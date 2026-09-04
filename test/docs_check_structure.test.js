/*-------------------------------------------------------------------------
 * Test: docs checker structure gates (TODO scope, H1, language switch,
 * heading skips) — end-to-end against a throwaway mini-repo.
 *-------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
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


test('language switch uses resolved target and only the first post-H1 block', () => {
  const { root } = makeRepo();
  // The checker must resolve the actual link target rather than comparing a
  // platform-specific path.relative() string (Windows uses backslashes).
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    '# Page\n\nEnglish | [简体中文](../../zh-CN/x/p.md)\n\n## Body\n\n```bash\n# not a heading\n```\n');
  writeFileSync(path.join(root, 'docs/zh-CN/x/p.md'),
    '# 页\n\n[English](../../en/x/p.md) | 简体中文\n\n## 正文\n\n```bash\n# 不是标题\n```\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  rmSync(root, { recursive: true, force: true });
});

test('wrong language partner path fails even when its label is correct', () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    '# Page\n\nEnglish | [简体中文](../../zh-CN/x/missing.md)\n');
  const r = run(root);
  assert.match(r.out, /broken local link: \.\.\/\.\.\/zh-CN\/x\/missing\.md/);
  assert.match(r.out, /no language-switch link to zh-CN counterpart/);
  rmSync(root, { recursive: true, force: true });
});

test('multiple H1s report structure only, not a misleading first-block error', () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    '# First\n\nEnglish | [简体中文](../../zh-CN/x/p.md)\n\n# Second\n');
  const r = run(root);
  assert.match(r.out, /has 2 ATX H1/);
  assert.doesNotMatch(r.out, /language-switch link not in the first block/);
  rmSync(root, { recursive: true, force: true });
});

function replacePages(root, enBody, zhBody) {
  writeFileSync(path.join(root, 'docs/en/x/p.md'), enBody);
  writeFileSync(path.join(root, 'docs/zh-CN/x/p.md'), zhBody);
}

function parityPage(languageLink, body) {
  return `# Page\n\n${languageLink}\n\n${body}\n`;
}

test('paired heading levels must match, while translated heading text may differ', () => {
  const { root } = makeRepo();
  replacePages(root,
    parityPage('English | [简体中文](../../zh-CN/x/p.md)', '## English section\n### Detail'),
    parityPage('[English](../../en/x/p.md) | 简体中文', '## 中文章节\n### 细节'));
  assert.equal(run(root).code, 0);
  replacePages(root,
    parityPage('English | [简体中文](../../zh-CN/x/p.md)', '## English section\n### Detail'),
    parityPage('[English](../../en/x/p.md) | 简体中文', '## 中文章节\n#### 跳级'));
  assert.match(run(root).out, /heading-level sequence differs/);
  rmSync(root, { recursive: true, force: true });
});

test('paired table count, columns, and data rows must match', () => {
  const { root } = makeRepo();
  const linkEn = 'English | [简体中文](../../zh-CN/x/p.md)';
  const linkZh = '[English](../../en/x/p.md) | 简体中文';
  const table = '| A | B |\n|---|---|\n| 1 | 2 |';
  replacePages(root, parityPage(linkEn, table), parityPage(linkZh, table));
  assert.equal(run(root).code, 0);

  replacePages(root, parityPage(linkEn, table), parityPage(linkZh, '## No table'));
  assert.match(run(root).out, /table structural signature differs/);
  replacePages(root, parityPage(linkEn, table), parityPage(linkZh, '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |'));
  assert.match(run(root).out, /table structural signature differs/);
  replacePages(root, parityPage(linkEn, table), parityPage(linkZh, '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'));
  assert.match(run(root).out, /table structural signature differs/);
  rmSync(root, { recursive: true, force: true });
});

test('paired fenced-code language sequences must match and fenced content is ignored', () => {
  const { root } = makeRepo();
  const linkEn = 'English | [简体中文](../../zh-CN/x/p.md)';
  const linkZh = '[English](../../en/x/p.md) | 简体中文';
  const en = '## Same\n\nPlain prose | is not a table, and `inline | code` is not one either.\n\n```bash\n# fake heading\n| fake | table |\n```';
  const zh = '## 不同标题\n\n普通正文 | 不是表格，`inline | code` 也不是。\n\n```bash\n# 假标题\n| 假 | 表格 |\n```';
  replacePages(root, parityPage(linkEn, en), parityPage(linkZh, zh));
  assert.equal(run(root).code, 0);
  replacePages(root, parityPage(linkEn, en), parityPage(linkZh, '## 不同标题\n\n```text\n# 假标题\n| 假 | 表格 |\n```'));
  assert.match(run(root).out, /fenced-code language sequence differs/);
  rmSync(root, { recursive: true, force: true });
});

test('key runtime contract tokens are present in both language pages', () => {
  const pairs = [
    ['reference/environment-variables.md', ['--checkpoint-interval=']],
    ['reference/slash-commands.md', ['--checkpoint-interval=']],
    ['reference/agent-tools.md', ['autoAccepted']],
    ['guides/knowledge-workflows.md', ['--checkpoint-interval=']],
    ['guides/planning-and-review.md', ['autoAccepted']],
    ['concepts/agent-workflow.md', ['autoAccepted', 'supersededBy', 'NO_PROGRESS_TURNS']],
  ];
  for (const [rel, tokens] of pairs) {
    const en = readFileSync(path.join('docs/en', rel), 'utf8');
    const zh = readFileSync(path.join('docs/zh-CN', rel), 'utf8');
    for (const token of tokens) {
      assert.ok(en.includes(token), `English ${rel} missing ${token}`);
      assert.ok(zh.includes(token), `Chinese ${rel} missing ${token}`);
    }
  }
  const enArch = readFileSync('docs/en/development/architecture.md', 'utf8');
  const zhArch = readFileSync('docs/zh-CN/development/architecture.md', 'utf8');
  assert.match(enArch, /common outer gate/i);
  assert.match(zhArch, /共同外层门/);
});
