<div align="center">

<img src="resources/icons/icon.png" alt="vsrelapse logo" width="84" height="84" />

# vsrelapse

VS Code extension for connecting to [Relapse](https://github.com/vpu00000/relapsegtk), executing Luau scripts across multiple sessions, capturing output, and managing accounts on Linux.

[![Release](https://img.shields.io/github/v/release/ActualMasterOogway/vsrelapse?style=flat-square)](https://github.com/ActualMasterOogway/vsrelapse/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/ActualMasterOogway/vsrelapse/ci.yml?style=flat-square&label=CI)](https://github.com/ActualMasterOogway/vsrelapse/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-Linux-blue?style=flat-square)

</div>

`vsrelapse` replaces the standalone GTK editor workflow with native VS Code panels. Sockets in `/tmp` appear automatically in the sidebar, scripts run straight from the active editor, redirected output streams to the Output panel, and `rconsole` opens inside an integrated terminal.

## Install

Download the `.vsix` from the [latest release](https://github.com/ActualMasterOogway/vsrelapse/releases/latest) and install it into Code Insiders or VS Code:

```sh
code-insiders --install-extension vsrelapse-0.1.0.vsix
```

To build from source instead:

```sh
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

## Features

### Sessions and execution
- Auto-discovers `/tmp/relapse.sock` (`No Profile`) and `/tmp/relapse-*.sock`.
- Native sidebar checkboxes let you target one or multiple running sessions at once.
- Tracks each session's current place and job ID for tooltips and `Relapse: Copy Join URI`.
- Status bar item shows current targets and opens a quick session picker when clicked.
- Output redirection (`vsrelapse.session.v2`) forwards `print`, `warn`, `info`, and uncaught errors with stack traces to `Output → Relapse`.

### Integrated `rconsole` and dialogs
- Implements `vsrelapse.console.v1` inside a native VS Code terminal (`Pseudoterminal`).
- Buffers early `rconsoleprint`, `rconsoleinfo`, `rconsolewarn`, and `rconsoleerr` calls until the terminal finishes opening so first-run messages are never dropped.
- Supports `rconsolename`, `rconsolesettitle`, `rconsoleclear`, `rconsolecreate`, `rconsoledestroy`, `rconsolehidden`, `rconsoleshow`, `rconsolehide`, and `rconsoleinput(prompt?)`. Closing the terminal unblocks pending `rconsoleinput` calls.
- Implements `vsrelapse.dialogs.v1` so in-game `messagebox(...)` and `MessageBox.new(...)` calls open native VS Code modal dialogs.

### Profiles and accounts
- Uses `relapsesdk` for profile discovery, creation, and configuration resolution, including XDG directories and custom `dataDir` paths.
- Includes `Relapse: Add Account from Cookie` to verify a cookie, pre-fill the profile name, and import in one step, plus `Relapse: Launch Profiles...` and `Relapse: Join Server with Profile...`.
- Includes `Relapse: Open Global Config` and `Relapse: Open Profile Config` with JSON schema autocomplete and validation for `config.json`.
- `Relapse: Migrate Legacy Data` converts data-only profiles to `config.json`, adds missing `state/.format` markers, imports the launcher path from `relapsegtk`'s `settings.ini`, and migrates legacy scripts.
- Renaming updates the profile configuration and default selection while retaining its data directory. Moving a profile to Trash includes its configuration and unshared data.
- Reads `.lock` with a non-blocking `flock` check to show live running status and prevent modifying active profiles.
- Imports `.ROBLOSECURITY` cookies (raw token or full `Cookie:` header) into `state/app/data/sober/cookies`, fetches the Roblox username and headshot, and caches metadata in `account.json`.
- Launches profiles detached (`--profile <name> --no-launch-ui`), with an optional Place ID and Job ID, while animating the sidebar row and status bar until the socket connects.

### Scripts and autoexec
- Lists files from your configured scripts folder (`~/.local/share/relapse/scripts` by default), the autoexec directories resolved for targeted profiles, and the resolved `workspace` directory. With no named targets, uses the configured default profile.
- Click any file to open it, or run it directly from the sidebar.

## Shortcuts and commands

All commands live under the `Relapse:` prefix in the Command Palette (`F1`).

| Action | Shortcut / Location | Command |
|---|---|---|
| Execute active editor | `Ctrl+Alt+R`, editor title `▶`, or right-click | `Relapse: Execute Active Editor` |
| Execute selection | `Ctrl+Alt+Shift+R` or right-click | `Relapse: Execute Selection` |
| Show redirected output | Sessions toolbar or `Ctrl+Shift+U` | `Relapse: Show Output` |
| Select target sessions | Click status bar item | `Relapse: Select Target Sessions` |
| Open `rconsole` terminal | Inline terminal icon on session or running profile | `Relapse: Open rconsole Terminal` |

## Settings

| Setting | Default | Description |
|---|---|---|
| `relapse.launcherPath` | `""` | Absolute path to the Relapse launcher executable. |
| `relapse.scriptsDir` | `~/.local/share/relapse/scripts` | Directory shown under Scripts in the sidebar. |
| `relapse.redirectOutput` | `true` | Capture in-game `print`, `warn`, `info`, and errors in `Output → Relapse`. |
| `relapse.autoOpenConsole` | `true` | Focus the `rconsole` terminal when `rconsoleshow` or `rconsoleprint` runs. |
| `relapse.autoTargetFirst` | `true` | Automatically select the first ready session when none are targeted. |

## Local data paths

- Profile configuration defaults to `~/.config/relapse/profiles/<name>/config.json`.
- Profile data defaults to `~/.local/share/relapse/profiles/<name>` and follows each profile’s `dataDir`.
- Global settings come from `~/.config/relapse/config.json`, with per-profile overrides.
- Autoexec defaults to `~/.config/relapse/autoexec`.
- `XDG_CONFIG_HOME` and `XDG_DATA_HOME` override the corresponding roots. Existing data-only profiles are also discovered.
- Sockets: `/tmp/relapse.sock` and `/tmp/relapse-<name>.sock`

## Development

Build dependencies require Node 22 or newer. The SDK is bundled into the extension.

```sh
npm run typecheck
npm run compile
npm test
```

End-to-end tests in `test/e2e/suite.ts` launch `code-insiders` with `--extensionDevelopmentPath` and `--extensionTestsPath` against a mock Unix socket to verify activation, command registration, and script execution.
