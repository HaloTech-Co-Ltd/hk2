/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频，图表，界面设计，版面框架，有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. As expressly permitted in
 * your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * TUI chrome in the Claude Code layout language — pure string builders:
 *
 *   renderWelcome  — the rounded welcome card: logo + session facts on the
 *                    LEFT, a tips / getting-set-up panel on the RIGHT,
 *                    separated by a vertical rule (no ⚠ warning wall).
 *   renderInputChrome — the OPEN input area: a full-width horizontal rule
 *                    above and below the editable rows, `❯ ` prompt glyph
 *                    on the first row (continuation rows indent).
 *   renderFooter   — one line under the input rule: contextual key hint on
 *                    the left, model / phase chip on the right.
 *
 * All ANSI-aware padding goes through style.visibleWidth.
 */
import * as style from '../../lib/agent/style.js';
import { renderLogo } from '../../lib/agent/logo.js';
import { modelTagFor, kbBrief, formatUsage } from '../commands/status_format.js';
import { VERSION } from '../version.js';

/** Pad a (possibly ANSI-styled) string to `w` visible columns. */
function padTo(s, w) {
  const vis = style.visibleWidth(s);
  return vis >= w ? s : s + ' '.repeat(w - vis);
}

/** Truncate a (possibly styled) string to `w` visible columns, ANSI-safe. */
function cutTo(s, w) {
  return style.visibleWidth(s) <= w ? s : style.truncateVisible(s, w);
}

function homeTilde(p) {
  const cwd = p || process.cwd();
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

/* ------------------------------------------------------------------ */
/* Welcome card */

const TIPS = [
  '/ for commands — completion as you type',
  '\\ + enter — continue onto a new line',
  'esc — interrupt the running turn',
  '↑ / ↓ — input history',
];

function setupHints(session) {
  const hints = [];
  if (!session.project) {
    hints.push('/project init --name=<name> --source=<repo-path>');
  } else if (!session.rt) {
    hints.push('/kb init — build this project\'s knowledge base');
  }
  if (!session.modelCfg) {
    hints.push('/model add <provider> <model-id> --api-key=… --base-url=…');
    hints.push('/model set-default <provider>/<model-id>');
  }
  return hints;
}

/**
 * The welcome card. Left column: logo rows, the tagline, Project/KB/Model
 * facts, cwd. Right column: tips, and when setup is incomplete a
 * "Getting set up" section (instead of the REPL's ⚠ warning wall).
 */
export function renderWelcome(session, width = Math.min(style.termWidth(), 100)) {
  const w = Math.max(64, width);
  const leftW = 38;
  // Body rows render as `│ L │ R │` — borders(3) + padding(4) = 7 columns.
  const rightW = w - leftW - 7;
  const left = [];
  const right = [];

  // Claude Code's left-column shape: heading, centered logo, then the
  // session facts (project · KB / model / cwd) pinned to the bottom rows.
  left.push(padTo(style.bold('Welcome back!'), leftW));
  left.push('');
  const logoRows = renderLogo(style);
  for (const row of logoRows) left.push(padTo(row, leftW));
  left.push('');
  const proj = session.project ? style.accent(session.project.name) : style.warning('no project');
  left.push(padTo(`${proj} ${style.dim('·')} ${kbBrief(session)}`, leftW));
  left.push(padTo(session.modelCfg ? style.muted(modelTagFor(session)) : style.warning('no-model'), leftW));
  left.push(padTo(style.dim(homeTilde(session.project?.sourcePath || null)), leftW));

  right.push(style.bold('Tips for getting started'));
  right.push('');
  for (const t of TIPS) right.push(style.dim('  ') + style.muted(t));
  const hints = setupHints(session);
  if (hints.length > 0) {
    right.push('');
    right.push(style.bold('Getting set up'));
    right.push('');
    for (const h of hints) right.push(style.dim('  ') + style.muted(h));
  }

  const rows = Math.max(left.length, right.length);
  const lines = [style.topBorder(`hk2 v${VERSION}`, { width: w, token: 'border' })];
  for (let i = 0; i < rows; i++) {
    const l = padTo(cutTo(left[i] || '', leftW), leftW);
    const r = padTo(cutTo(right[i] || '', rightW), rightW);
    const v = style.paint('border', style.BOX.vertical);
    lines.push(`${v} ${l} ${v} ${r} ${v}`);
  }
  lines.push(style.bottomBorder({ width: w, token: 'border' }));
  return lines;
}

/* ------------------------------------------------------------------ */
/* Input chrome (open rules + ❯ prompt, the Claude Code shape) */

const PROMPT_GLYPH = style.HAS_UTF8 ? '❯' : '>';
const RULE = style.HAS_UTF8 ? style.BOX.horizontal : '-';

/** Full-width rule line. */
export function renderRule(width) {
  return style.dim(RULE.repeat(Math.max(4, width)));
}

/**
 * The input area: rule, editable rows (first row prefixed `❯ `, continuation
 * rows indented 2), rule. The cursor cell for the Frame: row is relative to
 * these lines (the first editable row is index 1), col is absolute.
 */
export function renderInputChrome(boxTextRows, placeholder, width) {
  const inner = Math.max(8, width - 2);
  const lines = [renderRule(width)];
  if (boxTextRows.length === 0) {
    lines.push(style.accent(PROMPT_GLYPH) + ' ' + style.italic(style.dim(placeholder || '')));
  } else {
    for (let i = 0; i < boxTextRows.length; i++) {
      const prefix = i === 0 ? style.accent(PROMPT_GLYPH) + ' ' : '  ';
      lines.push(cutTo(prefix + (boxTextRows[i] || ''), width));
    }
  }
  lines.push(renderRule(width));
  return lines;
}

/* ------------------------------------------------------------------ */
/* Footer */

function spinnerFrame() {
  return style.SPINNER[Math.floor(Date.now() / 120) % style.SPINNER.length];
}

/**
 * One footer line: contextual hint left, model / phase chip right.
 * `armed` shows Claude Code's exact double-press-to-exit wording.
 */
export function renderFooter(session, width, { armed = false, busy = false, queued = 0 } = {}) {
  let left;
  if (armed) {
    left = 'Press Ctrl-C again to exit';
  } else if (busy) {
    left = queued > 0 ? `esc to interrupt · queued: ${queued}` : 'esc to interrupt';
  } else {
    left = 'enter to send · / for commands';
  }
  const model = session.modelCfg ? modelTagFor(session) : 'no-model';
  let right;
  if (busy) {
    const phase = session.phase || 'working';
    const usage = formatUsage(session.tokens, session.modelCfg?.maxChars || 0);
    right = `${style.accent(spinnerFrame() + ' ' + phase)} ${style.dim(style.ICON.dot)} ${usage}`;
  } else {
    right = `${style.muted(model)} ${style.dim(style.ICON.dot)} ${style.dim('ready')}`;
  }
  const leftVis = style.visibleWidth(left);
  const rightVis = style.visibleWidth(right);
  const gap = Math.max(1, width - leftVis - rightVis - 2);
  if (leftVis + rightVis + 2 > width) {
    // Too narrow: drop the chip, keep the hint.
    return `  ${style.dim(cutTo(left, Math.max(8, width - 2)))}`;
  }
  return `  ${style.dim(left)}${' '.repeat(gap)}${right} `;
}
