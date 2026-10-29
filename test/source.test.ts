import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findClaude } from '../src/source';

test('a configured claude path must be absolute and runnable', async () => {
  assert.equal(await findClaude('bin/claude'), undefined);
  assert.equal(await findClaude('./claude'), undefined);
  assert.equal(await findClaude('/no/such/claude'), undefined);
  assert.equal(await findClaude('/bin/sh'), '/bin/sh');
});
