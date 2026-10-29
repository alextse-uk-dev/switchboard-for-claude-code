import { MAX_TODO } from './todo';

/** A to-do as the page draws it. */
export interface TodoView {
  id: string;
  text: string;
  from: 'claude' | 'you';
  /** The session's title, if it came from or belongs to one. */
  session?: string;
  /** The live session's card key, so a click can open it. */
  key?: string;
  createdAt: number;
  doneAt?: number;
}

/**
 * What the board's page can ask for. Card actions name a card by its key,
 * to-do actions name an item by its id.
 */
export type FromBoard =
  | { type: 'open' | 'seen' | 'next' | 'copy' | 'todo'; key: string }
  | { type: 'new' | 'todoClear' }
  | { type: 'todoAdd'; text: string }
  | { type: 'todoDone'; id: string; done: boolean }
  | { type: 'todoDelete'; id: string };

const CARD_ACTIONS: ReadonlySet<string> = new Set(['open', 'seen', 'next', 'copy', 'todo']);
const TODO_ID = /^[a-z]-[A-Za-z0-9-]{1,40}$/;

/** Accepts only the messages the page is meant to send. */
export function asMessage(m: unknown): FromBoard | 'ready' | { type: 'width'; px: number } | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const r = m as Record<string, unknown>;
  const id = typeof r.id === 'string' && TODO_ID.test(r.id) ? r.id : undefined;
  switch (r.type) {
    case 'ready':
      return 'ready';
    case 'new':
    case 'todoClear':
      return { type: r.type };
    case 'width':
      return typeof r.px === 'number' && Number.isFinite(r.px) && r.px > 0 ? { type: 'width', px: Math.round(r.px) } : undefined;
    case 'todoAdd':
      return typeof r.text === 'string' && r.text.trim() && r.text.length <= MAX_TODO ? { type: 'todoAdd', text: r.text } : undefined;
    case 'todoDone':
      return id && typeof r.done === 'boolean' ? { type: 'todoDone', id, done: r.done } : undefined;
    case 'todoDelete':
      return id ? { type: 'todoDelete', id } : undefined;
  }
  if (typeof r.type === 'string' && CARD_ACTIONS.has(r.type) && typeof r.key === 'string') {
    return { type: r.type as 'open', key: r.key };
  }
  return undefined;
}

