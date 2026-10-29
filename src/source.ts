import { execFile } from 'node:child_process';
import { constants as fsc, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { countLines, emptyCost, sumTallies, type CostState, type Tally } from './core/cost';
import { lineage, parseAgentsJson, parsePs, projectSlug, toSession, withFileFields } from './core/parse';
import { readChunk, type Digest } from './core/transcript';
import type { Session } from './core/types';
import { alive } from './shared';

/** Where Claude Code keeps its state: `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The claude command: the configured path, else the first one on PATH or in
 * the usual install folders. A configured path must be absolute (after `~`).
 */
export async function findClaude(configured: string): Promise<string | undefined> {
  const expanded = configured.replace(/^~(?=$|\/)/, os.homedir());
  if (configured && !path.isAbsolute(expanded)) return undefined;
  const candidates = configured
    ? [expanded]
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

/** How much of the end of a transcript the first look reads at a time, and how far back it goes at most. */
const TAIL_BYTES = 1024 * 1024;
const MAX_BACK_BYTES = 16 * 1024 * 1024;
/** How long the CLI list is trusted while no session appears or disappears. */
const LIST_TTL_MS = 30_000;
/** How long to wait before looking again for a transcript that wasn't there. */
const MISSING_RETRY_MS = 30_000;
/** How much the cost count reads at a time, and the longest line it waits for before skipping it. */
const COST_CHUNK = 8 * 1024 * 1024;
const MAX_COST_LINE = 128 * 1024 * 1024;

interface CostFile extends CostState {
  /** Byte offset just past the last complete line counted. */
  offset: number;
}

/** A session's token totals: its own transcript plus its helper agents'. */
export interface SessionCost {
  tally: Tally;
  helpers: number;
}

interface Transcript {
  file?: string;
  missingSince?: number;
  /** Byte offset just past the last complete line read. */
  offset: number;
  digest: Digest;
}

/**
 * Reads what Claude Code says about its sessions. The list itself comes from
 * `claude agents --json` (the supported interface); the per-session status
 * files in `sessions/` add when each status changed, and the transcripts give
 * the titles and how each turn ended.
 */
export class SessionSource {
  readonly sessionsDir: string;
  private readonly projectsDir: string;
  private listed?: { at: number; key: string; sessions: Session[] };
  private transcripts = new Map<string, Transcript>();
  /** Cost counts by session id, then by transcript file. */
  private costs = new Map<string, Map<string, CostFile>>();
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

  /** What a session's transcript says, reading only what was added since the last call. */
  async digestOf(s: Session, now: number): Promise<Digest | undefined> {
    let t = this.transcripts.get(s.sessionId);
    if (!t) {
      t = { offset: 0, digest: {} };
      this.transcripts.set(s.sessionId, t);
    }
    if (!t.file) {
      // A session whose status moved since the last miss has likely written its transcript by now.
      const moved = (s.statusUpdatedAt ?? 0) > (t.missingSince ?? 0);
      if (t.missingSince !== undefined && now - t.missingSince < MISSING_RETRY_MS && !moved) return undefined;
      t.file = await this.findTranscript(s);
      if (!t.file) {
        t.missingSince = now;
        return undefined;
      }
    }
    try {
      await this.readNew(t);
    } catch (e) {
      this.log(`Could not read the transcript of ${s.name}: ${message(e)}`);
      t.file = undefined;
    }
    return t.digest;
  }

  private async readNew(t: Transcript): Promise<void> {
    const size = (await fs.stat(t.file!)).size;
    if (size < t.offset) Object.assign(t, { offset: 0, digest: {} });
    if (size === t.offset) return;
    const fh = await fs.open(t.file!, 'r');
    try {
      if (t.offset === 0 && size > TAIL_BYTES) {
        // First look at a long transcript: what matters is near the end.
        // Read backwards until a title and a reply turn up. Each chunk ends
        // where a line starts, so no line is cut in two; a line longer than
        // a chunk makes the next read reach twice as far back.
        let offset: number | undefined;
        let span = TAIL_BYTES;
        for (let end = size, n = 0; end > 0 && size - end < MAX_BACK_BYTES && span <= MAX_BACK_BYTES && n < 64; n++) {
          const start = Math.max(0, end - span);
          let buf = await readRange(fh, start, end);
          if (offset === undefined) {
            const nl = buf.lastIndexOf(0x0a);
            if (nl < 0 && start > 0) {
              span *= 2;
              continue;
            }
            // The newest line may still be being written; the next look reads it.
            offset = start + nl + 1;
            end = offset;
            buf = buf.subarray(0, nl + 1);
          }
          const cut = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
          if (start > 0 && (cut === 0 || cut >= buf.length)) {
            span *= 2;
            continue;
          }
          t.digest = readChunk(buf.subarray(cut).toString('utf8'), start + cut, t.digest);
          // The last kickoff prompt may sit a few replies back; a hand-over card needs it.
          if ((t.digest.customTitle || t.digest.aiTitle) && t.digest.reply && t.digest.kickoff) break;
          end = start + cut;
          span = TAIL_BYTES;
        }
        t.offset = offset ?? size;
        return;
      }
      // A transcript can grow a lot between two looks; the end is what matters.
      const start = Math.max(t.offset, size - MAX_BACK_BYTES);
      const buf = await readRange(fh, start, size);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      t.digest = readChunk(buf.subarray(0, lastNewline).toString('utf8'), start, t.digest);
      t.offset = start + lastNewline + 1;
    } finally {
      await fh.close();
    }
  }

  /**
   * What the session's tokens add up to. The first call reads its whole
   * transcript, and those of its helper agents (`<session id>/subagents/`
   * next to it); later calls read only what was added. Call digestOf first:
   * it finds the transcript.
   */
  async costOf(s: Session): Promise<SessionCost | undefined> {
    const main = this.transcripts.get(s.sessionId)?.file;
    if (!main) return undefined;
    let byFile = this.costs.get(s.sessionId);
    if (!byFile) {
      byFile = new Map();
      this.costs.set(s.sessionId, byFile);
    }
    const helpersDir = path.join(path.dirname(main), s.sessionId, 'subagents');
    const helpers = (await fs.readdir(helpersDir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .map((n) => path.join(helpersDir, n));
    const files = [main, ...helpers];
    for (const f of files) {
      let c = byFile.get(f);
      if (!c) {
        c = { offset: 0, ...emptyCost() };
        byFile.set(f, c);
      }
      try {
        await countNew(f, c);
      } catch (e) {
        this.log(`Could not count the tokens in ${path.basename(f)}: ${message(e)}`);
      }
    }
    return { tally: sumTallies(files.map((f) => byFile.get(f)!.tally)), helpers: helpers.length };
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
    for (const id of this.costs.keys()) if (!liveIds.has(id)) this.costs.delete(id);
  }
}

/** Counts the complete lines added to a transcript since the last call. */
async function countNew(file: string, c: CostFile): Promise<void> {
  const size = (await fs.stat(file)).size;
  if (size < c.offset) Object.assign(c, { offset: 0, ...emptyCost() });
  if (size === c.offset) return;
  const fh = await fs.open(file, 'r');
  try {
    let span = COST_CHUNK;
    while (c.offset < size) {
      const end = Math.min(size, c.offset + span);
      const buf = await readRange(fh, c.offset, end);
      const nl = buf.lastIndexOf(0x0a);
      if (nl < 0) {
        // The newest line may still be being written; the next look counts it.
        if (end >= size) return;
        if (span >= MAX_COST_LINE) {
          // No reply is this long; skip it. The broken rest fails to parse.
          c.offset = end;
          span = COST_CHUNK;
        } else {
          span *= 2;
        }
        continue;
      }
      countLines(buf.subarray(0, nl).toString('utf8'), c);
      c.offset += nl + 1;
      span = COST_CHUNK;
    }
  } finally {
    await fh.close();
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
