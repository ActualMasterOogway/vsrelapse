import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RelapseSocket } from '../src/socket/transport';

function encodeFrame(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrames(chunk: Buffer, state: { buf: Buffer }): Buffer[] {
  state.buf = Buffer.concat([state.buf, chunk]);
  const frames: Buffer[] = [];
  while (state.buf.length >= 4) {
    const len = state.buf.readUInt32BE(0);
    if (state.buf.length < 4 + len) break;
    frames.push(state.buf.subarray(4, 4 + len));
    state.buf = state.buf.subarray(4 + len);
  }
  return frames;
}

describe('RelapseSocket', () => {
  const tempDirs: string[] = [];

  function makeSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsrelapse-test-'));
    tempDirs.push(dir);
    return path.join(dir, 'relapse.sock');
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('completes channel handshake and exchanges framed messages', async () => {
    const sockPath = makeSocketPath();
    let receivedOpening: unknown;
    let echoed: string | undefined;

    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      conn.on('data', (chunk) => {
        for (const frame of decodeFrames(chunk, state)) {
          if (!receivedOpening) {
            receivedOpening = JSON.parse(frame.toString('utf8'));
            conn.write(encodeFrame(JSON.stringify({ ok: true, version: 1, max_message_bytes: 1048576 })));
          } else {
            echoed = frame.toString('utf8');
            conn.write(encodeFrame('pong'));
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const client = new RelapseSocket();
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          assert.equal(client.getState(), 'open');
          assert.equal(client.getMaxMessageBytes(), 1048576);
          const res = client.send('ping');
          assert.equal(res, 'queued');
        });
        client.on('message', (data: Buffer) => {
          messages.push(data.toString('utf8'));
          resolve();
        });
        client.on('close', (reason, detail) => {
          reject(new Error(`Unexpected close: ${reason} ${detail}`));
        });
        client.connect(sockPath, '@main');
      });

      assert.deepEqual(receivedOpening, { version: 1, channel: '@main' });
      assert.equal(echoed, 'ping');
      assert.deepEqual(messages, ['pong']);
      client.close();
    } finally {
      server.close();
    }
  });

  it('handles split-chunk headers and coalesced frames', async () => {
    const sockPath = makeSocketPath();
    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      conn.on('data', (chunk) => {
        for (const _frame of decodeFrames(chunk, state)) {
          conn.write(encodeFrame(JSON.stringify({ ok: true, version: 1, max_message_bytes: 4096 })));
          const both = Buffer.concat([encodeFrame('first'), encodeFrame('second')]);
          // Send 1 byte at a time for first 5 bytes, then the rest
          for (let i = 0; i < 5; i++) {
            conn.write(both.subarray(i, i + 1));
          }
          conn.write(both.subarray(5));
          break;
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const client = new RelapseSocket();
      const received: string[] = [];
      await new Promise<void>((resolve) => {
        client.on('message', (data: Buffer) => {
          received.push(data.toString('utf8'));
          if (received.length === 2) resolve();
        });
        client.connect(sockPath, '@main');
      });
      assert.deepEqual(received, ['first', 'second']);
      client.close();
    } finally {
      server.close();
    }
  });

  it('closes with protocol_error when server rejects channel', async () => {
    const sockPath = makeSocketPath();
    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      conn.on('data', (chunk) => {
        if (decodeFrames(chunk, state).length > 0) {
          conn.write(encodeFrame(JSON.stringify({ ok: false, error: 'denied' })));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const client = new RelapseSocket();
      const closed = await new Promise<{ reason: string; detail?: string }>((resolve) => {
        client.on('close', (reason, detail) => resolve({ reason, detail }));
        client.connect(sockPath, '@main');
      });
      assert.equal(closed.reason, 'protocol_error');
      assert.match(closed.detail ?? '', /denied/);
    } finally {
      server.close();
    }
  });

  it('closes with protocol_error on oversized frame', async () => {
    const sockPath = makeSocketPath();
    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      conn.on('data', (chunk) => {
        if (decodeFrames(chunk, state).length > 0) {
          conn.write(encodeFrame(JSON.stringify({ ok: true, version: 1, max_message_bytes: 16 })));
          conn.write(encodeFrame('a'.repeat(32)));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const client = new RelapseSocket();
      const closed = await new Promise<{ reason: string; detail?: string }>((resolve) => {
        client.on('close', (reason, detail) => resolve({ reason, detail }));
        client.connect(sockPath, '@main');
      });
      assert.equal(closed.reason, 'protocol_error');
    } finally {
      server.close();
    }
  });

  it('closes with timeout when opening handshake stalls', async () => {
    const sockPath = makeSocketPath();
    const server = net.createServer(() => {
      // Intentionally never respond
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const client = new RelapseSocket({ openingTimeoutMs: 50 });
      const closed = await new Promise<{ reason: string }>((resolve) => {
        client.on('close', (reason) => resolve({ reason }));
        client.connect(sockPath, '@main');
      });
      assert.equal(closed.reason, 'timeout');
    } finally {
      server.close();
    }
  });

  it('closes with protocol_error on invalid UTF-8 in opening response', async () => {
    const sockPath = makeSocketPath();
    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      conn.on('data', (chunk) => {
        if (decodeFrames(chunk, state).length > 0) {
          conn.write(encodeFrame(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const client = new RelapseSocket();
      const closed = await new Promise<{ reason: string }>((resolve) => {
        client.on('close', (reason) => resolve({ reason }));
        client.connect(sockPath, '@main');
      });
      assert.equal(closed.reason, 'protocol_error');
    } finally {
      server.close();
    }
  });
});
