/*-------------------------------------------------------------------------
 *
 * Regression tests for the /help system (src/slash/help.js).
 *
 * The original help-completion pass missed --plan-timeout-ms on
 * /kb knowledge learn because nothing cross-checked HELP_TEXT against the
 * flags the command implementations actually parse. These tests lock each
 * help surface to the real flag set so future drift fails loudly here
 * instead of silently shipping.
 *
 * Run:  node --test test/help_system.test.js
 * ----------------------------------------------------------------------*/

// MUST be the first import: it sets HK2_HOME to a temp dir before home.js
// (imported transitively by help.js) captures it at load.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import { HELP_TEXT, renderHelp, subcommandHelp } from '../src/slash/help.js';
import { __learnTest } from '../src/slash/kb.js';

const { parseFlags } = __learnTest;

/** All --flags mentioned in an array of help lines. */
const flagsIn = (lines) => {
  const out = new Set();
  for (const l of lines || []) {
    for (const m of l.matchAll(/--([a-z][a-z0-9-]*)/g)) out.add(m[1]);
  }
  return out;
};

test('HELP_TEXT covers every registered slash command family', () => {
  // SLASH_COMMANDS names minus aliases that share help text with a family.
  const registered = ['model', 'project', 'kb', 'session', 'clear', 'compact', 'quit'];
  for (const name of registered) {
    assert.ok(renderHelp(name), `missing HELP_TEXT entry for /${name}`);
  }
  // 'knowledge' is reachable as /help knowledge and /kb help knowledge.
  assert.ok(renderHelp('knowledge'));
});

test('/help kb lists every /kb subcommand the dispatcher routes', () => {
  const kbCases = [
    ['init', ' init'], ['update', ' update'], ['status', ' status'],
    ['search', ' search'], ['symbol', ' symbol'], ['neighbors', ' neighbors'],
    ['knowledge', ' knowledge'], ['transform', ' transform'], ['drop', ' drop'],
  ];
  const text = HELP_TEXT.kb.join('\n');
  for (const [sub] of kbCases) {
    assert.ok(text.includes(sub), `/help kb must mention subcommand "${sub}"`);
  }
});

test('/kb knowledge help learn documents every flag the implementation parses', () => {
  // Flags parsed by knowledgeLearnKb (src/slash/kb.js). Derived from the
  // implementation, not from the help text, so adding a parsed flag without
  // documenting it fails here.
  const learnFlags = ['space', 'file', 'base-dir', 'per-batch-chars', 'dry-run',
    'no-survey', 'plan-timeout-ms'];
  const topic = subcommandHelp('knowledge', 'learn');
  assert.ok(topic, 'subcommandHelp(knowledge, learn) must resolve');
  const documented = flagsIn(topic);
  for (const f of learnFlags) {
    assert.ok(documented.has(f), `learn help must document --${f}`);
  }
  // The example block must exercise the planning-timeout flag too.
  const full = HELP_TEXT.knowledge.join('\n');
  assert.ok(full.includes('--plan-timeout-ms='), 'learn examples must show --plan-timeout-ms=<N>');
});

test('learn flags documented in help are actually accepted by parseFlags', () => {
  // Every --flag documented under "learn flags:" must round-trip through the
  // shared flag parser (guards against typos like --dryrun vs --dry-run).
  const lines = HELP_TEXT.knowledge;
  const start = lines.findIndex(l => l === 'learn flags:');
  const end = lines.findIndex((l, i) => i > start && l === '');
  const documented = flagsIn(lines.slice(start + 1, end));
  // `trailing tokens` documents free text, not a flag.
  for (const f of ['space', 'file', 'base-dir', 'per-batch-chars', 'dry-run',
    'no-survey', 'plan-timeout-ms']) {
    assert.ok(documented.has(f), `"learn flags:" block must list --${f}`);
    const parsed = parseFlags([`--${f}=x`, 'instruction words']);
    assert.ok(f in parsed, `parseFlags must accept --${f}`);
  }
});

test('housekeep / empty help must not advertise flags the implementation ignores', () => {
  // knowledgeCleanupKb / knowledgeEmptyKb always confirm interactively and
  // never parse --yes. The help text once claimed "[--yes]" — regression lock.
  const text = HELP_TEXT.knowledge.join('\n');
  assert.ok(!/--yes/.test(text), '/kb knowledge help must not claim a --yes flag (both commands always confirm)');
});

test('/model help mentions every subcommand the dispatcher routes', () => {
  const modelSubs = ['list', 'use', 'set-default', 'set', 'set-phase', 'add', 'del', 'types', 'show'];
  const text = HELP_TEXT.model.join('\n');
  for (const sub of modelSubs) {
    assert.ok(text.includes(sub), `/help model must mention subcommand "${sub}"`);
  }
  // set-phase phases come from supportedPhaseNames() and are interpolated.
  assert.ok(/Phase: /.test(text), '/help model must list the supported phase names for set-phase');
});

test('/model help set-phase block lists supported phases dynamically', () => {
  const lines = subcommandHelp('model', 'set-phase');
  assert.ok(lines, 'subcommandHelp(model, set-phase) must resolve');
  const phaseLine = lines.find(l => l.startsWith('  --phase='));
  assert.ok(phaseLine, 'set-phase usage must include the --phase flag');
  // The line is generated from supportedPhaseNames() — assert it carries at
  // least two named phases (rewriting-query + code-review style values).
  const phases = phaseLine.split(':')[1].split('|').map(s => s.trim()).filter(Boolean);
  assert.ok(phases.length >= 2, `--phase must enumerate phases, got: ${phases}`);
});

test('/project help lists every set key setProject accepts', () => {
  // Keys handled by setProject (src/slash/project.js).
  const setKeys = ['current', 'name', 'source', 'source-root', 'include', 'exclude'];
  const text = HELP_TEXT.project.join('\n');
  for (const k of setKeys) {
    assert.ok(text.includes(`set ${k}`), `/help project must document "set ${k}"`);
  }
});

test('/help knowledge documents the knowledge family flags truthfully', () => {
  const text = HELP_TEXT.knowledge.join('\n');
  // add defaults to holy, not eden (knowledgeAddKb).
  assert.ok(/add .*\[--space=holy\|eden\]/.test(text), 'add usage must show --space=holy|eden');
  assert.ok(text.includes('(default holy)'), 'add help must state the holy default');
  // import --overwrite is parsed by knowledgeImportKb.
  assert.ok(text.includes('[--overwrite]'), 'import usage must show [--overwrite]');
});
