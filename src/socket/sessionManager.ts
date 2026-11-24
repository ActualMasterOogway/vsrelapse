import { EventEmitter } from 'node:events';
import { listClients } from 'relapsesdk';
import * as path from 'node:path';
import { SocketClient, SocketClientState } from './client';
import { OutputState, SessionBridge } from './sessionBridge';
import { ConsoleBridge, ConsolePlace } from './consoleBridge';
import { DialogBridge, DialogRequest } from './dialogBridge';

export interface SessionInfo {
  path: string;
  name: string;
  state: SocketClientState;
  outputState: OutputState;
  session: number;
  pid: number;
  targeted: boolean;
  place: ConsolePlace | null;
}

export interface SessionManagerOptions {
  socketDir?: string;
  sessionScript: string;
  consoleScript: string;
  dialogScript?: string;
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
  dialogs?: DialogBridge;
}

export function profileNameFromSocketPath(socketPath: string): string {
  const base = path.basename(socketPath);
  if (base.startsWith('relapse-') && base.endsWith('.sock')) {
    return base.slice(8, -5);
  }
  return 'No Profile';
}

export class SessionManager extends EventEmitter {
  private readonly socketDir: string;
  private readonly sessionScript: string;
  private readonly consoleScript: string;
  private readonly dialogScript?: string;
  private readonly pollMs: number;
  private outputEnabled: boolean;
  private autoTargetFirst: boolean;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly targeted = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private disposed = false;
  private readonly shutdown = new AbortController();

  constructor(options: SessionManagerOptions) {
    super();
    this.socketDir = options.socketDir ?? '/tmp';
    this.sessionScript = options.sessionScript;
    this.consoleScript = options.consoleScript;
    this.dialogScript = options.dialogScript;
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
    this.shutdown.abort();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const entry of this.sessions.values()) {
      entry.dialogs?.dispose();
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
      const clients = await listClients({ directory: this.socketDir, signal: this.shutdown.signal });
      const discovered = clients.map(client => client.socketPath);
      if (this.disposed) return;

      const discoveredSet = new Set(discovered);
      let changed = false;

      // Remove closed/gone sockets
      for (const [sockPath, entry] of this.sessions.entries()) {
        if (!discoveredSet.has(sockPath)) {
          entry.dialogs?.dispose();
          entry.console.dispose();
          entry.bridge.dispose();
          entry.client.dispose();
          this.sessions.delete(sockPath);
          this.targeted.delete(sockPath);
          changed = true;
        }
      }

      // Add new sockets
      let added = false;
      for (const sockPath of discovered) {
        if (!this.sessions.has(sockPath)) {
          this.addSession(sockPath);
          changed = true;
          added = true;
        }
      }

      if (added && this.autoTargetFirst && this.targeted.size === 0 && this.sessions.size > 0) {
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
    } catch (error) {
      if (!this.disposed) this.emit('entry', '', 'error', error instanceof Error ? error.message : String(error));
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
        place: s.console.getPlace(),
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

  async executeOnTargeted(
    name: string,
    source: string
  ): Promise<Array<{ path: string; name: string; error?: string }>> {
    return Promise.all(this.getTargetedPaths().map(async socketPath => {
      const entry = this.sessions.get(socketPath)!;
      try {
        await entry.bridge.execute(name, source);
        return { path: socketPath, name: entry.name };
      } catch (error) {
        return { path: socketPath, name: entry.name, error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  async sendConsoleInput(socketPath: string, id: number, text: string): Promise<boolean> {
    return this.sessions.get(socketPath)?.console.sendInput(id, text) ?? false;
  }

  async sendConsoleClosed(socketPath: string): Promise<boolean> {
    return this.sessions.get(socketPath)?.console.sendClosed() ?? false;
  }

  async sendDialogChoice(socketPath: string, id: number, choice: number): Promise<boolean> {
    return this.sessions.get(socketPath)?.dialogs?.sendChoice(id, choice) ?? false;
  }

  private addSession(sockPath: string): void {
    const name = profileNameFromSocketPath(sockPath);
    const client = new SocketClient(sockPath);
    const bridge = new SessionBridge(client, this.sessionScript);
    const consoleBridge = new ConsoleBridge(client, this.consoleScript);
    const dialogBridge = this.dialogScript ? new DialogBridge(client, this.dialogScript) : undefined;

    bridge.setOutputEnabled(this.outputEnabled);

    client.on('stateChanged', () => {
      bridge.sync();
      consoleBridge.sync();
      dialogBridge?.sync();
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

    bridge.on('stateChanged', () => {
      this.emit('sessionsChanged');
    });

    bridge.on('entry', (level: string, text: string) => {
      this.emit('entry', sockPath, level, text);
    });

    consoleBridge.on('show', (visible: boolean) => this.emit('consoleShow', sockPath, visible));
    consoleBridge.on('title', (title: string) => this.emit('consoleTitle', sockPath, title));
    consoleBridge.on('clear', () => this.emit('consoleClear', sockPath));
    consoleBridge.on('destroy', () => this.emit('consoleDestroy', sockPath));
    consoleBridge.on('place', () => this.emit('sessionsChanged'));
    consoleBridge.on('entry', (level: string, text: string) =>
      this.emit('consoleEntry', sockPath, level, text)
    );
    consoleBridge.on('input', (id: number, prompt?: string) =>
      this.emit('consoleInput', sockPath, id, prompt)
    );
    consoleBridge.on('error', (detail: string) =>
      this.emit('entry', sockPath, 'error', `[console] ${detail}`)
    );

    if (dialogBridge) {
      dialogBridge.on('open', (req: DialogRequest) => this.emit('dialogOpen', sockPath, req));
      dialogBridge.on('close', (id: number) => this.emit('dialogClose', sockPath, id));
      dialogBridge.on('reset', () => this.emit('dialogReset', sockPath));
      dialogBridge.on('error', (detail: string) =>
        this.emit('entry', sockPath, 'error', `[dialogs] ${detail}`)
      );
    }

    this.sessions.set(sockPath, {
      path: sockPath,
      name,
      client,
      bridge,
      console: consoleBridge,
      dialogs: dialogBridge,
    });

    client.start();
  }
}
