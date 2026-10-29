import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Seen marks older than this are dropped: the session is long gone. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** Pop-up claims older than this are swept at start-up. */
const CLAIM_KEEP_MS = 24 * 60 * 60 * 1000;

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

/** What the other live windows have said about themselves. */
export interface Peers {
  /** Session keys held in their terminal tabs. */
  owned: Set<string>;
  /** When any of them was last focused (0 if none). */
  focusedAt: number;
}

/**
 * State every VS Code window shares, kept in the extension's global storage
 * folder: when the user last looked at each session (`seen.json`), which
 * sessions each window holds and when it was last focused
 * (`windows/<id>.json`), and which pop-ups have been shown (`claims/`).
 */
export class SharedState {
  readonly seenFile: string;
  private readonly windowsDir: string;
  private readonly claimsDir: string;
  private readonly ownFile: string;
  private seen = new Map<string, number>();
  private owned: string[] = [];
  private focusedAt = 0;
  private lastWritten = '';
  /** Writes from this window run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string, windowId: string) {
    this.seenFile = path.join(dir, 'seen.json');
    this.windowsDir = path.join(dir, 'windows');
    this.claimsDir = path.join(dir, 'claims');
    this.ownFile = path.join(this.windowsDir, `${windowId}.json`);
  }

  async init(now: number): Promise<void> {
    await fs.mkdir(this.windowsDir, { recursive: true });
    await fs.mkdir(this.claimsDir, { recursive: true });
    await this.loadSeen();
    for (const n of await fs.readdir(this.claimsDir).catch(() => [] as string[])) {
      const file = path.join(this.claimsDir, n);
      const st = await fs.stat(file).catch(() => undefined);
      if (st && now - st.mtimeMs > CLAIM_KEEP_MS) await fs.rm(file, { force: true });
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Re-reads the seen marks, e.g. after another window wrote them. Marks are
   * merged, newest wins, so a write that raced ours loses nothing here.
   */
  async loadSeen(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.seenFile, 'utf8')) as { seen?: Record<string, unknown> };
      for (const [id, at] of Object.entries(data.seen ?? {})) {
        if (typeof at === 'number' && (this.seen.get(id) ?? -Infinity) < at) this.seen.set(id, at);
      }
    } catch {
      // No file yet, or one being replaced; keep what we have.
    }
  }

  seenAt(sessionId: string): number | undefined {
    return this.seen.get(sessionId);
  }

  /** Records that the user looked at these sessions. Resolves true if anything moved forward. */
  markSeen(entries: ReadonlyArray<readonly [string, number]>, now: number): Promise<boolean> {
    return this.serial(async () => {
      await this.loadSeen();
      let changed = false;
      for (const [id, at] of entries) {
        if ((this.seen.get(id) ?? -Infinity) < at) {
          this.seen.set(id, at);
          changed = true;
        }
      }
      if (!changed) return false;
      for (const [id, at] of this.seen) if (now - at > KEEP_MS) this.seen.delete(id);
      await writeAtomic(this.seenFile, JSON.stringify({ v: 1, seen: Object.fromEntries(this.seen) }));
      return true;
    });
  }

  /** Tells the other windows which sessions this window holds. */
  publishOwned(keys: readonly string[]): Promise<void> {
    this.owned = [...keys].sort();
    return this.writeWindow();
  }

  /** Tells the other windows that this one has just been focused. */
  noteFocused(at: number): Promise<void> {
    this.focusedAt = at;
    return this.writeWindow();
  }

  get lastFocusedAt(): number {
    return this.focusedAt;
  }

  private writeWindow(): Promise<void> {
    return this.serial(async () => {
      const data = JSON.stringify({ v: 1, pid: process.pid, sessions: this.owned, focusedAt: this.focusedAt });
      if (data === this.lastWritten) return;
      await writeAtomic(this.ownFile, data);
      this.lastWritten = data;
    });
  }

  /** What the other live windows hold, and when one was last focused. Files left by closed windows are removed. */
  async peers(): Promise<Peers> {
    const out: Peers = { owned: new Set(), focusedAt: 0 };
    let names: string[] = [];
    try {
      names = await fs.readdir(this.windowsDir);
    } catch {
      return out;
    }
    for (const n of names) {
      const file = path.join(this.windowsDir, n);
      if (!n.endsWith('.json') || file === this.ownFile) continue;
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown; sessions?: unknown; focusedAt?: unknown };
        if (typeof data.pid !== 'number' || !alive(data.pid)) {
          await fs.rm(file, { force: true });
          continue;
        }
        if (Array.isArray(data.sessions)) for (const k of data.sessions) if (typeof k === 'string') out.owned.add(k);
        if (typeof data.focusedAt === 'number') out.focusedAt = Math.max(out.focusedAt, data.focusedAt);
      } catch {
        // Being replaced right now; the next refresh reads it.
      }
    }
    return out;
  }

  /**
   * Claims one pop-up, so that no two windows show it. Resolves true for the
   * first caller only; on an unexpected error it says true, since a doubled
   * pop-up beats a missing one.
   */
  async claim(event: string): Promise<boolean> {
    const file = path.join(this.claimsDir, event.replace(/[^A-Za-z0-9.-]/g, '_'));
    try {
      await fs.writeFile(file, '', { flag: 'wx' });
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'EEXIST';
    }
  }

  async dispose(): Promise<void> {
    await fs.rm(this.ownFile, { force: true });
  }
}
