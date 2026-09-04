import test from 'node:test';
import assert from 'node:assert/strict';
import { Checkpoint } from '../lib/index/checkpoint.js';
import { resolveInitCheckpointConfig } from '../src/slash/kb.js';
import { resolveIndexerCheckpointInterval } from '../lib/index/indexer.js';

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

test('interactive /kb init checkpoint parsing preserves flag and environment boundaries', () => {
  const envCases = [
    [undefined, 100], ['', 100], ['0', 100], ['abc', 100], ['50', 50], ['-2', -2],
  ];
  for (const [value, expected] of envCases) {
    const env = value === undefined ? {} : { HK2_KB_CHECKPOINT_INTERVAL: value };
    assert.equal(resolveInitCheckpointConfig([], env).checkpointInterval, expected, String(value));
  }
  assert.equal(resolveInitCheckpointConfig(['--checkpoint-interval=0'], {}).checkpointInterval, 0);
  assert.ok(Number.isNaN(resolveInitCheckpointConfig(['--checkpoint-interval=abc'], {}).checkpointInterval));
  assert.ok(Number.isNaN(resolveInitCheckpointConfig(['--checkpoint-interval', 'abc'], {}).checkpointInterval));
  assert.ok(Number.isNaN(resolveInitCheckpointConfig(['--checkpoint-interval'], {}).checkpointInterval));
  assert.equal(resolveInitCheckpointConfig(['--checkpoint-interval='], { HK2_KB_CHECKPOINT_INTERVAL: '50' }).checkpointInterval, 50);
  assert.equal(resolveInitCheckpointConfig(['--no-checkpoint'], {}).enabled, false);
});

test('direct buildIndex checkpoint parsing passes options and environment values through', () => {
  assert.equal(resolveIndexerCheckpointInterval({ checkpointInterval: 0 }, { HK2_KB_CHECKPOINT_INTERVAL: '50' }), 0);
  assert.equal(resolveIndexerCheckpointInterval({ checkpointInterval: -2 }, {}), -2);
  assert.equal(resolveIndexerCheckpointInterval({}, {}), 100);
  assert.equal(resolveIndexerCheckpointInterval({}, { HK2_KB_CHECKPOINT_INTERVAL: '' }), 100);
  assert.equal(resolveIndexerCheckpointInterval({}, { HK2_KB_CHECKPOINT_INTERVAL: '0' }), 0);
  assert.ok(Number.isNaN(resolveIndexerCheckpointInterval({}, { HK2_KB_CHECKPOINT_INTERVAL: 'abc' })));
  assert.equal(resolveIndexerCheckpointInterval({}, { HK2_KB_CHECKPOINT_INTERVAL: '-2' }), -2);
});
