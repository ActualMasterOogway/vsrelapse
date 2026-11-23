import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../src/socket/sessionManager';

function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrames(chunk: Buffer, state: { buf: Buffer }): Record<string, unknown>[] {
  state.buf = Buffer.concat([state.buf, chunk]);
  const frames: Record<string, unknown>[] = [];
  while (state.buf.length >= 4) {
    const len = state.buf.readUInt32BE(0);
    if (state.buf.length < 4 + len) break;
    frames.push(JSON.parse(state.buf.subarray(4, 4 + len).toString('utf8')));
    state.buf = state.buf.subarray(4 + len);
  }
  return frames;
}

describe('SessionManager', () => {
  const tempDirs: string[] = [];

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsrelapse-mgr-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function startMockServer(sockPath: string, session: number, executed: string[]): Promise<net.Server> {
    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      let channel: string | null = null;
      conn.on('data', (chunk) => {
        for (const msg of decodeFrames(chunk, state)) {
          if (!channel) {
            channel = String(msg.channel);
            conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
            if (channel === '@main') {
              conn.write(encodeFrame({ type: 'hello', pid: 1234, profile: 'default', ready: true, session }));
            }
          } else if (channel === '@main' && msg.op === 'execute') {
            executed.push(String(msg.name));
            conn.write(encodeFrame({ type: 'exec_result', script_id: msg.script_id, phase: 'submitted' }));
          }
        }
      });
    });
    return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
  }

  it('discovers relapse.sock and relapse-*.sock, auto-targets first, and routes multi-target execution', async () => {
    const dir = makeDir();
    const defaultSock = path.join(dir, 'relapse.sock');
    const altSock = path.join(dir, 'relapse-alt1.sock');
    // Ignored invalid files
    fs.writeFileSync(path.join(dir, 'relapse-bad/file'.replace('/', '_')), '');
    fs.writeFileSync(path.join(dir, 'other.sock'), '');

    const execDefault: string[] = [];
    const execAlt: string[] = [];
    const s1 = await startMockServer(defaultSock, 1, execDefault);
    const s2 = await startMockServer(altSock, 2, execAlt);

    const mgr = new SessionManager({
      socketDir: dir,
      sessionScript: '-- s',
      consoleScript: '-- c',
      redirectOutput: false,
      autoTargetFirst: true,
      pollMs: 50,
    });

    try {
      mgr.start();
      await new Promise((r) => setTimeout(r, 80));

      const list = mgr.listSessions();
      assert.equal(list.length, 2);
      assert.equal(list[0].name, 'No Profile');
      assert.equal(list[1].name, 'alt1');
      assert.equal(mgr.getTargetedPaths().length, 1);

      // Target both
      mgr.setTargeted(altSock, true);
      mgr.setTargeted(defaultSock, true);
      assert.equal(mgr.getTargetedPaths().length, 2);

      const results = await mgr.executeOnTargeted('hello.luau', 'print(1)');
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => !r.error));
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(execDefault.includes('vsrelapse-console.luau'));
      assert.ok(execDefault.includes('hello.luau'));
      assert.ok(execAlt.includes('vsrelapse-console.luau'));
      assert.ok(execAlt.includes('hello.luau'));
      // Uncheck both and verify next poll tick does not re-target
      mgr.setTargeted(altSock, false);
      mgr.setTargeted(defaultSock, false);
      assert.equal(mgr.getTargetedPaths().length, 0);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(mgr.getTargetedPaths().length, 0);
    } finally {
      mgr.dispose();
      s1.close();
      s2.close();
    }
  });
});
