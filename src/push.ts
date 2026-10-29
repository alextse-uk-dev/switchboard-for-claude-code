import { execFile } from 'node:child_process';
import { idleMsFromIoreg, ntfyBody, type PushMessage, type PushTarget } from './core/push';

const SECRET_KEY = 'switchboard.phonePush';
const SEND_TIMEOUT_MS = 10_000;

/** The part of VS Code's secret storage this needs. */
export interface Secrets {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/**
 * Where pushes go, kept in VS Code's secret storage (the system keychain),
 * never in settings: settings can sync, and the topic is the only key to
 * the pushes.
 */
export class PushStore {
  private target?: PushTarget;
  private loaded = false;

  constructor(private readonly secrets: Secrets) {}

  /** Reads it again, e.g. after another window changed it. */
  async load(): Promise<PushTarget | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    this.target = undefined;
    try {
      const t = raw ? (JSON.parse(raw) as Partial<PushTarget>) : undefined;
      if (t && typeof t.server === 'string' && typeof t.topic === 'string') {
        this.target = { server: t.server, topic: t.topic, token: typeof t.token === 'string' && t.token ? t.token : undefined };
      }
    } catch {
      // Not ours to read; treat it as not set up.
    }
    this.loaded = true;
    return this.target;
  }

  /** What the last load or change said, without waiting. */
  peek(): PushTarget | undefined {
    return this.target;
  }

  async get(): Promise<PushTarget | undefined> {
    return this.loaded ? this.target : this.load();
  }

  async set(t: PushTarget): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(t));
    this.target = t;
    this.loaded = true;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.target = undefined;
    this.loaded = true;
  }

  static readonly KEY = SECRET_KEY;
}

/** Sends one push. Throws with a reason the user can act on. */
export async function sendPush(t: PushTarget, m: PushMessage): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t.token) headers.Authorization = `Bearer ${t.token}`;
  let res: Response;
  try {
    res = await fetch(t.server, { method: 'POST', headers, body: ntfyBody(t, m), signal: AbortSignal.timeout(SEND_TIMEOUT_MS), redirect: 'error' });
  } catch (e) {
    throw new Error(`could not reach ${new URL(t.server).host} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) {
    const why = res.status === 401 || res.status === 403 ? 'the server refused the access token' : res.status === 429 ? 'too many pushes for now' : `the server said ${res.status}`;
    throw new Error(why);
  }
}

/** How long since the last key press or mouse move, on macOS; undefined elsewhere or if it can't be read. */
export function systemIdleMs(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 2000, maxBuffer: 1 << 20 }, (err, out) => {
      resolve(err ? undefined : idleMsFromIoreg(out));
    });
  });
}
