/*-------------------------------------------------------------------------
 * Test: scanFences (documentation fence scanner) semantics.
 *
 * Pins the CommonMark-ish rules the docs checker enforces: backtick and
 * tilde fences of length >= 3, matching close character and length, no
 * language-tag requirement violations, unclosed-fence detection, content
 * immunity, and the 3-space indent limit.
 *-------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFences } from '../scripts/check-docs.mjs';

const kinds = (raw) => scanFences(raw).issues.map((i) => i.kind);

test('valid ```text fence: clean, content stripped', () => {
  const { stripped, issues } = scanFences('para\n```text\ninner [link](x.md)\n```\npara [ok](y.md)');
  assert.deepEqual(issues, []);
  assert.ok(!stripped.includes('[link](x.md)'), 'fence content stripped');
  assert.ok(stripped.includes('[ok](y.md)'), 'outside text kept');
});

test('valid ~~~text fence: clean', () => {
  assert.deepEqual(kinds('~~~text\nx\n~~~'), []);
});

test('valid 4-backtick json fence: clean', () => {
  assert.deepEqual(kinds('````json\n{"a":"```"}\n````'), []);
});

test('bare ``` fence flagged no-language', () => {
  assert.deepEqual(kinds('```\nx\n```'), ['no-language']);
});

test('bare ~~~ fence flagged no-language', () => {
  assert.deepEqual(kinds('~~~\nx\n~~~'), ['no-language']);
});

test('unclosed fence flagged with its opening line', () => {
  const issues = scanFences('a\n```bash\necho hi\nb').issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'unclosed');
  assert.equal(issues[0].line, 2);
});

test('``` opened, ~~~ close does NOT close — unclosed flagged', () => {
  assert.deepEqual(kinds('```text\nx\n~~~\n'), ['unclosed']);
});

test('fence content containing the other fence char is not a close', () => {
  // ``` inside a ~~~text block is content, not a fence; outer ~~~ closes.
  assert.deepEqual(kinds('~~~text\n```\nnot a close\n```\nstill open\n~~~'), []);
});

test('closing fence shorter than opening does not close', () => {
  // 4 backticks opened; the 3-backtick line is content, nothing closes -> unclosed.
  assert.deepEqual(kinds('````text\n```\n'), ['unclosed']);
  // Once a proper 4-backtick close arrives, the block is clean.
  assert.deepEqual(kinds('````text\n```\n````'), []);
});

test('up to 3 leading spaces still a fence; 4 spaces is indented code, not a fence', () => {
  assert.deepEqual(kinds('   ```text\nx\n   ```'), []);
  // 4-space indented ``` is NOT a fence: no no-language flag, no unclosed flag.
  assert.deepEqual(kinds('    ```\nx'), []);
});
