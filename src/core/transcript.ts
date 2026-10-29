import type { Outcome } from './types';

/** A fact from a transcript, with where its line starts (later lines are newer). */
export interface At<T> {
  v: T;
  at: number;
}

/**
 * What the end of a session's transcript says. Each fact is the newest of
 * its kind found so far; a chunk read later (forwards) or earlier
 * (backwards) only replaces a fact with a newer one.
 */
export interface Digest {
  customTitle?: At<string>;
  aiTitle?: At<string>;
  /** Claude's newest reply text in the main conversation. */
  reply?: At<string>;
  /** The context size after the newest reply: input plus cache tokens. */
  tokens?: At<number>;
  /** The newest compaction, holding the context size before it. */
  compacted?: At<number>;
  /** Claude Code's own one-line recap, written while the user was away. */
  recap?: At<string>;
  /** The newest turn that ended badly. */
  stop?: At<{ why: 'error' | 'interrupted'; text?: string }>;
  /** The model of the newest reply, e.g. "claude-opus-5-5". */
  model?: At<string>;
}

type Fact = keyof Digest;
const FACTS: readonly Fact[] = ['customTitle', 'aiTitle', 'reply', 'tokens', 'compacted', 'recap', 'stop', 'model'];

/** Each fact from whichever digest saw it later. */
export function mergeDigest(a: Digest, b: Digest): Digest {
  const out: Digest = { ...a };
  for (const f of FACTS) {
    const x = b[f];
    const y = out[f];
    if (x && (!y || x.at > y.at)) (out as Record<Fact, unknown>)[f] = x;
  }
  return out;
}

/** Cheap tests that skip the many lines (tool output, attachments) that never matter. */
const WANTED = ['"type":"assistant"', '"type":"custom-title"', '"type":"ai-title"', '"subtype":"away_summary"', '"subtype":"compact_boundary"', 'Request interrupted by user'];

const INTERRUPTED = '[Request interrupted by user';

/**
 * Reads one chunk of a transcript (JSONL) that starts at byte `start` of the
 * file. The chunk may start or end mid-line; broken lines are skipped.
 */
export function readChunk(chunk: string, start: number, into: Digest = {}): Digest {
  const found: Digest = {};
  let pos = 0;
  for (const line of chunk.split('\n')) {
    // Character offsets never run ahead of byte offsets, so `at` keeps the file's order.
    const at = start + pos;
    pos += line.length + 1;
    if (!WANTED.some((w) => line.includes(w))) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.isSidechain === true) continue;
    readRecord(r, at, found);
  }
  return mergeDigest(into, found);
}

function readRecord(r: Record<string, unknown>, at: number, d: Digest): void {
  const set = <F extends Fact>(f: F, v: NonNullable<Digest[F]>['v']) => {
    (d as Record<Fact, unknown>)[f] = { v, at };
  };
  switch (r.type) {
    case 'custom-title':
      if (typeof r.customTitle === 'string' && r.customTitle.trim()) set('customTitle', r.customTitle.trim());
      return;
    case 'ai-title':
      if (typeof r.aiTitle === 'string' && r.aiTitle.trim()) set('aiTitle', r.aiTitle.trim());
      return;
    case 'system':
      if (r.subtype === 'away_summary' && typeof r.content === 'string' && r.content.trim()) set('recap', r.content.trim());
      if (r.subtype === 'compact_boundary') {
        const pre = (r.compactMetadata as Record<string, unknown> | undefined)?.preTokens;
        set('compacted', typeof pre === 'number' ? pre : 0);
      }
      return;
    case 'user':
      if (textOf(r.message).startsWith(INTERRUPTED)) set('stop', { why: 'interrupted' });
      return;
    case 'assistant': {
      const m = r.message as Record<string, unknown> | undefined;
      const text = textOf(m).trim();
      if (r.isApiErrorMessage === true) {
        set('stop', { why: 'error', text: text || undefined });
        return;
      }
      const tokens = tokensOf(m?.usage);
      if (tokens !== undefined) set('tokens', tokens);
      if (typeof m?.model === 'string' && m.model && m.model !== '<synthetic>') set('model', m.model);
      if (text) set('reply', text);
      return;
    }
  }
}

/** The text blocks of a message, joined. */
function textOf(message: unknown): string {
  const c = (message as Record<string, unknown> | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b): b is { type: 'text'; text: string } => !!b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

function tokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  return total > 0 ? total : undefined;
}

/** The context size now, or undefined when it is unknown (nothing yet, or compacted since). */
export function contextTokens(d: Digest): number | undefined {
  if (!d.tokens) return undefined;
  if (d.compacted && d.compacted.at > d.tokens.at) return undefined;
  return d.tokens.v;
}

/** Whether the newest thing in the transcript is a compaction. */
export function compactedSinceReply(d: Digest): boolean {
  return !!d.compacted && (!d.tokens || d.compacted.at > d.tokens.at);
}

/** Words that mean a reply hands the work over to a new session. */
const HANDOFF = /\bkick-?off\b|\bready-to-paste\b|\b(?:next|fresh) session\b|\bsession after\b/i;

/** The opening words of a line that asks the user to do or decide something. */
const ASKS = /^(?:reply|answer|tell me|let me know|say|pick|choose|confirm|shall i|should i|do you want|want me to|ok to)\b/i;

/**
 * Words anywhere in a line that say the work waits on the user: "the only
 * thing left is your OK", "waiting for your answer", "once you say go".
 */
const WAITS = /\b(?:waiting (?:for|on) (?:you|your)\b|(?:i need|needs|awaits|waits for|wait for) your\b|(?:left|missing|remaining|needed)\b[^.?!]{0,80}\b(?:is|are) your\b|once you (?:say|reply|answer|confirm|approve|decide|send|tell|choose|pick|look)\b|your (?:ok|okay|go-ahead|approval|answers?|reply|decision|confirmation|sign-off)\b(?! (?:earlier|above|before|was|is in|came))|over to you\b|paste (?:it|them|the \w+|your \w+) (?:back|here)\b)/i;

/** A recap that says nothing is waiting. */
const NOTHING_PENDING = /\b(?:nothing (?:is )?(?:pending|needed|left|waiting)|no action (?:is )?needed|nothing (?:else )?(?:needed )?from you|nothing for you)\b/i;

/** The words that begin the user's part in a recap's next step. */
const YOUR_STEP = /^(?:reply|answer|paste|run|press|open|take|choose|pick|review|check|confirm|approve|look|add|give|decide|tell|say|send|test|try|reload|click|tick|read|start)\b/i;

/**
 * How an idle session's last turn ended. `freshTokens` is the context size
 * from which it suggests a new session (0 turns that off). Claude Code's
 * recap, when it came after the reply, has the last word on what is next.
 */
export function outcomeOf(d: Digest, freshTokens: number): Outcome {
  if (d.stop && (!d.reply || d.stop.at > d.reply.at)) return { kind: 'stopped', why: d.stop.v.why, text: d.stop.v.text };
  if (!d.reply) return { kind: 'blank' };
  const reply = d.reply.v;
  const recap = d.recap && d.recap.at > d.reply.at ? d.recap.v : undefined;
  const handoff = HANDOFF.exec(reply);
  if (handoff) {
    const lineStart = reply.lastIndexOf('\n', handoff.index) + 1;
    const lineEnd = reply.indexOf('\n', handoff.index);
    const line = plain(reply.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)) || undefined;
    return { kind: 'handoff', reason: 'kickoff', prompt: kickoffPrompt(reply, handoff.index), line };
  }
  const next = recap ? nextStep(recap) : undefined;
  if (next && HANDOFF.test(next)) return { kind: 'handoff', reason: 'kickoff', line: next };
  // "Nothing is pending; next, say if you want more" is an offer, not an ask.
  const ask = askOf(reply) ?? (next && !NOTHING_PENDING.test(recap!) && yoursToDo(next) ? next : undefined);
  if (ask) return { kind: 'question', ask };
  const tokens = contextTokens(d);
  if (freshTokens > 0 && tokens !== undefined && tokens >= freshTokens) return { kind: 'handoff', reason: 'context' };
  return { kind: 'done' };
}

/**
 * The ready-to-paste prompt after the hand-over words: the first fenced
 * block, else the first run of quoted (`>`) lines.
 */
export function kickoffPrompt(reply: string, from = 0): string | undefined {
  const rest = reply.slice(from);
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/m.exec(rest);
  const quoted = /(?:^[ \t]*>.*(?:\n|$))+/m.exec(rest);
  const first = fence && (!quoted || fence.index <= quoted.index) ? fence[2] : quoted?.[0].replace(/^[ \t]*> ?/gm, '');
  const text = first?.trim();
  return text && text.length >= 10 ? text : undefined;
}

/** The line of a reply's last few that asks the user something, or waits on them, as plain text. */
export function askOf(reply: string): string | undefined {
  const lines = proseLines(reply, 3).reverse();
  return lines.find((l) => /\?["'”’)*_]*$/.test(l) || ASKS.test(l) || WAITS.test(l));
}

/**
 * A recap's last step: what follows "Next," or "Next:", else its last
 * sentence. Claude Code's own "(disable recaps in /config)" hint is dropped.
 */
export function nextStep(recap: string): string | undefined {
  const text = recap.replace(/\s*\(disable recaps in \/config\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const m = /\bnext(?: step)?(?: is)?\s*[,:：—–-]\s*(.+)$/i.exec(text);
  if (m) return m[1].trim();
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"“])/);
  return sentences[sentences.length - 1];
}

/** Whether a recap's next step is the user's to take, not Claude's. */
export function yoursToDo(next: string): boolean {
  if (NOTHING_PENDING.test(next)) return false;
  if (WAITS.test(next) || /\b(?:tell me|let me know|say (?:go|yes|if|which))\b/i.test(next)) return true;
  // "I'll push…", "Once it merges, I rebase…": Claude's own step.
  if (/^(?:i|i'll|i'm|we|we'll)\b/i.test(next) || /^(?:once|when|after)\b[^,]*,\s*i\b/i.test(next)) return false;
  return YOUR_STEP.test(next);
}

const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm;

/** A reply's lines (the last `last` of them) as plain text, without code blocks, tables or blank lines. */
function proseLines(md: string, last = Infinity): string[] {
  const raw = md
    .replace(FENCED, '')
    .split('\n')
    .filter((l) => l.trim() && !/^\s*\|/.test(l));
  return raw.slice(-Math.min(last, raw.length)).map(plain).filter(Boolean);
}

/** Emphasis is only looked for in lines up to this long: the pattern gets slow on longer ones. */
const MAX_EMPHASIS_LINE = 4000;

/** One line of markdown as plain text, never cut short. Emphasis goes first, so it can't hide a link. */
export function plain(line: string): string {
  const bare = line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)*/, '');
  return (bare.length > MAX_EMPHASIS_LINE ? bare : bare.replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2'))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words a card shows under its title, in full: Claude Code's recap when
 * it is newer than the reply, else the reply's first paragraph.
 */
export function gist(d: Digest): string | undefined {
  const recap = d.recap && (!d.reply || d.recap.at > d.reply.at) ? d.recap.v : undefined;
  return recap ?? (d.reply ? firstParagraph(d.reply.v) : undefined);
}

/** The first paragraph that is more than headings, as one line of plain text. */
function firstParagraph(md: string): string | undefined {
  for (const p of md.replace(FENCED, '').split(/\n\s*\n/)) {
    if (p.split('\n').every((l) => !l.trim() || /^\s*#{1,6}\s/.test(l))) continue;
    const text = proseLines(p).join(' ');
    if (text) return text;
  }
  return undefined;
}
