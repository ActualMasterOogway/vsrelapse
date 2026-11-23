import { EventEmitter } from 'node:events';
import { type Channel, RelapseError } from 'relapsesdk';
import { SocketClient } from './client';

export type OutputState = 'off' | 'waiting' | 'connecting' | 'active' | 'failed';

const CHANNEL_NAME = 'vsrelapse.session.v2';
const VALID_LEVELS = new Set(['print', 'warn', 'error', 'info']);

export class SessionBridge extends EventEmitter {
  private readonly client: SocketClient;
  private readonly sessionScript: string;
  private channel: Channel | null = null;
  private opening = false;
  private setup = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private session = 0;
  private deadline = 0;
  private state: OutputState = 'off';
  private enabled = false;
  private ready = false;

  constructor(client: SocketClient, sessionScript: string) {
    super();
    this.client = client;
    this.sessionScript = sessionScript;
  }

  getState(): OutputState {
    return this.state;
  }

  setOutputEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    this.session = this.client.getSession();
    this.start();
  }

  sync(): void {
    const session = this.client.getSession();
    if (this.session === session) return;
    this.session = session;
    this.start();
  }

  isReady(): boolean {
    return (
      this.client.isReady() &&
      (!this.enabled || (this.ready && (this.channel?.connected ?? false)))
    );
  }

  async execute(name: string, source: string): Promise<void> {
    if (!this.isReady()) throw new RelapseError('not_ready', 'Output channel is not ready.');
    if (!this.enabled) {
      return this.client.execute(name, source);
    }
    const safeName = name && Buffer.byteLength(name, 'utf8') <= 255 ? name : 'editor.luau';
    const script = `getgenv().__vsrelapse_session_v2.execute(${encodeLuaString(source)},${encodeLuaString(safeName)})`;
    return this.client.execute('vsrelapse-execute.luau', script);
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private setState(state: OutputState, detail?: string): void {
    this.state = state;
    this.emit('stateChanged', state, detail);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stop(): void {
    this.setup.abort();
    this.setup = new AbortController();
    this.opening = false;
    this.cancelTimer();
    if (this.channel) {
      this.channel.removeAllListeners();
      this.channel.close();
      this.channel = null;
    }
    this.ready = false;
  }

  private fail(detail: string): void {
    this.stop();
    this.setState('failed', detail);
  }

  private start(): void {
    this.stop();
    if (!this.enabled) {
      this.setState('off', 'Output off');
      return;
    }
    if (!this.session) {
      this.setState('waiting', 'Waiting for a game');
      return;
    }

    const { signal } = this.setup;
    void this.client.execute('vsrelapse-session.luau', this.sessionScript, { signal }).catch(error => {
      if (!signal.aborted) this.fail(error instanceof Error ? error.message : String(error));
    });
    this.deadline = Date.now() + 10_000;
    this.setState('connecting', 'Starting UI channel…');
    this.startTimer();
    void this.tick();
  }

  private startTimer(): void {
    this.cancelTimer();
    this.timer = setInterval(() => void this.tick(), 250);
  }

  private async tick(): Promise<void> {
    if (this.ready) return;
    if (Date.now() >= this.deadline) {
      this.fail('UI channel setup timed out');
      return;
    }
    if (this.opening || this.channel?.connected) return;
    const { signal } = this.setup;
    this.opening = true;
    try {
      const channel = await this.client.openChannel(CHANNEL_NAME, { signal });
      if (signal.aborted) {
        channel.close();
        return;
      }
      this.channel = channel;
      channel.on('message', message => this.onMessage(message));
      channel.on('close', () => {
        this.channel = null;
        if (this.ready) {
          this.ready = false;
          this.deadline = Date.now() + 10_000;
          this.setState('connecting', 'Reconnecting…');
          this.startTimer();
        }
      });
      await channel.send({ op: 'configure', version: 2, redirect: this.enabled });
    } catch {
      // The bootstrap script may still be registering its channel. Retry until the deadline.
    } finally {
      if (!signal.aborted) this.opening = false;
    }
  }

  private onMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fail('Invalid UI channel message. Toggle redirection to retry.');
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : null;
    if (!type) {
      this.fail('Invalid UI channel message. Toggle redirection to retry.');
      return;
    }

    if (type === 'configured') {
      if (obj.version !== 2 || typeof obj.redirect !== 'boolean') {
        this.fail('Invalid UI channel message. Toggle redirection to retry.');
        return;
      }
      if (obj.redirect !== this.enabled) return;
      this.cancelTimer();
      this.ready = true;
      this.setState(this.enabled ? 'active' : 'off', this.enabled ? 'Capturing' : 'Output off');
    } else if (type === 'failed') {
      const detail = typeof obj.detail === 'string' && obj.detail.length <= 4096 ? obj.detail : null;
      if (!detail) {
        this.fail('Invalid UI channel message. Toggle redirection to retry.');
        return;
      }
      this.fail(detail);
    } else if (type === 'output') {
      if (
        !Array.isArray(obj.entries) ||
        obj.entries.length === 0 ||
        obj.entries.length > 32 ||
        typeof obj.dropped !== 'number' ||
        !Number.isInteger(obj.dropped) ||
        obj.dropped < 0
      ) {
        this.fail('Invalid UI channel message. Toggle redirection to retry.');
        return;
      }
      for (const row of obj.entries) {
        if (
          !row ||
          typeof row !== 'object' ||
          typeof (row as Record<string, unknown>).level !== 'string' ||
          !VALID_LEVELS.has((row as Record<string, unknown>).level as string) ||
          typeof (row as Record<string, unknown>).text !== 'string' ||
          ((row as Record<string, unknown>).text as string).length > 4096
        ) {
          this.fail('Invalid UI channel message. Toggle redirection to retry.');
          return;
        }
      }
      if (!this.enabled) return;
      for (const row of obj.entries as Array<{ level: string; text: string }>) {
        this.emit('entry', row.level, row.text);
      }
      if (obj.dropped > 0) {
        this.emit('entry', 'warn', `${obj.dropped} messages dropped: output arrived too quickly.`);
      }
    } else if (type === 'dropped') {
      if (typeof obj.count !== 'number' || !Number.isInteger(obj.count) || obj.count < 1) {
        this.fail('Invalid UI channel message. Toggle redirection to retry.');
        return;
      }
      if (this.enabled) {
        this.emit('entry', 'warn', `${obj.count} messages dropped: output arrived too quickly.`);
      }
    } else {
      this.fail('Invalid UI channel message. Toggle redirection to retry.');
    }
  }
}

export function encodeLuaString(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let out = '"';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x22 || b === 0x5c) {
      out += '\\' + String.fromCharCode(b);
    } else if (b < 32 || b >= 127) {
      out += '\\' + String(b).padStart(3, '0');
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out + '"';
}
