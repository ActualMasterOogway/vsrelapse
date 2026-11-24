import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { configuration } from 'relapsesdk';
import {
  ProfileStore,
  isValidProfileName,
  buildJoinUri,
} from '../src/profiles/store';
import {
  AccountStore,
  parseCookie,
  cookieSha256,
} from '../src/profiles/account';

describe('ProfileStore & AccountStore', () => {
  const tempDirs: string[] = [];

  async function makeDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsrelapse-prof-'));
    tempDirs.push(dir);
    return dir;
  }

  function options(dir: string) {
    return { homeDirectory: dir, configHome: path.join(dir, 'config'), dataHome: path.join(dir, 'data') };
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('validates profile names', () => {
    assert.equal(isValidProfileName('alt1'), true);
    assert.equal(isValidProfileName('my.profile_1-a'), true);
    assert.equal(isValidProfileName(''), false);
    assert.equal(isValidProfileName('.'), false);
    assert.equal(isValidProfileName('..'), false);
    assert.equal(isValidProfileName('a/b'), false);
    assert.equal(isValidProfileName('a'.repeat(65)), false);
  });

  it('builds and validates Roblox join URIs', () => {
    assert.equal(buildJoinUri('', ''), null);
    assert.equal(buildJoinUri('  ', '  '), null);
    assert.throws(() => buildJoinUri('', '550e8400-e29b-41d4-a716-446655440000'));
    assert.throws(() => buildJoinUri('abc', ''));
    assert.throws(() => buildJoinUri('12345', 'not-a-uuid'));
    assert.equal(buildJoinUri('12345', ''), 'roblox://placeId=12345');
    assert.equal(
      buildJoinUri('12345', '550e8400-e29b-41d4-a716-446655440000'),
      'roblox://placeId=12345&gameInstanceId=550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('parses .ROBLOSECURITY cookies safely', () => {
    assert.equal(parseCookie('abc123token'), 'abc123token');
    assert.equal(parseCookie('  foo=bar; .ROBLOSECURITY=tok_xyz; Path=/  '), 'tok_xyz');
    assert.equal(parseCookie('Cookie: .ROBLOSECURITY=hdr_tok; Path=/'), 'hdr_tok');
    assert.throws(() => parseCookie(''));
    assert.throws(() => parseCookie('bad"quote'));
    assert.throws(() => parseCookie('bad;semi'));
    assert.throws(() => parseCookie('bad\nnewline'));
  });

  it('creates, lists, renames, and detects flock-locked profiles', async () => {
    const dir = await makeDir();
    const store = new ProfileStore(options(dir));

    await store.createProfile('beta');
    await store.createProfile('alpha');
    assert.deepEqual(await store.listProfiles(), ['alpha', 'beta']);

    await store.renameProfile('beta', 'gamma');
    assert.deepEqual(await store.listProfiles(), ['alpha', 'gamma']);
    assert.equal(await store.isProfileRunning('alpha'), false);

    // Hold an exclusive flock on alpha/.lock via flock(1)
    const lockFile = path.join(await store.profilePath('alpha'), '.lock');
    const locker = spawn('flock', ['-x', lockFile, 'sleep', '5']);
    try {
      // Wait briefly for flock to acquire
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await store.isProfileRunning('alpha'), true);
      await assert.rejects(() => store.renameProfile('alpha', 'alpha2'), /Close this Profile/i);
    } finally {
      locker.kill('SIGKILL');
    }
  });

  it('imports cookies preserving existing cookie parts and caches account.json', async () => {
    const dir = await makeDir();
    const cacheDir = await makeDir();
    const profStore = new ProfileStore(options(dir));
    const accStore = new AccountStore(options(dir), cacheDir);

    await profStore.createProfile('main');
    const soberDir = path.join(await profStore.profilePath('main'), 'state', 'app', 'data', 'sober');
    await fs.mkdir(soberDir, { recursive: true });
    await fs.writeFile(path.join(soberDir, 'cookies'), 'GuestData=123; .ROBLOSECURITY=old', 'utf8');

    const account = {
      userId: 1001,
      username: 'tester',
      displayName: 'Tester',
      cookieHash: cookieSha256('new_secret_cookie'),
      checkedAt: 1700000000,
    };
    await accStore.importAccount('main', 'new_secret_cookie', account, false);

    assert.equal(await accStore.readCookie('main'), 'new_secret_cookie');
    assert.equal(await fs.readFile(path.join(await profStore.profilePath('main'), 'state/.format'), 'utf8'), '1\n');
    const rawCookies = await fs.readFile(path.join(soberDir, 'cookies'), 'utf8');
    assert.match(rawCookies, /GuestData=123/);
    assert.match(rawCookies, /\.ROBLOSECURITY=new_secret_cookie/);

    const loaded = await accStore.loadAccount('main', 'new_secret_cookie');
    assert.equal(loaded?.username, 'tester');
    assert.equal(await accStore.loadAccount('main', 'different_cookie'), null);
  });
  it('uses custom data directories for accounts and preserves config and default selection on rename', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    const accounts = new AccountStore(config);
    const dataDir = path.join(dir, 'custom');
    await configuration.writeGlobal({ defaultProfile: 'alt', raknet: { enabled: false } }, config);
    await configuration.writeProfile('alt', { dataDir, override: { autoexec: path.join(dir, 'autoexec') } }, config);
    await accounts.writeCookie('alt', 'test_cookie');
    assert.equal(await fs.readFile(path.join(dataDir, 'state/.format'), 'utf8'), '1\n');
    assert.equal((await fs.stat(path.join(dataDir, 'state/app/config/sober'))).isDirectory(), true);
    await store.renameProfile('alt', 'renamed');
    assert.deepEqual(await store.listProfiles(), ['renamed']);
    assert.equal(await accounts.readCookie('renamed'), 'test_cookie');
    assert.equal((await configuration.resolve(undefined, config)).profile, 'renamed');
    assert.equal((await configuration.resolve('renamed', config)).autoexec, path.join(dir, 'autoexec'));
    assert.deepEqual((await configuration.readGlobal(config)).raknet, { enabled: false });
  });

  it('keeps legacy profiles discoverable and preserves their data when renaming', async () => {
    const dir = await makeDir();
    const store = new ProfileStore(options(dir));
    const dataDir = await store.profilePath('legacy');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'account.json'), '{}');
    assert.deepEqual(await store.listProfiles(), ['legacy']);
    await store.renameProfile('legacy', 'updated');
    assert.deepEqual(await store.listProfiles(), ['updated']);
    assert.equal(await store.profilePath('updated'), dataDir);
    assert.equal(await fs.readFile(path.join(dataDir, 'account.json'), 'utf8'), '{}');
    await assert.rejects(store.createProfile('legacy'));
  });

  it('restores the config and default selection when trashing data fails', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    await store.createProfile('alt');
    await store.createProfile('other');
    await configuration.writeGlobal({ defaultProfile: 'alt' }, config);
    const configDir = path.dirname(configuration.profilePath('alt', config));
    await fs.writeFile(path.join(configDir, 'extra.json'), '{\"preserve\":true}');
    await assert.rejects(store.deleteProfile('alt', async target => {
      if (target === configDir) await fs.rename(target, path.join(dir, 'trashed-config'));
      else throw new Error('trash unavailable');
    }), /trash unavailable/);
    assert.deepEqual(await store.listProfiles(), ['alt', 'other']);
    assert.equal(await fs.readFile(path.join(configDir, 'extra.json'), 'utf8'), '{\"preserve\":true}');
    assert.equal((await configuration.resolve(undefined, config)).profile, 'alt');
    assert.equal((await fs.stat(await store.profilePath('alt'))).isDirectory(), true);
  });

  it('deletes profile config and data and selects another default', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    await store.createProfile('alt');
    await store.createProfile('other');
    await configuration.writeGlobal({ defaultProfile: 'alt' }, config);
    const targets: string[] = [];
    await store.deleteProfile('alt', async target => {
      targets.push(target);
      await fs.rename(target, path.join(dir, `trash-${targets.length}`));
    });
    assert.equal(targets.length, 2);
    assert.deepEqual(await store.listProfiles(), ['other']);
    assert.equal((await configuration.resolve(undefined, config)).profile, 'other');
  });

  it('preserves data used by another profile when deleting an alias', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    await store.createProfile('alt');
    const dataDir = await store.profilePath('alt');
    await configuration.writeProfile('alias', { dataDir }, config);
    const targets: string[] = [];
    await store.deleteProfile('alt', async target => {
      targets.push(target);
      await fs.rename(target, path.join(dir, 'trash'));
    });
    assert.equal(targets.length, 1);
    assert.deepEqual(await store.listProfiles(), ['alias']);
    assert.equal((await fs.stat(dataDir)).isDirectory(), true);
    await configuration.writeProfile('nested', { dataDir: path.join(dataDir, 'nested') }, config);
    await assert.rejects(store.deleteProfile('alias', async () => assert.fail('Must preserve overlapping data')), /overlap/);
  });

  it('lists valid profiles when another profile config is malformed', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    await store.createProfile('good');
    const badDir = path.dirname(configuration.profilePath('broken', config));
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'config.json'), '{not-valid-json', 'utf8');
    assert.deepEqual(await store.listProfiles(), ['good']);
  });

  it('rejects unrecognized state/.format versions during cookie import', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    const accounts = new AccountStore(config);
    await store.createProfile('main');
    const stateDir = path.join(await store.profilePath('main'), 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, '.format'), '2\n', 'utf8');
    await assert.rejects(accounts.writeCookie('main', 'cookie_val'), /Unrecognized profile layout/);
  });

  it('deletes configured profiles without creating a missing dataDir', async () => {
    const dir = await makeDir();
    const config = options(dir);
    const store = new ProfileStore(config);
    const missingData = path.join(dir, 'never-launched');
    await configuration.writeProfile('ghost', { dataDir: missingData }, config);
    const trashed: string[] = [];
    await store.deleteProfile('ghost', async target => {
      trashed.push(target);
      await fs.rm(target, { recursive: true, force: true });
    });
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0], path.dirname(configuration.profilePath('ghost', config)));
    await assert.rejects(fs.lstat(missingData));
  });

});
