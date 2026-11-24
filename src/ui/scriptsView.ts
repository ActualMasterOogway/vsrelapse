import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configuration } from 'relapsesdk';

export type ScriptNode = ScriptFolderItem | ScriptFileItem;

export class ScriptFolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderName: string,
    public readonly folderPath: string,
    public readonly isAutoexec: boolean
  ) {
    super(folderName, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folderPath}`;
    this.contextValue = 'scriptFolder';
    this.description = isAutoexec ? 'autoexec' : '';
    this.tooltip = folderPath;
    this.iconPath = new vscode.ThemeIcon(isAutoexec ? 'zap' : 'folder');
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
      const configs = await Promise.all((profiles.length ? profiles : [undefined]).map(profile => configuration.resolve(profile)));
      const autoexec = new Map<string, string[]>();
      for (const config of configs) {
        const names = autoexec.get(config.autoexec) ?? [];
        names.push(config.profile);
        autoexec.set(config.autoexec, names);
      }
      return [
        new ScriptFolderItem('Scripts', scriptsDir, false),
        ...Array.from(autoexec, ([directory, names]) => new ScriptFolderItem(
          autoexec.size === 1 ? 'Autoexec' : `Autoexec (${names.join(', ')})`, directory, true
        )),
      ];
    }

    if (element instanceof ScriptFolderItem) {
      let names: string[];
      try {
        names = await fs.readdir(element.folderPath);
      } catch {
        return [];
      }
      const files: ScriptFileItem[] = [];
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const full = path.join(element.folderPath, name);
        try {
          const st = await fs.stat(full);
          if (st.isFile()) {
            files.push(new ScriptFileItem(name, full));
          }
        } catch {
          // Ignore
        }
      }
      return files;
    }

    return [];
  }
}
