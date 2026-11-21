import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultProfilesDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'relapse', 'profiles');
}

export function isValidProfileName(name: string): boolean {
  if (!name || name === '.' || name === '..' || name.length > 64) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

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

export class ProfileStore {
  readonly profilesDir: string;

  constructor(profilesDir?: string) {
    this.profilesDir = profilesDir ?? defaultProfilesDir();
  }

  profilePath(name: string): string {
    if (!isValidProfileName(name)) {
      throw new Error('Use 1–64 letters, digits, dots, underscores or hyphens (excluding . and ..).');
    }
    return path.join(this.profilesDir, name);
  }

  async listProfiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.profilesDir);
    } catch {
      return [];
    }
    const profiles: string[] = [];
    for (const name of entries) {
      if (!isValidProfileName(name)) continue;
      try {
        const st = await fs.lstat(path.join(this.profilesDir, name));
        if (st.isDirectory()) profiles.push(name);
      } catch {
        // Ignore
      }
    }
    return profiles.sort();
  }

  async createProfile(name: string): Promise<void> {
    const target = this.profilePath(name);
    await fs.mkdir(this.profilesDir, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new Error('Could not add Profile: this name already exists');
      }
      throw new Error(`Could not add Profile: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async isProfileRunning(name: string): Promise<boolean> {
    const profileDir = this.profilePath(name);
    const lockPath = path.join(profileDir, '.lock');
    try {
      await fs.lstat(lockPath);
    } catch {
      return false;
    }
    try {
      await execFileAsync('flock', ['-s', '-n', lockPath, 'true']);
      return false;
    } catch (err) {
      const code = (err as { code?: number }).code;
      // flock exits 1 when -n fails to acquire lock
      return code === 1;
    }
  }

  async renameProfile(name: string, replacement: string): Promise<void> {
    const src = this.profilePath(name);
    const dst = this.profilePath(replacement);
    if (name === replacement) return;
    if (await this.isProfileRunning(name)) {
      throw new Error('Close this Profile before renaming it.');
    }
    try {
      await fs.access(dst);
      throw new Error('Could not rename Profile: this name already exists');
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) throw err;
    }
    await fs.rename(src, dst);
  }

  async prepareDeleteProfile(name: string): Promise<{
    path: string;
    restorePermissions: () => Promise<void>;
  }> {
    const profileDir = this.profilePath(name);
    if (await this.isProfileRunning(name)) {
      throw new Error('Close this profile before deleting it.');
    }
    const workDir = path.join(profileDir, 'state', 'assets-work', 'work');
    let previousMode: number | null = null;
    try {
      const st = await fs.lstat(workDir);
      const mode = st.mode & 0o7777;
      if ((mode & 0o700) !== 0o700) {
        previousMode = mode;
        await fs.chmod(workDir, mode | 0o700);
      }
    } catch {
      // No overlay work directory
    }
    return {
      path: profileDir,
      restorePermissions: async () => {
        if (previousMode !== null) {
          try {
            await fs.chmod(workDir, previousMode);
          } catch {
            // Ignore if already trashed
          }
        }
      },
    };
  }

  async launchProfile(
    launcherPath: string,
    name: string,
    placeId?: string,
    jobId?: string
  ): Promise<number> {
    this.profilePath(name);
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
