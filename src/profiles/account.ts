import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defaultProfilesDir, isValidProfileName } from './store';

const COOKIE_LIMIT = 16384;

export interface ProfileAccount {
  userId: number;
  username: string;
  displayName: string;
  cookieHash: string;
  checkedAt: number;
  avatarBase64?: string;
}

export function cookieSha256(cookie: string): string {
  return crypto.createHash('sha256').update(cookie, 'utf8').digest('hex');
}

function cookieFromHeader(text: string): string | null {
  const cleaned = text.replace(/^cookie:\s*/i, '');
  const parts = cleaned.split(';');
  for (const raw of parts) {
    const part = raw.trim();
    if (part.startsWith('.ROBLOSECURITY=')) {
      return part.slice('.ROBLOSECURITY='.length);
    }
  }
  return null;
}

export function parseCookie(text: string): string {
  if (!text || text.length > COOKIE_LIMIT) {
    throw new Error('Paste a .ROBLOSECURITY cookie.');
  }
  const stripped = text.trim();
  const cookie = cookieFromHeader(stripped) ?? stripped;
  if (!cookie) {
    throw new Error('Paste the cookie value or a .ROBLOSECURITY cookie header.');
  }
  for (let i = 0; i < cookie.length; i++) {
    const code = cookie.charCodeAt(i);
    if (code <= 32 || code >= 127 || cookie[i] === ';' || cookie[i] === '"' || cookie[i] === ',') {
      throw new Error('Paste the cookie value or a .ROBLOSECURITY cookie header.');
    }
  }
  return cookie;
}

export class AccountStore {
  private readonly profilesDir: string;
  private readonly avatarCacheDir?: string;

  constructor(profilesDir?: string, avatarCacheDir?: string) {
    this.profilesDir = profilesDir ?? defaultProfilesDir();
    this.avatarCacheDir = avatarCacheDir;
  }

  private profileDir(name: string): string {
    if (!isValidProfileName(name)) {
      throw new Error('Invalid profile name.');
    }
    return path.join(this.profilesDir, name);
  }

  async readCookie(name: string): Promise<string | null> {
    const cookiePath = path.join(this.profileDir(name), 'state', 'app', 'data', 'sober', 'cookies');
    let contents: string;
    try {
      contents = await fs.readFile(cookiePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const extracted = cookieFromHeader(contents);
    if (!extracted) return null;
    return parseCookie(extracted);
  }

  async writeCookie(name: string, rawCookie: string): Promise<void> {
    const cookie = parseCookie(rawCookie);
    const soberDir = path.join(this.profileDir(name), 'state', 'app', 'data', 'sober');
    await fs.mkdir(soberDir, { recursive: true, mode: 0o700 });
    const cookiePath = path.join(soberDir, 'cookies');

    let previous = '';
    try {
      previous = await fs.readFile(cookiePath, 'utf8');
    } catch {
      // File may not exist yet
    }

    const kept: string[] = [];
    for (const part of previous.split(';')) {
      const trimmed = part.trim();
      if (trimmed && !trimmed.startsWith('.ROBLOSECURITY=')) {
        kept.push(trimmed);
      }
    }
    kept.push(`.ROBLOSECURITY=${cookie}`);
    await fs.writeFile(cookiePath, kept.join('; '), { encoding: 'utf8', mode: 0o600 });
  }

  async loadAccount(name: string, cookie?: string | null): Promise<ProfileAccount | null> {
    const accountPath = path.join(this.profileDir(name), 'account.json');
    let raw: string;
    try {
      raw = await fs.readFile(accountPath, 'utf8');
    } catch {
      return null;
    }
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    if (
      obj.version !== 1 ||
      typeof obj.user_id !== 'number' ||
      typeof obj.username !== 'string' ||
      typeof obj.display_name !== 'string' ||
      typeof obj.cookie_sha256 !== 'string' ||
      typeof obj.checked_at !== 'number'
    ) {
      return null;
    }

    if (cookie !== undefined && cookie !== null && obj.cookie_sha256 !== cookieSha256(cookie)) {
      return null;
    }

    return {
      userId: obj.user_id,
      username: obj.username,
      displayName: obj.display_name,
      cookieHash: obj.cookie_sha256,
      checkedAt: obj.checked_at,
      avatarBase64: typeof obj.avatar_png_base64 === 'string' ? obj.avatar_png_base64 : undefined,
    };
  }

  async saveAccount(name: string, account: ProfileAccount): Promise<void> {
    const accountPath = path.join(this.profileDir(name), 'account.json');
    const payload: Record<string, unknown> = {
      version: 1,
      user_id: account.userId,
      username: account.username,
      display_name: account.displayName,
      checked_at: account.checkedAt,
      cookie_sha256: account.cookieHash,
    };
    if (account.avatarBase64) {
      payload.avatar_png_base64 = account.avatarBase64;
    }
    await fs.writeFile(accountPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async importAccount(
    name: string,
    rawCookie: string,
    account?: ProfileAccount,
    create = false
  ): Promise<void> {
    const cookie = parseCookie(rawCookie);
    if (create) {
      await fs.mkdir(this.profileDir(name), { recursive: true, mode: 0o700 });
    }
    await this.writeCookie(name, cookie);
    if (account) {
      await this.saveAccount(name, account);
    }
  }

  async lookupAccount(rawCookie: string): Promise<ProfileAccount> {
    const cookie = parseCookie(rawCookie);
    const userRes = await fetch('https://users.roblox.com/v1/users/authenticated', {
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie}`,
        Accept: 'application/json',
      },
    });
    if (!userRes.ok) {
      throw new Error(
        userRes.status === 401
          ? 'The .ROBLOSECURITY cookie is invalid or expired.'
          : `Roblox user lookup failed (HTTP ${userRes.status}).`
      );
    }
    const userJson = (await userRes.json()) as {
      id?: number;
      name?: string;
      displayName?: string;
    };
    if (
      typeof userJson.id !== 'number' ||
      typeof userJson.name !== 'string' ||
      typeof userJson.displayName !== 'string'
    ) {
      throw new Error('Unexpected Roblox user response.');
    }

    let avatarBase64: string | undefined;
    try {
      const thumbRes = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userJson.id}&size=150x150&format=Png&isCircular=false`
      );
      if (thumbRes.ok) {
        const thumbJson = (await thumbRes.json()) as {
          data?: Array<{ imageUrl?: string }>;
        };
        const imageUrl = thumbJson.data?.[0]?.imageUrl;
        if (imageUrl) {
          const imgRes = await fetch(imageUrl);
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            avatarBase64 = buf.toString('base64');
          }
        }
      }
    } catch {
      // Avatar fetch is best-effort
    }

    return {
      userId: userJson.id,
      username: userJson.name,
      displayName: userJson.displayName,
      cookieHash: cookieSha256(cookie),
      checkedAt: Math.floor(Date.now() / 1000),
      avatarBase64,
    };
  }

  async getAvatarPath(name: string, account: ProfileAccount): Promise<string | null> {
    if (!this.avatarCacheDir || !account.avatarBase64) return null;
    await fs.mkdir(this.avatarCacheDir, { recursive: true });
    const filePath = path.join(this.avatarCacheDir, `${name}-${account.userId}.png`);
    await fs.writeFile(filePath, Buffer.from(account.avatarBase64, 'base64'));
    return filePath;
  }
}
