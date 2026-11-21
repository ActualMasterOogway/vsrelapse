import * as vscode from 'vscode';
import { AccountStore, ProfileAccount } from '../profiles/account';
import { ProfileStore } from '../profiles/store';

export interface ProfileEntry {
  name: string;
  running: boolean;
  account: ProfileAccount | null;
  avatarPath: string | null;
}

export class ProfileTreeItem extends vscode.TreeItem {
  constructor(public readonly profile: ProfileEntry) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.id = profile.name;
    this.contextValue = 'profile';

    const parts: string[] = [];
    if (profile.account) {
      parts.push(`@${profile.account.username}`);
    }
    if (profile.running) {
      parts.push('Running');
    }
    this.description = parts.join(' • ');

    const tipLines = [`Profile: ${profile.name}`];
    if (profile.account) {
      tipLines.push(`Account: ${profile.account.displayName} (@${profile.account.username})`);
    }
    tipLines.push(`Status: ${profile.running ? 'Running' : 'Stopped'}`);
    this.tooltip = tipLines.join('\n');

    if (profile.avatarPath) {
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

  constructor(
    private readonly profileStore: ProfileStore,
    private readonly accountStore: AccountStore
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProfileTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ProfileTreeItem[]> {
    const names = await this.profileStore.listProfiles();
    const entries = await Promise.all(
      names.map(async (name): Promise<ProfileEntry> => {
        const running = await this.profileStore.isProfileRunning(name);
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
        return { name, running, account, avatarPath };
      })
    );
    return entries.map((e) => new ProfileTreeItem(e));
  }
}
