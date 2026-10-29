import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { counterText, formatAge, groupOf, shouldPop, Tracker, waitingLabel, type SessionEvent } from './core/model';
import { displayTitle } from './core/parse';
import { GROUP_LABEL, GROUP_ORDER, keyOf, type Group, type Session, type Titles } from './core/types';
import { SharedState, type Peers } from './shared';
import { claudeConfigDir, findClaude, message, SessionSource } from './source';
import { SessionTree, type Node, type Row, type Where } from './tree';

const VIEW_ID = 'switchboard.sessions';
const DEBOUNCE_MS = 300;
const TICK_MS = 60_000;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const board = new Board(ctx);
  ctx.subscriptions.push(board);
  await board.start();
}

export function deactivate(): void {}

/** A row's key, whether a command got it from a click (a string) or a context menu (a tree node). */
function keyArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const row = (arg as { row?: Row } | undefined)?.row;
  return row ? keyOf(row.s) : undefined;
}

/** Wraps text in single quotes for a POSIX shell. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rows, tabs and the tracker are keyed by process (`keyOf`), because two
 * tabs can resume one conversation. Seen marks are keyed by session id, so
 * looking at either tab counts for both.
 */
class Board implements vscode.Disposable {
  private readonly log = vscode.window.createOutputChannel('Switchboard', { log: true });
  private readonly tree = new SessionTree();
  private readonly view: vscode.TreeView<Node>;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  private readonly source: SessionSource;
  private readonly shared: SharedState;
  private readonly tracker = new Tracker();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: FSWatcher[] = [];
  private readonly shellPids = new WeakMap<vscode.Terminal, Promise<number | undefined>>();
  /** Tabs this window opened with `claude attach`, by key. They close when the attach ends. */
  private readonly attachTabs = new Map<string, vscode.Terminal>();
  private claude?: Promise<string | undefined>;

  private sessions: Session[] = [];
  private titles = new Map<string, Titles>();
  private tabs = new Map<string, vscode.Terminal>();
  private peers: Peers = { owned: new Set(), focusedAt: 0 };
  private rows = new Map<string, Row>();

  private running = false;
  private again = false;
  private debounce?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;

  constructor(ctx: vscode.ExtensionContext) {
    this.source = new SessionSource(claudeConfigDir(), () => this.claudePath(), (m) => this.log.warn(m));
    this.shared = new SharedState(ctx.globalStorageUri.fsPath, randomUUID());
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.tree });
    this.status.name = 'Switchboard';
    this.status.command = 'workbench.view.extension.switchboard';
  }

  async start(): Promise<void> {
    await this.shared.init(Date.now());
    if (vscode.window.state.focused) await this.safe(this.shared.noteFocused(Date.now()), undefined);
    const w = vscode.window;
    this.disposables.push(
      this.log,
      this.tree,
      this.view,
      this.status,
      vscode.commands.registerCommand('switchboard.open', (arg) => this.open(keyArg(arg))),
      vscode.commands.registerCommand('switchboard.newSession', () => this.newSession()),
      vscode.commands.registerCommand('switchboard.refresh', () => this.refresh()),
      vscode.commands.registerCommand('switchboard.markSeen', (arg) => this.markSeen(keyArg(arg))),
      vscode.commands.registerCommand('switchboard.markAllSeen', () => this.markAllSeen()),
      vscode.commands.registerCommand('switchboard.copySessionId', (arg) => {
        const row = this.rows.get(keyArg(arg) ?? '');
        if (row) void vscode.env.clipboard.writeText(row.s.sessionId);
      }),
      w.onDidChangeActiveTerminal(() => void this.noteLooking()),
      w.onDidChangeWindowState((s) => {
        if (s.focused) {
          void this.safe(this.shared.noteFocused(Date.now()), undefined);
          this.schedule();
        }
        void this.noteLooking();
      }),
      w.onDidOpenTerminal(() => this.schedule()),
      w.onDidCloseTerminal((t) => {
        for (const [key, tab] of this.attachTabs) if (tab === t) this.attachTabs.delete(key);
        this.schedule();
      }),
      this.view.onDidChangeVisibility((e) => e.visible && this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('switchboard.claudePath')) this.claude = undefined;
        if (e.affectsConfiguration('switchboard')) this.render();
      }),
    );
    this.watch(this.source.sessionsDir, () => this.schedule());
    this.watch(this.shared.dir, (file) => {
      if (file === path.basename(this.shared.seenFile)) void this.shared.loadSeen().then(() => this.render());
    });
    this.tick = setInterval(() => {
      if (this.view.visible || vscode.window.state.focused) this.schedule();
    }, TICK_MS);
    await this.refresh();
  }

  private watch(dir: string, onChange: (file: string | null) => void): void {
    try {
      const watcher = watch(dir, (_event, file) => onChange(file ? String(file) : null));
      watcher.on('error', (e) => this.log.warn(`Stopped watching ${dir}: ${message(e)}`));
      this.watchers.push(watcher);
    } catch (e) {
      // Claude Code hasn't made the folder yet; the minute tick still refreshes.
      this.log.info(`Not watching ${dir} yet: ${message(e)}`);
    }
  }

  /** Shared-state trouble (a full disk, a file being replaced) must not stop the sidebar or the pop-ups. */
  private async safe<T>(p: Promise<T>, fallback: T): Promise<T> {
    try {
      return await p;
    } catch (e) {
      this.log.warn(`Shared state: ${message(e)}`);
      return fallback;
    }
  }

  private claudePath(): Promise<string | undefined> {
    if (!this.claude) {
      const configured = vscode.workspace.getConfiguration('switchboard').get<string>('claudePath', '');
      this.claude = findClaude(configured).then((p) => {
        if (!p) this.log.warn('Could not find the claude command. Set switchboard.claudePath.');
        return p;
      });
    }
    return this.claude;
  }

  /** Refreshes once, at most DEBOUNCE_MS after the first of a burst of changes. */
  private schedule(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.refreshOnce();
      } while (this.again);
    } catch (e) {
      this.log.error(`Refresh failed: ${message(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    const now = Date.now();
    const sessions = await this.source.list(now);
    const { events, fresh } = this.tracker.update(sessions, now);
    this.sessions = sessions;
    this.source.forget(new Set(sessions.map((s) => s.sessionId)));

    this.tabs = await this.matchTabs(sessions);
    await this.safe(this.shared.publishOwned([...this.tabs.keys()]), undefined);
    this.peers = await this.safe(this.shared.peers(), { owned: new Set<string>(), focusedAt: 0 });

    const looking = this.lookingAt();
    const marks: Array<[string, number]> = [];
    if (looking) {
      // Watching a tab while its status changes counts as seeing the change.
      const id = looking.sessionId;
      if ((this.tracker.changedAt(keyOf(looking)) ?? 0) > (this.shared.seenAt(id) ?? -Infinity)) marks.push([id, now]);
    }
    // A session met for the first time counts as seen now, so an install or
    // a new window doesn't flag every idle session as finished.
    for (const s of fresh) if (this.shared.seenAt(s.sessionId) === undefined) marks.push([s.sessionId, now]);
    if (marks.length) await this.safe(this.shared.markSeen(marks, now), false);

    const titles = await Promise.all(sessions.map((s) => this.source.titlesOf(s, now)));
    this.titles = new Map(sessions.map((s, i) => [s.sessionId, titles[i] ?? {}]));
    this.render();
    for (const e of events) void this.maybePop(e, looking);
  }

  private async matchTabs(sessions: readonly Session[]): Promise<Map<string, vscode.Terminal>> {
    const byShell = new Map<number, vscode.Terminal>();
    await Promise.all(
      vscode.window.terminals.map(async (t) => {
        const pid = await this.shellPid(t);
        if (pid) byShell.set(pid, t);
      }),
    );
    const interactive = sessions.filter((s) => s.kind === 'interactive');
    const lines = await this.source.lineages(interactive.map((s) => s.pid));
    const tabs = new Map<string, vscode.Terminal>();
    for (const s of interactive) {
      const tab = (lines.get(s.pid) ?? [s.pid]).map((p) => byShell.get(p)).find((t) => t !== undefined);
      if (tab) tabs.set(keyOf(s), tab);
    }
    for (const [key, t] of this.attachTabs) {
      if (vscode.window.terminals.includes(t)) tabs.set(key, t);
      else this.attachTabs.delete(key);
    }
    return tabs;
  }

  private shellPid(t: vscode.Terminal): Promise<number | undefined> {
    let p = this.shellPids.get(t);
    if (!p) {
      p = Promise.race([
        Promise.resolve(t.processId),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000)),
      ]).then((pid) => {
        if (pid === undefined) this.shellPids.delete(t);
        return pid;
      });
      this.shellPids.set(t, p);
    }
    return p;
  }

  /** The session whose tab the user is looking at: the active terminal of a focused window. */
  private lookingAt(): Session | undefined {
    const active = vscode.window.activeTerminal;
    if (!active || !vscode.window.state.focused) return undefined;
    return this.sessions.find((s) => this.tabs.get(keyOf(s)) === active);
  }

  private async noteLooking(): Promise<void> {
    const s = this.lookingAt();
    if (s && this.rows.get(keyOf(s))?.group === 'finished') await this.markSeen(keyOf(s));
  }

  private where(key: string): Where {
    if (this.tabs.has(key)) return 'here';
    return this.peers.owned.has(key) ? 'elsewhere' : 'outside';
  }

  private render(): void {
    const rows = this.sessions.map((s): Row => {
      const key = keyOf(s);
      const changedAt = this.tracker.changedAt(key);
      return {
        s,
        title: displayTitle(s, this.titles.get(s.sessionId)),
        group: groupOf(s, changedAt, this.shared.seenAt(s.sessionId)),
        changedAt,
        where: this.where(key),
        terminal: this.tabs.get(key),
      };
    });
    this.rows = new Map(rows.map((r) => [keyOf(r.s), r]));
    this.tree.set(rows);

    const counts = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<Group, number>;
    for (const r of rows) counts[r.group]++;
    void vscode.commands.executeCommand('setContext', 'switchboard.hasFinished', counts.finished > 0);
    this.view.badge = counts.needs + counts.finished ? { value: counts.needs + counts.finished, tooltip: counterText(counts) } : undefined;
    this.renderStatus(counts, rows);
  }

  private renderStatus(counts: Record<Group, number>, rows: readonly Row[]): void {
    const text = counterText(counts);
    if (!text || !vscode.workspace.getConfiguration('switchboard').get<boolean>('statusBar.enabled', true)) {
      this.status.hide();
      return;
    }
    const icon = counts.needs ? '$(bell-dot)' : counts.finished ? '$(pass)' : counts.working ? '$(pulse)' : '$(circle-outline)';
    this.status.text = `${icon} ${text}`;
    this.status.backgroundColor = counts.needs ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tip = new vscode.MarkdownString();
    for (const g of GROUP_ORDER) {
      const mine = rows.filter((r) => r.group === g);
      if (mine.length) tip.appendMarkdown(`**${GROUP_LABEL[g]} (${mine.length})**: ${mine.map((r) => r.title).join(', ')}  \n`);
    }
    tip.appendMarkdown('\nClick to open Switchboard.');
    this.status.tooltip = tip;
    this.status.show();
  }

  private async maybePop(e: SessionEvent, looking: Session | undefined): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('switchboard');
    const key = keyOf(e.session);
    const pop = shouldPop(e, {
      needsOn: cfg.get<boolean>('popups.needsYou', true),
      finishedOn: cfg.get<boolean>('popups.finished', true),
      finishedMinMs: cfg.get<number>('popups.finishedMinSeconds', 30) * 1000,
      lookingAt: looking !== undefined && keyOf(looking) === key,
      ownedHere: this.tabs.has(key),
      ownedElsewhere: this.peers.owned.has(key),
      lastFocused: this.shared.lastFocusedAt >= this.peers.focusedAt,
    });
    if (!pop) return;
    const changedAt = this.tracker.changedAt(key) ?? Date.now();
    if (!(await this.safe(this.shared.claim(`${e.type}-${key}-${changedAt}`), true))) return;
    const title = this.rows.get(key)?.title ?? e.session.name;
    const pick = await (e.type === 'needs'
      ? vscode.window.showWarningMessage(`${title} needs you: it ${waitingLabel(e.session.waitingFor)}.`, 'Open')
      : vscode.window.showInformationMessage(`${title} finished after ${formatAge(e.turnMs ?? 0)}.`, 'Open'));
    if (pick === 'Open') await this.open(key);
  }

  private async open(key: string | undefined): Promise<void> {
    const row = key ? this.rows.get(key) : undefined;
    if (!key || !row) return;
    const tab = this.tabs.get(key);
    if (tab) {
      tab.show(false);
    } else if (row.s.kind === 'background') {
      const claude = await this.claudePath();
      if (!claude) {
        void vscode.window.showErrorMessage('Switchboard could not find the claude command. Set switchboard.claudePath.');
        return;
      }
      // `exec`, so the tab closes when the attach ends rather than lingering as a plain shell.
      const command = `exec ${shq(claude)} attach ${shq(row.s.attachId ?? row.s.sessionId)}`;
      const t = this.shellTab(row.title, row.s.cwd, command, 'server-process');
      this.attachTabs.set(key, t);
      t.show(false);
    } else if (row.where === 'elsewhere') {
      void vscode.window.showInformationMessage(`"${row.title}" runs in another VS Code window. Switch to that window to open it.`);
    } else {
      void vscode.window.showInformationMessage(`"${row.title}" runs outside VS Code (process ${row.s.pid}, in ${row.s.cwd}).`);
    }
    await this.markSeen(key);
    this.schedule();
  }

  /** A terminal tab that runs one shell command in the user's login shell. */
  private shellTab(name: string, cwd: string, command: string, icon: string): vscode.Terminal {
    const shell = vscode.env.shell || process.env.SHELL || '/bin/zsh';
    return vscode.window.createTerminal({
      name,
      cwd,
      shellPath: shell,
      shellArgs: ['-l', '-i', '-c', command],
      iconPath: new vscode.ThemeIcon(icon),
    });
  }

  private async markSeen(key: string | undefined): Promise<void> {
    const row = key ? this.rows.get(key) : undefined;
    if (!row) return;
    const now = Date.now();
    if (await this.safe(this.shared.markSeen([[row.s.sessionId, now]], now), false)) this.render();
  }

  private async markAllSeen(): Promise<void> {
    const now = Date.now();
    const ids = [...this.rows.values()].filter((r) => r.group === 'finished').map((r): [string, number] => [r.s.sessionId, now]);
    if (ids.length && (await this.safe(this.shared.markSeen(ids, now), false))) this.render();
  }

  private async newSession(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'New Claude Code session (1/3)',
      prompt: 'A name for the session. It shows on the tab and in Switchboard. Leave empty to let Claude name it.',
      placeHolder: 'e.g. Fix the login redirect',
    });
    if (name === undefined) return;
    const cwd = await this.pickFolder();
    if (!cwd) return;
    const task = await vscode.window.showInputBox({
      title: 'New Claude Code session (3/3)',
      prompt: 'The first thing to ask Claude. Leave empty to start with a blank prompt.',
      placeHolder: 'e.g. Find why the login page redirects twice',
    });
    if (task === undefined) return;
    const claude = (await this.claudePath()) ?? 'claude';
    const n = name.trim();
    const first = task.trim();
    const args = [shq(claude)];
    if (n) args.push('-n', shq(n));
    // `--` stops a task that starts with "-" from being read as an option.
    if (first) args.push(...(first.startsWith('-') ? ['--'] : []), shq(first));
    // The shell stays after claude exits, like a tab the user opened.
    const shell = vscode.env.shell || process.env.SHELL || '/bin/zsh';
    const t = this.shellTab(n || 'Claude Code', cwd, `${args.join(' ')}; exec ${shq(shell)} -l -i`, 'sparkle');
    t.show(false);
    this.schedule();
  }

  private async pickFolder(): Promise<string | undefined> {
    type Pick = vscode.QuickPickItem & { cwd?: string };
    const seen = new Set<string>();
    const items: Pick[] = [];
    const add = (cwd: string, detail: string) => {
      if (seen.has(cwd)) return;
      seen.add(cwd);
      items.push({ label: path.basename(cwd) || cwd, description: cwd.replace(os.homedir(), '~'), detail, cwd });
    };
    for (const f of vscode.workspace.workspaceFolders ?? []) add(f.uri.fsPath, 'Open in this window');
    for (const s of this.sessions) add(s.cwd, 'A session runs here');
    items.push({ label: '$(folder-opened) Choose another folder…' });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'New Claude Code session (2/3)',
      placeHolder: 'Which folder should the session work in?',
    });
    if (!pick) return undefined;
    if (pick.cwd) return pick.cwd;
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Start here' });
    return chosen?.[0]?.fsPath;
  }

  dispose(): void {
    clearTimeout(this.debounce);
    clearInterval(this.tick);
    for (const w of this.watchers) w.close();
    for (const d of this.disposables) d.dispose();
    void this.shared.dispose();
  }
}
