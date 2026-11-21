import * as vscode from 'vscode';
import { SessionInfo, SessionManager } from '../socket/sessionManager';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionInfo) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    this.id = session.path;
    this.contextValue = 'session';

    const stateLabel =
      session.state === 'ready'
        ? session.outputState === 'active'
          ? 'Ready • Output On'
          : session.outputState === 'failed'
            ? 'Ready • Output Failed'
            : 'Ready'
        : session.state === 'waiting'
          ? 'Waiting for game'
          : session.state === 'connecting'
            ? 'Connecting…'
            : 'Disconnected';

    this.description = session.session > 0 ? `${stateLabel} (#${session.session})` : stateLabel;
    this.tooltip = `${session.name}\nSocket: ${session.path}\nState: ${stateLabel}`;
    this.iconPath = new vscode.ThemeIcon(
      session.state === 'ready'
        ? 'plug'
        : session.state === 'waiting'
          ? 'clock'
          : 'debug-disconnect',
      session.state === 'ready'
        ? new vscode.ThemeColor('testing.iconPassed')
        : session.state === 'waiting'
          ? new vscode.ThemeColor('notificationsWarningIcon.foreground')
          : undefined
    );
    this.checkboxState = session.targeted
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: SessionManager) {
    this.manager.on('sessionsChanged', () => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionTreeItem[] {
    return this.manager.listSessions().map((s) => new SessionTreeItem(s));
  }
}
