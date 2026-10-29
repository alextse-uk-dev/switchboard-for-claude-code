import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { toCard } from '../src/core/card';
import { toSession } from '../src/core/parse';
import { askOf, contextTokens, gist, kickoffPrompt, mergeDigest, outcomeOf, plain, readChunk, type Digest } from '../src/core/transcript';

const line = (o: object) => JSON.stringify(o);
const reply = (text: string, tokens = 20_000, extra: object = {}) =>
  line({
    type: 'assistant',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 2, cache_read_input_tokens: tokens - 1_002, cache_creation_input_tokens: 1_000 },
    },
    ...extra,
  });
const toolCall = (tokens: number) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }], usage: { input_tokens: tokens } } });
const userText = (text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const recap = (content: string) => line({ type: 'system', subtype: 'away_summary', content });
const compact = (preTokens: number) => line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens } });

const digestOf = (...lines: string[]) => readChunk(lines.join('\n'), 0);

test('readChunk keeps the newest of each fact and skips cut lines and side chains', () => {
  const d = digestOf(
    'ai-title","aiTitle":"cut off"}',
    line({ type: 'ai-title', aiTitle: 'Old title' }),
    line({ type: 'user', message: 'mentions "type":"ai-title" in text' }),
    line({ type: 'custom-title', customTitle: 'My name' }),
    reply('First answer.', 30_000),
    line({ type: 'ai-title', aiTitle: 'New title' }),
    reply('A helper speaking.', 90_000, { isSidechain: true }),
    toolCall(31_000),
    reply('Second answer.', 32_000),
    '{"type":"assistant","message":{"content":[{"type":"te',
  );
  assert.equal(d.customTitle?.v, 'My name');
  assert.equal(d.aiTitle?.v, 'New title');
  assert.equal(d.reply?.v, 'Second answer.');
  assert.equal(contextTokens(d), 32_000);
});

test('a later chunk wins; an earlier chunk only fills gaps', () => {
  const later = readChunk(reply('Newest.'), 5_000);
  const earlier = readChunk([line({ type: 'ai-title', aiTitle: 'Title' }), reply('Older.')].join('\n'), 0);
  const d = mergeDigest(later, earlier);
  assert.equal(d.reply?.v, 'Newest.');
  assert.equal(d.aiTitle?.v, 'Title');
  assert.equal(readChunk(reply('Even newer.'), 9_000, d).reply?.v, 'Even newer.');
});

test('a compaction hides the old context size until the next reply', () => {
  const d = digestOf(reply('Done.', 180_000), compact(180_000));
  assert.equal(contextTokens(d), undefined);
  assert.equal(contextTokens(readChunk(reply('Back.', 25_000), 10_000, d)), 25_000);
});

test('outcomeOf: a plain final reply is done', () => {
  assert.deepEqual(outcomeOf(digestOf(reply('The parser now handles empty files, and all 40 tests pass.')), 150_000), { kind: 'done' });
  assert.deepEqual(outcomeOf(digestOf(), 150_000), { kind: 'blank' });
});

test('outcomeOf: a reply that ends by asking waits for your reply', () => {
  const o = outcomeOf(digestOf(reply('The fix is ready.\n\nShould I push the branch?')), 150_000);
  assert.deepEqual(o, { kind: 'question', ask: 'Should I push the branch?' });
  const imperative = outcomeOf(digestOf(reply('Two designs are on the page.\n\nReply **A** or **B**, or say what to change.')), 150_000);
  assert.equal(imperative.kind, 'question');
  const early = outcomeOf(digestOf(reply('Why was it slow? The cache was cold.\n\nIt is fixed now.\n\nAll tests pass.\n\nThe branch is pushed.')), 150_000);
  assert.equal(early.kind, 'done', 'a question far from the end is not an ask');
});

test('outcomeOf: a kickoff prompt hands over to a new session, and the prompt is found', () => {
  const text = [
    'Status: the parser is merged.',
    '',
    '### Kickoff prompt for the next session',
    '```',
    'Read NOTES.md (Status section) and start step 3: the exporter.',
    '```',
  ].join('\n');
  assert.deepEqual(outcomeOf(digestOf(reply(text)), 150_000), {
    kind: 'handoff',
    reason: 'kickoff',
    prompt: 'Read NOTES.md (Status section) and start step 3: the exporter.',
    line: 'Kickoff prompt for the next session',
  });
  const quoted = 'Paste this into a fresh session:\n\n> Read NOTES.md and finish the exporter.\n> Report status at the end.';
  const o = outcomeOf(digestOf(reply(quoted)), 150_000);
  assert.equal(o.kind === 'handoff' && o.prompt, 'Read NOTES.md and finish the exporter.\nReport status at the end.');
});

test('outcomeOf: a large context suggests a new session, unless 0 turns it off or a question waits', () => {
  assert.deepEqual(outcomeOf(digestOf(reply('All done.', 160_000)), 150_000), { kind: 'handoff', reason: 'context' });
  assert.deepEqual(outcomeOf(digestOf(reply('All done.', 160_000)), 0), { kind: 'done' });
  assert.equal(outcomeOf(digestOf(reply('Shall I merge it?', 160_000)), 150_000).kind, 'question');
  assert.deepEqual(outcomeOf(digestOf(reply('All done.', 160_000), compact(160_000)), 150_000), { kind: 'done' });
});

test('outcomeOf: an API error or an interrupt after the reply means it stopped', () => {
  const err = reply('API Error: 529 overloaded', 0, { isApiErrorMessage: true });
  assert.deepEqual(outcomeOf(digestOf(reply('Working on it.'), err), 150_000), { kind: 'stopped', why: 'error', text: 'API Error: 529 overloaded' });
  assert.deepEqual(outcomeOf(digestOf(reply('Working on it.'), userText('[Request interrupted by user]')), 150_000), {
    kind: 'stopped',
    why: 'interrupted',
    text: undefined,
  });
  assert.equal(outcomeOf(digestOf(userText('[Request interrupted by user]'), reply('Picked it up again.')), 150_000).kind, 'done');
});

test('kickoffPrompt ignores a fence that is too short to be a prompt', () => {
  assert.equal(kickoffPrompt('Kickoff:\n```\nok\n```'), undefined);
});

test('askOf and plain read markdown as text', () => {
  assert.equal(askOf('Done.\n\n- **Want me to** open the [PR](https://example.com)?'), 'Want me to open the PR?');
  assert.equal(plain('## **Status**: `ready`'), 'Status: ready');
  assert.equal(plain('> 1. Read [the note](/tmp/n.md)'), 'Read the note');
  assert.equal(plain('Go on? [Yes]**(command:x.y)** ?'), 'Go on? Yes ?', 'emphasis cannot rebuild a link');
});

test('gist: the recap when it is newer, else the first real paragraph', () => {
  assert.equal(gist(digestOf(reply('## Status\n\nThe exporter is **merged**.\n\nMore below.'))), 'The exporter is merged.');
  assert.equal(gist(digestOf(reply('Merged.'), recap('You asked for an exporter; it is merged.'))), 'You asked for an exporter; it is merged.');
  assert.equal(gist(digestOf(recap('Old recap.'), reply('New reply.'))), 'New reply.');
  assert.equal(gist(digestOf(reply('word '.repeat(2000).trim())))?.length, 9999, 'never cut short, however long the line');
  assert.equal(plain(`**${'a*'.repeat(5000)}**`).length, 10004, 'a very long line keeps its text, emphasis and all');
});

test('toCard: words, chips and the context meter', () => {
  const s = toSession({ pid: 7, sessionId: 'abcdef12-0000', cwd: '/home/sam/code/shop', kind: 'interactive', name: 'shop-3', status: 'idle' })!;
  const d: Digest = digestOf(reply('Ready.\n\nShould I push it?', 120_000));
  const outcome = outcomeOf(d, 150_000);
  const c = toCard({ s, title: 'Fix checkout', group: 'reply', outcome, digest: d, unread: true, where: 'elsewhere', freshTokens: 150_000, home: '/home/sam' });
  assert.equal(c.state, 'asks you');
  assert.equal(c.detail, 'Should I push it?');
  assert.equal(c.quote, true);
  assert.deepEqual(c.chips, ['other window']);
  assert.equal(c.tokens, 120_000);
  assert.equal(c.folder, 'shop');
  assert.equal(c.cwd, '~/code/shop');
  assert.equal(c.prompt, false);
  const bg = toCard({ s: { ...s, kind: 'background' }, title: 'x', group: 'working', unread: false, where: 'outside', freshTokens: 0, home: '' });
  assert.deepEqual(bg.chips, ['background']);
  assert.equal(bg.state, 'working');
});

test('toCard: a hand-over card shows the prompt it would send; ~ only for real subfolders of home', () => {
  const s = toSession({ pid: 7, sessionId: 'abcdef12-0000', cwd: '/home/samuel/shop', kind: 'interactive', name: 'shop-3', status: 'idle' })!;
  const d = digestOf(reply('Kickoff prompt:\n```\nRead NOTES.md and start step 3.\n```'));
  const c = toCard({ s, title: 'x', group: 'handoff', outcome: outcomeOf(d, 150_000), digest: d, unread: false, where: 'here', freshTokens: 150_000, home: '/home/sam' });
  assert.equal(c.detail, 'Read NOTES.md and start step 3.');
  assert.equal(c.prompt, true);
  assert.equal(c.cwd, '/home/samuel/shop');
});

test('toCard: cost, model and the whole reply', () => {
  const s = toSession({ pid: 7, sessionId: 'abcdef12-0000', cwd: '/home/sam/shop', kind: 'interactive', name: 'shop-3', status: 'idle' })!;
  const long = line({
    type: 'assistant',
    message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Merged.\n\n## Details\n\n- The exporter writes CSV and JSON.\n- 18 tests were added.' }], usage: { input_tokens: 10 } },
  });
  const d = digestOf(long);
  const tally = { usd: 12.4, replies: 30, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, unpriced: {} };
  const base = { s, title: 'x', group: 'done' as const, outcome: outcomeOf(d, 150_000), digest: d, unread: false, where: 'here' as const, freshTokens: 150_000, home: '/home/sam' };
  const c = toCard({ ...base, tally, helpers: 2 });
  assert.equal(c.cost, '$12.40');
  assert.match(c.costTip[0], /30 replies, 2 helper agents included/);
  assert.equal(c.model, 'Opus 5.5');
  assert.equal(c.detail, 'Merged.');
  assert.match(c.reply ?? '', /18 tests were added/);
  assert.equal(toCard({ ...base, tally: { ...tally, unpriced: { 'odd-model': 1 } } }).cost, '$12.40+', 'a + when some replies have no price');
  assert.equal(toCard({ ...base, tally, showCost: false }).cost, undefined);
  assert.equal(toCard({ ...base, tally: { ...tally, replies: 0 } }).cost, undefined);
  const short = digestOf(reply('**Merged.**'));
  assert.equal(toCard({ ...base, digest: short, outcome: outcomeOf(short, 150_000) }).reply, undefined, 'no "whole reply" when the detail already says it all');
});
