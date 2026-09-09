/*-------------------------------------------------------------------------
 *
 * Regression coverage for ast_edit diff-preview resource bounds.
 *
 * ast_edit uses a quadratic LCS matrix to build preview hunks. Large source
 * files must fail before that matrix is allocated, while ordinary edits keep
 * producing proposals.
 *
 * Run: node --test test/ast_edit_diff_budget.test.js
 *----------------------------------------------------------------------*/

import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTools } from '../lib/agent/tools.js';
import { resetPermissionService } from '../lib/config/setting.js';

async function makeTree() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hk2-ast-edit-diff-budget-'));
}

async function withWorkspace(tree, fn) {
  const prev = process.env.HK2_PROJECT_SOURCE;
  process.env.HK2_PROJECT_SOURCE = tree;
  resetPermissionService();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = prev;
    resetPermissionService();
  }
}

function getTools() {
  const tools = buildTools(null, {});
  return {
    astEdit: tools.find(t => t.name === 'ast_edit'),
    resolve: tools.find(t => t.name === 'resolve'),
  };
}

test('ast_edit rejects a diff preview that exceeds the LCS cell budget', async () => {
  const tree = await makeTree();
  const file = path.join(tree, 'large.js');
  try {
    const lines = ['targetCall();'];
    for (let i = 1; i < 4500; i++) lines.push(`keep(${i});`);
    await fs.writeFile(file, lines.join('\n') + '\n');

    await withWorkspace(tree, async () => {
      const { astEdit } = getTools();
      assert.ok(astEdit, 'ast_edit tool must exist');

      const result = await astEdit.execute({
        paths: [file],
        ops: [{ pat: 'targetCall()', out: 'renamedCall()' }],
      });

      assert.match(result.error || '', /diff preview exceeds safe size/);
      assert.equal(result.proposed, undefined, 'must not expose a partial proposal');
      assert.equal(result.proposalId, undefined, 'must not stage an oversized preview');
    });
  } finally {
    await fs.rm(tree, { recursive: true, force: true });
  }
});

test('ast_edit still produces normal proposals below the diff budget', async () => {
  const tree = await makeTree();
  const file = path.join(tree, 'small.js');
  try {
    await fs.writeFile(file, 'before();\ntargetCall();\nafter();\n');

    await withWorkspace(tree, async () => {
      const { astEdit, resolve } = getTools();
      const result = await astEdit.execute({
        paths: [file],
        ops: [{ pat: 'targetCall()', out: 'renamedCall()' }],
      });

      assert.equal(result.error, undefined);
      assert.equal(result.proposed, true);
      assert.ok(result.proposalId, 'normal edit should return a proposal id');

      const discarded = await resolve.execute({
        proposal_id: result.proposalId,
        action: 'discard',
      });
      assert.equal(discarded.discarded, 1);
    });
  } finally {
    await fs.rm(tree, { recursive: true, force: true });
  }
});
