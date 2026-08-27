/*-------------------------------------------------------------------------
 *
 * Unit tests for the derived slash-command completion (src/slash/index.js).
 *
 * Completions must come ONLY from what already exists — SLASH_COMMANDS for
 * the top level, the "Subcommands:" / "Phases:" sections of HELP_TEXT for
 * the sub levels. The drift guard asserts every registered command (and its
 * help entry) is reachable through completion, so a newly added command can
 * no longer ship without being completable — the failure mode of the old
 * hand-maintained list.
 *
 * Run:  node --test test/slash_completion.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { SLASH_COMMANDS, slashCompletions, allSlashCompletionLabels } from '../src/slash/index.js';
import { HELP_TEXT } from '../src/slash/help.js';

/* ----- drift guards --------------------------------------------------- */

test('drift guard: every registered command is completable', () => {
  const labels = allSlashCompletionLabels();
  for (const c of SLASH_COMMANDS) {
    assert.ok(labels.includes(c.name), `${c.name} present in completion labels`);
  }
});

test('drift guard: labels are unique and slash-prefixed', () => {
  const labels = allSlashCompletionLabels();
  assert.equal(new Set(labels).size, labels.length, 'no duplicate labels');
  for (const l of labels) assert.ok(l.startsWith('/'), `label ${l} starts with /`);
});

test('drift guard: every family with a HELP_TEXT entry offers <family> help', () => {
  const labels = allSlashCompletionLabels();
  for (const c of SLASH_COMMANDS) {
    const key = c.name.slice(1);
    if (HELP_TEXT[key]) {
      assert.ok(labels.includes(`${c.name} help`), `${c.name} help completable`);
    }
  }
});

/* ----- structured completion ------------------------------------------ */

test('top-level: prefix filter over command names', () => {
  const { items, replaceFrom } = slashCompletions('/mo');
  assert.equal(replaceFrom, 0);
  const labels = items.map(i => i.label);
  assert.ok(labels.includes('/model'));
  assert.ok(!labels.some(l => l !== '/model'), 'only /model matches /mo');
  assert.ok(typeof items[0].description === 'string' && items[0].description.length > 0, 'description carried');
});

test('sub-level: family subcommands from the Subcommands: section', () => {
  const { items } = slashCompletions('/kb kn');
  const labels = items.map(i => i.label);
  assert.ok(labels.includes('/kb knowledge'), 'nested topic offered as a subcommand');
  const { items: modelItems } = slashCompletions('/model li');
  assert.ok(modelItems.map(i => i.label).includes('/model list'), 'model list completes');
});

test('nested topic: /kb knowledge <sub> derives from the knowledge help block', () => {
  const { items, replaceFrom } = slashCompletions('/kb knowledge le');
  const labels = items.map(i => i.label);
  assert.ok(labels.includes('/kb knowledge learn'));
  assert.ok(!labels.includes('/kb knowledge list'), 'list filtered out by prefix');
  assert.equal(replaceFrom, '/kb knowledge '.length, 'replaces only the last token');
});

test('Phases: section parses too (/review code, /review plan)', () => {
  const { items } = slashCompletions('/review ');
  const labels = items.map(i => i.label);
  assert.ok(labels.includes('/review code'));
  assert.ok(labels.includes('/review plan'));
});

test('non-slash input yields no items', () => {
  assert.deepEqual(slashCompletions('hello').items, []);
  assert.deepEqual(slashCompletions('').items, []);
});

test('unknown deeper levels yield no items (no invention)', () => {
  // /model has no nested topics — third token must not invent completions.
  assert.deepEqual(slashCompletions('/model list x').items, []);
  assert.deepEqual(slashCompletions('/session resume x').items, []);
});
