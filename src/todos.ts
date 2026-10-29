import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { applyOp, parseTodos, prune, serializeTodos, syncAsks, type SessionAsks, type Todo, type TodoOp } from './core/todo';

/** How long a change waits for another window's lock, and when a lock counts as left behind. */
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The user's to-do list, in one file (`todos.json`) in the extension's global
 * storage folder, so every VS Code window shows the same list. Each change
 * takes a lock file, reads the list afresh, applies itself and writes the
 * list back whole, so two windows changing it at once both keep their change.
 */
export class TodoStore {
  static readonly FILE = 'todos.json';
  readonly file: string;
  private items: Todo[] = [];
  private lastRead = '';
  /** Changes from this window run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, TodoStore.FILE);
  }

  get list(): readonly Todo[] {
    return this.items;
  }

  /** Re-reads the file. Resolves true if the list changed. */
  async load(): Promise<boolean> {
    const text = await fs.readFile(this.file, 'utf8').catch(() => '');
    if (text === this.lastRead) return false;
    this.lastRead = text;
    this.items = parseTodos(text);
    return true;
  }

  /** Applies a change the user made. Resolves true if the list changed. */
  change(o: TodoOp, now: number): Promise<boolean> {
    return this.update((list) => applyOp(list, o, now), now);
  }

  /** Brings the asks in line with sessions' newest replies. Resolves true if the list changed. */
  syncAsks(sessions: readonly SessionAsks[], now: number): Promise<boolean> {
    if (!sessions.length) return Promise.resolve(false);
    return this.update((list) => syncAsks(list, sessions, now), now);
  }

  private update(apply: (list: readonly Todo[]) => Todo[] | undefined, now: number): Promise<boolean> {
    const run = this.queue.then(() =>
      this.locked(async () => {
        await this.load();
        const next = apply(this.items);
        if (!next) return false;
        const kept = prune(next, now);
        const text = serializeTodos(kept);
        const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(tmp, text, 'utf8');
        await fs.rename(tmp, this.file);
        this.items = kept;
        this.lastRead = text;
        return true;
      }),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs `work` holding `todos.json.lock`, which only one window can create at a time. */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    for (const start = Date.now(); ; ) {
      try {
        await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const st = await fs.stat(lock).catch(() => undefined);
        // A window that crashed while holding it leaves it behind.
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { force: true });
        else if (Date.now() - start > LOCK_WAIT_MS) throw new Error('the to-do list is locked by another window');
        else await sleep(15 + Math.random() * 30);
      }
    }
    try {
      return await work();
    } finally {
      await fs.rm(lock, { force: true });
    }
  }
}
