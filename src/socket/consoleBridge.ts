import { EventEmitter } from 'node:events';
import { RelapseSocket } from './transport';
import { SocketClient } from './client';

const CHANNEL_NAME = 'vsrelapse.console.v1';
const VALID_LEVELS = new Set(['print', 'warn', 'error', 'info']);

export class ConsoleBridge extends EventEmitter {
  private readonly client: SocketClient;
  private readonly consoleScript: string;
  private channel: RelapseSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly requests = new Set<number>();
  private requestId = 0;
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

  handleExecResult(id: number, submitted: boolean, detail?: string): boolean {
    if (!this.requests.delete(id)) return false;
    if (id === this.requestId && !submitted) {
      this.fail(detail || 'Console channel setup failed.');
    }
    return true;
  }

  sendInput(id: number, text: string): boolean {
    if (!this.ready || !this.channel || this.channel.getState() !== 'open') {
      return false;
    }
    const payload = JSON.stringify({ op: 'input', id, text });
    return this.channel.send(payload) === 'queued';
  }

  dispose(): void {
    this.stop();
    this.requests.clear();
    this.removeAllListeners();
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stop(): void {
    this.cancelTimer();
    if (this.channel) {
      this.channel.removeAllListeners();
      this.channel.close();
      this.channel = null;
    }
    this.requestId = 0;
    this.ready = false;
  }

  private fail(detail: string): void {
    this.stop();
    this.emit('error', detail);
  }

  private start(): void {
    this.stop();
    if (!this.session) return;

    const exec = this.client.execute('vsrelapse-console.luau', this.consoleScript);
    if (exec.result !== 'queued' || exec.scriptId === undefined) {
      this.fail('Could not start the console channel.');
      return;
    }
    this.requestId = exec.scriptId;
    if (this.requests.size >= 256) this.requests.clear();
    this.requests.add(this.requestId);

    const channel = new RelapseSocket();
    channel.on('open', () => {
      this.ready = true;
      this.cancelTimer();
    });
    channel.on('message', (data: Buffer) => this.onMessage(data));
    channel.on('close', () => {
      if (this.ready) {
        this.ready = false;
        this.deadline = Date.now() + 10_000;
        this.startTimer();
      }
    });
    this.channel = channel;
    this.deadline = Date.now() + 10_000;
    this.startTimer();
    this.tick();
  }

  private startTimer(): void {
    this.cancelTimer();
    this.timer = setInterval(() => this.tick(), 250);
  }

  private tick(): void {
    if (this.ready || !this.channel) return;
    if (Date.now() >= this.deadline) {
      this.fail('Console channel setup timed out');
      return;
    }
    if (this.channel.getState() === 'closed') {
      try {
        this.channel.connect(this.client.getPath(), CHANNEL_NAME);
      } catch {
        // Retry on next tick until deadline
      }
    }
  }

  private onMessage(data: Buffer): void {
    if (data.length === 0 || data.length > 65536 || data.includes(0)) {
      this.fail('Invalid console channel message');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      this.fail('Invalid console channel message');
      return;
    }
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
      if (typeof obj.id !== 'number' || !Number.isInteger(obj.id) || obj.id < 1 || obj.id > 0x7fffffff) {
        this.fail('Invalid console channel message');
        return;
      }
      this.emit('input', obj.id);
    } else {
      this.fail('Invalid console channel message');
    }
  }
}
