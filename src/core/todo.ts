import { createHash } from 'node:crypto';
import { plain } from './transcript';

/** One thing for the user to do. */
export interface Todo {
  id: string;
  text: string;
  /** Picked up from what Claude asked of you, or written by you. */
  from: 'claude' | 'you';
  /** The session it came from or belongs to. */
  sessionId?: string;
  /** That session's title when the item was added, so it still reads after the session ends. */
  session?: string;
  createdAt: number;
  doneAt?: number;
  /**
   * Deleted. The item stays as a marker for a while, so an ask that is still
   * in the session's last reply isn't picked up again.
   */
  deletedAt?: number;
}

/** Done and deleted items are dropped after this long. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Longer text is not a to-do but a pasted document. A long kickoff prompt still fits. */
export const MAX_TODO = 10_000;

/** A line that hands something to the user: "**Needs you:** …", "**You:** …", "Over to you: …". */
const LABELLED = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?(?:\*\*|__)?(needs you|over to you|your turn|for you|action for you|waiting on you|you)(?:\*\*|__)?[ \t]*[:：](?:\*\*|__)?[ \t]*(.*)$/i;
/** These labels count without bold; a bare "You:" needs it ("**You:**"). */
const PLAIN_OK = /^(?:needs you|over to you|your turn|action for you|waiting on you)$/i;
/** A heading over a list of the user's steps. */
const HEADING = /\b(?:needs you|for you to do|your to-?dos?|your (?:turn|move|steps|actions?)|what you need to do|over to you|waiting on you|next steps for you)\b/i;
/** "Nothing.", "None right now.", "Nothing — CI is green.": no ask. */
const NOTHING = /^(?:(?:nothing|none|n\/a|no action)\b|[-—–]+\s*$)/i;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/;

/**
 * The things a reply asks the user to do, as plain text: lines labelled
 * "Needs you:" (or "**You:**"), and the list under a heading such as
 * "Needs you" or "Your steps". Code blocks and tables are skipped.
 */
export function asksOf(reply: string): string[] {
  const out: string[] = [];
  const lines = reply.split('\n');
  let fence: string | undefined;
  let under: 'list' | undefined;
  /** The indent of the list's first item; deeper items are details of the one above. */
  let indent: number | undefined;
  let gap = false;
  for (const line of lines) {
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1];
      under = undefined;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      under = undefined;
      continue;
    }
    if (!line.trim()) {
      gap = true;
      continue;
    }
    const labelled = LABELLED.exec(line);
    if (labelled && (PLAIN_OK.test(labelled[1]) || /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)/.test(line))) {
      const rest = plain(labelled[2]);
      if (rest && !NOTHING.test(rest)) out.push(rest);
      // "**Needs you:**" with nothing after it heads a list.
      under = rest ? undefined : 'list';
      indent = undefined;
      gap = false;
      continue;
    }
    const isHeading = /^\s*#{1,6}\s/.test(line) || /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)[:：]?\s*$/.test(line);
    if (isHeading) {
      under = HEADING.test(plain(line)) ? 'list' : undefined;
      indent = undefined;
      gap = false;
      continue;
    }
    if (under === 'list') {
      if (LIST_ITEM.test(line)) {
        const at = /^[ \t]*/.exec(line)![0].length;
        indent ??= at;
        const text = plain(line);
        if (at <= indent && text && !NOTHING.test(text)) out.push(text);
        gap = false;
        continue;
      }
      // A wrapped line of the item above, or the paragraph that ends the list.
      if (/^\s{2,}\S/.test(line) && !gap && out.length) continue;
      under = undefined;
    }
    gap = false;
  }
  return [...new Set(out)].filter((t) => t.length <= MAX_TODO);
}

/** The same ask from the same session always gets the same id. */
export function askId(sessionId: string, text: string): string {
  return `c-${createHash('sha1').update(`${sessionId}\n${text.toLowerCase()}`).digest('hex').slice(0, 16)}`;
}

export interface Ask {
  sessionId: string;
  session: string;
  text: string;
}

/** Adds the asks not seen before (done and deleted ones count as seen). Returns undefined if nothing is new. */
export function mergeAsks(list: readonly Todo[], asks: readonly Ask[], now: number): Todo[] | undefined {
  const ids = new Set(list.map((t) => t.id));
  const added: Todo[] = [];
  for (const a of asks) {
    const id = askId(a.sessionId, a.text);
    if (ids.has(id)) continue;
    ids.add(id);
    added.push({ id, text: a.text, from: 'claude', sessionId: a.sessionId, session: a.session, createdAt: now });
  }
  return added.length ? [...list, ...added] : undefined;
}

/** What the user can do to the list. */
export type TodoOp =
  | { op: 'add'; id: string; text: string; sessionId?: string; session?: string }
  | { op: 'done'; id: string; done: boolean }
  | { op: 'delete'; id: string }
  | { op: 'clearDone' };

/** Applies one change. Returns undefined when it changes nothing. */
export function applyOp(list: readonly Todo[], o: TodoOp, now: number): Todo[] | undefined {
  switch (o.op) {
    case 'add': {
      const text = o.text.trim().replace(/\s+/g, ' ');
      if (!text || text.length > MAX_TODO || list.some((t) => t.id === o.id)) return undefined;
      return [...list, { id: o.id, text, from: 'you', sessionId: o.sessionId, session: o.session, createdAt: now }];
    }
    case 'done': {
      const t = list.find((x) => x.id === o.id && !x.deletedAt);
      if (!t || !!t.doneAt === o.done) return undefined;
      return list.map((x) => (x === t ? { ...x, doneAt: o.done ? now : undefined } : x));
    }
    case 'delete': {
      const t = list.find((x) => x.id === o.id && !x.deletedAt);
      if (!t) return undefined;
      // The user's own items can simply go; an ask is kept as a marker.
      if (t.from === 'you') return list.filter((x) => x !== t);
      return list.map((x) => (x === t ? { ...x, deletedAt: now } : x));
    }
    case 'clearDone': {
      if (!list.some((x) => x.doneAt && !x.deletedAt)) return undefined;
      return list.flatMap((x) => (x.doneAt && !x.deletedAt ? (x.from === 'you' ? [] : [{ ...x, deletedAt: now }]) : [x]));
    }
  }
}

/** Drops items done or deleted long ago. */
export function prune(list: readonly Todo[], now: number): Todo[] {
  return list.filter((t) => {
    const ended = t.deletedAt ?? t.doneAt;
    return ended === undefined || now - ended <= KEEP_MS;
  });
}

/** Reads the stored list, keeping only well-formed items. */
export function parseTodos(json: string): Todo[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return items.flatMap((r): Todo[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const id = str(o.id);
    const text = str(o.text);
    const createdAt = num(o.createdAt);
    if (!id || !text || createdAt === undefined || (o.from !== 'claude' && o.from !== 'you')) return [];
    const t: Todo = { id, text, from: o.from, createdAt };
    const sessionId = str(o.sessionId);
    const session = str(o.session);
    const doneAt = num(o.doneAt);
    const deletedAt = num(o.deletedAt);
    if (sessionId) t.sessionId = sessionId;
    if (session) t.session = session;
    if (doneAt !== undefined) t.doneAt = doneAt;
    if (deletedAt !== undefined) t.deletedAt = deletedAt;
    return [t];
  });
}

export function serializeTodos(list: readonly Todo[]): string {
  return `${JSON.stringify({ v: 1, items: list }, null, 1)}\n`;
}
