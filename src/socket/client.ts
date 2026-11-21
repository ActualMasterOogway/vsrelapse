import { EventEmitter } from 'node:events';
import { RelapseSocket } from './transport';

export type SocketClientState = 'disconnected' | 'connecting' | 'waiting' | 'ready';

export type SocketClientSendResult =
  | 'queued'
  | 'not_ready'
  | 'too_large'
  | 'backpressure'
  | 'ids_exhausted';

export interface ExecuteResponse {
  result: SocketClientSendResult;
  scriptId?: number;
}

export class SocketClient extends EventEmitter {
  private readonly transport: RelapseSocket;
  private readonly socketPath: string;
  private readonly reconnectMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: SocketClientState = 'disconnected';
  private helloReceived = false;
  private session = 0;
  private nextScriptId = 1;
  private disposed = false;

  constructor(socketPath: string, reconnectMs = 1000) {
    super();
    this.socketPath = socketPath;
    this.reconnectMs = reconnectMs;
    this.transport = new RelapseSocket();
    this.transport.on('message', (data: Buffer) => this.onMessage(data));
    this.transport.on('close', (_reason: string, detail?: string) => this.onClose(detail));
  }

  start(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => this.connectSocket(), this.reconnectMs);
    this.connectSocket();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.transport.close();
    this.removeAllListeners();
  }

  isReady(): boolean {
    return this.state === 'ready' && this.transport.getState() === 'open';
  }

  getState(): SocketClientState {
    return this.state;
  }

  getSession(): number {
    return this.isReady() ? this.session : 0;
  }

  getPath(): string {
    return this.socketPath;
  }

  getPeerPid(): number {
    return this.transport.getPeerPid();
  }

  execute(name: string, source: string): ExecuteResponse {
    if (!this.isReady()) {
      return { result: 'not_ready' };
    }
    if (this.nextScriptId >= Number.MAX_SAFE_INTEGER) {
      return { result: 'ids_exhausted' };
    }

    const scriptId = this.nextScriptId;
    const safeName = name && Buffer.byteLength(name, 'utf8') <= 255 ? name : 'editor.luau';
    const payload = JSON.stringify({
      op: 'execute',
      script_id: scriptId,
      session: this.session,
      name: safeName,
      source,
    });

    const sent = this.transport.send(payload);
    switch (sent) {
      case 'queued':
        this.nextScriptId += 1;
        return { result: 'queued', scriptId };
      case 'too_large':
        return { result: 'too_large' };
      case 'backpressure':
        return { result: 'backpressure' };
      case 'closed':
        return { result: 'not_ready' };
    }
  }

  private setState(state: SocketClientState, detail?: string): void {
    this.state = state;
    this.emit('stateChanged', state, detail);
  }

  private connectSocket(): void {
    if (this.disposed || this.transport.getState() !== 'closed') return;
    this.helloReceived = false;
    this.session = 0;
    try {
      this.transport.connect(this.socketPath, '@main');
      this.setState('connecting');
    } catch (err) {
      this.setState('disconnected', err instanceof Error ? err.message : String(err));
    }
  }

  private onClose(detail?: string): void {
    this.helloReceived = false;
    this.session = 0;
    if (!this.disposed) {
      this.setState('disconnected', detail);
    }
  }

  private onMessage(data: Buffer): void {
    if (data.length === 0 || data.includes(0)) {
      this.invalidMessage();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      this.invalidMessage();
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.invalidMessage();
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : null;
    if (!type || (!this.helloReceived && type !== 'hello')) {
      this.invalidMessage();
      return;
    }

    if (type === 'hello' || type === 'status') {
      if (
        (type === 'hello' && this.helloReceived) ||
        typeof obj.ready !== 'boolean' ||
        typeof obj.session !== 'number' ||
        !Number.isInteger(obj.session)
      ) {
        this.invalidMessage();
        return;
      }
      if (obj.session < 0 || (obj.ready && obj.session === 0)) {
        this.invalidMessage();
        return;
      }
      this.helloReceived = true;
      this.session = obj.session;
      this.setState(obj.ready ? 'ready' : 'waiting');
    } else if (type === 'exec_result') {
      const phase = typeof obj.phase === 'string' ? obj.phase : null;
      const detail = typeof obj.detail === 'string' ? obj.detail : undefined;
      if (
        typeof obj.script_id !== 'number' ||
        !Number.isInteger(obj.script_id) ||
        (phase !== 'submitted' && phase !== 'error')
      ) {
        this.invalidMessage();
        return;
      }
      this.emit('execResult', obj.script_id, phase === 'submitted', detail);
    } else if (type === 'log') {
      const level = typeof obj.level === 'string' ? obj.level : null;
      const text = typeof obj.text === 'string' ? obj.text : null;
      if (level === null || text === null) {
        this.invalidMessage();
        return;
      }
      this.emit('log', level, text);
    } else if (type === 'error') {
      const detail = typeof obj.detail === 'string' ? obj.detail : 'Request failed';
      this.emit('error', detail);
    }
  }

  private invalidMessage(): void {
    this.transport.close();
    this.emit('error', 'Invalid executor message');
  }
}
