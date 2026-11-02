import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isSessionId, parseRecord, type Recoverable } from './core/recover';

/**
 * The sessions held in VS Code's terminal tabs, kept on disk so that they can
 * be reopened after VS Code has closed them all. Nothing runs at shut-down,
 * which also covers a crash or a restart of the Mac: a record is written while
 * its session lives and removed only if the session ends while its window
 * lives on. One file per session (`recovery/<session id>`), so that two
 * windows never rewrite each other's, and removing the file is what claims a
 * session for resuming, so that two windows can't both reopen it.
 */
export class RecoveryStore {
  readonly dir: string;
  private records = new Map<string, Recoverable>();
  /** Counts changes, so a read that started before one can't undo it. */
  private generation = 0;

  constructor(sharedDir: string) {
    this.dir = path.join(sharedDir, 'recovery');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.load();
  }

  get list(): Recoverable[] {
    return [...this.records.values()];
  }

  get(id: string): Recoverable | undefined {
    return this.records.get(id);
  }

  /** Reads the folder again, e.g. after another window changed it. */
  async load(): Promise<void> {
    const started = ++this.generation;
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const records = new Map<string, Recoverable>();
    await Promise.all(
      names
        .filter(isSessionId)
        .map(async (id) => {
          const r = parseRecord(await fs.readFile(path.join(this.dir, id), 'utf8').catch(() => ''));
          if (r?.sessionId === id) records.set(id, r);
        }),
    );
    if (started === this.generation) this.records = records;
  }

  async write(r: Recoverable): Promise<void> {
    if (!isSessionId(r.sessionId)) return;
    const file = path.join(this.dir, r.sessionId);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(r), 'utf8');
    await fs.rename(tmp, file);
    this.generation++;
    this.records.set(r.sessionId, r);
  }

  /** Removes a record. Resolves true only for the caller that removed it, which then owns reopening it. */
  async take(id: string): Promise<boolean> {
    if (!isSessionId(id)) return false;
    this.generation++;
    this.records.delete(id);
    const file = path.join(this.dir, id);
    try {
      // A rename has one winner. Two unlinks at once can both report success (measured on APFS: most rounds).
      const taken = `${file}.${process.pid}.${randomUUID()}.taken`;
      await fs.rename(file, taken);
      await fs.rm(taken, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
