import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configuration } from 'relapsesdk';

export type ScriptNode = ScriptFolderItem | ScriptFileItem;

export type ScriptFolderKind = 'scripts' | 'autoexec' | 'workspace';

export class ScriptFolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderName: string,
    public readonly folderPath: string,
    public readonly kind: ScriptFolderKind,
    collapsibleState: vscode.TreeItemCollapsibleState = kind === 'workspace'
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(folderName, collapsibleState);
    this.id = `folder:${kind}:${folderPath}`;
    this.contextValue = kind === 'workspace' ? 'workspaceFolder' : 'scriptFolder';
    this.description =
      kind === 'autoexec'
        ? 'autoexec'
        : kind === 'workspace' && folderName === 'Workspace'
          ? 'workspace'
          : '';
    this.tooltip = folderPath;
    this.iconPath = new vscode.ThemeIcon(
      kind === 'autoexec' ? 'zap' : kind === 'workspace' ? 'folder-library' : 'folder'
    );
  }
}

export class ScriptFileItem extends vscode.TreeItem {
  constructor(
    public readonly fileName: string,
    public readonly filePath: string
  ) {
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `file:${filePath}`;
    this.contextValue = 'scriptFile';
    this.resourceUri = vscode.Uri.file(filePath);
    this.iconPath = vscode.ThemeIcon.File;
    this.command = {
      command: 'vscode.open',
      title: 'Open Script',
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export function resolveUserPath(rawPath: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export class ScriptsTreeProvider implements vscode.TreeDataProvider<ScriptNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly getScriptsDir: () => string,
    private readonly getProfiles: () => string[] = () => []
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ScriptNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ScriptNode): Promise<ScriptNode[]> {
    if (!element) {
      const scriptsDir = resolveUserPath(this.getScriptsDir());
      const profiles = this.getProfiles();
      const defaultAutoexec = path.join(configuration.configDirectory(), 'autoexec');
      const defaultWorkspace = path.join(configuration.dataDirectory(), 'workspace');
      const configs = await Promise.all(
        (profiles.length ? profiles : [undefined]).map(async (profile) => {
          try {
            return await configuration.resolve(profile);
          } catch {
            return {
              profile: profile ?? 'Default',
              autoexec: defaultAutoexec,
              workspace: defaultWorkspace,
            };
          }
        })
      );
      const autoexec = new Map<string, string[]>();
      const workspaces = new Map<string, string[]>();
      for (const config of configs) {
        const aeNames = autoexec.get(config.autoexec) ?? [];
        aeNames.push(config.profile);
        autoexec.set(config.autoexec, aeNames);

        const wsNames = workspaces.get(config.workspace) ?? [];
        wsNames.push(config.profile);
        workspaces.set(config.workspace, wsNames);
      }
      return [
        new ScriptFolderItem('Scripts', scriptsDir, 'scripts'),
        ...Array.from(
          autoexec,
          ([directory, names]) =>
            new ScriptFolderItem(
              autoexec.size === 1 ? 'Autoexec' : `Autoexec (${names.join(', ')})`,
              directory,
              'autoexec'
            )
        ),
        ...Array.from(
          workspaces,
          ([directory, names]) =>
            new ScriptFolderItem(
              workspaces.size === 1 ? 'Workspace' : `Workspace (${names.join(', ')})`,
              directory,
              'workspace'
            )
        ),
      ];
    }

    if (element instanceof ScriptFolderItem) {
      let names: string[];
      try {
        names = await fs.readdir(element.folderPath);
      } catch {
        return [];
      }
      const nodes: ScriptNode[] = [];
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const full = path.join(element.folderPath, name);
        try {
          const st = await fs.stat(full);
          if (st.isDirectory() && element.kind === 'workspace') {
            nodes.push(
              new ScriptFolderItem(name, full, 'workspace', vscode.TreeItemCollapsibleState.Collapsed)
            );
          } else if (st.isFile()) {
            nodes.push(new ScriptFileItem(name, full));
          }
        } catch {
          // Ignore
        }
      }
      return nodes;
    }

    return [];
  }
}
