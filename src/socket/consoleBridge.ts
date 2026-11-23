import { EventEmitter } from 'node:events';
import { type Channel } from 'relapsesdk';
import { SocketClient } from './client';

const CHANNEL_NAME = 'vsrelapse.console.v1';
const VALID_LEVELS = new Set(['print', 'warn', 'error', 'info']);

export class ConsoleBridge extends EventEmitter {
  private readonly client: SocketClient;
  private readonly consoleScript: string;
  private channel: Channel | null = null;
  private opening = false;
  private setup = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private session = 0;
  private deadline = 0;
  private ready = false;

  constructor(client: SocketClient, consoleScript: string) {
    super();
    this.client = client;
    this.consoleScript = consoleScript;
  }

  sync(): void {
    const session = this.client.getSession();
    if (this.session === session) return;
    this.session = session;
    this.start();
  }

  async sendInput(id: number, text: string): Promise<boolean> {
    if (!this.ready || !this.channel || !this.channel.connected) {
      return false;
    }
    try {
      await this.channel.send({ op: 'input_response', id, text });
      return true;
    } catch (error) {
      this.emit('error', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
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
    this.emit('error', detail);
  }

  private start(): void {
    this.stop();
    if (!this.session) return;

    const { signal } = this.setup;
    void this.client.execute('vsrelapse-console.luau', this.consoleScript, { signal }).catch(error => {
      if (!signal.aborted) this.fail(error instanceof Error ? error.message : String(error));
    });
    this.deadline = Date.now() + 10_000;
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
      this.fail('Console channel setup timed out');
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
          this.startTimer();
        }
      });
      this.ready = true;
      this.cancelTimer();
    } catch {
      // The bootstrap script may still be registering its channel. Retry until the deadline.
    } finally {
      if (!signal.aborted) this.opening = false;
    }
  }

  private onMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fail('Invalid console channel message');
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : null;
    if (!type) {
      this.fail('Invalid console channel message');
      return;
    }

    if (type === 'state') {
      if (typeof obj.title !== 'string' || obj.title.length > 255 || typeof obj.visible !== 'boolean') {
        this.fail('Invalid console channel message');
        return;
      }
      this.emit('title', obj.title);
      this.emit('show', obj.visible);
    } else if (type === 'show') {
      this.emit('show', true);
    } else if (type === 'hide') {
      this.emit('show', false);
    } else if (type === 'title') {
      if (typeof obj.text !== 'string' || obj.text.length > 255) {
        this.fail('Invalid console channel message');
        return;
      }
      this.emit('title', obj.text);
    } else if (type === 'clear') {
      this.emit('clear');
    } else if (type === 'print') {
      if (
        typeof obj.level !== 'string' ||
        !VALID_LEVELS.has(obj.level) ||
        typeof obj.text !== 'string' ||
        obj.text.length > 4096
      ) {
        this.fail('Invalid console channel message');
        return;
      }
      this.emit('entry', obj.level, obj.text);
    } else if (type === 'input') {
      if (
        typeof obj.id !== 'number' ||
        !Number.isInteger(obj.id) ||
        obj.id < 1 ||
        obj.id > 0x7fffffff ||
        (obj.prompt !== undefined && (typeof obj.prompt !== 'string' || obj.prompt.length > 4096))
      ) {
        this.fail('Invalid console channel message');
        return;
      }
      this.emit('input', obj.id, obj.prompt);
    } else {
      this.fail('Invalid console channel message');
    }
  }
}
