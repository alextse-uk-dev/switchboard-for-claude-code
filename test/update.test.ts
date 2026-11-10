import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  afterReload,
  BLOCKED_MS,
  compareVersions,
  decide,
  folderVersion,
  midTurn,
  newestInstalled,
  noticeText,
  obsoleteFolders,
  parseReloadRecord,
  parseVersion,
  QUIET_MS,
  reloadingText,
  updatedText,
  type Installed,
  type Look,
} from '../src/core/update';

const ID = 'Pub.my-ext';
const dir = (name: string, hasPackage = true): Installed => ({ name, hasPackage });
const newest = (folders: Installed[], obsolete = new Set<string>(), running = '0.9.0') => newestInstalled({ id: ID, running, folders, obsolete });

test('versions compare as numbers, never as strings', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.9.0', '0.10.0') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.9.10', '0.9.9') > 0);
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0]);
  assert.equal(parseVersion('0.10'), undefined);
  assert.equal(parseVersion('0.10.0-beta'), undefined);
});

test('a folder name gives its version, with or without a platform suffix', () => {
  assert.equal(folderVersion('pub.my-ext-0.10.0', ID), '0.10.0');
  assert.equal(folderVersion('pub.my-ext-0.10.0-darwin-arm64', ID), '0.10.0');
  assert.equal(folderVersion('pub.my-ext-1.2.3-linux-x64', ID), '1.2.3');
  assert.equal(folderVersion('Pub.My-Ext-1.2.3', ID), '1.2.3', 'the id is matched without regard to case');
});

test("another extension's folder is not this one's", () => {
  assert.equal(folderVersion('pub.my-ext-tools-1.0.0', ID), undefined);
  assert.equal(folderVersion('pub.other-1.0.0', ID), undefined);
  assert.equal(folderVersion('other.my-ext-1.0.0', ID), undefined);
  assert.equal(folderVersion('pub.my-ext', ID), undefined);
  assert.equal(folderVersion('.obsolete', ID), undefined);
});

test('the newest install above the running version is picked', () => {
  const folders = [dir('pub.my-ext-0.9.0'), dir('pub.my-ext-0.10.0'), dir('pub.my-ext-0.9.5')];
  assert.deepEqual(newest(folders), { folder: 'pub.my-ext-0.10.0', version: '0.10.0' });
  assert.deepEqual(newest([dir('pub.my-ext-0.10.0-darwin-arm64')]), { folder: 'pub.my-ext-0.10.0-darwin-arm64', version: '0.10.0' });
});

test('nothing is picked when no install is newer', () => {
  assert.equal(newest([dir('pub.my-ext-0.9.0'), dir('pub.my-ext-0.8.0')]), undefined);
  assert.equal(newest([]), undefined);
});

test("other extensions' folders are ignored, however new", () => {
  assert.equal(newest([dir('pub.my-ext-0.9.0'), dir('pub.my-ext-tools-9.0.0'), dir('pub.other-9.0.0')]), undefined);
});

test('a folder listed in .obsolete is ignored', () => {
  const obsolete = obsoleteFolders('{"pub.my-ext-0.10.0": true}');
  assert.equal(newest([dir('pub.my-ext-0.10.0')], obsolete), undefined);
  assert.deepEqual(newest([dir('pub.my-ext-0.10.0'), dir('pub.my-ext-0.9.5')], obsolete), { folder: 'pub.my-ext-0.9.5', version: '0.9.5' });
});

test('a folder without a package.json is ignored (an install still unpacking)', () => {
  assert.equal(newest([dir('pub.my-ext-0.10.0', false)]), undefined);
  assert.deepEqual(newest([dir('pub.my-ext-0.11.0', false), dir('pub.my-ext-0.10.0')]), { folder: 'pub.my-ext-0.10.0', version: '0.10.0' });
});

test('.obsolete that is missing or not a JSON object lists nothing', () => {
  assert.equal(obsoleteFolders(undefined).size, 0);
  assert.equal(obsoleteFolders('').size, 0);
  assert.equal(obsoleteFolders('not json').size, 0);
  assert.equal(obsoleteFolders('["pub.my-ext-0.10.0"]').size, 0);
  assert.equal(obsoleteFolders('null').size, 0);
  assert.deepEqual([...obsoleteFolders('{"a": true, "b": false}')], ['a']);
});

test('only an idle session is not mid-turn; an unknown status counts as mid-turn', () => {
  assert.equal(midTurn([]), false);
  assert.equal(midTurn(['idle', 'idle']), false);
  assert.equal(midTurn(['idle', 'busy']), true);
  assert.equal(midTurn(['waiting']), true, 'a permission prompt or a question');
  assert.equal(midTurn(['unknown']), true);
});

const look = (o: Partial<Look> = {}): Look => ({ target: '0.10.0', enabled: true, persistentTerminals: true, midTurn: false, running: false, now: 100_000, ...o });

test('the setting off only gives the notice', () => {
  assert.deepEqual(decide(look({ enabled: false })), { do: 'notice' });
  assert.deepEqual(decide(look({ enabled: false, midTurn: true })), { do: 'notice' });
});

test('without persistent terminals, only the notice: the tabs would not survive', () => {
  assert.deepEqual(decide(look({ persistentTerminals: false })), { do: 'notice' });
});

test('a version this window already reloaded for, and did not get, only gives the notice', () => {
  assert.deepEqual(decide(look({ tried: '0.10.0', quietSince: 0 })), { do: 'notice' });
  assert.deepEqual(decide(look({ tried: '0.9.5', quietSince: 0 })), { do: 'reload' }, 'a newer version still reloads');
});

test('"Not now" holds for that version only', () => {
  assert.deepEqual(decide(look({ declined: '0.10.0', quietSince: 0 })), { do: 'notice' });
  assert.deepEqual(decide(look({ target: '0.11.0', declined: '0.10.0', quietSince: 0 })), { do: 'reload' });
});

test('a mid-turn session makes the window wait, and its quiet count starts over', () => {
  assert.deepEqual(decide(look({ midTurn: true })), { do: 'wait' });
  assert.deepEqual(decide(look({ midTurn: true, quietSince: 0 })), { do: 'wait' });
});

test('a mid-turn session is waited for without limit', () => {
  assert.deepEqual(decide(look({ midTurn: true, running: true, blockedSince: 0, now: 10 * BLOCKED_MS })), { do: 'wait' });
});

test('a task or a debug session alone starts the blocked clock, and resets the quiet count', () => {
  assert.deepEqual(decide(look({ running: true, quietSince: 0, now: 100_000 })), { do: 'wait', blockedSince: 100_000 });
});

test('a task or a debug session alone under 10 minutes still waits', () => {
  assert.deepEqual(decide(look({ running: true, blockedSince: 100_000, now: 100_000 + BLOCKED_MS - 1 })), { do: 'wait', blockedSince: 100_000 });
});

test('a task or a debug session alone for 10 minutes gives the notice', () => {
  assert.equal(BLOCKED_MS, 10 * 60_000);
  assert.deepEqual(decide(look({ running: true, blockedSince: 100_000, now: 100_000 + BLOCKED_MS })), { do: 'notice' });
});

test('a mid-turn session in between starts the blocked clock again', () => {
  let d = decide(look({ running: true, now: 0 }));
  assert.deepEqual(d, { do: 'wait', blockedSince: 0 });
  d = decide(look({ running: true, midTurn: true, blockedSince: d.do === 'wait' ? d.blockedSince : undefined, now: BLOCKED_MS - 60_000 }));
  assert.deepEqual(d, { do: 'wait' }, 'the clock is dropped');
  d = decide(look({ running: true, blockedSince: d.do === 'wait' ? d.blockedSince : undefined, now: BLOCKED_MS + 60_000 }));
  assert.deepEqual(d, { do: 'wait', blockedSince: BLOCKED_MS + 60_000 }, 'and starts again: no notice yet');
});

test('once the task ends, the quiet count starts and the blocked clock is dropped', () => {
  assert.deepEqual(decide(look({ blockedSince: 0, now: 100_000 })), { do: 'wait', quietSince: 100_000 });
});

test('a first quiet look only starts the count', () => {
  assert.deepEqual(decide(look({ now: 100_000 })), { do: 'wait', quietSince: 100_000 });
});

test('a second quiet look under 5 seconds later still waits', () => {
  assert.deepEqual(decide(look({ quietSince: 100_000, now: 100_000 + QUIET_MS - 1 })), { do: 'wait', quietSince: 100_000 });
});

test('a second quiet look 5 seconds or more later reloads', () => {
  assert.deepEqual(decide(look({ quietSince: 100_000, now: 100_000 + QUIET_MS })), { do: 'reload' });
  assert.deepEqual(decide(look({ quietSince: 100_000, now: 200_000 })), { do: 'reload' });
});

test('a clock that went back starts the count again', () => {
  assert.deepEqual(decide(look({ quietSince: 200_000, now: 100_000 })), { do: 'wait', quietSince: 100_000 });
});

test('after a reload that got the new version, it says so', () => {
  assert.deepEqual(afterReload({ from: '0.9.0', to: '0.10.0', at: 1 }, '0.10.0'), { say: 'updated' });
});

test('after a reload that kept the old version, it remembers the try: no reload loop', () => {
  const r = afterReload({ from: '0.9.0', to: '0.10.0', at: 1 }, '0.9.0');
  assert.deepEqual(r, { say: 'notice', tried: '0.10.0' });
  assert.ok(r.say === 'notice');
  assert.deepEqual(decide(look({ tried: r.tried, quietSince: 0 })), { do: 'notice' }, 'the next look only gives the notice');
});

test('a reload record is read only when whole', () => {
  assert.deepEqual(parseReloadRecord({ from: '0.9.0', to: '0.10.0', at: 5 }), { from: '0.9.0', to: '0.10.0', at: 5 });
  assert.equal(parseReloadRecord(undefined), undefined);
  assert.equal(parseReloadRecord('0.10.0'), undefined);
  assert.equal(parseReloadRecord({ from: '0.9.0', to: '0.10.0' }), undefined);
  assert.equal(parseReloadRecord({ from: 'x', to: '0.10.0', at: 5 }), undefined);
});

test('the messages name the extension and the versions', () => {
  assert.equal(reloadingText('Switchboard', '0.10.0'), 'Switchboard 0.10.0 is installed. This window reloads in 5 seconds. Claude sessions in its terminal tabs keep running.');
  assert.equal(updatedText('Switchboard', '0.9.0', '0.10.0'), 'Switchboard updated from 0.9.0 to 0.10.0 and reloaded this window. Claude sessions in its terminal tabs kept running.');
  assert.equal(noticeText('Switchboard', '0.10.0'), 'Switchboard 0.10.0 is installed. Reload this window to use it.');
});
