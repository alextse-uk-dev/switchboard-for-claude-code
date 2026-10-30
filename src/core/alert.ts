import type { SessionEvent } from './model';
import { pushMessage } from './push';
import type { Outcome } from './types';

/**
 * Mac alerts: a macOS notification banner, and a sound once you have been
 * away for a while, when a session needs you or finishes a turn. They are
 * for when the VS Code pop-up can't reach you: another app is in front, or
 * you have left the desk.
 */
export interface AlertContext {
  needsOn: boolean;
  finishedOn: boolean;
  finishedMinMs: number;
  /**
   * This window decides about this session: it holds the tab, or no window
   * does and it was focused last (as for pop-ups and pushes).
   */
  decides: boolean;
  /**
   * You can see it already: you are looking at the session's tab, or this
   * window is in front and shows its own pop-up for the event.
   */
  seenHere: boolean;
  /** Time since the last key press or mouse move; undefined if it can't be read. */
  idleMs: number | undefined;
  /** No key press or mouse move for this long and you count as away. */
  awayAfterMs: number;
  /** A sound is chosen (not "none"). */
  soundOn: boolean;
}

export interface AlertPlan {
  banner: boolean;
  sound: boolean;
}

const NONE: AlertPlan = { banner: false, sound: false };

/**
 * What to do about one event. While you are away, a banner and the sound,
 * even for the tab in front of you. While you are here, a banner only if
 * you can't see the event in VS Code already. An idle time that can't be
 * read counts as away: a sound too many beats a missed one. With no away
 * time at all (0), every alert plays the sound, and the banner still keeps
 * to what you can see.
 */
export function alertPlan(e: SessionEvent, outcome: Outcome | undefined, c: AlertContext): AlertPlan {
  if (e.type === 'needs' && !c.needsOn) return NONE;
  if (e.type === 'finished') {
    if (!c.finishedOn || (e.turnMs ?? 0) < c.finishedMinMs) return NONE;
    // You stopped it yourself, so there is nothing to tell.
    if (outcome?.kind === 'stopped' && outcome.why === 'interrupted') return NONE;
  }
  if (!c.decides) return NONE;
  const away = c.idleMs === undefined || c.idleMs >= c.awayAfterMs;
  const sound = c.soundOn && away;
  if (c.seenHere && !(away && c.awayAfterMs > 0)) return { banner: false, sound };
  return { banner: true, sound };
}

/** The macOS sounds an alert can play, from /System/Library/Sounds. */
export const MAC_SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'] as const;

/** The sound file for a setting, or undefined for "none" or a name that isn't one of them. */
export function soundFile(name: string | undefined): string | undefined {
  const n = MAC_SOUNDS.find((s) => s.toLowerCase() === (name ?? '').trim().toLowerCase());
  return n ? `/System/Library/Sounds/${n}.aiff` : undefined;
}

/**
 * What a banner says: the same words as a phone push. It quotes Claude, since
 * a banner never leaves this computer.
 */
export function alertText(e: SessionEvent, title: string, folder: string, outcome: Outcome | undefined): { title: string; message: string } {
  const m = pushMessage(e, title, folder, outcome, true);
  return { title: m.title, message: m.message };
}

/**
 * The osascript arguments that show a banner. The words go in as arguments,
 * never into the script, so nothing in them can run: "--" ends the options,
 * so words that start with "-" (such as "-e …") can't add a line to it.
 */
export function bannerArgs(title: string, message: string): string[] {
  return ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--', title, message];
}

/**
 * Whether a window gives the whole set of Mac alerts (both kinds, with a
 * sound), which is what it tells other tools: one that plays its own sounds
 * may stay quiet only then.
 */
export function givesAllAlerts(c: { enabled: boolean; needsYou: boolean; finished: boolean; sound: string | undefined }): boolean {
  return c.enabled && c.needsYou && c.finished && soundFile(c.sound) !== undefined;
}

/** The path of a banner's link that opens a session, and of the test banner's. */
export const OPEN_PATH = '/open';
export const TEST_PATH = '/test';

/** The query of a banner's link that opens the session with this key. */
export function openQuery(key: string): string {
  return new URLSearchParams({ key }).toString();
}

/**
 * What a clicked banner's link asks for, from its path and query (VS Code
 * adds its own parts to the query, such as the window's id): a session's
 * key, the test banner, or nothing it knows.
 */
export function readLink(path: string, query: string): { open: string } | { test: true } | undefined {
  if (path === TEST_PATH) return { test: true };
  if (path !== OPEN_PATH) return undefined;
  const key = new URLSearchParams(query).get('key');
  return key ? { open: key } : undefined;
}

/**
 * The helper app's arguments for a banner. They go to the app as they are,
 * with no shell and no script in between, so nothing in them can run.
 */
export function helperArgs(title: string, message: string, link: string): string[] {
  return ['post', title, message, link];
}

/** What a helper exit code means, for the log, or undefined for success. */
export function helperFailure(code: number | null): string | undefined {
  switch (code) {
    case 0:
      return undefined;
    case 3:
      return 'notifications are off for Switchboard: allow them in System Settings > Notifications';
    case 4:
      return 'macOS refused the banner';
    case 5:
      return 'the notification prompt has no answer yet';
    default:
      return `the helper failed (exit ${code})`;
  }
}

/**
 * Which listed session a clicked link names, by its key ("pid:sessionId"):
 * the same one, or else the same session resumed under a new process.
 */
export function linkedKey(key: string, keys: Iterable<string>): string | undefined {
  const all = [...keys];
  if (all.includes(key)) return key;
  const id = (k: string) => {
    const i = k.indexOf(':');
    return i > 0 && i < k.length - 1 ? k.slice(i + 1) : undefined;
  };
  const want = id(key);
  return want === undefined ? undefined : all.find((k) => id(k) === want);
}

/** The CFBundleVersion in an Info.plist's text, or undefined if it has none. */
export function plistVersion(plist: string): string | undefined {
  return /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1].trim();
}

/**
 * Whether the bundled helper should replace the installed one: none is
 * installed (or it can't be read), or the bundled one is a newer version.
 * The same version is replaced only if it differs (a build made again), so
 * two windows on different versions never take turns swapping their own in.
 */
export function replacesHelper(bundled: { plist: string }, installed: { plist: string; same: boolean } | undefined): boolean {
  if (!installed) return true;
  const a = plistVersion(bundled.plist);
  const b = plistVersion(installed.plist);
  if (a === undefined || b === undefined) return !installed.same;
  const cmp = compareVersions(a, b);
  return cmp > 0 || (cmp === 0 && !installed.same);
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
