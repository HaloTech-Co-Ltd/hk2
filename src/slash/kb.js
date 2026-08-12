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
 * /kb command family — lifecycle and queries for the current project's KB.
 *
 * Three-space model:
 *   Holy Space   — stable knowledge (design principles, key algorithms).
 *                  Updates always require user approval (y/N), even when
 *                  HK2_ENABLE_AUTOUPDATEKB or HK2_ENABLE_AUTO_LEARN is 1.
 *   Eden Space   — frequently-updated knowledge (function lists, SQL command
 *                  catalogs). Auto-updatable when HK2_ENABLE_AUTO_LEARN=1.
 *   Index Space  — code index + per-space indexes + callgraph. Auto-updatable
 *                  when HK2_ENABLE_AUTOUPDATEKB=1.
 *
 * Usage:
 *   /kb init [--full]                  Build KB for the current project (full re-index)
 *   /kb update                         Incremental update (sha256 diff) — Index Space only
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
 * All commands operate on the current project (see /project set current).
 */
import path from 'node:path';
import { getCurrentProject, markKbBuilt } from '../../lib/config/home.js';
import { getRuntime, dropRuntime } from '../../lib/retrieval/kb_runtime.js';
import { buildIndex } from '../../lib/index/indexer.js';
import { addKbForProject, getKbMeta } from '../../lib/index/registry.js';
import {
  readStats, listKnowledge, readKnowledge, deleteKnowledge, moveKnowledge,
} from '../../lib/store/kb_store.js';
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
    case 'transform': return transformKb(rest, ctx);
    case 'drop': return dropKb(ctx);
    default:
      ctx.print(`/kb subcommands: init | update | status | search | symbol | neighbors | knowledge | transform | drop`);
      ctx.print(`See /help or the README for the three-space model (Holy / Eden / Index).`);
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
  ctx.print(`           kb dir=~/.hk2/kb/${p.id}/`);
  ctx.print(`           checkpoint: ${checkpoint ? `every ${checkpointInterval} files, resume=${resume}` : 'disabled'}`);
  ctx.print(`           summary:    ${skipSummary ? 'skipped' : 'auto-generated (project-overview / architecture-diagram / architecture-decisions)'}`);

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
  const stats = await buildIndex(p.id, {
    full: false,
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
  const [holyCount, edenCount] = await Promise.all([
    listKnowledge(p.id, 'holy').then(l => l.length).catch(() => 0),
    listKnowledge(p.id, 'eden').then(l => l.length).catch(() => 0),
  ]);
  ctx.print(`project: ${p.name} (${p.id})`);
  ctx.print(`  source:       ${meta.sourcePath}`);
  ctx.print(`  sourceRoot:   ${meta.sourceRoot || '(none)'}`);
  ctx.print(`  kb dir:       ~/.hk2/kb/${p.id}/`);
  ctx.print(`  updatedAt:    ${meta.updatedAt || '?'}`);
  ctx.print(``);
  ctx.print(`  Holy Space:   ${holyCount} entr${holyCount === 1 ? 'y' : 'ies'} (stable; updates require approval)`);
  ctx.print(`  Eden Space:   ${edenCount} entr${edenCount === 1 ? 'y' : 'ies'} (frequently-updated)`);
  ctx.print(`  Index Space:`);
  if (stats) {
    ctx.print(`    totalFiles:   ${stats.totalFiles}`);
    ctx.print(`    totalSymbols: ${stats.totalSymbols}`);
    if (stats.totalDocs) ctx.print(`    totalDocs:    ${stats.totalDocs}`);
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
    case 'init': case 'bootstrap': case 'scan': return knowledgeInitKb(subArgs, ctx);
    case 'housekeep': case 'housekeeping': case 'cleanup': case 'clean': return knowledgeCleanupKb(subArgs, ctx);
    case 'empty': case 'clear': case 'wipe': return knowledgeEmptyKb(subArgs, ctx);
    case 'export': return knowledgeExportKb(subArgs, ctx);
    case 'import': return knowledgeImportKb(subArgs, ctx);
    case 'del': case 'rm': return knowledgeDelKb(subArgs, ctx);
    case 'learn': case 'study': return knowledgeLearnKb(subArgs, ctx);
    case undefined:
      ctx.print(`/kb knowledge subcommands: list | show | add | init | housekeep | empty | export | import | del | learn`);
      return;
    default:
      ctx.print(`Unknown /kb knowledge subcommand: ${sub}. Use list | show | add | init | housekeep | empty | export | import | del | learn.`);
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
 * (the user typed the command). Holy Space's "always requires approval" rule
 * applies to AUTO paths (auto-update-kb, auto-learn), not to direct user
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
    if (spaceFilter || spaces.length > 1) {
      ctx.print(`[${space}] ${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
    }
    for (const e of list) {
      const title = e.title || '(untitled)';
      ctx.print(`  ${e.id.padEnd(28)}  ${title}`);
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
      ctx.print(`## ${entry.title || entry.id}  [${space}]`);
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
 * /kb knowledge init — deep-study the entire project and bootstrap Eden entries.
 *
 * Two-phase approach:
 *   Phase 1 (Planning): send the LLM a compact project map (directory tree with
 *     file paths, symbol counts, and top symbol names) + existing Holy/Eden
 *     summaries. Ask the LLM to propose a study plan: a list of topic batches,
 *     each covering related files across directories.
 *   Phase 2 (Execution): for each planned topic batch, read the listed files,
 *     send to LLM for focused Eden extraction, cross-check against Holy, save.
 *
 * Usage:
 *   /kb knowledge init [--per-batch-chars=N] [--dry-run] [--base-dir=PATH]
 *
 * --per-batch-chars: LLM context budget per execution batch (default 100000).
 * --dry-run: show proposed entries but do NOT write.
 * --base-dir=PATH: restrict the deep-study to files under this subdirectory
 *   (relative to the project source root, the same coordinate system used by
 *   indexed file paths, e.g. "src/slash" or "lib/index"). The three Phase 0
 *   project-wide survey entries are SKIPPED in this mode (they are whole-
 *   project by design); only Phase 1 planning + Phase 2 execution run, scoped
 *   to the chosen directory. Useful when you want to deep-study one module
 *   without disturbing the rest of the KB.
 */
async function knowledgeInitKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  if (!ctx.llm) {
    ctx.print(`No LLM configured. Run /model add + /model set-default first.`);
    return;
  }
  const flags = parseFlags(rest);
  const perBatchChars = parseInt(flags['per-batch-chars'], 10) || parseInt(flags['per-module-chars'], 10) || 100000;
  const dryRun = !!flags['dry-run'];
  const userPrompt = flags.positionalText || '';
  const baseDirRaw = typeof flags['base-dir'] === 'string' ? flags['base-dir'] : '';

  // Normalize --base-dir into the indexed-file coordinate system (paths are
  // stored relative to sourcePath + sourceRoot, forward-slash separated).
  const baseDir = baseDirRaw
    ? baseDirRaw.replace(/^\.?\/+/, '').replace(/\/+$/, '').split(path.sep).join('/')
    : '';

  ctx.print(`[kb knowledge init] Deep-studying project: ${p.name}`);
  ctx.print(`  source: ${p.sourcePath}`);
  if (p.sourceRoot) ctx.print(`  sourceRoot: ${p.sourceRoot}`);
  if (baseDir) ctx.print(`  base-dir: ${baseDir} (subdirectory scope)`);
  if (userPrompt) ctx.print(`  user instructions: ${userPrompt}`);

  // When --base-dir is set, build a scoped runtime view so Phase 1 / Phase 2
  // only see files under the chosen directory. Without --base-dir this is a
  // no-op alias of ctx.rt (identical behavior to before).
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

  // Load existing entries for conflict checking
  const existingHoly = await listKnowledge(p.id, 'holy').catch(() => []);
  let existingEden = await listKnowledge(p.id, 'eden').catch(() => []);
  ctx.print(`  existing Holy: ${existingHoly.length}, Eden: ${existingEden.length}`);

  // ============ Phase 0: Project-wide survey entries ============
  // Generates three fixed-id Eden entries (api-docs, code-walkthrough,
  // usage-examples) that survey the WHOLE project. These complement the
  // per-topic batches that Phase 2 produces.
  //
  // SKIPPED under --base-dir: survey entries are project-wide by design and
  // must not be overwritten with a single subdirectory's contents.
  if (!dryRun && !baseDir) {
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
        llm: ctx.llm,
        streamLLM: ctx.streamLLM,
        allSymbols,
        meta,
        onProgress: (which) => ctx.print(`  [survey] generating ${which}...`),
      });
      // Refresh eden list so Phase 1 sees the new entries
      existingEden = await listKnowledge(p.id, 'eden').catch(() => []);
    } catch (err) {
      ctx.print(`[Phase 0] survey generation failed: ${err.message}`);
    }
  }

  // ============ Phase 1: LLM plans the study ============
  ctx.setPhase?.('planning study');
  ctx.print('');
  ctx.print('[Phase 1: Planning] Building project map for the model...');

  const projectMap = buildProjectMap(scopedRt);
  ctx.print(`  project map: ${projectMap.fileCount} files across ${projectMap.dirCount} directories, ${projectMap.text.length} chars`);

  // Truncate existing entries to keep the planning prompt manageable
  const holySummary = existingHoly.slice(0, 30).map(e => `- ${e.id}: ${e.title}`).join('\n');
  const edenSummary = existingEden.slice(0, 30).map(e => `- ${e.id}: ${e.title}`).join('\n');

  const planSysPrompt = `You are planning a deep study of a software project. Group related files into focused topic batches — group by LOGICAL topic, not just by directory. Each batch covers a coherent area.

Output format — one batch per line, using pipe delimiters (NOT JSON):
topic-id | short description | file1.c, file2.c, file3.c

Example output (3 batches):
buffer-pool | shared buffer cache and page replacement | storage/buffer/bufmgr.c, storage/buffer/freelist.c, storage/buffer/buf_init.c
transaction-mgmt | transaction lifecycle and snapshots | access/transam/xact.c, utils/time/snapmgr.c, storage/ipc/procarray.c
wiredtiger-stemmers | full-text search stemmer modules | snowball/stem_ISO_8859_1_english.c, snowball/api.c

Rules:
- Aim for 5-30 batches. Cover ALL files listed in the map.
- Each batch: 1-30 files.
- Group by topic (e.g. "transaction-mgmt" can span access/transam/ + storage/ipc/ + utils/time/).
- Include every file in exactly one batch.
- Do NOT duplicate topics already covered by existing Holy or Eden entries (listed below).
- Output ONLY the pipe-delimited lines. No prose, no JSON, no markdown.`;

  const planUserPrompt = `Project: ${p.name}

=== COMPLETE FILE MAP ===
${projectMap.text}

Existing Holy entries (DO NOT duplicate):
${holySummary || '(none)'}

Existing Eden entries (DO NOT duplicate):
${edenSummary || '(none)'}
${userPrompt ? `\nAdditional user instructions:\n${userPrompt}` : ''}`;

  let planRaw = '';
  let planReasoning = '';
  try {
    for await (const evt of ctx.streamLLM(
      [
        { role: 'system', content: planSysPrompt },
        { role: 'user', content: planUserPrompt },
      ],
      { temperature: 0.1, maxChars: 65536, enableReasoning: true, timeoutMs: 300000 },
    )) {
      if (evt.type === 'delta') planRaw += evt.text;
      else if (evt.type === 'reasoning') planReasoning += evt.text;
    }
  } catch (err) {
    ctx.print(`[Phase 1] LLM planning call failed: ${err.message}`);
    return;
  }

  // Parse the plan from either content (planRaw) or reasoning (planReasoning).
  // The pipe-delimited format may appear in either field depending on the model.
  const planSource = planRaw.trim() || planReasoning.trim();
  let plan = parsePlanText(planSource);

  // Validate the parsed plan against the real file index. If too few of the
  // planned paths resolve to actual files, the model hallucinated paths or
  // the parser picked up prose (topics like "files", "hmm", etc.). In that
  // case, discard the plan and fall back to directory grouping.
  if (plan && plan.length > 0 && scopedRt?.files?.byId) {
    const realPaths = new Set(Object.values(scopedRt.files.byId).map(f => f.path).filter(Boolean));
    let plannedTotal = 0;
    let resolved = 0;
    for (const b of plan) {
      for (const p of b.files || []) {
        plannedTotal++;
        const clean = p.replace(/^\.\//, '');
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
      ctx.print(`[Phase 1] LLM plan parsed: ${plan.length} batches (${planRaw.trim() ? 'from content' : 'from reasoning'}, ${resolved}/${plannedTotal} paths resolve).`);
    }
  } else if (plan && plan.length > 0) {
    ctx.print(`[Phase 1] LLM plan parsed: ${plan.length} batches (${planRaw.trim() ? 'from content' : 'from reasoning'}).`);
  }

  if (!plan || plan.length === 0) {
    if (!plan) {
      ctx.print('[Phase 1] Could not parse LLM study plan.');
    }
    ctx.print('[Phase 1] Using directory-based grouping as fallback.');
    const modules = groupFilesByModule(scopedRt);
    plan = modules.map(mod => ({
      topic: mod.name,
      description: `${mod.name}/ module (${mod.files.length} files, ${mod.symbolCount} symbols)`,
      files: mod.files.map(f => f.path),
    }));
  }

  ctx.print('');
  ctx.print(`[Phase 1] Study plan: ${plan.length} batches`);
  for (let i = 0; i < plan.length; i++) {
    const b = plan[i];
    ctx.print(`  [${i + 1}/${plan.length}] ${b.topic}: ${b.description || ''} (${(b.files || []).length} files)`);
  }
  ctx.print('');

  // ============ Phase 2: Execute each planned batch ============
  ctx.print(`[Phase 2: Execution] Per-batch budget: ${perBatchChars} chars`);
  ctx.print('');

  const { writeKnowledge, readKnowledge } = await import('../../lib/store/kb_store.js');
  const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
  const rt = await getRuntime(p.id).catch(() => null);
  const projectId = p.id;

  // Build a lookup of file paths for reading
  const fileIndex = new Map();
  if (scopedRt?.files?.byId) {
    for (const f of Object.values(scopedRt.files.byId)) {
      if (f.path) fileIndex.set(f.path, f);
    }
  }

  let totalSaved = 0;
  let totalAccepted = 0;
  let totalDiscarded = 0;
  let totalProposed = 0;

  for (let batchIdx = 0; batchIdx < plan.length; batchIdx++) {
    const batch = plan[batchIdx];
    ctx.setPhase?.(`studying [${batchIdx + 1}/${plan.length}] ${batch.topic}`);
    ctx.print(`--- [${batchIdx + 1}/${plan.length}] ${batch.topic}: ${batch.description || ''} ---`);

    // Read the files listed in this batch's plan
    const sources = await readPlannedFiles(p, batch.files || [], fileIndex, perBatchChars);
    if (sources.length === 0) {
      ctx.print('  (no readable files — skipping)');
      continue;
    }
    const sourcesChars = sources.reduce((s, f) => s + f.content.length, 0);
    ctx.print(`  deep-read: ${sources.length} files, ${sourcesChars} chars`);

    // Build LLM context
    const holyNow = existingHoly.map(e => `- ${e.id}: ${e.title}`).join('\n');
    const edenNow = existingEden.map(e => `- ${e.id}: ${e.title}`).join('\n');

    let contextParts = [];
    for (const s of sources) {
      contextParts.push(`## ${s.path} (${s.symbolCount} syms)\n\`\`\`\n${s.content}\n\`\`\``);
    }
    const batchContext = contextParts.join('\n\n').slice(0, perBatchChars);

    const extractSysPrompt = buildExtractSysPrompt(holyNow, edenNow, userPrompt);
    const extractUserPrompt = `Project: ${p.name} — Topic: ${batch.topic}\n${batch.description || ''}\n\nBelow are source files related to this topic. Extract Eden knowledge entries.\n\n${batchContext}`;

    let raw = '';
    let rawReasoning = '';
    try {
      for await (const evt of ctx.streamLLM(
        [
          { role: 'system', content: extractSysPrompt },
          { role: 'user', content: extractUserPrompt },
        ],
        { temperature: 0.1, maxChars: 65536, enableReasoning: true, timeoutMs: 300000 },
      )) {
        if (evt.type === 'delta') raw += evt.text;
        else if (evt.type === 'reasoning') rawReasoning += evt.text;
      }
    } catch (err) {
      ctx.print(`  LLM call failed: ${err.message} — skipping.`);
      continue;
    }
    // Fallback: GLM-5.2 may put JSON in reasoning_content
    if (!raw.trim() && rawReasoning.trim()) {
      const m = rawReasoning.match(/\[[\s\S]*\]/);
      if (m) raw = m[0];
    }

    // Parse + cross-check + save
    let proposed = null;
    try { proposed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) { try { proposed = JSON.parse(m[0]); } catch {} }
    }
    if (!Array.isArray(proposed)) {
      ctx.print('  (could not parse as JSON array — skipping)');
      continue;
    }
    totalProposed += proposed.length;
    if (proposed.length === 0) {
      ctx.print('  (no Eden entries)');
      continue;
    }

    const { accepted, discarded: disc } = crossCheckEntries(proposed, existingHoly, existingEden);
    ctx.print(`  proposed: ${proposed.length}, accepted: ${accepted.length}, discarded: ${disc.length}`);
    for (const e of accepted) {
      ctx.print(`    [ACCEPT] ${e.id}: ${e.title || ''} (${(e.intro || '').length}c)`);
    }

    totalAccepted += accepted.length;
    totalDiscarded += disc.length;

    if (!dryRun && accepted.length > 0) {
      for (const entry of accepted) {
        const id = String(entry.id).replace(/[^A-Za-z0-9_.-]/g, '_');
        const record = {
          id, space: 'eden',
          title: entry.title, intro: entry.intro,
          keyFiles: Array.isArray(entry.keyFiles) ? entry.keyFiles : [],
          keySymbols: Array.isArray(entry.keySymbols) ? entry.keySymbols : [],
          keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
          autoLearned: true, bootstrap: true,
        };
        await writeKnowledge(projectId, 'eden', record);
        const final = await readKnowledge(projectId, 'eden', id);
        if (final && rt) rt.reloadKnowledge?.(final, 'eden');
        existingEden.push(record);
        totalSaved++;
      }
    }
  }

  // Final summary
  ctx.setPhase?.('idle');
  ctx.print('');
  ctx.print('=== /kb knowledge init complete ===');
  ctx.print(`  batches studied: ${plan.length}`);
  ctx.print(`  total proposed: ${totalProposed}`);
  ctx.print(`  total accepted: ${totalAccepted}`);
  ctx.print(`  total discarded: ${totalDiscarded}`);
  if (dryRun) {
    ctx.print(`  [dry-run] ${totalAccepted} entries would have been saved.`);
  } else if (totalSaved > 0) {
    ctx.print(`  ${totalSaved} Eden entr${totalSaved === 1 ? 'y' : 'ies'} saved.`);
  } else {
    ctx.print('  (no entries saved)');
  }
}

// File formats learnable via /kb knowledge learn (in addition to code-indexed
// ones). Kept in sync with doc_parser.DOC_EXTS but limited to the human-readable
// document types the user asked for: Markdown, PDF, Word, PowerPoint.
const LEARN_DOC_EXTS = new Set(['md', 'markdown', 'pdf', 'doc', 'docx', 'ppt', 'pptx']);

/**
 * /kb knowledge learn - deep-study a file (or every file in a directory) and
 * write extracted knowledge entries to a user-chosen space.
 *
 * Two-phase approach (mirrors /kb knowledge init):
 *   Phase 1 (Planning): send the LLM a compact manifest of the target files
 *     (paths + per-file char budget) and ask it to group them into focused
 *     topic batches.
 *   Phase 2 (Execution): for each batch, parse + read the listed files, feed
 *     them to the LLM for focused extraction, cross-check against existing
 *     entries, and write accepted entries to --space.
 *
 * Supported formats (via lib/parser/doc_parser.js):
 *   Markdown (.md/.markdown), PDF (.pdf), Word (.doc/.docx), PowerPoint (.ppt/.pptx).
 *   Other text-ish files the indexer already knows (.txt/.rst/.adoc/.json/.yaml/.html)
 *   are also accepted and read as UTF-8.
 *
 * Usage:
 *   /kb knowledge learn --space=eden|holy [--file=<path>] [--base-dir=<dir>]
 *                       [--per-batch-chars=N] [--dry-run] [instructions...]
 *
 *   --space           eden | holy (required). Holy writes require interactive
 *                     confirmation (see confirmHolyWrite below).
 *   --file=<path>     learn a single file.
 *   --base-dir=<dir>  learn every supported file under this directory
 *                     (recursive). All files are processed.
 *   --per-batch-chars LLM context budget per execution batch (default 100000).
 *   --dry-run         show proposed entries but do NOT write.
 *   trailing tokens   free-form instructions passed to the extraction prompt.
 *
 * Either --file or --base-dir must be given (not both).
 */
async function knowledgeLearnKb(rest, ctx) {
  const p = await getProjectOrFail(ctx);
  if (!p) return;
  if (!ctx.llm) {
    ctx.print(`No LLM configured. Run /model add + /model set-default first.`);
    return;
  }
  const flags = parseFlags(rest);
  const space = flags.space === 'holy' ? 'holy' : flags.space === 'eden' ? 'eden' : '';
  if (!space) {
    ctx.print(`--space is required and must be eden or holy.`);
    ctx.print(`Usage: /kb knowledge learn --space=eden|holy [--file=<path>] [--base-dir=<dir>] [--dry-run]`);
    return;
  }
  const fileArg = typeof flags.file === 'string' ? flags.file : '';
  const dirArg = typeof flags['base-dir'] === 'string' ? flags['base-dir'] : '';
  if (!fileArg && !dirArg) {
    ctx.print(`Either --file=<path> or --base-dir=<dir> is required.`);
    ctx.print(`Usage: /kb knowledge learn --space=eden|holy [--file=<path>] [--base-dir=<dir>] [--dry-run]`);
    return;
  }
  if (fileArg && dirArg) {
    ctx.print(`Pass only one of --file or --base-dir, not both.`);
    return;
  }
  const perBatchChars = parseInt(flags['per-batch-chars'], 10) || 100000;
  const dryRun = !!flags['dry-run'];
  const userPrompt = flags.positionalText || '';

  // ---- Resolve target files ----
  // Files may be inside or outside the project source tree. We resolve against
  // the CWD and fall back to the project source path so both project docs and
  // arbitrary external files (e.g. /tmp/spec.pdf) work.
  let targetFiles = [];
  const unsupported = [];
  const resolveRoot = (base) => {
    if (path.isAbsolute(base)) return base;
    if (p.sourcePath) {
      const inProject = path.join(p.sourcePath, base);
      const inCwd = path.resolve(base);
      // Prefer whichever exists; default to CWD-resolved for external files.
      return inCwd;
    }
    return path.resolve(base);
  };

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
    const dir = resolveRoot(dirArg);
    let st;
    try { st = await fs.stat(dir); }
    catch { ctx.print(`--base-dir not found: ${dir}`); return; }
    if (!st.isDirectory()) { ctx.print(`--base-dir is not a directory: ${dir}`); return; }
    ctx.print(`[kb knowledge learn] Walking ${dir} ...`);
    targetFiles = await walkLearnFiles(dir, unsupported);
  }

  if (targetFiles.length === 0) {
    ctx.print(`No learnable files found${dirArg ? ` under ${dirArg}` : ''}.`);
    ctx.print(`Supported: ${[...LEARN_DOC_EXTS].join(', ')}, plus txt/rst/adoc/json/yaml/html/sgml.`);
    if (unsupported.length) {
      ctx.print(`Skipped ${unsupported.length} unsupported file(s): ${unsupported.slice(0, 8).map(f => path.basename(f)).join(', ')}${unsupported.length > 8 ? ' ...' : ''}`);
    }
    return;
  }

  ctx.print(`[kb knowledge learn] Deep-studying ${targetFiles.length} file${targetFiles.length === 1 ? '' : 's'} -> ${space} space`);
  if (dirArg) ctx.print(`  base-dir: ${dirArg}`);
  if (userPrompt) ctx.print(`  user instructions: ${userPrompt}`);
  if (unsupported.length) {
    ctx.print(`  (skipped ${unsupported.length} unsupported file${unsupported.length === 1 ? '' : 's'})`);
  }

  // ---- Parse every target file up-front so we can report failures and ----
  // ---- guarantee every supported file is processed.                       ----
  const { parseDocument } = await import('../../lib/parser/doc_parser.js');
  const parsedFiles = [];   // { path, label, text }
  const failed = [];
  for (const abs of targetFiles) {
    const label = dirArg ? path.relative(resolveRoot(dirArg), abs) : path.basename(abs);
    ctx.setPhase?.(`parsing ${label}`);
    let parsed = null;
    try { parsed = await parseDocument(abs); }
    catch (err) { failed.push({ label, msg: err.message }); }
    if (!parsed || !((parsed.text || '').trim())) {
      if (parsed) failed.push({ label, msg: 'no extractable text' });
      continue;
    }
    // Large files (books, long PDFs/PPTs) are split into sequential parts so
    // EVERY section is studied. Previously the text was truncated to
    // perBatchChars here, silently discarding everything after the first
    // chunk (e.g. chapters 4-12 of a 12-chapter book). Each part is its own
    // manifest entry and gets its own study batch in Phase 2.
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
  const parsedLine = parsedFiles.length > targetFiles.length
    ? `  parsed: ${targetFiles.length} file(s) split into ${parsedFiles.length} study parts, ${totalChars} chars`
    : `  parsed: ${parsedFiles.length}/${targetFiles.length} files, ${totalChars} chars`;
  ctx.print(parsedLine);
  if (failed.length) {
    ctx.print(`  failed: ${failed.length}`);
    for (const f of failed.slice(0, 10)) ctx.print(`    - ${f.label}: ${f.msg}`);
  }

  // ---- Load existing entries for conflict checking ----
  const existingHoly = await listKnowledge(p.id, 'holy').catch(() => []);
  let existingEden = await listKnowledge(p.id, 'eden').catch(() => []);
  ctx.print(`  existing Holy: ${existingHoly.length}, Eden: ${existingEden.length}`);

  // ---- Phase 1: LLM plans study batches from the file manifest ----
  ctx.setPhase?.('planning study');
  ctx.print('');
  ctx.print('[Phase 1: Planning] Building file manifest for the model...');
  const manifest = parsedFiles.map((f, i) =>
    `[${i + 1}] ${f.path} (${f.text.length} chars${f.title && f.title !== f.path ? `, title: ${f.title}` : ''})`).join('\n');

  const planSysPrompt = `You are planning a deep study of a set of documents (PDF / Word / PowerPoint / Markdown) so reusable knowledge entries can be extracted into the project KB.

Group related files into focused topic batches - group by LOGICAL topic, not just by file. Each batch should be coherent and small enough to study together.

Output format - one batch per line, using pipe delimiters (NOT JSON):
topic-id | short description | file1, file2, file3

Rules:
- Use the EXACT file labels from the manifest (the [N] label text).
- Cover EVERY file across the batches - no file may be dropped.
- A large document is split into numbered parts (e.g. "book.pdf.part1", "book.pdf.part2") - each part is a separate manifest entry and must be covered like any other file.
- Keep each batch's TOTAL source size under the per-batch budget of ${perBatchChars} chars (the manifest shows every entry's char count). Split the parts of one book into separate batches when grouping them would exceed the budget.
- If there is only one file, output a single batch for it.
- Keep batches to <= 6 files when possible.

File manifest:
${manifest}`;

  let planRaw = '';
  let planReasoning = '';
  try {
    for await (const evt of ctx.streamLLM(
      [
        { role: 'system', content: planSysPrompt },
        { role: 'user', content: `Plan the study of these ${parsedFiles.length} document(s).${userPrompt ? `\nUser instructions: ${userPrompt}` : ''}` },
      ],
      { temperature: 0.1, maxChars: 8192, enableReasoning: true, timeoutMs: 120000 },
    )) {
      if (evt.type === 'delta') planRaw += evt.text;
      else if (evt.type === 'reasoning') planReasoning += evt.text;
    }
  } catch (err) {
    ctx.print(`[Phase 1] planning LLM call failed: ${err.message}`);
    ctx.print(`[Phase 1] falling back to one batch per file.`);
  }
  if (!planRaw.trim() && planReasoning.trim()) {
    const m = planReasoning.match(/topic-id[\s\S]*$/i);
    if (m) planRaw = m[0];
  }

  let plan = parsePlanText(planRaw);
  // Validate: every parsed file must appear in some batch. Files not assigned
  // by the LLM are given their own batch so nothing is dropped (the user asked
  // to ensure all files are learned).
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

  const { writeKnowledge, readKnowledge } = await import('../../lib/store/kb_store.js');
  const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
  const rt = await getRuntime(p.id).catch(() => null);
  const projectId = p.id;

  // Map label -> parsed text for fast lookup
  const textByLabel = new Map(parsedFiles.map(f => [f.path, f]));

  // For holy writes we ask for interactive confirmation once per run (not per
  // entry) to avoid spamming; the user already chose --space=holy explicitly.
  if (space === 'holy' && !dryRun) {
    ctx.print(`[holy] You are about to write learned entries to HOLY space.`);
    ctx.print(`  Holy Space is the source of truth for stable design knowledge.`);
    const holyConfirmed = await ctx.confirm(`Write learned entries to holy? (y/N) `);
    if (!holyConfirmed) {
      ctx.print(`Cancelled. Re-run with --space=eden, or confirm to proceed.`);
      return;
    }
  }

  let totalSaved = 0;
  let totalAccepted = 0;
  let totalDiscarded = 0;
  let totalProposed = 0;
  const processedLabels = new Set();

  // Shared Phase 2 study routine: feed one group of sources to the model,
  // cross-check the proposed entries, and write accepted ones. Mutates the
  // outer counters + existing-entry lists so later batches avoid duplicates.
  async function studySources(sources, topic, description) {
    if (sources.length === 0) return;
    const sourcesChars = sources.reduce((s, f) => s + f.text.length, 0);
    ctx.print(`  deep-read: ${sources.length} file(s), ${sourcesChars} chars`);

    const holyNow = existingHoly.map(e => `- ${e.id}: ${e.title}`).join('\n');
    const edenNow = existingEden.map(e => `- ${e.id}: ${e.title}`).join('\n');

    const contextParts = [];
    for (const s of sources) {
      contextParts.push(`## ${s.path}\n\`\`\`\n${s.text}\n\`\`\``);
    }
    // Budget is enforced by groupByBudget before we get here, so this slice is
    // only a last-resort guard against a single oversized source.
    const batchContext = contextParts.join('\n\n').slice(0, perBatchChars);

    const extractSysPrompt = buildLearnExtractSysPrompt(space, holyNow, edenNow, userPrompt);
    const extractUserPrompt = `Source documents for topic "${topic}": ${description}\n\nBelow are the document contents. Extract ${space} knowledge entries.\n\n${batchContext}`;

    let raw = '';
    let rawReasoning = '';
    try {
      for await (const evt of ctx.streamLLM(
        [
          { role: 'system', content: extractSysPrompt },
          { role: 'user', content: extractUserPrompt },
        ],
        { temperature: 0.1, maxChars: 65536, enableReasoning: true, timeoutMs: 300000 },
      )) {
        if (evt.type === 'delta') raw += evt.text;
        else if (evt.type === 'reasoning') rawReasoning += evt.text;
      }
    } catch (err) {
      ctx.print(`  LLM call failed: ${err.message} - skipping.`);
      return;
    }
    if (!raw.trim() && rawReasoning.trim()) {
      const m = rawReasoning.match(/\[[\s\S]*\]/);
      if (m) raw = m[0];
    }

    let proposed = null;
    try { proposed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) { try { proposed = JSON.parse(m[0]); } catch {} }
    }
    if (!Array.isArray(proposed)) {
      ctx.print('  (could not parse as JSON array - skipping)');
      return;
    }
    totalProposed += proposed.length;
    if (proposed.length === 0) {
      ctx.print('  (no entries)');
      return;
    }

    const { accepted, discarded: disc } = crossCheckEntries(proposed, existingHoly, existingEden);
    ctx.print(`  proposed: ${proposed.length}, accepted: ${accepted.length}, discarded: ${disc.length}`);
    for (const e of accepted) {
      ctx.print(`    [ACCEPT] ${e.id}: ${e.title || ''} (${(e.intro || '').length}c)`);
    }
    totalAccepted += accepted.length;
    totalDiscarded += disc.length;

    if (!dryRun && accepted.length > 0) {
      for (const entry of accepted) {
        const id = String(entry.id).replace(/[^A-Za-z0-9_.-]/g, '_');
        const record = {
          id, space,
          title: entry.title, intro: entry.intro,
          keyFiles: Array.isArray(entry.keyFiles) ? entry.keyFiles : [],
          keySymbols: Array.isArray(entry.keySymbols) ? entry.keySymbols : [],
          keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
          autoLearned: true, learned: true,
        };
        await writeKnowledge(projectId, space, record);
        const final = await readKnowledge(projectId, space, id);
        if (final && rt) rt.reloadKnowledge?.(final, space);
        if (space === 'holy') existingHoly.push(record);
        else existingEden.push(record);
        totalSaved++;
      }
    }
  }

  for (let batchIdx = 0; batchIdx < plan.length; batchIdx++) {
    const batch = plan[batchIdx];
    ctx.setPhase?.(`studying [${batchIdx + 1}/${plan.length}] ${batch.topic}`);
    ctx.print(`--- [${batchIdx + 1}/${plan.length}] ${batch.topic}: ${batch.description || ''} ---`);

    // Gather parsed text for this batch's files
    const sources = [];
    for (const rel of batch.files || []) {
      const f = textByLabel.get(rel) || findByLabel(textByLabel, rel);
      if (!f) continue;
      sources.push(f);
      processedLabels.add(f.path);
    }
    if (sources.length === 0) {
      ctx.print('  (no readable files in batch - skipping)');
      continue;
    }
    // Budget enforcement: an oversized batch (e.g. several book parts grouped
    // together) is studied in sub-groups so the model context never silently
    // truncates content (the original bug).
    const groups = groupByBudget(sources, perBatchChars);
    for (let gi = 0; gi < groups.length; gi++) {
      if (groups.length > 1) {
        ctx.print(`  sub-batch ${gi + 1}/${groups.length}: ${groups[gi].map(s => s.path).join(', ')}`);
      }
      await studySources(groups[gi], batch.topic, batch.description || '');
    }
  }

  // Safety net: if the planner dropped a file (no batch referenced it), study
  // it now so the user's "ensure all files learned" requirement is honored.
  const dropped = parsedFiles.filter(f => !processedLabels.has(f.path));
  if (dropped.length > 0) {
    ctx.print('');
    ctx.print(`[safety] ${dropped.length} file(s) were not covered by any batch - studying individually.`);
    for (const f of dropped) processedLabels.add(f.path);
    // Re-run Phase 2 with a single-file fallback plan.
    const fallbackPlan = dropped.map((f, i) => ({ topic: `fallback-${i + 1}`, description: f.path, files: [f.path] }));
    for (let batchIdx = 0; batchIdx < fallbackPlan.length; batchIdx++) {
      const batch = fallbackPlan[batchIdx];
      ctx.setPhase?.(`studying [fallback ${batchIdx + 1}/${fallbackPlan.length}] ${batch.topic}`);
      ctx.print(`--- [fallback ${batchIdx + 1}/${fallbackPlan.length}] ${batch.topic}: ${batch.description || ''} ---`);
      const sources = [findByLabel(textByLabel, batch.files[0])].filter(Boolean);
      if (sources.length === 0) continue;
      await studySources(sources, batch.topic, batch.description || '');
    }
  }

  // ---- Final summary ----
  ctx.setPhase?.('idle');
  ctx.print('');
  ctx.print('=== /kb knowledge learn complete ===');
  ctx.print(`  target files: ${targetFiles.length}`);
  ctx.print(`  parsed files: ${parsedFiles.length}`);
  ctx.print(`  batches studied: ${plan.length + (dropped.length ? dropped.length : 0)}`);
  ctx.print(`  total proposed: ${totalProposed}`);
  ctx.print(`  total accepted: ${totalAccepted}`);
  ctx.print(`  total discarded: ${totalDiscarded}`);
  if (dryRun) {
    ctx.print(`  [dry-run] ${totalAccepted} entries would have been saved to ${space}.`);
  } else if (totalSaved > 0) {
    ctx.print(`  ${totalSaved} ${space} entr${totalSaved === 1 ? 'y' : 'ies'} saved.`);
  } else {
    ctx.print('  (no entries saved)');
  }
}

/**
 * System prompt for the per-batch extraction phase of /kb knowledge learn.
 * Parameterized by target space so the model writes the right kind of entry.
 */
function buildLearnExtractSysPrompt(space, holySummary, edenSummary, userPrompt) {
  const spaceGuidance = space === 'holy'
    ? `The target space is HOLY - stable design knowledge that rarely changes: architecture, core algorithms, fundamental patterns, design principles. Only write genuinely stable, reusable design knowledge. If a document only contains ephemeral details (config values, version lists, one-off notes), return [].`
    : `The target space is EDEN - frequently-updated knowledge: API/command catalogs, function lists, module summaries, observed patterns, how-to checklists. Things that may evolve are welcome.`;
  return `You are analyzing documents (PDF / Word / PowerPoint / Markdown) to extract reusable knowledge entries for the project's KB ${space.toUpperCase()} Space.

${spaceGuidance}

For each piece of knowledge, decide whether it belongs in ${space.toUpperCase()}:
- Stable design knowledge (architecture, algorithms)? -> ${space === 'holy' ? 'INCLUDE' : 'SKIP (that is Holy Space)'}.
- Catalog / list / summary that may change? -> ${space === 'eden' ? 'INCLUDE' : 'SKIP (that is Eden Space)'}.

Output STRICT JSON array:
[
  {
    "id": "kebab-case-id",
    "title": "human-readable title",
    "intro": "2-5 paragraph prose explaining this knowledge; include key names, commands, and patterns mentioned in the documents",
    "keyFiles": ["document-relative paths or source file references"],
    "keySymbols": ["named entities / functions / commands / terms"],
    "keywords": ["english search terms"]
  }
]

Rules:
- Ground every entry in the ACTUAL document contents provided. Quote real terms and commands.
- Do NOT duplicate existing Holy or Eden entries.
- Aim for 1-6 entries per batch. Quality over quantity.
- If no extractable ${space} knowledge, return [].

Existing Holy entries (DO NOT duplicate):
${holySummary || '(none)'}

Existing Eden entries (DO NOT duplicate):
${edenSummary || '(none)'}
${userPrompt ? `\nAdditional user instructions (follow these when extracting knowledge):\n${userPrompt}` : ''}`;
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
  const lines = text.split('\n');
  // A pipe-delimited plan line needs at least TWO pipes (topic | desc | files).
  // A single pipe is more likely prose ("either x | y" or a markdown table row
  // header) than a real plan line — require three fields.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
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
      .split(/[,\s]+/)
      .map(s => s.replace(/^\.?\/+/, '').trim())
      .filter(f => f && /\.[a-z0-9]+$/i.test(f));
    if (files.length === 0) continue;

    batches.push({ topic, description, files });
  }

  return batches.length > 0 ? batches : null;
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
 * System prompt for the Eden extraction phase.
 */
function buildExtractSysPrompt(holySummary, edenSummary, userPrompt) {
  return `You are analyzing source code from a software project to extract reusable knowledge entries for the project's KB Eden Space.

Eden Space holds frequently-updated knowledge: function lists, command catalogs, API surface summaries, observed coding patterns, module responsibilities — things that may evolve.

For each piece of knowledge:
- Stable design knowledge (architecture, algorithms)? → SKIP (that's Holy Space).
- Catalog / list / summary that may change? → INCLUDE.

Output STRICT JSON array:
[
  {
    "id": "kebab-case-id",
    "title": "human-readable title",
    "intro": "2-4 paragraph prose explaining this knowledge",
    "keyFiles": ["project-relative paths"],
    "keySymbols": ["function/type/macro names"],
    "keywords": ["english search terms"]
  }
]

Rules:
- Use REAL identifiers and file paths from the provided source code.
- Do NOT duplicate existing Holy or Eden entries.
- Aim for 1-5 entries. Quality over quantity.
- If no extractable knowledge, return [].

Existing Holy entries (DO NOT duplicate):
${holySummary || '(none)'}

Existing Eden entries (DO NOT duplicate):
${edenSummary || '(none)'}
${userPrompt ? `\nAdditional user instructions (follow these when extracting knowledge):\n${userPrompt}` : ''}`;
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
/**
 * Collect project documentation files (*.md, *.rst, *.txt) under sourcePath/docs,
 * sourcePath/doc, and sourcePath root (README etc.).
 */
async function collectProjectDocs(project, maxChars) {
  const docsRoots = [
    path.join(project.sourcePath, 'docs'),
    path.join(project.sourcePath, 'doc'),
    path.join(project.sourcePath, project.sourceRoot || '', 'docs'),
    path.join(project.sourcePath, project.sourceRoot || '', 'doc'),
  ];
  // Also check root README/CHANGELOG
  const rootCandidates = ['README.md', 'README.rst', 'README', 'CHANGELOG.md', 'CHANGELOG'];
  const collected = [];
  let totalChars = 0;
  for (const root of docsRoots) {
    const files = await walkDocFiles(root, 30).catch(() => []);
    for (const f of files) {
      if (totalChars >= maxChars) break;
      try {
        let text = await fs.readFile(f, 'utf8');
        if (text.length > 20000) text = text.slice(0, 20000) + '\n...(truncated)';
        collected.push({ path: path.relative(project.sourcePath, f), text });
        totalChars += text.length;
      } catch {}
    }
  }
  // Check root README
  for (const name of rootCandidates) {
    const rp = path.join(project.sourcePath, name);
    if (totalChars >= maxChars) break;
    try {
      let text = await fs.readFile(rp, 'utf8');
      if (text.length > 4000) text = text.slice(0, 4000) + '\n...(truncated)';
      collected.push({ path: name, text });
      totalChars += text.length;
    } catch {}
  }
  return collected;
}

async function walkDocFiles(root, limit, depth = 0) {
  if (depth > 3 || limit <= 0) return [];
  const out = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  for (const ent of entries) {
    if (limit <= 0) break;
    if (ent.name.startsWith('.git') || ent.name === 'node_modules') continue;
    const fp = path.join(root, ent.name);
    if (ent.isDirectory()) {
      const sub = await walkDocFiles(fp, limit, depth + 1);
      out.push(...sub);
      limit -= sub.length;
    } else if (/\.(md|rst|txt|adoc)$/i.test(ent.name)) {
      out.push(fp);
      limit--;
    }
  }
  return out;
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
 * Removes ALL entries from the specified space(s). Irreversible.
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
    counts[space] = entries.length;
    totalCount += entries.length;
  }

  if (totalCount === 0) {
    ctx.print(`Selected space(s) already empty.`);
    return;
  }

  const breakdown = spaces.map(s => `${s}=${counts[s]}`).join(', ');
  ctx.print(`This will permanently delete ${totalCount} entries (${breakdown}).`);
  ctx.print(`This action is IRREVERSIBLE.`);
  const ok = await ctx.confirm(`Empty ${scope} space(s)? (y/N) `);
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
      if (e.id) {
        await deleteKnowledge(p.id, space, e.id);
        removed++;
      }
    }
  }
  dropRuntime(p.id);
  ctx.print(`Emptied: removed ${removed} entries from ${breakdown}.`);
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

async function knowledgeCleanupKb(rest, ctx) {
  const scope = rest[0];
  if (!scope || !['eden', 'holy', 'all'].includes(scope)) {
    ctx.print(`Usage: /kb knowledge cleanup <eden|holy|all>`);
    return;
  }
  const p = await getProjectOrFail(ctx);
  if (!p) return;

  const spaces = scope === 'all' ? ['eden', 'holy'] : [scope];
  const { deleteKnowledge } = await import('../../lib/store/kb_store.js');
  const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');

  let totalRemoved = 0;
  let totalKept = 0;

  for (const space of spaces) {
    const entries = await listKnowledge(p.id, space).catch(() => []);
    if (entries.length === 0) {
      ctx.print(`[${space}] 0 entries — nothing to clean.`);
      continue;
    }

    ctx.print(``);
    ctx.print(`[${space}] Scanning ${entries.length} entries...`);

    const toRemove = [];
    const seen = new Map(); // normalized-title → { id, introLen, idx }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const issues = [];

      // Check required fields
      if (!e.id) issues.push('missing id');
      if (!e.title || !e.title.trim()) issues.push('missing title');
      if (!e.intro || !e.intro.trim()) issues.push('missing intro');

      // Check for exact id duplicates
      if (e.id && seen.has('__id:' + e.id)) {
        issues.push(`duplicate id "${e.id}"`);
      }

      // Check for near-duplicate titles
      const normTitle = (e.title || '').toLowerCase().trim();
      if (normTitle) {
        for (const [key, existing] of seen) {
          if (key.startsWith('__title:')) {
            const prevTitle = key.slice(9);
            if (prevTitle === normTitle ||
                (prevTitle.length > 10 && (prevTitle.includes(normTitle) || normTitle.includes(prevTitle)))) {
              const thisIntro = (e.intro || '').length;
              if (thisIntro <= existing.introLen) {
                issues.push(`near-duplicate of "${existing.id}"`);
              }
              break;
            }
          }
        }
      }

      // Check keyword overlap for near-duplicates
      if (e.keywords && Array.isArray(e.keywords) && e.keywords.length > 0) {
        const thisKws = new Set(e.keywords.map(k => k.toLowerCase()));
        for (const [key, existing] of seen) {
          if (key.startsWith('__kws:')) {
            const prevKws = existing.kws;
            if (prevKws && prevKws.size > 0) {
              let overlap = 0;
              for (const k of thisKws) if (prevKws.has(k)) overlap++;
              const ratio = overlap / Math.min(thisKws.size, prevKws.size);
              if (ratio > 0.7) {
                const thisIntro = (e.intro || '').length;
                if (thisIntro <= existing.introLen) {
                  issues.push(`keyword-overlap with "${existing.id}" (${Math.round(ratio * 100)}%)`);
                }
                break;
              }
            }
          }
        }
      }

      if (issues.length > 0) {
        toRemove.push({ entry: e, reasons: issues });
      } else {
        seen.set('__id:' + (e.id || ''), { id: e.id, introLen: (e.intro || '').length });
        if (normTitle) seen.set('__title:' + normTitle, { id: e.id, introLen: (e.intro || '').length });
        if (e.keywords) seen.set('__kws:' + (e.id || ''), { id: e.id, introLen: (e.intro || '').length, kws: new Set(e.keywords.map(k => k.toLowerCase())) });
        totalKept++;
      }
    }

    if (toRemove.length === 0) {
      ctx.print(`  clean — no issues found (${entries.length} entries kept).`);
      continue;
    }

    ctx.print(`  ${toRemove.length} entr${toRemove.length === 1 ? 'y' : 'ies'} flagged for removal:`);
    for (const { entry, reasons } of toRemove) {
      ctx.print(`    - ${entry.id || '(no id)'}: ${reasons.join('; ')}`);
    }

    // Confirm
    const isHoly = space === 'holy';
    const prompt = isHoly
      ? `Remove these ${toRemove.length} Holy entr${toRemove.length === 1 ? 'y' : 'ies'}? This is irreversible. (y/N) `
      : `Remove these ${toRemove.length} Eden entr${toRemove.length === 1 ? 'y' : 'ies'}? (y/N) `;
    const ok = await ctx.confirm(prompt);
    if (!ok) {
      ctx.print(`  Skipped — all ${entries.length} entries kept.`);
      continue;
    }

    // Delete
    let removed = 0;
    for (const { entry } of toRemove) {
      if (entry.id) {
        const deleted = await deleteKnowledge(p.id, space, entry.id);
        if (deleted) removed++;
      }
    }
    totalRemoved += removed;
    ctx.print(`  Removed ${removed}, kept ${entries.length - removed}.`);
  }

  // Refresh runtime
  const rt = await getRuntime(p.id).catch(() => null);
  if (rt && totalRemoved > 0) {
    const { dropRuntime } = await import('../../lib/retrieval/kb_runtime.js');
    dropRuntime(p.id);
  }

  ctx.print(``);
  ctx.print(`Cleanup complete: ${totalRemoved} removed, ${totalKept} kept.`);
}

async function knowledgeDelKb(rest, ctx) {
  const id = rest[0];
  if (!id) { ctx.print(`Usage: /kb knowledge del <id>`); return; }
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
  const ok = await ctx.confirm(`Delete "${id}" from ${foundSpace} space? (y/N) `);
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
  const ok = await ctx.confirm(`Move "${id}" from ${fromSpace} → ${toSpace}? (y/N) `);
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
  const confirm = await ctx.confirm(`This will delete KB ~/.hk2/kb/${p.id}/ (irreversible). Continue? (y/N) `);
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
export const __learnTest = {
  isLearnableExt,
  walkLearnFiles,
  reconcilePlan,
  parseFlags,
  LEARN_DOC_EXTS,
  chunkDocText,
  groupByBudget,
  labelMatches,
};
