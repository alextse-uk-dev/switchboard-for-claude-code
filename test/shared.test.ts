import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { SharedState } from '../src/shared';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-test-'));
}

test('marks made at the same moment, in one window or two, are all kept', async () => {
  const dir = await tempDir();
  const a = new SharedState(dir, 'a');
  const b = new SharedState(dir, 'b');
  await a.init(0);
  await b.init(0);
  await Promise.all([a.markSeen([['s1', 10]], 10), a.markSeen([['s2', 20]], 20), b.markSeen([['s3', 30]], 30)]);
  await a.markSeen([['s4', 40]], 40);
  const c = new SharedState(dir, 'c');
  await c.init(0);
  assert.deepEqual(['s1', 's2', 's3', 's4'].map((id) => c.seenAt(id)), [10, 20, 30, 40]);
});

test('a mark never moves backwards', async () => {
  const dir = await tempDir();
  const a = new SharedState(dir, 'a');
  await a.init(0);
  assert.equal(await a.markSeen([['s1', 50]], 50), true);
  assert.equal(await a.markSeen([['s1', 40]], 60), false);
  assert.equal(a.seenAt('s1'), 50);
});

test('only the first window claims a pop-up', async () => {
  const dir = await tempDir();
  const a = new SharedState(dir, 'a');
  const b = new SharedState(dir, 'b');
  await a.init(0);
  await b.init(0);
  const results = await Promise.all([a.claim('needs-1:x-100'), b.claim('needs-1:x-100')]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await a.claim('needs-1:x-200'), true);
});

test('peers report what other live windows hold and when they were focused; dead ones are swept', async () => {
  const dir = await tempDir();
  const a = new SharedState(dir, 'a');
  const b = new SharedState(dir, 'b');
  await a.init(0);
  await b.init(0);
  await b.publishOwned(['1:x']);
  await b.noteFocused(500);
  await fs.writeFile(path.join(dir, 'windows', 'dead.json'), JSON.stringify({ v: 1, pid: 999999, sessions: ['2:y'], focusedAt: 900 }));
  const peers = await a.peers();
  assert.deepEqual([...peers.owned], ['1:x']);
  assert.equal(peers.focusedAt, 500);
  await assert.rejects(fs.access(path.join(dir, 'windows', 'dead.json')));
});
