import test from 'node:test';
import assert from 'node:assert/strict';
import { __learnTest } from '../src/slash/kb.js';

const { parsePlanText } = __learnTest;

test('parsePlanText parses clean pipe-delimited plan lines', () => {
  const plan = parsePlanText(
    'buffer-pool | shared buffer cache | storage/buffer/bufmgr.c, storage/buffer/freelist.c\n' +
    'xact-mgmt | transaction lifecycle | access/transam/xact.c',
  );
  assert.ok(plan);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].topic, 'buffer-pool');
  assert.deepEqual(plan[0].files, ['storage/buffer/bufmgr.c', 'storage/buffer/freelist.c']);
});

test('parsePlanText parses a markdown table body row', () => {
  const plan = parsePlanText(
    '| topic | desc | files |\n|---|---|---|\n| buffer-pool | desc | storage/buffer/bufmgr.c |',
  );
  assert.ok(plan);
  assert.equal(plan[0].topic, 'buffer-pool');
  assert.deepEqual(plan[0].files, ['storage/buffer/bufmgr.c']);
});

test('parsePlanText normalizes full-width pipes and semicolon file separators', () => {
  const plan = parsePlanText('buffer-pool ｜ desc ｜ storage/a.c; storage/b.h');
  assert.ok(plan);
  assert.equal(plan[0].topic, 'buffer-pool');
  assert.deepEqual(plan[0].files, ['storage/a.c', 'storage/b.h']);
});

test('parsePlanText extracts the plan from a fenced code block, ignoring prose', () => {
  const plan = parsePlanText(
    'Here is the plan:\n```text\nbuffer-pool | desc | storage/a.c\n```\nDone.',
  );
  assert.ok(plan);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].topic, 'buffer-pool');
});

test('parsePlanText still rejects prose reasoning with no pipe-delimited plan', () => {
  const plan = parsePlanText(
    'Let me group these files by topic.\nFirst I will consider the storage layer and its files.',
  );
  assert.equal(plan, null);
});

test('parsePlanText still rejects bullet / comma formats (no pipe delimiter)', () => {
  assert.equal(parsePlanText('- buffer-pool: desc\n  - storage/a.c'), null);
  assert.equal(parsePlanText('buffer-pool, desc, storage/a.c'), null);
});
