/* Supreme-code system-prompt injection test.
 * Run: node --test test/supreme_prompt.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt } from '../lib/agent/system_prompt.js';

test('buildSystemPrompt renders supreme codes with priority over KB context', () => {
  const prompt = buildSystemPrompt({
    project: { name: 'demo', id: 'demo-id' },
    tools: [{ name: 'bash', snippet: 'run commands' }],
    supremeCodes: ['API Key 绝对禁止出现在任何代码文件中', '代码规范必须严格遵循 **KB(project-code-format)**'],
    graphText: '# Knowledge-base context\nsome retrieved stuff',
  });
  assert.ok(prompt.includes('# Project Supreme Code'), 'section header present');
  assert.ok(prompt.includes('1. API Key 绝对禁止出现在任何代码文件中'));
  assert.ok(prompt.includes('2. 代码规范必须严格遵循 **KB(project-code-format)**'));
  assert.ok(prompt.includes('hk2-supreme-code'));
  assert.ok(prompt.includes('never violate'));
  // Supreme code precedes the KB graph section
  assert.ok(prompt.indexOf('# Project Supreme Code') < prompt.indexOf('# Knowledge-base context'));
  // Violations must be refused + cited
  assert.ok(prompt.includes('refuse it'));
});

test('buildSystemPrompt omits the section when there are no items', () => {
  const prompt = buildSystemPrompt({ supremeCodes: [], graphText: 'x' });
  assert.ok(!prompt.includes('# Project Supreme Code'));
  const noArg = buildSystemPrompt({ graphText: 'x' });
  assert.ok(!noArg.includes('# Project Supreme Code'));
});
