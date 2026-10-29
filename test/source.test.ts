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
