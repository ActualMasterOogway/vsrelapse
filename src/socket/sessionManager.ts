import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { SocketClient, SocketClientSendResult, SocketClientState } from './client';
import { OutputState, SessionBridge } from './sessionBridge';
import { ConsoleBridge } from './consoleBridge';

export interface SessionInfo {
  path: string;
  name: string;
  state: SocketClientState;
  outputState: OutputState;
  session: number;
  pid: number;
  targeted: boolean;
}

export interface SessionManagerOptions {
  socketDir?: string;
  sessionScript: string;
  consoleScript: string;
  redirectOutput?: boolean;
  autoTargetFirst?: boolean;
  pollMs?: number;
}

interface ManagedSession {
  path: string;
  name: string;
  client: SocketClient;
  bridge: SessionBridge;
  console: ConsoleBridge;
}

export function profileNameFromSocketPath(socketPath: string): string {
  const base = path.basename(socketPath);
  if (base.startsWith('relapse-') && base.endsWith('.sock')) {
    return base.slice(8, -5);
  }
  return 'No Profile';
}

function isValidSocketProfileName(name: string): boolean {
  return name !== '.' && name !== '..' && /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

async function isSocketListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(200, () => done(false));
  });
}

export class SessionManager extends EventEmitter {
  private readonly socketDir: string;
  private readonly sessionScript: string;
  private readonly consoleScript: string;
  private readonly pollMs: number;
  private outputEnabled: boolean;
  private autoTargetFirst: boolean;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly targeted = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private disposed = false;

  constructor(options: SessionManagerOptions) {
    super();
    this.socketDir = options.socketDir ?? '/tmp';
    this.sessionScript = options.sessionScript;
    this.consoleScript = options.consoleScript;
    this.outputEnabled = options.redirectOutput ?? true;
    this.autoTargetFirst = options.autoTargetFirst ?? true;
    this.pollMs = options.pollMs ?? 1000;
  }

  start(): void {
    if (this.disposed || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollMs);
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const entry of this.sessions.values()) {
      entry.console.dispose();
      entry.bridge.dispose();
      entry.client.dispose();
    }
    this.sessions.clear();
    this.targeted.clear();
    this.removeAllListeners();
  }

  setAutoTargetFirst(enabled: boolean): void {
    this.autoTargetFirst = enabled;
  }

  setOutputEnabled(enabled: boolean): void {
    this.outputEnabled = enabled;
    for (const entry of this.sessions.values()) {
      entry.bridge.setOutputEnabled(enabled);
    }
    this.emit('sessionsChanged');
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      const discovered = await this.discoverSockets();
      if (this.disposed) return;

      const discoveredSet = new Set(discovered);
      let changed = false;

      // Remove closed/gone sockets
      for (const [sockPath, entry] of this.sessions.entries()) {
        if (!discoveredSet.has(sockPath)) {
          entry.console.dispose();
          entry.bridge.dispose();
          entry.client.dispose();
          this.sessions.delete(sockPath);
          this.targeted.delete(sockPath);
          changed = true;
        }
      }

      // Add new sockets
      for (const sockPath of discovered) {
        if (!this.sessions.has(sockPath)) {
          this.addSession(sockPath);
          changed = true;
        }
      }

      if (this.autoTargetFirst && this.targeted.size === 0 && this.sessions.size > 0) {
        const firstReady = Array.from(this.sessions.values()).find((s) => s.client.isReady());
        const pick = firstReady ?? Array.from(this.sessions.values())[0];
        if (pick) {
          this.targeted.add(pick.path);
          changed = true;
        }
      }

      if (changed) {
        this.emit('sessionsChanged');
      }
    } finally {
      this.refreshing = false;
    }
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => {
        if (a.name === 'No Profile' && b.name !== 'No Profile') return -1;
        if (b.name === 'No Profile' && a.name !== 'No Profile') return 1;
        return a.name.localeCompare(b.name);
      })
      .map((s) => ({
        path: s.path,
        name: s.name,
        state: s.client.getState(),
        outputState: s.bridge.getState(),
        session: s.client.getSession(),
        pid: s.client.getPeerPid(),
        targeted: this.targeted.has(s.path),
      }));
  }

  setTargeted(socketPath: string, targeted: boolean): void {
    if (!this.sessions.has(socketPath)) return;
    if (targeted) {
      this.targeted.add(socketPath);
    } else {
      this.targeted.delete(socketPath);
    }
    this.emit('sessionsChanged');
  }

  getTargetedPaths(): string[] {
    return Array.from(this.targeted).filter((p) => this.sessions.has(p));
  }

  executeOnTargeted(
    name: string,
    source: string
  ): Array<{ path: string; name: string; result: SocketClientSendResult }> {
    const targets = this.getTargetedPaths();
    const results: Array<{ path: string; name: string; result: SocketClientSendResult }> = [];
    for (const sockPath of targets) {
      const entry = this.sessions.get(sockPath);
      if (!entry) continue;
      const result = entry.bridge.execute(name, source);
      results.push({ path: sockPath, name: entry.name, result });
    }
    return results;
  }

  sendConsoleInput(socketPath: string, id: number, text: string): boolean {
    const entry = this.sessions.get(socketPath);
    if (!entry) return false;
    return entry.console.sendInput(id, text);
  }

  private async discoverSockets(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.socketDir);
    } catch {
      return [];
    }

    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const candidates: string[] = [];

    for (const name of names) {
      if (name !== 'relapse.sock') {
        if (!name.startsWith('relapse-') || !name.endsWith('.sock')) continue;
        const profile = name.slice(8, -5);
        if (!isValidSocketProfileName(profile)) continue;
      }
      const fullPath = path.join(this.socketDir, name);
      try {
        const st = await fs.lstat(fullPath);
        if (!st.isSocket()) continue;
        if (uid >= 0 && st.uid !== uid) continue;
        if (await isSocketListening(fullPath)) {
          candidates.push(fullPath);
        }
      } catch {
        // Skip disappearing/unreadable entries
      }
    }

    return candidates.sort();
  }

  private addSession(sockPath: string): void {
    const name = profileNameFromSocketPath(sockPath);
    const client = new SocketClient(sockPath);
    const bridge = new SessionBridge(client, this.sessionScript);
    const consoleBridge = new ConsoleBridge(client, this.consoleScript);

    bridge.setOutputEnabled(this.outputEnabled);

    client.on('stateChanged', () => {
      bridge.sync();
      consoleBridge.sync();
      if (this.autoTargetFirst && this.targeted.size === 0 && client.isReady()) {
        this.targeted.add(sockPath);
      }
      this.emit('sessionsChanged');
    });

    client.on('log', (level: string, text: string) => {
      this.emit('entry', sockPath, level, text);
    });

    client.on('error', (detail: string) => {
      this.emit('entry', sockPath, 'error', detail);
    });

    client.on('execResult', (id: number, submitted: boolean, detail?: string) => {
      const handledByBridge = bridge.handleExecResult(id, submitted, detail);
      const handledByConsole = consoleBridge.handleExecResult(id, submitted, detail);
      if (!handledByBridge && !handledByConsole) {
        this.emit('execResult', sockPath, id, submitted, detail);
      }
    });

    bridge.on('stateChanged', () => {
      this.emit('sessionsChanged');
    });

    bridge.on('entry', (level: string, text: string) => {
      this.emit('entry', sockPath, level, text);
    });

    consoleBridge.on('show', (visible: boolean) => this.emit('consoleShow', sockPath, visible));
    consoleBridge.on('title', (title: string) => this.emit('consoleTitle', sockPath, title));
    consoleBridge.on('clear', () => this.emit('consoleClear', sockPath));
    consoleBridge.on('entry', (level: string, text: string) =>
      this.emit('consoleEntry', sockPath, level, text)
    );
    consoleBridge.on('input', (id: number) => this.emit('consoleInput', sockPath, id));
    consoleBridge.on('error', (detail: string) =>
      this.emit('entry', sockPath, 'error', `[console] ${detail}`)
    );

    this.sessions.set(sockPath, {
      path: sockPath,
      name,
      client,
      bridge,
      console: consoleBridge,
    });

    client.start();
  }
}
