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

export type Group = 'needs' | 'finished' | 'working' | 'idle' | 'background';

export const GROUP_ORDER: readonly Group[] = ['needs', 'finished', 'working', 'idle', 'background'];

export const GROUP_LABEL: Record<Group, string> = {
  needs: 'Needs you',
  finished: 'Finished',
  working: 'Working',
  idle: 'Idle',
  background: 'Background',
};

export interface Titles {
  customTitle?: string;
  aiTitle?: string;
}
