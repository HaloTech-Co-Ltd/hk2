/*-------------------------------------------------------------------------
 *
 * Regression coverage for ast_edit directory-scope completeness.
 *
 * A mutation tool must never stage a proposal from a silently truncated
 * directory walk. When the 2000-file scan cap is exceeded, ast_edit fails
 * closed and asks the caller to narrow the requested paths.
 *
 * Run: node --test test/ast_edit_scope.test.js
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
  return fs.mkdtemp(path.join(os.tmpdir(), 'hk2-ast-edit-scope-'));
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

async function writeFiles(dir, count) {
  const batchSize = 100;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(count, start + batchSize);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) => {
        const i = start + offset;
        return fs.writeFile(path.join(dir, `file-${String(i).padStart(4, '0')}.js`), 'noop();\n');
      }),
    );
  }
}

test('ast_edit fails closed when a directory scan exceeds 2000 files', async () => {
  const tree = await makeTree();
  try {
    await writeFiles(tree, 2001);

    await withWorkspace(tree, async () => {
      const astEdit = buildTools(null, {}).find(t => t.name === 'ast_edit');
      assert.ok(astEdit, 'ast_edit tool must exist');

      const result = await astEdit.execute({
        paths: [tree],
        ops: [{ pat: 'noop()', out: 'changed()' }],
      });

      assert.match(result.error || '', /exceeded 2000 files/);
      assert.equal(result.proposed, undefined, 'must not stage a partial proposal');
      assert.equal(result.proposalId, undefined, 'must not return a proposal id');
    });
  } finally {
    await fs.rm(tree, { recursive: true, force: true });
  }
});
