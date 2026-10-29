import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BoardView, type FromBoard } from './board';
import { toCard, type Where } from './core/card';
import { compareInGroup, counterText, groupOf, isUnread, popText, shouldPop, Tracker, type SessionEvent } from './core/model';
import { displayTitle } from './core/parse';
import { outcomeOf, type Digest } from './core/transcript';
import { GROUP_LABEL, GROUP_ORDER, keyOf, type Group, type Outcome, type Session } from './core/types';
import { SharedState, type Peers } from './shared';
import { claudeConfigDir, findClaude, message, SessionSource } from './source';

const VIEW_ID = 'switchboard.sessions';
const DEBOUNCE_MS = 300;
const TICK_MS = 60_000;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const board = new Board(ctx);
  ctx.subscriptions.push(board);
  await board.start();
}

export function deactivate(): void {}

/** Everything known about one session, as of the last refresh. */
interface Row {
  s: Session;
  title: string;
  group: Group;
  outcome?: Outcome;
  digest?: Digest;
  changedAt?: number;
  unread: boolean;
  where: Where;
}

const keyArg = (arg: unknown): string | undefined => (typeof arg === 'string' ? arg : undefined);

const config = () => vscode.workspace.getConfiguration('switchboard');

/** The context size from which a session is told to hand over (0: never). */
const freshTokens = () => Math.max(0, config().get<number>('newSessionTokens', 150_000));

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
  private readonly board: BoardView;
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
  private digests = new Map<string, Digest>();
  private tabs = new Map<string, vscode.Terminal>();
  /** Sessions run from inside another session's process, by key. */
  private nested = new Set<string>();
  private peers: Peers = { owned: new Set(), focusedAt: 0 };
  private rows = new Map<string, Row>();

  private running = false;
  private again = false;
  private debounce?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;

  constructor(ctx: vscode.ExtensionContext) {
    this.source = new SessionSource(claudeConfigDir(), () => this.claudePath(), (m) => this.log.warn(m));
    this.shared = new SharedState(ctx.globalStorageUri.fsPath, randomUUID());
    this.board = new BoardView(vscode.Uri.joinPath(ctx.extensionUri, 'media'), (m) => void this.fromBoard(m));
    this.status.name = 'Switchboard';
    this.status.command = 'workbench.view.extension.switchboard';
  }

  async start(): Promise<void> {
    await this.shared.init(Date.now());
    if (vscode.window.state.focused) await this.safe(this.shared.noteFocused(Date.now()), undefined);
    const w = vscode.window;
    this.disposables.push(
      this.log,
      this.board,
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.board),
      this.status,
      vscode.commands.registerCommand('switchboard.open', (arg) => this.open(keyArg(arg))),
      vscode.commands.registerCommand('switchboard.newSession', () => this.newSession()),
      vscode.commands.registerCommand('switchboard.refresh', () => this.refresh()),
      vscode.commands.registerCommand('switchboard.markSeen', (arg) => this.markSeen(keyArg(arg))),
      vscode.commands.registerCommand('switchboard.markAllSeen', () => this.markAllSeen()),
      vscode.commands.registerCommand('switchboard.startNext', (arg) => this.startNext(keyArg(arg))),
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
      this.board.onDidShow(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('switchboard.claudePath')) this.claude = undefined;
        if (e.affectsConfiguration('switchboard')) this.render();
        if (e.affectsConfiguration('switchboard.newSessionTokens')) this.schedule();
      }),
    );
    this.watch(this.source.sessionsDir, () => this.schedule());
    this.watch(this.shared.seenDir, () => void this.shared.loadSeen().then(() => this.render()));
    this.tick = setInterval(() => {
      if (this.board.visible || vscode.window.state.focused) this.schedule();
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
      // User settings only: a workspace must never choose what this runs.
      const configured = vscode.workspace.getConfiguration('switchboard').inspect<string>('claudePath')?.globalValue ?? '';
      this.claude = findClaude(configured).then((p) => {
        if (!p) this.log.warn('Could not find the claude command. Set switchboard.claudePath (an absolute path) in your user settings.');
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

    const digests = await Promise.all(sessions.map((s) => this.source.digestOf(s, now)));
    this.digests = new Map(sessions.flatMap((s, i): Array<[string, Digest]> => (digests[i] ? [[s.sessionId, digests[i]]] : [])));
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
    const sessionPids = new Set(sessions.map((s) => s.pid));
    const tabs = new Map<string, vscode.Terminal>();
    this.nested = new Set();
    for (const s of interactive) {
      for (const [i, p] of (lines.get(s.pid) ?? [s.pid]).entries()) {
        // A session started by another one (a hook, a tool) is not that session's tab.
        if (i > 0 && sessionPids.has(p)) {
          this.nested.add(keyOf(s));
          break;
        }
        const tab = byShell.get(p);
        if (tab) {
          tabs.set(keyOf(s), tab);
          break;
        }
      }
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
    if (s && this.rows.get(keyOf(s))?.unread) await this.markSeen(keyOf(s));
  }

  private where(key: string): Where {
    if (this.tabs.has(key)) return 'here';
    if (this.nested.has(key)) return 'nested';
    return this.peers.owned.has(key) ? 'elsewhere' : 'outside';
  }

  /** A digest is replaced, never changed, when its transcript grows, so its outcome can be kept. */
  private readonly outcomes = new WeakMap<Digest, { fresh: number; o: Outcome }>();

  private outcome(d: Digest, fresh: number): Outcome {
    const hit = this.outcomes.get(d);
    if (hit && hit.fresh === fresh) return hit.o;
    const o = outcomeOf(d, fresh);
    this.outcomes.set(d, { fresh, o });
    return o;
  }

  private render(): void {
    const fresh = freshTokens();
    const home = os.homedir();
    const rows = this.sessions.map((s): Row => {
      const key = keyOf(s);
      const changedAt = this.tracker.changedAt(key);
      const digest = this.digests.get(s.sessionId);
      const outcome = s.status === 'idle' && digest ? this.outcome(digest, fresh) : undefined;
      return {
        s,
        title: displayTitle(s, digest),
        group: groupOf(s, outcome),
        outcome,
        digest,
        changedAt,
        unread: isUnread(s, changedAt, this.shared.seenAt(s.sessionId)),
        where: this.where(key),
      };
    });
    this.rows = new Map(rows.map((r) => [keyOf(r.s), r]));

    const counts = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<Group, number>;
    for (const r of rows) counts[r.group]++;
    const unread = rows.filter((r) => r.unread).length;
    const sorted = GROUP_ORDER.flatMap((g) =>
      rows.filter((r) => r.group === g).sort((a, b) => compareInGroup(g, a.changedAt ?? a.s.startedAt, b.changedAt ?? b.s.startedAt)),
    );
    const cards = sorted.map((r) => toCard({ ...r, freshTokens: fresh, home }));
    const badge = counts.needs + unread ? { value: counts.needs + unread, tooltip: counterText(counts, unread) } : undefined;
    this.board.set(cards, badge);
    void vscode.commands.executeCommand('setContext', 'switchboard.hasUnread', unread > 0);
    this.renderStatus(counts, unread, sorted);
  }

  private renderStatus(counts: Record<Group, number>, unread: number, rows: readonly Row[]): void {
    const text = counterText(counts, unread);
    if (!text || !config().get<boolean>('statusBar.enabled', true)) {
      this.status.hide();
      return;
    }
    const icon = counts.needs ? '$(bell-dot)' : unread ? '$(pass)' : counts.working ? '$(pulse)' : '$(circle-outline)';
    this.status.text = `${icon} ${text}`;
    this.status.backgroundColor = counts.needs ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tip = new vscode.MarkdownString();
    for (const g of GROUP_ORDER) {
      const mine = rows.filter((r) => r.group === g);
      if (mine.length) tip.appendMarkdown(`**${GROUP_LABEL[g]} (${mine.length})**: ${mine.map((r) => escapeMd(r.title)).join(', ')}  \n`);
    }
    tip.appendMarkdown('\nClick to open Switchboard.');
    this.status.tooltip = tip;
    this.status.show();
  }

  private async maybePop(e: SessionEvent, looking: Session | undefined): Promise<void> {
    const cfg = config();
    const key = keyOf(e.session);
    const row = this.rows.get(key);
    // The user interrupted it themselves, so there is nothing to tell.
    if (e.type === 'finished' && row?.outcome?.kind === 'stopped' && row.outcome.why === 'interrupted') return;
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
    const text = popText(e, row?.title ?? e.session.name, e.type === 'finished' ? row?.outcome : undefined);
    const next = e.type === 'finished' && row?.group === 'handoff' ? ['Start next session'] : [];
    const warn = e.type === 'needs' || row?.group === 'stopped';
    const pick = await (warn ? vscode.window.showWarningMessage(text, 'Open', ...next) : vscode.window.showInformationMessage(text, 'Open', ...next));
    if (pick === 'Open') await this.open(key);
    else if (pick === 'Start next session') await this.startNext(key);
  }

  private async fromBoard(m: FromBoard): Promise<void> {
    switch (m.type) {
      case 'open':
        return this.open(m.key);
      case 'seen':
        return this.markSeen(m.key);
      case 'next':
        return this.startNext(m.key);
      case 'copy': {
        const o = this.rows.get(m.key)?.outcome;
        if (o?.kind === 'handoff' && o.prompt) {
          await vscode.env.clipboard.writeText(o.prompt);
          void vscode.window.setStatusBarMessage('$(check) Kickoff prompt copied', 3000);
        }
        return;
      }
      case 'new':
        return this.newSession();
    }
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
    } else if (row.where === 'nested') {
      void vscode.window.showInformationMessage(`"${row.title}" was started by another Claude Code session (a hook or a tool), so it has no tab of its own.`);
    } else if (row.where === 'elsewhere') {
      void vscode.window.showInformationMessage(`"${row.title}" runs in another VS Code window. Switch to that window to open it.`);
    } else {
      void vscode.window.showInformationMessage(`"${row.title}" runs outside VS Code (process ${row.s.pid}, in ${row.s.cwd}).`);
    }
    await this.markSeen(key);
    this.schedule();
  }

  /**
   * A terminal tab that runs one command. The command is always run by
   * /bin/sh, whose quoting `shq` is written for: the user's own shell may be
   * fish or PowerShell, which read quotes differently. `then` is an optional
   * program to `exec` afterwards (given as $0, so it needs no quoting).
   */
  private shellTab(name: string, cwd: string, command: string, icon: string, then?: string): vscode.Terminal {
    return vscode.window.createTerminal({
      name,
      cwd,
      shellPath: '/bin/sh',
      shellArgs: then ? ['-c', `${command}; exec "$0" -l`, then] : ['-c', command],
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
    const ids = [...this.rows.values()].filter((r) => r.unread).map((r): [string, number] => [r.s.sessionId, now]);
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
    await this.launch(name, cwd, task);
  }

  /**
   * Starts the session that follows a hand-over: same folder, and the kickoff
   * prompt as its first message. The prompt comes from Claude's reply, so the
   * user sees all of it before anything runs.
   */
  private async startNext(key: string | undefined): Promise<void> {
    const row = key ? this.rows.get(key) : undefined;
    if (!row) return;
    const prompt = row.outcome?.kind === 'handoff' ? row.outcome.prompt : undefined;
    const folder = path.basename(row.s.cwd);
    const pick = await vscode.window.showInformationMessage(
      `Start a new session in ${folder}?`,
      {
        modal: true,
        detail: prompt
          ? `Its first message will be the kickoff prompt from "${row.title}":\n\n${prompt}\n\nThe old session stays open.`
          : `It starts with a blank prompt. The old session stays open.`,
      },
      'Start',
    );
    if (pick !== 'Start') return;
    await this.markSeen(key);
    await this.launch(row.title, row.s.cwd, prompt ?? '');
  }

  /** Opens a tab running `claude -n <name> <task>` in a folder. */
  private async launch(name: string, cwd: string, task: string): Promise<void> {
    const claude = (await this.claudePath()) ?? 'claude';
    const n = name.trim();
    const first = task.trim();
    const args = [shq(claude)];
    if (n) args.push('-n', shq(n));
    // `--` stops a task that starts with "-" from being read as an option.
    if (first) args.push(...(first.startsWith('-') ? ['--'] : []), shq(first));
    // The user's shell takes over after claude exits, like a tab they opened.
    const shell = vscode.env.shell || process.env.SHELL || '/bin/zsh';
    const t = this.shellTab(n || 'Claude Code', cwd, args.join(' '), 'sparkle', shell);
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

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
