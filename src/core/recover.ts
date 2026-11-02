import * as path from 'node:path';
import { inTabScript, isEffort, shq } from './launch';
import type { Status } from './types';

/**
 * How long a window waits, after one of its sessions ends, before forgetting
 * it. As VS Code quits, its terminals die first and its windows a few seconds
 * later, so a window can see every session end on the way out. Waiting means
 * only a session that ended while the window lived on is forgotten: a tab
 * closed by hand, or /exit.
 */
export const FORGET_AFTER_MS = 20_000;

/** A closed session untouched for this long is no longer offered. */
export const KEEP_CLOSED_MS = 14 * 24 * 60 * 60 * 1000;

/** What it takes to reopen a session that has a terminal tab in a VS Code window. */
export interface Recoverable {
  sessionId: string;
  title: string;
  cwd: string;
  /** Resuming keeps the model but goes back to the default effort, so the effort is passed on. */
  effort?: string;
  status: Status;
  /** When its status last changed. */
  activeAt: number;
  /** Its place among the window's tabs. VS Code brings tabs back in order, as empty shells. */
  tab: number;
  /** The window's workspace, which decides whether that tab can be this window's. */
  workspace: string;
  /**
   * The extension host that holds its tab, as "pid|start time": while it runs,
   * that window looks after the record. A pid alone won't do: after a restart
   * of the Mac, the old number soon belongs to something else.
   */
  owner: string;
}

/** A session id as Claude Code writes it. Also what names the record's file. */
export function isSessionId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(s);
}

const STATUSES: ReadonlySet<string> = new Set<Status>(['busy', 'waiting', 'idle', 'unknown']);

/** Reads a record back. Anything that isn't one is refused: its fields end up in a command. */
export function parseRecord(text: string): Recoverable | undefined {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!o || typeof o !== 'object') return undefined;
  const { sessionId, title, cwd, effort, status, activeAt, tab, workspace, owner } = o;
  if (typeof sessionId !== 'string' || !isSessionId(sessionId)) return undefined;
  if (typeof title !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return undefined;
  if (typeof status !== 'string' || !STATUSES.has(status)) return undefined;
  if (typeof activeAt !== 'number' || typeof tab !== 'number' || typeof owner !== 'string' || !owner) return undefined;
  return { sessionId, title, cwd, effort: typeof effort === 'string' && isEffort(effort) ? effort : undefined, status: status as Status, activeAt, tab, workspace: typeof workspace === 'string' ? workspace : '', owner };
}

/**
 * Whether a window should write `next` over what is on file. Two tabs can
 * resume one conversation: while another live window holds the record, it
 * stays with that window, or the two would keep rewriting it.
 */
export function shouldWrite(old: Recoverable | undefined, next: Recoverable, ownerAlive: (owner: string) => boolean): boolean {
  if (!old) return true;
  if (old.owner !== next.owner && ownerAlive(old.owner)) return false;
  return JSON.stringify(old) !== JSON.stringify(next);
}

/**
 * What a record means right now:
 * - closed: it went down with its window, so it is offered for resuming;
 * - ending: it ended while this window lives, so it is forgotten after the wait;
 * - orphan: its window has gone but it still runs, so it is forgotten after
 *   the wait if it still runs then. Either it was resumed outside VS Code, or
 *   its window has only just gone and its signal is still on the way;
 * - keep: it is live, or another live window looks after it;
 * - drop: it is too old to offer.
 */
export type Verdict = 'closed' | 'ending' | 'orphan' | 'keep' | 'drop';

export function verdictOf(r: Recoverable, o: { live: boolean; me: string; ownerAlive: (owner: string) => boolean; now: number }): Verdict {
  if (r.owner === o.me) return o.live ? 'keep' : 'ending';
  if (o.ownerAlive(r.owner)) return 'keep';
  if (o.live) return 'orphan';
  return o.now - r.activeAt > KEEP_CLOSED_MS ? 'drop' : 'closed';
}

/** A verdict that ends with the record forgotten, once the wait is over. */
export const forgets = (v: Verdict): boolean => v === 'ending' || v === 'orphan';

/** The order to reopen in: each old window's tabs together, left to right. */
export function reopenOrder(rs: readonly Recoverable[]): Recoverable[] {
  return [...rs].sort((a, b) => a.owner.localeCompare(b.owner) || a.tab - b.tab || a.activeAt - b.activeAt);
}

/** The /bin/sh command that reopens a session. */
export function resumeCommand(claude: string, r: Pick<Recoverable, 'sessionId' | 'effort'>): string {
  const args = [shq(claude), '--resume', shq(r.sessionId)];
  if (r.effort && isEffort(r.effort)) args.push('--effort', r.effort);
  return args.join(' ');
}

/** What decides whether a session can come back in the tab at its old place. */
export interface RevivedTab {
  /** The tab's window has the workspace the session's had. */
  sameWorkspace: boolean;
  /** Someone has typed in it since VS Code brought it back, or its process has ended. */
  touched: boolean;
  /** It isn't a shell at its prompt: it runs something, it is some other program, or that couldn't be told. */
  busy: boolean;
}

/** Whether a process, as `ps -o comm=` names it, is a shell that can take a typed command. A login shell starts with "-". */
export function isShellCommand(comm: string): boolean {
  return /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|csh)$/.test(path.basename(comm.trim()));
}

export function canReuseTab(t: RevivedTab): boolean {
  return t.sameWorkspace && !t.touched && !t.busy;
}

/** What a revived tab's shell runs to bring a session back. The shell may have started in any folder. */
export function resumeScript(cwd: string, command: string): string {
  return inTabScript(`cd ${shq(cwd)} && ${command}`);
}

/** A closed session as the board draws it. */
export interface ClosedView {
  id: string;
  title: string;
  cwd: string;
  state: string;
  activeAt: number;
}

const WAS: Record<Status, string> = {
  busy: 'was working',
  waiting: 'was waiting on a prompt',
  idle: 'was idle',
  unknown: 'closed',
};

export function toClosedView(r: Recoverable, home: string): ClosedView {
  const underHome = home && (r.cwd === home || r.cwd.startsWith(home + path.sep));
  return { id: r.sessionId, title: r.title, cwd: underHome ? `~${r.cwd.slice(home.length)}` : r.cwd, state: WAS[r.status], activeAt: r.activeAt };
}

/** The pop-up after a restart. */
export function closedText(n: number): string {
  return n === 1 ? '1 Claude Code session closed with VS Code.' : `${n} Claude Code sessions closed with VS Code.`;
}

/** Names the pop-up for one set of closed sessions, so only one window shows it. */
export function offerClaim(rs: readonly Recoverable[]): string {
  return `closed-${rs.length}-${Math.max(0, ...rs.map((r) => r.activeAt))}`;
}
