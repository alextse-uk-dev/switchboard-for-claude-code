import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { counterText, formatAge, groupOf, shouldPop, Tracker, type PopContext } from '../src/core/model';
import type { Group, Session, Status } from '../src/core/types';

function session(status: Status, statusUpdatedAt?: number, extra: Partial<Session> = {}): Session {
  return { pid: 1, sessionId: 'a', cwd: '/w', kind: 'interactive', name: 'w-1', status, startedAt: 0, statusUpdatedAt, ...extra };
}

test('a session seen for the first time raises no event', () => {
  const t = new Tracker();
  const { events, fresh } = t.update([session('waiting', 10)], 20);
  assert.deepEqual(events, []);
  assert.equal(fresh.length, 1);
  assert.equal(t.changedAt('1:a'), 10);
});

test('starting to wait raises "needs"; the same wait does not repeat; a new prompt does', () => {
  const t = new Tracker();
  t.update([session('busy', 10)], 10);
  assert.deepEqual(t.update([session('waiting', 20)], 20).events.map((e) => e.type), ['needs']);
  assert.deepEqual(t.update([session('waiting', 20)], 30).events, []);
  assert.deepEqual(t.update([session('waiting', 40)], 40).events.map((e) => e.type), ['needs']);
});

test('finishing a turn raises "finished" with the length of the whole turn', () => {
  const t = new Tracker();
  t.update([session('idle', 0)], 0);
  t.update([session('busy', 1_000)], 1_000);
  t.update([session('waiting', 5_000)], 5_000);
  t.update([session('busy', 8_000)], 8_000);
  const { events } = t.update([session('idle', 61_000)], 61_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'finished');
  assert.equal(events[0].turnMs, 60_000);
});

test('a turn already running when first seen is timed from that sighting', () => {
  const t = new Tracker();
  t.update([session('busy', 5_000)], 9_000);
  assert.equal(t.update([session('idle', 35_000)], 35_000).events[0].turnMs, 30_000);
});

test('without a change time from the file, the time of the sighting is used and kept', () => {
  const t = new Tracker();
  t.update([session('busy')], 100);
  t.update([session('busy')], 200);
  assert.equal(t.changedAt('1:a'), 100);
  const { events } = t.update([session('idle')], 300);
  assert.equal(events[0].turnMs, 200);
  assert.equal(t.changedAt('1:a'), 300);
});

test('an unknown status raises nothing and a gone session is forgotten', () => {
  const t = new Tracker();
  t.update([session('busy', 1)], 1);
  assert.deepEqual(t.update([session('unknown', 2)], 2).events, []);
  t.update([], 3);
  assert.equal(t.changedAt('1:a'), undefined);
  assert.equal(t.update([session('waiting', 4)], 4).fresh.length, 1);
});

test('two processes resuming one conversation are tracked apart', () => {
  const t = new Tracker();
  const a = (st: Status, at: number) => session(st, at, { pid: 1 });
  const b = (st: Status, at: number) => session(st, at, { pid: 2 });
  t.update([a('waiting', 10), b('idle', 5)], 10);
  assert.deepEqual(t.update([a('waiting', 10), b('idle', 5)], 20).events, []);
  assert.equal(t.changedAt('1:a'), 10);
  assert.equal(t.changedAt('2:a'), 5);
});

test('groupOf: waiting needs you; idle since your last look is finished', () => {
  assert.equal(groupOf(session('waiting'), 10, 50), 'needs');
  assert.equal(groupOf(session('idle'), 60, 50), 'finished');
  assert.equal(groupOf(session('idle'), 40, 50), 'idle');
  assert.equal(groupOf(session('idle'), 60, undefined), 'idle');
  assert.equal(groupOf(session('busy'), 60, 50), 'working');
  assert.equal(groupOf(session('unknown'), 60, 50), 'idle');
});

test('groupOf: background sessions have their own group unless they need you or finished', () => {
  const bg = (st: Status) => session(st, undefined, { kind: 'background' });
  assert.equal(groupOf(bg('busy'), 60, 50), 'background');
  assert.equal(groupOf(bg('idle'), 40, 50), 'background');
  assert.equal(groupOf(bg('idle'), 60, 50), 'finished');
  assert.equal(groupOf(bg('waiting'), 60, 50), 'needs');
});

const ctx: PopContext = {
  needsOn: true,
  finishedOn: true,
  finishedMinMs: 30_000,
  lookingAt: false,
  ownedHere: false,
  ownedElsewhere: false,
  lastFocused: false,
};
const needs = { type: 'needs' as const, session: session('waiting') };
const done = (turnMs: number) => ({ type: 'finished' as const, session: session('idle'), turnMs });

test('shouldPop: the window holding the tab pops, unless you are looking at it', () => {
  assert.equal(shouldPop(needs, { ...ctx, ownedHere: true }), true);
  assert.equal(shouldPop(needs, { ...ctx, ownedHere: true, lookingAt: true, lastFocused: true }), false);
});

test('shouldPop: a session in another window never pops here; one in no window pops in the window focused last', () => {
  assert.equal(shouldPop(needs, { ...ctx, ownedElsewhere: true, lastFocused: true }), false);
  assert.equal(shouldPop(needs, { ...ctx, lastFocused: true }), true);
  assert.equal(shouldPop(needs, ctx), false);
});

test('shouldPop: short turns and switched-off kinds stay quiet', () => {
  assert.equal(shouldPop(done(29_000), { ...ctx, ownedHere: true }), false);
  assert.equal(shouldPop(done(30_000), { ...ctx, ownedHere: true }), true);
  assert.equal(shouldPop(done(90_000), { ...ctx, ownedHere: true, finishedOn: false }), false);
  assert.equal(shouldPop(needs, { ...ctx, ownedHere: true, needsOn: false }), false);
});

test('formatAge', () => {
  assert.equal(formatAge(10_000), 'just now');
  assert.equal(formatAge(50_000), '1 min');
  assert.equal(formatAge(4 * 60_000), '4 min');
  assert.equal(formatAge(60 * 60_000), '1 h');
  assert.equal(formatAge(65 * 60_000), '1 h 5 min');
  assert.equal(formatAge(50 * 60 * 60_000), '2 d');
});

test('counterText', () => {
  const c = (o: Partial<Record<Group, number>>) => ({ needs: 0, finished: 0, working: 0, idle: 0, background: 0, ...o });
  assert.equal(counterText(c({ needs: 1, finished: 2, working: 3 })), '1 needs you · 2 finished');
  assert.equal(counterText(c({ needs: 2 })), '2 need you');
  assert.equal(counterText(c({ working: 3, idle: 1 })), '3 working');
  assert.equal(counterText(c({ idle: 1, background: 2 })), '3 idle');
  assert.equal(counterText(c({})), '');
});
