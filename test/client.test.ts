import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SocketClient } from '../src/socket/client';

function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrames(chunk: Buffer, state: { buf: Buffer }): unknown[] {
  state.buf = Buffer.concat([state.buf, chunk]);
  const frames: unknown[] = [];
  while (state.buf.length >= 4) {
    const len = state.buf.readUInt32BE(0);
    if (state.buf.length < 4 + len) break;
    frames.push(JSON.parse(state.buf.subarray(4, 4 + len).toString('utf8')));
    state.buf = state.buf.subarray(4 + len);
  }
  return frames;
}

describe('SocketClient', () => {
  const tempDirs: string[] = [];

  function makeSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsrelapse-client-'));
    tempDirs.push(dir);
    return path.join(dir, 'relapse.sock');
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('transitions waiting -> ready and executes scripts', async () => {
    const sockPath = makeSocketPath();
    const receivedOps: unknown[] = [];

    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      let opened = false;
      conn.on('data', (chunk) => {
        for (const msg of decodeFrames(chunk, state)) {
          if (!opened) {
            opened = true;
            conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
            conn.write(encodeFrame({ type: 'hello', ready: false, session: 0 }));
          } else {
            receivedOps.push(msg);
            const req = msg as { script_id: number };
            conn.write(encodeFrame({ type: 'exec_result', script_id: req.script_id, phase: 'submitted' }));
          }
        }
      });
      setTimeout(() => {
        if (!conn.destroyed) {
          conn.write(encodeFrame({ type: 'status', ready: true, session: 42 }));
        }
      }, 20);
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const client = new SocketClient(sockPath, 50);
    try {
      const states: string[] = [];
      const execResults: Array<{ id: number; submitted: boolean }> = [];

      await new Promise<void>((resolve) => {
        client.on('stateChanged', (state: string) => {
          states.push(state);
          if (state === 'waiting') {
            assert.equal(client.isReady(), false);
            assert.deepEqual(client.execute('early.luau', 'print(0)'), { result: 'not_ready' });
          } else if (state === 'ready') {
            assert.equal(client.isReady(), true);
            assert.equal(client.getSession(), 42);
            const res = client.execute('test.luau', 'print(1)');
            assert.deepEqual(res, { result: 'queued', scriptId: 1 });
          }
        });
        client.on('execResult', (id: number, submitted: boolean) => {
          execResults.push({ id, submitted });
          resolve();
        });
        client.start();
      });

      assert.ok(states.includes('waiting'));
      assert.ok(states.includes('ready'));
      assert.deepEqual(receivedOps, [
        { op: 'execute', script_id: 1, session: 42, name: 'test.luau', source: 'print(1)' },
      ]);
      assert.deepEqual(execResults, [{ id: 1, submitted: true }]);
    } finally {
      client.dispose();
      server.close();
    }
  });

  it('emits log and error events and rejects non-hello first message', async () => {
    const sockPath = makeSocketPath();
    let connCount = 0;

    const server = net.createServer((conn) => {
      connCount++;
      const state = { buf: Buffer.alloc(0) };
      let opened = false;
      conn.on('data', (chunk) => {
        for (const _msg of decodeFrames(chunk, state)) {
          if (!opened) {
            opened = true;
            conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
            if (connCount === 1) {
              conn.write(encodeFrame({ type: 'hello', ready: true, session: 7 }));
              conn.write(encodeFrame({ type: 'log', level: 'print', text: 'hi from executor' }));
              conn.write(encodeFrame({ type: 'error', detail: 'bad request' }));
            } else {
              conn.write(encodeFrame({ type: 'status', ready: true, session: 7 }));
            }
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const client = new SocketClient(sockPath, 50);
    try {
      const logs: Array<{ level: string; text: string }> = [];
      const errors: string[] = [];
      await new Promise<void>((resolve) => {
        client.on('log', (level: string, text: string) => logs.push({ level, text }));
        client.on('error', (detail: string) => {
          errors.push(detail);
          resolve();
        });
        client.start();
      });
      assert.deepEqual(logs, [{ level: 'print', text: 'hi from executor' }]);
      assert.deepEqual(errors, ['bad request']);
    } finally {
      client.dispose();
      server.close();
    }
  });
});
