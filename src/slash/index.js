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
import { cmdSession } from './session.js';

export const SLASH_COMMANDS = [
  { name: '/model',   handler: cmdModel,   description: 'Manage models.json (list / use / set-default / set / add / del / show)' },
  { name: '/project', handler: cmdProject, description: 'Manage projects.json (init / list / set / show / drop)' },
  { name: '/kb',      handler: cmdKb,      description: 'Current project KB (init / update / status / search ...)' },
  { name: '/session', handler: cmdSession, description: 'Session management (info / new / clear / list / resume)' },
  { name: '/clear',   handler: cmdClear,   description: 'Clear the current conversation context' },
  { name: '/compact', handler: cmdCompact, description: 'Summarize prior conversation into a short brief' },
  { name: '/help',    handler: cmdHelp,    description: 'Show this help' },
  { name: '/quit',    handler: cmdQuit,    description: 'Exit (same as Ctrl+D)' },
  { name: '/exit',    handler: cmdQuit,    description: 'Exit (same as /quit)' },
];

async function cmdHelp(args, ctx) {
  ctx.print(`hk2 commands:`);
  for (const c of SLASH_COMMANDS) {
    ctx.print(`  ${c.name.padEnd(12)}  ${c.description}`);
  }
  ctx.print(``);
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
    ctx.print(`Unknown command: ${name} (type /help for the list)`);
    return true;
  }
  try {
    await cmd.handler(tokens.slice(1), ctx);
  } catch (err) {
    ctx.print(`Error: ${err.message}`);
    if (process.env.HK2_DEBUG) ctx.print(err.stack);
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

