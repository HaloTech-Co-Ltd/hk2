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
 * /kb command family — lifecycle and queries for the current session project's KB.
 *
 * Three-space model (update behavior is per write path):
 *   Holy Space   — stable knowledge. Agent-proposed writes confirm; explicit
 *                  user commands (/kb knowledge add --space=holy) are the
 *                  user's own intent; DOC learn --space=holy prompts once per
 *                  run (merges/overwrites of existing entries confirm per entry).
 *   Eden Space   — frequently-updated knowledge. Agent kb_save_knowledge
 *                  auto-writes under HK2_ENABLE_AUTO_LEARN; parser-owned
 *                  doc:<relpath> entries are synced by /kb init and /kb update.
 *   Index Space  — code index + per-space indexes + callgraph. Explicit
 *                  init/update run immediately; the end-of-turn auto update
 *                  is gated on HK2_ENABLE_AUTOUPDATEKB.
 *
 * Usage:
 *   /kb init [--full]                  Build KB for the current session project (full re-index)
 *   /kb update                         Incremental re-index + parser-owned doc: Eden sync
 *   /kb status                         Show KB statistics (counts per space)
 *   /kb search <query> [--top-k=N]     Search symbols in the KB (Index Space)
 *   /kb symbol <name>                  Look up symbol by name
 *   /kb neighbors <symbol_id>          Call-graph neighbors
 *   /kb knowledge list [--space=holy|eden]   List knowledge entries
 *   /kb knowledge show <id>                  Show full entry (any space)
 *   /kb knowledge del <id>                   Delete entry (requires confirmation)
 *   /kb transform <id> <from> <to>     Move entry between Holy and Eden (requires confirmation)
 *   /kb drop                           Delete the KB (requires confirmation)
 *
 * Commands use the current session's project. A --project/--project-id pin
 * is session-local; without a pin, the shared projects.json current pointer is used.
 */
import path from 'node:path';
import { getCurrentProject, markKbBuilt } from '../../lib/config/home.js';
import { getRuntime, dropRuntime } from '../../lib/retrieval/kb_runtime.js';
import { buildIndex } from '../../lib/index/indexer.js';
import { addKbForProject, getKbMeta } from '../../lib/index/registry.js';
import {
  readStats, listKnowledge, readKnowledge, deleteKnowledge, moveKnowledge,
  writeKnowledge, rebuildKnowledgeIndex, kbDir,
} from '../../lib/store/kb_store.js';
import {
  SUPREME_CODE_ID, SUPREME_CODE_MAX_ITEMS, isSupremeCode,
  readSupremeCode, writeSupremeCode, ensureSupremeCode,
  planCodeAdd, planCodeDel, parseCodeItemId, validateOneCodeItem,
} from '../../lib/store/supreme_code.js';
import { renderHelp, printCommandHelp, subcommandHelp } from './help.js';

/** Topics under '/kb knowledge help <topic>' that map to a whole family's
 *  help entry rather than one subcommand block (e.g. 'knowledge' itself). */
const HELP_SUBCOMMAND_TOPICS = ['knowledge', 'kb'];
import fs from 'node:fs/promises';

export async function cmdKb(args, ctx) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'init': case 'build': return initKb(rest, ctx);
    case 'update': return updateKb(rest, ctx);
    case 'status': return statusKb(ctx);
    case 'search': return searchKb(rest, ctx);
    case 'symbol': return symbolKb(rest, ctx);
    case 'neighbors': return neighborsKb(rest, ctx);
    case 'knowledge': return knowledgeKb(rest, ctx);
    case 'code': case 'supreme': return codeKb(rest, ctx);
    case 'transform': return transformKb(rest, ctx);
    case 'drop': return dropKb(ctx);
    case 'help': case '?': case undefined:
      // '/kb help knowledge' drills into the knowledge sub-family.
      if (sub !== undefined && rest[0]) {
        if (printCommandHelp(ctx, rest[0])) return;
        ctx.print(`Unknown /kb help topic: ${rest[0]} (try: knowledge)`);
        return;
      }
      printCommandHelp(ctx, 'kb');
      return;
    default:
      ctx.print(`Unknown /kb subcommand: ${sub}`);
      printCommandHelp(ctx, 'kb');
  }
}

async function getProjectOrFail(ctx) {
  // Prefer the session-pinned project (ctx.getCurrentProject) over the shared
  // global current pointer, so parallel `hk2 --project=` sessions don't
  // cross-resolve onto each other's project. Falls back to the legacy import
  // when the host doesn't supply ctx.getCurrentProject (e.g. serve / one-shot).
  const getter = ctx.getCurrentProject || (() => getCurrentProject());
  const p = await getter.call(ctx);
  if (!p) {
    ctx.print(`No current project. Run /project init or /project set current <id> first.`);
    return null;
  }
  return p;
}

async function initKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const flags = parseFlags(rest);
  const full = flags.full !== false;
  const checkpointInterval = flags['checkpoint-interval']
    ? parseInt(flags['checkpoint-interval'], 10)
    : (parseInt(process.env.HK2_KB_CHECKPOINT_INTERVAL, 10) || 100);
  const resume = flags.resume !== false && flags['no-resume'] === undefined;
  const checkpoint = flags['no-checkpoint'] === undefined;
  const skipSummary = flags['skip-summary'] !== undefined;

  ctx.print(`[kb init] project=${p.name}  source=${p.sourcePath}`);
  if (p.sourceRoot) ctx.print(`           sourceRoot=${p.sourceRoot}`);
  ctx.print(`           kb dir=${kbDir(p.id)}/`);
  ctx.print(`           checkpoint: ${checkpoint ? `every ${checkpointInterval} files, resume=${resume}` : 'disabled'}`);
  ctx.print(`           summary:    ${skipSummary ? 'skipped' : 'attempted when an LLM is available; each non-empty successful result is written independently'}`);

  await addKbForProject(p);
  const stats = await buildIndex(p.id, {
    full,
    checkpointInterval,
    resume,
    checkpoint,
    skipSummary,
    llm: ctx.llm,
    streamLLM: ctx.streamLLM,
    onProgress: ({ done, total, file }) => {
      const isCpHint = file && String(file).startsWith('[checkpoint');
      const isCpResume = file && String(file).startsWith('[resuming');
      if (isCpHint || isCpResume || done % 25 === 0 || done === total) {
        ctx.print(`  [${done}/${total}] ${file || ''}`);
      }
    },
    onSummaryProgress: (which) => {
      ctx.print(`  [summary] generating ${which}...`);
    },
  });
  await markKbBuilt(p.id);
  dropRuntime(p.id);
  const docsN = stats.totalDocs || 0;
  const gn = stats.graphNodes || 0;
  const ge = stats.graphEdges || {};
  ctx.print(`done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${docsN} docs, ${gn} graph nodes, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
  if (ge.calls || ge.imports || ge.contains) {
    ctx.print(`      graph edges: calls=${ge.calls || 0} imports=${ge.imports || 0} inherits=${ge.inherits || 0} contains=${ge.contains || 0}`);
  }
  ctx.print(`      tokens: ${stats.uniqueTokens} unique`);
  ctx.noteReloadKb?.();
}

async function updateKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const meta = await getKbMeta(p.id);
  if (!meta) {
    ctx.print(`KB not initialized. Run /kb init first.`);
    return;
  }
  ctx.print(`[kb update] source: ${meta.sourcePath}`);
  if (meta.sourceRoot) ctx.print(`           sourceRoot: ${meta.sourceRoot}`);

  // Legacy-KB upgrade check: snapshot knowledge first, then attempt migration
  // before the incremental re-index. Disk, permission, or process failures can
  // still leave a partial state; this is not a crash-safe transaction.
  let full = false;
  try {
    const { migrateKb } = await import('../../lib/store/kb_migrate.js');
    const migration = await migrateKb(p.id);
    if (migration.error) {
      ctx.print(`[kb update] upgrade aborted: ${migration.error}`);
      return;
    }
    if (migration.needed) {
      ctx.print(`[kb update] legacy KB detected — upgrading to the current layout:`);
      for (const it of migration.items) ctx.print(`  - ${it.id}: ${it.reason}`);
      for (const line of migration.performed || []) ctx.print(`  + ${line}`);
      if (migration.backupDir) ctx.print(`  + knowledge snapshot: ${migration.backupDir}`);
      full = !!migration.fullRebuild;
      if (full) ctx.print(`  + parser format changed — full re-index will follow`);
    }
  } catch (err) {
    ctx.print(`[kb update] upgrade check failed (continuing with normal update): ${err.message}`);
  }

  const stats = await buildIndex(p.id, {
    full,
    skipSummary: true,
    onProgress: ({ done, total, file }) => {
      if (done % 25 === 0 || done === total) {
        ctx.print(`  [${done}/${total}] ${file || ''}`);
      }
    },
  });
  await markKbBuilt(p.id);
  dropRuntime(p.id);
  ctx.print(`done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
  ctx.noteReloadKb?.();
}

async function statusKb(ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const meta = await getKbMeta(p.id);
  if (!meta) {
    ctx.print(`KB not initialized. Run /kb init.`);
    return;
  }
  const stats = await readStats(p.id);
  // The permanent supreme-code entry — self-heal when missing (projects
  // initialized before the feature), then report its item count.
  let supremeCount = 0;
  try {
    await ensureSupremeCode(p.id, { createdVia: 'kb-status-selfheal' });
    const sc = await readSupremeCode(p.id);
    supremeCount = sc ? sc.codes.length : 0;
  } catch { /* non-fatal for status display */ }
  const [holyCount, edenCount] = await Promise.all([
    listKnowledge(p.id, 'holy').then(l => l.length).catch(() => 0),
    listKnowledge(p.id, 'eden').then(l => l.length).catch(() => 0),
  ]);
  ctx.print(`project: ${p.name} (${p.id})`);
  ctx.print(`  source:       ${meta.sourcePath}`);
  ctx.print(`  sourceRoot:   ${meta.sourceRoot || '(none)'}`);
  ctx.print(`  kb dir:       ${kbDir(p.id)}/`);
  ctx.print(`  updatedAt:    ${meta.updatedAt || '?'}`);
  ctx.print(``);
  ctx.print(`  Holy Space:   ${holyCount} entr${holyCount === 1 ? 'y' : 'ies'} (stable; updates require approval)`);
  ctx.print(`  Supreme Code: ${supremeCount}/${SUPREME_CODE_MAX_ITEMS} item(s) — /kb code add|del (${SUPREME_CODE_ID})`);
  ctx.print(`  Eden Space:   ${edenCount} entr${edenCount === 1 ? 'y' : 'ies'} (frequently-updated)`);
  ctx.print(`  Index Space:`);
  if (stats) {
    ctx.print(`    totalFiles:   ${stats.totalFiles}`);
    ctx.print(`    totalSymbols: ${stats.totalSymbols}`);
    if (stats.totalDocs) ctx.print(`    totalDocs:    ${stats.totalDocs}`);
    if (stats.docLinks || stats.docTables || stats.docSymbolMentions) {
      ctx.print(`    docGraph:     docs=${stats.totalDocs || 0} links=${stats.docLinks || 0} tables=${stats.docTables || 0} symbolMentions=${stats.docSymbolMentions || 0}`);
    }
    ctx.print(`    uniqueTokens: ${stats.uniqueTokens}`);
    ctx.print(`    avgdl:        ${(stats.avgdl || 0).toFixed(1)}`);
    if (stats.graphNodes) {
      const ge = stats.graphEdges || {};
      ctx.print(`    graphNodes:   ${stats.graphNodes}`);
      ctx.print(`    graphEdges:   calls=${ge.calls || 0} imports=${ge.imports || 0} inherits=${ge.inherits || 0} contains=${ge.contains || 0}`);
    }
    ctx.print(`    buildMs:      ${stats.buildDurationMs || '?'}`);
    ctx.print(`    parserVer:    ${stats.parserVersion || '?'}`);
  }
}

async function fetchRt(ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return null;
  const meta = await getKbMeta(p.id);
  if (!meta) {
    ctx.print(`KB not initialized. Run /kb init.`);
    return null;
  }
  return { p, rt: await getRuntime(p.id) };
}

async function searchKb(rest, ctx) {
  const flags = parseFlags(rest);
  const query = flags.positionalText;
  if (!query) { ctx.print(`Usage: /kb search <query>`); return; }
  const got = await fetchRt(ctx);
  if (!got) return;
  const { rt } = got;
  const { codeSearch } = await import('../../lib/retrieval/code_search.js');
  const topK = parseInt(flags['top-k'], 10) || 20;
  const results = codeSearch(rt, query, { topK });
  if (results.length === 0) {
    ctx.print(`(no results)`);
    return;
  }
  ctx.print(`${results.length} result(s) for query="${query}"`);
  for (const r of results) {
    ctx.print(`  ${r.name} [${r.kind}]  ${r.filePath}:${r.lineStart}  score=${r.score.toFixed(2)}`);
    if (r.signature) ctx.print(`    ${r.signature}`);
  }
}

async function symbolKb(rest, ctx) {
  const name = rest[0];
  if (!name) { ctx.print(`Usage: /kb symbol <name>`); return; }
  const got = await fetchRt(ctx);
  if (!got) return;
  const { rt } = got;
  const syms = rt.getSymbolsByName(name) || [];
  if (syms.length === 0) {
    ctx.print(`(not found: ${name})`);
    return;
  }
  for (const s of syms) {
    ctx.print(`  ${s.name} [${s.kind}]  ${rt.getFilePath(s.fileId)}:${s.lineStart}-${s.lineEnd}`);
    if (s.signature) ctx.print(`    ${s.signature}`);
  }
}

async function neighborsKb(rest, ctx) {
  const id = rest[0];
  if (!id) { ctx.print(`Usage: /kb neighbors <symbol_id>`); return; }
  const got = await fetchRt(ctx);
  if (!got) return;
  const { rt } = got;
  const cg = rt.callgraph?.byId || {};
  const edges = cg[id] || [];
  if (edges.length === 0) {
    ctx.print(`(no neighbors or unknown symbol_id: ${id})`);
    return;
  }
  ctx.print(`${edges.length} neighbor(s):`);
  for (const nid of edges) {
    const s = rt.getSymbolById(nid);
    if (!s) continue;
    ctx.print(`  ${s.name} [${s.kind}]  ${rt.getFilePath(s.fileId)}:${s.lineStart}`);
  }
}

async function knowledgeKb(rest, ctx) {
  const sub = rest[0];
  const subArgs = rest.slice(1);
  switch (sub) {
    case 'list': case 'ls': return knowledgeListKb(subArgs, ctx);
    case 'show': case 'get': return knowledgeShowKb(subArgs, ctx);
    case 'add': case 'create': case 'set': return knowledgeAddKb(subArgs, ctx);
    case 'learn': case 'study': case 'init': case 'bootstrap': case 'scan':
      // 'init'/'bootstrap'/'scan' are legacy aliases of the merged learn
      // command; they map to whole-project CODE mode (no --file/--base-dir).
      return knowledgeLearnKb(subArgs, ctx);
    case 'housekeep': case 'housekeeping': case 'cleanup': case 'clean': return knowledgeCleanupKb(subArgs, ctx);
    case 'empty': case 'clear': case 'wipe': return knowledgeEmptyKb(subArgs, ctx);
    case 'export': return knowledgeExportKb(subArgs, ctx);
    case 'import': return knowledgeImportKb(subArgs, ctx);
    case 'del': case 'rm': return knowledgeDelKb(subArgs, ctx);
    case 'help': case '?': case undefined:
      // '/kb knowledge help learn' (and per-subcommand topics like 'add')
      if (sub !== undefined && subArgs[0]) {
        const topic = subArgs[0];
        if (HELP_SUBCOMMAND_TOPICS.includes(topic)) {   // whole-family help
          printCommandHelp(ctx, topic);
          return;
        }
        const lines = subcommandHelp('knowledge', topic);
        if (lines) {
          for (const l of lines) ctx.print(l);
          return;
        }
        ctx.print(`Unknown /kb knowledge topic: ${topic}`);
        ctx.print(`Type /kb knowledge help for the full list.`);
        return;
      }
      printCommandHelp(ctx, 'knowledge');
      return;
    default:
      ctx.print(`Unknown /kb knowledge subcommand: ${sub}`);
      printCommandHelp(ctx, 'knowledge');
  }
}

/**
 * /kb knowledge add — manually persist a knowledge entry.
 *
 * Usage:
 *   /kb knowledge add [--space=holy|eden] [--id=<id>] --title=<title>
 *                     [--intro=<text> | --intro-file=<path>]
 *                     [--key-files=<comma-sep>] [--key-symbols=<comma-sep>]
 *                     [--keywords=<comma-sep>]
 *
 * Defaults:
 *   --space   holy (use /kb transform to move to eden later)
 *   --id      derived from title (kebab-case slug) if omitted
 *   --intro   required, either inline or via --intro-file
 *
 * Examples:
 *   /kb knowledge add --title="SPI Extension Pattern" --intro="Use PGXS; ..."
 *   /kb knowledge add --space=eden --id=sql-cmds --title="SQL Commands" \\
 *                     --intro-file=/tmp/sql.md --keywords=sql,commands
 *
 * Note: this is an explicit user-initiated write — no y/N prompt is needed
 * (the user typed the command). Holy Space's approval rule applies to
 * agent-proposed and automatic paths, not to direct user
 * commands. Use /kb knowledge del to remove if you make a mistake.
 */
async function knowledgeAddKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const flags = parseFlags(rest);

  const space = flags.space === 'eden' ? 'eden' : 'holy';
  let id = flags.id;
  const title = flags.title;
  if (!title) {
    ctx.print(`--title is required. Example:`);
    ctx.print(`  /kb knowledge add --title="SPI Extension Pattern" --intro="Use PGXS; ..."`);
    return;
  }

  // intro: inline or from file
  let intro = '';
  if (flags['intro-file']) {
    try { intro = await fs.readFile(flags['intro-file'], 'utf8'); }
    catch (err) { ctx.print(`Read --intro-file failed: ${err.message}`); return; }
  } else if (flags.intro) {
    intro = flags.intro;
  } else {
    ctx.print(`--intro or --intro-file is required.`);
    return;
  }

  // Auto-derive id from title if not provided
  if (!id) {
    id = String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!id) id = 'untitled';
  }
  if (isSupremeCode(id)) {
    ctx.print(`id "${SUPREME_CODE_ID}" is reserved for the permanent Supreme Code entry.`);
    ctx.print(`Manage its items with: /kb code add | /kb code del`);
    return;
  }

  // Parse comma-separated arrays
  const keyFiles = flags['key-files'] ? String(flags['key-files']).split(',').map(s => s.trim()).filter(Boolean) : [];
  const keySymbols = flags['key-symbols'] ? String(flags['key-symbols']).split(',').map(s => s.trim()).filter(Boolean) : [];
  const keywords = flags.keywords ? String(flags.keywords).split(',').map(s => s.trim()).filter(Boolean) : [];

  // Check for overwrite
  const existing = await readKnowledge(p.id, space, id).catch(() => null);
  if (existing) {
    ctx.print(`(warning) entry "${id}" already exists in ${space} — overwriting.`);
  }

  // Build record
  const record = {
    id,
    space,
    title,
    intro,
    keyFiles,
    keySymbols,
    keywords,
    manual: true,  // mark as user-authored (vs auto-learned)
  };

  // Preview before write
  ctx.print(``);
  ctx.print(`=== Saving ${space}/${id} ===`);
  ctx.print(`title: ${title}`);
  if (keyFiles.length) ctx.print(`keyFiles: ${keyFiles.join(', ')}`);
  if (keySymbols.length) ctx.print(`keySymbols: ${keySymbols.join(', ')}`);
  if (keywords.length) ctx.print(`keywords: ${keywords.join(', ')}`);
  ctx.print(`intro (${intro.length} chars): ${intro.slice(0, 200)}${intro.length > 200 ? '...' : ''}`);
  ctx.print(`=== end ===`);

  // Persist
  const { writeKnowledge } = await import('../../lib/store/kb_store.js');
  const path = await writeKnowledge(p.id, space, record);

  // Hot-reload into runtime
  const { readKnowledge: readK } = await import('../../lib/store/kb_store.js');
  const final = await readK(p.id, space, id);
  if (final) {
    // Refresh runtime cache if loaded
    const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
    const rt = await getRuntime(p.id).catch(() => null);
    rt?.reloadKnowledge?.(final, space);
  }

  ctx.print(``);
  ctx.print(`Saved "${id}" to ${space} space.`);
  ctx.print(`  path: ${path}`);
}

async function knowledgeListKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const flags = parseFlags(rest);
  const spaceFilter = flags.space;
  const spaces = spaceFilter ? [spaceFilter] : ['holy', 'eden'];
  let total = 0;
  for (const space of spaces) {
    const list = await listKnowledge(p.id, space).catch(() => []);
    // Pin the permanent supreme-code entry to the top of the Holy list. It is
    // the project's fundamental law and must always be listed first, no
    // matter the readdir / alphabetical ordering. Stable sort keeps the
    // relative order of the remaining entries unchanged.
    if (space === 'holy' && list.some(e => isSupremeCode(e.id))) {
      list.sort((a, b) => (isSupremeCode(a.id) ? 0 : 1) - (isSupremeCode(b.id) ? 0 : 1));
    }
    if (spaceFilter || spaces.length > 1) {
      ctx.print(`[${space}] ${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
    }
    for (const e of list) {
      const title = e.title || '(untitled)';
      // Pushpin marks the permanent Supreme Code entry so it stands out from
      // ordinary knowledge entries at a glance.
      const pin = isSupremeCode(e.id) ? '📌 ' : '';
      const mark = isSupremeCode(e.id) ? '  — supreme code (permanent; manage via /kb code)' : '';
      ctx.print(`  ${pin}${e.id.padEnd(28)}  ${title}${mark}`);
      total++;
    }
  }
  if (total === 0 && !spaceFilter) {
    ctx.print(`(no knowledge entries in either space — the agent can save them via kb_save_knowledge)`);
  }
}

async function knowledgeShowKb(rest, ctx) {
  const id = rest[0];
  if (!id) { ctx.print(`Usage: /kb knowledge show <id>`); return; }
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  // Search both spaces
  for (const space of ['holy', 'eden']) {
    const entry = await readKnowledge(p.id, space, id).catch(() => null);
    if (entry) {
      const pin = isSupremeCode(entry.id) ? '📌 ' : '';
      ctx.print(`## ${pin}${entry.title || entry.id}  [${space}]`);
      if (entry.id !== entry.title) ctx.print(`id: ${entry.id}`);
      if (entry.intro) { ctx.print(''); ctx.print(entry.intro); }
      if (entry.keyFiles?.length) { ctx.print(''); ctx.print('keyFiles:'); for (const f of entry.keyFiles) ctx.print(`  ${f}`); }
      if (entry.keySymbols?.length) { ctx.print(''); ctx.print('keySymbols:'); for (const s of entry.keySymbols) ctx.print(`  ${s}`); }
      if (entry.keywords?.length) ctx.print(`keywords: ${entry.keywords.join(', ')}`);
      if (entry.createdAt) ctx.print(`createdAt: ${entry.createdAt}`);
      if (entry.updatedAt) ctx.print(`updatedAt: ${entry.updatedAt}`);
      return;
    }
  }
  ctx.print(`(entry not found: ${id})`);
}



/**
 * /kb knowledge learn — the unified deep-study command (merges the former
 * `/kb knowledge init` and `/kb knowledge learn`).
 *
 * Two modes, selected automatically:
 *
 *   DOC mode   (--file / --base-dir pointing at documents):
 *     deep-study Markdown / PDF / Word / PowerPoint / text documents and write
 *     extracted knowledge entries to a user-chosen space (eden or holy).
 *     Files may live outside the project source tree.
 *
 *   CODE mode  (no --file/--base-dir, or --base-dir pointing at an indexed
 *     subdirectory of the project):
 *     deep-study the project's indexed source files. Phase 0 attempts three
 *     project-wide survey entries (api-docs / code-walkthrough / usage-
 *     examples, skipped under --base-dir), Phase 1 asks the LLM to plan topic
 *     batches, Phase 2 executes each batch to extract Eden entries.
 *
 * Both modes share the same two-phase pipeline:
 *   Phase 1 (Planning): send the LLM a compact manifest of the study universe
 *     (doc labels + char counts, or the project file map with symbol hints)
 *     and ask it to group files into focused topic batches using a strict
 *     pipe-delimited format.
 *   Phase 2 (Execution): for each batch, load the file contents, feed them to
 *     the LLM for focused extraction, cross-check against existing entries,
 *     and write accepted entries to the target space.
 *
 * Usage:
 *   /kb knowledge learn [--space=eden|holy] [--file=<path>] [--base-dir=<dir>]
 *                       [--per-batch-chars=N] [--dry-run] [--no-survey]
 *                       [--model=<provider>/<model-id>] [--plan-timeout-ms=N]
 *                       [instructions...]
 *
 *   --space           eden | holy (default eden). In CODE mode the target is
 *                     always Eden (stable Holy knowledge is curated by hand).
 *                     DOC --space=holy prompts once per run; merges or overwrites
 *                     of existing Holy entries confirm per entry.
 *   --file=<path>     DOC mode: learn a single file.
 *   --base-dir=<dir>  DOC mode when the path is a real directory that is NOT
 *                     an indexed subdirectory: learn every supported file
 *                     under it. CODE mode when it IS an indexed subdirectory:
 *                     restrict the study to files under it. Without --file/
 *                     --base-dir: whole-project CODE mode.
 *   --per-batch-chars LLM context budget per execution batch (default 100000).
 *   --dry-run         show proposed entries but do NOT write.
 *   --no-survey       CODE mode: skip the Phase 0 project-wide survey entries.
 *   --model           <provider>/<model-id> from the model registry
 *                     (validated via resolveModelRef). Drives ALL learn LLM
 *                     calls — Phase 0 survey, Phase 1 planning, Phase 2
 *                     extraction and entry validation. Default: the current
 *                     session model (ctx.llm). Invalid refs abort before work.
 *   --plan-timeout-ms Phase 1 planning call timeout in ms (default 300000; env
 *                     equivalent HK2_PLAN_TIMEOUT_MS). Slow providers (e.g.
 *                     reasoning models on large file maps) can exceed a fixed
 *                     300s budget. Extract retries use min(plan-timeout, 180s)
 *                     so a hung call cannot stall a long batch run.
 *   trailing tokens   free-form instructions passed to every LLM prompt.
 *
 * Plan parsing hardening (no more "Could not parse LLM study plan."):
 *   - The plan is parsed from `content` first, then `reasoning` (some
 *     reasoning models put the plan in reasoning_content behind a short ack).
 *   - parsePlanText normalizes full-width pipes, unwraps fenced blocks,
 *     strips markdown table borders, accepts semicolon separators.
 *   - A parsed plan is only accepted when >= 50% of its paths resolve to real
 *     files; otherwise it falls back to deterministic grouping (directory
 *     grouping in CODE mode, per-file batches in DOC mode) — the command
 *     ALWAYS proceeds, never aborts on a bad plan.
 */
async function knowledgeLearnKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const flags = parseFlags(rest);

  // ---- Model resolution: --model=<provider/model-id> wins, else ctx.llm ----
  // The override drives EVERY learn LLM call: Phase 0 survey, Phase 1
  // planning, Phase 2 extraction and entry validation. ctx.streamLLM is
  // bound to the session model (session.llm.stream with status-bar token
  // tracking), so it is re-pointed at the resolved client's stream().
  const wrapStream = (client) => async function* (messages, opts = {}) {
    yield* client.stream(messages, opts);
  };
  const modelRef = typeof flags.model === 'string' ? flags.model : '';
  let llm = ctx.llm || null;
  let streamLLM = ctx.streamLLM || null;
  if (modelRef) {
    try {
      const got = await resolveCodeGenLlm(ctx, modelRef);
      llm = got.llm;
      streamLLM = wrapStream(llm);
      ctx.print(`[kb knowledge learn] model: ${modelRef}`);
    } catch (err) {
      ctx.print(`Error: ${err.message}`);
      return;
    }
  }
  if (!llm) {
    ctx.print(`No LLM configured. Run /model add + /model set-default first, or pass --model=<provider>/<model-id>.`);
    return;
  }
  // Defensive: a host ctx may carry llm without streamLLM (tests / embedders).
  if (!streamLLM) streamLLM = wrapStream(llm);
  const space = flags.space === 'holy' ? 'holy' : flags.space === 'eden' ? 'eden' : '';
  const perBatchChars = parseInt(flags['per-batch-chars'], 10) || 100000;
  const dryRun = !!flags['dry-run'];
  const skipSurvey = !!flags['no-survey'];
  // Planning timeout: slow providers (e.g. reasoning models on large maps)
  // can exceed a fixed 300s; make it configurable and default longer for the
  // first attempt. Extract retries get a smaller budget so a hung call
  // doesn't stall a long batch run.
  const planTimeoutMs = parseInt(flags['plan-timeout-ms'], 10) || parseInt(process.env.HK2_PLAN_TIMEOUT_MS, 10) || 300000;
  const retryTimeoutMs = Math.min(planTimeoutMs, 180000);
  const userPrompt = flags.positionalText || '';

  // Semantic validation gate (same env var as the turn-end [kb learn] pipeline
  // in src/commands/interactive.js). Default ON: every proposed entry is
  // checked against the existing KB for duplicate / update-in-place /
  // conflict before any write. Set HK2_KB_LEARN_VALIDATE=0 to restore the
  // legacy deterministic discard (crossCheckEntries, no LLM validation).
  const validateGate = (() => {
    const v = process.env.HK2_KB_LEARN_VALIDATE;
    if (v === undefined || v === null || v === '') return true;
    return !/^(0|no|false|off)$/i.test(v.trim());
  })();

  // ---- Mode resolution ----
  // Either --file or --base-dir may be given, not both. `--file` is always DOC
  // mode. `--base-dir` is DOC mode when it resolves to a real directory that
  // is not an indexed subdirectory of the project; it is CODE mode (scoped)
  // when it matches the indexed-file coordinate system (same rule the old
  // /kb knowledge init used). No flags: whole-project CODE mode.
  const fileArg = typeof flags.file === 'string' ? flags.file : '';
  const dirArgRaw = typeof flags['base-dir'] === 'string' ? flags['base-dir'] : '';
  if (fileArg && dirArgRaw) {
    ctx.print(`Pass only one of --file or --base-dir, not both.`);
    return;
  }

  // Normalize a --base-dir into the indexed-file coordinate system (paths
  // relative to sourcePath + sourceRoot, forward-slash separated).
  const normalizeBaseDir = (raw) => raw
    ? raw.replace(/^\.?\/+/, '').replace(/\/+$/, '').split(path.sep).join('/')
    : '';

  // Which indexed paths sit under a normalized base-dir?
  const indexedPaths = ctx.rt?.files?.byId
    ? Object.values(ctx.rt.files.byId).map(f => f.path).filter(Boolean)
    : [];
  const resolveCodeScope = (norm) => {
    if (!norm) return { scoped: false, count: indexedPaths.length };
    const prefix = norm.endsWith('/') ? norm : norm + '/';
    const count = indexedPaths.filter(fp => fp === norm || fp.startsWith(prefix)).length;
    return { scoped: true, count };
  };

  let mode = null;           // 'doc' | 'code'
  let baseDir = '';          // indexed-coordinate base-dir for scoped code mode
  let docDir = '';           // absolute directory for doc mode walking

  if (fileArg) {
    mode = 'doc';
  } else if (dirArgRaw) {
    // Prefer CODE mode when the path is an indexed subdirectory (keeps the
    // old `knowledge init --base-dir` semantics). Otherwise, if it's a real
    // directory on disk, treat it as DOC mode (old `learn --base-dir`).
    const norm = normalizeBaseDir(dirArgRaw);
    const scope = resolveCodeScope(norm);
    if (scope.count > 0) {
      mode = 'code';
      baseDir = norm;
    } else {
      const abs = path.isAbsolute(dirArgRaw) ? dirArgRaw : path.resolve(dirArgRaw);
      let st = null;
      try { st = await fs.stat(abs); } catch {}
      if (st && st.isDirectory()) {
        mode = 'doc';
        docDir = abs;
      } else {
        ctx.print(`--base-dir not found: ${abs} (and no indexed files under "${norm}")`);
        return;
      }
    }
  } else {
    mode = 'code';
  }

  ctx.print(`[kb knowledge learn] mode=${mode === 'doc' ? 'documents' : 'code'}  space=${space || 'eden'}  project=${p.name}`);
  ctx.print(`  source: ${p.sourcePath}`);
  if (p.sourceRoot) ctx.print(`  sourceRoot: ${p.sourceRoot}`);
  if (baseDir) ctx.print(`  base-dir: ${baseDir} (code scope, ${resolveCodeScope(baseDir).count} indexed files)`);
  if (docDir) ctx.print(`  base-dir: ${docDir} (documents)`);
  if (userPrompt) ctx.print(`  user instructions: ${userPrompt}`);
  if (dryRun) ctx.print(`  dry-run: proposals will NOT be written`);

  // In CODE mode the extraction target is always Eden: the old init wrote
  // bootstrap entries there, and Holy should stay hand-curated. --space=holy
  // is honored only in DOC mode (learning authoritative documents).
  const targetSpace = mode === 'code' ? 'eden' : (space || 'eden');
  if (mode === 'code' && space === 'holy') {
    ctx.print(`  note: --space=holy is ignored in code mode (extraction writes Eden entries).`);
  }

  // ================= common state =================
  const { writeKnowledge, readKnowledge } = await import('../../lib/store/kb_store.js');
  const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
  // Semantic validation primitives shared with the turn-end [kb learn] flow.
  const { findCandidateEntries, validateLearnedEntry } = await import('../../lib/agent/kb_validate.js');
  const rt = await getRuntime(p.id).catch(() => null);
  const projectId = p.id;

  const existingHoly = await listKnowledge(p.id, 'holy').catch(() => []);
  // Eden entries stamped supersededBy="holy:*" are RETIRED (Holy takes
  // precedence — the same exclusion buildRequestGraph applies). They must
  // never be a merge/update/conflict target: writing one back would strip
  // the stamp and resurrect the retired entry into retrieval.
  let existingEden = (await listKnowledge(p.id, 'eden').catch(() => []))
    .filter(e => !e.supersededBy);
  ctx.print(`  existing Holy: ${existingHoly.length}, Eden: ${existingEden.length}`);

  let totalSaved = 0;
  let totalAccepted = 0;
  let totalDiscarded = 0;
  let totalProposed = 0;
  let studiedBatches = 0;
  // Semantic validation can redirect a write onto the OTHER space (e.g. a
  // doc-mode run targeting eden whose entry updates a holy entry), so track
  // saves per space for the final summary instead of assuming targetSpace.
  let savedHoly = 0;
  let savedEden = 0;

  // Shared Phase 2 study routine: feed one group of sources to the model,
  // cross-check the proposed entries, and write accepted ones.
  // `sources` items: { path, text } (docs) or { path, content, symbolCount } (code).
  async function studySources(sources, topic, description, sourceKind) {
    if (sources.length === 0) return;
    const bodyOf = (s) => (s.text != null ? s.text : (s.content != null ? s.content : ''));
    const sourcesChars = sources.reduce((s, f) => s + bodyOf(f).length, 0);
    ctx.print(`  deep-read: ${sources.length} ${sourceKind === 'code' ? 'file' : 'file'}(s), ${sourcesChars} chars`);

    const holyNow = existingHoly.map(e => `- ${e.id}: ${e.title}`).join('\n');
    const edenNow = existingEden.map(e => `- ${e.id}: ${e.title}`).join('\n');

    const contextParts = [];
    for (const s of sources) {
      const label = s.symbolCount != null ? `## ${s.path} (${s.symbolCount} syms)` : `## ${s.path}`;
      contextParts.push(`${label}\n\`\`\`\n${bodyOf(s)}\n\`\`\``);
    }
    const batchContext = contextParts.join('\n\n').slice(0, perBatchChars);

    const extractSysPrompt = buildLearnExtractSysPrompt(targetSpace, holyNow, edenNow, userPrompt, sourceKind);
    const extractUserPrompt = sourceKind === 'code'
      ? `Project: ${p.name} — Topic: ${topic}\n${description || ''}\n\nBelow are source files related to this topic. Extract knowledge entries.\n\n${batchContext}`
      : `Source documents for topic "${topic}": ${description}\n\nBelow are the document contents. Extract knowledge entries.\n\n${batchContext}`;

    const callExtract = async (enableReasoning) => {
      let raw = '';
      let rawReasoning = '';
      for await (const evt of streamLLM(
        [
          { role: 'system', content: extractSysPrompt },
          { role: 'user', content: extractUserPrompt },
        ],
        { temperature: 0.1, maxChars: 65536, enableReasoning, timeoutMs: enableReasoning ? 300000 : retryTimeoutMs },
      )) {
        if (evt.type === 'retry') {
          // Transient failure — the call restarts from scratch; the failed
          // attempt's partial output is void (see lib/llm/retries.js).
          raw = '';
          rawReasoning = '';
        } else if (evt.type === 'delta') {
          raw += evt.text;
        } else if (evt.type === 'reasoning') {
          rawReasoning += evt.text;
        }
      }
      return { raw, rawReasoning };
    };
    let attempt;
    try {
      attempt = await callExtract(true);
    } catch (err) {
      ctx.print(`  LLM call failed: ${err.message} — skipping.`);
      return;
    }
    let proposed = parseJsonArrayLoose(attempt.raw, attempt.rawReasoning);
    if (!Array.isArray(proposed)) {
      // Deep-reasoning models can burn the whole output budget in the thinking
      // channel and emit an empty or truncated content stream — the root cause
      // of silent "could not parse as JSON array" skips. Retry once with
      // reasoning DISABLED so the JSON array must land in the content channel.
      ctx.print('  (extraction output unparseable — retrying with reasoning disabled...)');
      try {
        const retry = await callExtract(false);
        proposed = parseJsonArrayLoose(retry.raw, retry.rawReasoning);
      } catch (err) {
        ctx.print(`  retry failed: ${err.message}`);
      }
    }
    if (!Array.isArray(proposed)) {
      const head = (attempt.raw || attempt.rawReasoning || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      ctx.print(`  (could not parse as JSON array — skipping. content=${attempt.raw.length}c reasoning=${attempt.rawReasoning.length}c; head: ${head || '(empty)'})`);
      return;
    }
    totalProposed += proposed.length;
    if (proposed.length === 0) {
      ctx.print('  (no entries)');
      return;
    }

    // ---- Validate every proposed entry against the existing KB ----
    // Mirrors the turn-end [kb learn] pipeline (learnNewKnowledge in
    // src/commands/interactive.js): deterministic pre-filter
    // (findCandidateEntries) → semantic verdict (validateLearnedEntry) →
    // four branches: duplicate (skip + reason), update (merge IN PLACE onto
    // the existing entry), conflict (Holy → user decides; Eden → winner +
    // reason), new (write fresh; when related entries exist, state why we are
    // NOT updating them). Retired eden entries (supersededBy) were already
    // filtered out of existingEden so they can never be a merge target.
    const accepted = [];   // { record, effSpace, action }
    const skipped = [];    // { id, reason }
    // Pre-view of what this run will write, so two NEAR-IDENTICAL entries
    // proposed in the SAME batch can still see each other (the write loop
    // only runs after the whole batch is validated — without this mirror the
    // second one would blindly duplicate the first).
    const pendingHoly = [];
    const pendingEden = [];
    const viewOf = (arr, e) => {
      const i = arr.findIndex(x => x.id === e.id);
      if (i >= 0) arr[i] = e; else arr.push(e);
    };
    for (const entry of proposed) {
      if (!entry.id || !entry.title || !entry.intro) {
        skipped.push({ id: entry.id || '?', reason: 'missing required fields' });
        continue;
      }
      const id = String(entry.id).replace(/[^A-Za-z0-9_.-]/g, '_');
      if (isSupremeCode(id)) {
        // The supreme-code entry is permanent and managed ONLY via
        // /kb code add|del — the learn flow must never overwrite it.
        skipped.push({ id, reason: 'supreme-code entry is managed only via /kb code add | /kb code del' });
        continue;
      }
      const record = {
        id, space: targetSpace,
        title: entry.title, intro: entry.intro,
        keyFiles: Array.isArray(entry.keyFiles) ? entry.keyFiles : [],
        keySymbols: Array.isArray(entry.keySymbols) ? entry.keySymbols : [],
        keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
        autoLearned: true, learned: true,
        source: sourceKind === 'code' ? 'kb-knowledge-learn-code' : 'kb-knowledge-learn-doc',
      };

      if (!validateGate) {
        // HK2_KB_LEARN_VALIDATE=0 → legacy deterministic gate: exact id or
        // heuristic title/keyword collision → discard (no LLM validation).
        const legacy = crossCheckEntries([entry], existingHoly, existingEden);
        if (legacy.accepted.length > 0) {
          accepted.push({ record, effSpace: targetSpace, action: 'new' });
          viewOf(targetSpace === 'holy' ? pendingHoly : pendingEden, record);
        } else {
          const reason = legacy.discarded[0]?.reason || 'conflicts with an existing entry';
          ctx.print(`    [SKIP] ${id}: ${reason} (legacy gate, HK2_KB_LEARN_VALIDATE=0)`);
          skipped.push({ id, reason });
        }
        continue;
      }

      const candidates = findCandidateEntries(record, existingHoly.concat(pendingHoly), existingEden.concat(pendingEden));
      const verdict = await validateLearnedEntry(llm, record, candidates, { timeoutMs: 60000 });
      const cand = candidates.find(c => c.entry.id === verdict.targetId);
      if (cand && isSupremeCode(cand.entry.id)) {
        // The permanent Supreme Code entry can never be a merge/conflict
        // target: a redirected write would drop its `codes` array and the
        // protected flags. It is managed ONLY via /kb code add | /kb code del.
        ctx.print(`    [SKIP] ${id}: validator target "${cand.entry.id}" is the permanent Supreme Code entry — managed only via /kb code add | /kb code del.`);
        skipped.push({ id, reason: 'validator target is the permanent supreme-code entry' });
        continue;
      }

      if (verdict.verdict === 'duplicate') {
        // Same or essentially the same meaning already in the KB — skip the
        // write entirely to avoid redundant re-learning.
        ctx.print(`    [SKIP] ${id}: duplicate of "${verdict.targetId}" — ${verdict.reason || '(no reason)'}`);
        skipped.push({ id, reason: `duplicate of "${verdict.targetId}"` });
        continue;
      }

      if (verdict.verdict === 'update' && cand) {
        // Related entry covers the same topic — merge onto it instead of
        // creating a near-identical sibling. The write keeps the existing
        // entry's id + space; createdAt is carried over explicitly
        // (writeKnowledge only preserves it when the record already has one).
        ctx.print(`    [UPDATE] ${id} → ${cand.space}:"${cand.entry.id}" (merge in place) — ${verdict.reason || '(no reason)'}`);
        if (cand.space === 'holy' && !dryRun) {
          // Rewriting an EXISTING Holy entry is more invasive than adding a
          // new one — ask per entry even though the run-level holy gate
          // (doc mode) already passed.
          const ok = await ctx.confirm(`Merge new knowledge into HOLY entry "${cand.entry.id}"? (y/N) `);
          if (!ok) {
            ctx.print(`    [SKIP] ${id}: user declined the Holy merge — keeping "${cand.entry.id}" unchanged.`);
            skipped.push({ id, reason: `holy merge into "${cand.entry.id}" declined by user` });
            continue;
          }
        }
        record.id = cand.entry.id;
        record.space = cand.space;
        record.title = cand.entry.title || record.title;
        record.intro = verdict.mergedIntro;
        record.createdAt = cand.entry.createdAt; // keep the original creation time
        record.spaceChangedAt = cand.entry.spaceChangedAt; // in-place merge must not reset the space-change time
        record.keywords = [...new Set([...(cand.entry.keywords || []), ...record.keywords])];
        record.keyFiles = [...new Set([...(cand.entry.keyFiles || []), ...record.keyFiles])];
        record.keySymbols = [...new Set([...(cand.entry.keySymbols || []), ...record.keySymbols])];
        record.updatedByLearn = true;
        accepted.push({ record, effSpace: cand.space, action: 'merged' });
        viewOf(cand.space === 'holy' ? pendingHoly : pendingEden, record);
        continue;
      }

      if (verdict.verdict === 'conflict' && cand) {        // Direct contradiction with an existing entry.
        ctx.print(`    [CONFLICT] ${id} vs ${cand.space}:"${cand.entry.id}" — ${verdict.reason || '(no reason)'}`);
        ctx.print(`      validator: the ${verdict.conflictWinner === 'new' ? 'NEW' : 'EXISTING'} entry wins.`);
        if (cand.space === 'holy') {
          // Holy conflicts are ALWAYS decided by the user — Holy Space is
          // the source of truth and every write needs explicit approval.
          if (dryRun) {
            ctx.print(`      [dry-run] would ask: update holy "${cand.entry.id}" with the new knowledge (new wins)?`);
            skipped.push({ id, reason: `holy conflict with "${cand.entry.id}" (dry-run, undecided)` });
            continue;
          }
          const apply = await ctx.confirm(`The new entry CONFLICTS with holy entry "${cand.entry.id}". Update it with the new knowledge (new wins)? (y/N) `);
          if (!apply) {
            ctx.print(`    [SKIP] ${id}: keeping the existing Holy entry (original wins).`);
            skipped.push({ id, reason: `holy conflict with "${cand.entry.id}" — user kept the original` });
            continue;
          }
          record.id = cand.entry.id;
          record.space = 'holy';
          record.title = cand.entry.title || record.title;
          record.createdAt = cand.entry.createdAt; // keep the original creation time
          record.spaceChangedAt = cand.entry.spaceChangedAt; // in-place update: keep the original space-change time
          record.updatedByLearn = true;
          accepted.push({ record, effSpace: 'holy', action: 'merged' });
          viewOf(pendingHoly, record);
          continue;
        }
        if (verdict.conflictWinner === 'existing') {
          ctx.print(`    [SKIP] ${id}: the existing entry wins (the new extraction looked stale or wrong).`);
          skipped.push({ id, reason: `conflict with "${cand.entry.id}" — existing wins` });
          continue;
        }
        // Eden-vs-Eden, new wins: write the new entry and surface the old one
        // for manual cleanup (no auto-supersede across eden entries).
        ctx.print(`      The contradicting eden entry "${cand.entry.id}" is kept — review with /kb knowledge show, remove via /kb knowledge del if stale.`);
        accepted.push({ record, effSpace: targetSpace, action: 'new' });
        viewOf(targetSpace === 'holy' ? pendingHoly : pendingEden, record);
        continue;
      }

      // verdict 'new' — related entries may exist; state why we are NOT
      // updating them (required explanation for not updating in place).
      if (candidates.length > 0) {
        ctx.print(`    [ACCEPT] ${id}: ${entry.title || ''} (${(entry.intro || '').length}c) — new, NOT updating ${candidates.slice(0, 3).map(c => `${c.space}:${c.entry.id}`).join(', ')}${candidates.length > 3 ? ' ...' : ''}`);
        ctx.print(`      reason: ${verdict.reason || '(no reason provided)'}`);
      } else {
        ctx.print(`    [ACCEPT] ${id}: ${entry.title || ''} (${(entry.intro || '').length}c)`);
      }
      accepted.push({ record, effSpace: targetSpace, action: 'new' });
      viewOf(targetSpace === 'holy' ? pendingHoly : pendingEden, record);
    }

    ctx.print(`  proposed: ${proposed.length}, accepted: ${accepted.length}, skipped: ${skipped.length}`);
    totalAccepted += accepted.length;
    totalDiscarded += skipped.length;

    if (!dryRun && accepted.length > 0) {
      for (const { record, effSpace } of accepted) {
        await writeKnowledge(projectId, effSpace, record);
        const final = await readKnowledge(projectId, effSpace, record.id);
        if (final && rt) rt.reloadKnowledge?.(final, effSpace);
        // Keep the in-memory mirror fresh so entries proposed later in the
        // SAME batch validate against what was just written (a merged entry
        // replaces its target instead of piling up a duplicate).
        if (effSpace === 'holy') {
          const i = existingHoly.findIndex(e => e.id === record.id);
          if (i >= 0) existingHoly[i] = final || record; else existingHoly.push(final || record);
          savedHoly++;
        } else {
          const i = existingEden.findIndex(e => e.id === record.id);
          if (i >= 0) existingEden[i] = final || record; else existingEden.push(final || record);
          savedEden++;
        }
        totalSaved++;
      }
    }
  }

  // ================= DOC mode =================
  if (mode === 'doc') {
    const unsupported = [];
    let targetFiles = [];
    if (fileArg) {
      const abs = path.isAbsolute(fileArg) ? fileArg : path.resolve(fileArg);
      const ext = path.extname(abs).slice(1).toLowerCase();
      if (!isLearnableExt(ext)) {
        ctx.print(`Unsupported file type: .${ext || '(none)'}`);
        ctx.print(`Supported: ${[...LEARN_DOC_EXTS].join(', ')}, plus txt/rst/adoc/json/yaml/html/sgml.`);
        return;
      }
      try { const st = await fs.stat(abs); if (!st.isFile()) throw new Error('not a file'); }
      catch (err) { ctx.print(`--file not found or not a file: ${abs} (${err.message})`); return; }
      targetFiles.push(abs);
    } else {
      ctx.print(`[doc] Walking ${docDir} ...`);
      targetFiles = await walkLearnFiles(docDir, unsupported);
    }

    if (targetFiles.length === 0) {
      ctx.print(`No learnable files found${docDir ? ` under ${docDir}` : ''}.`);
      ctx.print(`Supported: ${[...LEARN_DOC_EXTS].join(', ')}, plus txt/rst/adoc/json/yaml/html/sgml.`);
      if (unsupported.length) {
        ctx.print(`Skipped ${unsupported.length} unsupported file(s): ${unsupported.slice(0, 8).map(f => path.basename(f)).join(', ')}${unsupported.length > 8 ? ' ...' : ''}`);
      }
      return;
    }

    ctx.print(`[doc] Deep-studying ${targetFiles.length} file${targetFiles.length === 1 ? '' : 's'} -> ${targetSpace} space`);
    if (unsupported.length) {
      ctx.print(`  (skipped ${unsupported.length} unsupported file${unsupported.length === 1 ? '' : 's'})`);
    }

    // Parse every target file up-front so failures are reported and every
    // supported file is processed.
    const { parseDocument } = await import('../../lib/parser/doc_parser.js');
    const parsedFiles = [];   // { path, label, text, title }
    const failed = [];
    for (const abs of targetFiles) {
      const label = docDir ? path.relative(docDir, abs) : path.basename(abs);
      ctx.setPhase?.(`parsing ${label}`);
      let parsed = null;
      try { parsed = await parseDocument(abs); }
      catch (err) { failed.push({ label, msg: err.message }); }
      if (!parsed || !((parsed.text || '').trim())) {
        if (parsed) failed.push({ label, msg: 'no extractable text' });
        continue;
      }
      // Large files are split into sequential parts so EVERY section is
      // studied; each part is its own manifest entry and Phase 2 batch.
      const chunks = chunkDocText(parsed.text, perBatchChars);
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunkLabel = chunks.length > 1 ? `${label}.part${ci + 1}` : label;
        parsedFiles.push({
          path: chunkLabel,
          label: chunkLabel,
          text: chunks[ci].text,
          title: chunks.length > 1
            ? `${parsed.title || label} (part ${ci + 1}/${chunks.length})`
            : (parsed.title || label),
        });
      }
    }
    ctx.setPhase?.('idle');

    if (parsedFiles.length === 0) {
      ctx.print(`Could not extract text from any file.`);
      for (const f of failed) ctx.print(`  - ${f.label}: ${f.msg}`);
      return;
    }
    const totalChars = parsedFiles.reduce((s, f) => s + f.text.length, 0);
    ctx.print(parsedFiles.length > targetFiles.length
      ? `  parsed: ${targetFiles.length} file(s) split into ${parsedFiles.length} study parts, ${totalChars} chars`
      : `  parsed: ${parsedFiles.length}/${targetFiles.length} files, ${totalChars} chars`);
    if (failed.length) {
      ctx.print(`  failed: ${failed.length}`);
      for (const f of failed.slice(0, 10)) ctx.print(`    - ${f.label}: ${f.msg}`);
    }

    // For holy writes we ask for interactive confirmation once per run.
    if (targetSpace === 'holy' && !dryRun) {
      ctx.print(`[holy] You are about to write learned entries to HOLY space.`);
      ctx.print(`  Holy Space is the source of truth for stable design knowledge.`);
      const holyConfirmed = await ctx.confirm(`Write learned entries to holy? (y/N) `);
      if (!holyConfirmed) {
        ctx.print(`Cancelled. Re-run with --space=eden, or confirm to proceed.`);
        return;
      }
    }

    // ---- Phase 1: LLM plans study batches from the file manifest ----
    ctx.setPhase?.('planning study');
    ctx.print('');
    ctx.print('[Phase 1: Planning] Building file manifest for the model...');
    const manifest = parsedFiles.map((f, i) =>
      `[${i + 1}] ${f.path} (${f.text.length} chars${f.title && f.title !== f.path ? `, title: ${f.title}` : ''})`).join('\n');

    const fileCount = parsedFiles.length;
    const planSysPrompt = `You are planning a deep study of a set of documents (PDF / Word / PowerPoint / Markdown) so reusable knowledge entries can be extracted into the project KB.

Group related files into focused topic batches - group by LOGICAL topic, not just by file. Each batch should be coherent and small enough to study together.

Output format - one batch per line, using pipe delimiters (NOT JSON, NO markdown):
topic-id | short description | file1, file2, file3

Rules:
- Use the EXACT file labels from the manifest (the [N] label text).
- Cover EVERY file across the batches - no file may be dropped.
- A large document is split into numbered parts (e.g. "book.pdf.part1") - each part is a separate manifest entry and must be covered like any other file.
- Keep each batch's TOTAL source size under the per-batch budget of ${perBatchChars} chars.
- If there is only one file, output a single batch for it.
- Keep batches to <= 6 files when possible.
- Output ONLY the pipe-delimited lines. No prose, no JSON, no markdown fences.

File manifest:
${manifest}`;

    const planCall = async (enableReasoning) => {
      let raw = '';
      let reasoning = '';
      for await (const evt of streamLLM(
        [
          { role: 'system', content: planSysPrompt },
          { role: 'user', content: `Plan the study of these ${fileCount} document(s).${userPrompt ? `\nUser instructions: ${userPrompt}` : ''}` },
        ],
        { temperature: 0.1, maxChars: planningBudgetFor(fileCount), enableReasoning, timeoutMs: enableReasoning ? planTimeoutMs : retryTimeoutMs },
      )) {
        if (evt.type === 'retry') {
          // Transient failure — the call restarts from scratch; the failed
          // attempt's partial plan text is void (see lib/llm/retries.js).
          raw = '';
          reasoning = '';
        } else if (evt.type === 'delta') {
          raw += evt.text;
        } else if (evt.type === 'reasoning') {
          reasoning += evt.text;
        }
      }
      return { raw, reasoning };
    };
    let planRaw = '';
    let planReasoning = '';
    try {
      ({ raw: planRaw, reasoning: planReasoning } = await planCall(true));
    } catch (err) {
      ctx.print(`[Phase 1] planning LLM call failed: ${err.message}`);
    }
    // Parse from content first; fall back to the reasoning channel when the
    // plan isn't there (reasoning models put it in reasoning_content).
    let plan = parsePlanText(planRaw);
    let planFromReasoning = false;
    if (!plan && planReasoning.trim()) {
      plan = parsePlanText(planReasoning);
      planFromReasoning = !!plan;
    }
    // Retry once with reasoning DISABLED (mirrors CODE mode Phase 1): when the
    // first attempt produced no parseable plan (e.g. a deep-reasoning model
    // burned the whole output budget thinking), a non-reasoning call forces
    // the answer into the content channel with a fresh budget.
    if (!plan) {
      ctx.print('[Phase 1] No parseable plan from content or reasoning - retrying with reasoning disabled...');
      try {
        const retry = await planCall(false);
        plan = parsePlanText(retry.raw);
        if (!plan && retry.reasoning.trim()) {
          plan = parsePlanText(retry.reasoning);
          planFromReasoning = !!plan;
        }
      } catch (err) {
        ctx.print(`[Phase 1] retry planning call failed: ${err.message}`);
      }
    }
    if (plan) {
      ctx.print(`[Phase 1] LLM plan parsed: ${plan.length} batch${plan.length === 1 ? '' : 'es'} (${planFromReasoning ? 'from reasoning' : 'from content'}).`);
    } else {
      ctx.print(`[Phase 1] LLM plan not parseable - falling back to per-file batches.`);
    }
    // Safety net: every parsed file must appear in some batch. Files the LLM
    // omitted get their own batch; batches referencing unknown files are dropped.
    plan = reconcilePlan(plan, parsedFiles);

    ctx.print('');
    ctx.print(`[Phase 1] Study plan: ${plan.length} batch${plan.length === 1 ? '' : 'es'}`);
    for (let i = 0; i < plan.length; i++) {
      const b = plan[i];
      ctx.print(`  [${i + 1}/${plan.length}] ${b.topic}: ${b.description || ''} (${(b.files || []).length} files)`);
    }
    ctx.print('');

    // ---- Phase 2: Execute each batch ----
    ctx.print(`[Phase 2: Execution] Per-batch budget: ${perBatchChars} chars`);
    ctx.print('');

    const textByLabel = new Map(parsedFiles.map(f => [f.path, f]));
    const processedLabels = new Set();

    for (let batchIdx = 0; batchIdx < plan.length; batchIdx++) {
      const batch = plan[batchIdx];
      ctx.setPhase?.(`studying [${batchIdx + 1}/${plan.length}] ${batch.topic}`);
      ctx.print(`--- [${batchIdx + 1}/${plan.length}] ${batch.topic}: ${batch.description || ''} ---`);

      const sources = [];
      for (const rel of batch.files || []) {
        const f = textByLabel.get(rel) || findByLabel(textByLabel, rel);
        if (!f) continue;
        sources.push(f);
        processedLabels.add(f.path);
      }
      if (sources.length === 0) {
        ctx.print('  (no readable files in batch — skipping)');
        continue;
      }
      // Budget enforcement: oversized batches are studied in sub-groups.
      const groups = groupByBudget(sources, perBatchChars);
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups.length > 1) {
          ctx.print(`  sub-batch ${gi + 1}/${groups.length}: ${groups[gi].map(s => s.path).join(', ')}`);
        }
        await studySources(groups[gi], batch.topic, batch.description || '', 'doc');
        studiedBatches++;
      }
    }

    // Safety net: study any file the planner dropped.
    const dropped = parsedFiles.filter(f => !processedLabels.has(f.path));
    if (dropped.length > 0) {
      ctx.print('');
      ctx.print(`[safety] ${dropped.length} file(s) were not covered by any batch - studying individually.`);
      for (const f of dropped) {
        ctx.setPhase?.(`studying [fallback] ${f.path}`);
        ctx.print(`--- [fallback] ${f.path} ---`);
        await studySources([f], f.path.replace(/\.[^.]+$/, ''), `single-file fallback for ${f.path}`, 'doc');
        studiedBatches++;
      }
    }

    ctx.setPhase?.('idle');
    ctx.print('');
    ctx.print('=== /kb knowledge learn complete ===');
    ctx.print(`  mode: documents`);
    ctx.print(`  target files: ${targetFiles.length}`);
    ctx.print(`  parsed files: ${parsedFiles.length}`);
    ctx.print(`  batches studied: ${studiedBatches}`);
    ctx.print(`  total proposed: ${totalProposed}`);
    ctx.print(`  total accepted: ${totalAccepted}`);
    ctx.print(`  total discarded: ${totalDiscarded}`);
    if (dryRun) {
      ctx.print(`  [dry-run] ${totalAccepted} entries would have been validated & written.`);
    } else if (totalSaved > 0) {
      const parts = [];
      if (savedHoly > 0) parts.push(`${savedHoly} holy`);
      if (savedEden > 0) parts.push(`${savedEden} eden`);
      ctx.print(`  saved: ${parts.join(', ')} (${totalSaved} total, incl. in-place updates).`);
    } else {
      ctx.print('  (no entries saved)');
    }
    return;
  }

  // ================= CODE mode =================
  // Scoped runtime view when --base-dir matches an indexed subdirectory.
  const scopedRt = baseDir ? buildScopedRt(ctx.rt, baseDir) : ctx.rt;
  if (baseDir) {
    const scopedFiles = scopedRt?.files?.byId ? Object.keys(scopedRt.files.byId).length : 0;
    ctx.print(`  scoped files under ${baseDir}/: ${scopedFiles}`);
    if (scopedFiles === 0) {
      ctx.print(`  (no indexed files under "${baseDir}" - aborting. Top-level dirs:`);
      const tops = new Set();
      if (ctx.rt?.files?.byId) {
        for (const f of Object.values(ctx.rt.files.byId)) {
          if (f.path) tops.add(f.path.split('/')[0] || '(root)');
        }
      }
      ctx.print(`   ${[...tops].sort().join(', ')})`);
      return;
    }
  }
  if (!scopedRt?.files?.byId || Object.keys(scopedRt.files.byId).length === 0) {
    ctx.print(`No indexed files. Run /kb init first.`);
    return;
  }

  // ---- Phase 0: project-wide survey entries (skipped under --base-dir / --no-survey / --dry-run) ----
  if (!dryRun && !baseDir && !skipSurvey) {
    ctx.setPhase?.('project survey');
    ctx.print('');
    ctx.print('[Phase 0: Project-wide survey] Generating api-docs / code-walkthrough / usage-examples...');
    try {
      const { generateSurveyEntries } = await import('../../lib/index/summarize.js');
      const { listSymbolShards, readSymbolsShard, getMeta } = await import('../../lib/store/kb_store.js');
      const meta = await getMeta(p.id);
      const allSymbols = [];
      const shards = await listSymbolShards(p.id);
      for (const s of shards) {
        const data = await readSymbolsShard(p.id, s.shardNum);
        for (const sym of data.symbols || []) allSymbols.push(sym);
      }
      await generateSurveyEntries(p.id, {
        llm,
        streamLLM,
        allSymbols,
        meta,
        onProgress: (which) => ctx.print(`  [survey] generating ${which}...`),
      });
      existingEden = (await listKnowledge(p.id, 'eden').catch(() => []))
        .filter(e => !e.supersededBy);
    } catch (err) {
      ctx.print(`[Phase 0] survey generation failed: ${err.message}`);
    }
  }

  // ---- Phase 1: LLM plans the study ----
  // Hierarchical strategy for large projects: asking the LLM to enumerate
  // every file in its output (e.g. postgres: 2620 files, 423k-char map) makes
  // reasoning models burn their entire budget in the reasoning channel and
  // emit ZERO plan lines — the direct cause of "Could not parse LLM study
  // plan.". Above the file threshold the LLM plans over DIRECTORIES (a ~20x
  // smaller map) and file assignment is expanded deterministically.
  ctx.setPhase?.('planning study');
  ctx.print('');
  ctx.print('[Phase 1: Planning] Building project map for the model...');

  const FILE_LEVEL_LIMIT = 300;
  const dirMap = buildDirMap(scopedRt);
  const hierarchical = dirMap.fileCount > FILE_LEVEL_LIMIT;
  let fileCount;
  let mapText;
  if (hierarchical) {
    fileCount = dirMap.fileCount;
    mapText = dirMap.text;
    ctx.print(`  project map: ${fileCount} files across ${dirMap.dirCount} directories — too large for file-level planning, using DIRECTORY-level map (${mapText.length} chars)`);
  } else {
    const projectMap = buildProjectMap(scopedRt);
    fileCount = projectMap.fileCount || 0;
    mapText = projectMap.text;
    ctx.print(`  project map: ${fileCount} files across ${projectMap.dirCount} directories, ${mapText.length} chars`);
  }

  const unitWord = hierarchical ? 'directories' : 'files';
  const unitHint = hierarchical
    ? `The map below lists DIRECTORIES (with file/symbol counts). Group DIRECTORIES into topics; a topic may list one or more directories (copy the directory paths EXACTLY, with or without the trailing slash).`
    : `Group related files into focused topic batches — group by LOGICAL topic, not just by directory. Each batch covers a coherent area.`;
  const planSysPrompt = `You are planning a deep study of a software project. ${unitHint}

Output format — one batch per line, using pipe delimiters (NOT JSON, NO markdown):
topic-id | short description | ${hierarchical ? 'dir1/, dir2/' : 'file1.c, file2.c, file3.c'}

Example output (3 batches):
buffer-pool | shared buffer cache and page replacement | ${hierarchical ? 'src/storage/buffer/' : 'storage/buffer/bufmgr.c, storage/buffer/freelist.c, storage/buffer/buf_init.c'}
transaction-mgmt | transaction lifecycle and snapshots | ${hierarchical ? 'src/access/transam/, src/utils/time/, src/storage/ipc/' : 'access/transam/xact.c, utils/time/snapmgr.c, storage/ipc/procarray.c'}
wiredtiger-stemmers | full-text search stemmer modules | ${hierarchical ? 'src/snowball/' : 'snowball/stem_ISO_8859_1_english.c, snowball/api.c'}

Rules:
- ${hierarchical ? `Aim for 5-${Math.min(60, Math.ceil(dirMap.dirCount / 5))} topic batches covering ALL directories in the map.` : `${batchGuidanceFor(fileCount)} Cover ALL files listed in the map.`}
- ${hierarchical ? 'Every directory in the map must appear in exactly one batch.' : 'Each batch: 1-30 files. Include every file in exactly one batch.'}
- Group by topic (e.g. "transaction-mgmt" can span access/transam/ + storage/ipc/ + utils/time/).
- Do NOT duplicate topics already covered by existing Holy or Eden entries (listed below).
- Output ONLY the pipe-delimited lines. No prose, no JSON, no markdown fences.

=== COMPLETE ${hierarchical ? 'DIRECTORY' : 'FILE'} MAP ===
${mapText}

Existing Holy entries (DO NOT duplicate):
${existingHoly.slice(0, 30).map(e => `- ${e.id}: ${e.title}`).join('\n') || '(none)'}

Existing Eden entries (DO NOT duplicate):
${existingEden.slice(0, 30).map(e => `- ${e.id}: ${e.title}`).join('\n') || '(none)'}`;

  // planCall(): one planning attempt. enableReasoning stays ON for the first
  // attempt (reasoning models plan better with it) and is disabled for the
  // retry so the model MUST put its answer in content.
  const planCall = async (enableReasoning) => {
    let raw = '';
    let reasoning = '';
    for await (const evt of streamLLM(
      [
        { role: 'system', content: planSysPrompt },
        { role: 'user', content: `Project: ${p.name}\n\nPlan the deep study of these ${fileCount} ${unitWord}.${userPrompt ? `\nUser instructions: ${userPrompt}` : ''}` },
      ],
      { temperature: 0.1, maxChars: planningBudgetFor(hierarchical ? dirMap.dirCount : fileCount), enableReasoning, timeoutMs: enableReasoning ? planTimeoutMs : retryTimeoutMs },
    )) {
      if (evt.type === 'retry') {
        // Transient failure — the call restarts from scratch; the failed
        // attempt's partial plan text is void (see lib/llm/retries.js).
        raw = '';
        reasoning = '';
      } else if (evt.type === 'delta') {
        raw += evt.text;
      } else if (evt.type === 'reasoning') {
        reasoning += evt.text;
      }
    }
    return { raw, reasoning };
  };

  let planRaw = '';
  let planReasoning = '';
  try {
    ({ raw: planRaw, reasoning: planReasoning } = await planCall(true));
  } catch (err) {
    ctx.print(`[Phase 1] LLM planning call failed: ${err.message}`);
  }

  let plan = parsePlanText(planRaw);
  let planFromReasoning = false;
  if (!plan && planReasoning.trim()) {
    plan = parsePlanText(planReasoning);
    planFromReasoning = !!plan;
  }
  // Retry once with reasoning DISABLED: when the first attempt produced no
  // parseable plan (e.g. the whole budget spent thinking), a non-reasoning
  // call forces the answer into the content channel with a fresh budget.
  if (!plan) {
    ctx.print('[Phase 1] No parseable plan from content or reasoning - retrying with reasoning disabled...');
    try {
      const retry = await planCall(false);
      plan = parsePlanText(retry.raw);
      if (!plan && retry.reasoning.trim()) plan = parsePlanText(retry.reasoning);
    } catch (err) {
      ctx.print(`[Phase 1] retry planning call failed: ${err.message}`);
    }
  }

  // Validate the parsed plan against the real file index: if < 50% of the
  // planned paths resolve to real files/directories the model hallucinated
  // paths or the parser picked up prose — discard and fall back.
  if (plan && plan.length > 0) {
    if (hierarchical) {
      // Directory-level plan: expand to concrete files now.
      const expanded = expandDirPlan(plan, dirMap);
      if (expanded.length === 0) {
        ctx.print('[Phase 1] Directory plan resolved to no files - discarding.');
        plan = null;
      } else {
        plan = expanded;
        ctx.print(`[Phase 1] LLM plan parsed: ${plan.length} file batches (expanded from a directory-level plan).`);
      }
    } else if (scopedRt?.files?.byId) {
      const realPaths = new Set(Object.values(scopedRt.files.byId).map(f => f.path).filter(Boolean));
      let plannedTotal = 0;
      let resolved = 0;
      for (const b of plan) {
        for (const fp of b.files || []) {
          plannedTotal++;
          const clean = fp.replace(/^\.\//, '');
          if (realPaths.has(clean)) { resolved++; continue; }
          for (const rp of realPaths) {
            if (rp === clean || rp.endsWith('/' + clean) || clean.endsWith('/' + rp)) { resolved++; break; }
          }
        }
      }
      const hitRate = plannedTotal > 0 ? resolved / plannedTotal : 0;
      if (hitRate < 0.5) {
        ctx.print(`[Phase 1] Parsed ${plan.length} batches, but only ${resolved}/${plannedTotal} planned paths resolve to real files (${Math.round(hitRate * 100)}%).`);
        ctx.print('[Phase 1] Discarding LLM plan — using directory-based grouping as fallback.');
        plan = null;
      } else {
        ctx.print(`[Phase 1] LLM plan parsed: ${plan.length} batches (${planFromReasoning ? 'from reasoning' : 'from content'}, ${resolved}/${plannedTotal} paths resolve).`);
      }
    } else if (plan.length > 0) {
      ctx.print(`[Phase 1] LLM plan parsed: ${plan.length} batches (${planFromReasoning ? 'from reasoning' : 'from content'}).`);
    }
  }

  // Fallback: deterministic directory-tree grouping. Every indexed file in
  // scope is covered by exactly one batch, so the study ALWAYS proceeds.
  if (!plan || plan.length === 0) {
    if (!plan) {
      ctx.print('[Phase 1] LLM produced no usable plan - proceeding with deterministic directory grouping (full coverage guaranteed).');
    }
    plan = dirTreePlan(scopedRt);
  }

  ctx.print('');
  ctx.print(`[Phase 1] Study plan: ${plan.length} batches`);
  for (let i = 0; i < plan.length; i++) {
    const b = plan[i];
    ctx.print(`  [${i + 1}/${plan.length}] ${b.topic}: ${b.description || ''} (${(b.files || []).length} files)`);
  }
  ctx.print('');

  // ---- Phase 2: Execute each planned batch ----
  ctx.print(`[Phase 2: Execution] Per-batch budget: ${perBatchChars} chars`);
  ctx.print('');

  const fileIndex = new Map();
  if (scopedRt?.files?.byId) {
    for (const f of Object.values(scopedRt.files.byId)) {
      if (f.path) fileIndex.set(f.path, f);
    }
  }

  for (let batchIdx = 0; batchIdx < plan.length; batchIdx++) {
    const batch = plan[batchIdx];
    ctx.setPhase?.(`studying [${batchIdx + 1}/${plan.length}] ${batch.topic}`);
    ctx.print(`--- [${batchIdx + 1}/${plan.length}] ${batch.topic}: ${batch.description || ''} ---`);

    const sources = await readPlannedFiles(p, batch.files || [], fileIndex, perBatchChars);
    if (sources.length === 0) {
      ctx.print('  (no readable files — skipping)');
      continue;
    }
    // Budget enforcement: oversized batches are studied in sub-groups.
    const groups = groupByBudget(sources, perBatchChars);
    for (let gi = 0; gi < groups.length; gi++) {
      if (groups.length > 1) {
        ctx.print(`  sub-batch ${gi + 1}/${groups.length}: ${groups[gi].map(s => s.path).join(', ')}`);
      }
      await studySources(groups[gi], batch.topic, batch.description || '', 'code');
      studiedBatches++;
    }
  }

  ctx.setPhase?.('idle');
  ctx.print('');
  ctx.print('=== /kb knowledge learn complete ===');
  ctx.print(`  mode: code${baseDir ? ` (scoped to ${baseDir}/)` : ''}`);
  ctx.print(`  batches studied: ${studiedBatches}`);
  ctx.print(`  total proposed: ${totalProposed}`);
  ctx.print(`  total accepted: ${totalAccepted}`);
  ctx.print(`  total discarded: ${totalDiscarded}`);
  if (dryRun) {
    ctx.print(`  [dry-run] ${totalAccepted} entries would have been validated & written.`);
  } else if (totalSaved > 0) {
    const parts = [];
    if (savedHoly > 0) parts.push(`${savedHoly} holy`);
    if (savedEden > 0) parts.push(`${savedEden} eden`);
    ctx.print(`  saved: ${parts.join(', ')} (${totalSaved} total, incl. in-place updates).`);
  } else {
    ctx.print('  (no entries saved)');
  }
}

// File formats learnable via /kb knowledge learn (in addition to code-indexed
// ones). Kept in sync with doc_parser.DOC_EXTS but limited to the human-readable
// document types the user asked for: Markdown, PDF, Word, PowerPoint.
const LEARN_DOC_EXTS = new Set(['md', 'markdown', 'pdf', 'doc', 'docx', 'ppt', 'pptx']);

/**
 * Scale the plan-output budget with the number of files being planned. The
 * plan must enumerate every file, so the output budget must grow with the
 * map size (old fixed 8192/65536 budgets truncated large plans and caused
 * "Could not parse LLM study plan." failures on big projects).
 */
function planningBudgetFor(fileCount) {
  const n = Math.max(1, fileCount || 1);
  return Math.max(65536, Math.min(500000, n * 120));
}

/**
 * Scale-aware batch-count guidance for the code-mode planning prompt. Hard-
 * coding "5-30 batches" caps coverage at 900 files — impossible for projects
 * like postgres (~3500 files) and makes reasoning models deviate from the
 * output format.
 */
function batchGuidanceFor(fileCount) {
  const maxFilesPerBatch = 30;
  if (fileCount > maxFilesPerBatch * 30) {
    return `Aim for ${Math.ceil(fileCount / maxFilesPerBatch)} batches so every file is covered (the map has ${fileCount} files).`;
  }
  return 'Aim for 5-30 batches.';
}

/**
 * System prompt for the per-batch extraction phase of /kb knowledge learn.
 * Parameterized by target space so the model writes the right kind of entry.
 */
function buildLearnExtractSysPrompt(space, holySummary, edenSummary, userPrompt, sourceKind = 'doc') {
  const spaceGuidance = space === 'holy'
    ? `The target space is HOLY - stable design knowledge that rarely changes: architecture, core algorithms, fundamental patterns, design principles. Only write genuinely stable, reusable design knowledge. If a source only contains ephemeral details (config values, version lists, one-off notes), return [].`
    : `The target space is EDEN - frequently-updated knowledge: API/command catalogs, function lists, module summaries, observed patterns, how-to checklists. Things that may evolve are welcome.`;
  const sourceLine = sourceKind === 'code'
    ? `You are analyzing SOURCE CODE files from a software project to extract reusable knowledge entries for the project's KB ${space.toUpperCase()} Space.`
    : `You are analyzing documents (PDF / Word / PowerPoint / Markdown) to extract reusable knowledge entries for the project's KB ${space.toUpperCase()} Space.`;
  const groundingRule = sourceKind === 'code'
    ? `- Use REAL identifiers and file paths from the provided source code. Never invent symbol names or paths.`
    : `- Ground every entry in the ACTUAL document contents provided. Quote real terms and commands.`;
  const aim = sourceKind === 'code' ? '1-5' : '1-6';
  const introHint = sourceKind === 'code'
    ? `"intro": "2-5 paragraph prose explaining this knowledge; include key names, functions, and patterns; state WHERE the knowledge lives (file paths / function names) so a future reader can navigate to it",`
    : `"intro": "2-5 paragraph prose explaining this knowledge; include key names, commands, and patterns mentioned in the sources",`;
  const keyFilesHint = sourceKind === 'code'
    ? `"keyFiles": ["project-relative source file paths"],`
    : `"keyFiles": ["document-relative paths or source file references"],`;
  const keySymbolsHint = sourceKind === 'code'
    ? `"keySymbols": ["function/type/macro names"],`
    : `"keySymbols": ["named entities / functions / commands / terms"],`;
  return `${sourceLine}

${spaceGuidance}

For each piece of knowledge, decide whether it belongs in ${space.toUpperCase()}:
- Stable design knowledge (architecture, algorithms)? -> ${space === 'holy' ? 'INCLUDE' : 'SKIP (that is Holy Space)'}.
- Catalog / list / summary that may change? -> ${space === 'eden' ? 'INCLUDE' : 'SKIP (that is Eden Space)'}.

Output STRICT JSON array:
[
  {
    "id": "kebab-case-id",
    "title": "human-readable title",
${introHint}
${keyFilesHint}
${keySymbolsHint}
    "keywords": ["english search terms"]
  }
]

Rules:
${groundingRule}
- Each entry must be a DISTINCT, self-contained topic a future reader can act on. Do not produce overlapping entries.
- Do NOT duplicate existing Holy or Eden entries.
- Aim for ${aim} entries per batch. Quality over quantity.
- If no extractable ${space} knowledge, return [].

Existing Holy entries (DO NOT duplicate):
${holySummary || '(none)'}

Existing Eden entries (DO NOT duplicate):
${edenSummary || '(none)'}${userPrompt ? `\nAdditional user instructions (follow these when extracting knowledge):\n${userPrompt}` : ''}`;
}


/**
 * Parse an LLM extraction response as a JSON array, tolerating the usual
 * wrapping artifacts: fenced ```json blocks, leading/trailing prose, and the
 * case where a reasoning model put the array in the reasoning channel behind
 * an empty content ack. Returns null when nothing parseable is found.
 */
function parseJsonArrayLoose(content, reasoning = '') {
  const tryParse = (text) => {
    if (!text || !text.trim()) return null;
    // Strip fenced blocks first: ```json\n[...]\n``` -> [...]
    const fenced = extractFencedBlocks(text);
    const candidates = [fenced, text].filter(c => c && c.trim());
    for (const cand of candidates) {
      try {
        const v = JSON.parse(cand);
        if (Array.isArray(v)) return v;
      } catch {}
      // Slice the outermost [...] span (skips prose around the array).
      const m = cand.match(/\[[\s\S]*\]/);
      if (m) {
        try {
          const v = JSON.parse(m[0]);
          if (Array.isArray(v)) return v;
        } catch {}
      }
    }
    return null;
  };
  return tryParse(content) ?? tryParse(reasoning);
}

/**
 * Recursively walk a directory and return absolute paths of files whose
 * extension is learnable (Markdown/PDF/Word/PowerPoint + text-ish doc types).
 * Unsupported files are collected into `unsupported` for reporting.
 */
async function walkLearnFiles(root, unsupported) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue; // skip hidden files/dirs
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      const sub = await walkLearnFiles(full, unsupported);
      out.push(...sub);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (isLearnableExt(ext)) out.push(full);
      else unsupported.push(full);
    }
  }
  return out;
}

function isLearnableExt(ext) {
  if (!ext) return false;
  if (LEARN_DOC_EXTS.has(ext)) return true;
  // Also accept the text-ish doc types doc_parser already understands.
  return ['txt', 'rst', 'adoc', 'json', 'yaml', 'yml', 'html', 'htm', 'sgml'].includes(ext);
}

/**
 * Ensure every parsed file appears in at least one batch. Files the LLM
 * omitted get their own single-file batch (topic = filename stem).
 */
function reconcilePlan(plan, parsedFiles) {
  if (!Array.isArray(plan)) plan = [];
  const seen = new Set();
  for (const b of plan) {
    for (const f of b.files || []) seen.add(f);
  }
  const missing = parsedFiles.filter(f => !seen.has(f.path));
  for (const f of missing) {
    plan.push({ topic: f.path.replace(/\.[^.]+$/, ''), description: `single-file fallback for ${f.path}`, files: [f.path] });
  }
  // Drop batches that reference no known files (hallucinated paths).
  const labels = new Set(parsedFiles.map(f => f.path));
  return plan
    .map(b => ({ ...b, files: (b.files || []).filter(f => labels.has(f) || findByLabelStr(parsedFiles, f)) }))
    .filter(b => (b.files || []).length > 0);
}

function findByLabel(map, rel) {
  if (map.has(rel)) return map.get(rel);
  for (const [k, v] of map) {
    if (labelMatches(k, rel)) return v;
  }
  return null;
}

function findByLabelStr(parsedFiles, rel) {
  for (const f of parsedFiles) {
    if (labelMatches(f.path, rel)) return true;
  }
  return false;
}

/**
 * Strip a chunk-part suffix (".part2") from a manifest label so a chunk label
 * ("book.pdf.part2") and its base label ("book.pdf") compare equal.
 */
function stripPartSuffix(label) {
  return String(label).replace(/\.part\d+$/i, '');
}

/**
 * Lenient label comparison used when resolving LLM-echoed file references back
 * to parsed entries. Handles: exact matches, chunk labels vs their base label
 * (".partN" suffix), relative-path prefixes, filenames containing spaces (the
 * planner often echoes only the tail, e.g. "PostgreSQL.pdf" for "The Internals
 * of PostgreSQL.pdf.part1"), and plain basenames.
 */
function labelMatches(stored, rel) {
  if (stored === rel) return true;
  const kb = stripPartSuffix(stored);
  const rb = stripPartSuffix(rel);
  if (kb === rb) return true;
  if (kb.endsWith('/' + rb) || rb.endsWith('/' + kb)) return true;
  if (kb.endsWith(rb) || rb.endsWith(kb)) return true;
  return path.basename(kb) === path.basename(rb);
}

/**
 * Split a long document's text into sequential chunks, each no larger than
 * `maxChars`, so every part of a large file (e.g. a 12-chapter book) is fed to
 * the model. Chunks break on line boundaries near the window edge so
 * paragraphs/headings aren't cut mid-line, and a small overlap tail ensures
 * content right at a boundary is visible to both neighboring chunks.
 *
 * Returns [{ text, start, end }] - a single chunk when the text already fits.
 */
function chunkDocText(text, maxChars = 100000, overlapChars = null) {
  const src = String(text || '').trim();
  if (!src) return [];
  if (src.length <= maxChars) return [{ text: src, start: 0, end: src.length }];
  const overlap = overlapChars == null
    ? Math.min(2000, Math.max(200, Math.floor(maxChars * 0.02)))
    : overlapChars;
  const chunks = [];
  let start = 0;
  while (start < src.length) {
    const windowEnd = Math.min(start + maxChars, src.length);
    let cut = windowEnd;
    if (windowEnd < src.length) {
      // Prefer the last newline within [windowEnd - overlap, windowEnd) so we
      // don't split mid-line.
      const searchFrom = Math.max(start + 1, windowEnd - overlap);
      const nl = src.lastIndexOf('\n', windowEnd - 1);
      if (nl >= searchFrom) cut = nl + 1;
    }
    if (cut <= start) cut = start + 1; // safety: always advance
    chunks.push({ text: src.slice(start, cut), start, end: cut });
    if (cut >= src.length) break;
    start = Math.max(start + 1, cut - overlap); // overlap tail into next chunk
  }
  return chunks;
}

/**
 * Group a batch's source entries into sub-groups whose cumulative char count
 * stays within `budget`. Guarantees the per-batch context passed to the model
 * never silently truncates content (Phase 2 budget enforcement).
 */
function groupByBudget(sources, budget) {
  const groups = [];
  let cur = [];
  let curChars = 0;
  for (const s of sources) {
    const c = (s.text || '').length;
    if (cur.length > 0 && curChars + c > budget) {
      groups.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += c;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}


/**
 * Parse the LLM's pipe-delimited plan output into batch objects.
 * Accepts both content and reasoning text. Handles:
 *   - "topic | description | file1.c, file2.c"
 *   - Lines without pipes (tries to split by whitespace)
 *   - Lines embedded in prose (extracts only lines with file paths)
 *   - JSON arrays (legacy fallback)
 */
function parsePlanText(text) {
  if (!text || !text.trim()) return null;

  // Try JSON first (legacy format)
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json) && json.length > 0 && json[0].topic) return json;
  } catch {}
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const json = JSON.parse(jsonMatch[0]);
      if (Array.isArray(json) && json.length > 0 && json[0].topic) return json;
    } catch {}
  }

  // Normalize reasoning-model artifacts before line parsing:
  //   - full-width pipe '｜' / comma '，' / enumeration comma '、' used by some
  //     Chinese reasoning models
  //   - fenced code blocks (```text ... ```) that wrap the plan
  const normalized = text
    .replace(/｜/g, '|')
    .replace(/，/g, ',')
    .replace(/、/g, ',');
  const fenced = extractFencedBlocks(normalized);
  const source = fenced.length > 0 ? fenced : normalized;

  // Parse pipe-delimited format only: `topic | description | file1.c, file2.c`
  //
  // We deliberately do NOT accept a space/tab-delimited fallback. When the
  // model puts its plan in the reasoning channel (common for reasoning-mode
  // models), the text is prose and ANY line containing a file-like token
  // would otherwise be picked up as a batch — producing garbage topics
  // named after random words in the prose ("files", "hmm", "so", etc.).
  // If the model doesn't follow the pipe-delimited spec, we return null
  // and the caller falls back to directory-based grouping.
  const batches = [];
  const lines = source.split('\n');
  // A pipe-delimited plan line needs at least TWO pipes (topic | desc | files).
  // A single pipe is more likely prose ("either x | y" or a markdown table row
  // header) than a real plan line — require three fields.
  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    // Strip a markdown table's leading/trailing pipes so `| a | b | c |` and
    // `a | b | c` parse identically.
    trimmed = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    if (!trimmed.includes('|')) continue;
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length < 3) continue;

    const topic = parts[0]
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    if (!topic) continue;

    const description = parts[1] || '';
    const filesStr = parts.slice(2).join('|');
    const files = filesStr
      .split(/[;,\s]+/)
      .map(s => s.replace(/^\.?\/+/, '').trim())
      .filter(f => f && /\.[a-z0-9]+$/i.test(f));
    if (files.length === 0) continue;

    batches.push({ topic, description, files });
  }

  return batches.length > 0 ? batches : null;
}

/**
 * Extract the contents of triple-backtick fenced code blocks. Reasoning models
 * often wrap their structured answer in ```text ... ```; parsing only the fence
 * contents avoids picking up surrounding prose.
 */
function extractFencedBlocks(text) {
  const blocks = [];
  const re = /```[a-zA-Z]*\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[1].trim()) blocks.push(m[1].trim());
  }
  return blocks.join('\n');
}

function buildProjectMap(rt) {
  if (!rt || !rt.files) return { text: '', fileCount: 0, dirCount: 0 };
  // Iterate entries (not values) so we retain the fileId key: file objects in
  // rt.files.byId carry {path,hash,...} but NO `id` field, and symbolsByFile is
  // keyed by the numeric fileId. Using f.id (undefined) silently dropped all
  // per-file symbol names from the planner map.
  const entries = Object.entries(rt.files.byId || {}).sort((a, b) => (a[1].path || '').localeCompare(b[1].path || ''));
  const lines = [];
  const dirs = new Set();
  for (const [id, f] of entries) {
    if (!f.path) continue;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(root)';
    dirs.add(dir);
    const syms = rt.symbolsByFile?.get(Number(id)) || rt.symbolsByFile?.get(id) || [];
    const symNames = syms.slice(0, 8).map(s => s.name).filter(Boolean).join(', ');
    lines.push(`${f.path} (${f.symbolCount || syms.length || 0} syms${symNames ? ': ' + symNames : ''})`);
  }
  return { text: lines.join('\n'), fileCount: entries.length, dirCount: dirs.size };
}

/**
 * Build a scoped runtime view containing only files under `baseDir` (a path
 * in the indexed-file coordinate system: relative to sourcePath + sourceRoot,
 * forward-slash separated). Used by `/kb knowledge init --base-dir=PATH` so
 * that Phase 1 planning + Phase 2 execution only see the chosen subdirectory.
 *
 * Returns an object shaped like ctx.rt with `files`, `symbolsByFile`, and
 * `callgraph` references filtered to the scoped file ids. The original runtime
 * (ctx.rt) is never mutated; we only construct shallow filtered containers.
 */
function buildScopedRt(rt, baseDir) {
  if (!rt || !rt.files || !baseDir) return rt;
  const prefix = baseDir.endsWith('/') ? baseDir : baseDir + '/';
  // Match files whose path equals baseDir (a file) or sits under baseDir/.
  const matchPath = (fp) => !!fp && (fp === baseDir || fp.startsWith(prefix));

  const scopedById = {};
  const scopedByPath = {};
  const scopedSymbolsByFile = new Map();
  for (const [id, f] of Object.entries(rt.files.byId || {})) {
    if (!matchPath(f.path)) continue;
    scopedById[id] = f;
    scopedByPath[f.path] = Number(id);
    const syms = rt.symbolsByFile?.get(Number(id)) || rt.symbolsByFile?.get(id) || [];
    if (syms.length) scopedSymbolsByFile.set(Number(id), syms);
  }
  return {
    ...rt,
    files: { byId: scopedById, byPath: scopedByPath, nextId: rt.files.nextId },
    symbolsByFile: scopedSymbolsByFile,
    // Keep the callgraph reference; it is only consulted for symbols that
    // belong to scoped files, and the surrounding code tolerates edges that
    // point outside the scope.
    callgraph: rt.callgraph,
  };
}

/**
 * Read files listed in a planned batch.
 */
async function readPlannedFiles(project, plannedPaths, fileIndex, maxChars) {
  const collected = [];
  let totalChars = 0;
  for (const relPath of plannedPaths) {
    if (totalChars >= maxChars) break;
    const cleanPath = relPath.replace(/^\.\//, '');
    let fileMeta = fileIndex.get(cleanPath);
    if (!fileMeta) {
      for (const [idx, f] of fileIndex) {
        if (idx === cleanPath || idx.endsWith('/' + cleanPath) || cleanPath.endsWith('/' + idx)) {
          fileMeta = f; break;
        }
      }
    }
    // fileIndex is the scope authority: under --base-dir it only contains
    // files under the chosen directory, so skipping unknown paths prevents the
    // LLM plan from pulling in out-of-scope files via disk reads. Without
    // --base-dir, fileIndex holds all indexed files, so hallucinated paths
    // are skipped too.
    if (!fileMeta) continue;
    const abs = path.join(project.sourcePath, project.sourceRoot || '', fileMeta.path);
    try {
      const content = await fs.readFile(abs, 'utf8');
      const remaining = maxChars - totalChars;
      const trimmed = content.length > remaining
        ? content.slice(0, remaining) + '\n/* ... truncated ... */'
        : content;
      collected.push({ path: fileMeta.path, content: trimmed, symbolCount: fileMeta.symbolCount || 0 });
      totalChars += trimmed.length;
    } catch {}
  }
  return collected;
}


/**
 * Cross-check proposed entries against Holy and existing Eden.
 */
function crossCheckEntries(proposed, holy, eden) {
  const all = [...holy, ...eden];
  const ids = new Set(all.map(e => e.id));
  const titles = all.map(e => ({ id: e.id, title: (e.title || '').toLowerCase(), keywords: new Set((e.keywords || []).map(k => k.toLowerCase())) }));
  const accepted = [];
  const discarded = [];
  for (const entry of proposed) {
    if (!entry.id || !entry.title || !entry.intro) {
      discarded.push({ id: entry.id || '?', reason: 'missing required fields' });
      continue;
    }
    if (ids.has(entry.id)) {
      discarded.push({ id: entry.id, reason: 'id already exists' });
      continue;
    }
    const pTitle = (entry.title || '').toLowerCase();
    const pKws = new Set((entry.keywords || []).map(k => k.toLowerCase()));
    let conflict = null;
    for (const t of titles) {
      if (t.title && (pTitle.includes(t.title) || t.title.includes(pTitle))) { conflict = t.id; break; }
      if (pKws.size > 0 && t.keywords.size > 0) {
        let ov = 0;
        for (const k of pKws) if (t.keywords.has(k)) ov++;
        if (ov / Math.min(pKws.size, t.keywords.size) > 0.6) { conflict = t.id; break; }
      }
    }
    if (conflict) {
      discarded.push({ id: entry.id, reason: `conflicts with "${conflict}"` });
      continue;
    }
    accepted.push(entry);
  }
  return { accepted, discarded };
}

// (Old single-pass helpers buildFileManifest / collectKeySources removed —
// replaced by the iterative approach above.)

/**
 * Group indexed files by top-level directory (module).
 * Used as a fallback when the LLM planning phase fails to produce JSON.
 */
function groupFilesByModule(rt) {
  if (!rt || !rt.files) return [];
  const groups = new Map();
  for (const f of Object.values(rt.files.byId || {})) {
    if (!f.path) continue;
    const topDir = f.path.split('/')[0] || '(root)';
    if (!groups.has(topDir)) groups.set(topDir, { name: topDir, files: [], symbolCount: 0 });
    const g = groups.get(topDir);
    g.files.push({ path: f.path, fileId: f.id, symbolCount: f.symbolCount || 0 });
    g.symbolCount += f.symbolCount || 0;
  }
  return Array.from(groups.values()).sort((a, b) => b.symbolCount - a.symbolCount);
}

/**
 * Build a DIRECTORY-level map for hierarchical planning on large projects.
 * Returns { text, dirCount, fileCount, dirs: [{ dir, fileCount, symbolCount, files }] }.
 *
 * On postgres (~2620 files / ~423k chars for the full file map) asking the LLM
 * to enumerate every file makes reasoning models burn their whole budget in
 * the reasoning channel (82KB of thought, ZERO content) before writing a
 * single plan line — the direct cause of "Could not parse LLM study plan.".
 * The directory map is ~10-30x smaller; the LLM groups DIRECTORIES into
 * topics and every file assignment below that is deterministic.
 */
function buildDirMap(rt) {
  if (!rt || !rt.files) return { text: '', dirCount: 0, fileCount: 0, dirs: [] };
  const dirs = new Map(); // dir -> { fileCount, symbolCount, files: [] }
  let fileCount = 0;
  for (const f of Object.values(rt.files.byId || {})) {
    if (!f.path) continue;
    fileCount++;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(root)';
    if (!dirs.has(dir)) dirs.set(dir, { dir, fileCount: 0, symbolCount: 0, files: [] });
    const d = dirs.get(dir);
    d.fileCount++;
    d.symbolCount += f.symbolCount || 0;
    d.files.push(f.path);
  }
  const list = Array.from(dirs.values()).sort((a, b) => a.dir.localeCompare(b.dir));
  const lines = list.map(d => `${d.dir}/ (${d.fileCount} files, ${d.symbolCount} syms)`);
  return { text: lines.join('\n'), dirCount: list.length, fileCount, dirs: list };
}

/**
 * Expand a directory-level LLM plan into a file-level plan.
 * Each batch lists directories (with a trailing '/' or matching a known dir);
 * this replaces them with the concrete files under each directory, splitting
 * mega-batches so Phase 2 stays within the per-batch char budget.
 */
function expandDirPlan(dirPlan, dirMap, maxFilesPerBatch = 30) {
  const byDir = new Map(dirMap.dirs.map(d => [d.dir, d]));
  const out = [];
  for (const batch of dirPlan) {
    const files = [];
    let desc = batch.description || '';
    for (const token of batch.files || []) {
      const clean = String(token).replace(/\/+$/, '').replace(/^\.?\/+/, '');
      const d = byDir.get(clean);
      if (d) {
        files.push(...d.files);
        continue;
      }
      // The LLM may echo a file path directly — keep it if it exists.
      if (dirMap.dirs.some(dd => dd.files.includes(clean))) files.push(clean);
    }
    if (files.length === 0) continue;
    // Split mega-batches: every file is covered, batches stay digestible.
    const unique = [...new Set(files)];
    for (let i = 0; i < unique.length; i += maxFilesPerBatch) {
      const slice = unique.slice(i, i + maxFilesPerBatch);
      const suffix = unique.length > maxFilesPerBatch ? ` [${Math.floor(i / maxFilesPerBatch) + 1}/${Math.ceil(unique.length / maxFilesPerBatch)}]` : '';
      out.push({ topic: batch.topic + (suffix ? '-' + suffix.match(/\d+\/\d+/)[0].split('/')[0] : ''), description: desc + suffix, files: slice });
    }
    desc = desc; // keep linters quiet about reassignment style
  }
  return out;
}

/**
 * Deterministic fallback plan from the directory tree: every file under a
 * directory goes to that directory's batch, and large directories are split
 * into <= maxFilesPerBatch chunks. This replaces the old top-level-only
 * grouping that turned postgres into two 2400-file mega-batches.
 */
function dirTreePlan(rt, maxFilesPerBatch = 30) {
  const dirMap = buildDirMap(rt);
  const out = [];
  for (const d of dirMap.dirs) {
    const topicBase = d.dir.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';
    for (let i = 0; i < d.files.length; i += maxFilesPerBatch) {
      const slice = d.files.slice(i, i + maxFilesPerBatch);
      const part = d.files.length > maxFilesPerBatch ? `-p${Math.floor(i / maxFilesPerBatch) + 1}` : '';
      out.push({
        topic: topicBase + part,
        description: `${d.dir}/ (${d.fileCount} files, ${d.symbolCount} syms)${part ? ` part ${Math.floor(i / maxFilesPerBatch) + 1}` : ''}`,
        files: slice,
      });
    }
  }
  return out;
}

/**
 * /kb knowledge export <eden|holy|all> <path>
 *
 * Writes all entries from the specified space(s) to a JSON file. Each entry
 * carries its source `space` field so that `import adaptive` can route
 * entries back to the correct space automatically.
 *
 * Output format (version 2):
 *   { "version": 2, "exportedAt": "...", "project": "name",
 *     "spaces": { "holy": N, "eden": M },
 *     "entryCount": N+M,
 *     "entries": [ { ...entry, "space": "holy"|"eden" }, ... ] }
 */

/**
 * /kb knowledge empty <eden|holy|all>
 *
 * Removes every ORDINARY entry from the specified space(s); the Supreme Code
 * entry is preserved. Irreversible.
 * ALWAYS prompts y/N, regardless of env vars.
 */
async function knowledgeEmptyKb(rest, ctx) {
  const scope = rest[0];
  if (!scope || !['eden', 'holy', 'all'].includes(scope)) {
    ctx.print(`Usage: /kb knowledge empty <eden|holy|all>`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;

  const spaces = scope === 'all' ? ['holy', 'eden'] : [scope];
  let totalCount = 0;
  const counts = {};
  for (const space of spaces) {
    const entries = await listKnowledge(p.id, space).catch(() => []);
    const filtered = entries.filter(e => !isSupremeCode(e.id));
    counts[space] = filtered.length;
    totalCount += filtered.length;
  }

  if (totalCount === 0) {
    ctx.print(`Selected space(s) already empty.`);
    return;
  }

  const breakdown = spaces.map(s => `${s}=${counts[s]}`).join(', ');
  ctx.print(`This will permanently delete ${totalCount} entries (${breakdown}).`);
  ctx.print(`This action is IRREVERSIBLE.`);
  const ok = await ctx.confirm(`Empty ${scope} space(s)? (y/N) `, { title: 'Empty space' });
  if (!ok) {
    ctx.print(`Cancelled.`);
    return;
  }

  const { deleteKnowledge } = await import('../../lib/store/kb_store.js');
  const { getRuntime, dropRuntime } = await import('../../lib/retrieval/kb_runtime.js');
  let removed = 0;
  for (const space of spaces) {
    const entries = await listKnowledge(p.id, space).catch(() => []);
    for (const e of entries) {
      if (e.id && !isSupremeCode(e.id)) {
        await deleteKnowledge(p.id, space, e.id);
        removed++;
      }
    }
  }
  dropRuntime(p.id);
  ctx.print(`Emptied: removed ${removed} entries from ${breakdown} (supreme-code entry preserved).`);
}

async function knowledgeExportKb(rest, ctx) {
  const flags = parseFlags(rest);
  const scope = flags.positional[0];
  const exportPath = flags.positional[1];
  if (!scope || !['eden', 'holy', 'all'].includes(scope)) {
    ctx.print(`Usage: /kb knowledge export <eden|holy|all> <path>`);
    return;
  }
  if (!exportPath) {
    ctx.print(`Usage: /kb knowledge export ${scope || '<eden|holy|all>'} <path>`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;

  const spaces = scope === 'all' ? ['holy', 'eden'] : [scope];
  const allEntries = [];
  const spaceCounts = {};
  for (const space of spaces) {
    const entries = await listKnowledge(p.id, space).catch(() => []);
    spaceCounts[space] = entries.length;
    ctx.print(`[${space}] ${entries.length} entries`);
    for (const e of entries) {
      allEntries.push({ ...e, space });
    }
  }

  if (allEntries.length === 0) {
    ctx.print(`(nothing to export — selected space(s) are empty)`);
    return;
  }

  const { writeFileAtomic } = await import('../../lib/util/fs_atomic.js');
  const absPath = path.resolve(exportPath);
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    project: p.name,
    spaces: spaceCounts,
    entryCount: allEntries.length,
    entries: allEntries,
  };
  await writeFileAtomic(absPath, JSON.stringify(payload, null, 2));
  ctx.print(``);
  ctx.print(`Exported ${allEntries.length} entries to: ${absPath}`);
  ctx.print(`  size: ${(JSON.stringify(payload).length / 1024).toFixed(1)} KB`);
  const breakdown = Object.entries(spaceCounts).map(([k, v]) => `${k}=${v}`).join(', ');
  ctx.print(`  spaces: ${breakdown}`);
}

/**
 * /kb knowledge import <path> [eden|holy|adaptive] [--overwrite]
 *
 * Reads a JSON file and imports entries into the target space.
 *
 * Target modes:
 *   eden        — all entries go to Eden (default)
 *   holy        — all entries go to Holy (ALWAYS prompts y/N)
 *   adaptive    — each entry goes to its original `space` field from the
 *                 export file. Entries without a `space` field default to Eden.
 *                 Holy-bound entries still get a y/N confirmation as a batch.
 *
 * --overwrite: replace existing entries with the same id.
 *
 * Examples:
 *   /kb knowledge import /tmp/pg-kb.json adaptive
 *   /kb knowledge import /tmp/pg-kb.json eden --overwrite
 *   /kb knowledge import /tmp/holy-backup.json holy
 */
async function knowledgeImportKb(rest, ctx) {
  const flags = parseFlags(rest);
  const importPath = flags.positional[0];
  const targetMode = flags.positional[1] || 'eden';
  const overwrite = !!flags.overwrite;
  if (!importPath) {
    ctx.print(`Usage: /kb knowledge import <path> [eden|holy|adaptive] [--overwrite]`);
    return;
  }
  if (!['eden', 'holy', 'adaptive'].includes(targetMode)) {
    ctx.print(`Target must be 'eden', 'holy', or 'adaptive' (got: ${targetMode}).`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;

  const absPath = path.resolve(importPath);
  let payload;
  try {
    const text = await fs.readFile(absPath, 'utf8');
    payload = JSON.parse(text);
  } catch (err) {
    ctx.print(`Failed to read/parse ${absPath}: ${err.message}`);
    return;
  }

  let entries;
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload && Array.isArray(payload.entries)) {
    entries = payload.entries;
  } else {
    ctx.print(`File does not contain a JSON array or {entries: [...]} object.`);
    return;
  }

  if (entries.length === 0) {
    ctx.print(`File contains 0 entries — nothing to import.`);
    return;
  }

  // Determine target space per entry based on the import mode
  const routed = entries.map(e => {
    let space;
    if (targetMode === 'adaptive') {
      space = (e.space === 'holy') ? 'holy' : 'eden';
    } else {
      space = targetMode;
    }
    return { entry: e, space };
  });

  // Load existing entries in both spaces for duplicate checking
  const existingHoly = await listKnowledge(p.id, 'holy').catch(() => []);
  const existingEden = await listKnowledge(p.id, 'eden').catch(() => []);
  const existingIds = {
    holy: new Set(existingHoly.map(e => e.id)),
    eden: new Set(existingEden.map(e => e.id)),
  };

  const toImport = [];
  const skipped = [];
  for (const { entry: e, space } of routed) {
    if (!e.id || !e.title || !e.intro) {
      skipped.push({ id: e.id || '?', reason: 'missing required fields' });
      continue;
    }
    if (isSupremeCode(e.id)) {
      skipped.push({ id: e.id, reason: 'supreme-code entry is managed only via /kb code add|del' });
      continue;
    }
    if (existingIds[space].has(e.id) && !overwrite) {
      skipped.push({ id: e.id, reason: `already exists in ${space} (use --overwrite)` });
      continue;
    }
    toImport.push({ entry: e, space });
  }

  // Summary
  const bySpace = { holy: 0, eden: 0 };
  for (const { space } of toImport) bySpace[space]++;

  ctx.print(`File: ${absPath}`);
  ctx.print(`Entries in file: ${entries.length}`);
  ctx.print(`Mode: ${targetMode}`);
  ctx.print(`To import: ${toImport.length} (holy=${bySpace.holy}, eden=${bySpace.eden})`);
  if (skipped.length > 0) {
    ctx.print(`Skipped: ${skipped.length}`);
    for (const s of skipped.slice(0, 10)) ctx.print(`  - ${s.id}: ${s.reason}`);
    if (skipped.length > 10) ctx.print(`  ... +${skipped.length - 10} more`);
  }

  if (toImport.length === 0) {
    ctx.print(`(nothing to import)`);
    return;
  }

  // Holy imports ALWAYS confirm
  if (bySpace.holy > 0) {
    ctx.print(``);
    ctx.print(`Note: ${bySpace.holy} entries will be imported to Holy Space.`);
    ctx.print(`These become part of the stable source of truth.`);
    const holyEntries = toImport.filter(t => t.space === 'holy');
    for (const { entry: e } of holyEntries.slice(0, 10)) {
      ctx.print(`  → ${e.id}: ${e.title || ''}`);
    }
    if (holyEntries.length > 10) ctx.print(`  ... +${holyEntries.length - 10} more`);
    const ok = await ctx.confirm(`Import ${bySpace.holy} entries to Holy? (y/N) `);
    if (!ok) {
      ctx.print(`Holy import cancelled. Importing only ${bySpace.eden} Eden entries.`);
      for (let i = toImport.length - 1; i >= 0; i--) {
        if (toImport[i].space === 'holy') toImport.splice(i, 1);
      }
    }
  }

  if (toImport.length === 0) {
    ctx.print(`(nothing left to import after Holy cancellation)`);
    return;
  }

  // Write
  const { writeKnowledge, readKnowledge } = await import('../../lib/store/kb_store.js');
  const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
  const rt = await getRuntime(p.id).catch(() => null);
  let imported = { holy: 0, eden: 0 };
  for (const { entry: e, space } of toImport) {
    const record = {
      id: e.id,
      title: e.title,
      intro: e.intro,
      keyFiles: Array.isArray(e.keyFiles) ? e.keyFiles : [],
      keySymbols: Array.isArray(e.keySymbols) ? e.keySymbols : [],
      keywords: Array.isArray(e.keywords) ? e.keywords : [],
    };
    await writeKnowledge(p.id, space, record);
    const final = await readKnowledge(p.id, space, e.id);
    if (final && rt) rt.reloadKnowledge?.(final, space);
    imported[space]++;
  }
  ctx.print(``);
  ctx.print(`Imported: holy=${imported.holy}, eden=${imported.eden}, total=${imported.holy + imported.eden}.`);
}

/**
 * /kb knowledge housekeep — LLM-assisted KB maintenance for one space
 * (eden | holy) or both (all).
 *
 * Usage:
 *   /kb knowledge housekeep <eden|holy|all> [--model=<provider>/<model-id>]
 *
 * Pipeline (all writes confirmed by the user; the permanent supreme-code
 * entry "hk2-supreme-code" is never touched):
 *
 *   Phase 1 (deterministic) — broken-entry scan (missing title/intro,
 *            duplicate ids) flagged for removal, y/N confirm. Same rules the
 *            old cleanup-only implementation used.
 *   Phase 2 (deterministic pre-filter + LLM) — near-duplicate / similar
 *            content clusters WITHIN a space are found cheaply first (title
 *            mutual containment or keyword overlap > 0.6 — the same
 *            thresholds as findHolyConflict / crossCheckEntries), then each
 *            candidate cluster is judged by the model: duplicate / similar /
 *            distinct. Duplicate & similar clusters get a merged entry which
 *            REPLACES all members (one write + deletes, y/N confirm; Holy
 *            asks with an "irreversible" warning).
 *   Phase 3 (scope=all only) — Eden entries that conflict with Holy entries
 *            (same pre-filter heuristic) are judged by the model: conflict /
 *            duplicate / complementary, with a suggested resolution. The user
 *            chooses per pair:
 *              1. stamp Eden supersededBy=holy:<id>   (Holy wins, Eden kept)
 *              2. delete the Eden entry               (Holy wins, Eden gone)
 *              3. merge Eden's unique content into the Holy entry (Holy is
 *                 REWRITTEN — needs its own y/N, Holy contract)
 *              4. skip
 *   Finally — if anything was written, both knowledge indexes
 *   (holy.idx.json / eden.idx.json) are rebuilt and the KB runtime cache is
 *   dropped so the next query sees fresh state.
 *
 * --model=<provider>/<model-id> selects the judging model (validated against
 * the registry); without it the current session model (ctx.llm) is used.
 */
async function knowledgeCleanupKb(rest, ctx) {
  const flags = parseFlags(rest);
  const scope = flags.positional[0];
  if (!scope || !['eden', 'holy', 'all'].includes(scope)) {
    ctx.print(`Usage: /kb knowledge housekeep <eden|holy|all> [--model=<provider>/<model-id>]`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;

  // ---- Model resolution: --model=<provider/model-id> wins, else ctx.llm ----
  const modelRef = typeof flags.model === 'string' ? flags.model : '';
  let llm = ctx.llm || null;
  if (modelRef) {
    try {
      const got = await resolveCodeGenLlm(ctx, modelRef);
      llm = got.llm;
      ctx.print(`[housekeep] model: ${modelRef}`);
    } catch (err) {
      ctx.print(`Error: ${err.message}`);
      return;
    }
  } else if (!llm) {
    ctx.print(`No LLM configured. Run /model add + /model set-default first, or pass --model=<provider>/<model-id>.`);
    return;
  }

  const spaces = scope === 'all' ? ['eden', 'holy'] : [scope];
  const { deleteKnowledge } = await import('../../lib/store/kb_store.js');
  const rt = await getRuntime(p.id).catch(() => null);

  let dirty = false;           // any write happened → rebuild indexes at the end
  let totalRemoved = 0;
  let totalMerged = 0;
  let totalStamps = 0;

  /* ================= Phase 1 + 2 per space ================= */
  for (const space of spaces) {
    const entries = await listKnowledge(p.id, space).catch(() => []);
    if (entries.length === 0) {
      ctx.print(`[${space}] 0 entries — nothing to housekeep.`);
      continue;
    }

    ctx.print(``);
    ctx.print(`[${space}] Scanning ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}...`);

    /* ---------- Phase 1: broken entries (deterministic) ---------- */
    const toRemove = [];
    const seenIds = new Set();
    for (const e of entries) {
      // The permanent supreme-code entry is never flagged for removal
      // (same exclusion as /kb knowledge empty; deleteKnowledge() also refuses it).
      if (isSupremeCode(e.id)) continue;
      const issues = [];
      if (!e.id) issues.push('missing id');
      else if (seenIds.has(e.id)) issues.push(`duplicate id "${e.id}"`);
      if (!e.title || !e.title.trim()) issues.push('missing title');
      if (!e.intro || !e.intro.trim()) issues.push('missing intro');
      if (e.id) seenIds.add(e.id);
      if (issues.length > 0) toRemove.push({ entry: e, reasons: issues });
    }
    if (toRemove.length > 0) {
      ctx.print(`  ${toRemove.length} broken entr${toRemove.length === 1 ? 'y' : 'ies'}:`);
      for (const { entry, reasons } of toRemove) {
        ctx.print(`    - ${entry.id || '(no id)'}: ${reasons.join('; ')}`);
      }
      const prompt = space === 'holy'
        ? `Remove these ${toRemove.length} Holy entr${toRemove.length === 1 ? 'y' : 'ies'}? This is irreversible. (y/N) `
        : `Remove these ${toRemove.length} Eden entr${toRemove.length === 1 ? 'y' : 'ies'}? (y/N) `;
      if (await ctx.confirm(prompt)) {
        let removed = 0;
        for (const { entry } of toRemove) {
          if (entry.id && await deleteKnowledge(p.id, space, entry.id)) removed++;
        }
        totalRemoved += removed;
        dirty = true;
        ctx.print(`  Removed ${removed} broken entr${removed === 1 ? 'y' : 'ies'}.`);
      } else {
        ctx.print(`  Skipped — broken entries kept.`);
      }
    }

    /* ---------- Phase 2: near-duplicate clusters (pre-filter → LLM) ---------- */
    const alive = entries.filter(e =>
      !isSupremeCode(e.id) && e.id && e.title && e.intro &&
      !toRemove.some(r => r.entry.id === e.id));
    const clusters = clusterSimilarEntries(alive);
    if (clusters.length === 0) {
      ctx.print(`  no near-duplicate candidates (${alive.length} entr${alive.length === 1 ? 'y' : 'ies'} scanned).`);
      continue;
    }
    ctx.print(`  ${clusters.length} similar-cluster candidate(s) — asking the model to judge...`);

    for (const cluster of clusters) {
      const verdict = await judgeCluster(llm, cluster);
      if (!verdict) {
        ctx.print(`  (judge unavailable for cluster [${cluster.map(e => e.id).join(', ')}] — skipping)`);
        continue;
      }
      if (verdict.relation === 'distinct') {
        ctx.print(`  [distinct] ${cluster.map(e => e.id).join(' + ')} — keep all.`);
        continue;
      }
      // duplicate | similar → merge proposal
      if (!verdict.merged || !verdict.merged.title || !verdict.merged.intro) {
        ctx.print(`  (${verdict.relation} but no usable merged entry for [${cluster.map(e => e.id).join(', ')}] — skipping)`);
        continue;
      }
      const label = verdict.relation === 'duplicate' ? 'DUPLICATE' : 'SIMILAR';
      ctx.print(`  [${label}] ${cluster.map(e => e.id).join(' + ')}`);
      printMergedPreview(ctx, verdict, cluster);
      let ok;
      if (space === 'holy') {
        ok = await ctx.confirm(`Replace these ${cluster.length} Holy entries with ONE merged entry? This is irreversible. (y/N) `, { title: 'Merge knowledge' });
      } else {
        ok = await ctx.confirm(`Replace these ${cluster.length} Eden entries with ONE merged entry? (y/N) `, { title: 'Merge knowledge' });
      }
      if (!ok) {
        ctx.print(`  Skipped.`);
        continue;
      }
      const primary = pickPrimary(cluster);
      const record = {
        ...primary,
        id: primary.id,
        space,
        title: verdict.merged.title,
        intro: verdict.merged.intro,
        keyFiles: uniqList(cluster, 'keyFiles'),
        keySymbols: uniqList(cluster, 'keySymbols'),
        // Union of the members' keywords PLUS the model's fused keywords —
        // printMergedPreview shows merged.keywords at the y/N prompt, so the
        // written entry must contain exactly what the user confirmed.
        keywords: uniqList([primary, ...cluster, verdict.merged], 'keywords'),
        housekeptAt: new Date().toISOString(),
        housekeptFrom: cluster.map(e => e.id),
        source: 'kb-knowledge-housekeep',
      };
      try {
        await writeKnowledge(p.id, space, record);
        for (const e of cluster) {
          if (e.id !== primary.id) await deleteKnowledge(p.id, space, e.id);
        }
        const fresh = await readKnowledge(p.id, space, record.id);
        if (fresh && rt) rt.reloadKnowledge?.(fresh, space);
        totalMerged++;
        dirty = true;
        ctx.print(`  Merged → "${record.id}" (absorbed ${cluster.length - 1} other entr${cluster.length - 1 === 1 ? 'y' : 'ies'}).`);
      } catch (err) {
        ctx.print(`  merge write failed: ${err.message}`);
      }
    }
  }

  /* ================= Phase 3: Eden vs Holy conflicts (scope=all only) ===== */
  if (scope === 'all') {
    // Already-superseded Eden entries are retired (same convention as
    // graph.js retrieval and clusterSimilarEntries): a conflict resolved by
    // a previous run — option 1 here, or syncConflictingEden — must never
    // re-trigger the judge call, the menu, or a second [Superseded by ...]
    // banner stacked onto the intro.
    const edenEntries = (await listKnowledge(p.id, 'eden').catch(() => []))
      .filter(e => e.id && !isSupremeCode(e.id) && !e.supersededBy);
    const holyEntries = (await listKnowledge(p.id, 'holy').catch(() => []))
      .filter(e => e.id && !isSupremeCode(e.id));
    const pairs = [];
    const matched = new Set(); // eden id → already in a pair
    for (const e of edenEntries) {
      const h = findConflictingHoly(e, holyEntries);
      if (h && !matched.has(e.id)) {
        pairs.push({ eden: e, holy: h });
        matched.add(e.id);
      }
    }
    if (pairs.length === 0) {
      ctx.print(``);
      ctx.print(`[all] no Eden↔Holy conflict candidates.`);
    } else {
      ctx.print(``);
      ctx.print(`[all] ${pairs.length} Eden↔Holy conflict candidate(s) — asking the model to judge...`);
      for (const pair of pairs) {
        const verdict = await judgeConflict(llm, pair);
        if (!verdict) {
          ctx.print(`  (judge unavailable for eden "${pair.eden.id}" vs holy "${pair.holy.id}" — skipping)`);
          continue;
        }
        if (verdict.relation === 'complementary') {
          ctx.print(`  [complementary] eden "${pair.eden.id}" ↔ holy "${pair.holy.id}" — keep both, no action.`);
          continue;
        }
        ctx.print(``);
        ctx.print(`  [${verdict.relation === 'conflict' ? 'CONFLICT' : 'DUPLICATE'}] eden "${pair.eden.title}" (${pair.eden.id})`);
        ctx.print(`               ↔ holy "${pair.holy.title}" (${pair.holy.id})`);
        if (verdict.reason) ctx.print(`    model note: ${String(verdict.reason).slice(0, 300)}`);
        if (verdict.suggestion) ctx.print(`    model suggests: ${String(verdict.suggestion).slice(0, 300)}`);
        const choice = await chooseOption(ctx, [
          `Stamp Eden supersededBy=holy:${pair.holy.id} (Holy wins; Eden kept but retired from retrieval)`,
          `Delete the Eden entry "${pair.eden.id}" (Holy wins; Eden removed)`,
          `Merge Eden's unique content into the Holy entry (REWRITES Holy "${pair.holy.id}")`,
          `Skip — keep both as-is`,
        ]);
        if (choice === 1) {
          const entry = await readKnowledge(p.id, 'eden', pair.eden.id);
          if (entry) {
            const updated = {
              ...entry,
              supersededBy: `holy:${pair.holy.id}`,
              supersededAt: new Date().toISOString(),
              intro: `[Superseded by holy:${pair.holy.id} — Holy Space takes precedence; follow the Holy entry "${pair.holy.title}" instead.]\n\n${entry.intro || ''}`,
            };
            await writeKnowledge(p.id, 'eden', updated);
            const fresh = await readKnowledge(p.id, 'eden', pair.eden.id);
            if (fresh && rt) rt.reloadKnowledge?.(fresh, 'eden');
            totalStamps++;
            dirty = true;
            ctx.print(`    stamped eden "${pair.eden.id}" → supersededBy holy:${pair.holy.id}`);
          }
        } else if (choice === 2) {
          if (await deleteKnowledge(p.id, 'eden', pair.eden.id)) {
            totalRemoved++;
            dirty = true;
            ctx.print(`    deleted eden "${pair.eden.id}"`);
          }
        } else if (choice === 3) {
          if (!verdict.merged || !verdict.merged.intro) {
            ctx.print(`    no merged content provided by the model — nothing to merge. Use option 1 or 2 instead.`);
          } else {
            printHolyMergePreview(ctx, pair.holy, verdict);
            const ok = await ctx.confirm(`Rewrite Holy "${pair.holy.id}" with the merged content? (y/N) `);
            if (ok) {
              const holyEntry = await readKnowledge(p.id, 'holy', pair.holy.id);
              if (holyEntry) {
                const updated = {
                  ...holyEntry,
                  title: verdict.merged.title || holyEntry.title,
                  intro: verdict.merged.intro,
                  keyFiles: uniqList([holyEntry, pair.eden], 'keyFiles'),
                  keySymbols: uniqList([holyEntry, pair.eden], 'keySymbols'),
                  keywords: uniqList([holyEntry, pair.eden], 'keywords'),
                  housekeptAt: new Date().toISOString(),
                  housekeptFrom: [pair.holy.id, pair.eden.id],
                };
                await writeKnowledge(p.id, 'holy', updated);
                const fresh = await readKnowledge(p.id, 'holy', pair.holy.id);
                if (fresh && rt) rt.reloadKnowledge?.(fresh, 'holy');
                totalMerged++;
                dirty = true;
                ctx.print(`    merged eden content into holy "${pair.holy.id}" (eden entry kept — stamp or delete it separately next).`);
              }
            } else {
              ctx.print(`    Skipped Holy rewrite.`);
            }
          }
        } else {
          ctx.print(`    skipped.`);
        }
      }
    }
  }

  /* ================= Final: rebuild knowledge indexes if dirty ============ */
  ctx.print(``);
  if (dirty) {
    for (const space of (scope === 'all' ? ['holy', 'eden'] : [scope])) {
      try {
        const res = await rebuildKnowledgeIndex(p.id, space);
        ctx.print(`rebuilt ${space} knowledge index (${res.count} entries → ${space}.idx.json)`);
      } catch (err) {
        ctx.print(`warning: ${space} knowledge index rebuild failed: ${err.message}`);
      }
    }
    dropRuntime(p.id);          // next query reloads fresh state incl. new idx
    ctx.noteReloadKb?.();
  } else {
    ctx.print(`No changes written — indexes left untouched.`);
  }
  ctx.print(`Housekeep complete: ${totalMerged} merged, ${totalStamps} superseded/stamped, ${totalRemoved} removed.`);
}

/* ------------------------------------------------------------------ */
/* /kb knowledge housekeep helpers                                      */
/* ------------------------------------------------------------------ */

/**
 * Deterministic near-duplicate pre-filter (cheap, no LLM).
 * Groups entries whose titles mutually contain each other or whose keyword
 * sets overlap > 0.6 — the exact thresholds used by findHolyConflict /
 * crossCheckEntries, so housekeep candidates match what the retrieval layer
 * already considers "the same thing".
 *
 * Union-find over pairwise similarity; returns clusters of size >= 2.
 * Entries already stamped supersededBy are excluded (they are retired by
 * design, not duplicates to fix). Exported for unit tests.
 */
export function clusterSimilarEntries(entries) {
  const active = entries.filter(e => e && e.id && !e.supersededBy);
  const parent = new Map(active.map(e => [e.id, e.id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const kwSets = new Map(active.map(e => [e.id, new Set((e.keywords || []).map(k => String(k).toLowerCase()))]));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (pairwiseSimilar(a, b, kwSets)) union(a.id, b.id);
    }
  }
  const groups = new Map();
  for (const e of active) {
    const root = find(e.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }
  return [...groups.values()].filter(g => g.length >= 2);
}

function pairwiseSimilar(a, b, kwSets) {
  const at = String(a.title || '').toLowerCase().trim();
  const bt = String(b.title || '').toLowerCase().trim();
  if (at && bt && (at.includes(bt) || bt.includes(at))) return true;
  const ak = kwSets.get(a.id), bk = kwSets.get(b.id);
  if (ak && bk && ak.size > 0 && bk.size > 0) {
    let ov = 0;
    for (const k of ak) if (bk.has(k)) ov++;
    if (ov / Math.min(ak.size, bk.size) > 0.6) return true;
  }
  return false;
}

/**
 * Same heuristic as findHolyConflict (lib/agent/graph.js): the first Holy
 * entry whose title mutually contains the Eden title, or whose keyword sets
 * overlap > 0.6. Local copy so the slash layer doesn't import agent code.
 * Exported for unit tests.
 */
export function findConflictingHoly(edenEntry, holyEntries) {
  const eTitle = String(edenEntry.title || '').toLowerCase();
  const eKws = new Set((edenEntry.keywords || []).map(k => String(k).toLowerCase()));
  for (const h of holyEntries) {
    const hTitle = String(h.title || '').toLowerCase();
    if (eTitle && hTitle && (eTitle.includes(hTitle) || hTitle.includes(eTitle))) return h;
    const hKws = new Set((h.keywords || []).map(k => String(k).toLowerCase()));
    if (eKws.size > 0 && hKws.size > 0) {
      let ov = 0;
      for (const k of eKws) if (hKws.has(k)) ov++;
      if (ov / Math.min(eKws.size, hKws.size) > 0.6) return h;
    }
  }
  return null;
}

/**
 * Ask the LLM whether a cluster of same-space entries is duplicate / similar
 * / distinct, and (when not distinct) produce one merged entry covering all
 * members. Returns null when the call or the parse fails.
 */
async function judgeCluster(llm, cluster) {
  const sys = `You are the maintainer of a software project's knowledge base. You judge whether knowledge entries in the SAME space cover the same ground, and when they do, you fuse them into ONE definitive entry.

Reply with ONLY a JSON object (no markdown fences, no prose):
{
  "relation": "duplicate" | "similar" | "distinct",
  "reason": "one short sentence",
  "merged": {
    "title": "best title for the fused entry",
    "intro": "fused intro: 2-5 paragraphs of prose covering ALL unique facts, file paths, symbols and commands from every member. Do not lose information; drop only true redundancy.",
    "keywords": ["union of the most useful search keywords"]
  }
}

"merged" may be null when relation is "distinct".
duplicate = same topic, substantially the same content.
similar   = same topic, complementary content worth fusing.
distinct  = different topics that merely share vocabulary.`;
  const user = `Entries in the same space:\n\n${cluster.map(e =>
    `## ${e.id} — ${e.title || ''}\nkeywords: ${(e.keywords || []).join(', ') || '(none)'}\nkeyFiles: ${(e.keyFiles || []).join(', ') || '(none)'}\nkeySymbols: ${(e.keySymbols || []).join(', ') || '(none)'}\nintro:\n${String(e.intro || '').slice(0, 2500)}`
  ).join('\n\n')}\n\nReply with ONLY the JSON object.`;
  const raw = await streamToText(llm, sys, user);
  if (raw == null) return null;
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || !['duplicate', 'similar', 'distinct'].includes(parsed.relation)) return null;
  return parsed;
}

/**
 * Ask the LLM whether an Eden entry conflicts with / duplicates a Holy entry
 * or is genuinely complementary. Returns null on call/parse failure.
 */
async function judgeConflict(llm, { eden, holy }) {
  const sys = `You are the maintainer of a software project's knowledge base. It has two spaces: HOLY (stable, hand-curated, authoritative) and EDEN (auto-updated, may drift). You judge the relationship between one Eden entry and one Holy entry.

Reply with ONLY a JSON object (no markdown fences, no prose):
{
  "relation": "conflict" | "duplicate" | "complementary",
  "reason": "one short sentence",
  "suggestion": "one short sentence recommending the best resolution for a human",
  "merged": {
    "title": "title for the fused HOLY entry (Holy's title preferred)",
    "intro": "fused intro that keeps ALL of Holy's content and adds any unique facts from Eden. Holy is the backbone; Eden contributes extras.",
    "keywords": ["union of the most useful search keywords"]
  }
}

"merged" is only meaningful when relation is conflict or duplicate.
conflict      = they state different/incompatible things about the same topic.
duplicate     = Eden merely restates Holy (nothing unique worth keeping).
complementary = different topics / genuinely additive — keep both.`;
  const user = `## EDEN entry "${eden.id}" — ${eden.title || ''}\nkeywords: ${(eden.keywords || []).join(', ') || '(none)'}\nintro:\n${String(eden.intro || '').slice(0, 2500)}\n\n## HOLY entry "${holy.id}" — ${holy.title || ''}\nkeywords: ${(holy.keywords || []).join(', ') || '(none)'}\nintro:\n${String(holy.intro || '').slice(0, 2500)}\n\nReply with ONLY the JSON object.`;
  const raw = await streamToText(llm, sys, user);
  if (raw == null) return null;
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || !['conflict', 'duplicate', 'complementary'].includes(parsed.relation)) return null;
  return parsed;
}

/** Run one (system, user) LLM call and collect the text channel. Null on error. */
async function streamToText(llm, sys, user) {
  if (!llm) return null;
  let raw = '';
  try {
    for await (const evt of llm.stream([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.1, maxChars: 16384, enableReasoning: false, timeoutMs: 180000 })) {
      if (evt.type === 'retry') {
        // Transient failure — the call restarts from scratch; the failed
        // attempt's partial text is void (see lib/llm/retries.js).
        raw = '';
      } else if (evt.type === 'delta') {
        raw += evt.text;
      }
    }
  } catch {
    return null;
  }
  return raw;
}

/** Extract the first JSON object from raw LLM output (fences tolerated). */
function parseJsonObjectLoose(raw) {
  const s = String(raw || '');
  try { const v = JSON.parse(s); if (v && typeof v === 'object') return v; } catch {}
  const fenced = extractFencedBlocks(s);
  for (const cand of [fenced, s]) {
    if (!cand || !cand.trim()) continue;
    const m = cand.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const v = JSON.parse(m[0]);
        if (v && typeof v === 'object') return v;
      } catch {}
    }
  }
  return null;
}

/**
 * Numeric menu prompt (1..N). Uses ctx.choose when the host provides one
 * (interactive REPL); otherwise prints the menu and defaults to the LAST
 * option (skip) — housekeep never mutates without an explicit interactive
 * decision. Returns the chosen 1-based number.
 */
async function chooseOption(ctx, options, fallback = null) {
  const chooser = ctx.choose;
  if (typeof chooser === 'function') {
    const idx = await chooser(`  choose [1-${options.length}] (Enter = ${options.length}): `, options);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return idx;
    if (idx == null) return fallback == null ? options.length : fallback;
    // defensive: a host may return the raw line — try parsing it
    const n = parseInt(String(idx).trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
    return fallback == null ? options.length : fallback;
  }
  ctx.print(`    resolution options:`);
  options.forEach((o, i) => ctx.print(`      ${i + 1}. ${o}`));
  ctx.print(`    (non-interactive session — defaulting to option ${options.length})`);
  return fallback == null ? options.length : fallback;
}

/**
 * The cluster member the merged entry inherits id/createdAt from: the oldest
 * entry wins (stable ids), tie-break by id for determinism.
 */
function pickPrimary(cluster) {
  const sorted = [...cluster].sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  return sorted[0];
}

/** Union of a list-field across entries, order-preserving, case-insensitive dedup. */
function uniqList(entries, field) {
  const out = [];
  const seen = new Set();
  for (const e of entries || []) {
    for (const v of (Array.isArray(e?.[field]) ? e[field] : [])) {
      const s = String(v);
      const key = s.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(s); }
    }
  }
  return out;
}

function printMergedPreview(ctx, verdict, cluster) {
  ctx.print(`    merged title: ${verdict.merged.title}`);
  const intro = String(verdict.merged.intro || '');
  ctx.print(`    merged intro (${intro.length} chars): ${intro.slice(0, 240).replace(/\n/g, ' ')}${intro.length > 240 ? '...' : ''}`);
  if (verdict.merged.keywords?.length) {
    ctx.print(`    merged keywords: ${verdict.merged.keywords.join(', ')}`);
  }
  ctx.print(`    replaces: ${cluster.map(e => e.id).join(', ')}`);
}

function printHolyMergePreview(ctx, holy, verdict) {
  ctx.print(`    new Holy title: ${verdict.merged.title || holy.title}`);
  const intro = String(verdict.merged.intro || '');
  ctx.print(`    new Holy intro (${intro.length} chars): ${intro.slice(0, 240).replace(/\n/g, ' ')}${intro.length > 240 ? '...' : ''}`);
}


/* ------------------------------------------------------------------ */
/* /kb code — the project Supreme Code (hk2-supreme-code) management    */
/* ------------------------------------------------------------------ */

/**
 * /kb code — manage the permanent supreme-code entry in Holy space.
 *
 * The entry is the project's fundamental law: max 100 items, 200 chars
 * each, gapless 1..N numbering. Every mutation below shows a preview and
 * requires an explicit y/N confirmation (Holy contract), then rewrites the
 * whole entry atomically. Nothing else may create/delete/modify this entry.
 *
 * Usage:
 *   /kb code list                                   show all items
 *   /kb code add [code-id] --code-content="..."     add (append) or update item
 *   /kb code add [code-id] --code-gen="..." [--model=provider/model-id]
 *                                                   generate one item via LLM
 *   /kb code del <code-id>                          delete + renumber
 */
async function codeKb(rest, ctx) {
  const sub = rest[0];
  const subArgs = rest.slice(1);
  switch (sub) {
    case 'add': case 'set': case 'update': return codeAddKb(subArgs, ctx);
    case 'del': case 'rm': case 'delete': return codeDelKb(subArgs, ctx);
    case 'list': case 'ls': case 'show': return codeListKb(subArgs, ctx);
    case 'help': case '?': case undefined:
      if (sub !== undefined && subArgs[0]) {
        const lines = subcommandHelp('kb', 'code');
        if (lines) { for (const l of lines) ctx.print(l); return; }
        ctx.print(`Unknown /kb code topic: ${subArgs[0]}`);
        return;
      }
      printCommandHelp(ctx, 'code');
      return;
    default:
      ctx.print(`Unknown /kb code subcommand: ${sub}`);
      printCommandHelp(ctx, 'code');
  }
}

async function codeListKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const got = await readSupremeCode(p.id);
  if (!got) {
    ctx.print(`Supreme Code entry missing (this should not happen). Run /kb status to self-heal.`);
    return;
  }
  ctx.print(`📌 Supreme Code (${SUPREME_CODE_ID}) — ${got.codes.length}/${SUPREME_CODE_MAX_ITEMS} item(s), obeyed by ALL operations:`);
  if (got.codes.length === 0) {
    ctx.print(`  (empty — add the first law with: /kb code add --code-content="...")`);
    return;
  }
  got.codes.forEach((c, i) => ctx.print(`  ${String(i + 1).padStart(3)}. ${c}`));
}

/** Resolve an LLM for --code-gen: --model=provider/model-id wins, else ctx.llm. */
async function resolveCodeGenLlm(ctx, modelRef) {
  if (!modelRef) return { llm: ctx.llm || null, ref: null };
  const { resolveModelRef, splitModelRef } = await import('../../lib/config/home.js');
  if (!splitModelRef(modelRef)) {
    throw new Error(`invalid --model ref: ${modelRef} (expected provider/model-id)`);
  }
  const cfg = await resolveModelRef(modelRef);
  if (!cfg) throw new Error(`model not found in registry: ${modelRef}`);
  const { LLMClient } = await import('../../lib/llm/client.js');
  return { llm: new LLMClient(cfg), ref: modelRef };
}

async function codeAddKb(rest, ctx) {
  const flags = parseFlags(rest);
  const rawId = flags.positional[0];
  const content = flags['code-content'];
  const gen = flags['code-gen'];
  const modelRef = flags.model;

  if (content === undefined && gen === undefined) {
    ctx.print(`Usage: /kb code add [code-id] (--code-content=<text> | --code-gen=<instructions>) [--model=<provider>/<model-id>]`);
    ctx.print(`  [code-id]   optional 1..N; omitted → append; <=N → update that item`);
    ctx.print(`  Limits: ${SUPREME_CODE_MAX_ITEMS} items max, ${SUPREME_CODE_MAX_CHARS} chars each.`);
    return;
  }
  if (content !== undefined && gen !== undefined) {
    ctx.print(`Choose ONE of --code-content or --code-gen (not both).`);
    return;
  }
  let id = null;
  if (rawId !== undefined) {
    id = parseCodeItemId(rawId);
    if (id === null) {
      ctx.print(`Invalid code-id "${rawId}": must be an integer 1..${SUPREME_CODE_MAX_ITEMS}.`);
      return;
    }
  }

  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const got = await readSupremeCode(p.id);
  const codes = got ? got.codes : [];

  // Determine the final item text.
  let text;
  if (content !== undefined) {
    const v = validateOneCodeItem(content);
    if (!v.ok) { ctx.print(`Invalid --code-content: ${v.reason}`); return; }
    text = v.content;  // verbatim apart from whitespace collapse (limit-checked)
  } else {
    // --code-gen: ask the (optionally specified) model to draft ONE item.
    let llm;
    try {
      const resolved = await resolveCodeGenLlm(ctx, modelRef);
      llm = resolved.llm;
    } catch (err) {
      ctx.print(`[code-gen] ${err.message}`);
      return;
    }
    if (!llm) {
      ctx.print(`[code-gen] no LLM available (set a model with /model set-default, or pass --model=provider/model-id).`);
      return;
    }
    ctx.print(`[code-gen] drafting one supreme-code item${modelRef ? ` via ${modelRef}` : ''}...`);
    const { buildCodeGenPrompt, sanitizeGeneratedCodeItem } = await import('../../lib/store/supreme_code.js');
    const prompt = buildCodeGenPrompt(gen, codes);
    let raw = '';
    try {
      const out = await llm.complete([{ role: 'user', content: prompt }], { temperature: 0.2, enableReasoning: false });
      raw = typeof out === 'string' ? out : (out?.content ?? '');
    } catch (err) {
      ctx.print(`[code-gen] LLM call failed: ${err.message}`);
      return;
    }
    const cleaned = sanitizeGeneratedCodeItem(raw);
    const v = validateOneCodeItem(cleaned);
    if (!v.ok) {
      ctx.print(`[code-gen] generated item rejected: ${v.reason}`);
      ctx.print(`  raw output: ${String(raw).slice(0, 200)}`);
      return;
    }
    text = v.content;
  }

  // Plan + confirm + write.
  const plan = planCodeAdd(codes, id, text);
  if (!plan.ok) { ctx.print(plan.error); return; }
  ctx.print(``);
  ctx.print(`Supreme Code — ${plan.action === 'update' ? `UPDATE item ${plan.id}` : `APPEND as item ${plan.id}`}:`);
  ctx.print(`  "${text}"`);
  if (plan.action === 'update') ctx.print(`  (replaces: "${codes[plan.id - 1]}")`);
  ctx.print(``);
  const ok = await ctx.confirm(`Write to the Supreme Code (Holy, permanent)? (y/N) `, { title: 'Supreme Code' });
  if (!ok) { ctx.print(`Cancelled. Nothing was written.`); return; }
  try {
    await writeSupremeCode(p.id, plan.codes);
  } catch (err) {
    ctx.print(`Write failed: ${err.message}`);
    return;
  }
  dropRuntime(p.id);
  ctx.noteReloadKb?.();
  ctx.print(`Saved. Supreme Code now has ${plan.codes.length} item(s) (item ${plan.id} ${plan.action}d).`);
}

async function codeDelKb(rest, ctx) {
  const rawId = typeof rest[0] === 'string' ? rest[0] : '';
  const flags = parseFlags(rest);
  const idStr = rawId && !rawId.startsWith('--') ? rawId : flags.positional[0];
  const id = parseCodeItemId(idStr);
  if (!id) {
    ctx.print(`Usage: /kb code del <code-id>`);
    ctx.print(`  code-id must be an integer 1..${SUPREME_CODE_MAX_ITEMS}.`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const got = await readSupremeCode(p.id);
  const codes = got ? got.codes : [];
  const plan = planCodeDel(codes, id);
  if (!plan.ok) { ctx.print(plan.error); return; }
  ctx.print(`Delete supreme-code item ${id}: "${plan.removed}"`);
  if (plan.codes.length > 0) {
    ctx.print(`Items after ${id} shift up (renumbering is gapless): now ${plan.codes.length} item(s).`);
  } else {
    ctx.print(`(the Supreme Code entry itself is permanent and stays, now empty)`);
  }
  const ok = await ctx.confirm(`Delete item ${id} from the Supreme Code? (y/N) `, { title: 'Delete knowledge' });
  if (!ok) { ctx.print(`Cancelled.`); return; }
  try {
    await writeSupremeCode(p.id, plan.codes);
  } catch (err) {
    ctx.print(`Write failed: ${err.message}`);
    return;
  }
  dropRuntime(p.id);
  ctx.noteReloadKb?.();
  ctx.print(`Deleted item ${id}. Supreme Code now has ${plan.codes.length} item(s).`);
}

async function knowledgeDelKb(rest, ctx) {
  const id = rest[0];
  if (!id) { ctx.print(`Usage: /kb knowledge del <id>`); return; }
  if (isSupremeCode(id)) {
    ctx.print(`"${SUPREME_CODE_ID}" is the permanent Supreme Code entry — deletion is not allowed.`);
    ctx.print(`Manage its items with /kb code add | /kb code del.`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  // Find the entry across both spaces
  let foundSpace = null;
  for (const space of ['holy', 'eden']) {
    const entry = await readKnowledge(p.id, space, id).catch(() => null);
    if (entry) { foundSpace = space; break; }
  }
  if (!foundSpace) { ctx.print(`(entry not found: ${id})`); return; }
  // Always confirm — Holy deletion especially
  const ok = await ctx.confirm(`Delete "${id}" from ${foundSpace} space? (y/N) `, { title: 'Delete knowledge' });
  if (!ok) { ctx.print('Cancelled.'); return; }
  await deleteKnowledge(p.id, foundSpace, id);
  // Refresh in-memory runtime
  dropRuntime(p.id);
  ctx.print(`Deleted "${id}" from ${foundSpace} space.`);
}

/**
 * /kb transform <id> <from-space> <to-space>
 * Move an entry between Holy and Eden spaces. Always requires confirmation
 * (it's a structural change to the KB), regardless of env vars.
 */
async function transformKb(rest, ctx) {
  const id = rest[0];
  const fromSpace = rest[1];
  const toSpace = rest[2];
  if (!id || !fromSpace || !toSpace) {
    ctx.print(`Usage: /kb transform <id> <from-space> <to-space>`);
    ctx.print(`  Spaces: holy | eden`);
    ctx.print(`  Example: /kb transform sql-commands eden holy`);
    return;
  }
  if (isSupremeCode(id)) {
    ctx.print(`"${SUPREME_CODE_ID}" is permanent — it cannot be moved between spaces.`);
    return;
  }
  if (!['holy', 'eden'].includes(fromSpace) || !['holy', 'eden'].includes(toSpace)) {
    ctx.print(`Invalid space. Use 'holy' or 'eden'.`);
    return;
  }
  if (fromSpace === toSpace) {
    ctx.print(`Source and target space are the same.`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const entry = await readKnowledge(p.id, fromSpace, id).catch(() => null);
  if (!entry) { ctx.print(`(entry "${id}" not found in ${fromSpace} space)`); return; }
  ctx.print(`Found entry: ${entry.title || entry.id}  (intro: ${(entry.intro || '').slice(0, 120)}${(entry.intro || '').length > 120 ? '...' : ''})`);
  const ok = await ctx.confirm(`Move "${id}" from ${fromSpace} → ${toSpace}? (y/N) `, { title: 'Move knowledge' });
  if (!ok) { ctx.print('Cancelled.'); return; }
  const newPath = await moveKnowledge(p.id, id, fromSpace, toSpace);
  // Refresh in-memory runtime so subsequent kb_knowledge / kb_search_knowledge sees it
  dropRuntime(p.id);
  ctx.print(`Moved "${id}": ${fromSpace} → ${toSpace}`);
  ctx.print(`New path: ${newPath}`);
}

async function dropKb(ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  const confirm = await ctx.confirm(`This will delete KB ${kbDir(p.id)}/ (irreversible). Continue? (y/N) `);
  if (!confirm) { ctx.print(`Cancelled.`); return; }
  const { deleteKb } = await import('../../lib/store/kb_store.js');
  await deleteKb(p.id);
  dropRuntime(p.id);
  ctx.print(`KB directory deleted. Project record preserved; run /kb init to rebuild.`);
  ctx.noteReloadKb?.();
}

function parseFlags(tokens) {
  const out = { positional: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) {
        out[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const key = t.slice(2);
        const next = tokens[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
      }
    } else {
      out.positional.push(t);
    }
  }
  out.positionalText = out.positional.join(' ').trim().replace(/^["'](.*)["']$/, '$1');
  return out;
}

// Exposed for unit tests (test/learn_knowledge.test.js). These are pure
// helpers used by /kb knowledge learn; not part of the public CLI surface.
/** Pure helpers of /kb knowledge housekeep, exposed for unit tests
 *  (test/kb_housekeep.test.js). Not part of the public CLI surface. */
export const __housekeepTest = {
  clusterSimilarEntries,
  findConflictingHoly,
};

export const __learnTest = {
  isLearnableExt,
  walkLearnFiles,
  reconcilePlan,
  parseFlags,
  LEARN_DOC_EXTS,
  chunkDocText,
  groupByBudget,
  labelMatches,
  parsePlanText,
  planningBudgetFor,
  batchGuidanceFor,
  buildDirMap,
  expandDirPlan,
  dirTreePlan,
  parseJsonArrayLoose,
};
