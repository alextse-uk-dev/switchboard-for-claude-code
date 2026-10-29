import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isModelId, launchCommand, launchSummary, readDefaults } from '../src/core/launch';

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

test('launchSummary lists everything the session starts with, and names the defaults', () => {
  assert.equal(
    launchSummary({ name: 'Fix login', where: '~/code/web', model: 'opus', effort: 'high', task: 'Find the bug', defaults: {} }),
    'Name: Fix login\nFolder: ~/code/web\nModel: opus\nEffort: high\n\nFirst message:\n\nFind the bug',
  );
  const d = launchSummary({ name: '', where: '/srv/app', task: ' ', defaults: { model: 'sonnet', effort: 'xhigh', from: "the project's .claude/settings.json" }, after: 'The old session stays open.' });
  assert.equal(
    d,
    "Name: none (Claude names it)\nFolder: /srv/app\nModel: default (sonnet, from the project's .claude/settings.json)\nEffort: default (xhigh, from your Claude Code settings)\n\nFirst message: none (a blank prompt).\n\nThe old session stays open.",
  );
  assert.match(launchSummary({ name: 'x', where: '~', task: 'Read NOTES.md', firstFrom: 'the kickoff prompt from "Parser"', defaults: {} }), /First message, the kickoff prompt from "Parser":\n\nRead NOTES.md/);
  assert.match(launchSummary({ name: 'x', where: '~', task: '', defaults: {} }), /Model: Claude Code's default\nEffort: Claude Code's default/);
});
