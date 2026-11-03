/**
 * Keeping alerts quiet: the same words for the same session are said once
 * in a while, and the user can mute them all for an hour.
 */

/** The same alert text for the same session is not repeated within this long. */
export const REPEAT_MS = 10 * 60 * 1000;
/** How long "Mute alerts for 1 hour" mutes them. */
export const MUTE_MS = 60 * 60 * 1000;

/**
 * Remembers what was last said about each session. `fresh` answers whether
 * an alert is worth giving, and notes it if so: an alert whose text matches
 * one given for the same session less than REPEAT_MS ago is not.
 */
export class Repeats {
  private said = new Map<string, Map<string, number>>();

  constructor(private readonly windowMs = REPEAT_MS) {}

  fresh(sessionId: string, text: string, now: number): boolean {
    let mine = this.said.get(sessionId);
    if (!mine) {
      mine = new Map();
      this.said.set(sessionId, mine);
    }
    for (const [t, at] of mine) if (now - at >= this.windowMs) mine.delete(t);
    const at = mine.get(text);
    if (at !== undefined && now - at < this.windowMs) return false;
    mine.set(text, now);
    return true;
  }

  /** Drops what was said about sessions no longer running. */
  forget(liveIds: ReadonlySet<string>): void {
    for (const id of this.said.keys()) if (!liveIds.has(id)) this.said.delete(id);
  }
}

/** Whether alerts are muted at `now`, given the stored end of the mute (if any). */
export function isMuted(until: number | undefined, now: number): boolean {
  return typeof until === 'number' && Number.isFinite(until) && now < until;
}

/** The end of a mute started at `now`. */
export function muteUntil(now: number): number {
  return now + MUTE_MS;
}

/**
 * Whether a mute has ended without its end being told yet: there is a stored
 * end, and it has passed. The caller then says so once and forgets the end.
 */
export function muteEnded(until: number | undefined, now: number): boolean {
  return typeof until === 'number' && Number.isFinite(until) && now >= until;
}

/** "14:05", the end of a mute in the user's own clock. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
