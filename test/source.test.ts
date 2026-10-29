import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findClaude } from '../src/source';

test('a configured claude path must be absolute and runnable', async () => {
  assert.equal(await findClaude('bin/claude'), undefined);
  assert.equal(await findClaude('./claude'), undefined);
  assert.equal(await findClaude('/no/such/claude'), undefined);
  assert.equal(await findClaude('/bin/sh'), '/bin/sh');
});

test('the first look reads back past a last line longer than a chunk, and a half-written line waits', async () => {
  const { mkdtemp, mkdir, writeFile, appendFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SessionSource } = await import('../src/source');
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-'));
  try {
    const cwd = '/work/shop';
    const id = '11111111-2222-3333-4444-555555555555';
    const file = join(dir, 'projects', '-work-shop', `${id}.jsonl`);
    await mkdir(join(dir, 'projects', '-work-shop'), { recursive: true });
    const big = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { content: 'x'.repeat(2_500_000) } }], usage: { input_tokens: 99_000 } },
    });
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Big write' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Writing the file now.' }], usage: { input_tokens: 98_000 } } }),
      big,
    ];
    await writeFile(file, `${'{"type":"attachment"}\n'.repeat(60_000)}${lines.join('\n')}\n{"type":"assistant","mess`);
    const src = new SessionSource(dir, async () => undefined, () => {});
    const s = { pid: 1, sessionId: id, cwd, kind: 'interactive' as const, name: 'shop-1', status: 'idle' as const, startedAt: 0 };
    const d = await src.digestOf(s, 0);
    assert.equal(d?.aiTitle?.v, 'Big write');
    assert.equal(d?.reply?.v, 'Writing the file now.');
    assert.equal(d?.tokens?.v, 99_000, 'the 2.5 MB line counts');
    await appendFile(file, 'age":{"content":[{"type":"text","text":"Done."}]}}\n');
    assert.equal((await src.digestOf(s, 1))?.reply?.v, 'Done.', 'the half-written line is read once complete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('costOf counts the whole transcript and its helper agents, then only what is added', async () => {
  const { mkdtemp, mkdir, writeFile, appendFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SessionSource } = await import('../src/source');
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-'));
  const line = (id: string, input: number, extra: object = {}) =>
    `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input } }, ...extra })}\n`;
  try {
    const id = '11111111-2222-3333-4444-555555555555';
    const project = join(dir, 'projects', '-work-shop');
    await mkdir(join(project, id, 'subagents'), { recursive: true });
    await writeFile(join(project, `${id}.jsonl`), line('m1', 1_000_000) + line('m1', 1_000_000) + line('m2', 500_000));
    await writeFile(join(project, id, 'subagents', 'agent-a1.jsonl'), line('h1', 250_000, { isSidechain: true }));
    await writeFile(join(project, id, 'subagents', 'agent-a1.meta.json'), '{}');
    const src = new SessionSource(dir, async () => undefined, () => {});
    const s = { pid: 1, sessionId: id, cwd: '/work/shop', kind: 'interactive' as const, name: 'shop-1', status: 'idle' as const, startedAt: 0 };
    assert.equal(await src.costOf(s), undefined, 'nothing before digestOf finds the transcript');
    await src.digestOf(s, 0);
    let c = await src.costOf(s);
    assert.equal(c?.helpers, 1);
    assert.equal(c?.tally.replies, 3);
    assert.ok(Math.abs((c?.tally.usd ?? 0) - 3.5) < 1e-9, `${c?.tally.usd}`);
    await appendFile(join(project, `${id}.jsonl`), line('m3', 1_000_000));
    await appendFile(join(project, id, 'subagents', 'agent-a1.jsonl'), '{"type":"assistant","mess');
    c = await src.costOf(s);
    assert.equal(c?.tally.replies, 4, 'the new reply counts; the half-written one waits');
    assert.ok(Math.abs((c?.tally.usd ?? 0) - 5.5) < 1e-9);
    // A reply with no id can't be told apart, so counting it once proves only new lines are read.
    await appendFile(join(project, `${id}.jsonl`), line('', 1_000_000));
    await src.costOf(s);
    c = await src.costOf(s);
    assert.equal(c?.tally.replies, 5);
    // A line longer than one read (8 MB) is read whole, and what follows it counts.
    const huge = JSON.stringify({ type: 'user', message: { content: 'y'.repeat(9_000_000) } });
    await appendFile(join(project, `${id}.jsonl`), `${huge}\n${line('m9', 1_000_000)}`);
    c = await src.costOf(s);
    assert.equal(c?.tally.replies, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
