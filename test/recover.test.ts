import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { canReuseTab, forgets, isShellCommand, KEEP_CLOSED_MS, offerClaim, parseRecord, reopenOrder, resumeCommand, resumeScript, shouldWrite, toClosedView, verdictOf, type Recoverable } from '../src/core/recover';
import { asMessage } from '../src/core/messages';
import { RecoveryStore } from '../src/recovery';

const ID = '7c894370-8424-44dd-8adf-88f5e35248ce';
const rec = (o: Partial<Recoverable> = {}): Recoverable => ({ sessionId: ID, title: 'Fix it', cwd: '/Users/a/code', status: 'idle', activeAt: 1000, tab: 0, workspace: '/w', owner: '50|a', ...o });

const NOW = 2000;
const verdict = (r: Recoverable, live: boolean, running: string[] = []) =>
  verdictOf(r, { live, me: '100|a', ownerAlive: (o) => o === '100|a' || running.includes(o), now: NOW });

test('a session whose window died with it is offered', () => {
  assert.equal(verdict(rec(), false), 'closed');
});

test('a session of this window that ends is only forgotten after the wait', () => {
  assert.equal(verdict(rec({ owner: '100|a' }), false), 'ending');
  assert.equal(verdict(rec({ owner: '100|a' }), true), 'keep');
});

test('another live window looks after its own records', () => {
  assert.equal(verdict(rec(), false, ['50|a']), 'keep', 'that window decides whether this one ended or closed');
  assert.equal(verdict(rec(), true, ['50|a']), 'keep');
});

test('a session still running after its window went waits: its signal may be on the way', () => {
  assert.equal(verdict(rec(), true), 'orphan');
  assert.equal(forgets('orphan'), true);
  assert.equal(verdict(rec(), false), 'closed', 'then it dies, and it is offered');
  assert.equal(forgets('closed'), false);
});

test('an old process number now used by something else does not count as the owner', () => {
  assert.equal(verdict(rec({ owner: '50|before the restart' }), false, ['50|after the restart']), 'closed');
  assert.equal(verdict(rec({ owner: '100|before the restart' }), false), 'closed', 'even if this window got the old number');
});

test('a closed session is offered for two weeks, even if it was idle long before', () => {
  assert.equal(verdictOf(rec({ activeAt: 0 }), { live: false, me: '100|a', ownerAlive: () => false, now: KEEP_CLOSED_MS }), 'closed');
  assert.equal(verdictOf(rec({ activeAt: 0 }), { live: false, me: '100|a', ownerAlive: () => false, now: KEEP_CLOSED_MS + 1 }), 'drop');
  assert.equal(verdictOf(rec({ activeAt: 0, owner: '100|a' }), { live: true, me: '100|a', ownerAlive: () => true, now: KEEP_CLOSED_MS * 3 }), 'keep', 'a live session never ages out');
});

test('shouldWrite: writes a change, and leaves a record another live window holds', () => {
  const alive = (o: string) => o === '50|a';
  const me = '100|a';
  assert.equal(shouldWrite(undefined, rec({ owner: me }), alive), true);
  assert.equal(shouldWrite(rec({ owner: me }), rec({ owner: me }), alive), false, 'nothing changed');
  assert.equal(shouldWrite(rec({ owner: me }), rec({ owner: me, status: 'busy' }), alive), true);
  assert.equal(shouldWrite(rec({ owner: '50|a' }), rec({ owner: me, status: 'busy' }), alive), false, 'two tabs on one conversation');
  assert.equal(shouldWrite(rec({ owner: '60|a' }), rec({ owner: me }), alive), true, 'taken over from a window that has gone');
});

test('resumeCommand quotes the id and passes only a real effort', () => {
  assert.equal(resumeCommand('/opt/my claude', { sessionId: ID, effort: 'xhigh' }), `'/opt/my claude' --resume '${ID}' --effort xhigh`);
  assert.equal(resumeCommand('claude', { sessionId: ID }), `'claude' --resume '${ID}'`);
  assert.equal(resumeCommand('claude', { sessionId: ID, effort: 'x; rm -rf ~' }), `'claude' --resume '${ID}'`);
});

test('a session takes its old tab back only if that tab is an untouched, idle shell of the same workspace', () => {
  const ok = { sameWorkspace: true, touched: false, busy: false };
  assert.equal(canReuseTab(ok), true);
  assert.equal(canReuseTab({ ...ok, sameWorkspace: false }), false);
  assert.equal(canReuseTab({ ...ok, touched: true }), false, 'the user may be using it');
  assert.equal(canReuseTab({ ...ok, busy: true }), false, 'a server, say, or another session');
});

test('isShellCommand knows a shell, a login shell, and refuses other programs', () => {
  for (const c of ['zsh', '-zsh', '/bin/zsh\n', 'bash', '-bash', 'fish', '/bin/sh']) assert.equal(isShellCommand(c), true, c);
  for (const c of ['node', 'claude', '/usr/local/bin/claude', 'python3', '']) assert.equal(isShellCommand(c), false, c);
});

test('resumeScript goes to the old folder first, deletes itself, and starts nothing if the folder is gone', () => {
  assert.equal(resumeScript("/Users/a/it's", "'claude' --resume 'x'"), `rm -f "$0"\ncd '/Users/a/it'\\''s' && 'claude' --resume 'x'\n`);
});

test('a record from before workspaces were kept still reads', () => {
  const { workspace: _w, ...old } = rec();
  assert.equal(parseRecord(JSON.stringify(old))?.workspace, '');
});

test('parseRecord refuses what could not have come from Switchboard', () => {
  const good = rec({ effort: 'high' });
  assert.deepEqual(parseRecord(JSON.stringify(good)), good);
  assert.equal(parseRecord('{ not json'), undefined);
  assert.equal(parseRecord(''), undefined);
  assert.equal(parseRecord('null'), undefined);
  assert.equal(parseRecord(JSON.stringify(rec({ sessionId: "x'; touch /tmp/p; '" }))), undefined);
  assert.equal(parseRecord(JSON.stringify(rec({ sessionId: '../../etc/passwd' }))), undefined);
  assert.equal(parseRecord(JSON.stringify(rec({ cwd: 'relative/path' }))), undefined);
  assert.equal(parseRecord(JSON.stringify({ ...rec(), status: 'odd' })), undefined);
  assert.equal(parseRecord(JSON.stringify(rec({ effort: 'extreme' })))?.effort, undefined, 'a bad effort is left out');
});

test('reopenOrder keeps each old window\'s tabs together, left to right', () => {
  const rs = [rec({ owner: '9|a', tab: 1, title: 'b2' }), rec({ owner: '5|a', tab: 1, title: 'a2' }), rec({ owner: '9|a', tab: 0, title: 'b1' }), rec({ owner: '5|a', tab: 0, title: 'a1' })];
  assert.deepEqual(reopenOrder(rs).map((r) => r.title), ['a1', 'a2', 'b1', 'b2']);
});

test('toClosedView shows the folder from home, and only a real home prefix', () => {
  assert.equal(toClosedView(rec(), '/Users/a').cwd, '~/code');
  assert.equal(toClosedView(rec({ cwd: '/Users/ab/code' }), '/Users/a').cwd, '/Users/ab/code');
  assert.equal(toClosedView(rec({ status: 'busy' }), '/Users/a').state, 'was working');
});

test('offerClaim is the same in every window for one set, and new for the next', () => {
  assert.equal(offerClaim([rec(), rec({ activeAt: 5 })]), offerClaim([rec({ activeAt: 5 }), rec()]));
  assert.notEqual(offerClaim([rec()]), offerClaim([rec({ activeAt: 1001 })]));
});

test('the board may only name real session ids', () => {
  assert.deepEqual(asMessage({ type: 'resume', id: ID }), { type: 'resume', id: ID });
  assert.deepEqual(asMessage({ type: 'dismissClosed', id: ID }), { type: 'dismissClosed', id: ID });
  assert.deepEqual(asMessage({ type: 'resumeAll' }), { type: 'resumeAll' });
  assert.deepEqual(asMessage({ type: 'dismissAllClosed' }), { type: 'dismissAllClosed' });
  assert.equal(asMessage({ type: 'resume', id: '../x' }), undefined);
  assert.equal(asMessage({ type: 'resume' }), undefined);
});

async function store(t: { after: (f: () => Promise<void>) => void }): Promise<RecoveryStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const s = new RecoveryStore(dir);
  await s.init();
  return s;
}

test('RecoveryStore: a record survives a new window, and half-written or foreign files are skipped', async (t) => {
  const a = await store(t);
  await a.write(rec({ effort: 'high' }));
  await fs.writeFile(path.join(a.dir, `${ID}.123.abc.tmp`), '{');
  await fs.writeFile(path.join(a.dir, 'aaaaaaaa-broken'), '{');
  await fs.writeFile(path.join(a.dir, 'bbbbbbbb-other-id'), JSON.stringify(rec()));
  const b = new RecoveryStore(path.dirname(a.dir));
  await b.init();
  assert.deepEqual(b.list, [rec({ effort: 'high' })]);
});

test('RecoveryStore: a read that started before a write cannot undo it', async (t) => {
  const a = await store(t);
  await a.write(rec({ title: 'old' }));
  const reading = a.load();
  await a.write(rec({ title: 'new' }));
  await reading;
  assert.equal(a.get(ID)?.title, 'new');
});

test('RecoveryStore.take lets only one window reopen a session', async (t) => {
  const a = await store(t);
  await a.write(rec());
  const b = new RecoveryStore(path.dirname(a.dir));
  await b.init();
  const wins = await Promise.all([a.take(ID), b.take(ID)]);
  assert.equal(wins.filter(Boolean).length, 1);
  assert.equal(a.get(ID), undefined);
  assert.equal(await a.take('../../x'), false);
});
