import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { toCard } from '../src/core/card';
import { groupWithJob, helperLines, isStale, jobCardFile, jobChips, jobLine, jobTip, parseJobCard, STALE_MS } from '../src/core/jobcard';
import { groupOf } from '../src/core/model';
import { toSession } from '../src/core/parse';
import { applyOp, askId, cardAskId, normalAsk, parseTodos, serializeTodos, shownTodos, syncAsks, syncCardAsks, type Todo } from '../src/core/todo';
import { JobCardStore, jobCardsDir } from '../src/jobcards';
import { TodoStore } from '../src/todos';

const ID = '0a1b2c3d-1111-2222-3333-444455556666';
const NOW = Date.parse('2026-11-03T04:00:00Z');

const example = {
  program: 'example-app',
  role: 'orchestrator',
  goal: 'move invoices to the new schema',
  step: 2,
  of: 7,
  next: 'run the migration on staging',
  blockedOn: null,
  needsYou: ['approve the migration plan'],
  eta: '2026-11-05',
  helpers: [{ id: 'agent-3', name: 'reviewer', task: 'review the migration diff', state: 'running' }],
  updatedAt: '2026-11-03T03:40:00Z',
};

test('parseJobCard reads the convention, and ignores what it does not know', () => {
  const c = parseJobCard(JSON.stringify({ ...example, colour: 'blue', extra: { deep: [1, 2] } }))!;
  assert.equal(c.program, 'example-app');
  assert.equal(c.role, 'orchestrator');
  assert.equal(c.step, 2);
  assert.equal(c.of, 7);
  assert.equal(c.blockedOn, undefined, 'null is not set');
  assert.deepEqual(c.needsYou, ['approve the migration plan']);
  assert.deepEqual(c.helpers, [{ id: 'agent-3', name: 'reviewer', task: 'review the migration diff', state: 'running' }]);
  assert.equal(c.updatedAt, Date.parse('2026-11-03T03:40:00Z'));
  assert.equal((c as unknown as Record<string, unknown>).colour, undefined);
});

test('parseJobCard tolerates bad JSON and wrong types', () => {
  assert.equal(parseJobCard('{ "program": '), undefined);
  assert.equal(parseJobCard('[1, 2]'), undefined);
  assert.equal(parseJobCard('null'), undefined);
  assert.equal(parseJobCard('"example-app"'), undefined);
  const c = parseJobCard(JSON.stringify({ program: 42, step: 'two', of: -1, needsYou: [null, '  ', 'sign off', 'sign off', 7], helpers: 'none', updatedAt: 'whenever' }), 1234)!;
  assert.equal(c.program, undefined);
  assert.equal(c.step, undefined);
  assert.equal(c.of, undefined);
  assert.deepEqual(c.needsYou, ['sign off'], 'blanks, non-text and repeats dropped');
  assert.deepEqual(c.helpers, []);
  assert.equal(c.updatedAt, 1234, 'an unreadable time falls back to the file time');
  assert.deepEqual(parseJobCard('{"needsYou": "approve it"}')!.needsYou, ['approve it'], 'one ask as plain text');
  assert.deepEqual(parseJobCard('{"helpers": [null, {"state": "idle"}, {"id": 3}]}')!.helpers, [{ id: '3' }], 'a helper with no id, name or task is dropped');
});

test('jobLine: program, step and next, as the card shows them', () => {
  const c = parseJobCard(JSON.stringify(example))!;
  assert.equal(jobLine(c), 'example-app · step 2 of 7 · next: run the migration on staging');
  assert.equal(jobLine(parseJobCard('{"goal": "ship example-app", "step": 3}')!), 'ship example-app · step 3', 'the goal stands in for a missing program');
  assert.equal(jobLine(parseJobCard('{"next": "tests"}')!), 'next: tests');
  assert.equal(jobLine(parseJobCard('{}')!), '');
});

test('helperLines: one line each, at most three, then +N more', () => {
  assert.deepEqual(helperLines(parseJobCard(JSON.stringify(example))!), ['↳ reviewer: review the migration diff (running)']);
  const many = parseJobCard(JSON.stringify({ helpers: [1, 2, 3, 4, 5].map((i) => ({ id: `agent-${i}`, task: `part ${i}` })) }))!;
  assert.deepEqual(helperLines(many), ['↳ agent-1: part 1', '↳ agent-2: part 2', '↳ agent-3: part 3', '+2 more']);
  assert.deepEqual(helperLines(parseJobCard('{"helpers": [{"name": "tester"}]}')!), ['↳ tester']);
});

test('a card older than a day by updatedAt is stale', () => {
  const c = parseJobCard(JSON.stringify(example))!;
  assert.equal(isStale(c, NOW), false);
  assert.equal(isStale(c, c.updatedAt! + STALE_MS - 1), false);
  assert.equal(isStale(c, c.updatedAt! + STALE_MS), true);
  assert.equal(isStale(parseJobCard('{}')!, NOW), false, 'no time at all is not stale');
  assert.ok(jobTip(c, c.updatedAt! + STALE_MS).some((l) => l.endsWith('(stale)')));
});

test('jobChips: blocked, and needs you', () => {
  assert.deepEqual(jobChips(parseJobCard(JSON.stringify(example))!), ['needs you']);
  assert.deepEqual(jobChips(parseJobCard('{"blockedOn": "CI is red", "needsYou": ["look at CI"]}')!), ['blocked', 'needs you']);
  assert.deepEqual(jobChips(parseJobCard('{"needsYou": []}')!), []);
});

test('jobTip lists the whole card', () => {
  const tip = jobTip(parseJobCard(JSON.stringify({ ...example, blockedOn: 'staging is down' }))!, NOW);
  assert.deepEqual(tip, [
    'Program: example-app (orchestrator)',
    'Goal: move invoices to the new schema',
    'Step: 2 of 7',
    'Next: run the migration on staging',
    'Blocked on: staging is down',
    'Needs you: approve the migration plan',
    'ETA: 2026-11-05',
    'Helper reviewer: review the migration diff (running)',
    'Updated 2026-11-03T03:40:00Z',
    'From the job card a tool wrote for this session.',
  ]);
});

const session = (status: 'idle' | 'busy' | 'waiting') =>
  toSession({ pid: 7, sessionId: ID, cwd: '/work/example-app', kind: 'interactive', name: 'example-app-1', status })!;

test('a session whose card needs you sorts into Needs you, even if its reply asked nothing', () => {
  const card = parseJobCard(JSON.stringify(example))!;
  const none = parseJobCard('{"program": "example-app"}')!;
  assert.equal(groupWithJob(groupOf(session('idle'), { kind: 'done' }), session('idle'), card), 'needs');
  assert.equal(groupWithJob('handoff', session('idle'), card), 'needs');
  assert.equal(groupWithJob('done', session('idle'), none), 'done', 'a card with nothing for you changes nothing');
  assert.equal(groupWithJob('done', session('idle'), undefined), 'done');
  assert.equal(groupWithJob('working', session('busy'), card), 'working', 'a working session stays under Working, with its chip');
  assert.equal(groupWithJob('needs', session('waiting'), card), 'needs');
});

test('toCard: the job line, helpers, chips and stale mark', () => {
  const job = parseJobCard(JSON.stringify({ ...example, blockedOn: 'staging is down' }))!;
  const c = toCard({ s: session('idle'), title: 'Invoices', group: 'needs', outcome: { kind: 'done' }, unread: false, where: 'here', freshTokens: 0, home: '', job, now: NOW });
  assert.equal(c.job?.line, 'example-app · step 2 of 7 · next: run the migration on staging');
  assert.deepEqual(c.job?.helpers, ['↳ reviewer: review the migration diff (running)']);
  assert.equal(c.job?.stale, false);
  assert.ok(c.job?.tip.includes('Blocked on: staging is down'));
  assert.deepEqual(c.chips, ['blocked', 'needs you']);
  assert.equal(c.state, 'needs you', 'not "waiting for you": the session itself is idle');
  const old = toCard({ s: session('idle'), title: 'Invoices', group: 'done', unread: false, where: 'here', freshTokens: 0, home: '', job, now: NOW + 2 * STALE_MS });
  assert.equal(old.job?.stale, true);
  const without = toCard({ s: session('idle'), title: 'Invoices', group: 'done', unread: false, where: 'here', freshTokens: 0, home: '' });
  assert.equal(without.job, undefined);
  assert.deepEqual(without.chips, []);
  const empty = toCard({ s: session('idle'), title: 'x', group: 'done', unread: false, where: 'here', freshTokens: 0, home: '', job: parseJobCard('{"role": "worker"}')!, now: NOW });
  assert.equal(empty.job, undefined, 'a card with nothing to show draws nothing');
});

test('toCard: a question or a hand-over moved under Needs you keeps its words and Start next', () => {
  const job = parseJobCard(JSON.stringify(example))!;
  const q = toCard({ s: session('idle'), title: 'x', group: 'needs', outcome: { kind: 'question', ask: 'Ship it?' }, unread: false, where: 'here', freshTokens: 0, home: '', job, now: NOW });
  assert.equal(q.detail, 'Ship it?');
  assert.equal(q.quote, true);
  const h = toCard({ s: session('idle'), title: 'x', group: 'needs', outcome: { kind: 'handoff', reason: 'kickoff', prompt: 'Carry on.' }, unread: false, where: 'here', freshTokens: 0, home: '', job, now: NOW });
  assert.equal(h.handoff, true);
  assert.equal(h.prompt, true);
  const d = toCard({ s: session('idle'), title: 'x', group: 'done', outcome: { kind: 'done' }, unread: false, where: 'here', freshTokens: 0, home: '' });
  assert.equal(d.handoff, false);
});

test('jobCardFile only takes a session id', () => {
  assert.equal(jobCardFile(ID), `${ID}.json`);
  assert.equal(jobCardFile('../../etc/passwd'), undefined);
  assert.equal(jobCardFile('a/b'), undefined);
  assert.equal(jobCardFile(''), undefined);
});

test('jobCardsDir: ~ expanded, and the default for nothing or a relative path', () => {
  assert.equal(jobCardsDir(undefined, '/home/u'), path.join('/home/u', '.claude', 'job-cards'));
  assert.equal(jobCardsDir('', '/home/u'), path.join('/home/u', '.claude', 'job-cards'));
  assert.equal(jobCardsDir('~/.claude/job-cards', '/home/u'), path.join('/home/u', '.claude', 'job-cards'));
  assert.equal(jobCardsDir('~/cards', '/home/u'), path.join('/home/u', 'cards'));
  assert.equal(jobCardsDir('/var/cards', '/home/u'), '/var/cards');
  assert.equal(jobCardsDir('cards', '/home/u'), path.join('/home/u', '.claude', 'job-cards'));
});

test('JobCardStore reads live sessions\' cards, tolerates a missing folder or bad file, and sees changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-jobs-'));
  try {
    const dir = path.join(root, 'job-cards');
    const store = new JobCardStore(dir);
    assert.equal((await store.read([ID])).size, 0, 'no folder yet');
    await fs.mkdir(dir);
    assert.equal((await store.read([ID])).size, 0, 'no file');
    const file = path.join(dir, `${ID}.json`);
    await fs.writeFile(file, '{ "program": ');
    assert.equal((await store.read([ID])).size, 0, 'half-written');
    await fs.writeFile(file, JSON.stringify(example));
    const t = new Date(Date.now() + 5000);
    await fs.utimes(file, t, t);
    const cards = await store.read([ID, 'not a session id']);
    assert.equal(cards.get(ID)?.program, 'example-app');
    assert.equal(cards.size, 1);
    await fs.writeFile(file, JSON.stringify({ ...example, step: 3 }));
    const t2 = new Date(Date.now() + 10_000);
    await fs.utimes(file, t2, t2);
    assert.equal((await store.read([ID])).get(ID)?.step, 3, 'a changed file is read again');
    await fs.rm(file);
    assert.equal((await store.read([ID])).size, 0, 'a removed card is gone');
    // Another folder, from the setting.
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, `${ID}.json`), '{"program": "example-app-2"}');
    store.setDir(other);
    assert.equal((await store.read([ID])).get(ID)?.program, 'example-app-2');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const asks = (texts: string[], sessionId = ID) => [{ sessionId, session: 'Invoices', texts }];

test('syncCardAsks adds a card\'s needs, and clears them when the card no longer lists them', () => {
  let list = syncCardAsks([], asks(['approve the migration plan', 'approve the migration plan.']), 1)!;
  assert.equal(list.length, 1, 'the same ask twice is one item');
  assert.equal(list[0].id, cardAskId(ID, 'approve the migration plan'));
  assert.equal(list[0].via, 'card');
  assert.equal(list[0].from, 'claude');
  assert.equal(syncCardAsks(list, asks(['Approve the migration plan']), 2), undefined, 'the same card again changes nothing');
  list = syncCardAsks(list, asks(['sign the release']), 3)!;
  assert.deepEqual(shownTodos(list, 4).map((t) => t.text), ['sign the release']);
  list = syncCardAsks(list, asks(['approve the migration plan', 'sign the release']), 5)!;
  assert.deepEqual(shownTodos(list, 6).map((t) => t.text).sort(), ['approve the migration plan', 'sign the release'], 'asked again, it comes back');
  list = syncCardAsks(list, asks([]), 7)!;
  assert.deepEqual(shownTodos(list, 8), [], 'an empty card clears them all');
});

test('a card\'s needs and a reply\'s asks show once, by normalised text, and each source clears only its own', () => {
  // The reply asks it first: the card's item is not added.
  let list = syncAsks([], asks(['**Approve** the migration plan.']), 1)!;
  assert.equal(syncCardAsks(list, asks(['approve the  migration plan']), 2), undefined);
  // The card adds one more; the reply's ask stays.
  list = syncCardAsks(list, asks(['approve the migration plan', 'sign the release']), 3)!;
  assert.deepEqual(shownTodos(list, 4).map((t) => t.text).sort(), ['**Approve** the migration plan.', 'sign the release']);
  // A newer reply asks nothing: its ask clears, the card's item stays.
  list = syncAsks(list, asks([]), 5)!;
  assert.deepEqual(shownTodos(list, 6).map((t) => t.text), ['sign the release']);
  // The card still lists the first one, so now it shows, from the card.
  list = syncCardAsks(list, asks(['approve the migration plan', 'sign the release']), 7)!;
  assert.deepEqual(shownTodos(list, 8).map((t) => [t.text, t.via]).sort(), [['approve the migration plan', 'card'], ['sign the release', 'card']]);
  // The reply asks it again: the card's copy steps aside.
  list = syncAsks(list, asks(['Approve the migration plan']), 9)!;
  list = syncCardAsks(list, asks(['approve the migration plan', 'sign the release']), 10)!;
  assert.deepEqual(shownTodos(list, 11).map((t) => [t.text, t.via ?? 'reply']).sort(), [['Approve the migration plan', 'reply'], ['sign the release', 'card']]);
});

test('a card ask you deleted or ticked stays so, and other sessions are left alone', () => {
  const one = syncCardAsks([], asks(['approve the migration plan']), 1)!;
  const deleted = applyOp(one, { op: 'delete', id: one[0].id }, 2)!;
  assert.equal(syncCardAsks(deleted, asks(['approve the migration plan']), 3), undefined);
  const ticked = applyOp(one, { op: 'done', id: one[0].id, done: true }, 2)!;
  assert.equal(syncCardAsks(ticked, asks([]), 3), undefined);
  const other = syncCardAsks(one, asks(['approve the migration plan'], 'ffffeeee-0000'), 4)!;
  assert.equal(other.length, 2);
  assert.notEqual(cardAskId(ID, 'x'), askId(ID, 'x'));
  assert.match(cardAskId(ID, 'x'), /^j-[0-9a-f]{16}$/);
});

test('normalAsk: case, spacing, markup and end stops', () => {
  assert.equal(normalAsk('  **Approve**  the plan. '), 'approve the plan');
  assert.equal(normalAsk('Approve the plan!?'), 'approve the plan');
  assert.equal(normalAsk('approve the plan'), 'approve the plan');
});

test('the stored list keeps where a card ask came from', async () => {
  const list: Todo[] = syncCardAsks([], asks(['approve the migration plan']), 1)!;
  assert.equal(parseTodos(serializeTodos(list))[0].via, 'card');
  assert.equal(parseTodos(JSON.stringify({ items: [{ id: 'c-1', text: 't', from: 'claude', createdAt: 1, via: 'other' }] }))[0].via, undefined);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-todos-'));
  try {
    const store = new TodoStore(dir);
    assert.equal(await store.syncCardAsks(asks(['approve the migration plan']), 1), true);
    assert.equal(await store.syncCardAsks(asks(['approve the migration plan']), 2), false);
    assert.equal(await store.syncCardAsks([], 3), false);
    assert.equal(store.list[0].via, 'card');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
