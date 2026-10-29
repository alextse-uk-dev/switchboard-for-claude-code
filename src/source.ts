import { execFile } from 'node:child_process';
import { constants as fsc, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lineage, parseAgentsJson, parsePs, parseTitles, projectSlug, toSession, withFileFields } from './core/parse';
import type { Session, Titles } from './core/types';
import { alive } from './shared';

/** Where Claude Code keeps its state: `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The claude command: the configured path, else the first one on PATH or in the usual install folders. */
export async function findClaude(configured: string): Promise<string | undefined> {
  const candidates = configured
    ? [configured.replace(/^~(?=$|\/)/, os.homedir())]
    : [
        ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'claude')),
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
  for (const c of candidates) {
    try {
      await fs.access(c, fsc.X_OK);
      return c;
    } catch {
      // Not here; try the next one.
    }
  }
  return undefined;
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How far back the first title search reads, and how much of the end of a transcript at a time. */
const TAIL_BYTES = 1024 * 1024;
const MAX_BACK_BYTES = 16 * 1024 * 1024;
/** How long the CLI list is trusted while no session appears or disappears. */
const LIST_TTL_MS = 30_000;
/** How long to wait before looking again for a transcript that wasn't there. */
const MISSING_RETRY_MS = 30_000;

interface Transcript {
  file?: string;
  missingSince?: number;
  /** Byte offset just past the last complete line read. */
  offset: number;
  titles: Titles;
}

/**
 * Reads what Claude Code says about its sessions. The list itself comes from
 * `claude agents --json` (the supported interface); the per-session status
 * files in `sessions/` add when each status changed, and the transcripts give
 * the titles.
 */
export class SessionSource {
  readonly sessionsDir: string;
  private readonly projectsDir: string;
  private listed?: { at: number; key: string; sessions: Session[] };
  private transcripts = new Map<string, Transcript>();
  private parents = new Map<number, number>();

  constructor(
    configDir: string,
    private readonly claudePath: () => Promise<string | undefined>,
    private readonly log: (msg: string) => void,
  ) {
    this.sessionsDir = path.join(configDir, 'sessions');
    this.projectsDir = path.join(configDir, 'projects');
  }

  /** Every live session. Falls back to the status files alone if the CLI can't be run. */
  async list(now: number): Promise<Session[]> {
    const files = await this.readStatusFiles();
    const key = [...files.values()].map((s) => `${s.pid}:${s.sessionId}`).sort().join(',');
    const reuse = this.listed && this.listed.key === key && now - this.listed.at < LIST_TTL_MS;
    let sessions = reuse ? this.listed!.sessions : undefined;
    if (!sessions) {
      const claude = await this.claudePath();
      if (claude) {
        try {
          sessions = parseAgentsJson(await run(claude, ['agents', '--json'], 8000));
          this.listed = { at: now, key, sessions };
        } catch (e) {
          this.log(`claude agents --json failed, so the status files are read directly: ${message(e)}`);
        }
      }
    }
    const live = [...files.values()].filter((s) => alive(s.pid));
    if (!sessions) {
      this.listed = undefined;
      return live;
    }
    // A list that parses but names none of the running sessions means its
    // format has changed under us; the status files are the better guess.
    if (live.length && !sessions.some((s) => files.has(s.pid))) {
      this.log('claude agents --json listed none of the running sessions, so the status files are read directly.');
      return live;
    }
    return sessions.map((s) => withFileFields(s, files.get(s.pid)));
  }

  private async readStatusFiles(): Promise<Map<number, Session>> {
    const out = new Map<number, Session>();
    let names: string[];
    try {
      names = await fs.readdir(this.sessionsDir);
    } catch {
      return out;
    }
    await Promise.all(
      names
        .filter((n) => /^\d+\.json$/.test(n))
        .map(async (n) => {
          try {
            const s = toSession(JSON.parse(await fs.readFile(path.join(this.sessionsDir, n), 'utf8')));
            if (s) out.set(s.pid, s);
          } catch {
            // Half-written or removed while we read it; the next change brings it back.
          }
        }),
    );
    return out;
  }

  /** The newest titles in a session's transcript, reading only what was added since the last call. */
  async titlesOf(s: Session, now: number): Promise<Titles | undefined> {
    let t = this.transcripts.get(s.sessionId);
    if (!t) {
      t = { offset: 0, titles: {} };
      this.transcripts.set(s.sessionId, t);
    }
    if (!t.file) {
      if (t.missingSince !== undefined && now - t.missingSince < MISSING_RETRY_MS) return undefined;
      t.file = await this.findTranscript(s);
      if (!t.file) {
        t.missingSince = now;
        return undefined;
      }
    }
    try {
      await this.readNewTitles(t);
    } catch (e) {
      this.log(`Could not read the title of ${s.name}: ${message(e)}`);
      t.file = undefined;
    }
    return t.titles;
  }

  private async readNewTitles(t: Transcript): Promise<void> {
    const size = (await fs.stat(t.file!)).size;
    if (size < t.offset) Object.assign(t, { offset: 0, titles: {} });
    if (size === t.offset) return;
    const fh = await fs.open(t.file!, 'r');
    try {
      if (t.offset === 0 && size > TAIL_BYTES) {
        // First look at a long transcript: titles are re-written often, so
        // the newest one is near the end. Read backwards until one turns up.
        for (let end = size; end > 0 && size - end < MAX_BACK_BYTES; end -= TAIL_BYTES) {
          const start = Math.max(0, end - TAIL_BYTES);
          const found = parseTitles((await readRange(fh, start, end)).toString('utf8'));
          t.titles = { customTitle: t.titles.customTitle ?? found.customTitle, aiTitle: t.titles.aiTitle ?? found.aiTitle };
          if (t.titles.customTitle || t.titles.aiTitle) break;
        }
        t.offset = size;
        return;
      }
      // A transcript can grow a lot between two looks; the end is what matters.
      const start = Math.max(t.offset, size - MAX_BACK_BYTES);
      const buf = await readRange(fh, start, size);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      t.titles = parseTitles(buf.subarray(0, lastNewline).toString('utf8'), t.titles);
      t.offset = start + lastNewline + 1;
    } finally {
      await fh.close();
    }
  }

  private async findTranscript(s: Session): Promise<string | undefined> {
    const name = `${s.sessionId}.jsonl`;
    const direct = path.join(this.projectsDir, projectSlug(s.cwd), name);
    if (await exists(direct)) return direct;
    // The folder naming may differ from ours; look in every project folder once.
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(this.projectsDir);
    } catch {
      return undefined;
    }
    for (const d of dirs) {
      const p = path.join(this.projectsDir, d, name);
      if (await exists(p)) return p;
    }
    return undefined;
  }

  /** Each pid and its nearest ancestors, for matching a session to the shell of a terminal tab. */
  async lineages(pids: readonly number[]): Promise<Map<number, number[]>> {
    if (pids.some((p) => !this.parents.has(p))) {
      try {
        this.parents = parsePs(await run('ps', ['-A', '-o', 'pid=,ppid='], 4000));
      } catch (e) {
        this.log(`ps failed, so tabs can't be matched: ${message(e)}`);
      }
    }
    return new Map(pids.map((p) => [p, lineage(p, this.parents)]));
  }

  /** Drops cached state for sessions that have ended. */
  forget(liveIds: ReadonlySet<string>): void {
    for (const id of this.transcripts.keys()) if (!liveIds.has(id)) this.transcripts.delete(id);
  }
}

async function readRange(fh: fs.FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.alloc(end - start);
  const { bytesRead } = await fh.read(buf, 0, buf.length, start);
  return buf.subarray(0, bytesRead);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
