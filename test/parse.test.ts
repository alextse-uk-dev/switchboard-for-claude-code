import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { displayTitle, lineage, parseAgentsJson, parsePs, projectSlug, toSession, withFileFields } from '../src/core/parse';
import type { Session } from '../src/core/types';

const cliInteractive = {
  pid: 6424,
  cwd: '/Users/sam/code/shop',
  kind: 'interactive',
  startedAt: 1000,
  sessionId: 'c79c1840-2d99-4658-9851-4efc8cdb59ff',
  name: 'shop-22',
  status: 'busy',
};

test('reads an interactive session from the CLI list', () => {
  const [s] = parseAgentsJson(JSON.stringify([cliInteractive]));
  assert.equal(s.kind, 'interactive');
  assert.equal(s.status, 'busy');
  assert.equal(s.name, 'shop-22');
  assert.equal(s.attachId, undefined);
});

test('reads background sessions from the CLI ("background", id) and from files ("bg", jobId)', () => {
  const cli = toSession({ ...cliInteractive, kind: 'background', id: 'd54d101e', status: 'idle', state: 'done' });
  assert.equal(cli?.kind, 'background');
  assert.equal(cli?.attachId, 'd54d101e');
  const file = toSession({ ...cliInteractive, kind: 'bg', jobId: 'aa11bb22' });
  assert.equal(file?.kind, 'background');
  assert.equal(file?.attachId, 'aa11bb22');
});

test('skips spare sessions, other kinds and broken records', () => {
  assert.equal(toSession({ ...cliInteractive, spare: true }), undefined);
  assert.equal(toSession({ ...cliInteractive, kind: 'sdk' }), undefined);
  assert.equal(toSession({ ...cliInteractive, pid: '6424' }), undefined);
  assert.equal(toSession(null), undefined);
  assert.throws(() => parseAgentsJson('{"not":"a list"}'));
});

test('an unrecognised status reads as unknown, and waitingFor only counts while waiting', () => {
  assert.equal(toSession({ ...cliInteractive, status: 'thinking' })?.status, 'unknown');
  assert.equal(toSession({ ...cliInteractive, status: 'shell' })?.status, 'busy');
  assert.equal(toSession({ ...cliInteractive, status: 'idle', waitingFor: 'input needed' })?.waitingFor, undefined);
  assert.equal(toSession({ ...cliInteractive, status: 'waiting', waitingFor: 'input needed' })?.waitingFor, 'input needed');
});

test("the status file's status and change time win over the CLI list", () => {
  const cli = toSession(cliInteractive)!;
  const file = toSession({ ...cliInteractive, status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: 5000, nameSource: 'user' })!;
  const merged = withFileFields(cli, file);
  assert.equal(merged.status, 'waiting');
  assert.equal(merged.waitingFor, 'dialog open');
  assert.equal(merged.statusUpdatedAt, 5000);
  assert.equal(merged.nameSource, 'user');
  const odd = withFileFields(cli, toSession({ ...cliInteractive, status: 'thinking', statusUpdatedAt: 7000 }));
  assert.equal(odd.status, 'busy', "the CLI's status stands when the file's is unknown");
  assert.equal(odd.statusUpdatedAt, 7000);
  const other = toSession({ ...cliInteractive, sessionId: 'another', status: 'idle' })!;
  assert.equal(withFileFields(cli, other), cli, 'a file for a reused pid is ignored');
});

test('displayTitle prefers a title the user set, then a chosen name, then the AI title', () => {
  const s: Session = toSession(cliInteractive)!;
  assert.equal(displayTitle(s, undefined), 'shop-22');
  const at = (v: string) => ({ v, at: 0 });
  assert.equal(displayTitle(s, { aiTitle: at('Fix checkout') }), 'Fix checkout');
  assert.equal(displayTitle({ ...s, nameSource: 'user', name: 'Checkout' }, { aiTitle: at('Fix checkout') }), 'Checkout');
  assert.equal(displayTitle({ ...s, nameSource: 'peer', name: 'Probe' }, { aiTitle: at('x') }), 'Probe');
  assert.equal(displayTitle({ ...s, nameSource: 'user', name: 'Checkout' }, { customTitle: at('Renamed'), aiTitle: at('x') }), 'Renamed');
});

test('projectSlug matches how Claude Code names transcript folders', () => {
  assert.equal(projectSlug('/Users/sam/code/shop'), '-Users-sam-code-shop');
  assert.equal(projectSlug('/Users/sam/code/shop/.claude/worktrees/a1'), '-Users-sam-code-shop--claude-worktrees-a1');
});

test('lineage walks up from a session to the shell of its tab', () => {
  const parents = parsePs('  100     1\n  200   100\n  300   200\n  400   300\n garbage\n');
  assert.deepEqual(lineage(400, parents), [400, 300, 200, 100]);
  assert.deepEqual(lineage(400, parents, 1), [400, 300]);
  assert.deepEqual(lineage(999, parents), [999]);
});
