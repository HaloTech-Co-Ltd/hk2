/**
 * Tool-card border color theming.
 *
 * Users customize the frame color of tool-call cards (bash / kb_* / read /
 * edit / write / find / grep / …) via ~/.hk2/theme.json:
 *
 *   {
 *     "toolCards": {
 *       "bash":  "#ff8800",     // exact tool name
 *       "kb_*":  "accent",      // the kb_ group
 *       "*":     "warning"      // wildcard fallback for every other tool
 *     },
 *     "titleFollowsBorder": false
 *   }
 *
 * Color values accept '#rrggbb', 'ansi:0-255', or a built-in token name
 * (accent / muted / dim / success / error / warning / border / bashMode /
 * pythonMode) — resolved and installed via style.applyTheme().
 *
 * Matching priority for a tool name:
 *   1. exact entry in toolCards (e.g. "read", "kb_search")
 *   2. group entry "kb_*" (only when the tool name starts with "kb_")
 *      group entry "bash" (only for the bash tool)
 *   3. wildcard "*"
 *   4. built-in default: bash -> bashMode, kb_ prefixed -> accent, else warning
 *
 * The chosen entry maps to a dynamic paint() token 'tool:<key>' registered in
 * style.js's override table, so the whole card (border + title + body chrome)
 * renders in the customized hue with zero renderer changes.
 */

import path from 'node:path';
import { HK2_HOME } from '../config/home.js';
import { readJsonSafe, writeJsonAtomic, exists } from '../util/fs_atomic.js';
import { applyTheme, resolveColorValue } from './style.js';

export const THEME_PATH = path.join(HK2_HOME, 'theme.json');

/** Built-in default mapping (tool name class -> style token). */
export const BUILTIN_TOOL_TOKENS = {
  bash: 'bashMode',
  'kb_*': 'accent',
  '*': 'warning',
};

/** The three documented top-level keys users may set. */
export const THEME_TOOL_KEYS = ['bash', 'kb_*', '*'];

// Runtime theme state (installed once at startup, mutated by /theme set).
let THEME = null;            // parsed theme.json, or null when absent/broken
let OVERRIDE_TOKENS = {};    // toolCards key -> dynamic paint() token name
let WARNINGS = [];           // [{ key, value, reason }] from the last load

function themeDir(theme) {
  const tc = theme?.toolCards;
  return tc && typeof tc === 'object' ? tc : {};
}

/** Normalize + validate a raw parsed theme.json into { toolCards, titleFollowsBorder }. */
export function normalizeTheme(raw) {
  if (!raw || typeof raw !== 'object') return { toolCards: {}, titleFollowsBorder: false };
  const warnings = [];
  const toolCards = {};
  const rawCards = themeDir(raw);
  for (const key of Object.keys(rawCards)) {
    const value = rawCards[key];
    if (!resolveColorValue(value)) {
      warnings.push({
        key,
        value,
        reason: 'expected #rrggbb, ansi:0-255, or a built-in token name',
      });
      continue;
    }
    toolCards[key] = value;
  }
  const titleFollowsBorder = !!raw.titleFollowsBorder;
  return { toolCards, titleFollowsBorder, warnings };
}

/**
 * Install a theme object into the style layer: register one override token
 * per valid toolCards entry ('tool:<key>' -> color) and set the
 * titleFollowsBorder flag. Returns the applyTheme result for introspection.
 */
export function installTheme(theme) {
  THEME = theme || null; // keep toolCardToken's lookup source in sync
  const cards = themeDir(theme);
  const overrides = {};
  const tokens = {};
  for (const [key, value] of Object.entries(cards)) {
    const token = `tool:${key}`;
    overrides[token] = value;
    tokens[key] = token;
  }
  OVERRIDE_TOKENS = tokens;
  const res = applyTheme({
    overrides,
    // Explicit false (not null) when theme is null/unsetting: applyTheme
    // treats null as "leave untouched", which would strand TITLE_FOLLOWS on
    // after /theme reset or an unreadable theme.json. We want a full restore.
    titleFollowsBorder: theme ? !!theme.titleFollowsBorder : false,
  });
  return res;
}

/**
 * Color token for a tool-call card. Customization lookup order:
 * exact toolCards entry > kb_ group and bash group > '*' wildcard > built-in default.
 */
export function toolCardToken(name) {
  const n = String(name || '');
  const cards = themeDir(THEME);
  if (Object.prototype.hasOwnProperty.call(cards, n)) return OVERRIDE_TOKENS[n];
  if (n.startsWith('kb_') && OVERRIDE_TOKENS['kb_*']) return OVERRIDE_TOKENS['kb_*'];
  if (n === 'bash' && OVERRIDE_TOKENS['bash']) return OVERRIDE_TOKENS['bash'];
  if (OVERRIDE_TOKENS['*']) return OVERRIDE_TOKENS['*'];
  if (n === 'bash') return 'bashMode';
  if (n.startsWith('kb_')) return 'accent';
  return 'warning';
}

/** Current parsed theme (or null when no theme.json exists). Exposes the raw values. */
export function getTheme() {
  return THEME;
}

/** Warnings collected by the last loadTheme(). */
export function getThemeWarnings() {
  return WARNINGS;
}

/** Map of toolCards key -> dynamic token currently installed. */
export function getOverrideTokens() {
  return { ...OVERRIDE_TOKENS };
}

/**
 * Load ~/.hk2/theme.json, validate, and install. Missing file installs
 * nothing (built-in defaults stay active). Broken JSON produces one warning
 * and falls back to built-ins. Returns the normalize/install report.
 */
export async function loadTheme() {
  if (!await exists(THEME_PATH)) {
    THEME = null;
    WARNINGS = [];
    installTheme(null);
    return { loaded: false, reason: 'absent', warnings: [] };
  }
  let raw = null;
  try {
    raw = await readJsonSafe(THEME_PATH, null);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object') {
    THEME = null;
    WARNINGS = [{ key: 'theme.json', value: '<file>', reason: 'unreadable or invalid JSON — using built-in colors' }];
    installTheme(null);
    return { loaded: false, reason: 'invalid', warnings: WARNINGS };
  }
  const norm = normalizeTheme(raw);
  WARNINGS = norm.warnings || [];
  const res = installTheme(norm);
  return { loaded: true, warnings: WARNINGS, applied: res.applied };
}

/** Persist a theme object to theme.json (atomic write). */
export async function saveTheme(theme) {
  const out = { toolCards: themeDir(theme), titleFollowsBorder: !!theme?.titleFollowsBorder };
  await writeJsonAtomic(THEME_PATH, out);
}
