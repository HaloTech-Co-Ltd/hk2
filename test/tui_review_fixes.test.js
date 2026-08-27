/*-------------------------------------------------------------------------
 *
 * Regression tests for the SECOND review round of the TUI branch. One file,
 * one concern per test, all headless:
 *
 *   P1  resume flushes the armed model reload flag (the first post-resume
 *       turn must run on the OWNER project's model — incl. a deregistered
 *       owner whose taskstate is still recovered by project id)
 *   P1  ctx.write — the io character-stream seam; src/slash never touches
 *       process.stdout/stderr directly (guard scan)
 *   P1  completion selection is marked by ❯ (survives NO_COLOR); the
 *       hidden-count hint is direction-aware; narrow layouts stack/hide
 *   P1  modal question text WRAPS (never truncated) + key-hint row + titles
 *   P1  freeText modal saves/restores the user's draft (makeDraftGuard)
 *   P2  welcome card three responsive tiers + /clear one-line summary
 *   P2  an idle Frame writes zero bytes (animation only while busy)
 *   P2  HK2_HIDE_THINKING=0 restores the live reasoning stream in the TUI
 *   P2  compact tool line: display names + exit/duration meta
 *
 * Run:  node --test test/tui_review_fixes.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_tty_env.js';
import './_learn_setup.js';

import { test, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { completionMenu } from '../src/tui/completion.js';
import { ModalHost, wrapVisible } from '../src/tui/modal.js';
import { makeDraftGuard } from '../src/tui/index.js';
import { renderWelcome, renderClearSummary } from '../src/tui/chrome.js';
import { Frame } from '../src/tui/frame.js';
import { makeTuiIo } from '../src/tui/tui_io.js';
import { makeTuiUi } from '../src/tui/tui_ui.js';
import { compactToolResult } from '../src/commands/tool_card.js';
import { createSession, buildCtx, buildBaseCtx, replIo, reloadAll, flushSessionReloads } from '../src/commands/session_ctx.js';
import { ensureHome, loadModels, saveModels, loadProjects, saveProjects, registerProject, removeProject, setCurrentProject } from '../lib/config/home.js';
import { Transcript } from '../lib/agent/transcript.js';
import { saveTaskState } from '../lib/agent/task_state.js';
import * as style from '../lib/agent/style.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ================================================================
 * P1 — resume consumes the armed model reload flag BEFORE the first turn
 * ================================================================ */

async function seedTwoModels() {
  await ensureHome();
  const data = {
    providers: {
      provA: {
        api: 'openai', baseUrl: 'http://a.example/v1', apiKey: 'sk-a',
        models: [{ id: 'model-a', name: 'model-a', contextWindow: 8192, temperature: 0.2 }],
      },
      provB: {
        api: 'openai', baseUrl: 'http://b.example/v1', apiKey: 'sk-b',
        models: [{ id: 'model-b', name: 'model-b', contextWindow: 8192, temperature: 0.2 }],
      },
    },
    default: 'provA/model-a',
  };
  await saveModels(data);
}

test('cross-project resume: the model reload flag is CONSUMED before the first turn', async () => {
  await seedTwoModels();
  const src = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-rv2-owner-'));
  const owner = await registerProject({ name: 'rv2owner', sourcePath: src });
  // Per-project default model override (projects.json record field).
  const projects = await loadProjects();
  projects.projects[owner.id].defaultModel = 'provB/model-b';
  await saveProjects(projects);
  const curSrc = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-rv2-cur-'));
  const cur = await registerProject({ name: 'rv2cur', sourcePath: curSrc });
  await setCurrentProject(cur.id);

  const session = createSession(null);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx);
  assert.equal(session.modelCfg.model, 'model-a', 'launch project follows the global default (provA)');

  // A session owned by the OTHER project.
  const prev = new Transcript(owner.id, 'sess-owner');
  await prev.logUser('owner session question');
  await prev.logAssistant('owner session answer');

  const ok = await ctx.resumeSession('sess-owner');
  assert.equal(ok, true);
  assert.equal(session.project?.id, owner.id, 'ownership unified onto the owner project');
  // THE bug this pins: reloadFlags.model stayed armed (and session.llm still
  // pointed at the launch project's model) until AFTER the first message.
  assert.deepEqual(session.reloadFlags, { project: false, kb: false, model: false },
    'resume consumed the reload flags itself');
  assert.equal(session.modelCfg.model, 'model-b', 'the OWNER project default is already active (not model-a)');

  await removeProject(owner.id);
  await removeProject(cur.id);
});

test('flushSessionReloads: consumes armed flags, clears them, no-ops when idle', async () => {
  const session = createSession(null);
  session.reloadFlags = { project: false, kb: false, model: true };
  const ran = await flushSessionReloads(session, {});
  assert.equal(ran, true);
  assert.deepEqual(session.reloadFlags, { project: false, kb: false, model: false });
  const ran2 = await flushSessionReloads(session, {});
  assert.equal(ran2, false, 'nothing armed → no reload');
});

test('both launch paths flush reload flags after a successful resume (wiring)', () => {
  const repl = fs.readFileSync(path.join(here, '..', 'src', 'commands', 'interactive.js'), 'utf8');
  const tui = fs.readFileSync(path.join(here, '..', 'src', 'tui', 'index.js'), 'utf8');
  for (const [name, src] of [['repl', repl], ['tui', tui]]) {
    const resumeIdx = src.indexOf('await resumeSessionInto(session, wanted);');
    assert.ok(resumeIdx > 0, `${name}: launch resume located`);
    const flushIdx = src.indexOf('await flushSessionReloads(session, ctx);', resumeIdx);
    assert.ok(flushIdx > 0, `${name}: reload flags flushed right after the launch resume`);
  }
});

test('resume of a session whose owner project was DELETED still recovers its taskstate (by owner pid)', async () => {
  await seedTwoModels();
  const src = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-rv2-gone-'));
  const owner = await registerProject({ name: 'rv2gone', sourcePath: src });
  const curSrc = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-rv2-gonecur-'));
  const cur = await registerProject({ name: 'rv2gonecur', sourcePath: curSrc });
  await setCurrentProject(cur.id);

  const prev = new Transcript(owner.id, 'sess-gone-owner');
  await prev.logUser('work in the now-deleted project');
  await saveTaskState(owner.id, {
    userRequest: 'interrupted task in a deleted project',
    sessionId: 'sess-gone-owner',
    reason: 'interrupt',
  });
  // Deregister the owner BEFORE resuming.
  await removeProject(owner.id);

  const session = createSession(null);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx);
  const ok = await ctx.resumeSession('sess-gone-owner');
  assert.equal(ok, true);
  assert.equal(session.project, null, 'no project context — the current project is not borrowed');
  // Keyed on the OWNER pid, not session.project (which is null now).
  assert.ok(session.lastTask, 'interrupted task recovered from the deleted owner project');
  assert.equal(session.lastTask.userRequest, 'interrupted task in a deleted project');

  await removeProject(cur.id);
});

/* ================================================================
 * P1 — ctx.write: the io character-stream seam
 * ================================================================ */

test('ctx.write routes through the io implementation (TUI → frame, REPL → stdout)', () => {
  // TUI: the stream primitive must land in the Frame, never on stdout.
  const seen = [];
  const frame = { write: (s) => seen.push(s), writeLine: () => {} };
  const tuiIo = makeTuiIo(frame, new ModalHost(), {});
  assert.equal(typeof tuiIo.write, 'function');
  tuiIo.write('partial');
  assert.deepEqual(seen, ['partial']);

  // REPL io provides the same primitive (process.stdout.write).
  assert.equal(typeof replIo({}).write, 'function');

  // ctx falls back to a function even when the io omits write.
  const ctx = buildBaseCtx(createSession(null), { print: () => {} });
  assert.equal(typeof ctx.write, 'function');
});

test('guard: src/slash never writes to process.stdout/stderr directly (Frame-only output)', () => {
  const dir = path.join(here, '..', 'src', 'slash');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Strip line + block comments first: the guard is about CODE, not prose.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');
    if (/process\.(stdout|stderr)\.write/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    'slash commands must stream via ctx.write — direct stream writes bypass the TUI Frame');
});

/* ================================================================
 * P1 — completion menu: ❯ marker (NO_COLOR-safe), direction hint, narrow
 * ================================================================ */

test('selection is marked by ❯ — two selections differ with ALL styling stripped', () => {
  const a = completionMenu('/kb kn', { width: 100, maxRows: 8, selected: 0 });
  const b = completionMenu('/kb kn', { width: 100, maxRows: 8, selected: 1 });
  assert.equal(a.items.length, 1, 'single candidate for this prefix (pre-check)');
  // Single item: pick a multi-item menu instead for the differ check.
  const m0 = completionMenu('/c', { width: 100, maxRows: 8, selected: 0 });
  const m1 = completionMenu('/c', { width: 100, maxRows: 8, selected: 1 });
  const p0 = m0.lines.map(strip);
  const p1 = m1.lines.map(strip);
  assert.notDeepEqual(p0, p1, 'plain-text renders DIFFER when the selection moves');
  const sel0 = p0.find((l) => l.startsWith('❯ '));
  const sel1 = p1.find((l) => l.startsWith('❯ '));
  assert.ok(sel0 && sel1, '❯ marker present in plain text');
  assert.notEqual(sel0, sel1, 'the marker MOVED with the selection');
});

test('hidden-count hint is direction-aware: ↓ at the top, ↑+↓ mid-list', () => {
  // selected = 0 → everything hidden is BELOW; an ↑ hint would mislead.
  const top = completionMenu('/ ', { width: 100, maxRows: 3, selected: 0 });
  const hintTop = strip(top.lines[top.lines.length - 1]);
  assert.match(hintTop, /↓ \d+ more/);
  assert.ok(!hintTop.includes('↑'), 'no up-hint when the window starts at item 0');

  // selected deep in the list → the window scrolled: hidden above AND below.
  const mid = completionMenu('/ ', { width: 100, maxRows: 3, selected: 10 });
  const hintMid = strip(mid.lines[mid.lines.length - 1]);
  assert.match(hintMid, /↑ \d+ more/);
  assert.match(hintMid, /↓ \d+ more|·/);
});

test('narrow screens: <64 cols stack the description under the label; <44 hide it', () => {
  const stacked = completionMenu('/kb knowl', { width: 50, maxRows: 12 });
  const plain = stacked.lines.map(strip);
  const labelRow = plain.find((l) => l.includes('/kb knowledge'));
  assert.ok(labelRow, 'label rendered at 50 cols');
  const descRow = plain.find((l, i) => i > 0 && l.startsWith('    ') && l.trim() && !l.startsWith('    ↓'));
  assert.ok(descRow, 'description on its own indented row (stacked layout)');

  const tiny = completionMenu('/kb knowl', { width: 40, maxRows: 12 });
  const tinyPlain = tiny.lines.map(strip).join('\n');
  assert.ok(tinyPlain.includes('/kb knowledge'), 'label survives at 40 cols');
  assert.ok(!tinyPlain.includes('Manage knowledge'), 'description dropped at extreme narrow');
});

/* ================================================================
 * P1 — modal: question text WRAPS + hint row + specific titles
 * ================================================================ */

test('long confirm text wraps across rows — the decision-critical tail is never truncated', () => {
  const h = new ModalHost();
  const long = 'Save the extracted knowledge about cross-project session ownership into the '
    + 'Holy space? This is permanent and requires your approval; choose Eden to keep it as '
    + 'working notes instead.';
  h.open('confirm', { text: long, title: 'Save knowledge', threeWay: true });
  const lines = h.render(80);
  const plain = lines.map(strip);
  // No ellipsis anywhere in the question body — the full text is present.
  const body = plain.slice(1, plain.length - 1).join(' ');
  assert.ok(body.includes('requires your approval'), 'mid-sentence content survives');
  assert.ok(body.includes('working notes instead.'), 'the decision-critical TAIL survives');
  assert.ok(!body.includes('…'), 'no truncation ellipsis');
  // Specific title + hint row.
  assert.ok(plain[0].includes('Save knowledge'), 'task-specific card title');
  const hint = plain[plain.length - 2];
  assert.match(hint, /↑↓ select · enter confirm · esc cancel · y\/n\/e/, 'key-hint row');
  // Three-way options rendered.
  assert.ok(body.includes('Eden (save to Eden instead)'));
});

test('wrapVisible: word wrap, CJK never split, over-wide words hard-broken', () => {
  assert.deepEqual(wrapVisible('alpha beta gamma', 11), ['alpha beta', 'gamma']);
  assert.deepEqual(wrapVisible('你好世界测试', 4), ['你好', '世界', '测试'], 'wide glyphs wrap whole');
  const hard = wrapVisible('abcdefghij', 4);
  assert.deepEqual(hard, ['abcd', 'efgh', 'ij'], 'long word hard-broken at the width');
  const emoji = wrapVisible('👨‍👩‍👧‍👦 家族', 2);
  assert.deepEqual(emoji, ['👨‍👩‍👧‍👦', '家', '族'],
    'ZWJ family stays whole; each wide CJK glyph gets its own 2-col row');
  assert.deepEqual(wrapVisible('   ', 10), [], 'whitespace-only → no rows');
});

test('optionList modal: header wraps, hint row present', () => {
  const h = new ModalHost();
  h.open('optionList', {
    title: 'Confirm plan',
    header: ['Plan Review - Issue 1/2: a fairly long issue title that would not fit one row at all'],
    options: [{ row: '  1. accept' }, { row: '  2. dismiss' }],
  });
  const plain = h.render(60).map(strip);
  assert.ok(plain[0].includes('Confirm plan'));
  const joined = plain.join('\n');
  assert.ok(joined.includes('would not fit'), 'long header wrapped, tail present');
  assert.ok(!joined.includes('…'), 'no ellipsis');
  assert.match(plain[plain.length - 2], /↑↓ select · enter confirm · 1-9 jump · esc cancel/);
});

/* ================================================================
 * P1 — freeText modal: the user's draft survives
 * ================================================================ */

test('makeDraftGuard: enter stashes the draft and yields a fresh editor; exit restores it', async () => {
  const { initialState, applyKey, text: boxText } = await import('../src/tui/input_box.js');
  let box = initialState({ placeholder: 'Message hk2…', width: 40, maxVisibleRows: 6 });
  for (const c of 'my next questi') box = applyKey(box, { type: 'char', text: c }).state;
  const draft = box;

  const guard = makeDraftGuard();
  assert.equal(guard.active(), false);
  const editor = guard.enter(box);
  assert.equal(guard.active(), true);
  assert.equal(boxText(editor), '', 'modal starts from an EMPTY editor — the draft cannot leak as the answer');
  assert.equal(editor.placeholder, 'Message hk2…', 'geometry/placeholder preserved');

  // The user answers the modal in the fresh editor.
  let typing = editor;
  for (const c of 'the answer') typing = applyKey(typing, { type: 'char', text: c }).state;

  const restored = guard.exit(typing);
  assert.equal(guard.active(), false);
  assert.equal(boxText(restored), 'my next questi', 'draft restored verbatim');
  assert.deepEqual([restored.row, restored.col], [draft.row, draft.col], 'cursor position restored too');
  // exit without enter is an identity no-op.
  const untouched = makeDraftGuard().exit(box);
  assert.equal(untouched, box);
});

/* ================================================================
 * P2 — welcome card tiers + /clear one-liner
 * ================================================================ */

test('welcome tiers: <60 two plain lines; 60-87 single-column card; ≥88 full dual card', () => {
  const s = createSession(null);
  s.project = { name: 'hk2', sourcePath: '/home/x/hk2' };
  s.modelCfg = { ref: 'p/m', model: 'glm-5.3', maxChars: 1 << 20 };
  s.kbMeta = { edenCount: 0, holyCount: 0 };

  // < 60: two lines, no card borders, nothing wider than the terminal.
  const mini = renderWelcome(s, 30);
  assert.equal(mini.length, 2);
  for (const ln of mini) assert.ok(style.visibleWidth(ln) <= 30, `mini line fits 30 cols (${style.visibleWidth(ln)})`);
  assert.ok(!mini.join('').includes('╭'), 'no card borders in the mini tier');

  // 60-87: a single-column card that fits, with the facts but no tips panel.
  const single = renderWelcome(s, 70);
  assert.ok(single.join('').includes('╭'), 'card rendered');
  for (const ln of single) assert.ok(style.visibleWidth(ln) <= 70, 'single-column card fits 70 cols');
  const singlePlain = single.map(strip).join('\n');
  assert.ok(singlePlain.includes('Project'));
  assert.ok(singlePlain.includes('Model'));
  assert.ok(!singlePlain.includes('Tips for getting started'), 'compact tier drops the tips panel');

  // ≥88 first-run: full dual card with the tips panel.
  const full = renderWelcome(s, 100);
  assert.ok(full.map(strip).join('\n').includes('Tips for getting started'));

  // compact overrides even on wide terminals (returning users / short rows).
  const compact = renderWelcome(s, 100, { compact: true });
  assert.ok(!compact.map(strip).join('\n').includes('Tips for getting started'));
});

test('renderClearSummary: ONE line, fits the width', () => {
  const s = createSession(null);
  s.project = { name: 'p1', sourcePath: '/x' };
  s.modelCfg = { ref: 'p/m', model: 'm1' };
  const line = renderClearSummary(s, 60);
  assert.equal(line.includes('\n'), false);
  assert.ok(style.visibleWidth(line) <= 60);
  assert.ok(strip(line).includes('context cleared'));
});

/* ================================================================
 * P2 — an idle Frame writes ZERO bytes
 * ================================================================ */

test('Frame: idle → no periodic writes; busy (animateWhen) → 200ms refresh runs', () => {
  let busy = false;
  let buf = '';
  const stream = { isTTY: true, columns: 80, write: (s) => { buf += s; } };
  const frame = new Frame(stream, {
    rows: 24, cols: 80,
    animateWhen: () => busy,
    blocks: [{ name: 's', render: () => ['STATUS'] }],
  });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    frame.start();          // initial draw
    mock.timers.tick(2000); // 2s idle
    const afterIdle = buf.length;
    assert.ok(afterIdle > 0, 'initial draw happened');
    assert.equal(buf.length, afterIdle, 'ZERO periodic writes while idle');

    busy = true;
    frame.requestRender();  // a state change re-syncs the animation
    mock.timers.tick(16);   // the coalesced redraw runs → arms the interval
    mock.timers.tick(2000); // the animation interval fires repeatedly
    assert.ok(buf.length > afterIdle + 100, 'spinner refresh writes while busy');
  } finally {
    frame.stop();
    mock.timers.reset();
  }
});

/* ================================================================
 * P2 — HK2_HIDE_THINKING=0 restores the live reasoning stream in the TUI
 * ================================================================ */

function fakeFrame() {
  const out = [];
  return { out, write: (s) => out.push(s), writeLine: (s = '') => out.push(s + '\n'), requestRender: () => {} };
}

test('TUI thinking: default collapsed; HK2_HIDE_THINKING=0 streams live', async () => {
  const prev = process.env.HK2_HIDE_THINKING;
  try {
    delete process.env.HK2_HIDE_THINKING;
    let frame = fakeFrame();
    let ui = makeTuiUi(frame, createSession(null), new ModalHost(), {});
    ui.stream.reset();
    ui.stream.reasoning('the model muses about the problem here');
    assert.equal(frame.out.join(''), '', 'default: reasoning is hidden while it runs');
    ui.stream.flushReasoning();
    assert.ok(frame.out.join('').includes('Thought for'), 'collapsed one-liner on flush');

    process.env.HK2_HIDE_THINKING = '0';
    frame = fakeFrame();
    ui = makeTuiUi(frame, createSession(null), new ModalHost(), {});
    ui.stream.reset();
    ui.stream.reasoning('visible reasoning line\n');
    assert.ok(frame.out.join('').includes('visible reasoning line'), '=0: reasoning renders live');
    ui.stream.flushReasoning();
    assert.ok(!frame.out.join('').includes('Thought for'), 'no collapsed duplicate when live was shown');
  } finally {
    if (prev === undefined) delete process.env.HK2_HIDE_THINKING;
    else process.env.HK2_HIDE_THINKING = prev;
  }
});

/* ================================================================
 * P2 — compact tool result: exit + duration meta
 * ================================================================ */

test('compactToolResult: exit status and duration prefix the result line', () => {
  const r = compactToolResult('bash',
    { ok: true, result: { exitCode: 0, stdout: '856 tests passed\nmore', stderr: '' } },
    { durSec: 4.9 });
  const p = strip(r);
  assert.ok(p.includes('exit 0'), 'exit status shown');
  assert.ok(p.includes('4.9s'), 'duration shown');
  assert.ok(p.includes('856 tests passed'), 'first stdout line still first-class');
});
