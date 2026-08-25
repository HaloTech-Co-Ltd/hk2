/**
 * /theme — customize tool-card border colors (~/.hk2/theme.json).
 *
 *   /theme                          list current colors + built-in defaults
 *   /theme set <key> <color>        set and persist (key: bash | kb_* | * | exact tool name)
 *   /theme reset [key]              drop one key, or the whole file with no arg
 *   /theme preview                  print sample cards for the three groups
 *   /theme title-follow [on|off]    toggle the top-border title following the frame color
 *
 * Color values: '#rrggbb' | 'ansi:0-255' | built-in token name
 * (accent / muted / dim / success / error / warning / border / bashMode / pythonMode).
 */

import * as style from '../../lib/agent/style.js';
import {
  loadTheme, saveTheme, getTheme, getThemeWarnings, normalizeTheme,
  BUILTIN_TOOL_TOKENS, THEME_TOOL_KEYS, THEME_PATH,
} from '../../lib/agent/tool_theme.js';
import fs from 'node:fs/promises';
import { exists } from '../../lib/util/fs_atomic.js';
import { printCommandHelp } from './help.js';

const COLOR_HELP = `Color values: #rrggbb | ansi:0-255 | token (accent muted dim success error warning border bashMode pythonMode)`;

export async function cmdTheme(args, ctx) {
  const sub = (args[0] || 'list').replace(/^--/, '');
  switch (sub) {
    case 'list': return themeList(ctx);
    case 'set': return themeSet(args.slice(1), ctx);
    case 'reset': return themeReset(args.slice(1), ctx);
    case 'preview': return themePreview(ctx);
    case 'title-follow': return themeTitleFollow(args.slice(1), ctx);
    case 'help': case '?':
      printCommandHelp(ctx, 'theme');
      return;
    default:
      ctx.print(`Unknown subcommand: ${sub}`);
      printCommandHelp(ctx, 'theme');
      return;
  }
}

function describeColor(value) {
  const res = style.resolveColorValue(value);
  if (!res) return `${value} (invalid)`;
  return `${res.hex}  ansi256:${res.ansi256}`;
}

function paintSwatch(value) {
  const res = style.resolveColorValue(value);
  if (!res) return String(value);
  const token = `swatch:${res.hex}`; // unique per color, registered ad hoc
  style.setThemeOverride(token, res.hex); // merge — keeps tool:* overrides intact
  return style.paint(token, '████ test-frame ╭─╮');
}

function effectiveValue(key) {
  const theme = getTheme();
  if (theme?.toolCards && Object.prototype.hasOwnProperty.call(theme.toolCards, key)) {
    return { value: theme.toolCards[key], custom: true };
  }
  // Group keys resolve from the built-in table; exact tool names fall back
  // to the built-in per-tool default token (bash / kb_ prefix / else warning).
  const builtin = BUILTIN_TOOL_TOKENS[key]
    ?? (key === 'bash' ? 'bashMode' : String(key).startsWith('kb_') ? 'accent' : 'warning');
  return { value: builtin, custom: false };
}

async function themeList(ctx) {
  await loadTheme();
  const theme = getTheme();
  ctx.print(`Tool-card frame colors  ${style.dim(`(${THEME_PATH})`)}`);
  for (const key of THEME_TOOL_KEYS) {
    const { value, custom } = effectiveValue(key);
    const tag = custom ? style.accent('custom') : style.dim('built-in');
    ctx.print(`  ${style.bold(key.padEnd(6))} ${tag}  ${style.dim(describeColor(value))}`);
    ctx.print(`    ${paintSwatch(value)}`);
  }
  const extras = Object.keys(theme?.toolCards || {}).filter((k) => !THEME_TOOL_KEYS.includes(k));
  if (extras.length) {
    ctx.print(`  ${style.dim('per-tool overrides:')}`);
    for (const key of extras) {
      ctx.print(`    ${style.bold(key)} ${style.dim(describeColor(theme.toolCards[key]))} ${style.dim(paintSwatch(theme.toolCards[key]))}`);
    }
  }
  ctx.print(`  title-follows-border: ${theme?.titleFollowsBorder ? style.accent('on') : style.dim('off')}`);
  const warns = getThemeWarnings() || [];
  for (const w of warns) ctx.print(style.warning(`  ! ${w.key}: ${w.reason}`));
  ctx.print(style.dim(`Change: /theme set <key> <color>   ${COLOR_HELP}`));
}

async function themeSet(args, ctx) {
  const key = args[0];
  const value = args[1];
  if (!key || !value) {
    ctx.print(`Usage: /theme set <key> <color>`);
    ctx.print(`  key:   bash | kb_* | * | an exact tool name (read, edit, kb_search, ...)`);
    ctx.print(`  color: ${COLOR_HELP}`);
    return;
  }
  if (!style.resolveColorValue(value)) {
    ctx.print(style.errorT(`Invalid color: ${value}`));
    ctx.print(`  ${COLOR_HELP}`);
    return;
  }
  await loadTheme();
  const theme = getTheme() || { toolCards: {}, titleFollowsBorder: false };
  const toolCards = { ...(theme.toolCards || {}), [key]: value };
  const next = { toolCards, titleFollowsBorder: !!theme.titleFollowsBorder };
  const norm = normalizeTheme(next);
  if (norm.warnings?.length) {
    for (const w of norm.warnings) ctx.print(style.warning(`! ${w.key}: ${w.reason}`));
  }
  await saveTheme(norm);
  await loadTheme();
  ctx.print(`${style.success('✓')} ${style.bold(key)} -> ${style.accent(value)}  ${style.dim(describeColor(value))}`);
  ctx.print(`  ${paintSwatch(value)}`);
  ctx.print(style.dim('Applied to new tool cards immediately.'));
}

async function themeReset(args, ctx) {
  const key = args[0];
  if (!key) {
    if (await exists(THEME_PATH)) await fs.unlink(THEME_PATH).catch(() => {});
    await loadTheme();
    ctx.print(`${style.success('✓')} theme.json removed — built-in colors restored.`);
    return;
  }
  await loadTheme();
  const theme = getTheme();
  if (!theme?.toolCards || !(key in theme.toolCards)) {
    ctx.print(`No custom color set for '${key}'.`);
    return;
  }
  const toolCards = { ...theme.toolCards };
  delete toolCards[key];
  if (Object.keys(toolCards).length === 0 && !theme.titleFollowsBorder) {
    if (await exists(THEME_PATH)) await fs.unlink(THEME_PATH).catch(() => {});
  } else {
    await saveTheme({ toolCards, titleFollowsBorder: !!theme.titleFollowsBorder });
  }
  await loadTheme();
  const { value, custom } = effectiveValue(key);
  ctx.print(`${style.success('✓')} ${key} reset to ${custom ? 'custom' : 'built-in'} ${style.dim(describeColor(value))}`);
}

async function themePreview(ctx) {
  await loadTheme();
  const { toolCardToken } = await import('../../lib/agent/tool_theme.js');
  const samples = [
    { name: 'bash', body: ['$ ls -la src/'] },
    { name: 'kb_search', body: ['query: "parse config file"'] },
    { name: 'read', body: ['path: src/cli.js'] },
  ];
  for (const s of samples) {
    const token = toolCardToken(s.name);
    const lines = style.card({ title: s.name, lines: s.body, token, width: 40 });
    for (const ln of lines) ctx.print(ln);
    ctx.print('');
  }
}

async function themeTitleFollow(args, ctx) {
  const arg = args[0];
  await loadTheme();
  const theme = getTheme() || { toolCards: {}, titleFollowsBorder: false };
  let next;
  if (arg === 'on' || arg === 'off') next = arg === 'on';
  else next = !theme.titleFollowsBorder; // toggle
  await saveTheme({ toolCards: theme.toolCards || {}, titleFollowsBorder: next });
  await loadTheme();
  ctx.print(`${style.success('✓')} title-follows-border: ${next ? style.accent('on') : style.dim('off')}`);
  ctx.print(style.dim('The title embedded in the top border now ' + (next ? 'follows' : 'ignores') + ' the frame color.'));
}
