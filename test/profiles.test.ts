import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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
    assert.throws(() => parseCookie(''));
    assert.throws(() => parseCookie('bad"quote'));
    assert.throws(() => parseCookie('bad;semi'));
    assert.throws(() => parseCookie('bad\nnewline'));
  });

  it('creates, lists, renames, and detects flock-locked profiles', async () => {
    const dir = await makeDir();
    const store = new ProfileStore(dir);

    await store.createProfile('beta');
    await store.createProfile('alpha');
    assert.deepEqual(await store.listProfiles(), ['alpha', 'beta']);

    await store.renameProfile('beta', 'gamma');
    assert.deepEqual(await store.listProfiles(), ['alpha', 'gamma']);
    assert.equal(await store.isProfileRunning('alpha'), false);

    // Hold an exclusive flock on alpha/.lock via flock(1)
    const lockFile = path.join(dir, 'alpha', '.lock');
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
    const profStore = new ProfileStore(dir);
    const accStore = new AccountStore(dir, cacheDir);

    await profStore.createProfile('main');
    const soberDir = path.join(dir, 'main', 'state', 'app', 'data', 'sober');
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
    const rawCookies = await fs.readFile(path.join(soberDir, 'cookies'), 'utf8');
    assert.match(rawCookies, /GuestData=123/);
    assert.match(rawCookies, /\.ROBLOSECURITY=new_secret_cookie/);

    const loaded = await accStore.loadAccount('main', 'new_secret_cookie');
    assert.equal(loaded?.username, 'tester');
    assert.equal(await accStore.loadAccount('main', 'different_cookie'), null);
  });
});
