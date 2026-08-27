/*-------------------------------------------------------------------------
 *
 * Automated regression tests for the M31 fixes (previously verified only
 * manually in a pty): intraword underscores, table width clamp, and the
 * footer's idle state before end-of-turn modals.
 *
 * Run:  node --test test/tui_cjk_render.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { MarkdownStream, applyInline } from '../lib/agent/markdown.js';
import * as style from '../lib/agent/style.js';
import { runTurn } from '../src/commands/turn.js';
import { createSession } from '../src/commands/session_ctx.js';

const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ----- 1. intraword underscores ------------------------------------------ */

test('applyInline: env-var / snake_case underscores survive; real emphasis still works', () => {
  assert.equal(plain(applyInline('HK2_ENABLE_AUTO_LEARN=1')), 'HK2_ENABLE_AUTO_LEARN=1');
  assert.equal(plain(applyInline('HK2_ENABLE_AUTOUPDATEKB=1')), 'HK2_ENABLE_AUTOUPDATEKB=1');
  assert.equal(plain(applyInline('file_name_mid_word')), 'file_name_mid_word');
  assert.equal(plain(applyInline('this is _real emphasis_ here')), 'this is real emphasis here');
});

test('markdown table in a TUI-width stream: every row ≤ width, underscores verbatim', () => {
  const W = 100;
  const md = new MarkdownStream({ width: W });
  const table = [
    '|        | Holy | Eden | Index |',
    '|--------|------|------|-------|',
    '| 存什么 | 架构、算法、关键模式（人工撰写/权威导入） | 函数目录、观察到的模式、解析后的文档、LLM 自动摘要 | 符号 BM25、调用图、继承图、各空间条目索引 |',
    '| 更新策略 | 永远需要用户显式批准（y/N） | HK2_ENABLE_AUTO_LEARN=1 | HK2_ENABLE_AUTOUPDATEKB=1 |',
    '',
    '一句话总结：Holy 是宪法，Eden 是工作笔记。',
  ].join('\n');
  const out = md.feed(table) + md.flush();
  for (const line of out.split('\n')) {
    assert.ok(style.visibleWidth(plain(line)) <= W,
      `row ≤ ${W} cols (got ${style.visibleWidth(plain(line))}): ${plain(line).slice(0, 50)}`);
  }
  assert.ok(out.includes('HK2_ENABLE_AUTO_LEARN=1') || plain(out).includes('HK2_ENABLE_AUTO_LEARN=1'),
    'env-var underscores verbatim in the table');
});

/* ----- 2. footer idles before end-of-turn modals ------------------------ */

function fakeUi() {
  const events = [];
  const rec = (name) => (...args) => { events.push([name, ...args]); };
  return {
    events,
    canPrompt: false,
    progress: { phase: null, stopped: false, midLine: false,
      start(p) { this.phase = p; }, nextPhase(p) { this.phase = p; }, reason() {}, resume() {},
      pause() {}, stop() {}, tick() {}, done() {}, breakLine() {} },
    spinnerStart(p) { rec('spinnerStart')(p); this.progress.start(p); },
    phase(p) { rec('phase')(p); this.progress.nextPhase(p); },
    phaseOnly(p) { rec('phaseOnly')(p); this.progress.phase = p; },
    setPhaseSafe(p) { rec('setPhaseSafe')(p); },
    statusRefresh() { rec('statusRefresh')(); },
    stream: { reset() {}, delta() {}, reasoning() {}, flushReasoning() { return ''; }, flushMarkdown() { return ''; }, flush() { return ''; } },
    toolStart() {}, toolEnd() {}, finishStream() { rec('finishStream')(); },
    noticeLines() {}, notice() {}, userEcho() {}, usageLine() {},
    cancelled() {}, interrupted() {}, failed() {},
    confirm: async () => false, optionList: async () => null, freeText: async () => ({ text: '', cancelled: true }),
    onInterrupt() { return () => {}; },
  };
}

test('phase resets to idle BEFORE the end-of-turn confirm (footer never shows streaming behind a modal)', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  process.env.HK2_ENABLE_AUTOUPDATEKB = '0';
  try {
    const session = createSession(null);
    // Two-round stream: round 1 issues a bash SEARCH command (fills
    // bashSearchCommands via onToolCallEnd); round 2 answers.
    let round = 0;
    session.llm = {
      async *stream() {
        round += 1;
        if (round === 1) {
          yield { type: 'tool_call', id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'grep -r foo .' }) };
        } else {
          yield { type: 'delta', text: 'answer' };
          yield { type: 'usage', input: 5, output: 1 };
        }
      },
    };
    session.modelCfg = { maxChars: 65536, temperature: 0.2, enableReasoning: false };
    session.project = { id: 'proj-x', name: 'projX', sourcePath: '/tmp' };
    session.rt = null;
    const confirmCalls = [];
    const ctx = { print() {}, confirm: async (t) => { confirmCalls.push({ phase: session.phase, t }); return false; } };
    const ui = fakeUi();
    await runTurn('do a search', session, ctx, ui);
    assert.ok(confirmCalls.length > 0, 'the confirm prompt ran');
    assert.equal(confirmCalls[0].phase, 'idle', 'session.phase was idle when the modal opened');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
    delete process.env.HK2_ENABLE_AUTOUPDATEKB;
  }
});
