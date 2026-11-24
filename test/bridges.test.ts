import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SocketClient } from '../src/socket/client';
import { SessionBridge } from '../src/socket/sessionBridge';
import { ConsoleBridge } from '../src/socket/consoleBridge';
import { DialogBridge, DialogRequest } from '../src/socket/dialogBridge';

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

describe('SessionBridge and ConsoleBridge', () => {
  const tempDirs: string[] = [];

  function makeSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsrelapse-bridges-'));
    tempDirs.push(dir);
    return path.join(dir, 'relapse.sock');
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('SessionBridge bootstraps vsrelapse.session.v2, captures output, and wraps execute', async () => {
    const sockPath = makeSocketPath();
    const mainExecs: Array<{ name: string; source: string }> = [];
    let sessionConn: net.Socket | null = null;

    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      let channel: string | null = null;
      conn.on('data', (chunk) => {
        for (const msg of decodeFrames(chunk, state)) {
          if (!channel) {
            channel = String(msg.channel);
            conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
            if (channel === '@main') {
              conn.write(encodeFrame({ type: 'hello', pid: 1234, profile: 'default', ready: true, session: 9 }));
            } else if (channel === 'vsrelapse.session.v2') {
              sessionConn = conn;
            }
          } else if (channel === '@main' && msg.op === 'execute') {
            mainExecs.push({ name: String(msg.name), source: String(msg.source) });
            conn.write(encodeFrame({ type: 'exec_result', script_id: msg.script_id, phase: 'submitted' }));
          } else if (channel === 'vsrelapse.session.v2' && msg.op === 'configure') {
            conn.write(encodeFrame({ type: 'configured', version: 2, redirect: msg.redirect }));
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const client = new SocketClient(sockPath, 50);
    const bridge = new SessionBridge(client, '-- session script --');

    try {
      const entries: Array<{ level: string; text: string }> = [];
      bridge.on('entry', (level: string, text: string) => entries.push({ level, text }));

      await new Promise<void>((resolve) => {
        client.on('stateChanged', (s: string) => {
          if (s === 'ready') bridge.sync();
        });
        bridge.on('stateChanged', (s: string) => {
          if (s === 'active') resolve();
        });
        bridge.setOutputEnabled(true);
        client.start();
      });

      assert.equal(bridge.isReady(), true);
      assert.equal(mainExecs[0].name, 'vsrelapse-session.luau');

      sessionConn!.write(
        encodeFrame({
          type: 'output',
          dropped: 2,
          entries: [{ level: 'print', text: 'hello world' }],
        })
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(entries, [
        { level: 'print', text: 'hello world' },
        { level: 'warn', text: '2 messages dropped: output arrived too quickly.' },
      ]);

      await bridge.execute('my.luau', 'print("hi—🔥\n")');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mainExecs[1].name, 'vsrelapse-execute.luau');
      assert.equal(
        mainExecs[1].source,
        'getgenv().__vsrelapse_session_v2.execute("print(\\"hi\\226\\128\\148\\240\\159\\148\\165\\010\\")","my.luau")'
      );
    } finally {
      bridge.dispose();
      client.dispose();
      server.close();
    }
  });

  it('ConsoleBridge bootstraps vsrelapse.console.v1 and handles input/output', async () => {
    const sockPath = makeSocketPath();
    let consoleConn: net.Socket | null = null;
    const consoleInputs: unknown[] = [];

    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      let channel: string | null = null;
      conn.on('data', (chunk) => {
        for (const msg of decodeFrames(chunk, state)) {
          if (!channel) {
            channel = String(msg.channel);
            conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
            if (channel === '@main') {
              conn.write(encodeFrame({ type: 'hello', pid: 1234, profile: 'default', ready: true, session: 12 }));
            } else if (channel === 'vsrelapse.console.v1') {
              consoleConn = conn;
              conn.write(encodeFrame({ type: 'state', title: 'My Console', visible: true }));
              conn.write(encodeFrame({
                type: 'place',
                placeId: '1818',
                jobId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'Happy Home',
              }));
              conn.write(encodeFrame({ type: 'print', level: 'info', text: 'ready!' }));
              conn.write(encodeFrame({ type: 'input', id: 5, prompt: 'enter a num: ' }));
            }
          } else if (channel === '@main' && msg.op === 'execute') {
            conn.write(encodeFrame({ type: 'exec_result', script_id: msg.script_id, phase: 'submitted' }));
          } else if (channel === 'vsrelapse.console.v1' && (msg.op === 'input_response' || msg.op === 'closed')) {
            consoleInputs.push(msg);
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const client = new SocketClient(sockPath, 50);
    const consoleBridge = new ConsoleBridge(client, '-- console script --');

    try {
      const events: unknown[] = [];
      consoleBridge.on('title', (t: string) => events.push(['title', t]));
      consoleBridge.on('show', (v: boolean) => events.push(['show', v]));
      consoleBridge.on('place', (p: unknown) => events.push(['place', p]));
      consoleBridge.on('destroy', () => events.push(['destroy']));
      consoleBridge.on('entry', (l: string, t: string) => events.push(['entry', l, t]));

      await new Promise<void>((resolve) => {
        client.on('stateChanged', (s: string) => {
          if (s === 'ready') consoleBridge.sync();
        });
        consoleBridge.on('input', async (id: number, prompt?: string) => {
          events.push(['input', id, prompt]);
          assert.equal(await consoleBridge.sendInput(id, 'hello'), true);
          assert.equal(await consoleBridge.sendClosed(), true);
          consoleConn!.write(encodeFrame({ type: 'destroy' }));
          resolve();
        });
        client.start();
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(events, [
        ['title', 'My Console'],
        ['show', true],
        ['place', { placeId: '1818', jobId: '550e8400-e29b-41d4-a716-446655440000', name: 'Happy Home' }],
        ['entry', 'info', 'ready!'],
        ['input', 5, 'enter a num: '],
        ['destroy'],
      ]);
      assert.deepEqual(consoleInputs, [
        { op: 'input_response', id: 5, text: 'hello' },
        { op: 'closed' },
      ]);
    } finally {
      consoleBridge.dispose();
      client.dispose();
      server.close();
    }
  });

  it('DialogBridge bootstraps vsrelapse.dialogs.v1, opens dialogs, and sends choice', async () => {
    const sockPath = makeSocketPath();
    let dialogConn: net.Socket | null = null;
    const sentChoices: unknown[] = [];

    const server = net.createServer((conn) => {
      const state = { buf: Buffer.alloc(0) };
      let channel: string | null = null;
      conn.on('data', (chunk) => {
        for (const msg of decodeFrames(chunk, state)) {
          if (!channel) {
            channel = String(msg.channel);
            conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
            if (channel === '@main') {
              conn.write(encodeFrame({ type: 'hello', pid: 1234, profile: 'default', ready: true, session: 15 }));
            } else if (channel === 'vsrelapse.dialogs.v1') {
              dialogConn = conn;
              conn.write(encodeFrame({
                type: 'open',
                id: 3,
                title: 'Confirm',
                text: 'Proceed?',
                buttons: ['Yes', 'No'],
                icon: 'question',
                default: 1,
              }));
            }
          } else if (channel === '@main' && msg.op === 'execute') {
            conn.write(encodeFrame({ type: 'exec_result', script_id: msg.script_id, phase: 'submitted' }));
          } else if (channel === 'vsrelapse.dialogs.v1' && msg.op === 'choice') {
            sentChoices.push(msg);
            conn.write(encodeFrame({ type: 'close', id: msg.id }));
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const client = new SocketClient(sockPath, 50);
    const dialogBridge = new DialogBridge(client, '-- dialogs script --');

    try {
      const opened: DialogRequest[] = [];
      const closed: number[] = [];
      dialogBridge.on('close', (id: number) => closed.push(id));

      await new Promise<void>((resolve) => {
        client.on('stateChanged', (s: string) => {
          if (s === 'ready') dialogBridge.sync();
        });
        dialogBridge.on('open', async (req: DialogRequest) => {
          opened.push(req);
          assert.equal(await dialogBridge.sendChoice(req.id, 1), true);
          resolve();
        });
        client.start();
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(opened.length, 1);
      assert.equal(opened[0].title, 'Confirm');
      assert.deepEqual(opened[0].buttons, ['Yes', 'No']);
      assert.deepEqual(sentChoices, [{ op: 'choice', id: 3, choice: 1 }]);
      assert.equal(dialogConn !== null, true);
    } finally {
      dialogBridge.dispose();
      client.dispose();
      server.close();
    }
  });
});
