import * as vscode from 'vscode';
import { SessionInfo, SessionManager } from '../socket/sessionManager';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionInfo) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    this.id = session.path;
    this.contextValue = session.place ? 'sessionInGame' : 'session';

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

    const placeLabel = session.place
      ? (session.place.name ?? `Place ${session.place.placeId}`)
      : undefined;
    const descParts = [session.session > 0 ? `${stateLabel} (#${session.session})` : stateLabel];
    if (placeLabel) descParts.push(placeLabel);
    this.description = descParts.join(' • ');

    const tipLines = [
      session.name,
      `Socket: ${session.path}`,
      `State: ${stateLabel}`,
    ];
    if (session.pid > 0) tipLines.push(`PID: ${session.pid}`);
    if (session.place) {
      tipLines.push(
        `Place: ${session.place.name ? `${session.place.name} (${session.place.placeId})` : session.place.placeId}`,
        `Job ID: ${session.place.jobId}`
      );
    }
    this.tooltip = tipLines.join('\n');
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
