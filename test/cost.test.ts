import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { costOf, countLines, emptyCost, formatUsd, modelKey, modelName, sumTallies, usageOf } from '../src/core/cost';

const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const reply = (id: string, model: string, usage: object, extra: object = {}) =>
  JSON.stringify({ type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'Hi' }], usage }, ...extra });

test('modelKey drops cloud prefixes, context tags, versions and dates; modelName reads it', () => {
  assert.equal(modelKey('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(modelKey('us.anthropic.claude-opus-4-5-20251101-v1:0'), 'claude-opus-4-5');
  assert.equal(modelKey('claude-opus-4-5@20251101'), 'claude-opus-4-5');
  assert.equal(modelKey('claude-3-5-haiku-20241022'), 'claude-3-5-haiku');
  assert.equal(modelKey('global.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelName('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelName('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(modelName('gpt-x'), 'gpt-x');
});

test('costOf prices input, output, cache reads and both kinds of cache write', () => {
  const u = usageOf({
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 3_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 2_000_000 },
  })!;
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, 2 × 1.25 × $4 + 1 × 2 × $4 in writes.
  near(costOf('claude-opus-5-5', u), 4 + 20 + 0.2 + 10 + 8);
  near(costOf('claude-opus-5-5', { ...u, fast: true }), 2 * (4 + 20 + 0.2 + 10 + 8));
  // Fast mode with no known fast price costs the same.
  near(costOf('claude-sonnet-5-5', { ...u, fast: true }), costOf('claude-sonnet-5-5', u)!);
  assert.equal(costOf('claude-unknown-9', u), undefined);
});

test('usageOf prices unsplit cache writes as 5-minute ones and ignores junk', () => {
  const u = usageOf({ input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: -5, speed: 'fast' })!;
  assert.deepEqual(u, { input: 10, output: 0, cacheRead: 0, write5m: 100, write1h: 0, fast: true });
  assert.equal(usageOf(null), undefined);
});

test('Sonnet 4.5 bills a prompt over 200k tokens at its 1M-context rate', () => {
  near(costOf('claude-sonnet-4-5', usageOf({ input_tokens: 200_000, output_tokens: 1_000_000 })!), 0.6 + 15);
  near(costOf('claude-sonnet-4-5', usageOf({ input_tokens: 100_000, cache_read_input_tokens: 100_001, output_tokens: 1_000_000 })!), 0.6 + 0.0600006 + 22.5);
});

test('Haiku 5.5 bills a prompt over 100k tokens at its higher rate', () => {
  const small = usageOf({ input_tokens: 100_000, output_tokens: 1_000_000 })!;
  const big = usageOf({ input_tokens: 100_001, output_tokens: 1_000_000 })!;
  near(costOf('claude-haiku-5-5', small), 0.01 + 0.5);
  near(costOf('claude-haiku-5-5', big), (100_001 * 0.5) / 1e6 + 2.5);
});

test('countLines counts each reply once, helpers included, and notes models with no price', () => {
  const c = emptyCost();
  const u = { input_tokens: 1_000_000, output_tokens: 0 };
  countLines(
    [
      reply('msg_1', 'claude-sonnet-5-5', u),
      reply('msg_1', 'claude-sonnet-5-5', u),
      reply('msg_2', 'claude-sonnet-5-5', u, { isSidechain: true }),
      reply('msg_3', '<synthetic>', u),
      reply('msg_4', 'mystery-model', u),
      JSON.stringify({ type: 'user', message: { content: 'says "type":"assistant" in passing' } }),
      '{"type":"assistant","message":{"id":"msg_5"',
    ].join('\n'),
    c,
  );
  countLines(reply('msg_2', 'claude-sonnet-5-5', u), c);
  assert.equal(c.tally.replies, 3);
  near(c.tally.usd, 4);
  assert.deepEqual(c.tally.unpriced, { 'mystery-model': 1 });
  assert.equal(c.tally.input, 3_000_000);
  const both = sumTallies([c.tally, c.tally]);
  near(both.usd, 8);
  assert.deepEqual(both.unpriced, { 'mystery-model': 2 });
});

test('formatUsd', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.001), '<$0.01');
  assert.equal(formatUsd(12.4), '$12.40');
  assert.equal(formatUsd(1234.5), '$1,235');
});
