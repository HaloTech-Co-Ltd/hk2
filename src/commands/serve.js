/**
 * serve mode: legacy interactive REPL (no agent loop, no tools).
 *
 * KB and LLM client are loaded once and reused across commands, avoiding the
 * ~1.5s load overhead per query.
 *
 * Supported commands:
 *   code [--enable-queryrewrite] [--verbose] <query>
 *   principle [--enable-queryrewrite] [--force] [--verbose] <query>
 *   principle save                                    Save the last principle answer
 *   impl [--enable-queryrewrite] [--verbose] <query>
 *   quit | exit
 *
 * State:
 *   state.lastPrinciple = null | { query, rewrite, topics, symbols, answer }
 */
import readline from 'node:readline';
import { resolveDefaultModel } from '../../lib/config/home.js';
import { parseArgs } from '../cli.js';
import { searchCode } from './search.js';
import { explain } from './explain.js';
import { createSavedAnswer } from '../../lib/store/saved_answer_store.js';
import { resolveKbName } from '../kb_name.js';

export async function serve() {
  const cfg = await resolveDefaultModel();
  if (!cfg) {
    console.error('No default model configured. Use /model add + /model set-default, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.');
    process.exit(2);
  }
  const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
  const { LLMClient } = await import('../../lib/llm/client.js');

  const kbName = await resolveKbName();
  const t0 = Date.now();
  const rt = await getRuntime(kbName);
  const llm = new LLMClient(cfg);
  const loadMs = Date.now() - t0;

  const state = { lastPrinciple: null, kbName };

  console.error(`[serve mode] KB=${kbName} loaded (${loadMs}ms, ${rt.bm.N} symbols, ${rt.knowledgeBySpace?.holy?.length || 0} holy, ${rt.knowledgeBySpace?.eden?.length || 0} eden)`);
  console.error('Commands: code / principle / impl / principle save / quit. Ctrl+D to exit.');

  const isInteractive = !!process.stdin.isTTY;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: 'hk2> ',
    terminal: isInteractive,
  });

  if (isInteractive) rl.prompt();
  for await (const line of rl) {
    const cmd = parseServeCommand(line);
    if (!cmd) { if (!rl.closed) rl.prompt(); continue; }
    try {
      if (cmd.command === 'quit' || cmd.command === 'exit') {
        break;
      }
      if (cmd.command === 'code') {
        if (!cmd.query) {
          console.error('Usage: code [--enable-queryrewrite] [--verbose] <query>');
        } else {
          await searchCode(cmd.query, { enableRewrite: cmd.enableRewrite, rt, llm });
        }
      } else if (cmd.command === 'principle') {
        if (!cmd.query) {
          console.error('Usage: principle [--enable-queryrewrite] [--force] [--verbose] <query>');
          console.error('      principle save');
        } else {
          const result = await explain(cmd.query, {
            mode: 'principle',
            enableRewrite: cmd.enableRewrite,
            force: cmd.force,
            verbose: cmd.verbose,
            rt, llm,
          });
          state.lastPrinciple = result.cached ? null : result;
        }
      } else if (cmd.command === 'save') {
        await savePrinciple(state);
      } else if (cmd.command === 'impl') {
        if (!cmd.query) {
          console.error('Usage: impl [--enable-queryrewrite] [--verbose] <query>');
        } else {
          await explain(cmd.query, {
            mode: 'impl',
            enableRewrite: cmd.enableRewrite,
            force: false,
            verbose: cmd.verbose,
            rt, llm,
          });
        }
      } else {
        console.error(`Unknown command: ${cmd.raw || line}`);
        console.error('Available: code / principle / impl / principle save / quit');
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      if (process.env.HK2_DEBUG) console.error(err.stack);
    }
    if (!rl.closed) rl.prompt();
  }

  if (!rl.closed) rl.close();
  if (isInteractive) console.error('\nGoodbye');
  process.exit(0);
}

/**
 * Parse one REPL line.
 *
 * Format:
 *   <command> [--flag ...] [--key value ...] <positional query>
 *
 * Special: `principle save` has no query, positional is empty.
 */
function parseServeCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  const cmd = tokens[0];
  const rest = tokens.slice(1);

  if (cmd === 'quit' || cmd === 'exit') {
    return { command: 'quit', raw: trimmed };
  }

  if (cmd === 'code' || cmd === 'impl') {
    const { flags, positional } = parseArgs(rest);
    return {
      command: cmd,
      enableRewrite: !!flags['enable-queryrewrite'],
      verbose: !!flags.verbose,
      query: positional.join(' ').trim(),
      raw: trimmed,
    };
  }

  if (cmd === 'principle') {
    if (rest.length === 1 && rest[0] === 'save') {
      return { command: 'save', raw: trimmed };
    }
    const { flags, positional } = parseArgs(rest);
    if (positional.length === 1 && positional[0] === 'save' && !flags['enable-queryrewrite'] && !flags.force && !flags.verbose) {
      return { command: 'save', raw: trimmed };
    }
    return {
      command: 'principle',
      enableRewrite: !!flags['enable-queryrewrite'],
      force: !!flags.force,
      verbose: !!flags.verbose,
      query: positional.join(' ').trim(),
      raw: trimmed,
    };
  }

  return { command: 'unknown', raw: trimmed };
}

async function savePrinciple(state) {
  if (!state.lastPrinciple) {
    console.error('No principle answer to save (only freshly-generated answers in this session can be saved; cached hits are already saved)');
    return;
  }
  const p = state.lastPrinciple;
  const rec = await createSavedAnswer(state.kbName, {
    mode: 'principle',
    query: p.query,
    rewrite: p.rewrite,
    topics: p.topics,
    symbols: p.symbols,
    answer: p.answer,
  });
  console.log(`[saved to KB: ${rec.id}]`);
  state.lastPrinciple = null;
}
