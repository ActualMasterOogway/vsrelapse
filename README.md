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
- Status bar item shows current targets and opens a quick session picker when clicked.
- Output redirection (`vsrelapse.session.v2`) forwards `print`, `warn`, `info`, and uncaught errors with stack traces to `Output → Relapse`.

### Integrated `rconsole`
- Implements `vsrelapse.console.v1` inside a native VS Code terminal (`Pseudoterminal`).
- Buffers early `rconsoleprint`, `rconsoleinfo`, `rconsolewarn`, and `rconsoleerr` calls until the terminal finishes opening so first-run messages are never dropped.
- Supports `rconsolename`, `rconsoleclear`, `rconsoleshow`, `rconsolehide`, and `rconsoleinput(prompt?)`.

### Profiles and accounts
- Manages profiles under `~/.local/share/relapse/profiles/<name>`: create, rename, and move to Trash.
- Reads `.lock` with a non-blocking `flock` check to show live running status and prevent modifying active profiles.
- Imports `.ROBLOSECURITY` cookies (raw token or full `Cookie:` header) into `state/app/data/sober/cookies`, fetches the Roblox username and headshot, and caches metadata in `account.json`.
- Launches profiles detached (`--profile <name> --no-launch-ui`), with an optional Place ID and Job ID, while animating the sidebar row and status bar until the socket connects.

### Scripts and autoexec
- Lists files from your configured scripts folder (`~/.local/share/relapse/scripts` by default) and `~/.config/relapse/autoexec`.
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

- Profiles: `~/.local/share/relapse/profiles/<name>`
- Autoexec: `~/.config/relapse/autoexec`
- Sockets: `/tmp/relapse.sock` and `/tmp/relapse-<name>.sock`

## Development

```sh
npm run typecheck
npm run compile
npm test
```

End-to-end tests in `test/e2e/suite.ts` launch `code-insiders` with `--extensionDevelopmentPath` and `--extensionTestsPath` against a mock Unix socket to verify activation, command registration, and script execution.
