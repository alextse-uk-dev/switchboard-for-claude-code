import type { Group, Session } from './types';

/**
 * A job card: what a session is working on, as some other tool describes
 * it in `<sessionId>.json` in the job-cards folder. Switchboard only reads
 * these; any tool may write them. Every field is optional.
 */
export interface JobCard {
  program?: string;
  role?: string;
  goal?: string;
  step?: number;
  of?: number;
  next?: string;
  blockedOn?: string;
  /** What the session waits on the user for. */
  needsYou: string[];
  eta?: string;
  helpers: JobHelper[];
  /** When the writer last updated it, in ms since the epoch (else the file's own time). */
  updatedAt?: number;
}

export interface JobHelper {
  id?: string;
  name?: string;
  task?: string;
  state?: string;
}

/** A card not updated for this long shows dimmed, marked stale. */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** Helpers listed on a card before "+N more". */
export const MAX_HELPERS = 3;
/** Longer text is cut; a job card is a summary, not a document. */
const MAX_TEXT = 2000;
const MAX_ITEMS = 50;

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t) : undefined;
};
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/**
 * Reads a job card's JSON. Anything it doesn't know, or of the wrong type,
 * is ignored; text that isn't a JSON object gives undefined. `fileTime` (the
 * file's modified time) stands in for a missing or unreadable `updatedAt`.
 */
export function parseJobCard(json: string, fileTime?: number): JobCard | undefined {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const o = data as Record<string, unknown>;
  const card: JobCard = { needsYou: [], helpers: [] };
  for (const k of ['program', 'role', 'goal', 'next', 'blockedOn', 'eta'] as const) {
    const t = text(o[k]);
    if (t) card[k] = t;
  }
  const step = count(o.step);
  const of = count(o.of);
  if (step !== undefined) card.step = step;
  if (of !== undefined && of > 0) card.of = of;
  if (Array.isArray(o.needsYou)) card.needsYou = [...new Set(o.needsYou.map(text).filter((t): t is string => !!t))].slice(0, MAX_ITEMS);
  else if (text(o.needsYou)) card.needsYou = [text(o.needsYou)!];
  if (Array.isArray(o.helpers)) {
    card.helpers = o.helpers.slice(0, MAX_ITEMS).flatMap((h): JobHelper[] => {
      if (!h || typeof h !== 'object') return [];
      const r = h as Record<string, unknown>;
      const out: JobHelper = {};
      const id = typeof r.id === 'number' ? String(r.id) : text(r.id);
      if (id) out.id = id;
      for (const k of ['name', 'task', 'state'] as const) {
        const t = text(r[k]);
        if (t) out[k] = t;
      }
      return out.id || out.name || out.task ? [out] : [];
    });
  }
  const at = typeof o.updatedAt === 'string' || typeof o.updatedAt === 'number' ? new Date(o.updatedAt).getTime() : NaN;
  if (Number.isFinite(at)) card.updatedAt = at;
  else if (fileTime !== undefined) card.updatedAt = fileTime;
  return card;
}

/** "billing-rewrite · step 2 of 7 · next: run the migration on staging". Empty if the card says none of it. */
export function jobLine(c: JobCard): string {
  const parts: string[] = [];
  const name = c.program ?? c.goal;
  if (name) parts.push(name);
  if (c.step !== undefined) parts.push(c.of ? `step ${c.step} of ${c.of}` : `step ${c.step}`);
  if (c.next) parts.push(`next: ${c.next}`);
  return parts.join(' · ');
}

/** One line per helper, at most MAX_HELPERS, then "+N more". */
export function helperLines(c: JobCard): string[] {
  const out = c.helpers.slice(0, MAX_HELPERS).map((h) => `↳ ${helperText(h)}`);
  const more = c.helpers.length - MAX_HELPERS;
  if (more > 0) out.push(`+${more} more`);
  return out;
}

/** "reviewer: review the migration diff (running)". */
function helperText(h: JobHelper): string {
  return `${h.name ?? h.id ?? 'helper'}${h.task ? `: ${h.task}` : ''}${h.state ? ` (${h.state})` : ''}`;
}

/** Not updated for a day or more. A card with no time at all counts as fresh. */
export function isStale(c: JobCard, now: number): boolean {
  return c.updatedAt !== undefined && now - c.updatedAt >= STALE_MS;
}

/** The whole card, for the line's tooltip. */
export function jobTip(c: JobCard, now: number): string[] {
  const out: string[] = [];
  if (c.program) out.push(`Program: ${c.program}${c.role ? ` (${c.role})` : ''}`);
  else if (c.role) out.push(`Role: ${c.role}`);
  if (c.goal) out.push(`Goal: ${c.goal}`);
  if (c.step !== undefined) out.push(`Step: ${c.step}${c.of ? ` of ${c.of}` : ''}`);
  if (c.next) out.push(`Next: ${c.next}`);
  if (c.blockedOn) out.push(`Blocked on: ${c.blockedOn}`);
  for (const n of c.needsYou) out.push(`Needs you: ${n}`);
  if (c.eta) out.push(`ETA: ${c.eta}`);
  for (const h of c.helpers) out.push(`Helper ${helperText(h)}`);
  if (c.updatedAt !== undefined) out.push(`Updated ${new Date(c.updatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}${isStale(c, now) ? ' (stale)' : ''}`);
  out.push('From the job card a tool wrote for this session.');
  return out;
}

/** The chips a job card adds to its session's card. */
export function jobChips(c: JobCard): string[] {
  const out: string[] = [];
  if (c.blockedOn) out.push('blocked');
  if (c.needsYou.length) out.push('needs you');
  return out;
}

/**
 * The section a session shows in, given its job card. An idle session whose
 * card waits on the user moves to "Needs you", even if its last reply asked
 * nothing. A working session stays under Working (its chip says it), since
 * it is still busy and will say more when its turn ends.
 */
export function groupWithJob(group: Group, s: Pick<Session, 'status'>, c: JobCard | undefined): Group {
  if (c?.needsYou.length && s.status === 'idle') return 'needs';
  return group;
}

/** A session id as Claude Code writes it, safe to use as a file name. */
export function jobCardFile(sessionId: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(sessionId) ? `${sessionId}.json` : undefined;
}
