import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as vscode from 'vscode';

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

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('ActualMasterOogway.vsrelapse');
  assert.ok(ext, 'ActualMasterOogway.vsrelapse extension should be loaded in Code Insiders');
  await ext.activate();
  assert.equal(ext.isActive, true, 'extension should be active');

  const commands = await vscode.commands.getCommands(true);
  const expectedCommands = [
    'relapse.executeActive',
    'relapse.executeSelection',
    'relapse.executeFile',
    'relapse.showOutput',
    'relapse.refreshSessions',
    'relapse.toggleOutput',
    'relapse.openConsole',
    'relapse.selectTargets',
    'relapse.refreshProfiles',
    'relapse.createProfile',
    'relapse.launchProfile',
    'relapse.launchProfileToPlace',
    'relapse.importCookie',
    'relapse.refreshAccount',
    'relapse.renameProfile',
    'relapse.deleteProfile',
    'relapse.refreshScripts',
    'relapse.newScript',
    'relapse.deleteScript',
    'relapse.openGlobalConfig',
    'relapse.openProfileConfig',
    'relapse.copyJoinUri',
  ];
  for (const cmd of expectedCommands) {
    assert.ok(commands.includes(cmd), `Command ${cmd} should be registered`);
  }

  // Start a mock Relapse socket in /tmp and verify end-to-end execution from Code Insiders
  const sockPath = `/tmp/relapse-vse2e${process.pid}.sock`;
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {
    // Ignore
  }

  const executedNames: string[] = [];
  const executedSources: string[] = [];

  const server = net.createServer((conn) => {
    const state = { buf: Buffer.alloc(0) };
    let channel: string | null = null;
    conn.on('data', (chunk) => {
      for (const msg of decodeFrames(chunk, state)) {
        if (!channel) {
          channel = String(msg.channel);
          conn.write(encodeFrame({ ok: true, version: 1, max_message_bytes: 1048576 }));
          if (channel === '@main') {
            conn.write(encodeFrame({ type: 'hello', pid: 1234, profile: 'default', ready: true, session: 99 }));
          }
        } else if (channel === '@main' && msg.op === 'execute') {
          executedNames.push(String(msg.name));
          executedSources.push(String(msg.source));
          conn.write(encodeFrame({ type: 'exec_result', script_id: msg.script_id, phase: 'submitted' }));
        } else if (channel === 'vsrelapse.session.v2' && msg.op === 'configure') {
          conn.write(encodeFrame({ type: 'configured', version: 2, redirect: msg.redirect }));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  try {
    await vscode.commands.executeCommand('relapse.refreshSessions');
    // Wait for session discovery + channel bootstrap
    await new Promise((r) => setTimeout(r, 800));

    const doc = await vscode.workspace.openTextDocument({
      language: 'lua',
      content: 'print("hello from code-insiders")',
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('relapse.executeActive');
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(
      executedNames.includes('vsrelapse-session.luau'),
      `Expected vsrelapse-session.luau bootstrap, got: ${JSON.stringify(executedNames)}`
    );
    assert.ok(
      executedNames.includes('vsrelapse-console.luau'),
      `Expected vsrelapse-console.luau bootstrap, got: ${JSON.stringify(executedNames)}`
    );
    assert.ok(
      executedNames.includes('vsrelapse-dialogs.luau'),
      `Expected vsrelapse-dialogs.luau bootstrap, got: ${JSON.stringify(executedNames)}`
    );
    assert.ok(
      executedSources.some((s) => s.includes('hello from code-insiders')),
      `Expected editor script execution, got: ${JSON.stringify(executedSources)}`
    );

    await vscode.commands.executeCommand('relapse.openConsole');
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    server.close();
    try {
      fs.rmSync(sockPath, { force: true });
    } catch {
      // Ignore
    }
  }
}
