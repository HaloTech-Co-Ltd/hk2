import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Checkpoint } from '../lib/index/checkpoint.js';

test('Checkpoint saves nearly every mark for zero, negative, and NaN intervals', async () => {
  for (const interval of [0, -1, NaN]) {
    const cp = new Checkpoint('test', { interval });
    let writes = 0;
    cp._write = async () => { writes++; };
    await cp.markDone('a.js', 'a');
    await cp.saveIfDue();
    assert.equal(writes, 1, `interval ${interval} should satisfy counter >= interval`);
  }
});

test('Checkpoint no-checkpoint mode suppresses mark and save', async () => {
  const cp = new Checkpoint('test', { interval: 0, enabled: false });
  let writes = 0;
  cp._write = async () => { writes++; };
  await cp.markDone('a.js', 'a');
  await cp.saveIfDue();
  assert.equal(cp.size, 0);
  assert.equal(writes, 0);
});

test('entry-point source keeps interactive and direct indexer checkpoint wrappers distinct', async () => {
  const slash = await readFile(new URL('../src/slash/kb.js', import.meta.url), 'utf8');
  const indexer = await readFile(new URL('../lib/index/indexer.js', import.meta.url), 'utf8');
  assert.match(slash, /parseInt\(process\.env\.HK2_KB_CHECKPOINT_INTERVAL, 10\) \|\| 100/);
  assert.match(indexer, /opts\.checkpointInterval \?\? parseInt\(process\.env\.HK2_KB_CHECKPOINT_INTERVAL \|\| '100', 10\)/);
  assert.match(slash, /no-checkpoint/);
});
