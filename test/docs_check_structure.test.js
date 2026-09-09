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

test('ATX headings with zero through three leading spaces are checked', () => {
  const { root } = makeRepo();
  const enLink = 'English | [简体中文](../../zh-CN/x/p.md)';
  const zhLink = '[English](../../en/x/p.md) | 简体中文';
  replacePages(root,
    parityPage(enLink, '## Two\n\n ### Three\n\n  #### Four\n\n   ##### Five'),
    parityPage(zhLink, '## 二\n\n ### 三\n\n  #### 四\n\n   ##### 五'));
  assert.equal(run(root).code, 0);
  writeFileSync(path.join(root, 'docs/en/x/p.md'),
    `# Page\n\n${enLink}\n\n   ### Skips H2\n`);
  const r = run(root);
  assert.match(r.out, /heading level skips from H1 to H3/);
  rmSync(root, { recursive: true, force: true });
});

test('four leading spaces are not parsed as an ATX heading', () => {
  const { root } = makeRepo();
  replacePages(root,
    parityPage('English | [简体中文](../../zh-CN/x/p.md)', '## Section\n\n    ### indented code'),
    parityPage('[English](../../en/x/p.md) | 简体中文', '## 章节\n\n    ### 缩进行'));
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  rmSync(root, { recursive: true, force: true });
});

test('paired heading parity recognizes indentation and catches an H2/H3 mismatch', () => {
  const { root } = makeRepo();
  replacePages(root,
    parityPage('English | [简体中文](../../zh-CN/x/p.md)', '## Section\n\n   ### Detail'),
    parityPage('[English](../../en/x/p.md) | 简体中文', '## 章节\n\n### 细节'));
  assert.equal(run(root).code, 0);
  replacePages(root,
    parityPage('English | [简体中文](../../zh-CN/x/p.md)', '## Section'),
    parityPage('[English](../../en/x/p.md) | 简体中文', '   ### 章节'));
  assert.match(run(root).out, /heading-level sequence differs/);
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

test('root README structural parity compares levels, tables, and fence languages', () => {
  const { root } = makeRepo();
  const enLink = '[zh](README_zh.md) docs [en](docs/en/README.md)';
  const zhLink = '[en](README.md) docs [zh](docs/zh-CN/README.md)';
  const shape = '## Section\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```bash\necho ok\n```';
  writeFileSync(path.join(root, 'README.md'), `# Root\n\n${enLink}\n\n${shape}\n`);
  writeFileSync(path.join(root, 'README_zh.md'), `# 根\n\n${zhLink}\n\n## 章节\n\n| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n\n\`\`\`bash\necho 好\n\`\`\`\n`);
  assert.equal(run(root).code, 0);

  writeFileSync(path.join(root, 'README_zh.md'), `# 根\n\n${zhLink}\n\n### 章节\n\n| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n\n\`\`\`bash\necho 好\n\`\`\`\n`);
  assert.match(run(root).out, /root README pair: heading-level sequence differs/);

  writeFileSync(path.join(root, 'README_zh.md'), `# 根\n\n${zhLink}\n\n## 章节\n\n| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n| 三 | 四 |\n\n\`\`\`bash\necho 好\n\`\`\`\n`);
  assert.match(run(root).out, /root README pair: table structural signature differs/);

  writeFileSync(path.join(root, 'README_zh.md'), `# 根\n\n${zhLink}\n\n## 章节\n\n| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n\n\`\`\`text\necho 好\n\`\`\`\n`);
  assert.match(run(root).out, /root README pair: fenced-code language sequence differs/);
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

test('agent-workflow: continuation upgrade lives in the request-assessment item, not auto-compact', () => {
  const en = readFileSync('docs/en/concepts/agent-workflow.md', 'utf8');
  const zh = readFileSync('docs/zh-CN/concepts/agent-workflow.md', 'utf8');
  // A numbered item runs from its "N. **title**" line until the next
  // column-0 "N. " list marker (continuation lines are indented).
  const item = (doc, n, titleRe) =>
    doc.match(new RegExp(`^${n}\\.\\s\\*\\*(?:${titleRe.source})\\*\\*[^\\n]*(?:\\n(?!\\d\\.\\s).*)*`, 'm'))?.[0] ?? '';
  for (const [doc, lang] of [[en, 'English'], [zh, 'Chinese']]) {
    const item2 = item(doc, 2, /Auto-compact check|自动压缩检查/) || '';
    const item6 = item(doc, 6, /Request-clarity assessment|请求清晰度评估/) || '';
    assert.ok(item2.length > 0, `${lang}: auto-compact item found`);
    assert.ok(item6.length > 0, `${lang}: request-assessment item found`);
    // The continuation-upgrade machinery belongs to the assessment item...
    assert.ok(/HK2_ENABLE_CONTINUATION_UPGRADE/.test(item6), `${lang}: item 6 documents the upgrade gate`);
    assert.ok(/enableReasoning:true/.test(item6), `${lang}: item 6 documents reasoning-enabled assessment`);
    // ...and NOT to the auto-compact item.
    assert.doesNotMatch(item2, /CONTINUATION_UPGRADE|followupUpgrade|enableReasoning/,
      `${lang}: auto-compact item must not carry continuation-upgrade material`);
  }
});

test('slash-command reference: /help <command> is the universal entry, not <command> help', () => {
  const en = readFileSync('docs/en/reference/slash-commands.md', 'utf8');
  const zh = readFileSync('docs/zh-CN/reference/slash-commands.md', 'utf8');
  assert.match(en, /`\/help <command>` is the universal detailed-help entry/);
  assert.match(zh, /`\/help <命令>` 是任意已注册命令的通用详细帮助入口/);
  for (const [doc, lang] of [[en, 'English'], [zh, 'Chinese']]) {
    assert.doesNotMatch(doc, /every family also supports/i, `${lang}: no every-family-help claim`);
    assert.doesNotMatch(doc, /每个命令族.*help/, `${lang}: no every-family-help claim`);
  }
  // The /remember usage keeps the flag in the real (first-argument) position.
  assert.match(en, /Usage: `\/remember \[--project\|-p\] \[fact\]`/);
  assert.match(zh, /用法：`\/remember \[--project\|-p\] \[事实\]`/);
});

test('agent-tools reference: the bash timeout explanation appears exactly once', () => {
  // The bash section once carried the timeout/8 KiB budget text TWICE (an
  // editing leftover). Extract the `### `bash`` section in both languages
  // and pin the merged single-paragraph form.
  const section = (doc) => {
    const m = doc.match(/^### `bash`[\s\S]*?(?=^###? )/m);
    assert.ok(m, 'bash section found');
    return m[0];
  };
  const en = section(readFileSync('docs/en/reference/agent-tools.md', 'utf8'));
  const zh = section(readFileSync('docs/zh-CN/reference/agent-tools.md', 'utf8'));
  const count = (s, re) => (s.match(re) || []).length;
  assert.equal(count(en, /defaults to 60 seconds/g), 1, 'English bash timeout text exactly once');
  assert.equal(count(zh, /默认为 60 秒/g), 1, 'Chinese bash timeout text exactly once');
  assert.equal(count(en, /8 KiB/g), 1, 'English 8 KiB budget exactly once');
  assert.equal(count(zh, /8 KiB/g), 1, 'Chinese 8 KiB budget exactly once');
});

test('no doc recommends an EOL Node line as the current LTS', () => {
  const files = [
    'README.md', 'README_zh.md',
    'docs/en/getting-started/installation.md', 'docs/zh-CN/getting-started/installation.md',
    'docs/en/guides/troubleshooting.md', 'docs/zh-CN/guides/troubleshooting.md',
    'docs/en/development/testing-and-contributing.md', 'docs/zh-CN/development/testing-and-contributing.md',
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /Node(\.js)? ?20 LTS/i, `${f} must not present Node 20 as the current LTS`);
  }
});
