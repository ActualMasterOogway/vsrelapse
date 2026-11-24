import { EventEmitter } from 'node:events';
import { Client, RelapseError, type Channel, type WaitOptions } from 'relapsesdk';

export type SocketClientState = 'disconnected' | 'connecting' | 'waiting' | 'ready';

export class SocketClient extends EventEmitter {
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly shutdown = new AbortController();
  private state: SocketClientState = 'disconnected';

  constructor(private readonly socketPath: string, private readonly reconnectMs = 1000) {
    super();
  }

  start(): void {
    if (this.shutdown.signal.aborted || this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => void this.connect(), this.reconnectMs);
    void this.connect();
  }

  dispose(): void {
    this.shutdown.abort();
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
    this.client?.close();
    this.client = null;
    this.state = 'disconnected';
    this.removeAllListeners();
  }

  isReady(): boolean {
    return this.client?.mainChannel.ready ?? false;
  }

  getState(): SocketClientState {
    return this.state;
  }

  getSession(): number {
    return this.isReady() ? this.client!.mainChannel.session : 0;
  }

  getPeerPid(): number {
    return this.client?.pid ?? 0;
  }

  async execute(name: string, source: string, options: WaitOptions = {}): Promise<void> {
    if (!this.client) throw new RelapseError('not_ready', 'Executor is not ready.');
    const safeName = name && Buffer.byteLength(name, 'utf8') <= 255 ? name : 'editor.luau';
    await this.client.mainChannel.execute(source, { ...options, name: safeName });
  }

  async openChannel(name: string, options: WaitOptions): Promise<Channel> {
    if (!this.client) throw new RelapseError('disconnected', 'Executor is disconnected.');
    return this.client.openChannel(name, options);
  }

  private setState(state: SocketClientState): void {
    this.state = state;
    this.emit('stateChanged', state);
  }

  private async connect(): Promise<void> {
    if (this.shutdown.signal.aborted || this.state !== 'disconnected') return;
    this.setState('connecting');
    try {
      const client = await Client.connect({ socketPath: this.socketPath, signal: this.shutdown.signal });
      if (this.shutdown.signal.aborted) {
        client.close();
        return;
      }
      this.client = client;
      client.mainChannel.on('status', () => this.setState(client.mainChannel.ready ? 'ready' : 'waiting'));
      client.mainChannel.on('log', ({ level, text }) => this.emit('log', level, text));
      client.mainChannel.on('close', ({ error }) => {
        this.client = null;
        if (this.shutdown.signal.aborted) return;
        this.setState('disconnected');
        if (error) this.emit('error', error.message);
      });
      this.setState(client.mainChannel.ready ? 'ready' : 'waiting');
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      this.setState('disconnected');
      this.emit('error', error instanceof Error ? error.message : String(error));
    }
  }
}
