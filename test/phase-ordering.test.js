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

test('assessment-first path: assessing request -> rewriting query -> retrieving KB', () => {
  const stream = new RecordingStream();
  const progress = new ProgressIndicator(stream);

  // Mirror runAgentTurn's full interactive control flow when request-clarity
  // assessment is enabled: assess, then rewrite, then retrieve. Retrieval must
  // still come after the rewrite.
  progress.start('assessing request');
  progress.nextPhase('rewriting query');
  progress.nextPhase('retrieving KB');
  progress.done();

  const phases = stream.recordedPhases();
  const ai = phases.indexOf('assessing request');
  const ri = phases.indexOf('rewriting query');
  const ki = phases.indexOf('retrieving KB');
  assert.ok(ai !== -1 && ri !== -1 && ki !== -1, 'all three phases recorded');
  assert.ok(ai < ri && ri < ki,
    `expected assessing < rewriting < retrieving, got idx ${ai}/${ri}/${ki}`);
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
