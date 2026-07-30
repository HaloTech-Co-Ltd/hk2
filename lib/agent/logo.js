/**
 * ASCII-art logo for hk2's welcome banner.
 *
 * Hand-authored to roughly mirror logo.jpg: a layered, interlocking-ring
 * emblem. Each rune is paired with a color token (see lib/agent/style.js)
 * so the logo picks up the active palette automatically.
 *
 * Compact (5 rows × ~16 cols) so the welcome card stays tight.
 */

/** Map each rune used in LOGO_ROWS to a style token. Spaces stay plain. */
const TOKEN_BY_RUNE = {
  '█': 'accent',     // outer ring — electric blue
  '▓': 'warning',    // middle ring — amber (the original is red; amber keeps contrast on dark bg)
  '▒': 'bashMode',   // inner band — green
  '░': 'dim',        // soft fill
  '·': 'muted',      // dot accents
  '●': 'success',    // center focal point
};

const LOGO_ROWS = [
  '   ██████████████   ',
  '  ██▓▓▒▒▒▒▒▒▒▒▓▓██  ',
  ' ██▓▓▒▒░●░░░●▒▒▒▓▓██ ',
  '  ██▓▓▒▒▒▒▒▒▒▒▓▓██  ',
  '   ██████████████   ',
];

/**
 * Render the logo, themed via lib/agent/style.js.
 * @param {import('./style.js')} style  the style module (passed in to avoid a circular import)
 * @returns {string[]}  one styled string per row
 */
export function renderLogo(style) {
  return LOGO_ROWS.map(row => {
    let out = '';
    for (const ch of row) {
      if (ch === ' ') { out += ' '; continue; }
      const token = TOKEN_BY_RUNE[ch];
      out += token ? style.paint(token, ch) : ch;
    }
    return out;
  });
}

export const LOGO_WIDTH = Math.max(...LOGO_ROWS.map(r => r.length));
export const LOGO_HEIGHT = LOGO_ROWS.length;
