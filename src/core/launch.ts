/** The model aliases Claude Code accepts for its latest models, in the order the picker lists them. */
export const MODEL_ALIASES = [
  { id: 'opus', label: 'Opus', detail: 'The latest Opus' },
  { id: 'sonnet', label: 'Sonnet', detail: 'The latest Sonnet' },
  { id: 'haiku', label: 'Haiku', detail: 'The latest Haiku: the fastest and cheapest' },
  { id: 'fable', label: 'Fable', detail: 'The latest Fable: the most capable, and the most expensive' },
] as const;

/** Claude Code's effort levels, from least thinking to most. */
export const EFFORTS = [
  { id: 'low', detail: 'Quickest, least thinking' },
  { id: 'medium', detail: '' },
  { id: 'high', detail: '' },
  { id: 'xhigh', detail: '' },
  { id: 'max', detail: 'Most thinking, slowest' },
] as const;

const EFFORT_IDS: ReadonlySet<string> = new Set(EFFORTS.map((e) => e.id));

/** An alias or a full model id, such as `claude-opus-5-5` or `opus[1m]`. Anything else is refused. */
export function isModelId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,79}$/.test(s);
}

export function isEffort(s: string): boolean {
  return EFFORT_IDS.has(s);
}

/** What a new session gets when no model or effort is given. */
export interface Defaults {
  model?: string;
  effort?: string;
  /** Which settings file said so, for the picker's words. */
  from?: string;
}

/**
 * The model and effort Claude Code would use, from its settings files
 * ordered from weakest to strongest (user, project, local). A file that
 * doesn't parse is skipped.
 */
export function readDefaults(files: ReadonlyArray<{ name: string; text: string | undefined }>): Defaults {
  const out: Defaults = {};
  for (const f of files) {
    if (!f.text) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(f.text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    if (typeof o.model === 'string' && o.model) {
      out.model = o.model;
      out.from = f.name;
    }
    if (typeof o.effortLevel === 'string' && isEffort(o.effortLevel)) out.effort = o.effortLevel;
  }
  return out;
}

/** Wraps text in single quotes for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Launch {
  claude: string;
  name?: string;
  model?: string;
  effort?: string;
  task?: string;
}

/**
 * The /bin/sh command that starts a session. A model or effort that isn't
 * well formed is left out rather than passed on.
 */
export function launchCommand(l: Launch): string {
  const args = [shq(l.claude)];
  const name = l.name?.trim();
  if (name) args.push('-n', shq(name));
  if (l.model && isModelId(l.model)) args.push('--model', shq(l.model));
  if (l.effort && isEffort(l.effort)) args.push('--effort', l.effort);
  const task = l.task?.trim();
  // `--` stops a task that starts with "-" from being read as an option.
  if (task) args.push(...(task.startsWith('-') ? ['--'] : []), shq(task));
  return args.join(' ');
}
