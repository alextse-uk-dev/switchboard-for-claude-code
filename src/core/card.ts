import * as path from 'node:path';
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
  changedAt?: number;
  /** "other window", "background", … */
  chips: string[];
  tokens?: number;
  /** The context size from which a new session is suggested (0: never). */
  freshTokens: number;
  compacted: boolean;
  /** A kickoff prompt was found, so it can be copied or started. */
  prompt: boolean;
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
}

function stateWords(c: CardInput, tokens: number | undefined): string {
  const o = c.outcome;
  switch (c.group) {
    case 'needs':
      return waitingLabel(c.s.waitingFor);
    case 'reply':
      return 'asks you';
    case 'handoff':
      if (o?.kind === 'handoff' && o.reason === 'context') return tokens ? `context ${formatTokens(tokens)}` : 'context is large';
      return o?.kind === 'handoff' && o.prompt ? 'kickoff prompt ready' : 'suggests a new session';
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
  if (c.group === 'handoff' && o?.kind === 'handoff' && o.reason === 'kickoff') return { detail: o.prompt ?? o.line, quote: true };
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
    changedAt: c.changedAt,
    chips: chipsOf(c),
    tokens,
    freshTokens: c.freshTokens,
    compacted,
    prompt: c.outcome?.kind === 'handoff' && !!c.outcome.prompt,
    tip,
  };
}
