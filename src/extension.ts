import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showBanner, playSound } from './alert';
import { BoardView, type FromBoard, type TodoView } from './board';
import { alertPlan, alertText, givesAllAlerts, soundFile } from './core/alert';
import { blankContext, fillBlanks, findBlanks, type Blank } from './core/blanks';
import { toCard, type Card, type Where } from './core/card';
import { EFFORTS, inTabScript, isEffort, isModelId, launchCommand, launchSummary, MODEL_ALIASES, nextTab, nextTabLine, readDefaults, shq, type Defaults } from './core/launch';
import { modelName } from './core/cost';
import { compareInGroup, counterText, groupOf, isUnread, popText, shouldPop, Tracker, type SessionEvent } from './core/model';
import { displayTitle } from './core/parse';
import { awayMs, maskedTopic, newTopic, parseTopicUrl, pendingVerdict, pushMessage, pushVerdict, tokenProblem, type Pending, type PushTarget } from './core/push';
import { asksOf, MAX_TODO, shownTodos, type SessionAsks, type TodoOp } from './core/todo';
import { outcomeOf, type Digest } from './core/transcript';
import { GROUP_LABEL, GROUP_ORDER, keyOf, type Group, type Outcome, type Session } from './core/types';
import { PushStore, sendPush, systemIdleMs } from './push';
import { SharedState, type Peers } from './shared';
import { claudeConfigDir, findClaude, message, SessionSource, type SessionCost } from './source';
import { TodoStore } from './todos';

const VIEW_ID = 'switchboard.sessions';
const NTFY = 'https://ntfy.sh/';
/** How often held-back pushes check whether you have left. */
const PENDING_TICK_MS = 60_000;
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
  /** What the defaults were when the choice was made, for the summary. */
  defaults?: Defaults;
}

/** Everything a new session starts with. */
interface Launching extends ModelChoice {
  name: string;
  cwd: string;
  task: string;
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

/**
 * One slot's answer: pick a choice, or type straight into the list. A choice
 * that wants the user's own words ("what's wrong") opens a box for them.
 */
function askBlank(b: Blank, context: string, title: string): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { answer?: string; open?: string };
  const fixed: Item[] = b.choices.map((c) =>
    c.open ? { label: `$(edit) ${c.label}…`, description: 'in your own words', open: c.label } : { label: c.label, answer: c.label },
  );
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = title;
    qp.placeholder = `Pick, or type your answer: ${context}`;
    qp.ignoreFocusOut = true;
    qp.items = fixed;
    qp.onDidChangeValue((v) => {
      const t = v.trim();
      qp.items = t ? [{ label: t, description: 'your answer', alwaysShow: true, answer: t }, ...fixed] : fixed;
    });
    let done = false;
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0] ?? qp.activeItems[0];
      if (!pick) return;
      done = true;
      qp.hide();
      if (pick.answer !== undefined) {
        resolve(pick.answer);
        return;
      }
      void vscode.window
        .showInputBox({
          title,
          prompt: `${pick.open ?? b.text}: your words go in the prompt in place of <${b.text}>.`,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : 'Type an answer, or press Escape to start nothing.'),
        })
        .then((v) => resolve(v?.trim() || undefined));
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

/** Mac alerts are turned on, and this is a Mac. */
const macAlertsOn = () => process.platform === 'darwin' && config().get<boolean>('macAlert.enabled', false);

/** This window gives every kind of Mac alert, with a sound: what its file tells other tools. */
const allMacAlerts = () =>
  macAlertsOn() &&
  givesAllAlerts({
    enabled: true,
    needsYou: config().get<boolean>('macAlert.needsYou', true),
    finished: config().get<boolean>('macAlert.finished', true),
    sound: config().get<string>('macAlert.sound', 'Glass'),
  });

/**
 * The moment a claim is named by. Claude Code's own status time is the same
 * in every window; without one, each window's clock differs by a little, so
 * the minute stands in, and two windows can't both claim one event.
 */
const claimAt = (s: Session, now: number) => s.statusUpdatedAt ?? `m${Math.floor(now / 60_000)}`;

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
  private readonly push: PushStore;
  /** Events held back while you were here, by claim name. */
  private readonly pending = new Map<string, Pending>();
  private pendingTick?: NodeJS.Timeout;
  /** When this window started, for telling "away" with no focus seen yet. */
  private readonly startedAt = Date.now();
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
  private peers: Peers = { owned: new Set(), focusedAt: 0, blurredAt: 0, focusedNow: false };
  private rows = new Map<string, Row>();

  private running = false;
  private again = false;
  private debounce?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.source = new SessionSource(claudeConfigDir(), () => this.claudePath(), (m) => this.log.warn(m));
    this.shared = new SharedState(ctx.globalStorageUri.fsPath, randomUUID());
    this.todos = new TodoStore(ctx.globalStorageUri.fsPath);
    this.push = new PushStore(ctx.secrets);
    this.board = new BoardView(vscode.Uri.joinPath(ctx.extensionUri, 'media'), (m) => void this.fromBoard(m));
    this.status.name = 'Switchboard';
    this.status.command = 'workbench.view.extension.switchboard';
  }

  async start(): Promise<void> {
    await this.shared.init(Date.now());
    await this.safe(this.todos.load(), false);
    await this.push.load().catch((e) => this.log.warn(`Phone push: ${message(e)}`));
    if (vscode.window.state.focused) await this.safe(this.shared.noteFocused(Date.now()), undefined);
    await this.safe(this.shared.noteMacAlerts(allMacAlerts()), undefined);
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
      vscode.commands.registerCommand('switchboard.phonePush.setup', () => this.setUpPush()),
      vscode.commands.registerCommand('switchboard.phonePush.test', () => this.testPush()),
      vscode.commands.registerCommand('switchboard.phonePush.off', () => this.pushOff()),
      vscode.commands.registerCommand('switchboard.macAlert.test', () => this.testMacAlert()),
      // Another window set it up or turned it off.
      this.ctx.secrets.onDidChange((e) => {
        if (e.key === PushStore.KEY) void this.push.load().then(() => this.render(), (err) => this.log.warn(`Phone push: ${message(err)}`));
      }),
      this.board.onDidResize((px) => void this.onResize(px)),
      w.onDidChangeActiveTerminal(() => void this.noteLooking()),
      w.onDidChangeWindowState((s) => {
        if (s.focused) {
          void this.safe(this.shared.noteFocused(Date.now()), undefined);
          this.schedule();
        } else void this.safe(this.shared.noteBlurred(Date.now()), undefined);
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
        if (e.affectsConfiguration('switchboard.macAlert')) void this.safe(this.shared.noteMacAlerts(allMacAlerts()), undefined);
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
    this.peers = await this.safe(this.shared.peers(), { owned: new Set<string>(), focusedAt: 0, blurredAt: 0, focusedNow: false });

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
    for (const e of events) {
      void this.maybePop(e, looking);
      void this.maybePush(e, looking);
      void this.maybeAlert(e, looking);
    }
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
    if (this.push.peek()) tip.appendMarkdown(`**Phone push**: on${config().get<string>('phonePush.when', 'away') === 'always' ? '' : `, when you're away ${config().get<number>('phonePush.awayMinutes', 3)} min`}  \n`);
    tip.appendMarkdown('\nClick to open Switchboard.');
    this.status.tooltip = tip;
    this.status.show();
  }

  /** Whether this window shows a pop-up for an event (before any claim). */
  private pops(e: SessionEvent, looking: Session | undefined): boolean {
    const cfg = config();
    const key = keyOf(e.session);
    return shouldPop(e, {
      needsOn: cfg.get<boolean>('popups.needsYou', true),
      finishedOn: cfg.get<boolean>('popups.finished', true),
      finishedMinMs: cfg.get<number>('popups.finishedMinSeconds', 30) * 1000,
      lookingAt: looking !== undefined && keyOf(looking) === key,
      ownedHere: this.tabs.has(key),
      ownedElsewhere: this.peers.owned.has(key),
      lastFocused: this.shared.lastFocusedAt >= this.peers.focusedAt,
    });
  }

  private async maybePop(e: SessionEvent, looking: Session | undefined): Promise<void> {
    const key = keyOf(e.session);
    const row = this.rows.get(key);
    // The user interrupted it themselves, so there is nothing to tell.
    if (e.type === 'finished' && row?.outcome?.kind === 'stopped' && row.outcome.why === 'interrupted') return;
    if (!this.pops(e, looking)) return;
    if (!(await this.safe(this.shared.claim(`${e.type}-${key}-${claimAt(e.session, Date.now())}`), true))) return;
    const text = popText(e, row?.title ?? e.session.name, e.type === 'finished' ? row?.outcome : undefined);
    const next = e.type === 'finished' && row?.group === 'handoff' ? ['Start next session'] : [];
    const warn = e.type === 'needs' || row?.group === 'stopped';
    const pick = await (warn ? vscode.window.showWarningMessage(text, 'Open', ...next) : vscode.window.showInformationMessage(text, 'Open', ...next));
    if (pick === 'Open') await this.open(key);
    else if (pick === 'Start next session') await this.startNext(key);
  }

  private pushSettings() {
    const cfg = config();
    return {
      needsOn: cfg.get<boolean>('phonePush.needsYou', true),
      finishedOn: cfg.get<boolean>('phonePush.finished', true),
      finishedMinMs: Math.max(0, cfg.get<number>('phonePush.finishedMinSeconds', 60)) * 1000,
      always: cfg.get<string>('phonePush.when', 'away') === 'always',
      awayAfterMs: Math.max(0, cfg.get<number>('phonePush.awayMinutes', 3)) * 60_000,
      withWords: cfg.get<boolean>('phonePush.quoteClaude', false),
    };
  }

  /** How long you have been away from this computer, as far as can be told. */
  private async away(): Promise<number> {
    const idle = await systemIdleMs();
    const p = this.peers;
    const anyFocused = vscode.window.state.focused || p.focusedNow;
    const last = Math.max(this.startedAt, this.shared.lastFocusedAt, this.shared.lastBlurredAt, p.focusedAt, p.blurredAt);
    return awayMs(Date.now(), idle, anyFocused, last);
  }

  /**
   * Sends a phone push for an event if you are away, or holds it back to
   * send if you leave before dealing with it. Every window sees every event,
   * but only one decides (as for pop-ups), and a claim makes sure only one
   * sends it.
   */
  private async maybePush(e: SessionEvent, looking: Session | undefined): Promise<void> {
    if (!(await this.push.get())) return;
    const key = keyOf(e.session);
    const changedAt = this.tracker.changedAt(key) ?? Date.now();
    const claim = `push-${e.type}-${key}-${claimAt(e.session, Date.now())}`;
    const c = this.pushSettings();
    const decides = this.tabs.has(key) || (!this.peers.owned.has(key) && this.shared.lastFocusedAt >= this.peers.focusedAt);
    const verdict = pushVerdict(e, this.rows.get(key)?.outcome, {
      ...c,
      decides,
      lookingAt: looking !== undefined && keyOf(looking) === key,
      awayMs: c.always ? 0 : await this.away(),
    });
    const p: Pending = { e, key, sessionId: e.session.sessionId, changedAt, since: Date.now() };
    if (verdict === 'push') await this.sendFor(p, claim);
    else if (verdict === 'wait' && !c.always) this.hold(claim, p);
  }

  /**
   * A macOS banner, and a sound once you have been away a while, for an
   * event the VS Code pop-up can't bring to you. As for pushes, one window
   * decides and a claim makes sure only one alerts.
   */
  private async maybeAlert(e: SessionEvent, looking: Session | undefined): Promise<void> {
    if (!macAlertsOn()) return;
    const cfg = config();
    const key = keyOf(e.session);
    const row = this.rows.get(key);
    const lookingAt = looking !== undefined && keyOf(looking) === key;
    const sound = soundFile(cfg.get<string>('macAlert.sound', 'Glass'));
    const plan = alertPlan(e, row?.outcome, {
      needsOn: cfg.get<boolean>('macAlert.needsYou', true),
      finishedOn: cfg.get<boolean>('macAlert.finished', true),
      finishedMinMs: Math.max(0, cfg.get<number>('macAlert.finishedMinSeconds', 60)) * 1000,
      decides: this.tabs.has(key) || (!this.peers.owned.has(key) && this.shared.lastFocusedAt >= this.peers.focusedAt),
      seenHere: lookingAt || (vscode.window.state.focused && this.pops(e, looking)),
      idleMs: await systemIdleMs(),
      awayAfterMs: Math.max(0, cfg.get<number>('macAlert.awaySeconds', 60)) * 1000,
      soundOn: sound !== undefined,
    });
    if (!plan.banner && !plan.sound) return;
    if (!(await this.safe(this.shared.claim(`alert-${e.type}-${key}-${claimAt(e.session, Date.now())}`), true))) return;
    const t = alertText(e, row?.title ?? e.session.name, path.basename(e.session.cwd) || e.session.cwd, row?.outcome);
    await Promise.all([
      plan.banner ? showBanner(t.title, t.message).catch((err) => this.log.warn(`Mac alert banner not shown: ${message(err)}.`)) : undefined,
      plan.sound && sound ? playSound(sound).catch((err) => this.log.warn(`Mac alert sound not played: ${message(err)}.`)) : undefined,
    ]);
  }

  private async testMacAlert(): Promise<void> {
    if (process.platform !== 'darwin') {
      void vscode.window.showInformationMessage('Mac alerts work on macOS only.');
      return;
    }
    const sound = soundFile(config().get<string>('macAlert.sound', 'Glass'));
    try {
      await Promise.all([showBanner('Switchboard', 'A test alert. Sessions that need you, or finish, will show like this.'), sound ? playSound(sound) : undefined]);
    } catch (err) {
      void vscode.window.showWarningMessage(`The test alert failed: ${message(err)}`);
      return;
    }
    const off = !macAlertsOn();
    const pick = await vscode.window.showInformationMessage(
      `Test alert sent${sound ? ', with its sound' : ''}. No banner? Allow notifications for Script Editor in System Settings > Notifications.${off ? ' Mac alerts are off: turn them on to get them for your sessions.' : ''}`,
      ...(off ? ['Turn on Mac alerts'] : []),
    );
    if (pick === 'Turn on Mac alerts') await config().update('macAlert.enabled', true, vscode.ConfigurationTarget.Global);
  }

  private hold(claim: string, p: Pending): void {
    this.pending.set(claim, p);
    this.pendingTick ??= setInterval(() => void this.checkPending(), PENDING_TICK_MS);
  }

  private async checkPending(): Promise<void> {
    const c = this.pushSettings();
    const target = await this.push.get();
    // The other windows' focus may have changed since the last refresh.
    if (this.pending.size && target && !c.always) this.peers = await this.safe(this.shared.peers(), this.peers);
    const away = this.pending.size && target && !c.always ? await this.away() : 0;
    const now = Date.now();
    for (const [claim, p] of this.pending) {
      const live = this.sessions.some((s) => keyOf(s) === p.key);
      const v = !target || (c.always && !p.retry) || !live
        ? 'drop'
        : pendingVerdict(p, now, { changedAt: this.tracker.changedAt(p.key), seenAt: this.shared.seenAt(p.sessionId), awayMs: away, awayAfterMs: c.awayAfterMs });
      if (v === 'wait') continue;
      this.pending.delete(claim);
      if (v === 'push') await this.sendFor(p, claim);
    }
    if (!this.pending.size) {
      clearInterval(this.pendingTick);
      this.pendingTick = undefined;
    }
  }

  private async sendFor(p: Pending, claim: string): Promise<void> {
    const target = await this.push.get();
    // A retry already holds its claim.
    if (!target || (!p.retry && !(await this.safe(this.shared.claim(claim), true)))) return;
    const e = p.e;
    const key = keyOf(e.session);
    const row = this.rows.get(key);
    const m = pushMessage(e, row?.title ?? e.session.name, path.basename(e.session.cwd) || e.session.cwd, row?.outcome, this.pushSettings().withWords);
    try {
      await sendPush(target, m);
      this.log.info(`Phone push sent: ${e.type} for ${key}.`);
    } catch (err) {
      // Kept, and tried again each minute until it goes, the session moves on, or an hour passes.
      this.log.warn(`Phone push not sent, trying again in a minute: ${message(err)}.`);
      this.hold(claim, { ...p, retry: true });
    }
  }

  private async setUpPush(): Promise<void> {
    type Item = vscode.QuickPickItem & { how: 'new' | 'own' | 'off' };
    const current = await this.push.get();
    const items: Item[] = [
      { label: '$(sparkle) Make a new private topic on ntfy.sh', description: 'free, no account', detail: 'Recommended. You subscribe to it in the ntfy app on your phone.', how: 'new' },
      { label: '$(link) Use a topic URL I already have', description: 'ntfy.sh or your own ntfy server', how: 'own' },
    ];
    if (current) items.push({ label: '$(circle-slash) Turn phone push off', description: maskedTopic(current), how: 'off' });
    const pick = await vscode.window.showQuickPick(items, {
      title: current ? `Phone push is on (${maskedTopic(current)})` : 'Set up phone push',
      placeHolder: 'Pushes go to the ntfy app on your phone when a session needs you or finishes while you are away.',
      ignoreFocusOut: true,
    });
    if (!pick) return;
    if (pick.how === 'off') return this.pushOff();
    let target: PushTarget;
    if (pick.how === 'new') {
      target = { server: NTFY, topic: newTopic(randomBytes(16)) };
    } else {
      const url = await vscode.window.showInputBox({
        title: 'Set up phone push (1/2): topic URL',
        prompt: 'The topic your phone subscribes to. Anyone who knows it can read the pushes, so keep it hard to guess.',
        placeHolder: 'https://ntfy.sh/your-topic',
        ignoreFocusOut: true,
        validateInput: (v) => {
          const r = parseTopicUrl(v);
          return 'error' in r ? r.error : undefined;
        },
      });
      if (url === undefined) return;
      const r = parseTopicUrl(url);
      if ('error' in r) return;
      const token = await vscode.window.showInputBox({
        title: 'Set up phone push (2/2): access token',
        prompt: 'Only for a topic that needs one (it starts "tk_"). Leave it empty for an open topic.',
        password: true,
        ignoreFocusOut: true,
        validateInput: tokenProblem,
      });
      if (token === undefined) return;
      target = { ...r, token: token.trim() || undefined };
    }
    await this.push.set(target);
    const url = `${target.server}${target.topic}`;
    if (pick.how === 'new') {
      await vscode.env.clipboard.writeText(url);
      const steps = [
        '1. Install the free ntfy app on your phone (App Store or Google Play) and open it.',
        '2. Tap +, then paste or type this topic, and subscribe:',
        `      ${target.topic}`,
        '',
        `The full URL, ${url}, is on the clipboard (on an iPhone with Handoff, it pastes there too). Keep it private: anyone who knows the topic can read the pushes.`,
        '',
        'Then press Send a test push.',
      ].join('\n');
      const go = await vscode.window.showInformationMessage('Phone push is on. Now subscribe on your phone.', { modal: true, detail: steps }, 'Send a test push');
      if (go === 'Send a test push') await this.testPush();
      return;
    }
    await this.testPush();
  }

  private async testPush(): Promise<void> {
    const target = await this.push.get();
    if (!target) {
      const go = await vscode.window.showInformationMessage('Phone push is not set up yet.', 'Set up phone push');
      if (go) await this.setUpPush();
      return;
    }
    try {
      await sendPush(target, { title: 'Switchboard test push', message: 'Phone push works. You will get one like this when a session needs you or finishes while you are away.', priority: 3, tags: ['wave'] });
      void vscode.window.showInformationMessage(`Test push sent to ${maskedTopic(target)}. If it doesn't show on your phone, check that the ntfy app subscribes to the same topic.`);
    } catch (e) {
      void vscode.window.showWarningMessage(`The test push was not sent: ${message(e)}.`);
    }
  }

  private async pushOff(): Promise<void> {
    if (!(await this.push.get())) {
      void vscode.window.showInformationMessage('Phone push is already off.');
      return;
    }
    await this.push.clear();
    this.pending.clear();
    this.render();
    void vscode.window.showInformationMessage('Phone push is off. The topic is forgotten; set it up again for a new one.');
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
    const step = (n: number) => `New Claude Code session (${n}/${total})`;
    const name = await vscode.window.showInputBox({
      title: step(1),
      prompt: 'A name for the session. It shows on the tab and in Switchboard. Leave empty to let Claude name it.',
      placeHolder: 'e.g. Fix the login redirect',
      ignoreFocusOut: true,
    });
    if (name === undefined) return;
    const cwd = await this.pickFolder(step(2));
    if (!cwd) return;
    const task = await vscode.window.showInputBox({
      title: step(3),
      prompt: 'The first thing to ask Claude. Leave empty to start with a blank prompt.',
      placeHolder: 'e.g. Find why the login page redirects twice',
      ignoreFocusOut: true,
    });
    if (task === undefined) return;
    // A pasted kickoff prompt may still have a slot for the user's answer.
    const blanks = findBlanks(task).length;
    const at = (n: number) => `New Claude Code session (${n}/${total + blanks})`;
    const filled = blanks ? await this.fillPrompt(task, (i) => `${at(4 + i)}: fill in the first message`) : task;
    if (filled === undefined) return;
    const choice = asks ? await this.chooseModel(cwd, (n) => at(3 + blanks + n)) : {};
    if (!choice) return;
    const l = { name, cwd, task: filled, ...choice };
    if (await this.confirmLaunch(l, 'Start this session?')) await this.launch(l);
  }

  /**
   * Starts the session that follows a hand-over: same folder, and the kickoff
   * prompt as its first message. Any slot the prompt leaves for the user's
   * answer is asked first, then the model and effort, then a summary to
   * confirm; the prompt comes from Claude's reply, so the user sees all of
   * it there before anything runs. The new session takes over the old one's
   * terminal tab when it can (see `nextTab`), else opens a tab of its own.
   */
  private async startNext(key: string | undefined): Promise<void> {
    const row = key ? this.rows.get(key) : undefined;
    if (!key || !row) return;
    const prompt = row.outcome?.kind === 'handoff' ? row.outcome.prompt : undefined;
    const folder = path.basename(row.s.cwd);
    // The next session carries on the same work, so it starts from the same model and effort.
    const same = { model: row.digest?.model?.v, effort: row.digest?.effort?.v };
    const asks = config().get<boolean>('newSession.chooseModel', true);
    const blanks = prompt ? findBlanks(prompt).length : 0;
    const step = (n: number) => `Start the next session in ${folder} (${n}/${blanks + (asks ? 2 : 0)})`;
    const task = prompt && blanks ? await this.fillPrompt(prompt, (i) => `${step(1 + i)}: fill in the kickoff prompt`) : prompt ?? '';
    if (task === undefined) return;
    const choice = asks ? await this.chooseModel(row.s.cwd, (n) => step(blanks + n), same) : same;
    if (!choice) return;
    const l = { name: row.title, cwd: row.s.cwd, task, ...choice };
    const earlier = row.outcome?.kind === 'handoff' && row.outcome.earlier;
    const filledIn = blanks ? `, with your answer${blanks > 1 ? 's' : ''} filled in` : '';
    const firstFrom = prompt ? `the kickoff prompt from ${earlier ? 'an earlier reply in ' : ''}"${row.title}"${filledIn}` : undefined;
    const tab = this.tabs.get(key);
    const where = nextTab({
      enabled: config().get<boolean>('startNext.sameTab', true),
      kind: row.s.kind,
      where: row.where,
      busy: row.s.status === 'busy',
      isTabProcess: !!tab && (await this.shellPid(tab)) === row.s.pid,
    });
    if (!(await this.confirmLaunch(l, `Start the next session in ${folder}?`, firstFrom, nextTabLine(where)))) return;
    await this.markSeen(key);
    if (where.inPlace && tab) {
      if (await this.launchInTab(key, tab, l)) return;
      void vscode.window.showInformationMessage("Switchboard couldn't start it in the old session's tab, so it opened in a tab of its own.");
    }
    await this.launch(l);
  }

  /**
   * Ends the session in a tab and starts `l` in the shell it leaves behind.
   * SIGINT is how Claude Code quits cleanly (exit status 0, the terminal put
   * back); it is sent once more, then SIGTERM, if the session is slow to go.
   * Resolves false, with nothing typed, if the session is busy again, won't
   * end, or its tab closed as it ended.
   */
  private async launchInTab(key: string, tab: vscode.Terminal, l: Launching): Promise<boolean> {
    const s = this.rows.get(key)?.s;
    if (!s || s.status === 'busy' || !vscode.window.terminals.includes(tab)) return false;
    for (const [sig, ms] of [['SIGINT', 2000], ['SIGINT', 2000], ['SIGTERM', 3000]] as const) {
      if (!alive(s.pid)) break;
      try {
        process.kill(s.pid, sig);
      } catch {
        break;
      }
      await until(() => !alive(s.pid), ms);
    }
    if (alive(s.pid)) {
      this.log.warn(`Session ${s.sessionId} (process ${s.pid}) did not end, so the next session opened in a tab of its own.`);
      return false;
    }
    if (!vscode.window.terminals.includes(tab)) return false;
    const claude = (await this.claudePath()) ?? 'claude';
    const command = launchCommand({ claude, name: l.name, model: l.model, effort: l.effort, task: l.task });
    // A file, because the user's shell may be zsh, bash or fish, and a long first message would echo line by line.
    const file = path.join(os.tmpdir(), `switchboard-${randomUUID()}.sh`);
    await fs.writeFile(file, inTabScript(command), { mode: 0o600 });
    // The shell prints its prompt after claude exits; text sent before that would be lost to claude.
    await new Promise((r) => setTimeout(r, 300));
    tab.sendText(`sh ${shq(file)}`, true);
    tab.show(false);
    this.schedule();
    return true;
  }

  /**
   * Asks for each slot a prompt leaves for the user's answer, such as
   * "<looks fine / what's wrong>", one step each, and returns the prompt with
   * the answers in. Resolves undefined if the user backs out.
   */
  private async fillPrompt(prompt: string, title: (i: number) => string): Promise<string | undefined> {
    const blanks = findBlanks(prompt);
    const answers: string[] = [];
    for (const [i, b] of blanks.entries()) {
      const a = await askBlank(b, blankContext(prompt, b), title(i));
      if (a === undefined) return undefined;
      answers.push(a);
    }
    return fillBlanks(prompt, blanks, answers);
  }

  /**
   * The last step before a session starts: everything it will start with,
   * in one box. Resolves true only for Start.
   */
  private async confirmLaunch(l: Launching, question: string, firstFrom?: string, after?: string): Promise<boolean> {
    const defaults = l.defaults ?? (await this.defaultsFor(l.cwd));
    const home = os.homedir();
    const where = l.cwd === home || l.cwd.startsWith(home + path.sep) ? `~${l.cwd.slice(home.length)}` : l.cwd;
    const detail = launchSummary({ ...l, where, defaults, firstFrom, after });
    const pick = await vscode.window.showInformationMessage(question, { modal: true, detail }, 'Start');
    return pick === 'Start';
  }

  /**
   * Asks for the model, then the effort. Each list opens on `same` (the old
   * session's own, when starting the next one), else on the last choice. Its
   * first entry, "Default", passes nothing, so Claude Code's own settings
   * decide. Resolves undefined if the user backs out.
   */
  private async chooseModel(cwd: string, title: (step: 1 | 2) => string, same?: { model?: string; effort?: string }): Promise<ModelChoice | undefined> {
    const d = await this.defaultsFor(cwd);
    const sameModel = same?.model && isModelId(same.model) ? same.model : undefined;
    const sameEffort = same?.effort && isEffort(same.effort) ? same.effort : undefined;
    const lastModel = sameModel ?? this.ctx.globalState.get<string>(LAST_MODEL_KEY, '');
    const lastEffort = sameEffort ?? this.ctx.globalState.get<string>(LAST_EFFORT_KEY, '');
    const fromSettings = (v: string | undefined, file?: string) =>
      v ? `${v}, from ${file ?? 'your Claude Code settings'}` : "Claude Code's own default";

    type Item = vscode.QuickPickItem & { value?: string };
    const models: Item[] = [
      { label: 'Default', description: fromSettings(d.model, d.from), value: '' },
      ...MODEL_ALIASES.map((m) => ({ label: m.label, description: m.id, detail: m.detail, value: m.id })),
      { label: '$(edit) Another model…', description: 'a full model id, e.g. claude-opus-5-5', value: undefined },
    ];
    if (sameModel) {
      models.splice(1, 0, { label: 'Same as this session', description: `${modelName(sameModel)} (${sameModel})`, value: sameModel });
    } else if (lastModel && !models.some((m) => m.value === lastModel)) {
      models.splice(1, 0, { label: lastModel, description: 'last used', value: lastModel });
    }
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
      ...EFFORTS.map((e) => ({
        label: e.id,
        description: [e.id === sameEffort ? 'this session\'s effort' : '', e.detail].filter(Boolean).join(' · ') || undefined,
        value: e.id,
      })),
    ];
    const e = await quickPick(efforts, { title: title(2), placeholder: 'How hard should it think? More effort is slower and uses more tokens.' }, (i) => i.value === lastEffort);
    if (!e) return undefined;
    await this.ctx.globalState.update(LAST_MODEL_KEY, model);
    await this.ctx.globalState.update(LAST_EFFORT_KEY, e.value ?? '');
    return { model: model || undefined, effort: e.value || undefined, defaults: d };
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
  private async launch(l: Launching): Promise<void> {
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
    clearInterval(this.pendingTick);
    for (const w of this.watchers) w.close();
    for (const d of this.disposables) d.dispose();
    void this.shared.dispose();
  }
}

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Resolves once `done` holds, checking every 100 ms, or after `ms` regardless. */
async function until(done: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
