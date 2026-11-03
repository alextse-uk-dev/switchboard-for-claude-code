import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { quickChoice, quickToast } from '../src/core/launch';
import { asMessage } from '../src/core/messages';
import { clockTime, isMuted, MUTE_MS, muteEnded, muteUntil, Repeats, REPEAT_MS } from '../src/core/quiet';

const A = '0a1b2c3d-1111-2222-3333-444455556666';
const B = 'ffffeeee-1111-2222-3333-444455556666';

test('Repeats: the same text for the same session is said once in ten minutes', () => {
  const r = new Repeats();
  assert.equal(r.fresh(A, '"example-app" needs you', 0), true);
  assert.equal(r.fresh(A, '"example-app" needs you', 60_000), false);
  assert.equal(r.fresh(A, '"example-app" needs you', REPEAT_MS - 1), false);
  assert.equal(r.fresh(A, '"example-app" is done', 60_000), true, 'other words are said');
  assert.equal(r.fresh(B, '"example-app" needs you', 60_000), true, 'another session is said');
  assert.equal(r.fresh(A, '"example-app" needs you', REPEAT_MS), true, 'after ten minutes it is said again');
  assert.equal(r.fresh(A, '"example-app" needs you', REPEAT_MS + 1000), false, 'and the ten minutes start over');
});

test('Repeats.forget drops ended sessions', () => {
  const r = new Repeats();
  r.fresh(A, 'x', 0);
  r.fresh(B, 'x', 0);
  r.forget(new Set([B]));
  assert.equal(r.fresh(A, 'x', 1), true);
  assert.equal(r.fresh(B, 'x', 1), false);
});

test('mute: an hour from now, then over', () => {
  const now = 1_000_000;
  const until = muteUntil(now);
  assert.equal(until - now, MUTE_MS);
  assert.equal(MUTE_MS, 60 * 60 * 1000);
  assert.equal(isMuted(until, now), true);
  assert.equal(isMuted(until, until - 1), true);
  assert.equal(isMuted(until, until), false);
  assert.equal(isMuted(undefined, now), false);
  assert.equal(isMuted(Number.NaN, now), false);
  assert.equal(muteEnded(until, until - 1), false);
  assert.equal(muteEnded(until, until), true, 'ended: say so once');
  assert.equal(muteEnded(undefined, now), false, 'no mute, nothing to say');
});

test('clockTime is hours and minutes', () => {
  const d = new Date(2026, 10, 3, 9, 5);
  assert.equal(clockTime(d.getTime()), '09:05');
});

test('quickChoice: the last choice, else the old session\'s own', () => {
  const same = { model: 'claude-opus-5-5', effort: 'xhigh' };
  assert.deepEqual(quickChoice({ model: 'sonnet', effort: 'high' }, same), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(quickChoice({ model: '', effort: '' }, same), { model: undefined, effort: undefined }, '"Default" last time means the settings decide');
  assert.deepEqual(quickChoice({}, same), same, 'never chosen: carry on as the old session');
  assert.deepEqual(quickChoice({}, {}), { model: undefined, effort: undefined });
  assert.deepEqual(quickChoice({ model: 'bad model; rm -rf', effort: 'huge' }, same), { model: undefined, effort: undefined }, 'malformed is dropped');
});

test('quickToast names the model and effort it used', () => {
  assert.equal(quickToast('example-app', { model: 'opus', effort: 'high' }, {}, false), 'Started the next session in example-app with opus and high effort.');
  assert.equal(quickToast('example-app', {}, { model: 'sonnet', effort: 'medium' }, true), 'Started the next session in example-app in the old tab with the default model (sonnet) and the default effort (medium).');
  assert.equal(quickToast('example-app', {}, {}, false), "Started the next session in example-app with Claude Code's default model and Claude Code's default effort.");
});

test('the board may ask for a quick Start next', () => {
  assert.deepEqual(asMessage({ type: 'nextQuick', key: `7:${A}` }), { type: 'nextQuick', key: `7:${A}` });
  assert.equal(asMessage({ type: 'nextQuick' }), undefined);
});
