import type { Status } from './types';

/** How long the window must stay quiet, over two looks, before it reloads. */
export const QUIET_MS = 5_000;
/** How long a task or a debug session alone may hold a reload back before the notice shows instead. */
export const BLOCKED_MS = 10 * 60_000;

/** `x.y.z` as three numbers, or undefined for anything else. */
export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Below 0 if a is older than b, 0 if the same, above 0 if newer. Numeric, so 0.10.0 is newer than 0.9.0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The version in an installed extension's folder name,
 * `<publisher>.<name>-<x.y.z>`, maybe with a `-<platform>` suffix.
 * Undefined for another extension's folder.
 */
export function folderVersion(folder: string, id: string): string | undefined {
  const name = folder.toLowerCase();
  const prefix = `${id.toLowerCase()}-`;
  if (!name.startsWith(prefix)) return undefined;
  const m = /^(\d+\.\d+\.\d+)(?:-[a-z0-9]+)*$/.exec(name.slice(prefix.length));
  return m?.[1];
}

/** The folder names VS Code's `.obsolete` file lists (a JSON object keyed by folder). Bad JSON lists none. */
export function obsoleteFolders(text: string | undefined): Set<string> {
  if (!text) return new Set();
  try {
    const o: unknown = JSON.parse(text);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return new Set();
    return new Set(Object.entries(o as Record<string, unknown>).filter(([, v]) => v).map(([k]) => k));
  } catch {
    return new Set();
  }
}

export interface Installed {
  name: string;
  /** The folder holds a package.json. */
  hasPackage: boolean;
}

/** The newest install of this extension that is newer than the running one, if any. */
export function newestInstalled(o: { id: string; running: string; folders: readonly Installed[]; obsolete: ReadonlySet<string> }): { folder: string; version: string } | undefined {
  let best: { folder: string; version: string } | undefined;
  for (const f of o.folders) {
    const version = folderVersion(f.name, o.id);
    if (!version || !f.hasPackage || o.obsolete.has(f.name)) continue;
    if (compareVersions(version, o.running) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { folder: f.name, version };
  }
  return best;
}

/**
 * A session in this window's tabs is mid-turn unless it is idle: working, or
 * stopped at a permission prompt or a question. A status that can't be read
 * counts as mid-turn.
 */
export function midTurn(statuses: readonly Status[]): boolean {
  return statuses.some((s) => s !== 'idle');
}

export interface Look {
  /** The newer version installed. */
  target: string;
  /** `switchboard.update.reloadWindow`. */
  enabled: boolean;
  /** `terminal.integrated.enablePersistentSessions`: without it, terminals don't survive a reload. */
  persistentTerminals: boolean;
  /** The version this window already reloaded for, and is still not on. */
  tried?: string;
  /** The version the user said "Not now" to in this window. */
  declined?: string;
  /** A Claude session in this window's tabs is mid-turn. */
  midTurn: boolean;
  /** A debug session or a task runs in this window. */
  running: boolean;
  /** When the window was first seen quiet, in a row of quiet looks. */
  quietSince?: number;
  /** When the window was first seen held back only by a task or a debug session, in a row of such looks. */
  blockedSince?: number;
  now: number;
}

export type Decision = { do: 'reload' } | { do: 'wait'; quietSince?: number; blockedSince?: number } | { do: 'notice' };

/**
 * What to do about a newer version: reload the window, wait for it to go
 * quiet, or only say so. A reload needs two quiet looks in a row, at least
 * QUIET_MS apart, so a session between two tool calls isn't taken for done.
 * A mid-turn session is waited for without limit; a task or a debug session
 * (a watch build, a dev server) only for BLOCKED_MS, then the notice.
 */
export function decide(l: Look): Decision {
  if (!l.enabled || !l.persistentTerminals) return { do: 'notice' };
  if (l.tried === l.target || l.declined === l.target) return { do: 'notice' };
  if (l.midTurn) return { do: 'wait' };
  if (l.running) {
    const since = l.blockedSince === undefined || l.now < l.blockedSince ? l.now : l.blockedSince;
    return l.now - since >= BLOCKED_MS ? { do: 'notice' } : { do: 'wait', blockedSince: since };
  }
  if (l.quietSince === undefined || l.now < l.quietSince) return { do: 'wait', quietSince: l.now };
  if (l.now - l.quietSince >= QUIET_MS) return { do: 'reload' };
  return { do: 'wait', quietSince: l.quietSince };
}

/** What is written just before the window reloads for an update. */
export interface ReloadRecord {
  from: string;
  to: string;
  at: number;
}

export function parseReloadRecord(v: unknown): ReloadRecord | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.at !== 'number') return undefined;
  if (!parseVersion(r.from) || !parseVersion(r.to)) return undefined;
  return { from: r.from, to: r.to, at: r.at };
}

/**
 * On starting after a reload for an update: say it worked, or, if the window
 * still runs an older version, remember the version it tried so it never
 * reloads for it again.
 */
export function afterReload(r: ReloadRecord, running: string): { say: 'updated' } | { say: 'notice'; tried: string } {
  return compareVersions(running, r.to) >= 0 ? { say: 'updated' } : { say: 'notice', tried: r.to };
}

export function reloadingText(name: string, to: string): string {
  return `${name} ${to} is installed. This window reloads in 5 seconds. Claude sessions in its terminal tabs keep running.`;
}

export function updatedText(name: string, from: string, to: string): string {
  return `${name} updated from ${from} to ${to} and reloaded this window. Claude sessions in its terminal tabs kept running.`;
}

export function noticeText(name: string, to: string): string {
  return `${name} ${to} is installed. Reload this window to use it.`;
}
