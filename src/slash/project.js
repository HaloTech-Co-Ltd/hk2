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
 * /project command family — manage ~/.hk2/projects.json.
 *
 * Usage:
 *   /project init [--name=NAME] [--source=PATH] [--source-root=REL] [--include=g,...] [--exclude=g,...]
 *                 [--extra=name:relRoot,...]
 *                 Register a new project (UUID), set as current. Does not
 *                 build the KB (use /kb init for that).
 *   /project list                       List all projects
 *   /project set current <id|name>      Switch current project
 *   /project set name <new-name>        Rename
 *   /project set source <path>          Update source path
 *   /project show                       Show current project details
 *   /project drop <id|name>             Remove project (KB preserved)
 */
import {
  registerProject, loadProjects,
  getCurrentProject, setCurrentProject, updateProject, removeProject,
  phaseStorageKeyToCliName, supportedPhaseNames,
} from '../../lib/config/home.js';
import { printCommandHelp } from './help.js';

export async function cmdProject(args, ctx) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'init': return initProject(rest, ctx);
    case 'list': case 'ls': return listProjects(ctx);
    case 'set': return setProject(rest, ctx);
    case 'show': return showProject(ctx);
    case 'drop': case 'rm': return dropProject(rest, ctx);
    case 'help': case '?': case undefined:
      printCommandHelp(ctx, 'project');
      return;
    default:
      ctx.print(`Unknown /project subcommand: ${sub}`);
      printCommandHelp(ctx, 'project');
  }
}

async function initProject(rest, ctx) {
  const flags = parseFlags(rest);
  if (!flags.source) {
    ctx.print(`Missing --source=<path>. Example: /project init --source=./myproject --source-root=src`);
    return;
  }
  try {
    const extraRoots = flags.extra
      ? String(flags.extra).split(',').map(s => {
          const colon = s.indexOf(':');
          if (colon <= 0) return null;
          return { name: s.slice(0, colon), relRoot: s.slice(colon + 1) };
        }).filter(Boolean)
      : [];
    const rec = await registerProject({
      name: flags.name,
      sourcePath: flags.source,
      sourceRoot: flags['source-root'] || '',
      includeGlobs: flags.include ? String(flags.include).split(',') : undefined,
      excludeGlobs: flags.exclude ? String(flags.exclude).split(',') : undefined,
      extraRoots,
    });
    ctx.print(`Registered project: ${rec.name}  id=${rec.id}`);
    ctx.print(`  sourcePath: ${rec.sourcePath}`);
    ctx.print(`  sourceRoot: ${rec.sourceRoot || '(none)'}`);
    ctx.print(`  include: ${rec.includeGlobs.join(', ')}`);
    ctx.print(`  exclude: ${rec.excludeGlobs.length} pattern(s)`);
    if (rec.extraRoots.length) {
      ctx.print(`  extra:`);
      for (const r of rec.extraRoots) ctx.print(`    ${r.name} -> ${r.relRoot}`);
    }
    ctx.print(`Next step: /kb init`);
    ctx.noteReloadProject?.();
  } catch (err) {
    ctx.print(`Error: ${err.message}`);
  }
}

async function listProjects(ctx) {
  const { current, projects } = await loadProjects();
  const list = Object.values(projects || {});
  if (list.length === 0) {
    ctx.print(`(empty. Use /project init --source=... to add one)`);
    return;
  }
  ctx.print(`Projects (current: ${current || '(none)'})`);
  for (const p of list) {
    const marker = p.id === current ? '* ' : '  ';
    ctx.print(`${marker}${p.name}  ${p.id}`);
    ctx.print(`      source=${p.sourcePath}`);
    if (p.sourceRoot) ctx.print(`      sourceRoot=${p.sourceRoot}`);
    ctx.print(`      kb=${p.kbBuiltAt ? 'built ' + p.kbBuiltAt.slice(0, 10) : '(not built)'}`);
  }
}

async function setProject(rest, ctx) {
  const key = rest[0];
  const val = rest.slice(1).join(' ').trim();
  if (!key) {
    ctx.print(`Usage:`);
    ctx.print(`  /project set current <id|name>`);
    ctx.print(`  /project set name <new-name>`);
    ctx.print(`  /project set source <path>`);
    ctx.print(`  /project set source-root <rel-path>`);
    ctx.print(`  /project set include <glob1,glob2,...>`);
    ctx.print(`  /project set exclude <glob1,glob2,...>`);
    return;
  }
  // Resolve the project via the session pin (ctx.getCurrentProject) when the
  // host provides it, falling back to the shared global pointer otherwise.
  // This keeps /project set/show operating on THIS session's project even
  // when a parallel `hk2 --project=<other>` has rewritten the global current.
  const getter = ctx.getCurrentProject || (() => getCurrentProject());
  const cur = await getter.call(ctx);
  if (!cur) {
    ctx.print(`No current project. Run /project init or /project set current <id> first.`);
    return;
  }
  if (key === 'current') {
    // Switch BOTH the shared global pointer and this session's pin.
    const switcher = ctx.setCurrentProject || (async (v) => setCurrentProject(v));
    const target = await switcher.call(ctx, val);
    if (!target) { ctx.print(`Not found: ${val}`); return; }
    ctx.print(`current = ${target.name} (${target.id})`);
    // ctx.setCurrentProject already flagged reload; only flag for the fallback.
    if (!ctx.setCurrentProject) ctx.noteReloadProject?.();
    return;
  }
  if (key === 'name') {
    if (!val) { ctx.print(`name cannot be empty`); return; }
    await updateProject(cur.id, { name: val });
    ctx.print(`name updated: ${val}`);
    ctx.noteReloadProject?.();
    return;
  }
  if (key === 'source') {
    if (!val) { ctx.print(`source cannot be empty`); return; }
    await updateProject(cur.id, { sourcePath: val });
    ctx.print(`sourcePath updated: ${val}`);
    ctx.print(`(run /kb init to rebuild the index with the new source)`);
    ctx.noteReloadProject?.();
    return;
  }
  if (key === 'source-root' || key === 'sourceRoot') {
    await updateProject(cur.id, { sourceRoot: val });
    ctx.print(`sourceRoot updated: ${val || '(cleared)'}`);
    ctx.print(`(run /kb init to rebuild the index)`);
    ctx.noteReloadProject?.();
    return;
  }
  if (key === 'include') {
    if (!val) { ctx.print(`include cannot be empty (comma-separated globs expected)`); return; }
    const globs = val.split(',').map(s => s.trim()).filter(Boolean);
    if (globs.length === 0) { ctx.print(`no valid globs parsed`); return; }
    await updateProject(cur.id, { includeGlobs: globs });
    ctx.print(`include updated: ${globs.join(', ')}`);
    ctx.print(`(run /kb init to rebuild the index)`);
    ctx.noteReloadProject?.();
    return;
  }
  if (key === 'exclude') {
    if (!val) { ctx.print(`exclude cannot be empty (comma-separated globs expected)`); return; }
    const globs = val.split(',').map(s => s.trim()).filter(Boolean);
    if (globs.length === 0) { ctx.print(`no valid globs parsed`); return; }
    await updateProject(cur.id, { excludeGlobs: globs });
    ctx.print(`exclude updated: ${globs.join(', ')}`);
    ctx.print(`(run /kb init to rebuild the index)`);
    ctx.noteReloadProject?.();
    return;
  }
  ctx.print(`Unknown set key: ${key}. Valid: current | name | source | source-root | include | exclude`);
}

async function showProject(ctx) {
  const getter = ctx.getCurrentProject || (() => getCurrentProject());
  const cur = await getter.call(ctx);
  if (!cur) {
    ctx.print(`No current project.`);
    return;
  }
  ctx.print(`current = ${cur.name}  (${cur.id})`);
  ctx.print(`  sourcePath: ${cur.sourcePath}`);
  ctx.print(`  sourceRoot: ${cur.sourceRoot || '(none)'}`);
  ctx.print(`  include: ${cur.includeGlobs.join(', ')}`);
  ctx.print(`  exclude: ${cur.excludeGlobs.join(', ')}`);
  if (cur.extraRoots && cur.extraRoots.length) {
    ctx.print(`  extra:`);
    for (const r of cur.extraRoots) ctx.print(`    ${r.name} -> ${r.relRoot}`);
  }
  ctx.print(`  kbBuiltAt: ${cur.kbBuiltAt || '(not built, run /kb init)'}`);
  ctx.print(`  createdAt: ${cur.createdAt}`);
  const phaseModels = (cur.phaseModels && typeof cur.phaseModels === 'object' && !Array.isArray(cur.phaseModels)) ? cur.phaseModels : {};
  // ALWAYS list every supported phase (rewrite-query, plan-review, ...) so a
  // phase that hasn't been configured is still VISIBLE as an explicit
  // "(unset)" row. Previously showProject only iterated the SET entries in
  // phaseModels, so a project with no plan-review override printed nothing
  // for plan-review, which read as "plan-review config is missing" even though
  // the machinery was fine - it just falls back to the session model. Mapping
  // storage keys back to CLI names is preserved so labels match what the user
  // typed into `/model set-phase --phase=...`.
  const configured = new Map();
  for (const [key, v] of Object.entries(phaseModels)) {
    if (typeof v === 'string' && v) configured.set(phaseStorageKeyToCliName(key) || key, v);
  }
  ctx.print(`  phase models:`);
  for (const phase of supportedPhaseNames()) {
    const ref = configured.get(phase);
    ctx.print(`    ${phase} -> ${ref || '(unset; uses the current session model)'}`);
  }
  // Surface any leftover storage keys that aren't in PHASE_KEYS (e.g. a phase
  // that was renamed/removed upstream) so the data isn't silently hidden.
  for (const [phase, ref] of configured.entries()) {
    if (!supportedPhaseNames().includes(phase)) {
      ctx.print(`    ${phase} -> ${ref}  (unknown phase)`);
    }
  }
}

async function dropProject(rest, ctx) {
  const target = rest[0];
  if (!target) { ctx.print(`Usage: /project drop <id|name>`); return; }
  const { projects } = await loadProjects();
  const found = Object.values(projects || {}).find(p => p.id === target || p.name === target);
  if (!found) { ctx.print(`Not found: ${target}`); return; }
  const ok = await removeProject(found.id);
  if (!ok) { ctx.print(`Delete failed`); return; }
  ctx.print(`Removed project: ${found.name} (${found.id})`);
  ctx.print(`(KB directory ~/.hk2/kb/${found.id}/ preserved; remove manually if needed)`);
  ctx.noteReloadProject?.();
}

function parseFlags(tokens) {
  const out = {};
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
    }
  }
  return out;
}
