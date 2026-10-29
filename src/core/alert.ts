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
