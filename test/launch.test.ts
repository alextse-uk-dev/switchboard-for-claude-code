import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isModelId, launchCommand, readDefaults } from '../src/core/launch';

test('launchCommand passes the model and effort, quoted, before the first message', () => {
  assert.equal(
    launchCommand({ claude: '/usr/local/bin/claude', name: "Bob's fix", model: 'opus', effort: 'high', task: 'Find the bug' }),
    `'/usr/local/bin/claude' -n 'Bob'\\''s fix' --model 'opus' --effort high 'Find the bug'`,
  );
  assert.equal(launchCommand({ claude: 'claude', model: 'claude-opus-5-5[1m]', task: '-v is broken' }), `'claude' --model 'claude-opus-5-5[1m]' -- '-v is broken'`);
  assert.equal(launchCommand({ claude: 'claude', name: '  ', model: '', effort: '' }), `'claude'`, 'blank choices mean the defaults');
});

test('launchCommand leaves out a model or effort that is not well formed', () => {
  assert.equal(launchCommand({ claude: 'claude', model: 'opus; rm -rf ~', effort: 'extreme' }), `'claude'`);
  assert.equal(isModelId('us.anthropic.claude-opus-4-5-20251101-v1:0'), true);
  assert.equal(isModelId('opus plan'), false);
  assert.equal(isModelId('-model'), false);
});

test('readDefaults: the project overrides the user, and a broken file is skipped', () => {
  const d = readDefaults([
    { name: 'user', text: JSON.stringify({ model: 'sonnet', effortLevel: 'xhigh' }) },
    { name: 'project', text: JSON.stringify({ model: 'opus' }) },
    { name: 'local', text: '{ not json' },
    { name: 'missing', text: undefined },
  ]);
  assert.deepEqual(d, { model: 'opus', from: 'project', effort: 'xhigh' });
  assert.deepEqual(readDefaults([{ name: 'user', text: JSON.stringify({ effortLevel: 'bogus' }) }]), {});
});
