/**
 * What a session's tokens would cost at Anthropic's API list prices. Claude
 * Code writes each reply's token usage into the transcript. One reply can
 * span several lines (one per content block), all carrying the same message
 * id and the same usage, so each id counts once.
 */

/** Dollars per million tokens. */
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

interface Price extends Rates {
  /** Fast mode multiplies every rate by this. */
  fast?: number;
  /** Other rates once the prompt (input plus cache) passes `above` tokens. */
  long?: Rates & { above: number };
}

const opus4 = { input: 5, output: 25, cacheRead: 0.5 };
const sonnet4 = { input: 3, output: 15, cacheRead: 0.3 };
/** Sonnet 4 and 4.5 bill a prompt over 200k tokens (their 1M context) at higher rates. */
const sonnet4Long = { ...sonnet4, long: { above: 200_000, input: 6, output: 22.5, cacheRead: 0.6 } };

/**
 * API list prices in November 2026. Cache writes cost 1.25× input for the
 * 5-minute cache and 2× for the 1-hour cache, on every model.
 */
const PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, fast: 2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2, fast: 2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  'claude-opus-4-8': opus4,
  'claude-opus-4-7': opus4,
  'claude-opus-4-6': opus4,
  'claude-opus-4-5': opus4,
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': sonnet4,
  'claude-sonnet-4-5': sonnet4Long,
  'claude-sonnet-4': sonnet4Long,
  'claude-3-7-sonnet': sonnet4,
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08 },
};

/**
 * A model id as the price table names it, without a cloud prefix, a context
 * tag, a version suffix or a date: `us.anthropic.claude-opus-4-5-20251101-v1:0`
 * and `claude-opus-5-5[1m]` become `claude-opus-4-5` and `claude-opus-5-5`.
 */
export function modelKey(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/^(?:[a-z-]+\.)?anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

/** "Opus 5.5", "Haiku 3.5", or the id itself for a model it can't name. */
export function modelName(model: string): string {
  const k = modelKey(model);
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d))?$/.exec(k) ?? /^claude-(\d+)(?:-(\d))?-([a-z]+)$/.exec(k);
  if (!m) return model;
  const [family, major, minor] = /^\d/.test(m[1]) ? [m[3], m[1], m[2]] : [m[1], m[2], m[3]];
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

/** One reply's tokens. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  fast: boolean;
}

/** Reads a transcript's `usage` object. */
export function usageOf(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const written = n(u.cache_creation_input_tokens);
  const split = u.cache_creation as Record<string, unknown> | undefined;
  // Writes the split doesn't account for are priced as the cheaper 5-minute kind.
  const write1h = Math.min(written, split ? n(split.ephemeral_1h_input_tokens) : 0);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    write5m: written - write1h,
    write1h,
    fast: u.speed === 'fast',
  };
}

/** A model's family and version, e.g. `claude-fable-5-2` → fable, [5, 2]. */
function familyOf(key: string): { family: string; version: number[] } | undefined {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(key) ?? /^claude-(\d+)(?:-(\d+))?-([a-z]+)$/.exec(key);
  if (!m) return undefined;
  return /^\d/.test(m[1]) ? { family: m[3], version: [Number(m[1]), Number(m[2] ?? 0)] } : { family: m[1], version: [Number(m[2]), Number(m[3] ?? 0)] };
}

const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1];

/**
 * The price-table entry a model is priced by: its own, else, for a model
 * newer than the table (`claude-fable-5-3`), the newest of its family, so a
 * new release isn't counted as free. Undefined for anything else.
 */
export function priceKey(model: string): string | undefined {
  const k = modelKey(model);
  if (PRICES[k]) return k;
  const f = familyOf(k);
  if (!f) return undefined;
  let best: { key: string; version: number[] } | undefined;
  for (const key of Object.keys(PRICES)) {
    const g = familyOf(key);
    if (g?.family === f.family && (!best || newer(g.version, best.version) > 0)) best = { key, version: g.version };
  }
  return best && newer(f.version, best.version) > 0 ? best.key : undefined;
}

/** Dollars for one reply on one model, or undefined when the model has no known price. */
export function costOf(model: string, u: Usage): number | undefined {
  const key = priceKey(model);
  const p = key ? PRICES[key] : undefined;
  if (!p) return undefined;
  const prompt = u.input + u.cacheRead + u.write5m + u.write1h;
  const r: Rates = p.long && prompt > p.long.above ? p.long : p;
  const x = u.fast && p.fast ? p.fast : 1;
  return (x * (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.write5m * r.input * 1.25 + u.write1h * r.input * 2)) / 1e6;
}

/** The running total for one transcript file, or for a whole session. */
export interface Tally {
  /** Dollars for the replies whose model has a known price. */
  usd: number;
  replies: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Replies on a model with no known price, by model id. */
  unpriced: Record<string, number>;
  /** Models newer than the price table, and the entry each was priced as. */
  estimated: Record<string, string>;
}

export const emptyTally = (): Tally => ({ usd: 0, replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: {}, estimated: {} });

/** A file's tally plus the reply ids already counted in it. */
export interface CostState {
  tally: Tally;
  seen: Set<string>;
}

export const emptyCost = (): CostState => ({ tally: emptyTally(), seen: new Set() });

/**
 * Adds the replies in some complete transcript lines to a file's tally. Helper
 * agents' replies count too (their own files hold nothing else).
 */
export function countLines(text: string, into: CostState): void {
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"assistant"')) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.type !== 'assistant') continue;
    const m = r.message as Record<string, unknown> | undefined;
    const model = typeof m?.model === 'string' ? m.model : undefined;
    const u = usageOf(m?.usage);
    if (!m || !u || !model || model === '<synthetic>') continue;
    const id = typeof m.id === 'string' ? m.id : typeof r.requestId === 'string' ? r.requestId : undefined;
    if (id) {
      if (into.seen.has(id)) continue;
      into.seen.add(id);
    }
    const t = into.tally;
    t.replies++;
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.cacheWrite += u.write5m + u.write1h;
    const usd = costOf(model, u);
    if (usd === undefined) t.unpriced[model] = (t.unpriced[model] ?? 0) + 1;
    else t.usd += usd;
    const as = priceKey(model);
    if (as && as !== modelKey(model)) t.estimated[model] = as;
  }
}

/** The sum of several tallies. */
export function sumTallies(tallies: readonly Tally[]): Tally {
  const out = emptyTally();
  for (const t of tallies) {
    out.usd += t.usd;
    out.replies += t.replies;
    out.input += t.input;
    out.output += t.output;
    out.cacheRead += t.cacheRead;
    out.cacheWrite += t.cacheWrite;
    for (const [m, n] of Object.entries(t.unpriced)) out.unpriced[m] = (out.unpriced[m] ?? 0) + n;
    Object.assign(out.estimated, t.estimated);
  }
  return out;
}

/** "$0.42", "$12.40", "$128", or "<$0.01". */
export function formatUsd(usd: number): string {
  if (usd < 0.005) return usd > 0 ? '<$0.01' : '$0';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}
