import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { alertPlan, alertText, bannerArgs, givesAllAlerts, MAC_SOUNDS, soundFile, type AlertContext } from '../src/core/alert';
import type { SessionEvent } from '../src/core/model';
import type { Session } from '../src/core/types';

function session(extra: Partial<Session> = {}): Session {
  return { pid: 1, sessionId: 'a', cwd: '/work/shop', kind: 'interactive', name: 'shop-1', status: 'idle', startedAt: 0, ...extra };
}

const needs: SessionEvent = { type: 'needs', session: session({ status: 'waiting', waitingFor: 'input needed' }) };
const finished = (turnMs: number): SessionEvent => ({ type: 'finished', session: session(), turnMs });

const here: AlertContext = {
  needsOn: true,
  finishedOn: true,
  finishedMinMs: 60_000,
  decides: true,
  seenHere: false,
  idleMs: 5_000,
  awayAfterMs: 60_000,
  soundOn: true,
};
const away: AlertContext = { ...here, idleMs: 120_000 };

test('while you are here, a banner only, and none for what VS Code already shows you', () => {
  assert.deepEqual(alertPlan(needs, undefined, here), { banner: true, sound: false });
  assert.deepEqual(alertPlan(needs, undefined, { ...here, seenHere: true }), { banner: false, sound: false });
});

test('while you are away, a banner and the sound, even for the tab in front of you', () => {
  assert.deepEqual(alertPlan(needs, undefined, away), { banner: true, sound: true });
  assert.deepEqual(alertPlan(needs, undefined, { ...away, seenHere: true }), { banner: true, sound: true });
  assert.deepEqual(alertPlan(needs, undefined, { ...away, soundOn: false }), { banner: true, sound: false });
  // Away from the moment the line is reached.
  assert.deepEqual(alertPlan(needs, undefined, { ...here, idleMs: 60_000 }), { banner: true, sound: true });
});

test('an idle time that cannot be read counts as away', () => {
  assert.deepEqual(alertPlan(needs, undefined, { ...here, idleMs: undefined, seenHere: true }), { banner: true, sound: true });
});

test('0 away seconds plays the sound every time, and the banner still skips what you can see', () => {
  assert.deepEqual(alertPlan(needs, undefined, { ...here, idleMs: 0, awayAfterMs: 0 }), { banner: true, sound: true });
  assert.deepEqual(alertPlan(needs, undefined, { ...here, idleMs: 0, awayAfterMs: 0, seenHere: true }), { banner: false, sound: true });
  assert.deepEqual(alertPlan(needs, undefined, { ...here, idleMs: 0, awayAfterMs: 0, seenHere: true, soundOn: false }), { banner: false, sound: false });
});

test('only the window that decides alerts', () => {
  assert.deepEqual(alertPlan(needs, undefined, { ...away, decides: false }), { banner: false, sound: false });
});

test('each kind can be turned off, and short or interrupted turns give no alert', () => {
  assert.deepEqual(alertPlan(needs, undefined, { ...away, needsOn: false }), { banner: false, sound: false });
  assert.deepEqual(alertPlan(finished(90_000), undefined, { ...away, finishedOn: false }), { banner: false, sound: false });
  assert.deepEqual(alertPlan(finished(59_000), undefined, away), { banner: false, sound: false });
  assert.deepEqual(alertPlan(finished(60_000), { kind: 'done' }, away), { banner: true, sound: true });
  assert.deepEqual(alertPlan(finished(90_000), { kind: 'stopped', why: 'interrupted' }, away), { banner: false, sound: false });
  assert.deepEqual(alertPlan(finished(90_000), { kind: 'stopped', why: 'error', text: 'Overloaded' }, away), { banner: true, sound: true });
  // A finished event with no turn time is a turn too short to time.
  assert.deepEqual(alertPlan({ type: 'finished', session: session() }, undefined, away), { banner: false, sound: false });
  assert.deepEqual(alertPlan({ type: 'finished', session: session() }, undefined, { ...away, finishedMinMs: 0 }), { banner: true, sound: true });
});

test('a sound setting names one of the macOS sounds, in any case; anything else is none', () => {
  assert.equal(soundFile('Glass'), '/System/Library/Sounds/Glass.aiff');
  assert.equal(soundFile(' submarine '), '/System/Library/Sounds/Submarine.aiff');
  assert.equal(soundFile('none'), undefined);
  assert.equal(soundFile(undefined), undefined);
  assert.equal(soundFile('../../tmp/x'), undefined);
});

test("the sound setting's list is the sounds the code can play, plus none", () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> } };
  };
  const setting = pkg.contributes.configuration.properties['switchboard.macAlert.sound'];
  assert.deepEqual(setting.enum, ['none', ...MAC_SOUNDS]);
  assert.equal(soundFile(String(setting.default)), '/System/Library/Sounds/Glass.aiff');
});

test('a banner says what a push says, and quotes Claude, since it stays on this computer', () => {
  const t = alertText(finished(125_000), 'Shop checkout', 'shop', { kind: 'question', ask: 'Which plan?' });
  assert.equal(t.title, 'Shop checkout is waiting for your reply');
  assert.equal(t.message, '"Which plan?" · shop');
  assert.deepEqual(alertText(needs, 'Shop checkout', 'shop', undefined), { title: 'Shop checkout needs you', message: 'asks a question · shop' });
});

test('the words go to osascript as arguments, never into the script', () => {
  const evil = '" & (do shell script "touch /tmp/x") & "';
  const args = bannerArgs(evil, 'body');
  assert.deepEqual(args.slice(-2), [evil, 'body']);
  const script = args.filter((_, i) => args[i - 1] === '-e');
  assert.ok(script.every((line) => !line.includes(evil)));
  assert.deepEqual(script, ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run']);
});

test('words that start with "-" stay words: "--" ends the options before them', () => {
  const evil = '-eproperty p : (do shell script "echo pwned") -- needs you';
  const args = bannerArgs(evil, '-s');
  assert.deepEqual(args.slice(-3), ['--', evil, '-s']);
  if (process.platform !== 'darwin') return;
  // The same arguments, with a script that hands the words back instead of showing them.
  const echo = ['-e', 'on run argv', '-e', 'return (item 1 of argv) & "|" & (item 2 of argv)', '-e', 'end run', ...args.slice(-3)];
  assert.equal(execFileSync('/usr/bin/osascript', echo, { encoding: 'utf8' }).trim(), `${evil}|-s`);
});

test('a window tells other tools it gives Mac alerts only for the whole set, with a sound', () => {
  const all = { enabled: true, needsYou: true, finished: true, sound: 'Glass' };
  assert.equal(givesAllAlerts(all), true);
  assert.equal(givesAllAlerts({ ...all, enabled: false }), false);
  assert.equal(givesAllAlerts({ ...all, needsYou: false }), false);
  assert.equal(givesAllAlerts({ ...all, finished: false }), false);
  assert.equal(givesAllAlerts({ ...all, sound: 'none' }), false);
});

test('the Mac alert settings are one for all windows', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { scope?: string }> } };
  };
  const keys = Object.keys(pkg.contributes.configuration.properties).filter((k) => k.startsWith('switchboard.macAlert.'));
  assert.equal(keys.length, 6);
  for (const k of keys) assert.equal(pkg.contributes.configuration.properties[k].scope, 'application', k);
});
