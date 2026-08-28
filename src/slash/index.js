/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
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
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Slash command registry and dispatcher.
 *
 * Lines starting with / are routed here; other lines are passed as user
 * messages to the agent loop.
 *
 * ctx interface (constructed by interactive.js):
 *   - print(text)               general output
 *   - confirm(prompt) → boolean synchronous y/N confirmation
 *   - lastAnswer                last LLM text (for /kb save-answer)
 *   - noteReloadModels()        model config changed (persisted default)
 *   - setModel(cfg)             hot-swap active model for this session only
 *   - clearSessionModel()       drop session-only model override
 *   - modelCfg                  current resolved model config (read)
 *   - noteReloadProject()       project switched
 *   - noteReloadKb()            KB changed
 *   - clearConversation()       clear in-memory message transcript
 *   - newSession()              start a fresh session id
 *   - exit()                    request exit from REPL
 */
import { cmdModel } from './model.js';
import { cmdProject } from './project.js';
import { cmdKb } from './kb.js';
import { cmdSession, resumeDirect } from './session.js';
import { cmdReview } from './review.js';
import { cmdTheme } from './theme.js';
import { printCommandHelp, HELP_TEXT } from './help.js';
import { dynamicSlot, invalidateDynamicCache } from './completions.js';

export const SLASH_COMMANDS = [
  { name: '/model',   handler: cmdModel,   description: 'Manage models.json (list / use / set-default / set / add / del / show)' },
  { name: '/project', handler: cmdProject, description: 'Manage projects.json (init / list / set / show / drop)' },
  { name: '/kb',      handler: cmdKb,      description: 'Current project KB (init / update / status / search ...)' },
  { name: '/session', handler: cmdSession, description: 'Session management (info / new / clear / list / resume)' },
  { name: '/resume',   handler: resumeDirect, description: 'Resume a previous session (latest, or /resume <id>) — Claude Code convention' },
  { name: '/review',  handler: cmdReview,  description: 'Manually review the completed task (code) — fresh-eyes regression check' },
  { name: '/theme',   handler: cmdTheme,   description: 'Customize tool-card border colors (list / set / reset / preview / title-follow)' },
  { name: '/clear',   handler: cmdClear,   description: 'Clear the current conversation context' },
  { name: '/compact', handler: cmdCompact, description: 'Summarize prior conversation into a short brief' },
  { name: '/help',    handler: cmdHelp,    description: 'Show this help' },
  { name: '/quit',    handler: cmdQuit,    description: 'Exit (same as Ctrl+D)' },
  { name: '/exit',    handler: cmdQuit,    description: 'Exit (same as /quit)' },
];

async function cmdHelp(args, ctx) {
  // /help <command> → full usage + flags + examples for that one command.
  if (args.length > 0) {
    if (printCommandHelp(ctx, args[0])) return;
    ctx.print(`Unknown command: /${args[0]} (type /help for the list)`);
    return;
  }
  ctx.print(`hk2 commands (type /help <command> for detailed usage and parameters):`);
  for (const c of SLASH_COMMANDS) {
    ctx.print(`  ${c.name.padEnd(12)}  ${c.description}`);
  }
  ctx.print(``);
  ctx.print(`Deeper help:   /help kb | /kb help knowledge   /model types   /model help set-phase`);
  ctx.print(`Anything else = a message to the agent (the agent answers using KB context + tools).`);
  ctx.print(`Multi-line input: just paste multi-line text - it is submitted as one message.`);
  ctx.print(`  (Or end a line with \\ to continue manually, then submit with an empty line.)`);
}

async function cmdQuit(args, ctx) {
  ctx.exit?.();
}

async function cmdClear(args, ctx) {
  ctx.clearConversation?.();
  ctx.print(`Conversation context cleared. Session transcript preserved on disk.`);
}

async function cmdCompact(args, ctx) {
  await ctx.compactConversation?.();
}

/**
 * Dispatch a line:
 *   - starts with / → routed to a slash handler
 *   - otherwise returns false (caller treats it as agent input)
 *
 * @returns {Promise<boolean>} true = handled (slash); false = agent input
 */
export async function dispatchSlash(line, ctx) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return false;
  // Tokenize with shell-style quote support so flag values can contain spaces:
  //   /kb knowledge add --title="SPI Extension Pattern" --intro="..."
  // becomes ['kb', 'knowledge', 'add', '--title=SPI Extension Pattern', '--intro=...'].
  const tokens = tokenizeSlashLine(trimmed);
  const name = tokens[0];
  const cmd = SLASH_COMMANDS.find(c => c.name === name);
  if (!cmd) {
    ctx.print(`Unknown command: ${name} (type /help for the list, or /help <command> for details)`);
    return true;
  }
  try {
    await cmd.handler(tokens.slice(1), ctx);
  } catch (err) {
    ctx.print(`Error: ${err.message}`);
    if (process.env.HK2_DEBUG) ctx.print(err.stack);
  } finally {
    // Any slash command may have mutated the stores the dynamic completion
    // sources read (/model add, /project drop, /session new, ...). Drop the
    // TTL cache so the very next Tab sees fresh data.
    invalidateDynamicCache();
  }
  return true;
}

/**
 * Tokenize a slash command line with shell-style quote support.
 *
 * Splits on whitespace, but treats `"..."` and `'...'` as quoted spans whose
 * interior whitespace is preserved. Quotes are stripped. A backslash escapes
 * the next character (so `--title="she said \"hi\""` parses correctly).
 *
 * Unquoted `=` is preserved as part of the token (so `--key=value` stays one
 * token even when `value` is bare). For values containing spaces, wrap in
 * quotes: `--title="foo bar"`.
 */
function tokenizeSlashLine(s) {
  const out = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let hasToken = false;
  const flush = () => {
    if (hasToken || buf.length > 0) {
      out.push(buf);
      buf = '';
      hasToken = false;
    }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      buf += c;
      hasToken = true;
      escape = false;
      continue;
    }
    if (c === '\\' && !inSingle) {
      // Backslash escape (outside single quotes; preserves literal text in single quotes)
      escape = true;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      hasToken = true;  // a quoted token may be empty: ""
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      hasToken = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      flush();
      continue;
    }
    buf += c;
    hasToken = true;
  }
  if (escape) buf += '\\';   // trailing backslash literal
  flush();
  return out;
}


/* ------------------------------------------------------------------ */
/* Slash-command completion — derived, single source of truth.
 *
 * Everything offered by Tab completion (and later the TUI completion menu)
 * is DERIVED from what already exists: SLASH_COMMANDS for the top level and
 * the "Subcommands:" / "Phases:" sections of HELP_TEXT for the sub levels.
 * No hand-maintained list, so completions can never drift from the
 * registered commands again.
 */

/**
 * Parse a HELP_TEXT block's subcommand rows into [{name, description}].
 *
 * A subcommand row starts at column 2 (`  name <args>   description`);
 * deeper-indented lines are argument/description continuations of the
 * previous row and are skipped. The section runs from its header to the
 * first blank line. `help` is always supported (via subcommandHelp) even
 * when no explicit row exists, so it is appended synthetically.
 */
function helpSubcommands(key) {
  const lines = HELP_TEXT[key];
  if (!Array.isArray(lines)) return [];
  const out = [];
  let inSection = false;
  for (const ln of lines) {
    if (/^(Subcommands|Phases|Modes|Commands):/.test(ln)) { inSection = true; continue; }
    if (!inSection) continue;
    if (ln.trim() === '') break; // section ends at the first blank line
    const m = ln.match(/^  (\S+)\s*(.*)$/);
    if (m) out.push({ name: m[1], description: m[2] });
  }
  if (!out.some(s => s.name === 'help')) {
    out.push({ name: 'help', description: 'Show detailed usage' });
  }
  // Multiple rows can start with the same subcommand (e.g. "set-default" and
  // "set-default current"); keep the first per name so completion never
  // offers duplicates.
  const seen = new Set();
  return out.filter(s => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** Prefix tokens up to (excluding) the fragment, with trailing space. */
function prefixTo(tokens, upto) {
  return tokens.slice(0, upto).join(' ') + ' ';
}

/** HELP_TEXT keys that appear as a subcommand row of `key` (nested topics, e.g. kb → knowledge, code). */
function nestedTopics(key) {
  const subs = helpSubcommands(key);
  return Object.keys(HELP_TEXT).filter(t => t !== key && subs.some(s => s.name === t));
}

/**
 * Structured completions for the (partial) input `line`.
 *
 * @param {string} line
 * @param {object} [dyn] dynamic candidates keyed by data kind, each an array
 *   of {ref|id|name, desc} records from completions.js — see dynamicSlot.
 *   Omit for the legacy static-only behavior (dynamic argument positions
 *   then offer no items, exactly as before this parameter existed).
 * @returns {{items: Array<{label: string, description: string}>, replaceFrom: number}}
 *   items — candidate completions (label = full replacement text, e.g.
 *   "/kb knowledge learn"); replaceFrom — index in `line` where the label
 *   replaces from (the start of the token being completed).
 */
export function slashCompletions(line, dyn) {
  if (typeof line !== 'string' || !line.startsWith('/')) return { items: [], replaceFrom: 0 };
  const tokens = line.split(/\s+/);
  const fragment = tokens[tokens.length - 1] || '';
  const replaceFrom = line.length - fragment.length;

  if (tokens.length === 1) {
    return {
      items: SLASH_COMMANDS
        .filter(c => c.name.startsWith(fragment))
        .map(c => ({ label: c.name, description: c.description })),
      replaceFrom,
    };
  }
  // ---- dynamic argument positions (models / sessions / projects) ----
  // Before falling into the static nested-topic machinery, check whether
  // the cursor token is a DATA argument. When it is, the static helpers
  // would either invent subcommands (wrong) or return empty (the old
  // behavior); instead the injected `dyn` snapshot supplies the real
  // candidates. Pass no snapshot → keeps returning empty (legacy).
  const slot = dynamicSlot(tokens);
  if (slot) {
    const pool = dyn?.[slot.kind];
    if (!Array.isArray(pool)) return { items: [], replaceFrom };
    const prefix = tokens.slice(0, slot.index).join(' ') + ' ';
    // Matching: a fragment matches the full ref ('openai/gpt…') OR the bare
    // model id / session id after the slash ('gpt…') — users remember the
    // model name far more often than the provider prefix.
    const matches = (c) => {
      const token = String(c.ref ?? c.id ?? c.name ?? '');
      if (token.startsWith(fragment)) return true;
      if (slot.kind === 'models') {
        const slash = token.lastIndexOf('/');
        if (slash > 0 && token.slice(slash + 1).startsWith(fragment)) return true;
      }
      return false;
    };
    const items = pool
      .filter(matches)
      .map((c) => ({
        label: prefix + (c.ref ?? c.id ?? c.name),
        description: String(c.desc ?? ''),
      }));
    return { items, replaceFrom };
  }

  const family = tokens[0];
  const key = family.slice(1);
  if (tokens.length === 2) {
    const subs = helpSubcommands(key);
    if (key === '') {
      // Bare '/ ': Claude Code shows ALL top-level commands here.
      return {
        items: SLASH_COMMANDS
          .filter(c => c.name.startsWith('/' + fragment))
          .map(c => ({ label: c.name, description: c.description })),
        replaceFrom,
      };
    }
    if (!HELP_TEXT[key]) {
      // A registered command with no HELP_TEXT block (e.g. '/help '), or an
      // unknown family: no subcommands to offer — returning EMPTY keeps the
      // menu closed so Enter submits the typed command instead of silently
      // replacing it with the top-level list's first entry.
      return { items: [], replaceFrom };
    }
    const items = subs
      .filter(s => s.name.startsWith(fragment))
      .map(s => ({ label: `${family} ${s.name}`, description: s.description }));
    for (const topic of nestedTopics(key)) {
      if (topic.startsWith(fragment)) {
        const row = subs.find(s => s.name === topic);
        items.push({ label: `${family} ${topic}`, description: row ? row.description : '' });
      }
    }
    return { items, replaceFrom };
  }
  if (tokens.length === 3) {
    // /model set-phase --phase=<name> ...: complete the phase enum inline.
    // (The ref position is handled above via dynamicSlot.)
    if (family === '/model' && tokens[1] === 'set-phase' && fragment.startsWith('--phase=')) {
      const typed = fragment.slice('--phase='.length);
      return {
        items: ['rewrite-query', 'request-assess', 'plan-review', 'code-review']
          .filter((p) => p.startsWith(typed))
          .map((p) => ({ label: `${prefixTo(tokens, tokens.length - 1)}--phase=${p}`, description: 'agent phase' })),
        replaceFrom,
      };
    }
    const topic = tokens[1];
    if (HELP_TEXT[topic] && helpSubcommands(key).some(s => s.name === topic)) {
      return {
        items: helpSubcommands(topic)
          .filter(s => s.name.startsWith(fragment))
          .map(s => ({ label: `${family} ${topic} ${s.name}`, description: s.description })),
        replaceFrom,
      };
    }
  }
  return { items: [], replaceFrom: 0 };
}

/** Flat list of every completion label (commands + family subs + nested topic subs). */
export function allSlashCompletionLabels() {
  const labels = [];
  for (const c of SLASH_COMMANDS) {
    labels.push(c.name);
    const key = c.name.slice(1);
    for (const s of helpSubcommands(key)) labels.push(`${c.name} ${s.name}`);
    for (const topic of nestedTopics(key)) {
      for (const s of helpSubcommands(topic)) labels.push(`${c.name} ${topic} ${s.name}`);
    }
  }
  return labels;
}
