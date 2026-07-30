/**
 * Themed output layer for hk2's REPL.
 *
 * Provides:
 *   - Color palette (titanium-inspired dark theme).
 *   - Unicode box-drawing (rounded corners) for tool-call cards and banners.
 *   - Braille spinner frames, ✓/✗ status icons, · bullet separator.
 *   - Helpers to render "cards": bordered frames with a title embedded in the
 *     top border, header line, body, status footer, bottom border.
 *
 * Color mode is chosen once per process: truecolor (24-bit) when COLORTERM
 * indicates it, otherwise 256-color, otherwise none. Callers do not need to
 * pick — every helper degrades gracefully. Override with HK2_NO_COLOR=1.
 */

const NO_COLOR = !!process.env.HK2_NO_COLOR || process.env.NO_COLOR;
const TERM = process.env.TERM || '';

function detectColorMode() {
  if (NO_COLOR || TERM === 'dumb') return 'none';
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  if (process.env.WT_SESSION) return 'truecolor';
  if (TERM === 'linux' || TERM === '') return '256';
  return 'truecolor';
}

const MODE = detectColorMode();

/**
 * Palette. Titanium-inspired hex values; ANSI-256 fallbacks chosen to
 * approximate the same hue/brightness on terminals without truecolor.
 */
const HEX = {
  accent:    '#00b4ff',  // electric blue
  muted:     '#9ca3b0',  // dim aluminum
  dim:       '#6b7280',  // darker gray
  success:   '#00ff88',  // readout green
  error:     '#ff4757',  // alert red
  warning:   '#ffb347',  // amber
  border:    '#2a3038',  // subtle gray
  bashMode:  '#00ff88',  // green (same as success)
  pythonMode:'#f0c040',  // warm yellow
};
const ANSI256 = {
  accent: 39, muted: 245, dim: 240, success: 84, error: 203,
  warning: 215, border: 236, bashMode: 84, pythonMode: 221,
};

/**
 * Detect whether the terminal likely renders UTF-8 box-drawing and symbol
 * characters. When false, ICON / BOX / SPINNER fall back to ASCII so we
 * don't show `��` replacement glyphs on Windows cmd.exe or any terminal
 * with a non-UTF-8 codepage. Override with HK2_ASCII=1 to force.
 */
function detectUtf8() {
  if (process.env.HK2_ASCII) return false;
  const ct = (process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '').toLowerCase();
  if (ct.includes('utf-8') || ct.includes('utf8')) return true;
  // macOS & most Linux distros default to UTF-8.
  if (process.platform === 'darwin' || process.platform === 'linux') return true;
  // Windows: only assume UTF-8 for known-modern terminals.
  if (process.platform === 'win32') {
    return !!(process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode' ||
      process.env.TERM === 'xterm-256color');
  }
  return false;
}
const UTF8 = detectUtf8();

/** Box-drawing glyphs. Rounded preset under UTF-8, ASCII fallback otherwise. */
export const BOX = UTF8 ? {
  topLeft: '╭', topRight: '╮',
  bottomLeft: '╰', bottomRight: '╯',
  horizontal: '─', vertical: '│',
  teeDown: '┬', teeUp: '┴',
} : {
  topLeft: '+', topRight: '+',
  bottomLeft: '+', bottomRight: '+',
  horizontal: '-', vertical: '|',
  teeDown: '-', teeUp: '-',
};

/** Spinner frames. Braille under UTF-8, ASCII fallback otherwise. */
export const SPINNER = UTF8
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['|', '/', '-', '\\', '|', '/', '-', '\\'];

/** Status icons. Unicode under UTF-8, ASCII fallback otherwise. */
export const ICON = UTF8 ? {
  ok: '✓', err: '✗', warn: '⚠', bullet: '•', dot: '·', arrow: '→', ellipsis: '…',
  up: '↑', down: '↓',
} : {
  ok: '+', err: 'x', warn: '!', bullet: '*', dot: '.', arrow: '->', ellipsis: '...',
  up: '^', down: 'v',
};

/** Heavy underline used under H1/H2 in markdown rendering (or ASCII '='). */
export const HEADING_RULE = UTF8 ? '━' : '=';

/** Whether full Unicode is available (for callers that need to gate features). */
export const HAS_UTF8 = UTF8;

const RESET = '\x1b[0m';

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/**
 * Wrap `text` in the named color token. Tokens: accent / muted / dim / success
 * / error / warning / border / bashMode / pythonMode. Honours embedded ANSI
 * (the closing reset restores to the named color, not to default — so colored
 * spans inside stay inside the token color until the caller's RESET).
 */
export function paint(token, text) {
  if (MODE === 'none' || !text) return text;
  if (MODE === 'truecolor') {
    const [r, g, b] = hexToRgb(HEX[token] || HEX.muted);
    const open = `\x1b[38;2;${r};${g};${b}m`;
    return `${open}${text}${RESET}`;
  }
  const code = ANSI256[token] ?? ANSI256.muted;
  return `\x1b[38;5;${code}m${text}${RESET}`;
}

export const accent    = (t) => paint('accent', t);
export const muted     = (t) => paint('muted', t);
export const dim       = (t) => paint('dim', t);
export const success   = (t) => paint('success', t);
export const errorT    = (t) => paint('error', t);
export const warning   = (t) => paint('warning', t);
export const border    = (t) => paint('border', t);
export const bashMode  = (t) => paint('bashMode', t);

export function bold(text) {
  if (MODE === 'none') return text;
  return `\x1b[1m${text}${RESET}`;
}
export function italic(text) {
  if (MODE === 'none') return text;
  return `\x1b[3m${text}${RESET}`;
}

/** Terminal width in columns (best-effort; fallback 80). */
export function termWidth() {
  return process.stdout.columns || process.stderr.columns || 80;
}

/** Visible width of a string with ANSI escapes stripped. */
export function visibleWidth(s) {
  if (!s) return 0;
  // Strip ANSI CSI sequences and OSC sequences (which end on BEL or ST).
  const stripped = String(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // Approximate wide-char awareness via the BMP codepoint range; good enough
  // for the box-drawing glyphs and CJK we actually emit.
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && (
      (cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF)
    ) ? 2 : 1;
  }
  return w;
}

/** Repeat the horizontal box glyph to a visible width, painted as border. */
function hrule(n, token = 'border') {
  return paint(token, BOX.horizontal.repeat(Math.max(0, n)));
}

/**
 * Pick a card width that fits every body line, capped at term width.
 *
 * @param {string[]} lines              body lines (may contain ANSI codes)
 * @param {object} [opts]
 * @param {string} [opts.title]         card title (visible portion adds to width budget)
 * @param {number} [opts.floor=30]      minimum width
 * @param {number} [opts.ceil]          maximum width (default: terminal width)
 * @param {number} [opts.padding=4]     extra slack: leading/trailing space + the two verticals
 * @returns {number}                    body width (interior of the card, including 1-char leading space)
 */
export function fitCardWidth(lines, opts = {}) {
  const floor = opts.floor ?? 30;
  const ceil = opts.ceil ?? termWidth();
  const padding = opts.padding ?? 4;  // 2 verticals + 2 spaces of breathing room
  const titleBudget = opts.title ? visibleWidth(opts.title) + 2 /* " title " */ : 0;
  let maxContent = 0;
  for (const ln of lines || []) maxContent = Math.max(maxContent, visibleWidth(ln));
  const want = maxContent + padding;
  return Math.max(floor, Math.min(ceil, Math.max(want, titleBudget + padding)));
}

/**
 * Top border with optional embedded title: `╭── title ──╮`.
 * The title sits between two horizontal runs; sides close the box.
 */
export function topBorder(title, { width = termWidth(), token = 'border' } = {}) {
  const innerW = Math.max(0, width - 2);  // minus the two verticals
  const t = title ? ` ${title} ` : '';
  const tVis = visibleWidth(t);
  const left = hrule(Math.min(innerW, Math.max(1, 3)));
  if (!title) {
    return paint(token, BOX.topLeft + BOX.horizontal.repeat(innerW) + BOX.topRight);
  }
  if (tVis >= innerW) {
    // Title fills the row: drop the trailing run.
    const titleStr = bold(muted(t.trim().slice(0, Math.max(1, innerW - 2))));
    return paint(token, BOX.topLeft) + left + titleStr + paint(token, BOX.horizontal.repeat(Math.max(0, innerW - visibleWidth(left) - visibleWidth(titleStr)))) + paint(token, BOX.topRight);
  }
  const after = innerW - visibleWidth(left) - tVis;
  return paint(token, BOX.topLeft) + left + bold(muted(t)) + hrule(Math.max(0, after), token) + paint(token, BOX.topRight);
}

/** Bottom border: `╰──…──╯`. */
export function bottomBorder({ width = termWidth(), token = 'border' } = {}) {
  const innerW = Math.max(0, width - 2);
  return paint(token, BOX.bottomLeft + BOX.horizontal.repeat(innerW) + BOX.bottomRight);
}

/**
 * Wrap a body line with the vertical borders: `│ line │`. Pads or truncates
 * the line so the right border always lines up.
 *
 * Layout inside the card:
 *   │ <space> text <padding> │
 *   ^^^^^^^ ^^^^^^^^^ ^^^^^^^ ^^^
 *   left-v  lead-space content trailing pad  right-v
 *
 * Total visible width = 1 + 1 + vis + pad + 1 = width
 * → pad = width - 3 - vis = (width - 2) - vis - 1 = innerW - vis - 1.
 * When pad < 0 the content wouldn't fit even without padding; truncate.
 */
export function bodyLine(text, { width = termWidth(), token = 'border' } = {}) {
  const innerW = Math.max(0, width - 2);
  const v = paint(token, BOX.vertical);
  const vis = visibleWidth(text);
  // Content budget = innerW - 1 (the leading space eats one column).
  // If vis exceeds the budget, truncate and append an ellipsis in-place.
  const budget = innerW - 1;
  if (vis > budget) {
    const ellipsisVis = visibleWidth(ICON.ellipsis);
    const cap = Math.max(0, budget - ellipsisVis);
    let out = '';
    let w = 0;
    let inEsc = false;
    for (const ch of String(text)) {
      if (ch === '\x1b') inEsc = true;
      if (inEsc) { out += ch; if (ch === 'm') inEsc = false; continue; }
      if (w >= cap) break;
      out += ch;
      w += visibleWidth(ch);
    }
    out += paint('dim', ICON.ellipsis);
    const used = visibleWidth(out);
    const pad = innerW - 1 - used;
    return `${v} ${out}${pad > 0 ? ' '.repeat(pad) : ''}${v}`;
  }
  const pad = innerW - 1 - vis;
  return `${v} ${text}${pad > 0 ? ' '.repeat(pad) : ''}${v}`;
}

/**
 * Render a complete card: top border + body lines + bottom border. Optional
 * `title` is embedded in the top border; optional `token` colors the border.
 */
export function card({ title = '', lines = [], token = 'border', width = termWidth() } = {}) {
  const out = [topBorder(title, { width, token })];
  for (const ln of lines) out.push(bodyLine(ln, { width, token }));
  out.push(bottomBorder({ width, token }));
  return out;
}

/**
 * Loader line: `<spinner> <message>` with optional `<dim·suffix>`.
 */
export function loaderLine(spinnerFrame, message, suffix = '') {
  const head = accent(spinnerFrame);
  const tail = suffix ? ' ' + dim(`${ICON.dot} ` + suffix) : '';
  return `${head} ${muted(message)}${tail}`;
}

/**
 * Tip line: ` Tip: <body>` — italic, label in customMessageLabel (accent),
 * body in muted.
 */
export function tipLine(text) {
  return ' ' + italic(accent('Tip: ') + muted(text));
}

/** Standard "Error: …" line in the error color. */
export function errorLine(msg) {
  return errorT(`Error: ${msg}`);
}

/** One-line header for a tool execution card: `<token> bold(text)`. */
export function cardHeader(text, token = 'bashMode') {
  return paint(token, bold(text));
}
