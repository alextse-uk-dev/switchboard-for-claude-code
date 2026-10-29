export type Status = 'busy' | 'waiting' | 'idle' | 'unknown';
export type Kind = 'interactive' | 'background';

/** One live Claude Code session, as Claude Code itself reports it. */
export interface Session {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: Kind;
  /** The short id `claude attach` takes (background sessions only). */
  attachId?: string;
  /** Claude Code's session name, e.g. "my-repo-12" or one the user chose. */
  name: string;
  /** "user" or "peer" when someone chose the name; "auto", "derived" or "collision" otherwise. */
  nameSource?: string;
  status: Status;
  /** Why a waiting session waits, e.g. "input needed". */
  waitingFor?: string;
  startedAt: number;
  /** When `status` last changed, in ms since the epoch. */
  statusUpdatedAt?: number;
}

/**
 * One running process. Two tabs can resume the same conversation, so the
 * session id alone is not unique.
 */
export function keyOf(s: Pick<Session, 'pid' | 'sessionId'>): string {
  return `${s.pid}:${s.sessionId}`;
}

/**
 * The board's sections, in the order they show. Every idle session lands in
 * the one that says what to do with it next.
 */
export type Group = 'needs' | 'reply' | 'handoff' | 'stopped' | 'done' | 'working' | 'idle';

export const GROUP_ORDER: readonly Group[] = ['needs', 'reply', 'handoff', 'stopped', 'done', 'working', 'idle'];

export const GROUP_LABEL: Record<Group, string> = {
  needs: 'Needs you',
  reply: 'Waiting for your reply',
  handoff: 'Start a new session',
  stopped: 'Stopped',
  done: 'Done',
  working: 'Working',
  idle: 'Idle',
};

/**
 * How an idle session's last turn ended, read from its transcript:
 * - done: a normal final reply;
 * - question: the reply ends by asking the user something;
 * - handoff: the reply hands over to a new session (a kickoff prompt), or the
 *   context has grown past the new-session line. `earlier` marks a prompt
 *   taken from an earlier reply, because the newest one gave none;
 * - stopped: an API error, or the user interrupted it;
 * - blank: nothing has been said yet.
 */
export type Outcome =
  | { kind: 'done' }
  | { kind: 'question'; ask: string }
  | { kind: 'handoff'; reason: 'kickoff' | 'context'; prompt?: string; line?: string; earlier?: true }
  | { kind: 'stopped'; why: 'error' | 'interrupted'; text?: string }
  | { kind: 'blank' };
