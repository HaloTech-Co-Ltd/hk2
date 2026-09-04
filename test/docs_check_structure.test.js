/*-------------------------------------------------------------------------
 * Test: docs checker structure gates (TODO scope, H1, language switch,
 * heading skips) — end-to-end against a throwaway mini-repo.
 *-------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'hk2docs-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'docs/en/x'), { recursive: true });
  mkdirSync(path.join(root, 'docs/zh-CN/x'), { recursive: true });
  cpSync('scripts/check-docs.mjs', path.join(root, 'scripts/check-docs.mjs'));
  writeFileSync(path.join(root, 'README.md'),
    '# Root\n\n[zh](README_zh.md) docs [en](docs/en/README.md)\n');
  writeFileSync(path.join(root, 'README_zh.md'),
    '# 根\n\n[en](README.md) docs [zh](docs/zh-CN/README.md)\n');
  writeFileSync(path.join(root, 'docs/README.md'),
    '# Idx\n\n- [en](en/README.md)\n- [zh](zh-CN/README.md)\n');
  writeFileSync(path.join(root, 'docs/en/README.md'),
    '# En\n\nEnglish | [简体中文](../zh-CN/README.md)\n');
  writeFileSync(path.join(root, 'docs/zh-CN/README.md'),
    '# Zh\n\n[English](../en/README.md) | 简体中文\n');
  const en = '# Page\n\nEnglish | [简体中文](../../zh-CN/x/p.md)\n\n```bash\n# not a heading\n```\n';
  const zh = '# 页\n\n[English](../../en/x/p.md) | 简体中文\n\n```bash\n# 不是标题\n```\n';
  writeFileSync(path.join(root, 'docs/en/x/p.md'), en);
  writeFileSync(path.join(root, 'docs/zh-CN/x/p.md'), zh);
  return { root, en, zh };
}

function run(root) {
  try {
    const out = execFileSync('node', [path.join(root, 'scripts/check-docs.mjs')], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

test('valid mini-repo passes; fenced # is not a heading', () => {
  const { root } = makeRepo();
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  rmSync(root, { recursive: true, force: true });
});

test('TODO in the ROOT README is caught', () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'README.md'),
    '# Root\n\n[zh](README_zh.md) docs [en](docs/en/README.md)\n\nTODO fix\n');
  const r = run(root);
  assert.match(r.out, /README\.md: contains a TODO\/TBD marker/);
  rmSync(root, { recursive: true, force: true });
});

test('zero H1 and double H1 are both caught', () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    'English | [简体中文](../../zh-CN/x/p.md)\n');
  let r = run(root);
  assert.match(r.out, /docs\/en\/x\/p\.md: has 0 ATX H1/);
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    '# A\n\nEnglish | [简体中文](../../zh-CN/x/p.md)\n\n# B\n');
  r = run(root);
  assert.match(r.out, /docs\/en\/x\/p\.md: has 2 ATX H1/);
  rmSync(root, { recursive: true, force: true });
});

test('language switch not directly under the H1 is caught', () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    '# Page\n\nSome intro paragraph first.\n\nEnglish | [简体中文](../../zh-CN/x/p.md)\n');
  const r = run(root);
  assert.match(r.out, /language-switch link not in the first block under the H1/);
  rmSync(root, { recursive: true, force: true });
});

test('heading level skip is caught', () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    '# Page\n\nEnglish | [简体中文](../../zh-CN/x/p.md)\n\n## Two\n\n#### Four\n');
  const r = run(root);
  assert.match(r.out, /heading level skips from H2 to H4/);
  rmSync(root, { recursive: true, force: true });
});
