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
