import { EventEmitter } from 'node:events';
import * as net from 'node:net';

export const RELAPSE_SOCKET_DEFAULT_PATH = '/tmp/relapse.sock';

const PROTOCOL_VERSION = 1;
const MAX_OPENING_BYTES = 4096;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 256;
const DEFAULT_OPENING_TIMEOUT_MS = 5000;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type RelapseSocketState = 'closed' | 'connecting' | 'opening' | 'open';

export type RelapseSocketCloseReason =
  | 'peer_closed'
  | 'local_closed'
  | 'protocol_error'
  | 'io_error'
  | 'timeout';

export type RelapseSocketSendResult = 'queued' | 'closed' | 'too_large' | 'backpressure';

export interface RelapseSocketOptions {
  openingTimeoutMs?: number;
}

export class RelapseSocket extends EventEmitter {
  private state: RelapseSocketState = 'closed';
  private socket: net.Socket | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private readonly openingTimeoutMs: number;
  private maxMessageBytes = 0;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private queuedBytes = 0;
  private queuedMessages = 0;
  private generation = 0;

  constructor(options?: RelapseSocketOptions) {
    super();
    this.openingTimeoutMs = options?.openingTimeoutMs ?? DEFAULT_OPENING_TIMEOUT_MS;
  }

  getState(): RelapseSocketState {
    return this.state;
  }

  getMaxMessageBytes(): number {
    return this.maxMessageBytes;
  }

  getPeerPid(): number {
    // Node's net.Socket does not expose SO_PEERCRED directly without native addons.
    return 0;
  }

  connect(socketPath: string = RELAPSE_SOCKET_DEFAULT_PATH, channel: string): void {
    if (this.state !== 'closed') {
      throw new Error('socket is already active');
    }
    if (!socketPath.startsWith('/')) {
      throw new Error('invalid Unix socket pathname');
    }
    if (!isValidChannel(channel)) {
      throw new Error('invalid channel name');
    }

    const gen = ++this.generation;
    this.state = 'connecting';
    this.recvBuffer = Buffer.alloc(0);
    this.queuedBytes = 0;
    this.queuedMessages = 0;
    this.maxMessageBytes = 0;

    const sock = net.createConnection(socketPath);
    this.socket = sock;

    this.timeout = setTimeout(() => {
      if (this.generation === gen && this.state !== 'open' && this.state !== 'closed') {
        this.finish('timeout', 'channel handshake timed out');
      }
    }, this.openingTimeoutMs);

    sock.on('connect', () => {
      if (this.generation !== gen || this.state !== 'connecting') return;
      this.state = 'opening';
      const opening = JSON.stringify({ version: PROTOCOL_VERSION, channel });
      this.writeFrame(Buffer.from(opening, 'utf8'));
    });

    sock.on('data', (chunk: Buffer) => {
      if (this.generation !== gen) return;
      this.handleData(chunk);
    });

    sock.on('error', (err: Error) => {
      if (this.generation !== gen) return;
      this.finish('io_error', err.message);
    });

    sock.on('close', (hadError: boolean) => {
      if (this.generation !== gen || this.state === 'closed') return;
      if (hadError) {
        this.finish('io_error', 'socket closed with error');
      } else if (this.recvBuffer.length > 0) {
        this.finish('protocol_error', 'connection closed mid-frame');
      } else {
        this.finish('peer_closed', 'peer closed the connection');
      }
    });
  }

  send(payload: string | Buffer): RelapseSocketSendResult {
    if (this.state !== 'open' || !this.socket) {
      return 'closed';
    }
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    if (body.length > this.maxMessageBytes) {
      return 'too_large';
    }
    if (
      this.queuedMessages >= MAX_QUEUED_MESSAGES ||
      body.length + 4 > MAX_QUEUED_BYTES - this.queuedBytes
    ) {
      return 'backpressure';
    }
    this.writeFrame(body);
    return 'queued';
  }

  close(): void {
    if (this.state === 'closed') return;
    this.finish('local_closed', 'closed by client');
  }

  private writeFrame(body: Buffer): void {
    if (!this.socket) return;
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);

    const frameLen = frame.length;
    this.queuedBytes += frameLen;
    this.queuedMessages += 1;

    this.socket.write(frame, () => {
      this.queuedBytes = Math.max(0, this.queuedBytes - frameLen);
      this.queuedMessages = Math.max(0, this.queuedMessages - 1);
    });
  }

  private handleData(chunk: Buffer): void {
    this.recvBuffer = this.recvBuffer.length === 0 ? chunk : Buffer.concat([this.recvBuffer, chunk]);
    const gen = this.generation;

    while (this.generation === gen && this.recvBuffer.length >= 4) {
      const bodySize = this.recvBuffer.readUInt32BE(0);
      const limit = this.state === 'opening' ? MAX_OPENING_BYTES : this.maxMessageBytes;
      if (bodySize > limit) {
        this.finish('protocol_error', 'frame exceeds the message limit');
        return;
      }
      if (this.recvBuffer.length < 4 + bodySize) {
        return;
      }

      const body = this.recvBuffer.subarray(4, 4 + bodySize);
      this.recvBuffer = this.recvBuffer.subarray(4 + bodySize);

      if (this.state === 'opening') {
        this.handleOpeningResponse(body);
      } else {
        this.emit('message', body);
      }
    }
  }

  private handleOpeningResponse(body: Buffer): void {
    if (body.length === 0 || body.includes(0)) {
      this.finish('protocol_error', 'expected a JSON channel response');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8Decoder.decode(body));
    } catch {
      this.finish('protocol_error', 'expected a JSON channel response');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.finish('protocol_error', 'expected a channel response object');
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.ok !== 'boolean') {
      this.finish('protocol_error', 'missing channel response status');
      return;
    }
    if (!obj.ok) {
      const detail = typeof obj.error === 'string' ? obj.error : 'channel rejected';
      this.finish('protocol_error', detail);
      return;
    }
    if (
      typeof obj.version !== 'number' ||
      obj.version !== PROTOCOL_VERSION ||
      typeof obj.max_message_bytes !== 'number' ||
      !Number.isInteger(obj.max_message_bytes) ||
      obj.max_message_bytes <= 0 ||
      obj.max_message_bytes > 0xffffffff
    ) {
      this.finish('protocol_error', 'invalid channel version or message limit');
      return;
    }

    this.maxMessageBytes = Math.min(obj.max_message_bytes, MAX_MESSAGE_BYTES);
    this.state = 'open';
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.emit('open');
  }

  private finish(reason: RelapseSocketCloseReason, detail?: string): void {
    if (this.state === 'closed') return;
    this.generation += 1;
    this.state = 'closed';
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.recvBuffer = Buffer.alloc(0);
    this.queuedBytes = 0;
    this.queuedMessages = 0;
    this.maxMessageBytes = 0;
    this.emit('close', reason, detail);
  }
}

function isValidChannel(channel: string): boolean {
  if (!channel || Buffer.byteLength(channel, 'utf8') > 255) return false;
  for (let i = 0; i < channel.length; i++) {
    const code = channel.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
