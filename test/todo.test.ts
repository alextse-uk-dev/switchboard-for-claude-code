import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { asMessage } from '../src/core/messages';
import { applyOp, askId, asksOf, parseTodos, prune, serializeTodos, shownTodos, syncAsks, type Todo } from '../src/core/todo';
import { TodoStore } from '../src/todos';

test('asksOf picks the lines labelled for you, in full', () => {
  const reply = [
    'The branch is merged.',
    '',
    '**Needs you:** delete the merged branches `fix/login` and `feat/export`, locally and on GitHub. My delete was blocked by the permission check, so it has to be you.',
    '',
    '1. Tests pass.',
    '2. **You:** run **Reload Window** once.',
    'Needs you: approve the [deploy](https://example.com).',
  ].join('\n');
  assert.deepEqual(asksOf(reply), [
    'delete the merged branches fix/login and feat/export, locally and on GitHub. My delete was blocked by the permission check, so it has to be you.',
    'run Reload Window once.',
    'approve the deploy.',
  ]);
});

test('asksOf skips "nothing", a bare "You:", and labels without a colon', () => {
  assert.deepEqual(asksOf('**Needs you:** nothing.\nNeeds you: none\n**Needs you:** nothing — CI is green.\nNeeds you: none right now.\nNeeds you: —'), []);
  assert.deepEqual(asksOf('Needs you: now run the deploy.'), ['now run the deploy.'], '"now" is not "no"');
  assert.deepEqual(asksOf('You: the reviewer, me: the author.'), []);
  assert.deepEqual(asksOf('The board has sections:\n- **Needs you**\n  - a permission prompt\n- **Done**'), []);
});

test('asksOf reads the list under a heading for you, and stops where it ends', () => {
  const reply = [
    '## Status',
    '- Everything is green.',
    '',
    '### Needs you',
    '- Run the migration on staging.',
    '  It takes about a minute.',
    '  - It is the cost one.',
    '  - CI is green.',
    '',
    '- Tell me which of the two names you prefer.',
    '',
    'Then I can carry on.',
    '- Not an ask: this list follows a paragraph.',
    '',
    '**Your steps:**',
    '1. Open the preview.',
  ].join('\n');
  assert.deepEqual(asksOf(reply), ['Run the migration on staging.', 'Tell me which of the two names you prefer.', 'Open the preview.']);
});

test('asksOf ignores code blocks and tables', () => {
  const reply = ['```', 'Needs you: in a code block', '```', '| Needs you: | in a table |', '~~~md', '### Needs you', '- fenced', '~~~'].join('\n');
  assert.deepEqual(asksOf(reply), []);
});

test('syncAsks adds a reply\'s asks once, and never brings back one you deleted or ticked', () => {
  const asks = (texts: string[], sessionId = 's1') => [{ sessionId, session: 'Fix login', texts }];
  const one = syncAsks([], asks(['Run the migration.', 'Run the migration.']), 10)!;
  assert.equal(one.length, 1);
  assert.equal(one[0].id, askId('s1', 'Run the migration.'));
  assert.equal(one[0].from, 'claude');
  assert.equal(syncAsks(one, asks(['Run the migration.']), 20), undefined, 'the same reply again changes nothing');
  const deleted = applyOp(one, { op: 'delete', id: one[0].id }, 30)!;
  assert.equal(deleted[0].deletedAt, 30, 'an ask is kept as a marker');
  assert.equal(syncAsks(deleted, asks(['Run the migration.']), 40), undefined);
  const ticked = applyOp(one, { op: 'done', id: one[0].id, done: true }, 30)!;
  assert.equal(syncAsks(ticked, asks([]), 40), undefined, 'a ticked ask stays ticked');
  assert.equal(syncAsks(one, asks(['Run the migration.'], 's2'), 50)?.length, 2, 'the same words from another session are another item');
});

test('syncAsks clears what a session has moved past, and brings it back if asked again', () => {
  const s = (texts: string[]) => [{ sessionId: 's1', session: 'Release', texts }];
  let list = syncAsks([], s(['Check the exclusion list.', 'Pick a template.']), 1)!;
  list = applyOp(list, { op: 'add', id: 'u-1', text: 'My own note', sessionId: 's1', session: 'Release' }, 2)!;
  // The next reply asks something else: the earlier asks were answered.
  list = syncAsks(list, s(['Run free-set.sh again.']), 3)!;
  const shown = (l: Todo[]) => shownTodos(l, 4).map((t) => t.text).sort();
  assert.deepEqual(shown(list), ['My own note', 'Run free-set.sh again.'], 'your own items are never cleared');
  assert.equal(list.find((t) => t.text === 'Pick a template.')?.clearedAt, 3);
  // A reply that asks nothing clears the rest; asking again brings an ask back.
  list = syncAsks(list, s([]), 5)!;
  assert.deepEqual(shown(list), ['My own note']);
  list = syncAsks(list, s(['Pick a template.']), 6)!;
  assert.deepEqual(shown(list), ['My own note', 'Pick a template.']);
  assert.equal(list.filter((t) => t.text === 'Pick a template.').length, 1, 'brought back, not copied');
  assert.equal(syncAsks(list, [{ sessionId: 's2', session: 'Other', texts: [] }], 7), undefined, 'other sessions are not touched');
});

test('shownTodos: ticked items leave after a day; deleted and cleared ones never show', () => {
  const day = 24 * 60 * 60 * 1000;
  const list: Todo[] = [
    { id: 'u-1', text: 'open', from: 'you', createdAt: 0 },
    { id: 'u-2', text: 'ticked lately', from: 'you', createdAt: 0, doneAt: 10 * day },
    { id: 'u-3', text: 'ticked long ago', from: 'you', createdAt: 0, doneAt: 1 },
    { id: 'c-4', text: 'deleted', from: 'claude', createdAt: 0, deletedAt: 1 },
    { id: 'c-5', text: 'cleared', from: 'claude', createdAt: 0, clearedAt: 1 },
  ];
  assert.deepEqual(shownTodos(list, 10.5 * day).map((t) => t.id), ['u-1', 'u-2']);
});

test('applyOp: add, tick, untick, delete and clear', () => {
  let list: Todo[] = applyOp([], { op: 'add', id: 'u-1', text: '  Buy   milk  ' }, 1)!;
  assert.deepEqual(list, [{ id: 'u-1', text: 'Buy milk', from: 'you', sessionId: undefined, session: undefined, createdAt: 1 }]);
  assert.equal(applyOp(list, { op: 'add', id: 'u-2', text: '   ' }, 2), undefined);
  assert.equal(applyOp(list, { op: 'add', id: 'u-1', text: 'again' }, 2), undefined, 'an id is added once');
  list = applyOp(list, { op: 'done', id: 'u-1', done: true }, 3)!;
  assert.equal(list[0].doneAt, 3);
  assert.equal(applyOp(list, { op: 'done', id: 'u-1', done: true }, 4), undefined);
  list = applyOp(list, { op: 'done', id: 'u-1', done: false }, 5)!;
  assert.equal(list[0].doneAt, undefined);
  list = syncAsks(list, [{ sessionId: 's', session: 'S', texts: ['Approve it.'] }], 6)!;
  list = applyOp(list, { op: 'done', id: list[1].id, done: true }, 7)!;
  list = applyOp(list, { op: 'done', id: 'u-1', done: true }, 8)!;
  list = applyOp(list, { op: 'clearDone' }, 9)!;
  assert.deepEqual(list.map((t) => [t.from, t.deletedAt]), [['claude', 9]], 'your own go; asks stay as markers');
  assert.equal(applyOp(list, { op: 'clearDone' }, 10), undefined);
  assert.equal(applyOp([], { op: 'delete', id: 'u-9' }, 10), undefined);
});

test('prune drops items ended over 30 days ago; parseTodos keeps only well-formed items', () => {
  const day = 24 * 60 * 60 * 1000;
  const list: Todo[] = [
    { id: 'u-1', text: 'open', from: 'you', createdAt: 0 },
    { id: 'u-2', text: 'done long ago', from: 'you', createdAt: 0, doneAt: 0 },
    { id: 'c-3', text: 'deleted lately', from: 'claude', createdAt: 0, deletedAt: 20 * day },
    { id: 'c-4', text: 'cleared long ago', from: 'claude', createdAt: 0, clearedAt: 0 },
  ];
  assert.deepEqual(prune(list, 31 * day).map((t) => t.id), ['u-1', 'c-3']);
  const text = serializeTodos(list).replace('"items": [', '"items": [{"id":"x"}, 7, {"id":"u-9","text":"t","from":"robot","createdAt":1},');
  assert.deepEqual(parseTodos(text), list);
  assert.deepEqual(parseTodos('not json'), []);
});

test('two windows changing the list at the same moment both keep their change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-todo-'));
  try {
    const a = new TodoStore(dir);
    const b = new TodoStore(dir);
    await Promise.all([
      a.change({ op: 'add', id: 'u-a1', text: 'A1' }, 1),
      b.change({ op: 'add', id: 'u-b1', text: 'B1' }, 1),
      a.change({ op: 'add', id: 'u-a2', text: 'A2' }, 2),
      b.syncAsks([{ sessionId: 's', session: 'S', texts: ['Approve it.'] }], 2),
    ]);
    const c = new TodoStore(dir);
    await c.load();
    assert.deepEqual(c.list.map((t) => t.text).sort(), ['A1', 'A2', 'Approve it.', 'B1']);
    await assert.rejects(fs.access(`${c.file}.lock`), 'the lock is let go');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a lock left by a crashed window is taken over once it is stale', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-todo-'));
  try {
    const a = new TodoStore(dir);
    await fs.writeFile(`${a.file}.lock`, '999999');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${a.file}.lock`, old, old);
    assert.equal(await a.change({ op: 'add', id: 'u-1', text: 'still works' }, 1), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('two windows changing the list one after the other keep each other\'s changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-todo-'));
  try {
    const a = new TodoStore(dir);
    const b = new TodoStore(dir);
    await a.change({ op: 'add', id: 'u-a', text: 'from A' }, 1);
    await b.change({ op: 'add', id: 'u-b', text: 'from B' }, 2);
    await a.syncAsks([{ sessionId: 's', session: 'S', texts: ['Approve it.'] }], 3);
    assert.equal(await b.load(), true);
    assert.deepEqual(b.list.map((t) => t.text), ['from A', 'from B', 'Approve it.']);
    assert.equal(await b.load(), false, 'an unchanged file is not news');
    assert.equal(await a.syncAsks([], 4), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('asMessage accepts only what the page is meant to send', () => {
  assert.deepEqual(asMessage({ type: 'todoAdd', text: 'Ring Sam' }), { type: 'todoAdd', text: 'Ring Sam' });
  assert.equal(asMessage({ type: 'todoAdd', text: '   ' }), undefined);
  assert.equal(asMessage({ type: 'todoAdd', text: 'x'.repeat(10_001) }), undefined);
  assert.deepEqual(asMessage({ type: 'todoDone', id: 'c-0123abcd', done: true }), { type: 'todoDone', id: 'c-0123abcd', done: true });
  assert.equal(asMessage({ type: 'todoDone', id: '../../etc', done: true }), undefined);
  assert.equal(asMessage({ type: 'todoDelete', id: 7 }), undefined);
  assert.deepEqual(asMessage({ type: 'width', px: 301.6 }), { type: 'width', px: 302 });
  assert.equal(asMessage({ type: 'width', px: -1 }), undefined);
  assert.deepEqual(asMessage({ type: 'todo', key: '1:abc' }), { type: 'todo', key: '1:abc' });
  assert.deepEqual(asMessage({ type: 'todoClear', extra: 'ignored' }), { type: 'todoClear' });
  assert.equal(asMessage({ type: 'exec', key: 'x' }), undefined);
  assert.equal(asMessage('ready'), undefined);
});
