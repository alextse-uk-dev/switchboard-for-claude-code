import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jobCardFile, parseJobCard, type JobCard } from './core/jobcard';

/** The job-cards folder from the setting: `~` expanded; a relative path or nothing means the default. */
export function jobCardsDir(configured: string | undefined, home = os.homedir()): string {
  const fallback = path.join(home, '.claude', 'job-cards');
  const t = (configured ?? '').trim();
  if (!t) return fallback;
  const expanded = t.replace(/^~(?=$|[\\/])/, home);
  return path.isAbsolute(expanded) ? expanded : fallback;
}

interface Cached {
  mtimeMs: number;
  size: number;
  card?: JobCard;
}

/**
 * Reads the job cards of live sessions, `<dir>/<sessionId>.json`. A file is
 * read again only when its time or size changes. A missing folder, a missing
 * file or one that doesn't parse simply gives no card.
 */
export class JobCardStore {
  private cache = new Map<string, Cached>();

  constructor(public dir: string) {}

  /** Points at another folder (the setting changed), forgetting what was read. */
  setDir(dir: string): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.cache.clear();
  }

  async read(sessionIds: Iterable<string>): Promise<Map<string, JobCard>> {
    const ids = [...new Set(sessionIds)];
    const out = new Map<string, JobCard>();
    await Promise.all(
      ids.map(async (id) => {
        const card = await this.readOne(id);
        if (card) out.set(id, card);
      }),
    );
    for (const id of this.cache.keys()) if (!ids.includes(id)) this.cache.delete(id);
    return out;
  }

  private async readOne(id: string): Promise<JobCard | undefined> {
    const name = jobCardFile(id);
    if (!name) return undefined;
    const file = path.join(this.dir, name);
    const st = await fs.stat(file).catch(() => undefined);
    if (!st?.isFile()) {
      this.cache.delete(id);
      return undefined;
    }
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.card;
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    // Too big to be a summary: someone wrote something else there.
    const card = text !== undefined && text.length <= 256 * 1024 ? parseJobCard(text, st.mtimeMs) : undefined;
    this.cache.set(id, { mtimeMs: st.mtimeMs, size: st.size, card });
    return card;
  }
}
