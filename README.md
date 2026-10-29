# Switchboard for Claude Code

A VS Code sidebar that lists every [Claude Code](https://code.claude.com) session running on your machine and shows which ones need you. Click one to jump to its terminal tab.

It works with the sessions you already run: plain `claude` in VS Code terminal tabs, any folder, no wrapper, no tmux and no worktrees.

> Not an official Anthropic product. Switchboard only reads the status files Claude Code writes on your machine.

<p>
  <img src="docs/board-dark.png" alt="The Switchboard board in a dark theme, with sessions grouped as Needs you, Waiting for your reply, Start a new session, Stopped, Done, Working and Idle" width="300">
  <img src="docs/board-light.png" alt="The same board in a light theme" width="300">
</p>

*The sessions in these pictures are made up.*

## What it does

- **A board of every session**, one coloured section per state:
  - **Needs you:** a permission prompt or a question is waiting.
  - **Waiting for your reply:** Claude finished its turn by asking you something. The card quotes the question.
  - **Start a new session:** Claude handed over with a kickoff prompt, or the context has grown past the new-session line (150k tokens by default).
  - **Stopped:** the turn ended on an API error, or you interrupted it.
  - **Done:** a normal final reply. The card shows Claude Code's own recap, or the reply's first paragraph.
  - **Working**
  - **Idle:** nothing said yet.
- **Each card shows** the session's title (the name you gave it, or else Claude's own title, never `my-repo-27`), its folder, how long ago it changed, and a context meter. A dot marks a turn that finished since you last looked.
- **Click a card to open it.**
  - A session in this window's terminal tabs comes to the front.
  - A background session opens with `claude attach` in a new tab.
- **Start next session.** On a hand-over card, one click opens a new session in the same folder with the kickoff prompt as its first message. **Copy prompt** copies it instead.
- **A status-bar counter**, e.g. `🔔 1 needs you · 2 finished`. It turns amber while something waits, and a click opens the board.
- **Pop-ups with an Open button** when a session starts waiting for you, or finishes a turn of 30 seconds or more. They say how the turn ended.
  - There are none for the tab you're looking at.
  - With several VS Code windows open, only one window pops up: the one holding the tab, or the focused one for a session outside every window.
- **New session (+)**: give it a name, a folder and a first task, and it opens a tab running `claude -n "<name>" "<task>"`.

## How it works

1. Claude Code keeps a small status file per running session (`~/.claude/sessions/<pid>.json`): busy, waiting or idle. Switchboard watches that folder, so it does nothing while nothing changes.
2. When a status file changes, Switchboard reads Claude Code's own session list (`claude agents --json`), adding each file's change time.
3. Titles, and how each turn ended, come from the end of each session's transcript: Claude's last reply, Claude Code's recap, the context size, a compaction or an error. Only new lines are read after the first look.
4. A session is matched to its tab through the process tree: the session's parent process is the tab's shell.
5. "Seen" marks live in the extension's storage folder, one small file per session, which every VS Code window shares. Opening a session, clicking it or having its tab in front while the turn ends all count as seeing it.
6. The board is a webview that draws with your theme's own colours. Its text is set as plain text, never as HTML, and its content security policy allows only its own script.

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
| `switchboard.newSessionTokens` | `150000` | Suggest a new session once a finished session's context reaches this many tokens. `0` turns it off. |
| `switchboard.statusBar.enabled` | `true` | Show the counter. |
| `switchboard.claudePath` | `""` | Absolute path to `claude` if it isn't on PATH or in `~/.local/bin`. It is read from user settings only, so a workspace can never choose what Switchboard runs. |

## Limits

- `claude agents --json` is part of a research preview, so its format may change. If it fails, Switchboard reads the status files directly. A status it doesn't recognise shows as "status unknown", never as a guess.
- "Waiting for your reply" and "Start a new session" are read from the words of Claude's last reply: a question in its last lines, or words such as "kickoff prompt" or "next session". The card always shows the words it went by, so you can judge.
- A VS Code window can only bring forward its own tabs. A session in another window, or in another terminal app, is listed ("other window", "outside VS Code"), but a click can't jump there yet.
- "Looking at it" means its terminal is the active one in a focused window. VS Code doesn't say whether the terminal panel itself is visible.
- A session started by another session (by a hook or a tool) is listed as "inside another session" and has no tab of its own.
- macOS and Linux only for now (it uses `ps` to read the process tree).

## Development

```sh
npm install
npm test          # compiles, then runs the unit tests with Node's test runner
```

Press F5 in VS Code with this folder open to start an Extension Development Host.

## Licence

MIT
