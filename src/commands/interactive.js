/**
 * interactive mode (default): agent REPL.
 *
 * Boot flow:
 *   1. ensureHome (~/.hk2 ready)
 *   2. Load current project (warn if none)
 *   3. Load KB (warn if not built)
 *   4. Resolve default model config → LLMClient
 *   5. Enter REPL: one line per interaction
 *        - Lines starting with / → slash dispatch
 *        - Otherwise → agent loop (streaming + tool calls + KB graph)
 *
 * Reload: project / model / KB changes flag a reload; next prompt redraws state.
 */
import readline from 'node:readline';
import { ensureHome, getCurrentProject, resolveDefaultModel } from '../../lib/config/home.js';
import { getRuntime, dropRuntime } from '../../lib/retrieval/kb_runtime.js';
import { LLMClient } from '../../lib/llm/client.js';
import { buildTools, KbFirstGuard } from '../../lib/agent/tools.js';
import { runLoop } from '../../lib/agent/loop.js';
import { buildSystemPrompt } from '../../lib/agent/system_prompt.js';
import { buildRequestGraph, renderRequestGraph } from '../../lib/agent/graph.js';
import { dispatchSlash } from '../slash/index.js';
import { getKbMeta } from '../../lib/index/registry.js';
import { ProgressIndicator } from '../progress.js';
import Transcript from '../../lib/agent/transcript.js';
import { StatusBar } from '../../lib/agent/statusbar.js';
import { PasteHandler } from '../../lib/agent/paste.js';
import * as style from '../../lib/agent/style.js';
import { renderLogo } from '../../lib/agent/logo.js';
import { MarkdownStream } from '../../lib/agent/markdown.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { exists } from '../../lib/util/fs_atomic.js';

export async function interactive(opts = {}) {
  await ensureHome();

  const session = {
    project: null,
    kbMeta: null,
    rt: null,
    llm: null,
    modelCfg: null,
    transcript: null,
    messages: [],
    lastAnswer: null,
    reloadFlags: { project: false, kb: false, model: false },
    rl: null,
    exiting: false,
    multilineBuf: null,
    queue: [],
    processing: false,
    exitResolve: null,
    consumeNext: null,
    startedAt: new Date().toISOString(),
    toolCallCount: 0,
    bashSearchCommands: [],
    // Token usage. Three scopes:
    //   callIn / callOut       — LATEST single LLM call's tokens (running max
    //                            within the call; used as the accumulation
    //                            input for the two broader scopes)
    //   loopIn / loopOut       — current loop (= one user prompt = one
    //                            runAgentTurn / runLoop) total. DISPLAYED in
    //                            the bottom status bar.
    //   cumIn / cumOut         — cumulative across the whole session (logged)
    //   cacheRead / cacheCreation — prompt-cache stats (logged only)
    // callIn/callOut are reset at the start of each LLM stream call via
    // onTurnStart (which fires per-call inside the agent loop); the previous
    // call's values are committed to loopIn/loopOut and cumIn/cumOut first.
    // loopIn/loopOut are reset at the start of each user prompt.
    tokens: { callIn: 0, callOut: 0, loopIn: 0, loopOut: 0, loopPeakIn: 0, loopPeakOut: 0, cumIn: 0, cumOut: 0, cacheRead: 0, cacheCreation: 0 },
    // Persistent status bar — pinned to the bottom of the terminal
    statusBar: null,
    phase: 'idle',     // current phase string for the status bar
    turnStart: 0,      // epoch ms of current turn start (for elapsed display)
    // Per-turn KB-first guardrail — tracks whether the agent used KB tools
    // this turn, so we can nudge it away from bash-grep / source-read when
    // the KB has what it needs.
    kbGuard: new KbFirstGuard(),
  };

  const ctx = buildCtx(session);

  await reloadAll(session, ctx);

  const isInteractive = !!process.stdin.isTTY || opts.forceTty;
  session.rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: promptFor(session),
    terminal: isInteractive,
    completer: makeCompleter(),
  });

  // Bracketed paste support: detect multi-line pastes and submit them as a
  // single '\n'-joined message instead of one agent turn per pasted line.
  // Only meaningful in TTY mode; non-TTY (piped) input is unaffected.
  const paste = new PasteHandler(process.stderr, session.rl.input, session.rl);
  session.paste = paste;

  // Persistent bottom status bar (only in TTY mode)
  session.statusBar = new StatusBar(process.stderr, {
    formatter: () => formatStatusLine(session),
  });
  if (session.statusBar.isEnabled()) {
    // Clear the visible screen so the previous session's last lines don't
    // bleed in around the welcome card on re-entry. Scrollback is preserved
    // (no \x1b[3J); the user can still scroll up to prior invocations.
    // Done BEFORE start() so the status bar's scroll region takes effect on
    // a clean viewport.
    process.stderr.write('\x1b[H\x1b[2J');
    session.statusBar.start();
    // Refresh every 500ms while running — keeps elapsed-time display fresh
    session.statusBar.poll(500);
    // Restore terminal if Node crashes or user kills the process
    const restoreOnce = () => { session.statusBar?.stop(); };
    process.once('exit', restoreOnce);
    process.once('SIGINT', () => { restoreOnce(); process.exit(130); });
    process.once('SIGTERM', () => { restoreOnce(); process.exit(143); });
  }

  printBanner(session, ctx);

  const enqueue = async (line) => {
    session.queue.push(line);
    if (session.processing) return;
    session.processing = true;
    try {
      while (session.queue.length > 0 && !session.exiting) {
        const l = session.queue.shift();
        await processLine(l, session, ctx);
        if (session.reloadFlags.project || session.reloadFlags.kb || session.reloadFlags.model) {
          await reloadAll(session, ctx, session.reloadFlags);
          session.reloadFlags = { project: false, kb: false, model: false };
        }
      }
    } finally {
      session.processing = false;
    }
    if (session.exiting) {
      session.exitResolve?.();
      return;
    }
    if (!session.rl.closed) {
      session.rl.setPrompt(promptFor(session));
      session.rl.prompt();
      session.statusBar?.update();
    }
  };

  // Enable bracketed paste AFTER the banner so the enable sequence isn't
  // visually interleaved with it. onFlush submits the buffered paste as one
  // '\n'-joined message once the terminal sends the paste-end marker.
  paste.onFlush = (text) => { void enqueue(text); };
  paste.start();

  if (isInteractive) session.rl.prompt();
  session.rl.on('line', (line) => {
    // If we're mid-paste, buffer the line and wait for paste-end. Pasted
    // content otherwise arrives as one 'line' event per line and each would
    // fire as a separate agent turn.
    if (paste.bufferIfPasting(line)) return;
    if (session.consumeNext) {
      const cb = session.consumeNext;
      session.consumeNext = null;
      cb(line);
      return;
    }
    void enqueue(line);
  });
  session.rl.on('close', () => {
    if (!session.processing) session.exitResolve?.();
  });

  await new Promise((resolve) => { session.exitResolve = resolve; });

  paste.stop();
  session.statusBar?.stop();
  if (!session.rl.closed) session.rl.close();
  if (isInteractive) console.error('Goodbye');
  process.exit(0);
}

/* ------------------------------------------------------------------ */

function buildCtx(session) {
  return {
    print: (text) => console.error(text),
    confirm: async (promptText) => {
      if (!session.rl) return false;
      return await new Promise((resolve) => {
        process.stderr.write(promptText);
        session.consumeNext = (ans) => {
          resolve(/^[yj](es)?$/i.test((ans || '').trim()));
        };
      });
    },
    get lastAnswer() { return session.lastAnswer; },
    get llm() { return session.llm; },
    get modelCfg() { return session.modelCfg; },
    get rt() { return session.rt; },
    /** Set the status-bar phase string and refresh the bar. */
    setPhase: (p) => {
      session.phase = p;
      if (!session.turnStart) session.turnStart = Date.now();
      session.statusBar?.update();
    },
    /**
     * Stream from the LLM with status-bar tracking. Wraps ctx.llm.stream()
     * so that usage events update session.tokens and the status bar refreshes.
     * Use this in slash commands that make LLM calls (e.g. /kb knowledge init).
     *
     * A slash-command stream is treated as its own loop: callIn/callOut and
     * loopIn/loopOut both reset at start. loopIn/loopOut are delta-updated on
     * each usage event so the bar shows running totals mid-stream (not just
     * after the stream ends).
     */
    streamLLM: async function* (messages, opts = {}) {
      if (!session.llm) throw new Error('No LLM configured');
      // Reset per-call AND per-loop token counters for this stream.
      session.tokens.callIn = 0;
      session.tokens.callOut = 0;
      session.tokens.loopIn = 0;
      session.tokens.loopOut = 0;
      session.tokens.loopPeakIn = 0;
      session.tokens.loopPeakOut = 0;
      session.statusBar?.update();
      for await (const evt of session.llm.stream(messages, opts)) {
        if (evt.type === 'usage') {
          if (typeof evt.input === 'number' && evt.input > 0 && evt.input > session.tokens.callIn) {
            // Delta-update loop so the bar reflects the in-flight call.
            session.tokens.loopIn += evt.input - session.tokens.callIn;
            session.tokens.callIn = evt.input;
            // Peak across the loop = max single-call input. This is what
            // the context window actually constrains, so the % in the bar
            // can't exceed 100% unless the provider accepted >window tokens.
            if (session.tokens.callIn > session.tokens.loopPeakIn) {
              session.tokens.loopPeakIn = session.tokens.callIn;
            }
          }
          if (typeof evt.output === 'number' && evt.output > 0 && evt.output > session.tokens.callOut) {
            session.tokens.loopOut += evt.output - session.tokens.callOut;
            session.tokens.callOut = evt.output;
            if (session.tokens.callOut > session.tokens.loopPeakOut) {
              session.tokens.loopPeakOut = session.tokens.callOut;
            }
          }
          session.statusBar?.update();
        }
        yield evt;
      }
      // Commit this stream's call maxima to the cumulative session totals.
      session.tokens.cumIn += session.tokens.callIn;
      session.tokens.cumOut += session.tokens.callOut;
    },
    noteReloadModels: () => { session.reloadFlags.model = true; },
    noteReloadProject: () => { session.reloadFlags.project = true; session.reloadFlags.kb = true; },
    noteReloadKb: () => { session.reloadFlags.kb = true; },
    clearConversation: () => {
      session.messages = [];
      session.lastAnswer = null;
    },
    newSession: async () => {
      const oldProject = session.project;
      session.transcript = null;
      session.messages = [];
      session.lastAnswer = null;
      session.toolCallCount = 0;
      if (oldProject) {
        session.transcript = new Transcript(oldProject.id);
        await session.transcript.logMeta('start', { pid: process.pid, cwd: process.cwd(), reason: 'new-session' });
      }
    },
    resumeSession: async (sessionId) => {
      if (!session.project) return false;
      const t = new Transcript(session.project.id, sessionId);
      const p = t.path;
      if (!await exists(p)) return false;
      session.transcript = t;
      session.messages = [];
      session.lastAnswer = null;
      // Replay: simple — re-read the JSONL and rebuild messages[] minimally
      const text = await fs.readFile(p, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'user') session.messages.push({ role: 'user', content: evt.text });
        else if (evt.type === 'assistant') session.messages.push({ role: 'assistant', content: evt.text });
      }
      return true;
    },
    getSessionInfo: () => {
      const info = {
        sessionId: session.transcript?.sessionId,
        projectId: session.project?.id,
        projectName: session.project?.name,
        startedAt: session.startedAt,
        messageCount: session.messages.filter(m => m.role === 'user' || m.role === 'assistant').length,
        toolCalls: session.toolCallCount,
        path: session.transcript?.path,
      };
      return info;
    },
    compactConversation: async () => {
      const out = await compactMessages(session);
      if (out == null) {
        console.error(`(nothing to compact yet)`);
        return;
      }
      session.messages = out.messages;
      await session.transcript?.logMeta('compact', { dropped: out.dropped, kept: out.kept });
      console.error(`Compacted: dropped ${out.dropped} messages, kept ${out.kept}.`);
    },
    exit: () => { session.exiting = true; },
  };
}

async function reloadAll(session, ctx, flags = { project: true, kb: true, model: true }) {
  if (flags.project) {
    session.project = await getCurrentProject();
    if (session.project && session.project.sourcePath) {
      process.env.HK2_PROJECT_SOURCE = session.project.sourcePath;
    }
    if (session.project && !session.transcript) {
      session.transcript = new Transcript(session.project.id);
      await session.transcript.logMeta('start', { pid: process.pid, cwd: process.cwd() });
    }
    session.kbMeta = session.project ? await getKbMeta(session.project.id) : null;
  }
  if (flags.kb) {
    if (session.project) {
      session.kbMeta = await getKbMeta(session.project.id);
      if (session.kbMeta) {
        try { session.rt = await getRuntime(session.project.id); }
        catch (err) { session.rt = null; console.error(`[warn] KB load failed: ${err.message}`); }
      } else {
        session.rt = null;
      }
    } else {
      session.rt = null;
    }
  }
  if (flags.model) {
    const cfg = await resolveDefaultModel();
    if (cfg) {
      session.modelCfg = cfg;
      session.llm = new LLMClient(cfg);
    } else {
      session.llm = null;
    }
  }
}

function promptFor(session) {
  // Colored prompt. Compact; live state lives in the status bar.
  const projTag = session.project ? style.accent(session.project.name) : style.dim('no-project');
  const kbTag = kbBrief(session);
  const modelTag = session.modelCfg ? style.muted(session.modelCfg.ref.split('/').pop()) : style.warning('no-model');
  const sep = style.dim('|');
  return `${style.dim('hk2')}(${projTag}${sep}${kbTag}${sep}${modelTag})${style.accent('>')} `;
}

/**
 * Compact one-line KB summary for prompt / status bar / welcome card.
 * Returns a styled string showing per-space entry counts, e.g.
 *   "Eden/147 Holy/1"  (KB loaded, with entries)
 *   "Eden/0 Holy/0"    (KB loaded, empty)
 *   "no-kb"            (no runtime)
 *
 * Always returns a styled string so callers can splice it inline.
 */
function kbBrief(session) {
  if (!session.rt) return style.warning('no-kb');
  const ks = session.rt.knowledgeBySpace || { holy: [], eden: [] };
  const eden = String(ks.eden?.length ?? 0);
  const holy = String(ks.holy?.length ?? 0);
  return `${style.dim('Eden/')}${style.muted(eden)} ${style.dim('Holy/')}${style.muted(holy)}`;
}

/**
 * Persistent bottom status bar contents.
 *
 * Format: `<phase> │ <proj>|<kb>|<model> │ ↑1.4k ↓120 0.1%/1.0M │ <elapsed>`
 *
 * Token numbers (↑↓ and the %) are aggregated across the current loop = the
 * user prompt currently being processed. They are NOT the latest single LLM
 * call's numbers — a multi-step task with N tool-call rounds shows the sum
 * across all N calls.
 */
function formatStatusLine(session) {
  const projTag = session.project ? style.accent(session.project.name) : style.dim('no-project');
  const kbTag = kbBrief(session);
  const modelTag = session.modelCfg ? style.muted(session.modelCfg.ref.split('/').pop()) : style.warning('no-model');
  const usage = formatUsage(session.tokens, session.modelCfg?.maxChars || 0);
  const phase = session.phase || 'idle';
  const sep = style.dim(style.BOX.vertical);
  let line = `${style.accent(phase)} ${sep} ${projTag} ${style.dim('|')} ${kbTag} ${style.dim('|')} ${modelTag} ${sep} ${usage}`;
  if (session.turnStart > 0) {
    const secs = ((Date.now() - session.turnStart) / 1000).toFixed(1);
    line += ` ${sep} ${style.muted(secs + 's')} ${style.dim(style.ICON.dot)} ${style.italic(style.dim('esc to interrupt'))}`;
  }
  return line;
}

/**
 * Format token usage as a status bar segment:
 *   ↑1.4k ↓120 0.1%/1.0M
 *   ↑ peak single-call input in this loop (= peak context size)
 *   ↓ peak single-call output in this loop (= largest response so far)
 *   0.1%  = peak input / context window (real context-fill, can't exceed
 *           100% unless the provider actually accepted >window tokens)
 *   1.0M  = context window size from model config
 *
 * "Peak" rather than "sum" because each LLM call's input already includes
 * the full prior context — summing inputs across calls double-counts the
 * shared prefix and produces a number that has no real meaning. Peak input
 * represents the most context a single call consumed, which is what the
 * window actually constrains.
 */
function formatUsage(tokens, contextWindow) {
  const tin = tokens?.loopPeakIn ?? tokens?.callIn ?? 0;
  const tout = tokens?.loopPeakOut ?? tokens?.callOut ?? 0;
  const pct = contextWindow > 0 ? (tin / contextWindow) * 100 : 0;
  const pctStr = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
  return `${style.accent(style.ICON.up + fmtTok(tin))} ${style.success(style.ICON.down + fmtTok(tout))} ${style.muted(pctStr + '%/' + fmtTok(contextWindow))}`;
}

function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n || 0);
}

function safeParseArgs(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

/**
 * Card width for tool-call cards. Tool cards always span the full terminal
 * width so their borders fill the screen edge-to-edge; bodyLine() truncates
 * any content that would overflow. (The welcome banner keeps its own 96-col
 * cap in printBanner, so this only affects bash/read/write/edit/find/etc.)
 */
function cardWidthFor(lines, title) {
  return style.termWidth();
}

/**
 * Build the header line for a tool-call card. Shows the most meaningful single
 * argument (the bash command, the read path, the find pattern, etc.) so the
 * user can see at a glance what the call actually does — matches the
 * per-tool renderers used by the styled output.
 */
function toolHeader(name, args, token) {
  const preview = (s) => s && s.length > 110 ? s.slice(0, 110) + '…' : (s || '');
  switch (name) {
    case 'bash':
      return `${style.success('$')} ${style.muted(preview(args.command))}`;
    case 'read':
      return `${style.cardHeader('read', token)} ${style.accent(preview(args.path))}`;
    case 'write':
      return `${style.cardHeader('write', token)} ${style.accent(preview(args.path))} ${style.dim('(' + (args.content?.length || 0) + ' bytes)')}`;
    case 'edit':
      return `${style.cardHeader('edit', token)} ${style.accent(preview(args.path))}`;
    case 'find':
      return `${style.cardHeader('find', token)} ${style.accent(preview(args.pattern))}`;
    case 'grep':
      return `${style.cardHeader('grep', token)} ${style.accent(preview(args.pattern))}`;
    case 'kb_search':
      return `${style.cardHeader('kb_search', token)} ${style.muted(preview(args.query))}`;
    case 'kb_symbol':
      return `${style.cardHeader('kb_symbol', token)} ${style.accent(preview(args.name))}`;
    case 'kb_neighbors':
    case 'kb_callchain':
    case 'kb_refs':
      return `${style.cardHeader(name, token)} ${style.muted(preview(args.symbol_id))}`;
    case 'kb_class':
      return `${style.cardHeader('kb_class', token)} ${style.accent(preview(args.name || args.qual_name))}`;
    case 'kb_knowledge':
    case 'kb_search_knowledge':
      return `${style.cardHeader(name, token)} ${style.muted(preview(args.id || args.query))}`;
    default:
      return `${style.cardHeader(name, token)}`;
  }
}

function printBanner(session, ctx) {
  // Welcome card — rounded border with title in the top edge.
  const projTag = session.project ? session.project.name : style.warning('no project');
  const kbTag = kbBrief(session);
  // Trim the model ref to its last segment so "provider/model-id" doesn't
  // push the Project/KB/Model row past the card width. Matches prompt and
  // status bar behaviour.
  const modelTag = session.modelCfg
    ? session.modelCfg.ref.split('/').pop()
    : style.warning('no-model');
  // Cap at 96 cols (was 72) so the Project/KB/Model row has breathing room
  // once KB shows Eden/N Holy/N. Still shrinks to term width on narrow
  // terminals and floors at 40 so the logo + tagline stay readable.
  const width = Math.min(96, Math.max(40, style.termWidth()));
  // Logo + tagline on the first rows; the ASCII art is rendered through the
  // active palette so it stays readable on any theme.
  const logoRows = renderLogo(style);
  const tagline = [
    style.bold(style.accent('hk2')) + ' ' + style.muted('— KB-driven coding agent'),
    '',
    style.dim('interactive REPL · per-project KB'),
    '',
    style.italic(style.dim('esc to interrupt')),
  ];
  // Pair logo rows with tagline rows (left logo, right tagline).
  const headerRows = [];
  for (let i = 0; i < logoRows.length; i++) {
    const logo = logoRows[i];
    const tag = tagline[i] || '';
    headerRows.push(`${logo}  ${tag}`);
  }
  const lines = [
    ...headerRows,
    '',
    `${style.accent('Project:')} ${style.muted(projTag)}   ${style.accent('KB:')} ${kbTag}   ${style.accent('Model:')} ${style.muted(modelTag)}`,
    '',
    `${style.dim('/help')} ${style.muted('commands')}  ${style.dim('/quit')} ${style.muted('exit')}  ${style.dim('\\\\')} ${style.muted('multi-line')}`,
  ];
  for (const ln of style.card({ title: 'hk2', lines, width, token: 'border' })) {
    ctx.print(ln);
  }
  ctx.print('');
  if (!session.project) {
    ctx.print(`${style.warning('⚠ No current project.')}`);
    ctx.print(`  Register: ${style.accent('/project init --name=... --source=... --source-root=...')}`);
    ctx.print(`  Switch:   ${style.accent('/project set current <id|name>')}`);
    ctx.print('');
  } else if (!session.rt) {
    ctx.print(`${style.warning('⚠ No KB for')} ${style.muted(`"${session.project.name}"`)}`);
    ctx.print(`  ${style.accent('/kb init')}`);
    ctx.print('');
  }
  if (!session.modelCfg) {
    ctx.print(`${style.warning('⚠ No default model configured.')}`);
    ctx.print(`  ${style.accent('/model add <provider> <model-id> --api-key=... --base-url=...')}`);
    ctx.print(`  ${style.accent('/model use <provider>/<model-id>')}`);
    ctx.print('');
  }
}

function makeCompleter() {
  const cmds = ['/model', '/project', '/kb', '/session', '/help', '/quit', '/exit', '/clear', '/compact',
    '/model list', '/model add', '/model use', '/model del', '/model show',
    '/project init', '/project list', '/project set', '/project show',
    '/kb init', '/kb update', '/kb status', '/kb search', '/kb save-answer',
    '/session info', '/session list', '/session new', '/session resume'];
  return function completer(line) {
    const hits = cmds.filter(c => c.startsWith(line));
    return [hits.length ? hits : cmds, line];
  };
}

/* ------------------------------------------------------------------ */

async function processLine(line, session, ctx) {
  if (session.multilineBuf !== null) {
    if (line.trim() === '') {
      const full = session.multilineBuf;
      session.multilineBuf = null;
      await handleLine(full, session, ctx);
    } else {
      session.multilineBuf += '\n' + line;
      session.rl.setPrompt('... ');
      session.rl.prompt();
    }
    return;
  }
  if (line.trim().endsWith('\\') && !line.trim().startsWith('/')) {
    session.multilineBuf = line.trim().slice(0, -1);
    session.rl.setPrompt('... ');
    session.rl.prompt();
    return;
  }
  await handleLine(line, session, ctx);
}

async function handleLine(line, session, ctx) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const handled = await dispatchSlash(line, ctx);
  if (handled) {
    // Reset status-bar state so the elapsed timer stops ticking and the phase
    // returns to idle. Slash commands use ctx.setPhase() during execution
    // (which sets turnStart); without this reset the bar keeps counting after
    // the command finishes. runAgentTurn does the same reset on its own exit
    // path; slash commands bypass that path.
    session.phase = 'idle';
    session.turnStart = 0;
    session.statusBar?.update();
    return;
  }

  if (!session.llm) {
    ctx.print(`No default model configured. Use /model add + /model use before chatting.`);
    return;
  }
  if (!session.rt) {
    ctx.print(`KB not loaded. Run /kb init or /project set current <project-with-KB>.`);
    return;
  }

  await runAgentTurn(trimmed, session, ctx);
}

async function runAgentTurn(userText, session, ctx) {
  const progress = new ProgressIndicator();
  session.turnStart = Date.now();
  const setPhase = (p) => {
    session.phase = p;
    session.statusBar?.update();
  };

  // ESC-to-interrupt: while a turn is running, pressing ESC aborts the
  // in-flight LLM stream (runLoop checks the signal at the top of each turn
  // and inside the stream loop, and forwards it to the provider fetch). Only
  // wired in TTY mode, where readline keypress events are available.
  const abortCtrl = new AbortController();
  const onKeypress = (_str, key) => {
    if (key && key.name === 'escape' && !abortCtrl.signal.aborted) {
      abortCtrl.abort(new Error('interrupted by user (ESC)'));
    }
  };
  const rlInput = session.rl?.input;
  const canInterrupt = !!(rlInput && session.rl?.terminal);
  if (canInterrupt) {
    readline.emitKeypressEvents(rlInput);  // idempotent; readline already set this up
    rlInput.on('keypress', onKeypress);
  }

  progress.start('retrieving KB');
  setPhase('retrieving KB');

  // LLM query rewrite (HK2_ENABLE_QUERYREWRITE, default 1).
  // Rewrites natural-language user query to English function names + keywords
  // so BM25 retrieves sharper results.
  const enableRewrite = envFlag('HK2_ENABLE_QUERYREWRITE', 1);
  let rewrite = null;
  if (enableRewrite && session.llm) {
    progress.nextPhase('rewriting query');
    setPhase('rewriting query');
    try {
      const { rewriteQuery } = await import('../../lib/retrieval/rewrite_query.js');
      rewrite = await rewriteQuery(session.llm, userText, { timeoutMs: 15000 });
      await session.transcript?.logMeta('rewrite', {
        intent: rewrite.intent,
        functionNames: rewrite.functionNames,
        keywords: rewrite.keywords,
        rewrittenQuery: rewrite.rewrittenQuery,
        fallback: rewrite.fallback,
      });
    } catch (err) {
      progress.done();
      ctx.print(`[warn] query rewrite failed, using raw query: ${err.message}`);
      rewrite = null;
    }
  }

  let graphText = '';
  let graphSummary = '';
  try {
    const graph = await buildRequestGraph(session.rt, userText, {
      maxChars: session.modelCfg.maxChars || 65536,
      project: session.project,
      retrievalQuery: rewrite && !rewrite.fallback ? rewrite.rewrittenQuery : userText,
      rewrite,
    });
    graphSummary = graph.summary;
    graphText = renderRequestGraph(graph, { maxChars: Math.floor((session.modelCfg.maxChars || 65536) / 2) });
    await session.transcript?.logMeta('graph', { summary: graph.summary });
  } catch (err) {
    progress.done();
    ctx.print(`[warn] knowledge graph build failed: ${err.message}`);
    graphText = '';
  }

  const tools = buildTools(session.rt, {
    allowWrite: true,
    llm: session.llm,
    projectId: session.project?.id,
    guard: session.kbGuard,
  });

  if (session.messages.length === 0) {
    const sysPrompt = buildSystemPrompt({
      project: session.project,
      tools,
      cwd: process.cwd(),
      graphText,
    });
    session.messages.push({ role: 'system', content: sysPrompt });
    await session.transcript?.logSystemPrompt(sysPrompt);
  } else {
    session.messages.push({
      role: 'system',
      content: `## Knowledge-base context for this turn (query="${userText}")\nHits: ${graphSummary}\n\n${graphText}`,
    });
  }

  // Track KB-first-policy violations: when the agent uses bash to grep/find/cat
  // source files, that's a signal the KB didn't have what it needed and we
  // should suggest a KB update at end of turn.
  session.bashSearchCommands = [];
  // Reset per-loop AND per-call token counters; cumulative session totals
  // (cumIn/cumOut) stay in session.tokens. callIn/callOut will also be reset
  // on every onTurnStart (per LLM call) after being committed to loopIn/loopOut.
  session.tokens.callIn = 0;
  session.tokens.callOut = 0;
  session.tokens.loopIn = 0;
  session.tokens.loopOut = 0;
  session.tokens.loopPeakIn = 0;
  session.tokens.loopPeakOut = 0;

  session.messages.push({ role: 'user', content: userText });
  await session.transcript?.logUser(userText);

  progress.nextPhase('waiting for model');
  setPhase('waiting for model');

  let assistantText = '';
  // Per-LLM-call markdown renderer. Streams line-by-line styling so the
  // user sees formatted output (headings, lists, code blocks) as it
  // arrives instead of raw `##` / `**bold**` source.
  let mdStream = new MarkdownStream();
  const flushMarkdown = () => {
    if (!mdStream) return '';
    const out = mdStream.flush();
    return out;
  };
  const callbacks = {
    onTurnStart: (_turnIdx) => {
      // Each LLM stream call inside the agent loop starts a new "turn".
      // Commit the previous call's per-call maxima to the cumulative session
      // total, then reset callIn/callOut. loopIn/loopOut are NOT touched
      // here: they're delta-updated in onUsage so the bar always reflects
      // the running loop total, including the in-flight call.
      if (_turnIdx > 1) {
        session.tokens.cumIn += session.tokens.callIn;
        session.tokens.cumOut += session.tokens.callOut;
      }
      session.tokens.callIn = 0;
      session.tokens.callOut = 0;
      // Reset the KB-first guardrail so each call gets a fresh "haven't used KB yet" check.
      session.kbGuard?.reset();
      // Fresh markdown renderer for the new LLM call.
      mdStream = new MarkdownStream();
      session.statusBar?.update();
    },
    onDelta: (text) => {
      progress.tick(text);
      // Style the delta through the markdown stream; raw text still
      // accumulates into assistantText for the transcript.
      const rendered = mdStream ? mdStream.feed(text) : text;
      if (rendered) process.stdout.write(rendered);
      assistantText += text;
      if (session.phase !== 'streaming') setPhase('streaming');
      else session.statusBar?.update();
    },
    onReasoning: () => {
      if (session.phase !== 'thinking') setPhase('thinking');
    },
    onUsage: (u) => {
      // Usage events from the LLM client are cumulative-within-call snapshots
      // (the client wrapper emits progressive estimates + real provider values
      // using max() semantics). For callIn/callOut we take the running max.
      // For loopIn/loopOut we delta-update on each event so the bar shows the
      // running loop total mid-call — without this, the bar would lag one
      // full LLM call behind (and read 0 during the first call of the loop).
      // loopPeakIn/loopPeakOut track the max single-call value across the
      // loop — what the status-bar % is computed from, since context-window
      // fill is per-call, not summed.
      // cumIn/cumOut are committed at call boundaries (onTurnStart + post-loop).
      if (typeof u.input === 'number' && u.input > 0 && u.input > session.tokens.callIn) {
        session.tokens.loopIn += u.input - session.tokens.callIn;
        session.tokens.callIn = u.input;
        if (session.tokens.callIn > session.tokens.loopPeakIn) {
          session.tokens.loopPeakIn = session.tokens.callIn;
        }
      }
      if (typeof u.output === 'number' && u.output > 0 && u.output > session.tokens.callOut) {
        session.tokens.loopOut += u.output - session.tokens.callOut;
        session.tokens.callOut = u.output;
        if (session.tokens.callOut > session.tokens.loopPeakOut) {
          session.tokens.loopPeakOut = session.tokens.callOut;
        }
      }
      session.statusBar?.update();
    },
    onToolCallStart: (call) => {
      // Stream ended for this LLM call. Flush any partial markdown line so
      // the trailing text renders before the tool card opens.
      const flushed = flushMarkdown();
      if (flushed) process.stdout.write(flushed);
      setPhase(`tool: ${call.name}`);
      // Open the card: top border with the tool name as title + header line.
      // Default width matches the welcome bar so all cards line up visually;
      // onToolCallEnd may grow the card further if the body needs more room
      // (it redraws the top via ANSI cursor-up so the borders stay aligned).
      const args = typeof call.arguments === 'string' ? safeParseArgs(call.arguments) : (call.arguments || {});
      const token = call.name === 'bash' ? 'bashMode'
        : call.name.startsWith('kb_') ? 'accent'
        : 'border';
      const header = toolHeader(call.name, args, token);
      const w = cardWidthFor([header], call.name);
      process.stderr.write('\n');
      process.stderr.write(style.topBorder(call.name, { width: w, token }) + '\n');
      process.stderr.write(style.bodyLine(header, { width: w, token }) + '\n');
    },
    onToolCallEnd: (call, result) => {
      setPhase('waiting for model');
      session.toolCallCount++;
      const args = typeof call.arguments === 'string' ? safeParseArgs(call.arguments) : (call.arguments || {});
      const token = call.name === 'bash' ? 'bashMode'
        : call.name.startsWith('kb_') ? 'accent'
        : 'border';
      const header = toolHeader(call.name, args, token);
      const previewText = JSON.stringify(result.ok ? result.result : { error: result.error });
      // Render up to 6 body lines so big tool results don't drown the turn.
      const maxLines = 6;
      const bodyLines = [];
      const chunks = previewText.split('\\n');
      const joined = chunks.slice(0, maxLines);
      for (const ln of joined) {
        const truncated = ln.length > 200 ? ln.slice(0, 200) + '…' : ln;
        bodyLines.push(style.dim(truncated));
      }
      if (chunks.length > maxLines) {
        bodyLines.push(style.dim(`… ${chunks.length - maxLines} more lines`));
      }
      const statusLine = result.ok
        ? `${style.success(style.ICON.ok)} ${style.dim('ok')}`
        : `${style.errorT(style.ICON.err)} ${style.errorT('failed')}`;
      bodyLines.push(statusLine);
      // Pick the final width from the FULL body (header + every body line).
      const w = cardWidthFor([header, ...bodyLines], call.name);
      const startW = cardWidthFor([header], call.name);
      if (w > startW) {
        // Body needs more width than the top predicted. Move cursor back up
        // to the top border (2 lines: top + header), clear to end of screen,
        // and redraw the whole card at the wider width so the borders match
        // and no body character is truncated.
        process.stderr.write('\x1b[2A\x1b[J');
        process.stderr.write(style.topBorder(call.name, { width: w, token }) + '\n');
        process.stderr.write(style.bodyLine(header, { width: w, token }) + '\n');
      }
      // When w === startW the top + header from onToolCallStart are still
      // valid; just append the body and bottom border at the same width.
      for (const ln of bodyLines) {
        process.stderr.write(style.bodyLine(ln, { width: w, token }) + '\n');
      }
      process.stderr.write(style.bottomBorder({ width: w, token }) + '\n');
      session.transcript?.logToolCall(call, result);
      // Record bash search-like commands for end-of-turn KB update suggestion
      if (call.name === 'bash') {
        try {
          const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments;
          if (args && typeof args.command === 'string' && session.kbGuard?._isBashSearch(args.command)) {
            session.bashSearchCommands.push(args.command);
          }
        } catch { /* ignore */ }
      }
    },
  };

  try {
    const result = await runLoop({
      llm: session.llm,
      messages: session.messages,
      tools,
      callbacks,
      signal: abortCtrl.signal,
      llmOpts: {
        maxChars: session.modelCfg.maxChars,
        temperature: session.modelCfg.temperature,
        enableReasoning: session.modelCfg.enableReasoning,
      },
      // No fixed maxTurns — the loop runs until the task is done, with
      // stuck-detection (identical-repeat / no-progress) and a high
      // absolute safety cap as backstops. See lib/agent/loop.js.
    });

    // Final flush of the markdown renderer in case the last LLM call left a
    // trailing partial line (no terminating newline). Renders it before the
    // closing blank line so the layout stays clean.
    const finalFlush = flushMarkdown();
    if (finalFlush) process.stdout.write(finalFlush);

    process.stdout.write('\n');
    progress.done();

    // Commit the final LLM call's per-call maxima into the cumulative session
    // totals. (onTurnStart commits every call except the last, since the loop
    // ends after the last call returns no tool_calls.) loopIn/loopOut already
    // include the final call via the delta-update in onUsage — no commit here.
    session.tokens.cumIn += session.tokens.callIn;
    session.tokens.cumOut += session.tokens.callOut;

    // Status line — show usage for the WHOLE LOOP plus cumulative session totals.
    if (session.tokens.loopIn > 0 || session.tokens.loopOut > 0) {
      const usage = formatUsage(session.tokens, session.modelCfg?.maxChars || 0);
      process.stderr.write(`${style.success(style.ICON.ok + ' usage')} ${style.dim(style.ICON.dot)} ${usage}\n`);
      await session.transcript?.logMeta('usage', {
        loop: { in: session.tokens.loopIn, out: session.tokens.loopOut },
        cumulative: { in: session.tokens.cumIn, out: session.tokens.cumOut },
      });
    }

    session.lastAnswer = assistantText;
    await session.transcript?.logAssistant(assistantText);
    await session.transcript?.logTurn(result.turns, result.toolCalls);

    // End-of-turn KB update: if the agent fell back to bash-search at all,
    // the project source may have new files / the KB may be stale. Offer to
    // run an incremental update unless HK2_ENABLE_AUTO_UPDATEKB=1, in which
    // case update silently.
    await maybeOfferKbUpdate(session, ctx);

    session.phase = 'idle';
    session.turnStart = 0;
    session.statusBar?.update();
  } catch (err) {
    progress.done();
    if (abortCtrl.signal.aborted) {
      // User pressed ESC. Any partial assistant text was already streamed to
      // stdout; we don't record an incomplete assistant turn in the transcript.
      process.stderr.write(`\n${style.warning(style.ICON.warn + ' interrupted')}${style.dim(' — partial output preserved')}\n`);
      session.phase = 'idle';
    } else {
      process.stderr.write(`\n${style.errorLine(err.message)}\n`);
      if (process.env.HK2_DEBUG) process.stderr.write(err.stack + '\n');
      session.phase = 'error';
    }
    session.turnStart = 0;
    session.statusBar?.update();
  } finally {
    if (canInterrupt && rlInput) rlInput.off('keypress', onKeypress);
  }
}

/**
 * Naive context compaction: keep system + last N messages, summarize earlier
 * ones into a single system message via the LLM.
 *
 * Returns null if there are too few messages to compact.
 */
async function compactMessages(session) {
  const conversation = session.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (conversation.length < 6) return null;

  const keep = 4;   // keep the last 4 messages verbatim
  const toCompact = conversation.slice(0, conversation.length - keep);
  const kept = conversation.slice(conversation.length - keep);

  const summaryText = toCompact.map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n');

  // Build a fresh system message carrying the summary
  const newMessages = [];
  for (const m of session.messages) {
    if (m.role === 'user' || m.role === 'assistant') continue;
    newMessages.push(m);
  }
  newMessages.push({
    role: 'system',
    content: `## Prior conversation (compacted)\nThe following is a summary of the previous ${toCompact.length} messages. Treat it as background context.\n\n${summaryText.slice(0, 4000)}${summaryText.length > 4000 ? '...(truncated)' : ''}\n`,
  });
  for (const m of kept) newMessages.push(m);

  return { messages: newMessages, dropped: toCompact.length, kept: kept.length };
}

/**
 * Parse a 0/1 env flag. Returns defaultValue if unset; treats 0/no/false/off as false.
 */
function envFlag(name, defaultValue = 0) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return !!defaultValue;
  return /^(1|yes|true|on)$/i.test(v.trim());
}

// Note: bash search detection lives in lib/agent/tools.js's KbFirstGuard
// (_isBashSearch). interactive.js calls it via session.kbGuard for the
// end-of-turn KB-update suggestion.

/**
 * After a turn ends, if the agent used bash to grep/find/cat source files
 * (i.e. the KB didn't have what it needed), offer to update the three KB
 * spaces per their update policies:
 *
 *   Index Space  — auto with HK2_ENABLE_AUTOUPDATEKB=1; otherwise prompt y/N
 *   Eden Space   — auto with HK2_ENABLE_AUTO_LEARN=1;  otherwise prompt y/N
 *   Holy Space   — ALWAYS prompt y/N, regardless of env vars
 *
 * Why: Holy holds stable design knowledge; committing to it is a deliberate
 * user choice. Eden and Index can be auto-updated because their content is
 * either derivable (Index: re-derived from code) or transient (Eden: lists
 * that evolve with the codebase).
 */
async function maybeOfferKbUpdate(session, ctx) {
  if (!session.project) return;
  if (!session.bashSearchCommands || session.bashSearchCommands.length === 0) return;

  const autoUpdate = envFlag('HK2_ENABLE_AUTOUPDATEKB', 0);
  const autoLearn = envFlag('HK2_ENABLE_AUTO_LEARN', 0);

  ctx.print('');
  ctx.print(`[kb hint] The agent used bash to search source files ${session.bashSearchCommands.length} time(s) during this turn.`);
  ctx.print('          This usually means the KB was missing some knowledge the agent needed.');

  // 1. Index Space — re-index the code
  if (autoUpdate) {
    await runKbUpdate(session, ctx);
  } else {
    const ok = await ctx.confirm('Run /kb update now to refresh Index Space? (y/N) ');
    if (ok) await runKbUpdate(session, ctx);
    else ctx.print('[kb hint] Skipped Index Space refresh. Run /kb update manually when ready.');
  }

  // 2. Eden / Holy — ask the model to extract what it learned, then route
  //    to the right space based on stability. The model itself decides
  //    whether the learned content is "stable" (Holy) or "frequently-updated"
  //    (Eden). Per-space policy then applies:
  //      - Eden + HK2_ENABLE_AUTO_LEARN=1 → auto-commit
  //      - Eden + HK2_ENABLE_AUTO_LEARN=0 → prompt y/N
  //      - Holy → ALWAYS prompt y/N (even with auto-learn)
  await learnNewKnowledge(session, ctx, { autoLearn });

  session.bashSearchCommands = [];
}

async function runKbUpdate(session, ctx) {
  ctx.print('[kb update] refreshing Index Space (incremental re-index)...');
  try {
    const { buildIndex } = await import('../../lib/index/indexer.js');
    const { markKbBuilt } = await import('../../lib/config/home.js');
    const { dropRuntime } = await import('../../lib/retrieval/kb_runtime.js');
    const stats = await buildIndex(session.project.id, { full: false });
    await markKbBuilt(session.project.id);
    dropRuntime(session.project.id);
    ctx.print(`[kb update] done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.uniqueTokens} tokens, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
    ctx.noteReloadKb?.();
    return true;
  } catch (err) {
    ctx.print(`[kb update] failed: ${err.message}`);
    return false;
  }
}

/**
 * One-shot LLM call to extract a knowledge entry from the just-finished
 * conversation. The model itself decides whether the content belongs in
 * Holy Space (stable) or Eden Space (frequently-updated). Per-space policy
 * then decides whether to auto-commit or prompt the user.
 *
 * Holy ALWAYS prompts the user — even with HK2_ENABLE_AUTO_LEARN=1.
 */
async function learnNewKnowledge(session, ctx, { autoLearn }) {
  if (!session.llm) {
    ctx.print('[kb learn] no LLM available, skipping knowledge capture.');
    return;
  }
  const lastUser = [...session.messages].reverse().find(m => m.role === 'user');
  const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string');
  if (!lastUser || !lastAssistant) {
    ctx.print('[kb learn] no conversation to learn from, skipping.');
    return;
  }

  ctx.print('[kb learn] asking the model to summarize what it learned...');

  const sysPrompt = `You are extracting a reusable knowledge note from a completed coding task so future tasks on the same project can skip the discovery work.

The project KB has two knowledge spaces:
- "holy": stable knowledge that rarely changes (design principles, key algorithms, fundamental patterns). Examples: "how to write a PostgreSQL extension", "how the WAL replay loop works".
- "eden": frequently-updated knowledge (function lists, command catalogs, observed patterns that may evolve). Examples: "list of common SQL commands", "frequently-used utility functions".

Output STRICT JSON only — no markdown fences, no prose. Schema:
{
  "space": "holy" | "eden",
  "id": "kebab-case-id",
  "title": "human-readable title",
  "intro": "2-5 paragraphs of prose explaining the concept; include key API names and call patterns",
  "keyFiles": ["project-relative file paths"],
  "keySymbols": ["exact function/type names"],
  "keywords": ["english keywords for future search"]
}

Pick "holy" only for genuinely stable design knowledge. Pick "eden" for things that may evolve.
If the conversation did not produce any reusable knowledge (one-off fix, trivial), output: {"skip": true}`;

  const userPrompt = `Task that was just completed:
USER: ${typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)}

Bash search commands the agent used during this task (signaling KB gaps):
${session.bashSearchCommands.slice(0, 8).map(c => '- ' + c.split('\n')[0].slice(0, 200)).join('\n')}

Agent's final summary / explanation:
${(typeof lastAssistant.content === 'string' ? lastAssistant.content : '').slice(0, 4000)}`;

  let raw = '';
  for await (const evt of session.llm.stream(
    [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.1, maxChars: 8192, enableReasoning: false, timeoutMs: 60000 },
  )) {
    if (evt.type === 'delta') raw += evt.text;
  }

  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed || parsed.skip) {
    ctx.print('[kb learn] the model declined to save a knowledge entry (no reusable knowledge identified).');
    return;
  }

  const space = parsed.space === 'eden' ? 'eden' : 'holy';
  const id = String(parsed.id || 'learned').replace(/[^A-Za-z0-9_.-]/g, '_');
  const record = {
    id,
    space,
    title: parsed.title || 'Learned knowledge',
    intro: parsed.intro || '',
    keyFiles: Array.isArray(parsed.keyFiles) ? parsed.keyFiles : [],
    keySymbols: Array.isArray(parsed.keySymbols) ? parsed.keySymbols : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    autoLearned: true,
  };

  // Per-space policy
  let commit = false;
  if (space === 'holy') {
    // Holy ALWAYS prompts — even with HK2_ENABLE_AUTO_LEARN=1
    ctx.print('');
    ctx.print(`[kb learn] Model proposes HOLY entry "${id}": ${record.title}`);
    ctx.print(`  intro (preview): ${(record.intro || '').slice(0, 200)}${(record.intro || '').length > 200 ? '...' : ''}`);
    ctx.print(`  Note: Holy Space is the stable source of truth. Updates require explicit approval even with HK2_ENABLE_AUTO_LEARN=1.`);
    commit = await ctx.confirm(`Commit to Holy Space? (y/N) `);
  } else {
    // Eden: auto-commit if autoLearn, else prompt
    if (autoLearn) {
      commit = true;
    } else {
      ctx.print('');
      ctx.print(`[kb learn] Model proposes EDEN entry "${id}": ${record.title}`);
      ctx.print(`  intro (preview): ${(record.intro || '').slice(0, 200)}${(record.intro || '').length > 200 ? '...' : ''}`);
      commit = await ctx.confirm(`Commit to Eden Space? (y/N) `);
    }
  }

  if (!commit) {
    ctx.print('[kb learn] Cancelled. Nothing was written.');
    return;
  }

  // Persist
  const { writeKnowledge } = await import('../../lib/store/kb_store.js');
  const p = await writeKnowledge(session.project.id, space, record);
  // Reload into runtime so subsequent kb_knowledge / kb_search_knowledge sees it
  const { readKnowledge } = await import('../../lib/store/kb_store.js');
  const final = await readKnowledge(session.project.id, space, id);
  if (final) session.rt?.reloadKnowledge?.(final, space);

  ctx.print(`[kb learn] saved ${space} entry "${id}": ${record.title}`);
  ctx.print(`            path: ${p}`);
  await session.transcript?.logMeta('learned_knowledge', { id, space, title: record.title });
}


