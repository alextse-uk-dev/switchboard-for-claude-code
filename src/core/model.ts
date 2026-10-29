import { keyOf, type Group, type Outcome, type Session, type Status } from './types';

export interface SessionEvent {
  type: 'needs' | 'finished';
  session: Session;
  /** For "finished": how long the turn ran, from leaving idle to idle again. */
  turnMs?: number;
}

interface Seen {
  status: Status;
  changedAt: number;
  turnStart?: number;
}

/**
 * Remembers each session's last status, so that a fresh list can be turned
 * into "started needing you" and "finished a turn" events.
 */
export class Tracker {
  private last = new Map<string, Seen>();

  /** When the session's status last changed, as best known. Takes a `keyOf` key. */
  changedAt(key: string): number | undefined {
    return this.last.get(key)?.changedAt;
  }

  /**
   * Feeds one complete session list. Returns the events since the previous
   * list, and the sessions seen for the first time (which never raise events:
   * a reload must not replay old prompts).
   */
  update(sessions: readonly Session[], now: number): { events: SessionEvent[]; fresh: Session[] } {
    const events: SessionEvent[] = [];
    const fresh: Session[] = [];
    const next = new Map<string, Seen>();
    for (const s of sessions) {
      const key = keyOf(s);
      const prev = this.last.get(key);
      const at = s.statusUpdatedAt ?? (prev && prev.status === s.status ? prev.changedAt : now);
      let turnStart = prev?.turnStart;
      if (!prev) {
        fresh.push(s);
        turnStart = s.status === 'busy' || s.status === 'waiting' ? at : undefined;
      } else {
        if ((s.status === 'busy' || s.status === 'waiting') && (prev.status === 'idle' || prev.status === 'unknown')) {
          turnStart = at;
        }
        if (s.status === 'waiting' && (prev.status !== 'waiting' || at !== prev.changedAt)) {
          events.push({ type: 'needs', session: s });
        }
        if (s.status === 'idle' && (prev.status === 'busy' || prev.status === 'waiting')) {
          events.push({ type: 'finished', session: s, turnMs: turnStart === undefined ? undefined : at - turnStart });
        }
      }
      if (s.status === 'idle') turnStart = undefined;
      next.set(key, { status: s.status, changedAt: at, turnStart });
    }
    this.last = next;
    return { events, fresh };
  }
}

const GROUP_OF_OUTCOME: Record<Outcome['kind'], Group> = {
  done: 'done',
  question: 'reply',
  handoff: 'handoff',
  stopped: 'stopped',
  blank: 'idle',
};

/**
 * Which board section a session belongs to. An idle session goes where its
 * last turn's outcome says; one whose transcript can't be read is "idle".
 */
export function groupOf(s: Session, outcome: Outcome | undefined): Group {
  if (s.status === 'waiting') return 'needs';
  if (s.status === 'busy') return 'working';
  if (s.status === 'idle' && outcome) return GROUP_OF_OUTCOME[outcome.kind];
  return 'idle';
}

/**
 * Whether an idle session's last turn ended after the user last looked at
 * it. `seenAt` is undefined only for a session never met, which never counts.
 */
export function isUnread(s: Session, changedAt: number | undefined, seenAt: number | undefined): boolean {
  return s.status === 'idle' && seenAt !== undefined && changedAt !== undefined && changedAt > seenAt;
}

export interface PopContext {
  needsOn: boolean;
  finishedOn: boolean;
  finishedMinMs: number;
  /** The user is looking at this session's tab right now. */
  lookingAt: boolean;
  /** The session runs in a terminal tab of this VS Code window. */
  ownedHere: boolean;
  /** Another live VS Code window has said the session is in one of its tabs. */
  ownedElsewhere: boolean;
  /** No other live VS Code window has been focused more recently than this one. */
  lastFocused: boolean;
}

/**
 * Whether this window should pop up for an event. Exactly one window should:
 * the one holding the tab, or for a session in no window, the one focused
 * last (VS Code keeps the pop-up until the user comes back to it).
 */
export function shouldPop(e: SessionEvent, c: PopContext): boolean {
  if (e.type === 'needs' && !c.needsOn) return false;
  if (e.type === 'finished' && (!c.finishedOn || (e.turnMs ?? 0) < c.finishedMinMs)) return false;
  if (c.lookingAt) return false;
  if (c.ownedHere) return true;
  if (c.ownedElsewhere) return false;
  return c.lastFocused;
}

const WAITING_LABEL: Record<string, string> = {
  'input needed': 'asks a question',
  'dialog open': 'waiting on a prompt',
  'sandbox request': 'asks for network access',
  'worker request': 'a helper asks for approval',
  'goal proposal': 'proposes a goal',
};

/** A short phrase for why a session waits. */
export function waitingLabel(waitingFor: string | undefined): string {
  if (!waitingFor) return 'waiting for you';
  return WAITING_LABEL[waitingFor] ?? waitingFor;
}

/** "just now", "4 min", "1 h 5 min", "2 d". */
export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (ms < 45_000) return 'just now';
  if (min < 1) return '1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Sort order inside a group: the longest wait first for "needs you", the newest change first elsewhere. */
export function compareInGroup(group: Group, a: number, b: number): number {
  return group === 'needs' ? a - b : b - a;
}

/**
 * "1 needs you · 2 finished" (finished: idle turns not looked at yet), or how
 * many are working or idle when nothing does.
 */
export function counterText(counts: Readonly<Record<Group, number>>, unread: number): string {
  const parts: string[] = [];
  if (counts.needs) parts.push(`${counts.needs} need${counts.needs === 1 ? 's' : ''} you`);
  if (unread) parts.push(`${unread} finished`);
  if (parts.length) return parts.join(' · ');
  if (counts.working) return `${counts.working} working`;
  const rest = counts.reply + counts.handoff + counts.stopped + counts.done + counts.idle;
  return rest ? `${rest} idle` : '';
}

/** "182k" for a context size. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Breaks markdown link syntax. VS Code notifications turn `[x](command:…)`
 * into a link that runs the command, and titles, questions and errors come
 * from transcripts.
 */
export function noLinks(text: string): string {
  return text.replace(/\]\s*\(/g, ']\u200b(');
}

/** The words a pop-up says about an event, given how the turn ended. Safe to show: links are broken. */
export function popText(e: SessionEvent, title: string, outcome: Outcome | undefined): string {
  return noLinks(popWords(e, title, outcome));
}

function popWords(e: SessionEvent, title: string, outcome: Outcome | undefined): string {
  if (e.type === 'needs') return `${title} needs you (${waitingLabel(e.session.waitingFor)}).`;
  const after = e.turnMs ? ` after ${formatAge(e.turnMs)}` : '';
  switch (outcome?.kind) {
    case 'question':
      return `${title} is waiting for your reply: "${outcome.ask}"`;
    case 'handoff':
      return outcome.reason === 'kickoff'
        ? `${title} finished${after} and wrote a kickoff prompt for a new session.`
        : `${title} finished${after}. Its context is large, so start a new session next.`;
    case 'stopped':
      return outcome.why === 'error' ? `${title} stopped on an error${outcome.text ? `: ${outcome.text}` : '.'}` : `${title} was interrupted.`;
    default:
      return `${title} finished${after}.`;
  }
}
