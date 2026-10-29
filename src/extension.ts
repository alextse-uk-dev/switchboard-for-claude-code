import { randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BoardView, type FromBoard, type TodoView } from './board';
import { toCard, type Card, type Where } from './core/card';
import { EFFORTS, isModelId, launchCommand, MODEL_ALIASES, readDefaults, shq, type Defaults } from './core/launch';
import { compareInGroup, counterText, groupOf, isUnread, popText, shouldPop, Tracker, type SessionEvent } from './core/model';
import { displayTitle } from './core/parse';
import { asksOf, MAX_TODO, shownTodos, type SessionAsks, type TodoOp } from './core/todo';
import { outcomeOf, type Digest } from './core/transcript';
import { GROUP_LABEL, GROUP_ORDER, keyOf, type Group, type Outcome, type Session } from './core/types';
import { SharedState, type Peers } from './shared';
import { claudeConfigDir, findClaude, message, SessionSource, type SessionCost } from './source';
import { TodoStore } from './todos';

const VIEW_ID = 'switchboard.sessions';
const DEBOUNCE_MS = 300;
const TICK_MS = 60_000;
/** How far one `workbench.action.increaseViewSize` moves a side bar's edge, in pixels. */
const RESIZE_STEP = 60;
/** The board width last set on its own, so it is set once and the user's own resizing then stands. */
const WIDTH_KEY = 'switchboard.boardWidthSet';
/** The model and effort last chosen for a new session ('' for the default). */
const LAST_MODEL_KEY = 'switchboard.lastModel';
const LAST_EFFORT_KEY = 'switchboard.lastEffort';

/** A model and an effort for a new session; either left out means Claude Code's default. */
interface ModelChoice {
  model?: string;
  effort?: string;
}

/** A quick pick that opens on the item `active` picks. Resolves undefined if dismissed. */
function quickPick<T extends vscode.QuickPickItem>(items: T[], o: { title: string; placeholder: string }, active: (i: T) => boolean): Promise<T | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.title = o.title;
    qp.placeholder = o.placeholder;
    qp.ignoreFocusOut = true;
    qp.items = items;
    const start = items.find(active);
    if (start) qp.activeItems = [start];
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems[0] ?? qp.activeItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

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

/** The board's default width in pixels (0: leave the side bar as it is). */
const boardWidth = () => Math.max(0, Math.round(config().get<number>('board.width', 440)));


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
  private readonly todos: TodoStore;
  private readonly tracker = new Tracker();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: FSWatcher[] = [];
  private readonly shellPids = new WeakMap<vscode.Terminal, Promise<number | undefined>>();
  /** Tabs this window opened with `claude attach`, by key. They close when the attach ends. */
  private readonly attachTabs = new Map<string, vscode.Terminal>();
  private claude?: Promise<string | undefined>;

  private sessions: Session[] = [];
  private digests = new Map<string, Digest>();
  private costs = new Map<string, SessionCost>();
  /** The reply each session's asks were last picked from, by session id. */
  private asked = new Map<string, number>();
  private cards = new Map<string, Card>();
  /** A width change in progress, and what it set out to do (for the log). */
  private fitting?: { from: number; target: number; timer: NodeJS.Timeout };
  private tabs = new Map<string, vscode.Terminal>();
  /** Sessions run from inside another session's process, by key. */
  private nested = new Set<string>();
  private peers: Peers = { owned: new Set(), focusedAt: 0 };
  private rows = new Map<string, Row>();

  private running = false;
  private again = false;
  private debounce?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.source = new SessionSource(claudeConfigDir(), () => this.claudePath(), (m) => this.log.warn(m));
    this.shared = new SharedState(ctx.globalStorageUri.fsPath, randomUUID());
    this.todos = new TodoStore(ctx.globalStorageUri.fsPath);
    this.board = new BoardView(vscode.Uri.joinPath(ctx.extensionUri, 'media'), (m) => void this.fromBoard(m));
    this.status.name = 'Switchboard';
    this.status.command = 'workbench.view.extension.switchboard';
  }

  async start(): Promise<void> {
    await this.shared.init(Date.now());
    await this.safe(this.todos.load(), false);
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
      vscode.commands.registerCommand('switchboard.addTodo', () => this.addTodo()),
      vscode.commands.registerCommand('switchboard.fitWidth', () => this.fitWidthNow()),
      this.board.onDidResize((px) => void this.onResize(px)),
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
        if (e.affectsConfiguration('switchboard.newSessionTokens') || e.affectsConfiguration('switchboard.showCost')) this.schedule();
        // A new default width applies at once if the board is in view.
        if (e.affectsConfiguration('switchboard.board.width') && this.board.width) void this.onResize(this.board.width);
      }),
    );
    this.watch(this.source.sessionsDir, () => this.schedule());
    this.watch(this.shared.seenDir, () => void this.shared.loadSeen().then(() => this.render()));
    // Another window changed the to-do list.
    this.watch(this.shared.dir, (file) => {
      if (file === null || file === TodoStore.FILE) void this.safe(this.todos.load(), false).then((changed) => changed && this.render());
    });
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
    await this.pickAsks(sessions);
    this.render();
    for (const e of events) void this.maybePop(e, looking);
    await this.countCosts(sessions);
  }

  /**
   * Counts what each session's tokens cost, then draws again. It runs after
   * the first draw: the first count reads whole transcripts, which can take
   * a while for long sessions. Sessions are counted one at a time, so the
   * work comes in small pieces.
   */
  private async countCosts(sessions: readonly Session[]): Promise<void> {
    if (!config().get<boolean>('showCost', true)) {
      if (this.costs.size) {
        this.costs = new Map();
        this.render();
      }
      return;
    }
    const costs = new Map<string, SessionCost>();
    let changed = false;
    for (const s of sessions) {
      if (!this.digests.has(s.sessionId)) continue;
      const c = await this.source.costOf(s);
      if (!c) continue;
      costs.set(s.sessionId, c);
      const old = this.costs.get(s.sessionId);
      if (!old || old.tally.replies !== c.tally.replies || old.helpers !== c.helpers) changed = true;
    }
    if ([...this.costs.keys()].some((id) => !costs.has(id))) changed = true;
    this.costs = costs;
    if (changed) this.render();
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

  /**
   * Keeps the to-do list in step with what idle sessions' newest replies ask
   * of the user: new asks are added, and asks a session has moved past are
   * cleared. A session that has ended keeps its last asks until ticked.
   */
  private async pickAsks(sessions: readonly Session[]): Promise<void> {
    const live = new Set(sessions.map((s) => s.sessionId));
    for (const id of this.asked.keys()) if (!live.has(id)) this.asked.delete(id);
    if (!config().get<boolean>('todos.fromReplies', true)) return;
    const changed: SessionAsks[] = [];
    for (const s of sessions) {
      const d = this.digests.get(s.sessionId);
      // A reply in the middle of a turn may still change its mind.
      if (s.status !== 'idle' || !d?.reply || this.asked.get(s.sessionId) === d.reply.at) continue;
      this.asked.set(s.sessionId, d.reply.at);
      changed.push({ sessionId: s.sessionId, session: displayTitle(s, d), texts: asksOf(d.reply.v) });
    }
    await this.safe(this.todos.syncAsks(changed, Date.now()), false);
  }

  private render(): void {
    const fresh = freshTokens();
    const showCost = config().get<boolean>('showCost', true);
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
    const cards = sorted.map((r) => {
      const cost = this.costs.get(r.s.sessionId);
      return toCard({ ...r, freshTokens: fresh, home, tally: cost?.tally, helpers: cost?.helpers, showCost });
    });
    this.cards = new Map(cards.map((c) => [c.key, c]));
    const todos = this.todoViews(rows);
    const open = todos.filter((t) => !t.doneAt).length;
    const badge = counts.needs + unread ? { value: counts.needs + unread, tooltip: counterText(counts, unread) } : undefined;
    this.board.set(cards, todos, badge);
    void vscode.commands.executeCommand('setContext', 'switchboard.hasUnread', unread > 0);
    this.renderStatus(counts, unread, sorted, open);
  }

  /** The list as the page draws it: open items newest first, then done ones, most recently done first. */
  private todoViews(rows: readonly Row[]): TodoView[] {
    const keys = new Map(rows.map((r) => [r.s.sessionId, keyOf(r.s)]));
    const list = shownTodos(this.todos.list, Date.now());
    const open = list.filter((t) => !t.doneAt).sort((a, b) => b.createdAt - a.createdAt);
    const done = list.filter((t) => t.doneAt).sort((a, b) => b.doneAt! - a.doneAt!);
    return [...open, ...done].map((t) => ({
      id: t.id,
      text: t.text,
      from: t.from,
      session: t.session,
      key: t.sessionId ? keys.get(t.sessionId) : undefined,
      createdAt: t.createdAt,
      doneAt: t.doneAt,
    }));
  }

  private renderStatus(counts: Record<Group, number>, unread: number, rows: readonly Row[], todos: number): void {
    const sessions = counterText(counts, unread);
    const text = [sessions, todos ? `${todos} to do` : ''].filter(Boolean).join(' · ');
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
    if (todos) tip.appendMarkdown(`**To do**: ${todos} open  \n`);
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
      case 'todo':
        return this.cardToTodo(m.key);
      case 'todoAdd':
        await this.changeTodo({ op: 'add', id: `u-${randomUUID()}`, text: m.text });
        return;
      case 'todoDone':
        await this.changeTodo({ op: 'done', id: m.id, done: m.done });
        return;
      case 'todoDelete':
        await this.changeTodo({ op: 'delete', id: m.id });
        return;
      case 'todoClear':
        await this.changeTodo({ op: 'clearDone' });
        return;
    }
  }

  private async changeTodo(o: TodoOp): Promise<boolean> {
    const changed = await this.safe(this.todos.change(o, Date.now()), false);
    if (changed) this.render();
    return changed;
  }

  /** Puts what a card says (its question, prompt or recap) on the to-do list, linked to its session. */
  private async cardToTodo(key: string): Promise<void> {
    const row = this.rows.get(key);
    const card = this.cards.get(key);
    if (!row || !card) return;
    let text = card.detail ?? card.title;
    // Only a pasted document is longer; the start says what it is.
    if (text.length > MAX_TODO) text = `${text.slice(0, MAX_TODO - 1)}…`;
    if (await this.changeTodo({ op: 'add', id: `u-${randomUUID()}`, text, sessionId: row.s.sessionId, session: row.title })) {
      void vscode.window.setStatusBarMessage('$(check) Added to your to-do list', 3000);
    } else {
      void vscode.window.showWarningMessage('Switchboard could not add that to your to-do list. The Switchboard output channel says why.');
    }
  }

  private async addTodo(): Promise<void> {
    const text = await vscode.window.showInputBox({ title: 'Add a to-do', prompt: 'Something for you to do. It shows at the top of the Switchboard board.' });
    if (text?.trim()) await this.changeTodo({ op: 'add', id: `u-${randomUUID()}`, text });
  }

  /**
   * Gives the board its default width the first time it is drawn (and again
   * after the setting changes). After that the user's own resizing stands.
   */
  private async onResize(px: number): Promise<void> {
    const f = this.fitting;
    if (f) {
      this.fitting = undefined;
      clearTimeout(f.timer);
      const moved = px !== f.from;
      this.log.info(`Board width: ${f.from}px → ${px}px (default ${f.target}px).`);
      if (!moved) this.log.warn('Could not change the side bar width. Drag its edge, or check that Switchboard is in the primary side bar.');
      return;
    }
    const target = boardWidth();
    if (!target || this.ctx.globalState.get<number>(WIDTH_KEY) === target) return;
    await this.ctx.globalState.update(WIDTH_KEY, target);
    // Only ever wider on its own: a side bar already wider than the default stays.
    if (px < target - RESIZE_STEP / 2) await this.fitWidth(px, target);
  }

  /** The command: open the board and set it to the default width, wider or narrower. */
  private async fitWidthNow(): Promise<void> {
    const target = boardWidth();
    if (!target) {
      void vscode.window.showInformationMessage('Set switchboard.board.width to a width in pixels first (it is 0, which leaves the side bar alone).');
      return;
    }
    // Marked as set first, so the width the board reports on opening doesn't start a second change.
    await this.ctx.globalState.update(WIDTH_KEY, target);
    await vscode.commands.executeCommand('workbench.view.extension.switchboard');
    const px = this.board.width ?? (await new Promise<number | undefined>((resolve) => {
      const d = this.board.onDidResize((w) => {
        d.dispose();
        resolve(w);
      });
      setTimeout(() => {
        d.dispose();
        resolve(undefined);
      }, 3000);
    }));
    if (px === undefined) {
      this.log.warn('The board did not report its width, so it was left alone.');
      return;
    }
    await this.fitWidth(px, target);
  }

  /**
   * VS Code has no setting or API for a view's width. Its "Increase/Decrease
   * Current View Size" commands move the edge of whichever part has focus,
   * and focus inside a webview doesn't count as being in the side bar. So
   * Explorer (whose tree does) takes focus while the edge moves, and the board
   * comes back straight after.
   */
  private async fitWidth(px: number, target: number): Promise<void> {
    const steps = Math.max(-20, Math.min(20, Math.round((target - px) / RESIZE_STEP)));
    if (!steps || this.fitting) return;
    try {
      await vscode.commands.executeCommand('workbench.view.explorer');
      // Explorer hides the board only when both are in the same side bar.
      // If the board is still in view, widening would move some other part.
      await new Promise((r) => setTimeout(r, 250));
      if (this.board.visible) {
        this.log.warn('Switchboard is not in the same side bar as Explorer, so its width was left alone. Drag its edge instead.');
        return;
      }
      const step = steps > 0 ? 'workbench.action.increaseViewSize' : 'workbench.action.decreaseViewSize';
      for (let i = 0; i < Math.abs(steps); i++) await vscode.commands.executeCommand(step);
      // The board reports its new width when it is back in view; onResize logs it.
      const timer = setTimeout(() => {
        if (this.fitting?.timer !== timer) return;
        this.fitting = undefined;
        this.log.warn('The board did not report its width after the change.');
      }, 3000);
      this.fitting = { from: px, target, timer };
    } catch (e) {
      this.log.warn(`Could not set the board width: ${message(e)}`);
    } finally {
      await vscode.commands.executeCommand('workbench.view.extension.switchboard');
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
    const asks = config().get<boolean>('newSession.chooseModel', true);
    const total = asks ? 5 : 3;
    const name = await vscode.window.showInputBox({
      title: `New Claude Code session (1/${total})`,
      prompt: 'A name for the session. It shows on the tab and in Switchboard. Leave empty to let Claude name it.',
      placeHolder: 'e.g. Fix the login redirect',
      ignoreFocusOut: true,
    });
    if (name === undefined) return;
    const cwd = await this.pickFolder(`New Claude Code session (2/${total})`);
    if (!cwd) return;
    let choice: ModelChoice = {};
    if (asks) {
      const c = await this.chooseModel(cwd, (n) => `New Claude Code session (${2 + n}/${total})`);
      if (!c) return;
      choice = c;
    }
    const task = await vscode.window.showInputBox({
      title: `New Claude Code session (${total}/${total})`,
      prompt: 'The first thing to ask Claude. Leave empty to start with a blank prompt.',
      placeHolder: 'e.g. Find why the login page redirects twice',
      ignoreFocusOut: true,
    });
    if (task === undefined) return;
    await this.launch({ name, cwd, task, ...choice });
  }

  /**
   * Starts the session that follows a hand-over: same folder, and the kickoff
   * prompt as its first message. The model and effort are chosen first; the
   * prompt comes from Claude's reply, so the user sees all of it before
   * anything runs.
   */
  private async startNext(key: string | undefined): Promise<void> {
    const row = key ? this.rows.get(key) : undefined;
    if (!row) return;
    const prompt = row.outcome?.kind === 'handoff' ? row.outcome.prompt : undefined;
    const folder = path.basename(row.s.cwd);
    let choice: ModelChoice = {};
    if (config().get<boolean>('newSession.chooseModel', true)) {
      const c = await this.chooseModel(row.s.cwd, (n) => `Start the next session in ${folder} (${n}/2)`);
      if (!c) return;
      choice = c;
    }
    const runs = `Model: ${choice.model ?? 'your default'} · Effort: ${choice.effort ?? 'your default'}.`;
    const pick = await vscode.window.showInformationMessage(
      `Start a new session in ${folder}?`,
      {
        modal: true,
        detail: prompt
          ? `${runs}\n\nIts first message will be the kickoff prompt from "${row.title}":\n\n${prompt}\n\nThe old session stays open.`
          : `${runs}\n\nIt starts with a blank prompt. The old session stays open.`,
      },
      'Start',
    );
    if (pick !== 'Start') return;
    await this.markSeen(key);
    await this.launch({ name: row.title, cwd: row.s.cwd, task: prompt ?? '', ...choice });
  }

  /**
   * Asks for the model, then the effort. Each list opens on the last choice,
   * and its first entry, "Default", passes nothing, so Claude Code's own
   * settings decide. Resolves undefined if the user backs out.
   */
  private async chooseModel(cwd: string, title: (step: 1 | 2) => string): Promise<ModelChoice | undefined> {
    const d = await this.defaultsFor(cwd);
    const lastModel = this.ctx.globalState.get<string>(LAST_MODEL_KEY, '');
    const lastEffort = this.ctx.globalState.get<string>(LAST_EFFORT_KEY, '');
    const fromSettings = (v: string | undefined, file?: string) =>
      v ? `${v}, from ${file ?? 'your Claude Code settings'}` : "Claude Code's own default";

    type Item = vscode.QuickPickItem & { value?: string };
    const models: Item[] = [
      { label: 'Default', description: fromSettings(d.model, d.from), value: '' },
      ...MODEL_ALIASES.map((m) => ({ label: m.label, description: m.id, detail: m.detail, value: m.id })),
      { label: '$(edit) Another model…', description: 'a full model id, e.g. claude-opus-5-5', value: undefined },
    ];
    if (lastModel && !models.some((m) => m.value === lastModel)) models.splice(1, 0, { label: lastModel, description: 'last used', value: lastModel });
    const m = await quickPick(models, { title: title(1), placeholder: 'Which model should the session use?' }, (i) => i.value === lastModel);
    if (!m) return undefined;
    let model = m.value;
    if (model === undefined) {
      model = await vscode.window.showInputBox({
        title: title(1),
        prompt: 'A model alias (opus, sonnet, haiku, fable) or a full model id.',
        placeHolder: 'e.g. claude-opus-5-5',
        ignoreFocusOut: true,
        validateInput: (v) => (!v.trim() || isModelId(v.trim()) ? undefined : 'Letters, digits and . _ : @ [ ] - only.'),
      });
      if (model === undefined) return undefined;
      model = model.trim();
    }

    const efforts: Item[] = [
      { label: 'Default', description: fromSettings(d.effort), value: '' },
      ...EFFORTS.map((e) => ({ label: e.id, description: e.detail || undefined, value: e.id })),
    ];
    const e = await quickPick(efforts, { title: title(2), placeholder: 'How hard should it think? More effort is slower and uses more tokens.' }, (i) => i.value === lastEffort);
    if (!e) return undefined;
    await this.ctx.globalState.update(LAST_MODEL_KEY, model);
    await this.ctx.globalState.update(LAST_EFFORT_KEY, e.value ?? '');
    return { model: model || undefined, effort: e.value || undefined };
  }

  /** The model and effort Claude Code would use in a folder: user settings, then the project's own. */
  private async defaultsFor(cwd: string): Promise<Defaults> {
    const read = (file: string) => fs.readFile(file, 'utf8').catch(() => undefined);
    const files = [
      { name: 'your Claude Code settings', file: path.join(claudeConfigDir(), 'settings.json') },
      { name: "the project's .claude/settings.json", file: path.join(cwd, '.claude', 'settings.json') },
      { name: "the project's .claude/settings.local.json", file: path.join(cwd, '.claude', 'settings.local.json') },
    ];
    return readDefaults(await Promise.all(files.map(async (f) => ({ name: f.name, text: await read(f.file) }))));
  }

  /** Opens a tab running `claude -n <name> [--model …] [--effort …] <task>` in a folder. */
  private async launch(l: { name: string; cwd: string; task: string } & ModelChoice): Promise<void> {
    const claude = (await this.claudePath()) ?? 'claude';
    const command = launchCommand({ claude, name: l.name, model: l.model, effort: l.effort, task: l.task });
    // The user's shell takes over after claude exits, like a tab they opened.
    const shell = vscode.env.shell || process.env.SHELL || '/bin/zsh';
    const t = this.shellTab(l.name.trim() || 'Claude Code', l.cwd, command, 'sparkle', shell);
    t.show(false);
    this.schedule();
  }

  private async pickFolder(title: string): Promise<string | undefined> {
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
      title,
      placeHolder: 'Which folder should the session work in?',
      ignoreFocusOut: true,
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
