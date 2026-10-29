import * as path from 'node:path';
import { formatUsd, modelName, type Tally } from './cost';
import { formatTokens, waitingLabel } from './model';
import { compactedSinceReply, contextTokens, gist, type Digest } from './transcript';
import { keyOf, type Group, type Outcome, type Session } from './types';

/** Where a session's terminal is, seen from this window. */
export type Where = 'here' | 'elsewhere' | 'outside' | 'nested';

/** One card on the board: plain data, sent to the webview as it is. */
export interface Card {
  key: string;
  title: string;
  group: Group;
  /** An idle turn that ended after the user last looked. */
  unread: boolean;
  folder: string;
  cwd: string;
  /** A few words in the section's colour: "asks a question", "done". */
  state: string;
  /** The line under the title: the question, the recap, the error. */
  detail?: string;
  /** The detail is Claude's own words. */
  quote: boolean;
  /** The detail is long enough to start folded, with Show more. */
  fold: boolean;
  changedAt?: number;
  /** "other window", "background", … */
  chips: string[];
  tokens?: number;
  /** The context size from which a new session is suggested (0: never). */
  freshTokens: number;
  compacted: boolean;
  /** A kickoff prompt was found, so it can be copied or started. */
  prompt: boolean;
  /** What the session's tokens would cost at API prices, e.g. "$12.40". */
  cost?: string;
  /** The cost's breakdown, for its tooltip. */
  costTip: string[];
  /** The newest reply's model, e.g. "Opus 5.5". */
  model?: string;
  /** The newest reply's effort, e.g. "xhigh". */
  effort?: string;
  /** Claude's whole last reply (markdown), when it says more than the detail line. */
  reply?: string;
  /** Lines for the hover tooltip. */
  tip: string[];
}

export interface CardInput {
  s: Session;
  title: string;
  group: Group;
  outcome?: Outcome;
  digest?: Digest;
  changedAt?: number;
  unread: boolean;
  where: Where;
  freshTokens: number;
  home: string;
  /** Token totals for the session and its helper agents. */
  tally?: Tally;
  /** How many helper agents (subagents) the session has run. */
  helpers?: number;
  /** Show the cost (default true). */
  showCost?: boolean;
}

function stateWords(c: CardInput, tokens: number | undefined): string {
  const o = c.outcome;
  switch (c.group) {
    case 'needs':
      return waitingLabel(c.s.waitingFor);
    case 'reply':
      return 'asks you';
    case 'handoff':
      if (o?.kind === 'handoff' && o.reason === 'context' && !o.prompt) return tokens ? `context ${formatTokens(tokens)}` : 'context is large';
      if (o?.kind === 'handoff' && o.prompt) return o.earlier ? 'earlier kickoff prompt' : 'kickoff prompt ready';
      return 'suggests a new session';
    case 'stopped':
      return o?.kind === 'stopped' && o.why === 'interrupted' ? 'interrupted' : 'API error';
    case 'done':
      return 'done';
    case 'working':
      return 'working';
    default:
      if (c.s.status === 'unknown') return 'status unknown';
      return o?.kind === 'blank' ? 'no messages yet' : 'idle';
  }
}

function detailOf(c: CardInput): { detail?: string; quote: boolean } {
  const o = c.outcome;
  if (c.group === 'reply' && o?.kind === 'question') return { detail: o.ask, quote: true };
  if (c.group === 'stopped' && o?.kind === 'stopped' && o.text) return { detail: o.text, quote: false };
  // A hand-over card shows what it went by: the prompt it would send, else the words that matched.
  if (c.group === 'handoff' && o?.kind === 'handoff' && (o.prompt || o.reason === 'kickoff')) return { detail: o.prompt ?? o.line, quote: true };
  const g = c.digest ? gist(c.digest) : undefined;
  return { detail: g, quote: false };
}

function chipsOf(c: CardInput): string[] {
  const out: string[] = [];
  if (c.s.kind === 'background') out.push('background');
  if (c.where === 'nested') out.push('inside another session');
  else if (c.where === 'elsewhere') out.push('other window');
  else if (c.where === 'outside' && c.s.kind !== 'background') out.push('outside VS Code');
  return out;
}

/** Builds one card from what the extension knows about a session. */
export function toCard(c: CardInput): Card {
  const tokens = c.digest ? contextTokens(c.digest) : undefined;
  const { detail, quote } = detailOf(c);
  const folder = path.basename(c.s.cwd) || c.s.cwd;
  const underHome = c.home && (c.s.cwd === c.home || c.s.cwd.startsWith(c.home + path.sep));
  const cwd = underHome ? `~${c.s.cwd.slice(c.home.length)}` : c.s.cwd;
  const tip = [cwd, `Session ${c.s.name} · ${c.s.sessionId.slice(0, 8)} · pid ${c.s.pid}`];
  if (tokens !== undefined) tip.push(`Context: ${tokens.toLocaleString('en-US')} tokens`);
  const compacted = c.digest ? compactedSinceReply(c.digest) : false;
  if (compacted && c.digest?.compacted?.v) tip.push(`Compacted from ${formatTokens(c.digest.compacted.v)} tokens`);
  const reply = c.digest?.reply?.v;
  const t = c.showCost !== false && c.tally?.replies ? c.tally : undefined;
  return {
    key: keyOf(c.s),
    title: c.title,
    group: c.group,
    unread: c.unread,
    folder,
    cwd,
    state: stateWords(c, tokens),
    detail,
    quote,
    fold: foldsDetail(c.group, detail),
    changedAt: c.changedAt,
    chips: chipsOf(c),
    tokens,
    freshTokens: c.freshTokens,
    compacted,
    prompt: c.outcome?.kind === 'handoff' && !!c.outcome.prompt,
    cost: t ? `${formatUsd(t.usd)}${Object.keys(t.unpriced).length ? '+' : ''}` : undefined,
    costTip: t ? costTip(t, c.helpers ?? 0) : [],
    model: c.digest?.model ? modelName(c.digest.model.v) : undefined,
    effort: c.digest?.effort?.v,
    reply: reply && saysMore(reply, detail) ? reply : undefined,
    tip,
  };
}

/** Lines a folded detail keeps showing; the board clamps to the same number. */
export const FOLD_LINES = 4;

/**
 * Whether a card's detail starts folded. Only hand-over cards fold: their
 * detail is a whole kickoff prompt, often a paragraph or more. Over
 * FOLD_LINES lines, or about as many characters as FOLD_LINES lines of a
 * board at its default width, is long. The board unfolds one that fits anyway.
 */
export function foldsDetail(group: Group, detail: string | undefined): boolean {
  if (group !== 'handoff' || !detail) return false;
  return detail.split('\n').length > FOLD_LINES || detail.length > FOLD_LINES * 60;
}

/** Whether a reply holds more than the detail line shows (markup and spacing aside). */
function saysMore(reply: string, detail: string | undefined): boolean {
  const bare = (s: string) => s.replace(/[\s*_`#>|-]/g, '').length;
  return bare(reply) > bare(detail ?? '') + 15;
}

function costTip(t: Tally, helpers: number): string[] {
  const n = (x: number) => x.toLocaleString('en-US');
  const out = [
    `About ${formatUsd(t.usd)} at API prices, for ${n(t.replies)} replies${helpers ? `, ${helpers} helper agent${helpers === 1 ? '' : 's'} included` : ''}.`,
    `Tokens: ${n(t.input)} input, ${n(t.output)} output, ${n(t.cacheRead)} cache reads, ${n(t.cacheWrite)} cache writes.`,
  ];
  const unpriced = Object.entries(t.unpriced);
  if (unpriced.length) out.push(`Not counted (no known price): ${unpriced.map(([m, k]) => `${k} on ${m}`).join(', ')}.`);
  out.push('On a Claude plan this is what the same tokens would cost on the API, not what you pay.');
  return out;
}
