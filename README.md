# Switchboard for Claude Code

A VS Code sidebar that lists every [Claude Code](https://code.claude.com) session running on your machine and shows which ones need you. Click one to jump to its terminal tab.

It works with the sessions you already run: plain `claude` in VS Code terminal tabs, any folder, no wrapper, no tmux and no worktrees.

> Not an official Anthropic product. Switchboard only reads the status files Claude Code writes on your machine.

```
SWITCHBOARD                                   + ✓ ↻
▾ Needs you  1
  🔔 Fix the login redirect        api · asks a question · 2 min
▾ Finished  1
  ✔ Upgrade the date library       web · finished · 4 min
▾ Working  2
  ◌ Write tests for the parser     cli · working · 31 min
  ◌ Draft release notes            docs · working · 3 min · other window
▾ Background  1
  ▣ Nightly dependency check       web · idle · 1 h
```

## What it does

- **Groups every session**:
  - **Needs you:** a permission prompt or a question is waiting.
  - **Finished:** it stopped working and you haven't looked at it since.
  - **Working**
  - **Idle**
  - **Background:** sessions started with `claude --bg` or from agent view.
- **Shows each session by its title**: the name you gave it, or else Claude's own title for it, never `my-repo-27`.
- **Click to open.**
  - A session in this window's terminal tabs comes to the front.
  - A background session opens with `claude attach` in a new tab.
- **A status-bar counter**, e.g. `🔔 1 needs you · 1 finished`. It turns amber while something waits, and a click opens the sidebar.
- **Pop-ups with an Open button** when a session starts waiting for you, or finishes a turn of 30 seconds or more.
  - There are none for the tab you're looking at.
  - With several VS Code windows open, only one window pops up: the one holding the tab, or the focused one for a session outside every window.
- **New session (+)**: give it a name, a folder and a first task, and it opens a tab running `claude -n "<name>" "<task>"`.

## How it works

1. Claude Code keeps a small status file per running session (`~/.claude/sessions/<pid>.json`): busy, waiting or idle. Switchboard watches that folder, so it does nothing while nothing changes.
2. When a status file changes, Switchboard reads Claude Code's own session list (`claude agents --json`), adding each file's change time.
3. Titles come from the end of each session's transcript, and only new lines are read after the first look.
4. A session is matched to its tab through the process tree: the session's parent process is the tab's shell.
5. "Seen" marks live in the extension's storage folder, which every VS Code window shares. Opening a session, clicking it or having its tab in front while the turn ends all count as seeing it.

Nothing leaves your machine.

## Install

Until it is on the Marketplace, install it from a `.vsix` file:

```sh
npm install
npm run package          # tests, then builds switchboard-for-claude-code-<version>.vsix
code --install-extension switchboard-for-claude-code-0.1.0.vsix
```

Then run **Developer: Reload Window**.

Tip: set `"terminal.integrated.tabs.title": "${sequence}"` in VS Code's settings, so each terminal tab shows the session's title too.

## Settings

| Setting | Default | |
|---|---|---|
| `switchboard.popups.needsYou` | `true` | Pop up when a session starts waiting for you. |
| `switchboard.popups.finished` | `true` | Pop up when a session finishes a turn. |
| `switchboard.popups.finishedMinSeconds` | `30` | Only for turns at least this long. |
| `switchboard.statusBar.enabled` | `true` | Show the counter. |
| `switchboard.claudePath` | `""` | Path to `claude` if it isn't on PATH or in `~/.local/bin`. |

## Limits

- `claude agents --json` is part of a research preview, so its format may change. If it fails, Switchboard reads the status files directly. A status it doesn't recognise shows as "status unknown", never as a guess.
- A VS Code window can only bring forward its own tabs. A session in another window, or in another terminal app, is listed ("other window", "outside VS Code"), but a click can't jump there yet.
- "Looking at it" means its terminal is the active one in a focused window. VS Code doesn't say whether the terminal panel itself is visible.
- macOS and Linux only for now (it uses `ps` to read the process tree).

## Development

```sh
npm install
npm test          # compiles, then runs the unit tests with Node's test runner
```

Press F5 in VS Code with this folder open to start an Extension Development Host.

## Licence

MIT
