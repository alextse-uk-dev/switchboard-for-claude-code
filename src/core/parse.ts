import type { Kind, Session, Status, Titles } from './types';

const STATUSES: ReadonlySet<string> = new Set(['busy', 'waiting', 'idle']);

function kindOf(v: unknown): Kind | undefined {
  if (v === 'interactive') return 'interactive';
  if (v === 'bg' || v === 'background') return 'background';
  return undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Reads one record from `claude agents --json` or from a `sessions/<pid>.json`
 * file. Returns undefined for anything that is not a user-facing session.
 */
export function toSession(o: unknown): Session | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  const pid = num(r.pid);
  const sessionId = str(r.sessionId);
  const cwd = str(r.cwd);
  const kind = kindOf(r.kind);
  if (pid === undefined || !sessionId || !cwd || !kind || r.spare === true) return undefined;
  const status: Status = typeof r.status === 'string' && STATUSES.has(r.status) ? (r.status as Status) : 'unknown';
  return {
    pid,
    sessionId,
    cwd,
    kind,
    attachId: kind === 'background' ? (str(r.id) ?? str(r.jobId)) : undefined,
    name: str(r.name) ?? sessionId.slice(0, 8),
    nameSource: str(r.nameSource),
    status,
    waitingFor: status === 'waiting' ? str(r.waitingFor) : undefined,
    startedAt: num(r.startedAt) ?? 0,
    statusUpdatedAt: num(r.statusUpdatedAt),
  };
}

/** Parses the output of `claude agents --json`. Throws if it is not a JSON array. */
export function parseAgentsJson(text: string): Session[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('claude agents --json did not print an array');
  return data.map(toSession).filter((s): s is Session => s !== undefined);
}

/**
 * Lays a session's own status file over its entry in the CLI list. The file
 * is written the moment the status changes, so its status and its
 * `statusUpdatedAt` are the freshest; the CLI decides which sessions exist.
 */
export function withFileFields(s: Session, file: Session | undefined): Session {
  if (!file || file.sessionId !== s.sessionId) return s;
  return {
    ...s,
    attachId: s.attachId ?? (s.kind === 'background' ? file.attachId : undefined),
    nameSource: file.nameSource ?? s.nameSource,
    status: file.status,
    waitingFor: file.waitingFor,
    statusUpdatedAt: file.statusUpdatedAt,
  };
}

const CUSTOM = '"type":"custom-title"';
const AI = '"type":"ai-title"';

/**
 * Finds the newest title records in a chunk of a session transcript (JSONL).
 * The chunk may start or end mid-line; broken lines are skipped.
 */
export function parseTitles(chunk: string, into: Titles = {}): Titles {
  const out: Titles = { ...into };
  for (const line of chunk.split('\n')) {
    const isCustom = line.includes(CUSTOM);
    if (!isCustom && !line.includes(AI)) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (isCustom && typeof r.customTitle === 'string' && r.customTitle.trim()) out.customTitle = r.customTitle.trim();
      else if (!isCustom && typeof r.aiTitle === 'string' && r.aiTitle.trim()) out.aiTitle = r.aiTitle.trim();
    } catch {
      // A line cut by the chunk edge.
    }
  }
  return out;
}

/** The name a person would recognise: a title they set, the name they chose, then Claude's own title. */
export function displayTitle(s: Session, t: Titles | undefined): string {
  if (t?.customTitle) return t.customTitle;
  if (s.nameSource === 'user' || s.nameSource === 'peer') return s.name;
  return t?.aiTitle ?? s.name;
}

/** Claude Code's transcript folder name for a working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Parses `ps -A -o pid=,ppid=` into a child → parent map. */
export function parsePs(text: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) parents.set(Number(m[1]), Number(m[2]));
  }
  return parents;
}

/** The pid itself and up to `depth` of its ancestors, nearest first. */
export function lineage(pid: number, parents: ReadonlyMap<number, number>, depth = 4): number[] {
  const out = [pid];
  let cur = pid;
  for (let i = 0; i < depth; i++) {
    const p = parents.get(cur);
    if (p === undefined || p <= 1) break;
    out.push(p);
    cur = p;
  }
  return out;
}
