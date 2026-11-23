import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { configuration, profiles, type ConfigurationOptions } from 'relapsesdk';

const execFileAsync = promisify(execFile);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidProfileName = profiles.isValidName;

export function buildJoinUri(placeId?: string, jobId?: string): string | null {
  const place = (placeId ?? '').trim();
  const job = (jobId ?? '').trim();
  if (!place) {
    if (job) throw new Error('A Job ID needs a Place ID.');
    return null;
  }
  if (!/^[1-9][0-9]*$/.test(place)) {
    throw new Error('Place ID must be a positive number.');
  }
  const parsed = BigInt(place);
  if (parsed < 1n || parsed > 9223372036854775807n) {
    throw new Error('Place ID must be a positive number.');
  }
  if (job && !UUID_RE.test(job)) {
    throw new Error('Enter a valid Job ID.');
  }
  return `roblox://placeId=${parsed.toString()}${job ? `&gameInstanceId=${job}` : ''}`;
}

export async function withProfileLock<T>(dataDir: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = spawn('flock', ['-x', '-n', '-E', '73', path.join(dataDir, '.lock'),
    'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise<void>(resolve => lock.once('close', () => resolve()));
  lock.stdin.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.once('exit', code => reject(new Error(code === 73
        ? 'Close this Profile before modifying it.'
        : 'Could not lock the profile.')));
      lock.stdout.once('data', () => resolve());
    });
    return await action();
  } finally {
    lock.stdin.end();
    await closed;
  }
}

export class ProfileStore {
  constructor(readonly options: ConfigurationOptions = {}) {}

  async profilePath(name: string): Promise<string> {
    return (await profiles.paths(name, this.options)).dataDir;
  }

  async listProfiles(): Promise<string[]> {
    const configured = await profiles.list(this.options);
    const root = path.join(configuration.dataDirectory(this.options), 'profiles');
    const used = new Set(configured.map(profile => path.resolve(profile.dataDir)));
    const legacy = await fs.readdir(root, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const names = new Set(configured.map(profile => profile.name));
    for (const entry of legacy) {
      if (entry.isDirectory() && isValidProfileName(entry.name) && !used.has(path.join(root, entry.name))) {
        names.add(entry.name);
      }
    }
    return [...names].sort();
  }

  async createProfile(name: string): Promise<void> {
    await profiles.create(name, this.options);
  }

  async isProfileRunning(name: string): Promise<boolean> {
    const profileDir = await this.profilePath(name);
    const lockPath = path.join(profileDir, '.lock');
    try {
      await fs.lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    try {
      await execFileAsync('flock', ['-s', '-n', lockPath, 'true']);
      return false;
    } catch (err) {
      const code = (err as { code?: number }).code;
      // flock exits 1 when -n fails to acquire lock
      if (code === 1) return true;
      throw err;
    }
  }

  async renameProfile(name: string, replacement: string): Promise<void> {
    const dataDir = await this.profilePath(name);
    const source = path.dirname(configuration.profilePath(name, this.options));
    const destination = path.dirname(configuration.profilePath(replacement, this.options));
    if (name === replacement) return;
    await withProfileLock(dataDir, async () => {
      if ((await this.listProfiles()).includes(replacement)) throw new Error('This profile name already exists.');
      const config = await configuration.readProfile(name, this.options);
      // Pin the data location so changing the profile name preserves its account and state.
      await configuration.writeProfile(name, { ...config, dataDir }, this.options);
      await fs.mkdir(destination, { mode: 0o700 });
      try {
        await fs.rename(source, destination);
      } catch (error) {
        await fs.rmdir(destination);
        throw error;
      }
      try {
        const global = await configuration.readGlobal(this.options);
        if ((global.defaultProfile ?? 'Default') === name) {
          await configuration.writeGlobal({ ...global, defaultProfile: replacement }, this.options);
        }
      } catch (error) {
        await fs.rename(destination, source);
        throw error;
      }
    });
  }

  async deleteProfile(name: string, trash: (target: string) => Promise<void>): Promise<void> {
    const dataDir = await this.profilePath(name);
    const configDir = path.dirname(configuration.profilePath(name, this.options));
    const configRoot = configuration.configDirectory(this.options);
    const dataRoot = configuration.dataDirectory(this.options);
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    };
    if (contains(dataDir, configRoot) || contains(dataDir, dataRoot)) {
      throw new Error('The profile data directory contains shared Relapse files.');
    }
    await withProfileLock(dataDir, async () => {
      const others = (await profiles.list(this.options)).filter(profile => profile.name !== name);
      // A configured data directory can be shared by multiple profile names.
      const shared = others.some(profile => path.resolve(profile.dataDir) === path.resolve(dataDir));
      const nested = others.some(profile => path.resolve(profile.dataDir) !== path.resolve(dataDir)
        && (contains(dataDir, profile.dataDir) || contains(profile.dataDir, dataDir)));
      if (nested) throw new Error('Profile data directories overlap. Update their dataDir settings before deleting.');
      const global = await configuration.readGlobal(this.options);
      const isDefault = (global.defaultProfile ?? 'Default') === name;
      const configExists = await fs.lstat(configDir).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
      const backup = await fs.mkdtemp(path.join(configRoot, '.delete-'));
      const workDir = path.join(dataDir, 'state', 'assets-work', 'work');
      let previousMode: number | undefined;
      let configTrashed = false;
      try {
        if (configExists) await fs.cp(configDir, path.join(backup, 'config'), { recursive: true });
        if (isDefault) {
          const replacement = (await this.listProfiles()).find(profile => profile !== name) ?? 'Default';
          await configuration.writeGlobal({ ...global, defaultProfile: replacement }, this.options);
        }
        if (configExists) {
          await trash(configDir);
          configTrashed = true;
        }
        if (!shared) {
          const stat = await fs.lstat(workDir).catch(error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (stat && !stat.isSymbolicLink()) {
            previousMode = stat.mode & 0o7777;
            await fs.chmod(workDir, previousMode | 0o700);
          }
          const exists = await fs.lstat(dataDir).catch(error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (exists) await trash(dataDir);
        }
      } catch (error) {
        if (configTrashed) {
          await fs.cp(path.join(backup, 'config'), configDir, { recursive: true, force: false, errorOnExist: true });
        }
        if (previousMode !== undefined) await fs.chmod(workDir, previousMode);
        if (isDefault) await configuration.writeGlobal(global, this.options);
        throw error;
      } finally {
        await fs.rm(backup, { recursive: true, force: true });
      }
    });
  }

  async launchProfile(
    launcherPath: string,
    name: string,
    placeId?: string,
    jobId?: string
  ): Promise<number> {
    await this.profilePath(name);
    if (!launcherPath || !path.isAbsolute(launcherPath)) {
      throw new Error('Select an executable launcher in Settings first.');
    }
    try {
      await fs.access(launcherPath, fs.constants.X_OK);
    } catch {
      throw new Error('Select an executable launcher in Settings first.');
    }
    if (await this.isProfileRunning(name)) {
      throw new Error('This Profile is already running or being maintained.');
    }
    const uri = buildJoinUri(placeId, jobId);
    const args = ['--profile', name, '--no-launch-ui'];
    if (uri) {
      args.push('--', uri);
    }
    const env = { ...process.env };
    delete env.LD_PRELOAD;
    delete env.LD_AUDIT;
    delete env.LD_LIBRARY_PATH;

    const child = spawn(launcherPath, args, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      child.once('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Could not launch profile: ${err.message}`));
        }
      });
      child.once('spawn', () => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve(child.pid ?? 0);
        }
      });
    });
  }
}
