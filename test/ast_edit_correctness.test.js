/* Regression coverage for ast_edit match positioning and wildcard substitution. */

import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTools } from '../lib/agent/tools.js';
import { resetPermissionService } from '../lib/config/setting.js';
import { queryPattern } from '../lib/parser/ts_parser.js';

async function rewrite(source, pat, out) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-ast-edit-correctness-'));
  const file = path.join(dir, 'input.js');
  const previousSource = process.env.HK2_PROJECT_SOURCE;
  await fs.writeFile(file, source);
  process.env.HK2_PROJECT_SOURCE = dir;
  resetPermissionService();
  try {
    const tools = buildTools(null, {});
    const preview = await tools.find(tool => tool.name === 'ast_edit').execute({
      paths: [file],
      ops: [{ pat, out }],
    });
    assert.equal(preview.error, undefined);
    assert.equal(preview.proposed, true);
    const applied = await tools.find(tool => tool.name === 'resolve').execute({
      proposal_id: preview.proposalId,
      action: 'apply',
    });
    assert.equal(applied.error, undefined);
    return await fs.readFile(file, 'utf8');
  } finally {
    if (previousSource === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = previousSource;
    resetPermissionService();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('documented anonymous $$$ rewrite preserves arguments', async () => {
  assert.equal(
    await rewrite('console.log(a, b);\n', 'console.log($$$)', 'logger.info($$$)'),
    'logger.info(a, b);\n',
  );
});

test('identical calls are each rewritten once when replacement wraps the match', async () => {
  assert.equal(
    await rewrite(
      'console.log(a);\nconsole.log(a);\n',
      'console.log($$$ARGS)',
      'wrap(console.log($$$ARGS))',
    ),
    'wrap(console.log(a));\nwrap(console.log(a));\n',
  );
});

test('anonymous multi-wildcards preserve multi-line captures', async () => {
  assert.equal(
    await rewrite('console.log(\n  a,\n  b\n);\n', 'console.log($$$)', 'logger.info($$$)'),
    'logger.info(\n  a,\n  b\n);\n',
  );
});

test('named and anonymous wildcards can be mixed and reordered', async () => {
  assert.equal(
    await rewrite('call(first, middle, last);\n', 'call($FIRST, $$$, $LAST)', 'call($LAST, $$$, $FIRST)'),
    'call(last, middle, first);\n',
  );
});

test('queryPattern returns exact, non-overlapping half-open offsets', () => {
  const source = 'console.log(a);\nconsole.log(a);';
  const matches = queryPattern(source, 'console.log($$$ARGS)');
  assert.deepEqual(
    matches.map(({ startOffset, endOffset }) => [startOffset, endOffset]),
    [[0, 14], [16, 30]],
  );
  for (let i = 1; i < matches.length; i++) {
    assert.ok(matches[i - 1].endOffset <= matches[i].startOffset);
  }
});
