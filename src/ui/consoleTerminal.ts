import * as vscode from 'vscode';
import { SessionManager } from '../socket/sessionManager';

interface ConsoleSessionState {
  terminal?: vscode.Terminal;
  pty?: RelapseConsolePty;
  title: string;
  pendingInputId: number | null;
  lineBuffer: string;
}

class RelapseConsolePty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidChangeName = this.nameEmitter.event;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onClosed: () => void,
    private readonly getInputBuffer: () => string,
    private readonly setInputBuffer: (next: string) => void,
    private readonly isWaitingInput: () => boolean
  ) {}

  open(): void {
    this.writeEmitter.fire('\x1b[90m[Relapse rconsole connected]\x1b[0m\r\n');
  }

  close(): void {
    this.onClosed();
  }

  writeLine(level: string, text: string): void {
    const normalized = text.replace(/\r?\n/g, '\r\n');
    let prefix = '';
    let suffix = '\x1b[0m';
    if (level === 'warn') {
      prefix = '\x1b[33m';
    } else if (level === 'error') {
      prefix = '\x1b[31m';
    } else if (level === 'info') {
      prefix = '\x1b[36m';
    } else {
      suffix = '';
    }
    this.writeEmitter.fire(`${prefix}${normalized}${suffix}\r\n`);
  }

  promptInput(): void {
    this.writeEmitter.fire('\x1b[32m> \x1b[0m');
  }

  clear(): void {
    this.writeEmitter.fire('\x1b[2J\x1b[3J\x1b[H');
  }

  rename(title: string): void {
    this.nameEmitter.fire(title);
  }

  handleInput(data: string): void {
    if (!this.isWaitingInput()) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = this.getInputBuffer();
        this.setInputBuffer('');
        this.writeEmitter.fire('\r\n');
        this.onLine(line);
      } else if (ch === '\x7f' || ch === '\b') {
        const cur = this.getInputBuffer();
        if (cur.length > 0) {
          this.setInputBuffer(cur.slice(0, -1));
          this.writeEmitter.fire('\b \b');
        }
      } else if (ch >= ' ') {
        this.setInputBuffer(this.getInputBuffer() + ch);
        this.writeEmitter.fire(ch);
      }
    }
  }
}

export class ConsoleTerminalManager {
  private readonly states = new Map<string, ConsoleSessionState>();

  constructor(
    private readonly manager: SessionManager,
    private readonly autoOpen: () => boolean
  ) {
    manager.on('consoleTitle', (sockPath: string, title: string) => {
      const st = this.getOrCreateState(sockPath);
      st.title = title;
      st.pty?.rename(title);
    });

    manager.on('consoleShow', (sockPath: string, visible: boolean) => {
      if (visible && this.autoOpen()) {
        this.show(sockPath);
      } else if (!visible) {
        this.states.get(sockPath)?.terminal?.hide();
      }
    });

    manager.on('consoleClear', (sockPath: string) => {
      this.states.get(sockPath)?.pty?.clear();
    });

    manager.on('consoleEntry', (sockPath: string, level: string, text: string) => {
      const st = this.ensureTerminal(sockPath, this.autoOpen());
      st.pty?.writeLine(level, text);
    });

    manager.on('consoleInput', (sockPath: string, id: number) => {
      const st = this.ensureTerminal(sockPath, true);
      st.pendingInputId = id;
      st.lineBuffer = '';
      st.pty?.promptInput();
    });
  }

  show(sockPath: string): void {
    const st = this.ensureTerminal(sockPath, true);
    st.terminal?.show(false);
  }

  dispose(): void {
    for (const st of this.states.values()) {
      st.terminal?.dispose();
    }
    this.states.clear();
  }

  private getOrCreateState(sockPath: string): ConsoleSessionState {
    let st = this.states.get(sockPath);
    if (!st) {
      const sessionName =
        this.manager.listSessions().find((s) => s.path === sockPath)?.name ?? 'Relapse';
      st = {
        title: `Relapse Console (${sessionName})`,
        pendingInputId: null,
        lineBuffer: '',
      };
      this.states.set(sockPath, st);
    }
    return st;
  }

  private ensureTerminal(sockPath: string, showNow: boolean): ConsoleSessionState {
    const st = this.getOrCreateState(sockPath);
    if (!st.terminal || !st.pty) {
      const pty = new RelapseConsolePty(
        (line) => {
          if (st.pendingInputId !== null) {
            const id = st.pendingInputId;
            st.pendingInputId = null;
            this.manager.sendConsoleInput(sockPath, id, line);
          }
        },
        () => {
          st.terminal = undefined;
          st.pty = undefined;
          st.pendingInputId = null;
          st.lineBuffer = '';
        },
        () => st.lineBuffer,
        (next) => {
          st.lineBuffer = next;
        },
        () => st.pendingInputId !== null
      );
      st.pty = pty;
      st.terminal = vscode.window.createTerminal({
        name: st.title,
        pty,
        iconPath: new vscode.ThemeIcon('terminal'),
      });
      if (showNow) {
        st.terminal.show(true);
      }
    } else if (showNow) {
      st.terminal.show(true);
    }
    return st;
  }
}
