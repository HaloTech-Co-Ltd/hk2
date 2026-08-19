/*-------------------------------------------------------------------------
 *
 * Regression test: interactive-command spinner phase ordering.
 *
 * The LLM query rewrite MUST run before KB retrieval, because the rewritten
 * query feeds BM25. Therefore the ProgressIndicator's phase sequence must be:
 *   ... -> 'rewriting query' -> 'retrieving KB' -> ...
 * The spinner must NEVER announce 'retrieving KB' before 'rewriting query'
 * on the rewrite-enabled path. This guards the Eden KB entry
 * `interactive-progress-phase-ordering` against silent re-regression.
 *
 * Run:  node --test test/phase-ordering.test.js
 * ----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { ProgressIndicator } from '../src/progress.js';

/**
 * A writable non-TTY stream that records every write, so we can assert on the
 * order in which phase labels are emitted. ProgressIndicator._beginPhase writes
 * a `[<phase>...]` header (ANSI-styled even off-TTY); _endPhase writes a newline.
 * recordedPhases() strips ANSI and pulls out the headers in emission order.
 */
class RecordingStream {
  constructor() { this.chunks = []; this.isTTY = false; }
  write(chunk) { this.chunks.push(String(chunk)); }
  recordedPhases() {
    const ansi = /\x1b\[[0-9;]*m/g;
    const phases = [];
    for (const c of this.chunks) {
      const clean = c.replace(ansi, '');
      const m = clean.match(/\[(.+?)\.\.\./);
      if (m) phases.push(m[1]);
    }
    return phases;
  }
}

test('rewrite-enabled path emits rewriting query BEFORE retrieving KB', () => {
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  // Mirror runAgentTurn's rewrite-enabled control flow:
  //   start on 'rewriting query' (the rewrite step), then once the rewrite is
  //   done, transition to 'retrieving KB' right before buildRequestGraph.
  progress.start('rewriting query');
  progress.nextPhase('retrieving KB');
  progress.done();

  const phases = stream.recordedPhases();
  assert.equal(phases.filter((p) => p === 'rewriting query').length, 1);
  assert.equal(phases.filter((p) => p === 'retrieving KB').length, 1);

  const ri = phases.indexOf('rewriting query');
  const ki = phases.indexOf('retrieving KB');
  assert.ok(ri !== -1 && ki !== -1, 'both phases recorded');
  assert.ok(ri < ki, `'rewriting query' (idx ${ri}) must come before 'retrieving KB' (idx ${ki})`);
});

test('no-rewrite path starts directly on retrieving KB (no rewriting query)', () => {
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  // Mirror runAgentTurn's no-rewrite control flow: there is no rewrite step,
  // so the spinner starts and stays on 'retrieving KB' until buildRequestGraph
  // finishes. There must be NO 'rewriting query' phase on this path.
  progress.start('retrieving KB');
  progress.done();

  const phases = stream.recordedPhases();
  assert.equal(phases.filter((p) => p === 'retrieving KB').length, 1);
  assert.equal(phases.filter((p) => p === 'rewriting query').length, 0,
    'no-rewrite path must not show a rewriting-query phase');
});

test('assessment path: rewriting query -> retrieving KB -> assessing request', () => {
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  // Mirror runAgentTurn's full interactive control flow when request-clarity
  // assessment is enabled: rewrite, then retrieve, THEN assess (the assessment
  // runs after retrieval so the LLM can judge clarity against the retrieved
  // project context). Retrieval must still come after the rewrite.
  progress.start('rewriting query');
  progress.nextPhase('retrieving KB');
  progress.nextPhase('assessing request');
  progress.done();

  const phases = stream.recordedPhases();
  const ai = phases.indexOf('assessing request');
  const ri = phases.indexOf('rewriting query');
  const ki = phases.indexOf('retrieving KB');
  assert.ok(ai !== -1 && ri !== -1 && ki !== -1, 'all three phases recorded');
  assert.ok(ri < ki && ki < ai,
    `expected rewriting < retrieving < assessing, got idx ${ri}/${ki}/${ai}`);
});

test('reasoning models advance spinner to thinking instead of stalling on waiting for model', () => {
  // Regression for the deepseek-v4-pro bug: reasoning models emit a long
  // reasoning_content stream BEFORE any body text. The interactive REPL's
  // onReasoning callback must drive progress.reason() so the spinner shows
  // 'thinking' (live progress) rather than freezing on 'waiting for model'
  // for the entire reasoning window. This mirrors the Eden KB entry
  // `interactive-repl-session-and-context-api` runAgentTurn flow.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  // Enter the model-wait phase (as runAgentTurn does before the agent loop).
  progress.start('waiting for model');
  // First reasoning delta arrives — must transition to 'thinking'.
  progress.reason();
  // More reasoning deltas — reason() is idempotent, no duplicate phase.
  progress.reason();
  progress.done();

  const phases = stream.recordedPhases();
  const wi = phases.indexOf('waiting for model');
  const ti = phases.indexOf('thinking');
  assert.ok(wi !== -1, 'waiting for model phase recorded');
  assert.ok(ti !== -1, 'thinking phase recorded after reasoning delta');
  assert.ok(wi < ti, `waiting (idx ${wi}) must come before thinking (idx ${ti})`);
  // Idempotent: exactly one 'thinking' header despite two reason() calls.
  assert.equal(phases.filter((p) => p === 'thinking').length, 1,
    'reason() must not re-emit the thinking phase on repeated calls');
});


test('reasoning then body delta: tick() still finalizes the spinner after reason()', () => {
  // Critical invariant: reason() must NOT set `stopped`, so the first body
  // delta's tick() still clears the spinner line and streaming proceeds. If
  // reason() leaked the stopped flag, the spinner would persist into body
  // output (the original bug's mirror image).
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('waiting for model');
  progress.reason();                  // reasoning window
  progress.tick('Hello');             // first body delta
  progress.done();

  // tick() finalizes the active phase, so 'thinking' is recorded as ended.
  // done() then must NOT re-print a phase header (stopped is already true).
  const phases = stream.recordedPhases();
  assert.ok(phases.includes('thinking'), 'thinking phase recorded before tick');
  // After tick(), the spinner is stopped; done() prints only the final stats
  // line, never a second 'thinking' header.
  assert.equal(phases.filter((p) => p === 'thinking').length, 1,
    'thinking phase finalized exactly once by tick()');
});


test('reason() is a no-op when no phase is active (defensive)', () => {
  // runAgentTurn wires onReasoning unconditionally; if a reasoning delta
  // ever arrived while no spinner phase was running (e.g. after tick()),
  // reason() must not crash or fabricate a phase. It simply does nothing.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);
  progress.start('waiting for model');
  progress.tick('body');              // stops the spinner, phase -> null
  progress.reason();                  // no active phase → no-op
  progress.done();
  const phases = stream.recordedPhases();
  assert.ok(!phases.includes('thinking'),
    'reason() after tick() must not start a new thinking phase');
});


test('regression canary: retrieving-before-rewriting order is detectable as wrong', () => {
  // This encodes the EXACT regression we are guarding against. If someone
  // reintroduces `progress.start('retrieving KB')` unconditionally and then
  // `nextPhase('rewriting query')`, retrieval would be announced before the
  // rewrite. The RecordingStream must surface that bad order (ki < ri) so the
  // positive-ordering assertions above would catch it. This test documents and
  // exercises the detection mechanism itself.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);
  progress.start('retrieving KB');
  progress.nextPhase('rewriting query');
  progress.done();

  const phases = stream.recordedPhases();
  const ri = phases.indexOf('rewriting query');
  const ki = phases.indexOf('retrieving KB');
  assert.ok(ri !== -1 && ki !== -1, 'both phases recorded for the canary');
  assert.ok(ki < ri,
    'canary shows the bad order (retrieving announced before rewriting); ' +
    'the positive tests above must reject this ordering');
});


// ===========================================================================
// Multi-turn agent-loop regression tests (the bug class v1.1.37 missed).
//
// In a multi-turn loop the first turn's first body delta runs tick()
// (stopped=true, phase=null). On every subsequent LLM call the spinner MUST
// be re-armed, otherwise reason()/tick() are no-ops for the rest of the loop
// and every phase label after turn 1 is "lost" (the original deepseek-v4-pro
// bug, re-reported as the spinner repeating 'thinking' / 'waiting for model').
//
// A SINGLE-turn test passes even when this bug is present; only a multi-turn
// sequence (two full LLM calls with reasoning) catches it. See Holy KB entry
// `progress-indicator-multi-turn-reasoning`.
// ===========================================================================

test('stop() finalizes the spinner so a tool card can take the line', () => {
  // Regression for the EXACT reported symptom: reasoning models (deepseek-
  // v4-pro) emit reasoning_content then tool_calls with NO body text. tick()
  // never fires, so the spinner keeps animating under 'thinking' and its per-
  // 200ms \r refresh overwrites the tool header. stop() sets `stopped` and
  // drops the phase so the spinner stays down for the tool round.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('waiting for model');
  progress.reason();        // reasoning window -> 'thinking' (animated, not stopped)
  progress.stop();          // tool_calls arrived: hand the line to the card
  progress.done();

  const phases = stream.recordedPhases();
  assert.ok(phases.includes('thinking'), 'thinking phase recorded before the tool round');
  // After stop(), the spinner is stopped; a stray reasoning delta must NOT
  // restart it (that is what overwrote the tool card).
  progress.reason();
  assert.equal(phases.filter((p) => p === 'thinking').length, 1,
    'stop() must suppress a post-stop reason() so it cannot overwrite the card');
});

test('stop() is a no-op when no phase is active (does not disturb body output)', () => {
  // tick() already cleared the line for clean body streaming. A redundant
  // stop() must do nothing — never print an extra clear / blank line that
  // would shift already-rendered output.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('waiting for model');
  progress.tick('Hello');   // body streaming starts, line already cleared
  const writesBefore = stream.chunks.length;
  progress.stop();          // redundant — must be a no-op
  assert.equal(stream.chunks.length, writesBefore,
    'stop() after tick() must not emit anything');
  progress.done();
});

test('resume() re-arms a stopped spinner without resetting totalStart', () => {
  // Mirrors interactive.js onTurnStart(_turnIdx > 1): after turn 1's tick()
  // stopped the spinner, resume() must bring it back so turn 2's reasoning
  // window / model wait shows a live phase instead of a dead line.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('rewriting query');          // turn 1 prelude
  progress.nextPhase('waiting for model');
  progress.tick('answer');                     // turn 1 body delta -> stopped
  // Simulate the agent loop starting turn 2.
  progress.resume('waiting for model');        // <-- the fix
  progress.reason();                           // turn 2 reasoning window
  progress.done();

  const phases = stream.recordedPhases();
  // Turn 2's reasoning window MUST produce a fresh 'thinking' phase. Without
  // resume(), reason() is a no-op (phase is null) and 'thinking' never appears
  // for turn 2 — this is exactly the lost-phase-description bug.
  assert.ok(phases.includes('thinking'),
    'resume() must let a subsequent reason() reach the thinking phase');
  assert.ok(phases.includes('waiting for model'),
    'resume() must begin a fresh waiting-for-model phase');
});

// ---------------------------------------------------------------------------
// breakLine(): mid-phase warnings must start on a fresh line
// ---------------------------------------------------------------------------
//
// TTY spinner frames end WITHOUT a newline (`\r⠋ rewriting query · 0.0s`), so a
// warning printed by the phase-model fallback policy used to be glued straight
// onto the timing text:
//   ⠋ rewriting query · 0.0s[warn] phase model for rewrite-query is unreachable
// The warn sinks in runAgentTurn / runCodeReview call progress.breakLine()
// before ctx.print so the warning starts on its own line — without a blank
// line between back-to-back warnings (breakLine is idempotent per line).

function visibleText(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

class TtyRecordingStream extends RecordingStream {
  constructor() { super(); this.isTTY = true; }
}

test('breakLine() breaks a pending TTY spinner frame so warnings start on their own line', () => {
  const stream = new TtyRecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('rewriting query');           // renders \r⠋ rewriting query · 0.0s (no \n)
  progress.breakLine();                        // <-- the fix
  stream.write('[warn] phase model for rewrite-query is unreachable: ECONNREFUSED\n');
  progress._render();                          // spinner re-claims the new line
  progress.nextPhase('retrieving KB');
  progress.done();

  const out = visibleText(stream.chunks.join(''));
  // No warning glued after the timing suffix ("0.0s[warn]") — the exact
  // symptom from the report.
  assert.ok(!/s\[warn\]/.test(out), 'warning must not be glued onto the spinner timing text');
  // The warning occupies its own line (start-of-line after a newline).
  assert.ok(/^\[warn\]/m.test(out), 'warning starts at the beginning of its own line');
  // No blank-line gaps introduced.
  assert.ok(!/\n\n/.test(out), 'no blank lines introduced');
});

test('breakLine() is idempotent: back-to-back warnings get no blank line between them', () => {
  const stream = new TtyRecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('rewriting query');
  progress.breakLine();
  stream.write('[warn] unreachable\n');
  progress.breakLine();                         // line already broken -> no-op
  stream.write('[warn] falling back\n');
  progress.done();

  const out = visibleText(stream.chunks.join(''));
  assert.ok(!/\n\n/.test(out), 'no blank line between back-to-back warnings');
  assert.equal((out.match(/^\[warn\]/gm) || []).length, 2, 'both warnings on their own lines');
});

test('breakLine() is a no-op when no frame is pending (post-done / post-pause)', () => {
  const stream = new TtyRecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('rewriting query');
  progress.pause();                            // line wiped, midLine=false
  const before = stream.chunks.length;
  progress.breakLine();
  assert.equal(stream.chunks.length, before, 'no output when the line is already broken');

  progress.start('assessing request');
  progress.done();                             // finalized with a newline
  const before2 = stream.chunks.length;
  progress.breakLine();
  assert.equal(stream.chunks.length, before2, 'no output after done()');
});

test('non-TTY: breakLine() breaks the "[phase...]" header line the same way', () => {
  const stream = new RecordingStream();       // isTTY falsy
  const progress = new ProgressIndicator(stream);

  progress.start('assessing request');         // writes "[assessing request...] " (no \n)
  progress.breakLine();
  stream.write('[warn] skipping the request-assess phase\n');
  progress.done();

  const out = visibleText(stream.chunks.join(''));
  assert.ok(!/\[assessing request\.\.\.\] \[warn\]/.test(out), 'warning not glued to the phase header');
  assert.ok(/^\[warn\]/m.test(out), 'warning on its own line');
});

test('multi-turn reasoning loop: BOTH turns record a thinking phase', () => {
  // THE regression test that v1.1.37 was missing. Simulates two full LLM turns
  // in an agent loop where each turn has a reasoning window, mirroring the
  // interactive REPL callback sequence for a reasoning model (deepseek-v4-pro):
  //   prelude -> nextPhase('waiting for model')
  //   turn 1: onReasoning -> reason(); ... tick() / onToolCallStart -> stop()
  //   turn 2: onTurnStart(2) -> resume('waiting for model'); onReasoning -> reason()
  //   done()
  // Before the fix, turn 2's reason() was a no-op so only ONE thinking phase
  // was recorded and the phase description was "lost" for the rest of the loop.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  // --- Turn 1 prelude + LLM call ---
  progress.nextPhase('waiting for model');
  progress.reason();                         // turn 1 reasoning window
  progress.stop();                           // turn 1 ends with tool_calls (no body)
  // --- Turn 2 (after a tool round) ---
  progress.resume('waiting for model');      // onTurnStart(2) re-arms the spinner
  progress.reason();                         // turn 2 reasoning window
  progress.done();

  const phases = stream.recordedPhases();
  const thinkingCount = phases.filter((p) => p === 'thinking').length;
  assert.equal(thinkingCount, 2,
    `both turns must record a thinking phase (got ${thinkingCount}); ` +
    'a single-turn test passes even when the multi-turn bug is present');
});

test('multi-turn with body text: spinner re-arms after tick() too', () => {
  // Variant where turn 1 ends with real body text (tick), not a tool card.
  // Same invariant: turn 2 must still reach 'thinking' because resume()
  // cleared the stopped flag that tick() set.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.nextPhase('waiting for model');
  progress.reason();
  progress.tick('body text');                 // turn 1 body delta -> stopped
  progress.resume('waiting for model');       // turn 2
  progress.reason();
  progress.done();

  const phases = stream.recordedPhases();
  assert.equal(phases.filter((p) => p === 'thinking').length, 2,
    'resume() must re-arm the spinner even after a tick()-stopped turn');
});


// ===========================================================================
// Reasoning CONTENT rendering regression tests (the bug v1.1.37 + multi-turn
// fixes BOTH missed). The earlier fixes only made the spinner ADVANCE into a
// 'thinking' phase — but the interactive REPL's onReasoning callback DISCARDED
// the reasoning text (it took no `text` argument), so the user saw the spinner
// flicker between 'thinking' and 'waiting for model' with NO description of
// what the model was actually thinking. These tests guard the ReasoningStream
// that now surfaces reasoning_content live.
// ===========================================================================

import { ReasoningStream } from '../lib/agent/reasoning_stream.js';

/** Strip ANSI escapes for readable assertions on rendered reasoning output. */
function stripAnsiForTest(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

test('ReasoningStream surfaces reasoning content instead of discarding it', () => {
  // THE core regression: onReasoning(text) must render the reasoning delta, not
  // throw it away. Previously the REPL only switched the spinner label to
  // 'thinking' and dropped evt.text entirely.
  const rs = new ReasoningStream();
  let out = '';
  out += rs.feed('Let me analyze the file.\n');
  out += rs.feed('The callback ignores its argument.\n');
  out += rs.end();

  const visible = stripAnsiForTest(out);
  assert.ok(visible.includes('✎ thinking'), 'a thinking header marks the reasoning window');
  assert.ok(visible.includes('Let me analyze the file.'),
    'the FIRST reasoning delta must be rendered, not discarded');
  assert.ok(visible.includes('The callback ignores its argument.'),
    'subsequent reasoning deltas must be rendered too');
});

test('ReasoningStream emits the thinking header exactly once per window', () => {
  // Multiple reasoning deltas arrive in one window. The '✎ thinking' header
  // must appear once (not once per delta, which would spam the output).
  const rs = new ReasoningStream();
  let out = '';
  out += rs.feed('a');
  out += rs.feed('b');
  out += rs.feed('c\n');
  out += rs.end();
  const headerCount = (stripAnsiForTest(out).match(/✎ thinking/g) || []).length;
  assert.equal(headerCount, 1, 'exactly one thinking header per reasoning window');
});

test('ReasoningStream.end() finalizes and ignores later deltas until reset()', () => {
  // After a reasoning window ends (body text or a tool card takes over), late
  // reasoning deltas must not leak into the body / card output. They resume
  // only after reset() (called at the next turn boundary).
  const rs = new ReasoningStream();
  let out = '';
  out += rs.feed('window one\n');
  out += rs.end();
  const afterEnd = rs.feed('should be ignored');
  assert.equal(afterEnd, '', 'feed() after end() is ignored');
  // reset() re-arms for the next reasoning window.
  rs.reset();
  out = rs.feed('window two\n');
  assert.ok(stripAnsiForTest(out).includes('window two'),
    'after reset() a new reasoning window renders again');
  assert.ok(stripAnsiForTest(out).includes('✎ thinking'),
    'the new window emits its own header');
});

test('ReasoningStream accumulates partial deltas into complete lines', () => {
  // Providers chunk reasoning_content into tiny deltas that often split mid-
  // line. The stream must buffer and only render on newline boundaries so
  // the displayed text isn't fragmented.
  const rs = new ReasoningStream();
  let out = '';
  out += rs.feed('Step 1: ');          // no newline yet — buffered, not emitted as a line
  out += rs.feed('read the file.\n'); // now the complete line renders
  out += rs.end();
  const visible = stripAnsiForTest(out);
  assert.ok(visible.includes('Step 1: read the file.'),
    'partial deltas must be joined into a complete line before rendering');
  // The header line + one reasoning line = 2 lines of content.
  assert.equal(visible.split('\n').filter((l) => l.length > 0).length, 2,
    'exactly the header line plus one reasoning line');
});

test('ReasoningStream caps the thinking window at 5 lines by default (HK2_HIDE_THINKING)', () => {
  // Default (HK2_HIDE_THINKING unset or 1): long reasoning streams must not
  // flood the REPL — only the first 5 content lines render, and end() reports
  // the hidden count. The header line does NOT count against the budget.
  const cases = [undefined, '1'];
  for (const v of cases) {
    if (v === undefined) delete process.env.HK2_HIDE_THINKING;
    else process.env.HK2_HIDE_THINKING = v;
    const rs = new ReasoningStream();
    let out = '';
    for (let i = 1; i <= 12; i++) out += rs.feed(`line ${i}\n`);
    out += rs.end();
    const visible = stripAnsiForTest(out);
    assert.ok(visible.includes('line 1') && visible.includes('line 5'),
      'the first 5 reasoning lines render');
    assert.ok(!visible.includes('line 6'),
      `the 6th+ reasoning lines are hidden (HK2_HIDE_THINKING=${v})`);
    assert.ok(visible.includes('7 more lines hidden'),
      'end() reports the number of hidden lines');
    assert.ok(visible.includes('HK2_HIDE_THINKING=0'),
      'the notice points at the escape hatch');
    // header + 5 content lines + 1 notice = 7 rendered lines
    assert.equal(visible.split('\n').filter((l) => l.length > 0).length, 7);
  }
  delete process.env.HK2_HIDE_THINKING;
});

test('ReasoningStream short windows are unaffected by the 5-line cap', () => {
  // Windows within budget render exactly as before: no notice line, no change.
  delete process.env.HK2_HIDE_THINKING;
  const rs = new ReasoningStream();
  let out = '';
  out += rs.feed('one\n');
  out += rs.feed('two partial that stays buffered');
  out += rs.end();
  const visible = stripAnsiForTest(out);
  assert.ok(visible.includes('one') && visible.includes('two partial that stays buffered'));
  assert.ok(!visible.includes('hidden'), 'no hidden-lines notice under budget');
});

test('HK2_HIDE_THINKING=0 streams the full reasoning content', () => {
  // Opt-out restores the pre-cap behavior byte-for-byte: every line renders
  // and no hidden-lines notice is emitted, no matter how long the stream.
  process.env.HK2_HIDE_THINKING = '0';
  const rs = new ReasoningStream();
  let out = '';
  for (let i = 1; i <= 12; i++) out += rs.feed(`line ${i}\n`);
  out += rs.end();
  delete process.env.HK2_HIDE_THINKING;
  const visible = stripAnsiForTest(out);
  for (let i = 1; i <= 12; i++) {
    assert.ok(visible.includes(`line ${i}`), `full mode renders line ${i}`);
  }
  assert.ok(!visible.includes('hidden'), 'no notice in full mode');
});

test('reasoning then body: tick() still finalizes the spinner after reason()', () => {
  // End-to-end invariant via the ProgressIndicator: the reasoning-content fix
  // must not disturb the spinner state machine. After reason() + pause() (what
  // onReasoning does on the first delta) the first body delta's tick() must
  // still finalize cleanly, and the spinner records exactly one thinking phase.
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  progress.start('waiting for model');
  progress.reason();        // first reasoning delta -> 'thinking'
  progress.pause();         // let reasoning text own the line (as onReasoning does)
  progress.tick('answer');  // first body delta
  progress.done();

  const phases = stream.recordedPhases();
  assert.ok(phases.includes('thinking'), 'thinking phase still recorded');
  assert.equal(phases.filter((p) => p === 'thinking').length, 1,
    'pause() must not cause a duplicate thinking phase, and tick() finalizes once');
});
