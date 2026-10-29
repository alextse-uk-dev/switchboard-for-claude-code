import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { SessionEvent } from '../src/core/model';
import {
  awayMs,
  idleMsFromIoreg,
  maskedTopic,
  newTopic,
  ntfyBody,
  parseTopicUrl,
  pendingVerdict,
  plainText,
  PENDING_MS,
  pushMessage,
  pushVerdict,
  type Pending,
  tokenProblem,
  type PushContext,
} from '../src/core/push';
import type { Session } from '../src/core/types';
import { PushStore, sendPush, type Secrets } from '../src/push';

function session(extra: Partial<Session> = {}): Session {
  return { pid: 1, sessionId: 'a', cwd: '/work/shop', kind: 'interactive', name: 'shop-1', status: 'idle', startedAt: 0, ...extra };
}

const needs: SessionEvent = { type: 'needs', session: session({ status: 'waiting', waitingFor: 'input needed' }) };
const finished = (turnMs: number): SessionEvent => ({ type: 'finished', session: session(), turnMs });

test('a topic URL splits into its server and topic', () => {
  assert.deepEqual(parseTopicUrl(' https://ntfy.sh/sb-abc_12 '), { server: 'https://ntfy.sh/', topic: 'sb-abc_12' });
  assert.deepEqual(parseTopicUrl('https://push.example.org/ntfy/alerts'), { server: 'https://push.example.org/ntfy/', topic: 'alerts' });
  assert.deepEqual(parseTopicUrl('https://push.example.org/alerts/'), { server: 'https://push.example.org/', topic: 'alerts' });
  assert.deepEqual(parseTopicUrl('http://192.168.1.20:8080/t'), { server: 'http://192.168.1.20:8080/', topic: 't' });
  assert.deepEqual(parseTopicUrl('http://localhost/t'), { server: 'http://localhost/', topic: 't' });
});

test('a topic URL it cannot use says why', () => {
  for (const bad of ['ntfy.sh/x', 'http://ntfy.sh/x', 'https://ntfy.sh/', 'https://ntfy.sh/a b', 'https://u:p@ntfy.sh/x', 'https://ntfy.sh/x?auth=1', 'ftp://ntfy.sh/x', 'http://8.8.8.8/x', `https://ntfy.sh/${'x'.repeat(65)}`]) {
    const r = parseTopicUrl(bad);
    assert.ok('error' in r, bad);
  }
});

test('a new topic is long, random and easy to type', () => {
  const t = newTopic(new Uint8Array(16).map((_, i) => i * 37));
  assert.match(t, /^sb-[a-km-np-z2-9]{16}$/);
  assert.notEqual(newTopic(new Uint8Array(16)), newTopic(new Uint8Array(16).fill(1)));
  assert.throws(() => newTopic(new Uint8Array(4)));
  assert.ok('topic' in parseTopicUrl(`https://ntfy.sh/${t}`));
});

test('a masked topic shows the server and only the start of the topic', () => {
  const m = maskedTopic({ server: 'https://ntfy.sh/', topic: 'sb-abcdefghijklmnop' });
  assert.equal(m, 'https://ntfy.sh/sb-ab…');
  assert.ok(!m.includes('ghij'));
});

test('a push says who, where and what, and never quotes Claude unless asked', () => {
  const n = pushMessage(needs, 'Shop checkout', 'shop', undefined, false);
  assert.deepEqual(n, { title: 'Shop checkout needs you', message: 'asks a question · shop', priority: 4, tags: ['bell'] });

  const q = pushMessage(finished(120_000), 'Shop checkout', 'shop', { kind: 'question', ask: 'Ship it to the secret-server?' }, false);
  assert.equal(q.title, 'Shop checkout is waiting for your reply');
  assert.equal(q.message, 'It finished after 2 min with a question for you · shop');
  assert.ok(!JSON.stringify(q).includes('secret'));
  assert.equal(pushMessage(finished(1), 'S', 'f', { kind: 'question', ask: 'Ship it?' }, true).message, '"Ship it?" · f');

  const err = { kind: 'stopped', why: 'error', text: 'Overloaded at /home/me/private' } as const;
  assert.equal(pushMessage(finished(1), 'S', 'f', err, false).message, 'On an error · f');
  assert.equal(pushMessage(finished(1), 'S', 'f', err, true).message, 'On an error: Overloaded at /home/me/private · f');

  assert.equal(pushMessage(finished(90_000), 'S', 'f', { kind: 'handoff', reason: 'kickoff', prompt: 'p' }, true).message, 'It wrote a kickoff prompt for a new session · f');
  assert.deepEqual(pushMessage(finished(0), 'S', 'f', { kind: 'done' }, false), { title: 'S finished', message: 'Done · f', priority: 3, tags: ['white_check_mark'] });
});

test('a push is kept short and carries no clickable links', () => {
  const m = pushMessage(finished(1), 'S', 'f', { kind: 'question', ask: `see [here](command:evil) ${'word '.repeat(80)}?` }, true);
  assert.ok(m.message.length <= 210);
  assert.ok(m.message.endsWith('… · f'));
  assert.ok(!m.message.includes(']('));
  assert.ok(pushMessage(needs, 'T'.repeat(300), 'f', undefined, false).title.length <= 200);
});

test("ntfy's JSON names the topic and carries the message", () => {
  const body = JSON.parse(ntfyBody({ topic: 'sb-x' }, { title: 'T “quoted” 🔔', message: 'M\nline', priority: 4, tags: ['bell'] }));
  assert.deepEqual(body, { topic: 'sb-x', title: 'T “quoted” 🔔', message: 'M\nline', priority: 4, tags: ['bell'] });
});

test("macOS's idle time is read from ioreg, in milliseconds", () => {
  const out = '    | |   "HIDIdleTime" = 88228166000\n    | |   "HIDIdleTimeDelta" = 1\n';
  assert.equal(idleMsFromIoreg(out), 88_228);
  assert.equal(idleMsFromIoreg('nothing here'), undefined);
});

test('away time: the computer\'s idle time decides; otherwise time since a VS Code window had focus', () => {
  assert.equal(awayMs(10_000, 4_000, true, 9_000), 4_000);
  assert.equal(awayMs(10_000, undefined, true, 1_000), 0);
  assert.equal(awayMs(10_000, undefined, false, 4_000), 6_000);
  assert.equal(awayMs(10_000, undefined, false, 0), 0);
});

const ctx = (c: Partial<PushContext> = {}): PushContext => ({
  needsOn: true,
  finishedOn: true,
  finishedMinMs: 60_000,
  always: false,
  decides: true,
  lookingAt: false,
  awayMs: 0,
  awayAfterMs: 180_000,
  ...c,
});

test('a push goes at once only when you are away; while you are here it waits', () => {
  assert.equal(pushVerdict(needs, undefined, ctx({ awayMs: 200_000 })), 'push');
  assert.equal(pushVerdict(needs, undefined, ctx({ awayMs: 10_000 })), 'wait');
  assert.equal(pushVerdict(needs, undefined, ctx({ lookingAt: true, awayMs: 200_000 })), 'wait');
  assert.equal(pushVerdict(finished(120_000), { kind: 'done' }, ctx({ awayMs: 180_000 })), 'push');
});

test('"always" pushes even while you are here, but not for the tab you look at', () => {
  assert.equal(pushVerdict(needs, undefined, ctx({ always: true })), 'push');
  assert.equal(pushVerdict(needs, undefined, ctx({ always: true, lookingAt: true })), 'drop');
});

test('settings, short turns and your own interrupts drop a push', () => {
  assert.equal(pushVerdict(needs, undefined, ctx({ needsOn: false, awayMs: 1e9 })), 'drop');
  assert.equal(pushVerdict(finished(120_000), { kind: 'done' }, ctx({ finishedOn: false, awayMs: 1e9 })), 'drop');
  assert.equal(pushVerdict(finished(59_999), { kind: 'done' }, ctx({ awayMs: 1e9 })), 'drop');
  assert.equal(pushVerdict({ type: 'finished', session: session() }, { kind: 'done' }, ctx({ awayMs: 1e9 })), 'drop');
  assert.equal(pushVerdict(finished(120_000), { kind: 'stopped', why: 'interrupted' }, ctx({ awayMs: 1e9 })), 'drop');
  assert.equal(pushVerdict(finished(120_000), { kind: 'stopped', why: 'error' }, ctx({ awayMs: 1e9 })), 'push');
  // Needs-you has no length to check.
  assert.equal(pushVerdict(needs, undefined, ctx({ finishedMinMs: 1e9, awayMs: 1e9 })), 'push');
});

test('a held-back push goes once you leave, unless the session moved on, you saw it, or an hour passed', () => {
  const p = (e: SessionEvent): Pending => ({ e, key: '1:a', sessionId: 'a', changedAt: 1_000, since: 1_000 });
  const o = { changedAt: 1_000, seenAt: 500, awayMs: 0, awayAfterMs: 180_000 };
  assert.equal(pendingVerdict(p(needs), 60_000, o), 'wait');
  assert.equal(pendingVerdict(p(needs), 240_000, { ...o, awayMs: 180_000 }), 'push');
  assert.equal(pendingVerdict(p(needs), 240_000, { ...o, changedAt: 2_000, awayMs: 1e9 }), 'drop');
  assert.equal(pendingVerdict(p(needs), 240_000, { ...o, changedAt: undefined, awayMs: 1e9 }), 'drop');
  assert.equal(pendingVerdict(p(finished(120_000)), 240_000, { ...o, seenAt: 1_000, awayMs: 1e9 }), 'drop');
  assert.equal(pendingVerdict(p(finished(120_000)), 240_000, { ...o, seenAt: 999, awayMs: 1e9 }), 'push');
  assert.equal(pendingVerdict(p(needs), 1_000 + PENDING_MS + 1, { ...o, awayMs: 1e9 }), 'drop');
});

function memorySecrets(): Secrets & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

test('the push target lives in secret storage, and a second store sees changes once it loads', async () => {
  const secrets = memorySecrets();
  const a = new PushStore(secrets);
  const b = new PushStore(secrets);
  assert.equal(await a.get(), undefined);
  await a.set({ server: 'https://ntfy.sh/', topic: 'sb-x', token: 'tk_1' });
  // b first reads it on its first get.
  assert.deepEqual(await b.get(), { server: 'https://ntfy.sh/', topic: 'sb-x', token: 'tk_1' });
  assert.deepEqual(b.peek(), { server: 'https://ntfy.sh/', topic: 'sb-x', token: 'tk_1' });
  await a.clear();
  // Until told of the change (onDidChange), b keeps what it read.
  assert.ok(await b.get());
  assert.equal(await b.load(), undefined);
  assert.equal(b.peek(), undefined);
  assert.equal(secrets.data.size, 0);
});

test('a broken stored value counts as not set up', async () => {
  const secrets = memorySecrets();
  secrets.data.set(PushStore.KEY, '{not json');
  assert.equal(await new PushStore(secrets).load(), undefined);
  secrets.data.set(PushStore.KEY, JSON.stringify({ server: 1 }));
  assert.equal(await new PushStore(secrets).load(), undefined);
});

async function withServer(status: number, run: (url: string, got: Array<{ req: IncomingMessage; body: string }>) => Promise<void>): Promise<void> {
  const got: Array<{ req: IncomingMessage; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ req, body });
      res.writeHead(status, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, got);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a push is one JSON POST to the server root, with the token as a bearer', async () => {
  await withServer(200, async (server, got) => {
    await sendPush({ server, topic: 'sb-x', token: 'tk_abc' }, { title: 'T', message: 'M', priority: 4, tags: ['bell'] });
    assert.equal(got.length, 1);
    assert.equal(got[0].req.method, 'POST');
    assert.equal(got[0].req.url, '/');
    assert.equal(got[0].req.headers.authorization, 'Bearer tk_abc');
    assert.equal(got[0].req.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(got[0].body), { topic: 'sb-x', title: 'T', message: 'M', priority: 4, tags: ['bell'] });
  });
  await withServer(200, async (server, got) => {
    await sendPush({ server, topic: 'sb-x' }, { title: 'T', message: 'M', priority: 3, tags: [] });
    assert.equal(got[0].req.headers.authorization, undefined);
  });
});

test('a refused push says why', async () => {
  await withServer(403, async (server) => {
    await assert.rejects(sendPush({ server, topic: 't', token: 'bad' }, { title: 'T', message: 'M', priority: 3, tags: [] }), /refused the access token/);
  });
  await withServer(429, async (server) => {
    await assert.rejects(sendPush({ server, topic: 't' }, { title: 'T', message: 'M', priority: 3, tags: [] }), /too many pushes/);
  });
  await assert.rejects(sendPush({ server: 'http://127.0.0.1:9/', topic: 't' }, { title: 'T', message: 'M', priority: 3, tags: [] }), /could not reach 127\.0\.0\.1:9/);
});

test('only the window that decides about a session pushes for it, so a watched tab never pushes from another window', () => {
  assert.equal(pushVerdict(needs, undefined, ctx({ decides: false, always: true })), 'drop');
  assert.equal(pushVerdict(needs, undefined, ctx({ decides: false, awayMs: 1e9 })), 'drop');
});

test('a push carries no tappable links, from the title, the folder or a quote', () => {
  const m = pushMessage(finished(1), 'See https://evil.example now', 'www.evil.com', { kind: 'question', ask: 'Open [x](command:y) or evil.io?' }, true);
  for (const text of [m.title, m.message]) {
    assert.ok(!/https?:\/\//.test(text), text);
    assert.ok(!/\w\.\w/.test(text), text);
    assert.ok(!text.includes(']('), text);
  }
  assert.equal(plainText('a.b').replace(/​/g, ''), 'a.b');
  assert.equal(plainText('done. Next'), 'done. Next');
});

test('a push that failed to send is tried again whether or not you are away, until the session moves on', () => {
  const p: Pending = { e: needs, key: '1:a', sessionId: 'a', changedAt: 1_000, since: 1_000, retry: true };
  const o = { changedAt: 1_000, seenAt: undefined, awayMs: 0, awayAfterMs: 180_000 };
  assert.equal(pendingVerdict(p, 60_000, o), 'push');
  assert.equal(pendingVerdict(p, 60_000, { ...o, changedAt: 5_000 }), 'drop');
  assert.equal(pendingVerdict(p, 1_000 + PENDING_MS + 1, o), 'drop');
});

test('an access token is checked before it is kept', () => {
  assert.equal(tokenProblem(''), undefined);
  assert.equal(tokenProblem(' tk_AbC123 '), undefined);
  assert.ok(tokenProblem('tk_a b'));
  assert.ok(tokenProblem('tk_a\r\nX-Evil: 1'));
});
