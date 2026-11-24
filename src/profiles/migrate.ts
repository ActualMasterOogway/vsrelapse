import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { configuration, profiles, type ConfigurationOptions } from 'relapsesdk';
import { AccountStore } from './account';
import { isValidProfileName, ProfileStore } from './store';

const execFileAsync = promisify(execFile);

export interface MigrationReport {
  migratedConfigs: string[];
  upgradedStates: string[];
  launcherImported?: string;
}

async function isExecutable(filePath: string): Promise<boolean> {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return false;
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readRelapseGtkLauncher(
  configHome?: string
): Promise<string | null> {
  const base = configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const iniPath = path.join(base, 'relapsegtk', 'settings.ini');
  let raw: string;
  try {
    raw = await fs.readFile(iniPath, 'utf8');
  } catch {
    return null;
  }
  let inLauncher = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('[')) {
      inLauncher = trimmed === '[Launcher]';
      continue;
    }
    if (inLauncher && trimmed.startsWith('path=')) {
      const candidate = trimmed.slice(5).trim();
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function findDefaultLauncher(configHome?: string): Promise<string | null> {
  const fromGtk = await readRelapseGtkLauncher(configHome);
  if (fromGtk) return fromGtk;

  try {
    const { stdout } = await execFileAsync('which', ['relapse-launcher']);
    const resolved = stdout.trim();
    if (resolved && (await isExecutable(resolved))) return resolved;
  } catch {
    // Not in PATH
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'relapse-launcher'),
    path.join(home, '.local', 'share', 'relapse', 'relapse-launcher'),
    '/usr/local/bin/relapse-launcher',
    '/usr/bin/relapse-launcher',
  ];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function migrateLegacyProfiles(
  options: ConfigurationOptions = {}
): Promise<MigrationReport> {
  const store = new ProfileStore(options);
  const accounts = new AccountStore(options);

  const dataProfilesRoot = path.join(configuration.dataDirectory(options), 'profiles');
  const configured = await profiles.list(options).catch(() => []);
  const usedDataDirs = new Set(configured.map((p) => path.resolve(p.dataDir)));

  const migratedConfigs: string[] = [];
  const legacyEntries = await fs
    .readdir(dataProfilesRoot, { withFileTypes: true })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });

  for (const entry of legacyEntries) {
    if (!entry.isDirectory() || !isValidProfileName(entry.name)) continue;
    const dataDir = path.join(dataProfilesRoot, entry.name);
    if (usedDataDirs.has(path.resolve(dataDir))) continue;

    const cfgPath = configuration.profilePath(entry.name, options);
    const cfgExists = await fs.lstat(cfgPath).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    );
    if (!cfgExists) {
      await configuration.writeProfile(entry.name, { dataDir, override: {} }, options);
      migratedConfigs.push(entry.name);
    }
  }

  const upgradedStates: string[] = [];
  const allNames = await store.listProfiles();
  for (const name of allNames) {
    try {
      if (await accounts.ensureStateInitialized(name)) {
        upgradedStates.push(name);
      }
    } catch {
      // Skip locked/non-standard profiles
    }
  }

  return { migratedConfigs, upgradedStates };
}

export async function migrateLegacyScriptsDir(
  targetDir: string,
  legacyDir = path.join(os.homedir(), 'relapse-scripts-tmpdir')
): Promise<{ moved: string[]; skipped: string[] }> {
  if (path.resolve(targetDir) === path.resolve(legacyDir)) {
    return { moved: [], skipped: [] };
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(legacyDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { moved: [], skipped: [] };
    }
    throw err;
  }

  await fs.mkdir(targetDir, { recursive: true });
  const moved: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const src = path.join(legacyDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    const dstExists = await fs.lstat(dst).then(
      () => true,
      () => false
    );
    if (dstExists) {
      skipped.push(entry.name);
      continue;
    }
    await fs.rename(src, dst);
    moved.push(entry.name);
  }

  // Remove empty legacy folder if nothing remains
  const remaining = await fs.readdir(legacyDir).catch(() => ['keep']);
  if (remaining.length === 0) {
    await fs.rmdir(legacyDir).catch(() => {});
  }

  return { moved, skipped };
}
