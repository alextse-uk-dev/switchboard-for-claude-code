import { formatAge, noLinks, waitingLabel, type SessionEvent } from './model';
import type { Outcome } from './types';

/**
 * Phone pushes go through ntfy (https://ntfy.sh, or a server of your own):
 * a POST to a topic, which the ntfy app on the phone subscribes to. Anyone
 * who knows the topic can read it, so the topic is kept in VS Code's secret
 * storage and a new one is long and random.
 */
export interface PushTarget {
  /** The server, ending in "/", e.g. "https://ntfy.sh/". */
  server: string;
  topic: string;
  /** An ntfy access token, for a topic that needs one. */
  token?: string;
}

const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

/** Hosts that may use plain http: this machine, or a server on the local network. */
function localHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Reads a topic URL such as "https://ntfy.sh/my-topic". Says what is wrong with one it can't use. */
export function parseTopicUrl(raw: string): { server: string; topic: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'That is not a URL. It looks like https://ntfy.sh/your-topic.' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localHost(u.hostname))) {
    return { error: 'Use https (plain http only for a server on this machine or your local network).' };
  }
  if (u.username || u.password) return { error: 'Leave the name and password out of the URL; give an access token instead.' };
  if (u.search || u.hash) return { error: 'Leave out everything after the topic (no "?" or "#").' };
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic) return { error: 'Add the topic after the server, e.g. https://ntfy.sh/your-topic.' };
  if (!TOPIC.test(topic)) return { error: 'A topic is up to 64 letters, digits, "-" or "_".' };
  return { server: `${u.origin}/${parts.map((p) => `${p}/`).join('')}`, topic };
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A new topic nobody can guess: "sb-" and 16 characters (80 random bits) that are easy to type on a phone. */
export function newTopic(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error('newTopic needs 16 random bytes');
  let out = 'sb-';
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Shows a topic URL without giving the topic away, e.g. "https://ntfy.sh/sb-k3…". */
export function maskedTopic(t: Pick<PushTarget, 'server' | 'topic'>): string {
  return `${t.server}${t.topic.slice(0, Math.min(5, Math.ceil(t.topic.length / 3)))}…`;
}

export interface PushMessage {
  title: string;
  message: string;
  /** ntfy's 1 to 5; 4 is "high". */
  priority: number;
  /** ntfy tags; names of emoji show as icons. */
  tags: string[];
}

const MAX_WORDS = 200;

/**
 * Breaks every link a phone could make tappable: markdown links, "://" and
 * dotted names such as "example.com", with an invisible space.
 */
export function plainText(s: string): string {
  return noLinks(s)
    .replace(/:\/\//g, ':\u200b//')
    .replace(/(\w)\.(?=\w)/g, '$1.\u200b');
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_WORDS ? `${one.slice(0, MAX_WORDS - 1)}…` : one;
}

/**
 * What a push says. Without `withWords`, it names the session, its folder
 * and what happened, and never quotes Claude: the push passes through the
 * ntfy server, which can read it.
 */
export function pushMessage(e: SessionEvent, title: string, folder: string, outcome: Outcome | undefined, withWords: boolean): PushMessage {
  // The folder always shows; a long line is cut short instead.
  const message = (line: string) => plainText(`${clip(line)} · ${clip(folder)}`);
  const named = (t: string) => plainText(clip(t));
  if (e.type === 'needs') {
    return { title: named(`${title} needs you`), message: message(waitingLabel(e.session.waitingFor)), priority: 4, tags: ['bell'] };
  }
  const after = e.turnMs ? ` after ${formatAge(e.turnMs)}` : '';
  switch (outcome?.kind) {
    case 'question':
      return {
        title: named(`${title} is waiting for your reply`),
        message: message(withWords ? `"${outcome.ask}"` : `It finished${after} with a question for you`),
        priority: 4,
        tags: ['speech_balloon'],
      };
    case 'handoff':
      return {
        title: named(`${title} finished${after}`),
        message: message(outcome.reason === 'kickoff' ? 'It wrote a kickoff prompt for a new session' : 'Its context is large, so start a new session next'),
        priority: 3,
        tags: ['arrows_counterclockwise'],
      };
    case 'stopped':
      return {
        title: named(`${title} stopped`),
        message: message(outcome.why === 'error' ? (withWords && outcome.text ? `On an error: ${outcome.text}` : 'On an error') : 'It was interrupted'),
        priority: 4,
        tags: ['warning'],
      };
    default:
      return { title: named(`${title} finished${after}`), message: message('Done'), priority: 3, tags: ['white_check_mark'] };
  }
}

/** The JSON ntfy takes at its root URL. */
export function ntfyBody(t: Pick<PushTarget, 'topic'>, m: PushMessage): string {
  return JSON.stringify({ topic: t.topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags });
}

/**
 * Reads how long since the last key press or mouse move from macOS's
 * `ioreg -c IOHIDSystem` (HIDIdleTime, in nanoseconds).
 */
export function idleMsFromIoreg(text: string): number | undefined {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text);
  return m ? Math.floor(Number(m[1]) / 1_000_000) : undefined;
}

export interface PushContext {
  needsOn: boolean;
  finishedOn: boolean;
  finishedMinMs: number;
  /** Push even while you are at the computer. */
  always: boolean;
  /**
   * This window decides about this session: it holds the tab, or no window
   * does and it was focused last. Only that window can tell whether you are
   * looking at the tab, so the others leave the event alone.
   */
  decides: boolean;
  /** You are looking at this session's tab right now. */
  lookingAt: boolean;
  /** How long you have been away, as far as can be told (0: you are here). */
  awayMs: number;
  awayAfterMs: number;
}

/**
 * What to do about one event: push now, wait to see whether you leave
 * before you deal with it, or drop it.
 */
export function pushVerdict(e: SessionEvent, outcome: Outcome | undefined, c: PushContext): 'push' | 'wait' | 'drop' {
  if (e.type === 'needs' && !c.needsOn) return 'drop';
  if (e.type === 'finished') {
    if (!c.finishedOn || (e.turnMs ?? 0) < c.finishedMinMs) return 'drop';
    // You stopped it yourself, so there is nothing to tell.
    if (outcome?.kind === 'stopped' && outcome.why === 'interrupted') return 'drop';
  }
  if (!c.decides) return 'drop';
  if (c.lookingAt) return c.always ? 'drop' : 'wait';
  if (c.always || c.awayMs >= c.awayAfterMs) return 'push';
  return 'wait';
}

/**
 * How long you have been away. Where the computer says how long since you
 * last touched it (macOS), that decides. Otherwise it is how long since any
 * VS Code window had focus, and nothing while one has it.
 */
export function awayMs(now: number, idleMs: number | undefined, anyFocused: boolean, lastFocusedAt: number): number {
  if (idleMs !== undefined) return idleMs;
  if (anyFocused) return 0;
  return lastFocusedAt > 0 ? Math.max(0, now - lastFocusedAt) : 0;
}

/** An event held back while you were here, to push if you leave before dealing with it. */
export interface Pending {
  e: SessionEvent;
  key: string;
  sessionId: string;
  changedAt: number;
  since: number;
  /** A push that failed to send, tried again each minute whether or not you are away. */
  retry?: true;
}

/** An ntfy access token: printable, no spaces (they start "tk_"). Empty means none. */
export function tokenProblem(t: string): string | undefined {
  const v = t.trim();
  return !v || /^[\x21-\x7e]{1,256}$/.test(v) ? undefined : 'An access token has no spaces or special characters (it starts "tk_").';
}

/** How long a held-back event waits for you to leave before it is dropped. */
export const PENDING_MS = 60 * 60 * 1000;

/**
 * A held-back event goes once the session has moved on (its status changed
 * again, or it ended), once you have seen it, or after an hour; it is
 * pushed if you have been away long enough.
 */
export function pendingVerdict(
  p: Pending,
  now: number,
  o: { changedAt: number | undefined; seenAt: number | undefined; awayMs: number; awayAfterMs: number },
): 'push' | 'wait' | 'drop' {
  if (o.changedAt !== p.changedAt) return 'drop';
  if (p.e.type === 'finished' && o.seenAt !== undefined && o.seenAt >= p.changedAt) return 'drop';
  if (now - p.since > PENDING_MS) return 'drop';
  if (p.retry) return 'push';
  return o.awayMs >= o.awayAfterMs ? 'push' : 'wait';
}
