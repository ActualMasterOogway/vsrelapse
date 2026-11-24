import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { configuration } from 'relapsesdk';
import {
  migrateLegacyProfiles,
  migrateLegacyScriptsDir,
  readRelapseGtkLauncher,
} from '../src/profiles/migrate';

describe('Migration helpers', () => {
  const tempDirs: string[] = [];

  async function makeDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsrelapse-mig-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('migrates legacy data-only profiles to config.json and adds missing state/.format', async () => {
    const dir = await makeDir();
    const opts = {
      homeDirectory: dir,
      configHome: path.join(dir, 'config'),
      dataHome: path.join(dir, 'data'),
    };
    const legacyDir = path.join(opts.dataHome, 'relapse', 'profiles', 'alt1');
    const soberDir = path.join(legacyDir, 'state', 'app', 'data', 'sober');
    await fs.mkdir(soberDir, { recursive: true });
    await fs.writeFile(path.join(soberDir, 'cookies'), '.ROBLOSECURITY=abc', 'utf8');

    const report = await migrateLegacyProfiles(opts);
    assert.deepEqual(report.migratedConfigs, ['alt1']);
    assert.deepEqual(report.upgradedStates, ['alt1']);

    const profileCfg = await configuration.readProfile('alt1', opts);
    assert.equal(profileCfg.dataDir, legacyDir);
    assert.equal(await fs.readFile(path.join(legacyDir, 'state', '.format'), 'utf8'), '1\n');
  });

  it('reads executable launcher path from relapsegtk settings.ini', async () => {
    const dir = await makeDir();
    const launcher = path.join(dir, 'relapse-launcher');
    await fs.writeFile(launcher, '#!/bin/sh\n', { mode: 0o755 });

    const cfgDir = path.join(dir, 'config');
    await fs.mkdir(path.join(cfgDir, 'relapsegtk'), { recursive: true });
    await fs.writeFile(
      path.join(cfgDir, 'relapsegtk', 'settings.ini'),
      `[Launcher]\npath=${launcher}\n`,
      'utf8'
    );

    assert.equal(await readRelapseGtkLauncher(cfgDir), launcher);
  });

  it('moves legacy scripts to target directory and removes empty old folder', async () => {
    const dir = await makeDir();
    const oldDir = path.join(dir, 'old');
    const newDir = path.join(dir, 'new');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'a.luau'), 'print(1)', 'utf8');

    const res = await migrateLegacyScriptsDir(newDir, oldDir);
    assert.deepEqual(res.moved, ['a.luau']);
    assert.deepEqual(res.skipped, []);
    assert.equal(await fs.readFile(path.join(newDir, 'a.luau'), 'utf8'), 'print(1)');
    await assert.rejects(fs.lstat(oldDir));
  });
});
