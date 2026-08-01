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
 * Tool registry. Each tool is { name, label, description, snippet, guidelines[], parameters, execute }.
 *   - description   : full description shown in tool spec to the LLM
 *   - snippet       : one-line summary injected into system prompt
 *   - guidelines    : array of usage rules injected into system prompt
 *
 * Tool protocol:
 *   - LLM emits OpenAI tool_calls / Anthropic tool_use blocks
 *   - adapter yields {type:'tool_call', id, name, arguments}
 *   - loop calls tool.execute(arguments) → result
 *   - result returned as {role:'tool', tool_call_id, name, content}
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists } from '../util/fs_atomic.js';
import { spawn } from 'node:child_process';
import { codeSearch } from '../retrieval/code_search.js';
import { shortHash } from '../util/hash.js';
import * as proposals from './proposals.js';

const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LINES = 2000;
const MAX_BASH_OUTPUT = 8192;
const BASH_TIMEOUT_MS = 60_000;

// Extensions covered by the KB. Used by:
//   - KbFirstGuard._isBashSearch / shouldHintRead — to decide when a bash or
//     read call should have used a KB tool instead.
//   - The read tool's hint message wording.
// Source + doc extensions both count: doc files (.md/.json/.yaml/…) are
// routed into Eden as `doc:<relpath>` entries by the indexer, so reading
// them directly bypasses kb_search_knowledge.
const SOURCE_EXT_RE = /\.(c|h|cpp|cc|hpp|cxx|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|scala|rb|php|swift|sh|bash|zsh|y|l|md|markdown|txt|rst|adoc|json|yaml|yml|html|htm|pdf|docx)$/i;

/* ------------------------------------------------------------------ */
/* KB-first guardrail (per LLM call)                                   */
/* ------------------------------------------------------------------ */

/**
 * Per-LLM-call KB-first policy tracker. Detects when the agent uses bash or
 * read in a way that should have used a KB tool first, and emits a one-time
 * hint.
 *
 * Lifecycle invariant (callers MUST honour this):
 *   - guard.reset()              at the start of EACH LLM stream call inside
 *                                runLoop (interactive.js fires this from the
 *                                onTurnStart callback). A user prompt spans
 *                                many LLM calls; the guard resets per call,
 *                                not per prompt.
 *   - guard.noteKbUsage()        whenever a KB tool actually runs (kb_search,
 *                                kb_symbol, kb_outline, kb_neighbors,
 *                                kb_callchain, kb_class, kb_refs, kb_implements,
 *                                kb_knowledge, kb_search_knowledge,
 *                                kb_save_knowledge) — and when read() prepends
 *                                a KB-sourced outline. Must be called AFTER the
 *                                tool's own precondition checks so that a
 *                                KB which exists but is missing the graph
 *                                (or fails to write) does not falsely mark
 *                                KB-used and suppress the hint when the
 *                                agent then falls back to bash.
 *                                completion — must be called AFTER the
 *                                tool's own precondition checks so that a
 *                                KB which exists but is missing the graph
 *                                (or fails to write) does not falsely mark
 *                                KB-used and suppress the hint when the
 *                                agent then falls back to bash.
 *   - guard.shouldHintBash(cmd)  true if the bash call violates KB-first
 *                                AND we haven't hinted yet this LLM call
 *   - guard.shouldHintRead(p)    true if the read violates KB-first AND
 *                                we haven't hinted yet this LLM call
 *
 * If a caller (e.g. a non-interactive one-shot path) constructs its own
 * `new KbFirstGuard()` without an external reset, the hint fires at most
 * once per process lifetime — usually wrong. Either thread the same guard
 * instance across LLM calls and reset() it, or skip the guard entirely.
 *
 * Once the agent uses any KB tool in this LLM call, subsequent bash/read
 * calls are considered "intentional fallbacks" and no hint is emitted.
 */
export class KbFirstGuard {
  constructor() {
    this.reset();
  }
  reset() {
    this.kbUsedThisTurn = false;
    this.bashHinted = false;
    this.readHinted = false;
  }
  noteKbUsage() {
    this.kbUsedThisTurn = true;
  }
  /**
   * Snapshot for transcript logging — lets us reconstruct later why a hint
   * did or didn't fire for a given tool call.
   */
  snapshot() {
    return {
      kbUsedThisTurn: this.kbUsedThisTurn,
      bashHinted: this.bashHinted,
      readHinted: this.readHinted,
    };
  }
  /**
   * Heuristic: does this bash command look like code/doc discovery that
   * the KB could have answered? Matches both direct search tools (grep,
   * ripgrep, git grep, fd, find, ag, ack) and source-file readers (cat,
   * sed, awk, head, tail, wc, nl, cut, paste, xxd, od, strings) when the
   * command line mentions a file with a source/doc extension.
   */
  _isBashSearch(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    const c = cmd.toLowerCase();
    if (/\b(grep|rg|ag|ack|git\s+grep|fd|locate|find)\b/.test(c)) return true;
    if (/\b(cat|sed|awk|head|tail|wc|nl|cut|paste|xxd|od|strings)\b/.test(c) && SOURCE_EXT_RE.test(c)) return true;
    return false;
  }
  shouldHintBash(cmd) {
    if (this.kbUsedThisTurn || this.bashHinted) return false;
    return this._isBashSearch(cmd);
  }
  bashHint(cmd) {
    this.bashHinted = true;
    return `[kb-first policy hint] This bash command looks like code discovery (grep/find/cat on source files). The project KB has a prebuilt index — try kb_search("<natural-language query>") or kb_symbol("<exact name>") instead; they hit the index directly and are faster + more accurate. Only fall back to bash when the KB genuinely doesn't have what you need (and at end of turn hk2 will offer to /kb update to capture any new symbols).`;
  }
  shouldHintRead(p) {
    if (this.kbUsedThisTurn || this.readHinted) return false;
    if (!p || typeof p !== 'string') return false;
    return SOURCE_EXT_RE.test(p);
  }
  readHint(p) {
    this.readHinted = true;
    return `[kb-first policy hint] You're reading a source file without having queried the KB yet this LLM call. Consider kb_search / kb_symbol first to confirm this is the right file and to discover related symbols / callers via kb_neighbors. (Hint shown once per LLM call.)`;
  }
}


/* ------------------------------------------------------------------ */
/* File tools                                                            */
/* ------------------------------------------------------------------ */

async function toolRead({ path: p, offset = 1, limit, outline = true }, guard, rt) {
  if (!p) return { error: 'path required' };
  const abs = resolveSafe(p);
  if (!abs) return { error: `path escapes workspace: ${p}` };
  if (!await exists(abs)) return { error: `not found: ${p}` };
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) return { error: `stat failed: ${p}` };
  if (stat.isDirectory()) return { error: `is directory: ${p}` };
  if (stat.size > 5 * 1024 * 1024) return { error: `file too large: ${stat.size} bytes` };

  let text;
  try { text = await fs.readFile(abs, 'utf8'); }
  catch (err) { return { error: `read failed: ${err.message}` }; }

  const lines = text.split('\n');
  // offset is 1-indexed
  const start = Math.max(0, (offset || 1) - 1);
  const lim = Math.max(1, Math.min(MAX_READ_LINES, limit || MAX_READ_LINES));
  const end = Math.min(lines.length, start + lim);
  const slice = lines.slice(start, end);
  const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n');

  // KB-first guardrail: if this is a source file AND the agent hasn't used
  // any KB tool yet this turn, prepend a one-time hint nudging toward
  // kb_search / kb_symbol. We still return the requested content.
  const hint = guard?.shouldHintRead(p) ? guard.readHint(p) : null;

  // KB outline prepend: when the file is a code file known to the KB and the
  // caller didn't disable it, surface the structural outline above the
  // content so the agent sees what each region contains before reading it.
  // Outline comes from the pre-built index (no extra parsing); if the file
  // isn't indexed, silently skip — the read-hint above already nudges.
  let outlineBlock = '';
  let tag;
  if (outline && rt && SOURCE_EXT_RE.test(p)) {
    const fileId = rt.getFileId?.(p);
    if (fileId !== null && fileId !== undefined) {
      const syms = (rt.getSymbolsInFile?.(fileId) || [])
        .slice().sort((a, b) => (a.lineStart || 0) - (b.lineStart || 0))
        .slice(0, 60);
      if (syms.length > 0) {
        const rows = syms.map(s => {
          const lines2 = s.lineEnd && s.lineStart ? ` (lines ${s.lineStart}-${s.lineEnd})` : '';
          const sig = s.signature ? ` — ${s.signature.slice(0, 100)}` : '';
          return `  ${s.kind.padEnd(10)} ${s.qualName || s.name}${lines2}${sig}`;
        });
        outlineBlock = `## Outline (from KB, ${syms.length} symbols)\n${rows.join('\n')}\n\n`;
        // Mark KB-used so subsequent bash/read on this file don't re-hint.
        guard?.noteKbUsage?.();
      }
      const hash = rt.files?.byId?.[fileId]?.hash;
      if (hash) tag = hash.slice(0, 8);
    }
  }

  return {
    path: path.relative(process.cwd(), abs) || abs,
    totalLines: lines.length,
    shownLines: `${start + 1}-${end}`,
    content: hint ? `${hint}\n${outlineBlock}${numbered}` : `${outlineBlock}${numbered}`,
    kbHint: hint || undefined,
    tag,
  };
}

async function toolWrite({ path: p, content }) {
  if (!p) return { error: 'path required' };
  if (typeof content !== 'string') return { error: 'content must be string' };
  const abs = resolveSafe(p);
  if (!abs) return { error: `path escapes workspace: ${p}` };
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { path: path.relative(process.cwd(), abs) || abs, bytes: Buffer.byteLength(content) };
}

/**
 * Edit tool: single-string replacement with optional multi-edit shorthand.
 */
async function toolEdit({ path: p, old_string, new_string, oldText, newText, edits, tag }) {
  if (!p) return { error: 'path required' };
  const abs = resolveSafe(p);
  if (!abs) return { error: `path escapes workspace: ${p}` };
  if (!await exists(abs)) return { error: `not found: ${p}` };

  // Normalize: accept either {old_string,new_string} or {edits:[{oldText,newText}]}
  const editList = Array.isArray(edits) && edits.length > 0
    ? edits.map(e => ({ old: e.oldText, neu: e.newText }))
    : [{ old: oldText ?? old_string, neu: newText ?? new_string }];

  const text = await fs.readFile(abs, 'utf8');
  // Hashline-style anchored edit: if the caller passed `tag` (shortHash from
  // a prior read/kb_outline), reject when the file's current content hash
  // differs — protects against silent overwrites when the file changed
  // between read and edit (race or stale index).
  if (tag && shortHash(text) !== tag) {
    return {
      error: `stale tag: file changed since read (expected ${tag}, got ${shortHash(text)})`,
      hint: 'Re-read the file to refresh the tag, or omit tag to skip the safety check.',
    };
  }
  let next = text;
  for (const e of editList) {
    if (typeof e.old !== 'string' || typeof e.neu !== 'string') return { error: 'edit.oldText/newText must be strings' };
    if (e.old === e.neu) return { error: 'oldText === newText' };
    const idx = next.indexOf(e.old);
    if (idx === -1) return { error: 'oldText not found' };
    const idx2 = next.indexOf(e.old, idx + 1);
    if (idx2 !== -1) return { error: `oldText not unique (matches at ${idx}, ${idx2})` };
    next = next.slice(0, idx) + e.neu + next.slice(idx + e.old.length);
  }
  await fs.writeFile(abs, next);
  return { path: path.relative(process.cwd(), abs) || abs, applied: editList.length };
}

async function toolGlob({ pattern, path: cwd, limit }) {
  if (!pattern) return { error: 'pattern required' };
  const root = cwd ? resolveSafe(cwd) : process.cwd();
  if (!root) return { error: `cwd escapes workspace: ${cwd}` };
  const lim = Math.max(1, Math.min(1000, limit || 1000));
  const results = await globWalk(root, pattern, lim);
  return { cwd: root, count: results.length, files: results };
}

async function toolGrep({ pattern, path: cwd, glob: globPat, ignoreCase, literal, context, limit }) {
  if (!pattern) return { error: 'pattern required' };
  const root = cwd ? resolveSafe(cwd) : process.cwd();
  if (!root) return { error: `path escapes workspace: ${cwd}` };
  const lim = Math.max(1, Math.min(100, limit || 100));
  let re;
  try {
    re = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ignoreCase ? 'i' : '');
  } catch (err) { return { error: `bad regex: ${err.message}` }; }
  const files = await globWalk(root, globPat || '**/*', 500);
  const matches = [];
  const ctx = Math.max(0, Math.min(5, context || 0));
  for (const f of files) {
    if (matches.length >= lim) break;
    let text;
    try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const before = ctx > 0 ? lines.slice(Math.max(0, i - ctx), i) : [];
        const after = ctx > 0 ? lines.slice(i + 1, i + 1 + ctx) : [];
        matches.push({
          file: path.relative(root, f),
          line: i + 1,
          text: lines[i].slice(0, 240),
          before: before.map((t, j) => ({ line: i - ctx + j + 1, text: t.slice(0, 240) })),
          after: after.map((t, j) => ({ line: i + 1 + j + 1, text: t.slice(0, 240) })),
        });
        if (matches.length >= lim) break;
      }
    }
  }
  return { count: matches.length, matches };
}

/**
 * Structural-text code search. Translates ast-grep-style patterns to regex
 * via lib/parser/ts_parser.js:queryWithTreeSitter (a v1 regex approximation
 * until full AST-query translation ships). Kb-first behaviour: if the pattern
 * is a bare identifier that the KB knows about, prepend a hint suggesting
 * kb_symbol — exact-name lookups are cheaper through the index.
 */
async function toolAstGrep({ pat, path: cwd, glob: globPat, limit }, guard, rt) {
  if (!pat) return { error: 'pat required' };
  const root = cwd ? resolveSafe(cwd) : process.cwd();
  if (!root) return { error: `cwd escapes workspace: ${cwd}` };
  const lim = Math.max(1, Math.min(50, limit || 30));
  const files = await globWalk(root, globPat || '**/*', 200);
  const { queryWithTreeSitter } = await import('../parser/ts_parser.js');
  const out = [];
  const filesWithMatches = new Set();
  for (const f of files) {
    if (out.length >= lim) break;
    let text;
    try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
    const ext = path.extname(f).slice(1).toLowerCase();
    if (!ext || !SOURCE_EXT_RE.test('.' + ext)) continue;   // code files only
    const matches = await queryWithTreeSitter(text, ext, pat);
    if (!matches) continue;
    for (const m of matches) {
      if (out.length >= lim) break;
      out.push({
        path: path.relative(root, f),
        startLine: m.startLine, endLine: m.endLine,
        text: m.text.slice(0, 240),
        meta: m.meta,
      });
      filesWithMatches.add(f);
    }
  }
  // KB-first hint: when `pat` is a bare identifier the KB knows, prepend the
  // hint once per call so the agent considers kb_symbol next time. Doesn't
  // mark KB-used (ast_grep is a search, like grep — exact same scoping rule).
  let kbHint;
  if (rt && guard && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pat)) {
    const known = rt.getSymbolsByName?.(pat) || [];
    if (known.length > 0) {
      kbHint = `[kb-first policy hint] Pattern "${pat}" is an exact identifier the KB knows (${known.length} symbol${known.length === 1 ? '' : 's'}). Use kb_symbol("${pat}") for direct lookup; ast_grep is for structural / multi-name patterns.`;
    }
  }
  return {
    pattern: pat,
    scope: path.relative(process.cwd(), root) || '.',
    matchCount: out.length,
    fileCount: filesWithMatches.size,
    matches: out,
    kbHint,
  };
}

/**
 * Structural rewrite with preview/accept. Computes proposed writes for each
 * (pattern → template) op across the listed paths, returns a unified diff
 * preview + proposalId, and stashes the writes for `toolResolve`. Never
 * touches the filesystem itself.
 *
 * Template substitution: `$$$IDENT` / `$IDENT` / `$_` in `out` are replaced
 * with the corresponding capture from the match in `pat`. Literal text is
 * preserved. Example:
 *   pat:   'console.log($$$)'
 *   out:   'logger.info($$$)'
 * replaces every console.log call with logger.info, args preserved.
 */
async function toolAstEdit({ ops, paths, tag }, _guard) {
  if (!Array.isArray(ops) || ops.length === 0) return { error: 'ops[] required (at least one {pat, out})' };
  if (!Array.isArray(paths) || paths.length === 0) return { error: 'paths[] required' };
  for (const op of ops) {
    if (!op || typeof op.pat !== 'string' || typeof op.out !== 'string') {
      return { error: 'each op needs {pat: string, out: string}' };
    }
  }

  const { queryWithTreeSitter } = await import('../parser/ts_parser.js');

  // Resolve paths to absolute file lists.
  const allFiles = [];
  for (const p of paths) {
    const root = resolveSafe(p);
    if (!root) return { error: `path escapes workspace: ${p}` };
    let stat;
    try { stat = await fs.stat(root); } catch { return { error: `not found: ${p}` }; }
    if (stat.isFile()) {
      allFiles.push(root);
    } else if (stat.isDirectory()) {
      const walked = await globWalk(root, '**/*', 200);
      for (const f of walked) allFiles.push(f);
    }
  }

  const stagedFiles = [];   // [{ path, abs, prev, next, tag, diffHunks }]
  let totalAdd = 0, totalDel = 0;

  for (const abs of allFiles) {
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (!ext || !SOURCE_EXT_RE.test('.' + ext)) continue;
    let text;
    try { text = await fs.readFile(abs, 'utf8'); } catch { continue; }
    // Optional hashline-style tag: reject if the file's current tag differs.
    const currentTag = shortHash(text);
    if (tag && tag !== currentTag) {
      return { error: `stale tag for ${path.relative(process.cwd(), abs)}: expected ${tag}, got ${currentTag}` };
    }
    let next = text;
    let fileChanged = false;
    for (const op of ops) {
      const matches = await queryWithTreeSitter(next, ext, op.pat);
      if (!matches || matches.length === 0) continue;
      // Apply matches in reverse offset order so earlier substitutions don't
      // shift later offsets.
      const sorted = matches.slice().sort((a, b) => (a._startOff ?? 0) - (b._startOff ?? 0));
      // We don't have offsets from queryWithTreeSitter (regex returns line/col).
      // Re-run the same regex to get offsets; if the API returned offsets, we'd
      // use them. For v1, re-extract via the pattern.
      // Simpler: substitute left-to-right by repeatedly searching for the
      // matched text. This is O(n*m) but fine for v1 with the 50-match cap.
      for (const m of sorted) {
        const replacement = substituteTemplate(op.out, m.meta);
        // Use the literal matched text as the search key (m.text).
        const idx = next.indexOf(m.text);
        if (idx === -1) continue;
        next = next.slice(0, idx) + replacement + next.slice(idx + m.text.length);
        fileChanged = true;
      }
    }
    if (!fileChanged) continue;
    const hunks = makeDiffHunks(text, next);
    for (const h of hunks) {
      for (const line of h.lines) {
        if (line.kind === 'add') totalAdd++;
        else if (line.kind === 'del') totalDel++;
      }
    }
    stagedFiles.push({
      path: path.relative(process.cwd(), abs),
      abs,
      prev: text,
      next,
      tag: currentTag,
      diffHunks: hunks,
    });
  }

  if (stagedFiles.length === 0) {
    return {
      proposed: false,
      proposalId: null,
      diffs: [],
      summary: { files: 0, additions: 0, deletions: 0 },
      message: 'No matches found for the given ops/paths combination.',
    };
  }

  const proposalId = randomUUID();
  proposals.stage(proposalId, stagedFiles.map(f => ({
    path: f.path, abs: f.abs, next: f.next, prev: f.prev, tag: f.tag,
  })));

  return {
    proposed: true,
    proposalId,
    diffs: stagedFiles.map(f => ({ path: f.path, hunks: f.diffHunks })),
    summary: { files: stagedFiles.length, additions: totalAdd, deletions: totalDel },
  };
}

/**
 * Apply or discard a previously-staged ast_edit proposal.
 *   action: 'apply'   — write each staged file (re-validates tag first)
 *   action: 'discard' — drop the stash entry without writing
 */
async function toolResolve({ proposal_id, action }) {
  if (!proposal_id) return { error: 'proposal_id required' };
  if (action !== 'apply' && action !== 'discard') {
    return { error: "action must be 'apply' or 'discard'" };
  }
  const entry = proposals.get(proposal_id);
  if (!entry) return { error: `unknown or expired proposal: ${proposal_id}` };

  if (action === 'discard') {
    proposals.drop(proposal_id);
    return { applied: 0, discarded: entry.files.length, proposalId: proposal_id };
  }

  // Apply: re-validate each file's tag, then write. Roll back on any failure.
  const written = [];
  for (const f of entry.files) {
    let current;
    try { current = await fs.readFile(f.abs, 'utf8'); }
    catch (err) {
      // Roll back
      for (const w of written) {
        try { await fs.writeFile(w.abs, w.prev); } catch {}
      }
      proposals.drop(proposal_id);
      return { error: `read failed for ${f.path}: ${err.message}`, rolledBack: written.length };
    }
    if (f.tag && shortHash(current) !== f.tag) {
      for (const w of written) {
        try { await fs.writeFile(w.abs, w.prev); } catch {}
      }
      proposals.drop(proposal_id);
      return {
        error: `stale tag for ${f.path}: file changed between preview and resolve`,
        rolledBack: written.length,
      };
    }
    try { await fs.writeFile(f.abs, f.next); }
    catch (err) {
      for (const w of written) {
        try { await fs.writeFile(w.abs, w.prev); } catch {}
      }
      proposals.drop(proposal_id);
      return { error: `write failed for ${f.path}: ${err.message}`, rolledBack: written.length };
    }
    written.push(f);
  }
  proposals.drop(proposal_id);
  return { applied: written.length, discarded: 0, proposalId: proposal_id };
}

/** Replace $IDENT / $$$IDENT / $_ in `tmpl` with captures from `meta`. */
function substituteTemplate(tmpl, meta) {
  let out = '';
  let i = 0;
  while (i < tmpl.length) {
    if (tmpl[i] === '$') {
      if (tmpl[i + 1] === '$' && tmpl[i + 2] === '$') {
        let j = i + 3, name = '';
        while (j < tmpl.length && /[A-Za-z0-9_]/.test(tmpl[j])) { name += tmpl[j]; j++; }
        if (name && meta[name] !== undefined) { out += meta[name]; i = j; continue; }
        // Anonymous $$$ — no capture name; skip the token.
        i = j; continue;
      }
      if (tmpl[i + 1] === '_') { i += 2; continue; }
      if (tmpl[i + 1] && /[A-Za-z_]/.test(tmpl[i + 1])) {
        let j = i + 1, name = '';
        while (j < tmpl.length && /[A-Za-z0-9_]/.test(tmpl[j])) { name += tmpl[j]; j++; }
        if (meta[name] !== undefined) { out += meta[name]; i = j; continue; }
        // Unknown name — preserve literal.
      }
    }
    out += tmpl[i];
    i++;
  }
  return out;
}

/**
 * Myers-style line diff approximation. For v1 we use a simple LCS-based diff
 * (good enough for previews of modest-sized hunks).
 */
function makeDiffHunks(prev, next) {
  const a = prev.split('\n');
  const b = next.split('\n');
  // LCS DP
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk forward to emit ops, grouping consecutive changes into hunks.
  const hunks = [];
  let cur = null;
  let i = 0, j = 0;
  const flush = () => { if (cur && cur.lines.length > 0) { hunks.push(cur); } cur = null; };
  const newHunk = (startLine) => { flush(); cur = { startLine, lines: [] }; };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flush();
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (!cur) newHunk(i + 1);
      cur.lines.push({ kind: 'del', line: i + 1, text: a[i] });
      i++;
    } else {
      if (!cur) newHunk(i + 1);
      cur.lines.push({ kind: 'add', line: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    if (!cur) newHunk(i + 1);
    cur.lines.push({ kind: 'del', line: i + 1, text: a[i] });
    i++;
  }
  while (j < b.length) {
    if (!cur) newHunk(i + 1);
    cur.lines.push({ kind: 'add', line: j + 1, text: b[j] });
    j++;
  }
  flush();
  return hunks;
}

async function toolBash({ command, timeout }, guard) {
  if (!command) return { error: 'command required' };

  // KB-first guardrail: if the command looks like a code-discovery search
  // (grep/find/rg/cat on source files) AND the agent hasn't used any KB
  // tool this turn, prepend a one-time hint to stderr nudging toward
  // kb_search / kb_symbol. We still execute the command — the hint just
  // teaches the agent to prefer KB next time.
  const hint = guard?.shouldHintBash(command) ? guard.bashHint(command) : null;

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = hint ? hint + '\n' : '';
    let truncated = false;
    const onChunk = (buf, isErr) => {
      const remaining = MAX_BASH_OUTPUT - (isErr ? errOut.length : out.length);
      if (remaining <= 0) { truncated = true; return; }
      const slice = buf.subarray(0, remaining);
      const more = buf.subarray(remaining);
      const text = slice.toString('utf8');
      if (isErr) errOut += text; else out += text;
      if (more.length > 0) truncated = true;
    };
    child.stdout.on('data', (b) => onChunk(b, false));
    child.stderr.on('data', (b) => onChunk(b, true));
    const to = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ timedOut: true, stdout: out, stderr: errOut, truncated, kbHint: hint || undefined });
    }, Math.min(BASH_TIMEOUT_MS, (timeout || 60) * 1000));
    child.on('error', (err) => { clearTimeout(to); resolve({ error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(to);
      resolve({ exitCode: code, stdout: out, stderr: errOut, truncated, kbHint: hint || undefined });
    });
  });
}

/* ------------------------------------------------------------------ */
/* KB tools                                                            */
/* ------------------------------------------------------------------ */

function toolKbSearch(rt, llm) {
  return async ({ query, top_k, skip_rewrite }, guard) => {
    if (!query) return { error: 'query required' };
    // Note: we mark KB-used BEFORE running the search. An empty result still
    // counts — the agent did query the KB, so a later bash fallback is an
    // intentional "KB doesn't have this" rather than a missed opportunity.
    // The end-of-turn KB-update offer (interactive.js) is what catches the
    // "KB is stale" case, not the per-call hint.
    guard?.noteKbUsage?.();

    // Optional LLM rewrite: convert natural-language query to English
    // function names + keywords for sharper BM25 results. Default on
    // when an LLM is wired in; pass skip_rewrite=true if you already
    // have identifier-style keywords.
    let rewriteInfo = null;
    let retrievalQuery = query;
    if (!skip_rewrite && llm) {
      try {
        const { rewriteQuery } = await import('../retrieval/rewrite_query.js');
        const r = await rewriteQuery(llm, query, { timeoutMs: 15000 });
        if (!r.fallback && r.rewrittenQuery?.trim()) {
          retrievalQuery = r.rewrittenQuery;
          rewriteInfo = {
            intent: r.intent,
            functionNames: r.functionNames,
            keywords: r.keywords,
            rewrittenQuery: r.rewrittenQuery,
          };
        }
      } catch (err) {
        rewriteInfo = { error: err.message };
      }
    }

    const results = codeSearch(rt, retrievalQuery, { topK: Math.max(5, Math.min(50, top_k || 20)) });
    return {
      query,
      retrievalQuery,
      rewrite: rewriteInfo,
      count: results.length,
      results: results.map(r => ({
        id: r.id, name: r.name, kind: r.kind,
        filePath: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
        signature: r.signature, score: r.score, snippet: r.snippet,
      })),
    };
  };
}

function toolKbSymbol(rt) {
  return async ({ name }, guard) => {
    if (!name) return { error: 'name required' };
    guard?.noteKbUsage?.();
    const syms = rt.getSymbolsByName(name) || [];
    return {
      count: syms.length,
      symbols: syms.map(s => ({
        id: s.id, name: s.name, kind: s.kind,
        filePath: rt.getFilePath(s.fileId),
        lineStart: s.lineStart, lineEnd: s.lineEnd,
        signature: s.signature,
      })),
    };
  };
}

/**
 * File outline from the KB index — no FS read. Returns the symbol list for a
 * file with line ranges + signatures so the agent can navigate without paying
 * for the full file content. Kb-first alternative to `read` for "what's in
 * this file?" questions.
 */
function toolKbOutline(rt) {
  return async ({ path: p }, guard) => {
    if (!p) return { error: 'path required' };
    const fileId = rt.getFileId(p);
    if (fileId === null || fileId === undefined) {
      return {
        error: `file not in KB: ${p}`,
        hint: 'Run /kb update to index new files, or use read() to fetch content directly.',
      };
    }
    guard?.noteKbUsage?.();
    const allSyms = rt.getSymbolsInFile(fileId) || [];
    // Build a parentId → child lookup so we can show container info.
    const childCountByParent = new Map();
    for (const s of allSyms) {
      if (s.parentSymbolId) {
        childCountByParent.set(s.parentSymbolId, (childCountByParent.get(s.parentSymbolId) || 0) + 1);
      }
    }
    const sorted = allSyms.slice().sort((a, b) => (a.lineStart || 0) - (b.lineStart || 0));
    const MAX = 200;
    const visible = sorted.slice(0, MAX);
    const outline = visible.map(s => {
      const parent = s.parentSymbolId ? allSyms.find(x => x.id === s.parentSymbolId) : null;
      return {
        name: s.name,
        qualName: s.qualName || s.name,
        kind: s.kind,
        lineStart: s.lineStart,
        lineEnd: s.lineEnd,
        signature: s.signature || '',
        docString: (s.docString || '').slice(0, 200),
        parentName: parent ? parent.name : null,
        childCount: childCountByParent.get(s.id) || 0,
      };
    });
    return {
      path: p,
      fileId,
      totalSymbols: allSyms.length,
      shown: outline.length,
      truncated: sorted.length > MAX ? sorted.length - MAX : 0,
      tag: (rt.files?.byId?.[fileId]?.hash || '').slice(0, 8),
      outline,
    };
  };
}

function toolKbNeighbors(rt) {
  return async ({ symbol_id }, guard) => {
    if (!symbol_id) return { error: 'symbol_id required' };
    guard?.noteKbUsage?.();
    const cg = rt.callgraph?.byId || {};
    const edges = cg[symbol_id] || [];
    const out = [];
    for (const id of edges) {
      const s = rt.getSymbolById(id);
      if (!s) continue;
      out.push({
        id: s.id, name: s.name, kind: s.kind,
        filePath: rt.getFilePath(s.fileId), lineStart: s.lineStart,
      });
    }
    return { count: out.length, neighbors: out };
  };
}

/**
 * Bounded call-chain traversal over the knowledge graph.
 */
function toolKbCallChain(rt) {
  return async ({ symbol_id, direction = 'both', max_depth = 2, max_nodes = 20 }, guard) => {
    if (!symbol_id) return { error: 'symbol_id required' };
    if (!rt.graph) return { error: 'knowledge graph not built for this KB' };
    guard?.noteKbUsage?.();
    const chain = rt.getCallChain(symbol_id, direction, max_depth, max_nodes);
    const fmt = arr => arr.map(n => ({
      id: rt.toSymbolId(n.id),
      name: n.name,
      qualName: n.qualName,
      kind: n.kind,
      filePath: n.filePath,
      lineStart: n.lineStart,
      lineEnd: n.lineEnd,
      signature: (n.signature || '').slice(0, 160),
    }));
    return {
      start: rt.toSymbolId(symbol_id),
      forward: fmt(chain.forward),
      backward: fmt(chain.backward),
      forwardCount: chain.forward.length,
      backwardCount: chain.backward.length,
    };
  };
}

/**
 * Look up a class / interface / struct by name. Returns members, super-classes,
 * and implementations.
 */
function toolKbClass(rt) {
  return async ({ name, qual_name }, guard) => {
    if (!name && !qual_name) return { error: 'name or qual_name required' };
    if (!rt.graph) return { error: 'knowledge graph not built for this KB' };
    guard?.noteKbUsage?.();

    let node = null;
    if (qual_name) node = rt.resolveByQualName(qual_name);
    if (!node && name) {
      const matches = rt.searchNodes(name, 10)
        .filter(n => ['class', 'struct', 'interface', 'enum'].includes(n.kind));
      node = matches[0] || null;
    }
    if (!node) return { error: `class not found: ${name || qual_name}` };

    const members = rt.getClassMembers(node.id).map(m => ({
      id: rt.toSymbolId(m.id),
      name: m.name,
      kind: m.kind,
      signature: (m.signature || '').slice(0, 160),
      lineStart: m.lineStart,
    }));
    const impls = rt.getImplementations(node.id).map(i => ({
      id: rt.toSymbolId(i.id),
      name: i.name,
      kind: i.kind,
      filePath: i.filePath,
    }));

    return {
      id: rt.toSymbolId(node.id),
      name: node.name,
      qualName: node.qualName,
      kind: node.kind,
      filePath: node.filePath,
      lineStart: node.lineStart,
      lineEnd: node.lineEnd,
      superClassNames: node.superClassNames || [],
      implementsNames: node.implementsNames || [],
      docString: (node.docString || '').slice(0, 400),
      members,
      implementations: impls,
    };
  };
}

/**
 * List references to a symbol — who calls it, what imports it, what implements it.
 */
function toolKbRefs(rt) {
  return async ({ symbol_id, kind = 'any' }, guard) => {
    if (!symbol_id) return { error: 'symbol_id required' };
    if (!rt.graph) return { error: 'knowledge graph not built for this KB' };
    guard?.noteKbUsage?.();

    const out = { symbol_id };
    if (kind === 'any' || kind === 'call') {
      out.callers = rt.getCallers(symbol_id, 1, 30).map(n => ({
        id: rt.toSymbolId(n.id), name: n.name, kind: n.kind,
        filePath: n.filePath, lineStart: n.lineStart,
      }));
    }
    if (kind === 'any' || kind === 'import') {
      out.importers = rt.getImporters(symbol_id).map(n => ({
        id: rt.toSymbolId(n.id), name: n.name, filePath: n.filePath,
      }));
    }
    if (kind === 'any' || kind === 'inherit') {
      out.derived = rt.getImplementations(symbol_id).map(n => ({
        id: rt.toSymbolId(n.id), name: n.name, kind: n.kind, filePath: n.filePath,
      }));
    }
    return out;
  };
}

/**
 * Find classes / structs that implement a given interface or extend a base class.
 */
function toolKbImplements(rt) {
  return async ({ interface_id_or_name }, guard) => {
    if (!interface_id_or_name) return { error: 'interface_id_or_name required' };
    if (!rt.graph) return { error: 'knowledge graph not built for this KB' };
    guard?.noteKbUsage?.();

    let nodeId = rt.toNodeId(interface_id_or_name);
    if (!rt.graph.nodes.has(nodeId)) {
      // Look up by name
      const matches = rt.searchNodes(interface_id_or_name, 5)
        .filter(n => ['interface', 'class', 'struct'].includes(n.kind));
      if (matches.length === 0) return { error: `not found: ${interface_id_or_name}` };
      nodeId = matches[0].id;
    }
    const impls = rt.getImplementations(nodeId).map(n => ({
      id: rt.toSymbolId(n.id),
      name: n.name,
      qualName: n.qualName,
      kind: n.kind,
      filePath: n.filePath,
      lineStart: n.lineStart,
    }));
    return {
      interface_id: rt.toSymbolId(nodeId),
      implementations: impls,
      count: impls.length,
    };
  };
}

/**
 * Look up a knowledge entry by id, searching both Holy and Eden spaces.
 * Replaces the old kb_principle tool.
 */
function toolKbKnowledge(rt) {
  return async ({ id, space }, guard) => {
    if (!id) return { error: 'id required' };
    guard?.noteKbUsage?.();
    if (space) {
      // Caller specified a space
      const { readKnowledge } = await import('../store/kb_store.js');
      const entry = await readKnowledge(rt.name, space, id);
      if (!entry) return { error: `not found: ${id} in ${space}` };
      return entry;
    }
    // Search both spaces via runtime cache first, then disk (cache may be
    // ahead of disk for in-flight edits within a turn)
    const cached = rt.findKnowledge?.(id);
    if (cached) return cached.entry;
    const { findKnowledge } = await import('../store/kb_store.js');
    const found = await findKnowledge(rt.name, id);
    if (!found) return { error: `knowledge entry not found: ${id}` };
    return found.entry;
  };
}

/**
 * Search across both Holy and Eden spaces by natural-language query.
 * Simple substring + keyword match (good enough for typical small knowledge
 * bases; the heavy BM25 path stays over the code symbols).
 */
function toolKbSearchKnowledge(rt) {
  return async ({ query, top_k }, guard) => {
    if (!query) return { error: 'query required' };
    guard?.noteKbUsage?.();
    const k = Math.max(1, Math.min(20, top_k || 5));
    const all = rt.allKnowledge?.() || [];
    if (all.length === 0) return { count: 0, results: [] };
    const q = query.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const entry of all) {
      const hay = [
        entry.id || '',
        entry.title || '',
        entry.intro || '',
        ...(entry.keywords || []),
      ].join(' ').toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      count: scored.length,
      results: scored.slice(0, k).map(({ entry, score }) => ({
        id: entry.id,
        space: entry.space,
        title: entry.title,
        score,
        introPreview: (entry.intro || '').slice(0, 200),
      })),
    };
  };
}

/**
 * Save a knowledge entry to Holy or Eden space. Replaces kb_save_principle.
 *
 * Space policy (enforced by interactive.js's user-approval flow, NOT here —
 * this tool just persists whatever the agent sends):
 *   - Holy: stable knowledge (design principles, key algorithms). The agent
 *     should pick this for things that rarely change. Interactive mode will
 *     ALWAYS prompt the user y/N before committing, regardless of env vars.
 *   - Eden: frequently-updated knowledge (function lists, SQL command
 *     catalogs, observed patterns). The agent should pick this for things
 *     that may evolve. Auto-commits when HK2_ENABLE_AUTO_LEARN=1.
 */
function toolKbSaveKnowledge(rt, projectId) {
  return async ({ space, id, title, intro, key_files, key_symbols, keywords }, guard) => {
    if (!id) return { error: 'id required' };
    if (!title) return { error: 'title required' };
    if (!intro || typeof intro !== 'string') return { error: 'intro required' };
    const targetSpace = space === 'eden' ? 'eden' : 'holy';  // default holy (safer)

    const { writeKnowledge } = await import('../store/kb_store.js');
    const entry = {
      id,
      title,
      intro,
      keyFiles: Array.isArray(key_files) ? key_files : [],
      keySymbols: Array.isArray(key_symbols) ? key_symbols : [],
      keywords: Array.isArray(keywords) ? keywords : [],
    };
    const p = await writeKnowledge(rt.name, targetSpace, entry);

    // Hot-reload into runtime so subsequent kb_knowledge / kb_search_knowledge sees it
    const record = await (await import('../store/kb_store.js')).readKnowledge(rt.name, targetSpace, id);
    if (record) rt.reloadKnowledge?.(record, targetSpace);

    // Only mark KB-used once the write + reload succeeded; a failed save
    // shouldn't suppress the bash/read hint for the rest of this LLM call.
    guard?.noteKbUsage?.();

    return { saved: true, id, space: targetSpace, path: p };
  };
}

/* ------------------------------------------------------------------ */
/* Workspace safety                                                    */
/* ------------------------------------------------------------------ */

function getWorkspaceRoots() {
  const roots = [process.cwd()];
  if (process.env.HK2_PROJECT_SOURCE) roots.push(process.env.HK2_PROJECT_SOURCE);
  return roots.map(r => path.resolve(r));
}

function resolveSafe(p) {
  if (!p || typeof p !== 'string') return null;
  const abs = path.resolve(p);
  const roots = getWorkspaceRoots();
  for (const r of roots) {
    if (abs === r || abs.startsWith(r + path.sep)) return abs;
  }
  return null;
}

async function globWalk(root, pattern, limit) {
  const out = [];
  const segments = pattern.split('/').filter(Boolean);
  await walk(root, root, segments, 0, out, limit);
  return out;
}

async function walk(root, dir, segments, idx, out, limit) {
  if (out.length >= limit) return;
  if (idx >= segments.length) {
    try {
      const st = await fs.stat(dir);
      if (st.isFile()) out.push(dir);
    } catch {}
    return;
  }
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  const seg = segments[idx];
  for (const ent of entries) {
    if (out.length >= limit) return;
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    if (ent.isDirectory()) {
      if (seg === '**') {
        await walk(root, path.join(dir, ent.name), segments, idx, out, limit);
        await walk(root, path.join(dir, ent.name), segments, idx + 1, out, limit);
      } else if (matchSeg(seg, ent.name)) {
        await walk(root, path.join(dir, ent.name), segments, idx + 1, out, limit);
      }
    } else if (idx === segments.length - 1 && matchSeg(seg, ent.name)) {
      out.push(path.join(dir, ent.name));
    }
  }
  if (seg === '**') {
    await walk(root, dir, segments, idx + 1, out, limit);
  }
}

function matchSeg(pattern, name) {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

/* ------------------------------------------------------------------ */
/* Plan tool: the interface that receives the LLM plan decision        */
/* ------------------------------------------------------------------ */

/**
 * Coerce a raw strategies array (from the LLM tool call args) into a clean
 * list of { name, description, recommended }. Drops anything without a name.
 */
function coercePlanStrategies(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name) continue;
    const description = typeof s.description === 'string' ? s.description.trim() : '';
    out.push({ name, description, recommended: !!s.recommended });
  }
  return out;
}

/**
 * Normalize a raw plan (from the LLM tool call args) into a clean shape:
 *   { summary, steps: [{ goal, strategies: [{ name, description, recommended }] }] }
 * Ensures exactly one strategy per step is recommended (forces the first if
 * zero or many). Returns null if the plan does not have at least 2 steps with
 * at least 2 strategies each - i.e. not a real plan worth confirming.
 */
function normalizePlanInput(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = [];
  for (const st of stepsRaw) {
    if (!st || typeof st !== 'object') continue;
    const goal = typeof st.goal === 'string' ? st.goal.trim() : '';
    const strategies = coercePlanStrategies(st.strategies);
    if (!goal || strategies.length < 2) continue;
    const recs = strategies.filter(s => s.recommended);
    if (recs.length !== 1) {
      for (const s of strategies) s.recommended = false;
      strategies[0].recommended = true;
    }
    steps.push({ goal, strategies });
  }
  if (steps.length < 2) return null;
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  return { summary, steps };
}

/**
 * Plan tool factory.
 *
 * The `plan` tool is the interface by which the agent's LLM communicates a
 * planning decision: it calls `plan` with a decomposed plan (summary + steps,
 * each step with 2-4 candidate strategies, one marked recommended) when it
 * decides a task is complex enough to warrant user confirmation.
 *
 *   confirmFn(plan) -> Promise<planText | null>
 *     When supplied (interactive mode), the tool surfaces the plan to the user
 *     for per-step strategy selection and returns the user's finalized plan as
 *     the tool result so the agent can follow it. A null return means the user
 *     cancelled; the tool result tells the agent to stop.
 *     When NOT supplied (non-interactive / one-shot), the tool just echoes the
 *     plan back with each step's recommended strategy selected, so the agent
 *     can proceed with its own recommendation.
 */
function toolPlan(confirmFn) {
  return async ({ summary, steps }, _guard) => {
    const plan = normalizePlanInput({ summary, steps });
    if (!plan) {
      return {
        error: 'Invalid plan. Provide a "summary" string and a "steps" array of at least 2 steps, each with a "goal" and 2-4 "strategies" (name, description, recommended on exactly one).',
      };
    }
    if (typeof confirmFn === 'function') {
      let confirmed;
      try {
        confirmed = await confirmFn(plan);
      } catch {
        confirmed = null;
      }
      if (!confirmed) {
        return { cancelled: true, message: 'The user cancelled the plan. Stop and ask the user how they would like to proceed; do not continue executing the cancelled plan.' };
      }
      return { confirmed: true, plan: confirmed };
    }
    // No confirmation interface available: auto-accept the recommended strategy
    // for each step and echo a finalized plan text back to the agent.
    const parts = [];
    if (plan.summary) parts.push(`Summary: ${plan.summary}`);
    plan.steps.forEach((s, i) => {
      const rec = s.strategies.find(x => x.recommended) || s.strategies[0];
      parts.push(`Step ${i + 1}: ${s.goal} -> ${rec.name}${rec.description ? ' - ' + rec.description : ''}`);
    });
    return { confirmed: true, plan: parts.join('\n'), autoAccepted: true };
  };
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the tool list. KB tools require a loaded KBRuntime.
 * @param {object} rt  KBRuntime (may be null if no KB)
 * @param {{allowWrite?: boolean, llm?: object}} opts
 *   - llm: optional LLMClient; when provided, kb_search runs LLM query rewrite
 *          per call (controlled by the skip_rewrite tool arg, default false).
 */
export function buildTools(rt, opts = {}) {
  const llm = opts.llm;
  const allowWrite = opts.allowWrite !== false;
  // Optional plan-confirmation callback. When supplied (interactive mode),
  // the `plan` tool surfaces the agent-proposed plan to the user for
  // per-step strategy selection. When absent (one-shot / non-interactive),
  // the `plan` tool auto-accepts the recommended strategy per step.
  const planConfirm = opts.planConfirm;
  // Per-turn KB-first guardrail. Caller can pass an existing one (so it
  // survives across buildTools calls within the same session) — otherwise
  // we create a fresh one.
  const guard = opts.guard || new KbFirstGuard();

  const tools = [
    {
      name: 'read',
      snippet: 'Read file contents (KB outline prepended for indexed code files)',
      guidelines: [
        'Use read to examine files instead of cat or sed.',
        'For code files known to the KB, read prepends a structural Outline (from KB) section. Use kb_outline first when you only need the structure — it is cheaper.',
        'The result includes a `tag` (content hash) for indexed files. Echo it back as the `tag` argument to edit for stale-anchor protection.',
      ],
      description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${MAX_READ_LINES} lines or ${Math.floor(MAX_READ_BYTES / 1024)}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. For code files in the KB, a structural Outline section (sourced from the pre-built index) is prepended; pass outline=false to disable.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read (relative or absolute)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
          outline: { type: 'boolean', description: 'Prepend KB outline for indexed code files (default true)' },
        },
        required: ['path'],
      },
      execute: (args, guard) => toolRead(args, guard, rt),
    },
    {
      name: 'bash',
      snippet: 'Execute bash commands (ls, grep, find, etc.)',
      guidelines: ['Inspect HK2_* / PI_* environment variables for current model and session details.'],
      description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to ${MAX_READ_LINES} lines or ${Math.floor(MAX_BASH_OUTPUT / 1024)}KB (whichever is hit first). Optionally provide a timeout in seconds.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (optional, default 60)' },
        },
        required: ['command'],
      },
      execute: toolBash,
    },
    {
      name: 'find',
      snippet: 'Find files by glob pattern (respects .gitignore)',
      guidelines: [],
      description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to 1000 results.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
          path: { type: 'string', description: 'Directory to search in (default: current directory)' },
          limit: { type: 'number', description: 'Maximum number of results (default: 1000)' },
        },
        required: ['pattern'],
      },
      execute: toolGlob,
    },
    {
      name: 'grep',
      snippet: 'Search file contents for patterns (respects .gitignore)',
      guidelines: [],
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to 100 matches. Long lines are truncated to 240 chars.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
          path: { type: 'string', description: 'Directory or file to search (default: current directory)' },
          glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
          literal: { type: 'boolean', description: 'Treat pattern as literal string instead of regex (default: false)' },
          context: { type: 'number', description: 'Number of lines to show before and after each match (default: 0)' },
          limit: { type: 'number', description: 'Maximum number of matches to return (default: 100)' },
        },
        required: ['pattern'],
      },
      execute: toolGrep,
    },
    {
      name: 'ast_grep',
      snippet: 'Structural code search with $$$/$_ metavariables (ast-grep style)',
      guidelines: [
        'Pattern syntax: $$$IDENT (multi-wildcard capture), $IDENT (single identifier capture), $_ (anon wildcard), other text is literal.',
        'For exact-identifier lookups across the codebase, prefer kb_symbol; ast_grep is for structural / multi-token patterns.',
      ],
      description: `Structural code search (ast-grep style). The pattern is translated to a regex approximation: $$$IDENT matches any text (multi-line, non-greedy), $IDENT matches a single identifier, $_ matches one token, and other characters are literal. Returns up to 50 matches across up to 200 files. Examples: 'console.log($$$)' matches any console.log call; 'function $NAME($$$)' captures function names; 'class $NAME' captures class declarations.`,
      parameters: {
        type: 'object',
        properties: {
          pat: { type: 'string', description: 'ast-grep pattern, e.g. "console.log($$$)" or "function $NAME($$$)"' },
          path: { type: 'string', description: 'Directory to search in (default: current directory)' },
          glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts'" },
          limit: { type: 'number', description: 'Maximum matches to return (default: 30, max: 50)' },
        },
        required: ['pat'],
      },
      execute: (args, guard) => toolAstGrep(args, guard, rt),
    },
    {
      name: 'ast_edit',
      snippet: 'Structural rewrite with preview/accept (queue writes, return diff + proposalId)',
      guidelines: [
        'Always call ast_edit first to preview; then call resolve with the returned proposalId to apply or discard.',
        'Template syntax in `out`: $IDENT / $$$IDENT / $_ substitute the captures matched by `pat`.',
        'Optional `tag` (shortHash of file content from a prior read/kb_outline) rejects the proposal if any target file changed since the tag was minted.',
      ],
      description: `Structural rewrite across one or more files. Computes proposed writes (never writes to disk itself), returns a unified-diff preview plus a proposalId, then stashes the writes for resolve. Each op is {pat, out}: pat uses ast-grep metavariables ($$$IDENT, $IDENT, $_), out uses the same syntax to substitute captures. Returns { proposed, proposalId, diffs[], summary }. If no matches, returns proposed:false with summary zeroed.`,
      parameters: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pat: { type: 'string', description: 'ast-grep pattern (e.g. "console.log($$$)")' },
                out: { type: 'string', description: 'replacement template (e.g. "logger.info($$$)")' },
              },
              required: ['pat', 'out'],
            },
            minItems: 1,
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files or directories to rewrite (directories walk recursively)',
            minItems: 1,
          },
          tag: { type: 'string', description: 'Optional shortHash tag from prior read/kb_outline; rejects if any target file changed' },
        },
        required: ['ops', 'paths'],
      },
      execute: toolAstEdit,
    },
    {
      name: 'resolve',
      snippet: 'Apply or discard a previously-previewed ast_edit proposal',
      guidelines: [
        'Call resolve after ast_edit returns proposalId: "apply" writes the files, "discard" drops them.',
        'Re-validates each file\'s tag at apply time and rolls back if any file changed since the preview.',
      ],
      description: `Two-phase commit for ast_edit. action:"apply" writes every staged file (re-validating the content tag first; rolls back on any failure). action:"discard" drops the stash without writing. Returns { applied, discarded, proposalId } on success or { error, rolledBack } on failure.`,
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: 'proposalId returned by ast_edit' },
          action: { type: 'string', enum: ['apply', 'discard'], description: 'apply = write files, discard = drop the stash' },
        },
        required: ['proposal_id', 'action'],
      },
      execute: toolResolve,
    },
    {
      name: 'plan',
      snippet: 'Propose an execution plan for user confirmation (call when a task is complex enough to need a strategy decision)',
      guidelines: [
        'Call `plan` ONLY when you decide the task is complex enough to need an interactive plan + per-step confirmation BEFORE execution begins (multiple distinct phases, a design decision the user should confirm, several files / subsystems, or materially different approaches).',
        'For simple / routine tasks (single action, quick read / question, one-line edit, standard chained workflow like git add + commit + push), skip `plan` and proceed directly to execution.',
        'Provide a one-line `summary` plus 2-5 ordered `steps`, each with a short `goal` and 2-4 `strategies` (name + one-line description), marking exactly one strategy per step as `recommended: true`.',
        'The tool returns the user-confirmed plan (chosen strategy per step) which you must follow. If the user cancels, the result says so — stop and ask how to proceed instead of executing the cancelled plan.',
        'Do NOT start editing files before the `plan` tool returns; do not ask the user to confirm a plan in prose — `plan` is the only confirmation interface.',
      ],
      description: 'Propose an execution plan for the user to confirm. Use this when you, as the triage assistant, decide the task is complex enough to warrant a strategy decision the user should confirm before execution. Provide a `summary` string and a `steps` array (2-5 ordered steps), each step having a `goal` string and a `strategies` array of 2-4 objects ({ name, description, recommended }) with exactly one recommended. The tool surfaces the plan to the user for per-step strategy selection (or auto-accepts the recommended strategy in non-interactive mode) and returns the finalized plan text for you to follow. Returns { confirmed, plan } on acceptance, { cancelled } if the user cancels, or { error } if the plan shape is invalid.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-line summary of the whole plan' },
          steps: {
            type: 'array',
            description: 'Ordered execution steps (2-5).',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string', description: 'Short imperative describing what the step achieves' },
                strategies: {
                  type: 'array',
                  description: '2-4 candidate strategies for this step.',
                  minItems: 2,
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Short label (<= 6 words)' },
                      description: { type: 'string', description: 'One line of detail' },
                      recommended: { type: 'boolean', description: 'Mark exactly one strategy per step as recommended' },
                    },
                    required: ['name', 'description'],
                  },
                },
              },
              required: ['goal', 'strategies'],
            },
          },
        },
        required: ['summary', 'steps'],
      },
      execute: toolPlan(planConfirm),
    },
  ];

  if (allowWrite) {
    tools.push({
      name: 'edit',
      snippet: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      guidelines: [
        'Use edit for precise changes (edits[].oldText must match exactly)',
        'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
        'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
        'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
        'Pass the `tag` from a prior read/kb_outline result to opt in to stale-anchor protection: the edit is rejected if the file changed since the tag was minted.',
      ],
      description: `Edit a single file using exact text replacement. Every edit's oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. Accepts either {edits:[{oldText,newText}]} (preferred, multiple disjoint edits in one call) or {old_string, new_string} (single edit). Optional \`tag\` (shortHash from a prior read/kb_outline) rejects the edit if the file's current content hash differs — protects against silent overwrites when the file changed since the read.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit (relative or absolute)' },
          edits: {
            type: 'array',
            description: 'One or more targeted replacements.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text to find. Must be unique in the file.' },
                newText: { type: 'string', description: 'Replacement text.' },
              },
              required: ['oldText', 'newText'],
            },
          },
          old_string: { type: 'string', description: 'Single-edit shorthand for edits[0].oldText' },
          new_string: { type: 'string', description: 'Single-edit shorthand for edits[0].newText' },
          tag: { type: 'string', description: 'Optional shortHash tag from a prior read/kb_outline. Rejects the edit if the file changed since.' },
        },
        required: ['path'],
      },
      execute: toolEdit,
    });
    tools.push({
      name: 'write',
      snippet: 'Create or overwrite files',
      guidelines: ['Use write only for new files or complete rewrites.'],
      description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write (relative or absolute)' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
      execute: toolWrite,
    });
  }

  // KB tools (hk2 additions)
  if (rt) {
    tools.push(
      {
        name: 'kb_search',
        snippet: 'Search the project KB for symbols by natural-language query',
        guidelines: ['Use kb_search instead of grep when looking for semantic concepts; grep is for literal text. Each kb_search call rewrites your query through an LLM by default for sharper results; pass skip_rewrite=true only if you are already passing identifier-style keywords.'],
        description: 'Search the project knowledge base by natural-language / keyword query. Returns symbols ranked by BM25 + name-match reranking, with file paths, line ranges, and snippets. By default the query is rewritten through the LLM into English function names + keywords before retrieval; pass skip_rewrite=true to skip that step (useful when you already have identifiers).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language or keyword query' },
            top_k: { type: 'number', description: 'Max results (default 20, max 50)' },
            skip_rewrite: { type: 'boolean', description: 'Skip the LLM query-rewrite step (default false)' },
          },
          required: ['query'],
        },
        execute: toolKbSearch(rt, llm),
      },
      {
        name: 'kb_symbol',
        snippet: 'Look up a symbol by exact name across the KB',
        guidelines: [],
        description: 'Look up a symbol by its exact identifier name. Returns all matching candidates across the codebase.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Exact symbol name (e.g. function, class, type name)' } },
          required: ['name'],
        },
        execute: toolKbSymbol(rt),
      },
      {
        name: 'kb_outline',
        snippet: 'File outline from the KB (no FS read) — name/kind/lines/signature per symbol',
        guidelines: [
          'Use kb_outline BEFORE read when you only need to navigate a file (what symbols exist, where they live).',
          'For exact-name lookups across the whole codebase, use kb_symbol; kb_outline is for one specific file.',
        ],
        description: `Get the symbol outline of a file FROM THE KB INDEX (no filesystem read). Returns each symbol's name, qualified name, kind, line range, signature, parent class, and child count. Use this when you need to know "what's in this file?" or "where is X defined in this file?" — much cheaper than read and stays in sync with the indexed codebase. If the file isn't in the KB, the call returns an explicit error pointing at /kb update.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Project-relative path (e.g. "src/agent/tools.js")' } },
          required: ['path'],
        },
        execute: toolKbOutline(rt),
      },
      {
        name: 'kb_neighbors',
        snippet: 'Get call-graph neighbors of a symbol',
        guidelines: [],
        description: 'Get call-graph neighbors (1-hop) of a symbol — functions this symbol calls, or callers, depending on graph direction.',
        parameters: {
          type: 'object',
          properties: { symbol_id: { type: 'string', description: 'Symbol id of the form "<fileId>:<line>"' } },
          required: ['symbol_id'],
        },
        execute: toolKbNeighbors(rt),
      },
      {
        name: 'kb_callchain',
        snippet: 'Traverse the call chain (forward / backward / both) over the knowledge graph',
        guidelines: [
          'For relationship questions (who calls X, what calls Y calls Z), prefer kb_callchain over reading files — it walks the prebuilt call graph directly.',
        ],
        description: 'Bounded DFS over the call graph. Returns callers and/or callees up to max_depth hops, capped at max_nodes total.',
        parameters: {
          type: 'object',
          properties: {
            symbol_id: { type: 'string', description: 'Starting symbol id ("<fileId>:<line>")' },
            direction: { type: 'string', enum: ['forward', 'backward', 'both'], description: 'forward = callees, backward = callers, both = bidirectional (default both)' },
            max_depth: { type: 'number', description: 'Max hop depth (default 2)' },
            max_nodes: { type: 'number', description: 'Max nodes returned per direction (default 20)' },
          },
          required: ['symbol_id'],
        },
        execute: toolKbCallChain(rt),
      },
      {
        name: 'kb_class',
        snippet: 'Look up a class / interface / struct by name with members + implementations',
        guidelines: [
          'When the user asks "what is in class X" or "show the members of Y", use kb_class instead of reading the file directly.',
        ],
        description: 'Look up a class, interface, or struct by name (or qualified name). Returns: signature, doc string, members (methods + fields), super-classes, and direct implementations.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Class / interface name (substring match)' },
            qual_name: { type: 'string', description: 'Optional fully-qualified name (Namespace.Class) for exact match' },
          },
        },
        execute: toolKbClass(rt),
      },
      {
        name: 'kb_refs',
        snippet: 'Find references to a symbol (callers, importers, derived classes)',
        guidelines: [],
        description: 'Reverse lookup: who calls this symbol, who imports the file containing it, what classes derive from it. Pass kind=call|import|inherit|any.',
        parameters: {
          type: 'object',
          properties: {
            symbol_id: { type: 'string', description: 'Symbol id ("<fileId>:<line>")' },
            kind: { type: 'string', enum: ['call', 'import', 'inherit', 'any'], description: 'Reference kind to query (default any)' },
          },
          required: ['symbol_id'],
        },
        execute: toolKbRefs(rt),
      },
      {
        name: 'kb_implements',
        snippet: 'Find classes that implement an interface or extend a base class',
        guidelines: [],
        description: 'Given an interface or base class, list all classes / structs that derive from it (via the inheritance edges in the knowledge graph).',
        parameters: {
          type: 'object',
          properties: {
            interface_id_or_name: { type: 'string', description: 'Symbol id OR name (substring match) of the interface / base class' },
          },
          required: ['interface_id_or_name'],
        },
        execute: toolKbImplements(rt),
      },
      {
        name: 'kb_knowledge',
        snippet: 'Look up a knowledge entry (Holy or Eden space) by id',
        guidelines: [
          'Always check kb_knowledge / kb_search_knowledge BEFORE exploring code — Holy space often holds the design-level answer (e.g. "how to write a PG extension").',
        ],
        description: 'Look up a knowledge entry by id, searching both Holy Space (stable design knowledge) and Eden Space (frequently-updated knowledge). Returns the full entry: title, intro, keyFiles, keySymbols, keywords, space.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Entry id (kebab-case, e.g. "spi-extension-pattern")' },
            space: { type: 'string', enum: ['holy', 'eden'], description: 'Optional: restrict to a specific space' },
          },
          required: ['id'],
        },
        execute: toolKbKnowledge(rt),
      },
      {
        name: 'kb_search_knowledge',
        snippet: 'Search Holy + Eden knowledge entries by natural-language query',
        guidelines: [],
        description: 'Search across both Holy and Eden knowledge spaces by natural-language query. Returns matching entries ranked by simple keyword overlap. Use this to discover if the project KB already documents a concept before exploring code.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language query' },
            top_k: { type: 'number', description: 'Max results (default 5, max 20)' },
          },
          required: ['query'],
        },
        execute: toolKbSearchKnowledge(rt),
      },
    );

    // Knowledge capture tool — let the agent persist what it learned into
    // Holy or Eden space. Only added when projectId is supplied.
    if (opts.projectId) {
      tools.push({
        name: 'kb_save_knowledge',
        snippet: 'Save a knowledge entry to Holy (stable) or Eden (frequently-updated) space',
        guidelines: [
          'Pick the space based on stability: Holy for design principles / key algorithms that rarely change (e.g. "how the WAL replay loop works"); Eden for things that may evolve (e.g. "list of SQL commands", "common function patterns").',
          'Saving to Holy ALWAYS prompts the user y/N before commit, even with HK2_ENABLE_AUTO_LEARN=1 — Holy space is the source of truth and updates require explicit approval.',
          'Saving to Eden auto-commits when HK2_ENABLE_AUTO_LEARN=1; otherwise also prompts.',
          'The entry should be self-contained: intro is the concept in prose; keyFiles / keySymbols anchor it to the codebase; keywords help future kb_search_knowledge hit it.',
        ],
        description: 'Persist a knowledge entry into Holy Space (stable, requires user approval) or Eden Space (frequently-updated, auto-learn eligible). Reloads into the in-memory KB immediately so subsequent kb_knowledge / kb_search_knowledge calls see it.',
        parameters: {
          type: 'object',
          properties: {
            space: { type: 'string', enum: ['holy', 'eden'], description: "Target space. Holy = stable design knowledge (user-approval required). Eden = frequently-updated (auto-learn eligible). Defaults to 'holy' if omitted." },
            id: { type: 'string', description: 'Kebab-case identifier, e.g. "spi-extension-pattern"' },
            title: { type: 'string', description: 'Human-readable title' },
            intro: { type: 'string', description: '2-5 paragraph prose explanation of the concept. Include key API names and call patterns.' },
            key_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Project-relative file paths for verification (e.g. ["src/backend/executor/spi.c"])',
            },
            key_symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol names that anchor the concept (e.g. ["SPI_connect", "SPI_execute"])',
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'English keywords for future kb_search_knowledge discovery',
            },
          },
          required: ['id', 'title', 'intro'],
        },
        execute: toolKbSaveKnowledge(rt, opts.projectId),
      });
    }
  }

  // Attach the per-turn guard so executeToolCall can pass it to tool.execute
  // as the 2nd argument. Tools that care (toolBash, toolRead) read it.
  for (const t of tools) t._guard = guard;

  return tools;
}

/** OpenAI-style tools array (without execute). */
export function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function findTool(tools, name) {
  return tools.find(t => t.name === name) || null;
}

export async function executeToolCall(tools, call) {
  const tool = findTool(tools, call.name);
  if (!tool) return { ok: false, error: `unknown tool: ${call.name}` };
  let args = call.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}'); }
    catch (err) { return { ok: false, error: `bad arguments JSON: ${err.message}` }; }
  }
  if (!args || typeof args !== 'object') args = {};
  try {
    // Tools whose execute() wants the per-turn guard take it as the 2nd arg.
    // We close over `guard` at buildTools() time so we can pass it here.
    const result = await tool.execute(args, tool._guard);
    return {
      ok: true,
      result,
      // Snapshot guard state AFTER execute ran, so the transcript shows
      // whether this call flipped kbUsedThisTurn or triggered a hint.
      guard: tool._guard?.snapshot?.(),
    };
  } catch (err) {
    return { ok: false, error: err.message, guard: tool._guard?.snapshot?.() };
  }
}
