/**
 * A kickoff prompt often leaves a slot for the user's answer, such as
 * "My third look: <looks fine / what's wrong>." These find such slots, so
 * the user can fill them in before the session starts instead of editing
 * the prompt by hand.
 */

export interface Choice {
  label: string;
  /** True when the choice asks for the user's own words, e.g. "what's wrong". */
  open: boolean;
}

export interface Blank {
  /** Where `<…>` starts and ends (end is exclusive) in the prompt. */
  start: number;
  end: number;
  /** The text between the angle brackets. */
  text: string;
  choices: Choice[];
}

// Words that start a choice the user answers in their own words.
const OPEN_START = /^(what|which|how|why|who|where|when|describe|explain|list|name|say|type|your|any|anything|other)\b/i;

function isBlankText(t: string): boolean {
  if (t.length < 2 || t.length > 200) return false;
  if (/^\s|\s$/.test(t)) return false; // "a < b and c > d" is not a slot
  if (/[<>\n="`]/.test(t)) return false; // nor is an HTML tag
  // A slot has words in it ("your verdict"), or is a list of choices ("yes/no").
  // A single word, such as `<id>` in a command, is the command's own placeholder.
  return /\s/.test(t) || /^[A-Za-z'-]+(\/[A-Za-z'-]+)+$/.test(t);
}

function choicesOf(t: string): Choice[] {
  const parts = t.split('/').map((p) => p.trim()).filter(Boolean);
  // One choice ("<your verdict>") always needs the user's own words.
  return parts.map((label) => ({ label, open: parts.length === 1 || OPEN_START.test(label) || /(\.\.\.|…)$/.test(label) }));
}

/** The slots in a prompt, in order. Text inside backticks is code, so it is never a slot. */
export function findBlanks(prompt: string): Blank[] {
  const out: Blank[] = [];
  let inCode = false;
  for (let i = 0; i < prompt.length; i++) {
    const c = prompt[i];
    if (c === '`') {
      inCode = !inCode;
      continue;
    }
    if (c !== '<' || inCode) continue;
    const close = prompt.indexOf('>', i + 1);
    if (close < 0) break;
    const text = prompt.slice(i + 1, close);
    if (!isBlankText(text)) continue;
    out.push({ start: i, end: close + 1, text, choices: choicesOf(text) });
    i = close;
  }
  return out;
}

/** The prompt with each slot replaced by its answer. A slot with no answer stays as it was. */
export function fillBlanks(prompt: string, blanks: readonly Blank[], answers: readonly (string | undefined)[]): string {
  let out = '';
  let at = 0;
  blanks.forEach((b, i) => {
    const a = answers[i]?.trim();
    out += prompt.slice(at, b.start) + (a ? a : prompt.slice(b.start, b.end));
    at = b.end;
  });
  return out + prompt.slice(at);
}

/** A few words around a slot, so the user sees what they are answering. */
export function blankContext(prompt: string, b: Blank, width = 60): string {
  const before = prompt.slice(Math.max(0, b.start - width), b.start).replace(/\s+/g, ' ');
  const after = prompt.slice(b.end, b.end + 20).replace(/\s+/g, ' ');
  const cut = b.start > width ? `…${before.replace(/^\S*\s/, '')}` : before;
  return `${cut}<${b.text}>${after}${b.end + 20 < prompt.length ? '…' : ''}`;
}
