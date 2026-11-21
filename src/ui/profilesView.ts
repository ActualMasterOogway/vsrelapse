import * as vscode from 'vscode';
import { AccountStore, ProfileAccount } from '../profiles/account';
import { ProfileStore } from '../profiles/store';
import { SessionInfo } from '../socket/sessionManager';

export interface ProfileEntry {
  name: string;
  running: boolean;
  launching: boolean;
  sessionState?: SessionInfo['state'];
  sessionPath?: string;
  account: ProfileAccount | null;
  avatarPath: string | null;
}

export class ProfileTreeItem extends vscode.TreeItem {
  constructor(public readonly profile: ProfileEntry) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.id = profile.name;
    this.contextValue = profile.launching
      ? 'profileLaunching'
      : profile.running
        ? 'profileRunning'
        : 'profile';

    const parts: string[] = [];
    if (profile.account) {
      parts.push(`@${profile.account.username}`);
    }
    if (profile.launching) {
      parts.push('Launching…');
    } else if (profile.sessionState === 'ready') {
      parts.push('Ready');
    } else if (profile.sessionState === 'waiting') {
      parts.push('Waiting for game');
    } else if (profile.sessionState === 'connecting') {
      parts.push('Connecting…');
    } else if (profile.running) {
      parts.push('Running');
    }
    this.description = parts.join(' • ');

    const tipLines = [`Profile: ${profile.name}`];
    if (profile.account) {
      tipLines.push(`Account: ${profile.account.displayName} (@${profile.account.username})`);
    }
    tipLines.push(
      `Status: ${
        profile.launching
          ? 'Launching…'
          : profile.sessionState
            ? `Running (${profile.sessionState})`
            : profile.running
              ? 'Running'
              : 'Stopped'
      }`
    );
    this.tooltip = tipLines.join('\n');

    if (profile.launching) {
      this.iconPath = new vscode.ThemeIcon(
        'loading~spin',
        new vscode.ThemeColor('charts.blue')
      );
    } else if (profile.avatarPath) {
      this.iconPath = vscode.Uri.file(profile.avatarPath);
    } else {
      this.iconPath = new vscode.ThemeIcon(
        profile.running ? 'vm-running' : 'account',
        profile.running ? new vscode.ThemeColor('testing.iconPassed') : undefined
      );
    }
  }
}

export class ProfilesTreeProvider implements vscode.TreeDataProvider<ProfileTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly launchingProfiles = new Set<string>();

  constructor(
    private readonly profileStore: ProfileStore,
    private readonly accountStore: AccountStore,
    private readonly getSessions: () => SessionInfo[] = () => []
  ) {}

  setLaunching(name: string, launching: boolean): void {
    if (launching) {
      this.launchingProfiles.add(name);
    } else {
      this.launchingProfiles.delete(name);
    }
    this.refresh();
  }

  getLaunchingProfiles(): string[] {
    return Array.from(this.launchingProfiles);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProfileTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ProfileTreeItem[]> {
    const names = await this.profileStore.listProfiles();
    const sessionsByName = new Map<string, SessionInfo>();
    for (const session of this.getSessions()) {
      sessionsByName.set(session.name, session);
    }

    const entries = await Promise.all(
      names.map(async (name): Promise<ProfileEntry> => {
        const session = sessionsByName.get(name);
        const launching = this.launchingProfiles.has(name);
        const running = Boolean(session) || (await this.profileStore.isProfileRunning(name));
        let account: ProfileAccount | null = null;
        let avatarPath: string | null = null;
        try {
          const cookie = await this.accountStore.readCookie(name);
          account = await this.accountStore.loadAccount(name, cookie);
          if (account) {
            avatarPath = await this.accountStore.getAvatarPath(name, account);
          }
        } catch {
          // Best-effort account info
        }
        return {
          name,
          running,
          launching,
          sessionState: session?.state,
          sessionPath: session?.path,
          account,
          avatarPath,
        };
      })
    );
    return entries.map((e) => new ProfileTreeItem(e));
  }
}
