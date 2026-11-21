import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AccountStore } from './profiles/account';
import { buildJoinUri, isValidProfileName, ProfileStore } from './profiles/store';
import { profileNameFromSocketPath, SessionManager } from './socket/sessionManager';
import { ConsoleTerminalManager } from './ui/consoleTerminal';
import { ProfilesTreeProvider, ProfileTreeItem } from './ui/profilesView';
import {
  resolveUserPath,
  ScriptFileItem,
  ScriptFolderItem,
  ScriptsTreeProvider,
} from './ui/scriptsView';
import { SessionsTreeProvider, SessionTreeItem } from './ui/sessionsView';

function getConfig() {
  return vscode.workspace.getConfiguration('relapse');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionScript = await fs.readFile(
    path.join(context.extensionPath, 'resources', 'scripts', 'session.luau'),
    'utf8'
  );
  const consoleScript = await fs.readFile(
    path.join(context.extensionPath, 'resources', 'scripts', 'console.luau'),
    'utf8'
  );

  const outputChannel = vscode.window.createOutputChannel('Relapse', { log: true });
  context.subscriptions.push(outputChannel);

  const cfg = getConfig();
  const manager = new SessionManager({
    sessionScript,
    consoleScript,
    redirectOutput: cfg.get<boolean>('redirectOutput', true),
    autoTargetFirst: cfg.get<boolean>('autoTargetFirst', true),
  });
  context.subscriptions.push({ dispose: () => manager.dispose() });

  const profileStore = new ProfileStore();
  const accountStore = new AccountStore(
    undefined,
    path.join(context.globalStorageUri.fsPath, 'avatars')
  );

  const consoleManager = new ConsoleTerminalManager(manager, () =>
    getConfig().get<boolean>('autoOpenConsole', true)
  );
  context.subscriptions.push({ dispose: () => consoleManager.dispose() });

  // Log output routing
  manager.on('entry', (sockPath: string, level: string, text: string) => {
    const multi = manager.listSessions().length > 1;
    const prefix = multi ? `[${profileNameFromSocketPath(sockPath)}] ` : '';
    const line = `${prefix}${text}`;
    if (level === 'error') {
      outputChannel.error(line);
    } else if (level === 'warn') {
      outputChannel.warn(line);
    } else if (level === 'info') {
      outputChannel.info(line);
    } else {
      outputChannel.appendLine(line);
    }
  });

  manager.on('execResult', (sockPath: string, _id: number, submitted: boolean, detail?: string) => {
    if (!submitted) {
      const name = profileNameFromSocketPath(sockPath);
      outputChannel.error(`[${name}] Execution failed: ${detail ?? 'unknown error'}`);
      void vscode.window.showErrorMessage(`Relapse (${name}): ${detail ?? 'Execution failed'}`);
    }
  });

  // TreeViews
  const sessionsProvider = new SessionsTreeProvider(manager);
  const sessionsView = vscode.window.createTreeView('relapse.sessions', {
    treeDataProvider: sessionsProvider,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(sessionsView);

  sessionsView.onDidChangeCheckboxState((e) => {
    for (const [item, state] of e.items) {
      manager.setTargeted(
        item.session.path,
        state === vscode.TreeItemCheckboxState.Checked
      );
    }
  });

  const profilesProvider = new ProfilesTreeProvider(profileStore, accountStore);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('relapse.profiles', profilesProvider)
  );

  const scriptsProvider = new ScriptsTreeProvider(() =>
    getConfig().get<string>('scriptsDir', '~/.local/share/relapse/scripts')
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('relapse.scripts', scriptsProvider)
  );

  // Status Bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'relapse.selectTargets';
  context.subscriptions.push(statusBar);

  const updateStatusBar = () => {
    const all = manager.listSessions();
    const targeted = all.filter((s) => s.targeted);
    if (all.length === 0) {
      statusBar.text = '$(plug) Relapse: No sessions';
      statusBar.tooltip = 'No active Relapse sockets found in /tmp';
    } else if (targeted.length === 0) {
      statusBar.text = `$(plug) Relapse: ${all.length} available (none targeted)`;
      statusBar.tooltip = 'Click to select target Relapse sessions';
    } else {
      const names = targeted.map((s) => s.name).join(', ');
      const readyCount = targeted.filter((s) => s.state === 'ready').length;
      statusBar.text = `$(plug) Relapse: ${names}`;
      statusBar.tooltip = `${readyCount}/${targeted.length} targeted session(s) ready`;
    }
    statusBar.show();
  };

  manager.on('sessionsChanged', updateStatusBar);
  updateStatusBar();

  // Configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const nextCfg = getConfig();
      if (e.affectsConfiguration('relapse.redirectOutput')) {
        manager.setOutputEnabled(nextCfg.get<boolean>('redirectOutput', true));
      }
      if (e.affectsConfiguration('relapse.autoTargetFirst')) {
        manager.setAutoTargetFirst(nextCfg.get<boolean>('autoTargetFirst', true));
      }
      if (e.affectsConfiguration('relapse.scriptsDir')) {
        scriptsProvider.refresh();
      }
    })
  );

  // Helper: execute source on targeted sessions
  const executeSource = async (name: string, source: string) => {
    const targeted = manager.getTargetedPaths();
    if (targeted.length === 0) {
      void vscode.window.showWarningMessage(
        'No Relapse session targeted. Check a session in the Relapse sidebar or launch a profile.'
      );
      return;
    }
    const results = manager.executeOnTargeted(name, source);
    const failed = results.filter((r) => r.result !== 'queued');
    if (failed.length > 0) {
      const msg = failed.map((f) => `${f.name}: ${f.result}`).join(', ');
      void vscode.window.showWarningMessage(`Relapse execution issue: ${msg}`);
    }
  };

  // Commands: Execution & Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand('relapse.executeActive', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const name = path.basename(editor.document.fileName || 'editor.luau');
      await executeSource(name, editor.document.getText());
    }),

    vscode.commands.registerCommand('relapse.executeSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const name = path.basename(editor.document.fileName || 'selection.luau');
      await executeSource(name, editor.document.getText(editor.selection));
    }),

    vscode.commands.registerCommand('relapse.executeFile', async (item?: ScriptFileItem) => {
      if (!item) return;
      const source = await fs.readFile(item.filePath, 'utf8');
      await executeSource(item.fileName, source);
    }),

    vscode.commands.registerCommand('relapse.refreshSessions', () => manager.refresh()),

    vscode.commands.registerCommand('relapse.toggleOutput', async () => {
      const current = getConfig().get<boolean>('redirectOutput', true);
      await getConfig().update('redirectOutput', !current, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `Relapse output redirection ${!current ? 'enabled' : 'disabled'}.`
      );
    }),

    vscode.commands.registerCommand('relapse.openConsole', (item?: SessionTreeItem) => {
      const sockPath = item?.session.path ?? manager.getTargetedPaths()[0];
      if (!sockPath) {
        void vscode.window.showWarningMessage('No active Relapse session.');
        return;
      }
      consoleManager.show(sockPath);
    }),

    vscode.commands.registerCommand('relapse.selectTargets', async () => {
      const sessions = manager.listSessions();
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage('No active Relapse sessions found in /tmp.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.name,
          description: s.state,
          detail: s.path,
          picked: s.targeted,
        })),
        {
          canPickMany: true,
          placeHolder: 'Select Relapse session(s) to target for execution',
        }
      );
      if (!picks) return;
      const chosen = new Set(picks.map((p) => p.detail));
      for (const s of sessions) {
        manager.setTargeted(s.path, chosen.has(s.path));
      }
    })
  );

  // Commands: Profiles & Accounts
  const resolveLauncherPath = async (): Promise<string | null> => {
    let launcher = getConfig().get<string>('launcherPath', '').trim();
    if (!launcher) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: 'Select Relapse Launcher Executable',
      });
      if (!picked || picked.length === 0) return null;
      launcher = picked[0].fsPath;
      await getConfig().update('launcherPath', launcher, vscode.ConfigurationTarget.Global);
    }
    return launcher;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('relapse.refreshProfiles', () => profilesProvider.refresh()),

    vscode.commands.registerCommand('relapse.createProfile', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'New Relapse profile name',
        placeHolder: 'alt1',
        validateInput: (val) =>
          isValidProfileName(val.trim())
            ? null
            : 'Use 1–64 letters, digits, dots, underscores or hyphens (excluding . and ..).',
      });
      if (!name) return;
      try {
        await profileStore.createProfile(name.trim());
        profilesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.launchProfile', async (item?: ProfileTreeItem) => {
      if (!item) return;
      const launcher = await resolveLauncherPath();
      if (!launcher) return;
      try {
        await profileStore.launchProfile(launcher, item.profile.name);
        setTimeout(() => profilesProvider.refresh(), 500);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand(
      'relapse.launchProfileToPlace',
      async (item?: ProfileTreeItem) => {
        if (!item) return;
        const launcher = await resolveLauncherPath();
        if (!launcher) return;
        const placeId = await vscode.window.showInputBox({
          prompt: `Place ID to join with profile "${item.profile.name}"`,
          placeHolder: 'e.g. 1818',
        });
        if (placeId === undefined) return;
        const jobId = await vscode.window.showInputBox({
          prompt: 'Optional Job ID (UUID) — leave empty to join any server',
          placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        });
        if (jobId === undefined) return;
        try {
          buildJoinUri(placeId, jobId);
          await profileStore.launchProfile(launcher, item.profile.name, placeId, jobId);
          setTimeout(() => profilesProvider.refresh(), 500);
        } catch (err) {
          void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }
    ),

    vscode.commands.registerCommand('relapse.importCookie', async (item?: ProfileTreeItem) => {
      if (!item) return;
      const raw = await vscode.window.showInputBox({
        prompt: `Paste .ROBLOSECURITY cookie for "${item.profile.name}"`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!raw) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Verifying Roblox account for "${item.profile.name}"…`,
        },
        async () => {
          try {
            const account = await accountStore.lookupAccount(raw);
            await accountStore.importAccount(item.profile.name, raw, account, false);
            profilesProvider.refresh();
            void vscode.window.showInformationMessage(
              `Imported @${account.username} (${account.displayName}) into "${item.profile.name}".`
            );
          } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
          }
        }
      );
    }),

    vscode.commands.registerCommand('relapse.refreshAccount', async (item?: ProfileTreeItem) => {
      if (!item) return;
      try {
        const cookie = await accountStore.readCookie(item.profile.name);
        if (!cookie) {
          void vscode.window.showWarningMessage(
            `No .ROBLOSECURITY cookie found for "${item.profile.name}".`
          );
          return;
        }
        const account = await accountStore.lookupAccount(cookie);
        await accountStore.saveAccount(item.profile.name, account);
        profilesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.renameProfile', async (item?: ProfileTreeItem) => {
      if (!item) return;
      const replacement = await vscode.window.showInputBox({
        prompt: `Rename profile "${item.profile.name}"`,
        value: item.profile.name,
        validateInput: (val) =>
          isValidProfileName(val.trim())
            ? null
            : 'Use 1–64 letters, digits, dots, underscores or hyphens (excluding . and ..).',
      });
      if (!replacement || replacement.trim() === item.profile.name) return;
      try {
        await profileStore.renameProfile(item.profile.name, replacement.trim());
        profilesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.deleteProfile', async (item?: ProfileTreeItem) => {
      if (!item) return;
      const confirm = await vscode.window.showWarningMessage(
        `Move profile "${item.profile.name}" to Trash?`,
        { modal: true },
        'Move to Trash'
      );
      if (confirm !== 'Move to Trash') return;
      try {
        const prep = await profileStore.prepareDeleteProfile(item.profile.name);
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(prep.path), {
            recursive: true,
            useTrash: true,
          });
        } catch (err) {
          await prep.restorePermissions();
          throw err;
        }
        profilesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    })
  );

  // Commands: Scripts
  context.subscriptions.push(
    vscode.commands.registerCommand('relapse.refreshScripts', () => scriptsProvider.refresh()),

    vscode.commands.registerCommand('relapse.newScript', async (item?: ScriptFolderItem) => {
      const folder =
        item?.folderPath ??
        resolveUserPath(getConfig().get<string>('scriptsDir', '~/.local/share/relapse/scripts'));
      const fileName = await vscode.window.showInputBox({
        prompt: 'New script filename',
        placeHolder: 'script.luau',
        validateInput: (val) =>
          !val.trim() || val.includes('/') || val.includes('\\')
            ? 'Enter a valid filename.'
            : null,
      });
      if (!fileName) return;
      await fs.mkdir(folder, { recursive: true });
      const target = path.join(folder, fileName.trim());
      try {
        await fs.writeFile(target, '', { flag: 'wx', encoding: 'utf8' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      scriptsProvider.refresh();
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('relapse.deleteScript', async (item?: ScriptFileItem) => {
      if (!item) return;
      const confirm = await vscode.window.showWarningMessage(
        `Move "${item.fileName}" to Trash?`,
        { modal: true },
        'Move to Trash'
      );
      if (confirm !== 'Move to Trash') return;
      await vscode.workspace.fs.delete(vscode.Uri.file(item.filePath), { useTrash: true });
      scriptsProvider.refresh();
    })
  );

  manager.start();
}

export function deactivate(): void {
  // Disposed via context.subscriptions
}
