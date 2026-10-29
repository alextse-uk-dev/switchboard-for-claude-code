import { keyOf, type Group, type Session, type Status } from './types';

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

/**
 * Which sidebar group a session belongs to. `seenAt` is when the user last
 * looked at the session; an idle session that changed after that is
 * "finished". Background sessions sit in their own group unless they need
 * the user or have finished.
 */
export function groupOf(s: Session, changedAt: number | undefined, seenAt: number | undefined): Group {
  if (s.status === 'waiting') return 'needs';
  if (s.status === 'idle' && seenAt !== undefined && changedAt !== undefined && changedAt > seenAt) return 'finished';
  if (s.kind === 'background') return 'background';
  return s.status === 'busy' ? 'working' : 'idle';
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

/** "1 needs you · 2 finished", or how many are working or idle when nothing needs the user. */
export function counterText(counts: Readonly<Record<Group, number>>): string {
  const parts: string[] = [];
  if (counts.needs) parts.push(`${counts.needs} need${counts.needs === 1 ? 's' : ''} you`);
  if (counts.finished) parts.push(`${counts.finished} finished`);
  if (parts.length) return parts.join(' · ');
  if (counts.working) return `${counts.working} working`;
  const rest = counts.idle + counts.background;
  return rest ? `${rest} idle` : '';
}
