/*-------------------------------------------------------------------------
 *
 * Unit tests for tool-card border color theming:
 *   - lib/agent/style.js      override kernel (rgbToAnsi256, resolveColorValue,
 *                             applyTheme / setThemeOverride / paint)
 *   - lib/agent/tool_theme.js matching priority, theme.json round-trip
 *   - src/slash/theme.js      /theme subcommands
 *
 * HK2_HOME is pointed at a scratch dir BEFORE importing tool_theme.js (it
 * resolves THEME_PATH from HK2_HOME at module load).
 *
 * Run:  node --test test/theme.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let tmpHome = '';
let origHome = '';

test.before(async () => {
  origHome = process.env.HK2_HOME || '';
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-theme-'));
  process.env.HK2_HOME = tmpHome;
});

test.after(async () => {
  if (origHome) process.env.HK2_HOME = origHome;
  else delete process.env.HK2_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------- style.js

test('rgbToAnsi256 quantizes known colors', async () => {
  const style = await import('../lib/agent/style.js');
  assert.strictEqual(style.rgbToAnsi256(255, 0, 0), 196);
  assert.strictEqual(style.rgbToAnsi256(0, 0, 255), 21);
  assert.strictEqual(style.rgbToAnsi256(255, 255, 255), 231);
  assert.strictEqual(style.rgbToAnsi256(0, 0, 0), 16);
  // grayscale ramp
  assert.ok(style.rgbToAnsi256(128, 128, 128) >= 232 && style.rgbToAnsi256(128, 128, 128) <= 255);
  // clamp out-of-range
  assert.strictEqual(style.rgbToAnsi256(999, -5, 0), 196);
});

test('resolveColorValue accepts hex / ansi:N / token, rejects junk', async () => {
  const style = await import('../lib/agent/style.js');
  const hex = style.resolveColorValue('#FF8800');
  assert.strictEqual(hex.hex, '#ff8800');
  assert.ok(Number.isInteger(hex.ansi256));

  const ansi = style.resolveColorValue('ansi:208');
  assert.strictEqual(ansi.ansi256, 208);
  assert.ok(/^#[0-9a-f]{6}$/.test(ansi.hex));

  const tok = style.resolveColorValue('accent');
  assert.strictEqual(tok.hex, '#00b4ff');
  assert.strictEqual(tok.ansi256, 39);

  assert.strictEqual(style.resolveColorValue('not-a-color'), null);
  assert.strictEqual(style.resolveColorValue('ansi:999'), null);
  assert.strictEqual(style.resolveColorValue(''), null);
});

test('applyTheme installs overrides consulted by paint, then clears', async () => {
  const style = await import('../lib/agent/style.js');
  const res = style.applyTheme({ overrides: { 'tool:bash': '#ff8800', bad: 'junk' } });
  assert.deepStrictEqual(res.applied, ['tool:bash']);
  assert.strictEqual(res.warnings.length, 1);
  assert.strictEqual(res.warnings[0].token, 'bad');

  // paint uses the override in this process's color mode
  const mode = process.env.HK2_NO_COLOR ? 'none' : 'color';
  const painted = style.paint('tool:bash', 'X');
  if (mode === 'color') {
    assert.ok(painted.includes('X'));
    // truecolor uses 255;136;0; 256-mode uses 38;5;214 — both non-default
    assert.ok(/\x1b\[38;(2;255;136;0|5;214)m/.test(painted));
  } else {
    assert.strictEqual(painted, 'X');
  }

  // invalid token untouched by override still paints (fallback path)
  assert.ok(typeof style.paint('nonexistent-token', 'Y') === 'string');

  style.clearThemeOverrides();
  assert.strictEqual(style.getTokenColor('tool:bash'), null);
});

test('setThemeOverride merges without clearing existing overrides', async () => {
  const style = await import('../lib/agent/style.js');
  style.applyTheme({ overrides: { 'tool:bash': '#ff8800' } });
  assert.strictEqual(style.setThemeOverride('swatch:1', '#00ffcc'), true);
  assert.strictEqual(style.setThemeOverride('swatch:bad', 'junk'), false);
  // original still installed after the merge-style call
  assert.strictEqual(style.getTokenColor('tool:bash').hex, '#ff8800');
  assert.strictEqual(style.getTokenColor('swatch:1').hex, '#00ffcc');
  style.clearThemeOverrides();
});

test('topBorder title follows the border token when titleFollowsBorder is on', async () => {
  const style = await import('../lib/agent/style.js');
  const w = { width: 30, token: 'warning' };
  const before = style.topBorder('read', w);
  style.applyTheme({ titleFollowsBorder: true });
  const after = style.topBorder('read', w);
  // Visual difference only exists when colors are emitted; under
  // HK2_NO_COLOR paint()/muted() both return plain text so the strings are
  // identical by design.
  if (!process.env.HK2_NO_COLOR && !process.env.NO_COLOR) {
    assert.notStrictEqual(before, after);
  }
  assert.strictEqual(style.isTitleFollowsBorder(), true);
  style.clearThemeOverrides();
  const restored = style.topBorder('read', w);
  assert.strictEqual(restored, before);
  assert.strictEqual(style.isTitleFollowsBorder(), false);
});

test('installTheme(null) fully restores built-ins including title-follow', async () => {
  const style = await import('../lib/agent/style.js');
  const m = await import('../lib/agent/tool_theme.js');
  // Simulate /theme title-follow on + custom colors, then a full reset
  // (installTheme(null) is what loadTheme() calls when theme.json is gone).
  m.installTheme(m.normalizeTheme({ toolCards: { bash: '#ff8800' }, titleFollowsBorder: true }));
  assert.strictEqual(style.isTitleFollowsBorder(), true);
  assert.strictEqual(m.toolCardToken('bash'), 'tool:bash');
  m.installTheme(null);
  assert.strictEqual(style.isTitleFollowsBorder(), false, 'TITLE_FOLLOWS must reset with the theme');
  assert.strictEqual(m.toolCardToken('bash'), 'bashMode');
  assert.strictEqual(style.getTokenColor('tool:bash'), null, 'override cleared');
  style.clearThemeOverrides();
});

// ------------------------------------------------------------ tool_theme.js

test('toolCardToken built-in defaults match the legacy mapping', async () => {
  const m = await import('../lib/agent/tool_theme.js');
  await m.loadTheme(); // no theme.json in scratch home
  assert.strictEqual(m.toolCardToken('bash'), 'bashMode');
  assert.strictEqual(m.toolCardToken('kb_search'), 'accent');
  assert.strictEqual(m.toolCardToken('kb_symbol'), 'accent');
  assert.strictEqual(m.toolCardToken('read'), 'warning');
  assert.strictEqual(m.toolCardToken('edit'), 'warning');
  assert.strictEqual(m.toolCardToken('ast_grep'), 'warning');
  assert.strictEqual(m.toolCardToken(''), 'warning');
});

test('toolCardToken customization priority: exact > group > wildcard > builtin', async () => {
  const m = await import('../lib/agent/tool_theme.js');
  m.installTheme(m.normalizeTheme({
    toolCards: { bash: '#ff8800', 'kb_*': 'accent', '*': 'ansi:208', read: 'success' },
  }));
  assert.strictEqual(m.toolCardToken('bash'), 'tool:bash');        // group key == exact
  assert.strictEqual(m.toolCardToken('kb_symbol'), 'tool:kb_*');   // group
  assert.strictEqual(m.toolCardToken('read'), 'tool:read');        // exact beats wildcard
  assert.strictEqual(m.toolCardToken('edit'), 'tool:*');           // wildcard
  assert.strictEqual(m.toolCardToken('write'), 'tool:*');
  assert.strictEqual(m.toolCardToken('kb_knowledge'), 'tool:kb_*');
});

test('invalid entries are warned and skipped, fall back to built-ins', async () => {
  const m = await import('../lib/agent/tool_theme.js');
  const norm = m.normalizeTheme({ toolCards: { bash: 'junk', '*': '#ff8800' } });
  assert.strictEqual(norm.warnings.length, 1);
  assert.strictEqual(norm.warnings[0].key, 'bash');
  assert.strictEqual(norm.toolCards.bash, undefined);
  m.installTheme(norm);
  // bash entry invalid -> wildcard applies (documented fallback chain)
  assert.strictEqual(m.toolCardToken('bash'), 'tool:*');
  assert.strictEqual(m.toolCardToken('edit'), 'tool:*');
});

test('theme.json save/load round-trip survives restart', async () => {
  const m = await import('../lib/agent/tool_theme.js');
  await m.saveTheme({ toolCards: { bash: '#ff8800', read: '#00ffcc' }, titleFollowsBorder: true });
  const report = await m.loadTheme();
  assert.strictEqual(report.loaded, true);
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(m.toolCardToken('bash'), 'tool:bash');
  assert.strictEqual(m.toolCardToken('read'), 'tool:read');
  assert.strictEqual(m.toolCardToken('kb_search'), 'accent'); // untouched -> builtin
  const theme = m.getTheme();
  assert.strictEqual(theme.titleFollowsBorder, true);
});

test('broken theme.json degrades to built-ins with one warning', async () => {
  const m = await import('../lib/agent/tool_theme.js');
  const file = path.join(process.env.HK2_HOME, 'theme.json');
  await fs.writeFile(file, '{broken json');
  const report = await m.loadTheme();
  assert.strictEqual(report.loaded, false);
  assert.strictEqual(report.reason, 'invalid');
  assert.strictEqual(m.toolCardToken('bash'), 'bashMode');
  assert.strictEqual(m.toolCardToken('read'), 'warning');
  await fs.unlink(file);
});

// -------------------------------------------------------------- /theme cmd

test('/theme set + list + reset happy path', async () => {
  const { cmdTheme } = await import('../src/slash/theme.js');
  const m = await import('../lib/agent/tool_theme.js');
  const lines = [];
  const ctx = { print: (t) => lines.push(t) };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  await cmdTheme(['set', 'bash', '#ff8800'], ctx);
  await cmdTheme(['set', 'read', 'ansi:208'], ctx);
  assert.ok(lines.some((l) => strip(l).includes('bash -> #ff8800')));

  lines.length = 0;
  await cmdTheme(['list'], ctx);
  const text = strip(lines.join('\n'));
  assert.ok(text.includes('bash'));
  assert.ok(text.includes('custom'));
  assert.ok(text.includes('#ff8800'));
  assert.ok(/per-tool overrides/.test(text));
  assert.ok(/read/.test(text));

  lines.length = 0;
  await cmdTheme(['reset', 'read'], ctx);
  assert.ok(strip(lines.join('\n')).includes('read reset to built-in'));

  lines.length = 0;
  await cmdTheme(['reset'], ctx);
  const file = path.join(process.env.HK2_HOME, 'theme.json');
  await assert.rejects(() => fs.access(file));
  assert.strictEqual(m.toolCardToken('bash'), 'bashMode');
  assert.strictEqual(m.toolCardToken('read'), 'warning');
});

test('/theme set rejects invalid colors with usage help', async () => {
  const { cmdTheme } = await import('../src/slash/theme.js');
  const lines = [];
  const ctx = { print: (t) => lines.push(t) };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  await cmdTheme(['set', '*', 'notacolor'], ctx);
  const text = strip(lines.join('\n'));
  assert.ok(text.includes('Invalid color'));
  assert.ok(text.includes('#rrggbb'));
  // nothing persisted
  const file = path.join(process.env.HK2_HOME, 'theme.json');
  await assert.rejects(() => fs.access(file));
});

test('/theme preview renders sample cards with current tokens', async () => {
  const { cmdTheme } = await import('../src/slash/theme.js');
  const m = await import('../lib/agent/tool_theme.js');
  await m.saveTheme({ toolCards: { bash: '#ff8800' }, titleFollowsBorder: false });
  const lines = [];
  const ctx = { print: (t) => lines.push(t) };
  await cmdTheme(['preview'], ctx);
  const all = lines.join('\n');
  assert.ok(all.includes('bash'));
  assert.ok(all.includes('kb_search'));
  assert.ok(all.includes('read'));
  // the bash card carries the custom truecolor escape (when colors enabled)
  if (!process.env.HK2_NO_COLOR) {
    assert.ok(all.includes('\x1b[38;2;255;136;0m'));
  }
  await cmdTheme(['reset'], ctx);
});

test('/theme title-follow toggles and persists', async () => {
  const { cmdTheme } = await import('../src/slash/theme.js');
  const m = await import('../lib/agent/tool_theme.js');
  const lines = [];
  const ctx = { print: (t) => lines.push(t) };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  await cmdTheme(['title-follow', 'on'], ctx);
  assert.ok(strip(lines.join('\n')).includes('title-follows-border: on'));
  assert.strictEqual(m.getTheme().titleFollowsBorder, true);
  lines.length = 0;
  await cmdTheme(['title-follow', 'off'], ctx);
  assert.strictEqual(m.getTheme().titleFollowsBorder, false);
  await cmdTheme(['reset'], ctx);
});

test('/theme is registered in SLASH_COMMANDS and shows in help', async () => {
  const { SLASH_COMMANDS } = await import('../src/slash/index.js');
  const cmd = SLASH_COMMANDS.find((c) => c.name === '/theme');
  assert.ok(cmd, '/theme registered');
  assert.match(cmd.description, /border colors/i);
});

test('/theme help and ? print the family help from HELP_TEXT', async () => {
  const { cmdTheme } = await import('../src/slash/theme.js');
  const { HELP_TEXT } = await import('../src/slash/help.js');
  for (const alias of ['help', '?']) {
    const lines = [];
    const ctx = { print: (t) => lines.push(t) };
    await cmdTheme([alias], ctx);
    const text = lines.join('\n');
    assert.ok(text.includes('Usage: /theme'), `/theme ${alias} prints usage`);
    assert.ok(text.includes('title-follow'), `/theme ${alias} lists subcommands`);
    assert.ok(!text.includes('Unknown subcommand'), `/theme ${alias} is not rejected`);
  }
  // HELP_TEXT is the single source of truth — every routed subcommand is listed.
  const text = HELP_TEXT.theme.join('\n');
  for (const sub of ['list', 'set', 'reset', 'preview', 'title-follow']) {
    assert.ok(text.includes(sub), `/help theme must mention subcommand "${sub}"`);
  }
});

test('/theme <unknown> falls back to family help, not a bare usage line', async () => {
  const { cmdTheme } = await import('../src/slash/theme.js');
  const lines = [];
  const ctx = { print: (t) => lines.push(t) };
  await cmdTheme(['bogus'], ctx);
  const text = lines.join('\n');
  assert.ok(text.includes('Unknown subcommand: bogus'));
  assert.ok(text.includes('Usage: /theme'), 'default branch prints full family help');
});
