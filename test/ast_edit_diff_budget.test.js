/* Regression coverage for ast_edit diff-preview resource bounds. */

import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTools } from '../lib/agent/tools.js';
import { resetPermissionService } from '../lib/config/setting.js';

async function runAtLineCount(lineCount) {
  const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-ast-edit-diff-budget-'));
  const file = path.join(tree, 'input.js');
  const previousSource = process.env.HK2_PROJECT_SOURCE;
  const lines = ['targetCall();'];
  for (let i = 1; i < lineCount; i++) lines.push(`keep(${i});`);
  await fs.writeFile(file, lines.join('\n') + '\n');
  process.env.HK2_PROJECT_SOURCE = tree;
  resetPermissionService();
  try {
    const tools = buildTools(null, {});
    const astEdit = tools.find(tool => tool.name === 'ast_edit');
    const resolve = tools.find(tool => tool.name === 'resolve');
    const result = await astEdit.execute({
      paths: [file],
      ops: [{ pat: 'targetCall()', out: 'renamedCall()' }],
    });
    return { result, resolve };
  } finally {
    if (previousSource === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = previousSource;
    resetPermissionService();
    await fs.rm(tree, { recursive: true, force: true });
  }
}

test('ast_edit permits exactly 4,000,000 full-file LCS cells', async () => {
  // 1,998 newline-terminated lines => (1,999 + 1)^2 = 4,000,000 cells.
  const { result, resolve } = await runAtLineCount(1998);
  assert.equal(result.error, undefined);
  assert.equal(result.proposed, true);
  assert.ok(result.proposalId);
  const discarded = await resolve.execute({ proposal_id: result.proposalId, action: 'discard' });
  assert.equal(discarded.discarded, 1);
});

test('ast_edit rejects 4,004,001 full-file LCS cells before staging', async () => {
  // 1,999 newline-terminated lines => (2,000 + 1)^2 = 4,004,001 cells.
  const { result } = await runAtLineCount(1999);
  assert.match(result.error || '', /full-file LCS budget/);
  assert.match(result.error || '', /reducing replacement scope will not help/);
  assert.equal(result.proposed, undefined);
  assert.equal(result.proposalId, undefined);
});
