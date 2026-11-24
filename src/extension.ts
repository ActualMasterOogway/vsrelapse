import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configuration } from 'relapsesdk';
import { AccountStore } from './profiles/account';
import {
  findDefaultLauncher,
  migrateLegacyProfiles,
  migrateLegacyScriptsDir,
} from './profiles/migrate';
import { buildJoinUri, isValidProfileName, ProfileStore } from './profiles/store';
import { profileNameFromSocketPath, SessionManager } from './socket/sessionManager';
import type { DialogRequest } from './socket/dialogBridge';
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
  const dialogScript = await fs.readFile(
    path.join(context.extensionPath, 'resources', 'scripts', 'dialogs.luau'),
    'utf8'
  );

  const outputChannel = vscode.window.createOutputChannel('Relapse', { log: true });
  context.subscriptions.push(outputChannel);

  const cfg = getConfig();
  const manager = new SessionManager({
    sessionScript,
    consoleScript,
    dialogScript,
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
    const prefix = sockPath && multi ? `[${profileNameFromSocketPath(sockPath)}] ` : '';
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

  // In-game messagebox / MessageBox dialogs (vsrelapse.dialogs.v1)
  const activeDialogs = new Map<string, { cancelled: boolean }>();
  manager.on('dialogOpen', (sockPath: string, req: DialogRequest) => {
    const key = `${sockPath}:${req.id}`;
    const tracker = { cancelled: false };
    activeDialogs.set(key, tracker);

    const sessionName = profileNameFromSocketPath(sockPath);
    const titlePrefix = req.title && req.title !== 'Relapse' ? `${req.title} (${sessionName})` : `Relapse (${sessionName})`;
    const message = req.text ? `${titlePrefix}\n\n${req.text}` : titlePrefix;
    const items: vscode.MessageItem[] = req.buttons.map((title) => ({ title }));
    const picker =
      req.icon === 'error'
        ? vscode.window.showErrorMessage
        : req.icon === 'warning'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;

    void picker(message, { modal: true }, ...items).then((picked) => {
      activeDialogs.delete(key);
      if (tracker.cancelled) return;
      const choice = picked ? req.buttons.indexOf(picked.title) + 1 : 0;
      void manager.sendDialogChoice(sockPath, req.id, choice);
    });
  });

  manager.on('dialogClose', (sockPath: string, id: number) => {
    const tracker = activeDialogs.get(`${sockPath}:${id}`);
    if (tracker) {
      tracker.cancelled = true;
      activeDialogs.delete(`${sockPath}:${id}`);
    }
  });

  manager.on('dialogReset', (sockPath: string) => {
    for (const [key, tracker] of activeDialogs.entries()) {
      if (key.startsWith(`${sockPath}:`)) {
        tracker.cancelled = true;
        activeDialogs.delete(key);
      }
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

  const profilesProvider = new ProfilesTreeProvider(profileStore, accountStore, () =>
    manager.listSessions()
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('relapse.profiles', profilesProvider)
  );

  const scriptsProvider = new ScriptsTreeProvider(
    () => getConfig().get<string>('scriptsDir', '~/.local/share/relapse/scripts'),
    () => manager.listSessions()
      .filter(session => session.targeted && session.name !== 'No Profile')
      .map(session => session.name)
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('relapse.scripts', scriptsProvider)
  );

  // Status Bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'relapse.selectTargets';
  context.subscriptions.push(statusBar);

  const updateStatusBar = () => {
    const launching = profilesProvider.getLaunchingProfiles();
    const all = manager.listSessions();
    const targeted = all.filter((s) => s.targeted);
    if (launching.length > 0) {
      statusBar.text = `$(loading~spin) Relapse: Launching ${launching.join(', ')}…`;
      statusBar.tooltip = 'Waiting for Relapse session socket to appear';
    } else if (all.length === 0) {
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

  manager.on('sessionsChanged', () => {
    updateStatusBar();
    profilesProvider.refresh();
    scriptsProvider.refresh();
  });
  updateStatusBar();

  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(configuration.configDirectory(), '**/config.json')
  );
  const refreshConfiguration = () => {
    profilesProvider.refresh();
    scriptsProvider.refresh();
  };
  context.subscriptions.push(configWatcher,
    configWatcher.onDidCreate(refreshConfiguration),
    configWatcher.onDidChange(refreshConfiguration),
    configWatcher.onDidDelete(refreshConfiguration));

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
    const results = await manager.executeOnTargeted(name, source);
    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      for (const failure of failed) {
        outputChannel.error(`[${failure.name}] Execution failed: ${failure.error}`);
      }
      const msg = failed.map((f) => `${f.name}: ${f.error}`).join(', ');
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
      try {
        const source = await fs.readFile(item.filePath, 'utf8');
        await executeSource(item.fileName, source);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.copyJoinUri', async (item?: SessionTreeItem) => {
      const place = item?.session.place;
      if (!place) {
        void vscode.window.showInformationMessage('This session is not currently in a game.');
        return;
      }
      const uri = buildJoinUri(place.placeId, place.jobId);
      if (uri) {
        await vscode.env.clipboard.writeText(uri);
        vscode.window.setStatusBarMessage(`$(clippy) Copied ${uri}`, 3000);
      }
    }),

    vscode.commands.registerCommand('relapse.joinSessionServer', async (item?: SessionTreeItem) => {
      const place = item?.session.place;
      if (!place) {
        void vscode.window.showInformationMessage('This session is not currently in a game.');
        return;
      }
      const allProfiles = await profileStore.listProfiles();
      const stopped: Array<{ label: string; description?: string }> = [];
      for (const name of allProfiles) {
        if (await profileStore.isProfileRunning(name)) continue;
        const cookie = await accountStore.readCookie(name).catch(() => null);
        const acc = await accountStore.loadAccount(name, cookie).catch(() => null);
        stopped.push({
          label: name,
          description: acc ? `@${acc.username} (${acc.displayName})` : undefined,
        });
      }
      if (stopped.length === 0) {
        void vscode.window.showInformationMessage('No stopped profiles available to join.');
        return;
      }
      const picked = await vscode.window.showQuickPick(stopped, {
        placeHolder: `Launch a profile into ${place.name ?? `Place ${place.placeId}`}`,
      });
      if (!picked) return;
      await launchWithFeedback(picked.label, place.placeId, place.jobId);
    }),

    vscode.commands.registerCommand('relapse.showOutput', () => {
      outputChannel.show(true);
    }),

    vscode.commands.registerCommand('relapse.refreshSessions', () => manager.refresh()),

    vscode.commands.registerCommand('relapse.toggleOutput', async () => {
      const current = getConfig().get<boolean>('redirectOutput', true);
      const next = !current;
      await getConfig().update('redirectOutput', next, vscode.ConfigurationTarget.Global);
      if (next) {
        const picked = await vscode.window.showInformationMessage(
          'Relapse output redirection enabled (Output → Relapse).',
          'Show Output'
        );
        if (picked === 'Show Output') {
          outputChannel.show(true);
        }
      } else {
        void vscode.window.showInformationMessage('Relapse output redirection disabled.');
      }
    }),

    vscode.commands.registerCommand(
      'relapse.openConsole',
      (item?: SessionTreeItem | ProfileTreeItem) => {
        let sockPath: string | undefined;
        if (item instanceof SessionTreeItem) {
          sockPath = item.session.path;
        } else if (item instanceof ProfileTreeItem) {
          sockPath =
            item.profile.sessionPath ??
            manager.listSessions().find((s) => s.name === item.profile.name)?.path;
          if (!sockPath) {
            void vscode.window.showInformationMessage(
              `Session socket for "${item.profile.name}" is not connected yet.`
            );
            return;
          }
        } else {
          sockPath = manager.getTargetedPaths()[0];
        }
        if (!sockPath) {
          void vscode.window.showWarningMessage('No active Relapse session.');
          return;
        }
        consoleManager.show(sockPath);
      }
    ),

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
      const detected = await findDefaultLauncher();
      if (detected) {
        await getConfig().update('launcherPath', detected, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(`$(check) Detected Relapse launcher: ${detected}`, 4000);
        return detected;
      }
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

  const launchWithFeedback = async (
    profileName: string,
    placeId?: string,
    jobId?: string
  ): Promise<void> => {
    const launcher = await resolveLauncherPath();
    if (!launcher) return;
    if (placeId !== undefined || jobId !== undefined) {
      buildJoinUri(placeId, jobId);
    }

    profilesProvider.setLaunching(profileName, true);
    updateStatusBar();

    try {
      await profileStore.launchProfile(launcher, profileName, placeId, jobId);
    } catch (err) {
      profilesProvider.setLaunching(profileName, false);
      updateStatusBar();
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      return;
    }

    void vscode.window.withProgress(
      {
        location: { viewId: 'relapse.profiles' },
        title: `Launching ${profileName}…`,
      },
      async () => {
        await new Promise<void>((resolve) => {
          let finished = false;
          const finish = (connected: boolean) => {
            if (finished) return;
            finished = true;
            sub.dispose();
            clearTimeout(timer);
            profilesProvider.setLaunching(profileName, false);
            updateStatusBar();
            if (connected) {
              vscode.window.setStatusBarMessage(
                `$(check) Relapse: ${profileName} session connected`,
                4000
              );
            }
            resolve();
          };

          const check = () => {
            if (manager.listSessions().some((s) => s.name === profileName)) {
              finish(true);
            }
          };

          const sub = new vscode.Disposable(() => {
            manager.off('sessionsChanged', check);
          });
          manager.on('sessionsChanged', check);
          const timer = setTimeout(() => finish(false), 20_000);
          void manager.refresh().then(check);
        });
      }
    );
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
      await launchWithFeedback(item.profile.name);
    }),

    vscode.commands.registerCommand(
      'relapse.launchProfileToPlace',
      async (item?: ProfileTreeItem) => {
        if (!item) return;
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
          await launchWithFeedback(item.profile.name, placeId, jobId);
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
        await profileStore.deleteProfile(item.profile.name, async target => {
          await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
        });
        profilesProvider.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.openGlobalConfig', async () => {
      try {
        const configPath = configuration.globalPath();
        try {
          await fs.access(configPath);
        } catch {
          const global = await configuration.readGlobal();
          await configuration.writeGlobal(global);
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.openProfileConfig', async (item?: ProfileTreeItem) => {
      if (!item) return;
      try {
        const configPath = configuration.profilePath(item.profile.name);
        try {
          await fs.access(configPath);
        } catch {
          const existing = await configuration.readProfile(item.profile.name);
          await configuration.writeProfile(item.profile.name, existing);
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.addAccountFromCookie', async () => {
      const raw = await vscode.window.showInputBox({
        prompt: 'Paste .ROBLOSECURITY cookie to create a profile',
        password: true,
        ignoreFocusOut: true,
      });
      if (!raw) return;

      const account = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Verifying .ROBLOSECURITY cookie…',
        },
        async () => {
          try {
            return await accountStore.lookupAccount(raw);
          } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
            return null;
          }
        }
      );
      if (!account) return;

      const suggested = account.username.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'account';
      const existingProfiles = new Set(await profileStore.listProfiles());
      const name = await vscode.window.showInputBox({
        prompt: `Profile name for @${account.username} (${account.displayName})`,
        value: suggested,
        validateInput: (val) => {
          const trimmed = val.trim();
          if (!isValidProfileName(trimmed)) {
            return 'Use 1–64 letters, digits, dots, underscores or hyphens (excluding . and ..).';
          }
          if (existingProfiles.has(trimmed)) {
            return 'A profile with this name already exists.';
          }
          return null;
        },
      });
      if (!name) return;

      try {
        await accountStore.importAccount(name.trim(), raw, account, true);
        profilesProvider.refresh();
        void vscode.window.showInformationMessage(
          `Created profile "${name.trim()}" for @${account.username}.`
        );
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.commands.registerCommand('relapse.launchMultipleProfiles', async () => {
      const allProfiles = await profileStore.listProfiles();
      const stopped: Array<{ label: string; description?: string }> = [];
      for (const name of allProfiles) {
        if (await profileStore.isProfileRunning(name)) continue;
        const cookie = await accountStore.readCookie(name).catch(() => null);
        const acc = await accountStore.loadAccount(name, cookie).catch(() => null);
        stopped.push({
          label: name,
          description: acc ? `@${acc.username} (${acc.displayName})` : undefined,
        });
      }
      if (stopped.length === 0) {
        void vscode.window.showInformationMessage('No stopped profiles available to launch.');
        return;
      }

      const picks = await vscode.window.showQuickPick(stopped, {
        canPickMany: true,
        placeHolder: 'Select profile(s) to launch',
      });
      if (!picks || picks.length === 0) return;

      const activePlace = manager.listSessions().find((s) => s.place)?.place;
      const placeId = await vscode.window.showInputBox({
        prompt: 'Optional Place ID — leave empty to open launcher home',
        placeHolder: 'e.g. 1818',
        value: activePlace?.placeId ?? '',
      });
      if (placeId === undefined) return;

      let jobId = '';
      if (placeId.trim()) {
        const enteredJob = await vscode.window.showInputBox({
          prompt: 'Optional Job ID (UUID) — leave empty to join any server',
          placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          value: activePlace && activePlace.placeId === placeId.trim() ? activePlace.jobId : '',
        });
        if (enteredJob === undefined) return;
        jobId = enteredJob;
      }

      try {
        buildJoinUri(placeId, jobId);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }

      for (const pick of picks) {
        await launchWithFeedback(pick.label, placeId, jobId);
      }
    }),

    vscode.commands.registerCommand('relapse.migrateLegacyData', async () => {
      try {
        const report = await migrateLegacyProfiles();
        let launcherMsg = '';
        if (!getConfig().get<string>('launcherPath', '').trim()) {
          const detected = await findDefaultLauncher();
          if (detected) {
            await getConfig().update('launcherPath', detected, vscode.ConfigurationTarget.Global);
            launcherMsg = ` Launcher path set to ${detected}.`;
          }
        }
        const scriptsTarget = resolveUserPath(
          getConfig().get<string>('scriptsDir', '~/.local/share/relapse/scripts')
        );
        const scriptsRes = await migrateLegacyScriptsDir(scriptsTarget);
        profilesProvider.refresh();
        scriptsProvider.refresh();

        const parts: string[] = [];
        if (report.migratedConfigs.length > 0) {
          parts.push(`created config.json for ${report.migratedConfigs.join(', ')}`);
        }
        if (report.upgradedStates.length > 0) {
          parts.push(`initialized state/.format for ${report.upgradedStates.join(', ')}`);
        }
        if (scriptsRes.moved.length > 0) {
          parts.push(`moved ${scriptsRes.moved.length} script(s) from ~/relapse-scripts-tmpdir`);
        }
        const summary =
          parts.length > 0
            ? `Relapse migration complete: ${parts.join('; ')}.${launcherMsg}`
            : `All Relapse profiles and files are already up to date.${launcherMsg}`;
        void vscode.window.showInformationMessage(summary);
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
      try {
        await fs.mkdir(folder, { recursive: true });
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }
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
