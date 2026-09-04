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
import { getPermissionService, kbPathCandidates, resolveKbContentPath, resolveKbContentPaths, filterAllowedPaths } from '../config/setting.js';
import { codeSearch } from '../retrieval/code_search.js';
import { shortHash } from '../util/hash.js';
import { isSupremeCode, SUPREME_CODE_ID } from '../store/supreme_code.js';
import { compileGlob } from '../index/walker.js';
import * as proposals from './proposals.js';

const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LINES = 2000;
const MAX_BASH_OUTPUT = 8192;
const BASH_TIMEOUT_MS = 60_000;

// Tool-level heuristic whitelist (NOT the complete parser/indexer support
// list — e.g. no .cs/.kts/.sgml/.doc/.ppt/.pptx, and it also includes doc
// formats like .md/.json/.pdf). Used by:
//   - KbFirstGuard._isBashSearch / shouldHintRead — to decide when a bash or
//     read call should have used a KB tool instead.
//   - The read tool's auto outline/tag annotation eligibility.
//   - ast_grep / ast_edit file filtering (note: doc/binary extensions pass
//     this regex too — directory rewrites should be scoped to text sources).
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
    this.kbAssistedThisTurn = false;
    this.bashHinted = false;
    this.readHinted = false;
    this.searchToolHinted = false;
  }
  noteKbUsage() {
    this.kbUsedThisTurn = true;
  }
  /**
   * The KB contributed to a NON-kb_* tool call (e.g. read's outline prepend).
   * Unlike noteKbUsage this does NOT suppress the bash/read hints — the agent
   * still hasn't *chosen* a KB tool, so the nudge stays armed.
   */
  noteKbAssist() {
    this.kbAssistedThisTurn = true;
  }
  /**
   * Snapshot for transcript logging — lets us reconstruct later why a hint
   * did or didn't fire for a given tool call.
   */
  snapshot() {
    return {
      kbUsedThisTurn: this.kbUsedThisTurn,
      kbAssistedThisTurn: this.kbAssistedThisTurn,
      bashHinted: this.bashHinted,
      readHinted: this.readHinted,
      searchToolHinted: this.searchToolHinted,
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
  /**
   * Should the standalone grep / find tool result carry a kb-first nudge?
   * Once per LLM call, and only when the agent hasn't chosen a KB tool yet
   * (mirrors the bash-hint scoping rule).
   */
  shouldHintSearchTool() {
    return !this.kbUsedThisTurn && !this.searchToolHinted;
  }
  searchToolHint(toolName, detail = '') {
    this.searchToolHinted = true;
    return `[kb-first policy hint] ${toolName} walks the filesystem linearly. ${detail || 'The project KB has a prebuilt index'} — try kb_search("<natural-language query>") (BM25 + rerank) or kb_symbol("<exact name>") instead; they hit the index directly. (Hint shown once per LLM call.)`;
  }
}


/* ------------------------------------------------------------------ */
/* File tools                                                            */
/* ------------------------------------------------------------------ */

async function toolRead({ path: p, offset = 1, limit, outline = true }, guard, rt) {
  if (!p) return { error: 'path required' };
  const res = await resolvePermitted(p, 'r');
  if (res.error) return { error: res.error };
  const abs = res.abs;
  if (!await exists(abs)) return { error: `not found: ${p}` };
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) return { error: `stat failed: ${p}` };
  if (stat.isDirectory()) return { error: `is directory: ${p}` };
  if (stat.size > 5 * 1024 * 1024) return { error: `file too large: ${stat.size} bytes` };

  let text;
  try { text = await fs.readFile(abs, 'utf8'); }
  catch (err) { return { error: `read failed: ${err.message}` }; }

  // Binary guard: a NUL byte in the head of the file means this is not text
  // (UTF-16/exe/renamed binary). Returning mojibake wastes context and gives
  // the agent silently-garbage content — the same failure class as a silent
  // zero-match. Fail loudly instead.
  if (text.slice(0, 8192).includes('\u0000')) {
    return { error: `binary file (NUL byte detected): ${p} — read only supports text files` };
  }

  // Normalize line endings for DISPLAY: CRLF files would otherwise leave a
  // trailing CR glued to every line (invisible noise that still corrupts the
  // model's verbatim copies for edit oldText) and split('\n') on a file ending
  // in a newline yields a trailing PHANTOM empty element — surfacing as a
  // bogus empty last line and inflating totalLines by one (a 3-line file
  // reported 4; offset past the last real line returned a phantom row).
  // Semantics match toolGrep exactly: CRLF → LF, trailing-newline phantom
  // popped, empty file → zero lines, no-trailing-newline keeps its last line.
  // The `tag` stays a hash of the RAW file content, so edit's stale-anchor
  // check is unaffected; edit accepts both LF and CRLF oldText forms.
  const norm = text.replace(/\r\n/g, '\n');
  const lines = norm === '' ? [] : norm.split('\n');
  if (lines.length > 0 && norm.endsWith('\n')) lines.pop();

  // offset is 1-indexed
  const start = Math.max(0, (offset || 1) - 1);
  const lim = Math.max(1, Math.min(MAX_READ_LINES, limit || MAX_READ_LINES));
  // Line cap AND byte cap (the description always promised 256KB but the
  // byte half was never enforced — 2000 long lines could blow far past it
  // with no signal). Byte cap stops at LINE granularity (never mid-line) and
  // always yields at least the first requested line; a cap hit surfaces as
  // truncated + note instead of a silent partial read.
  const rows = [];
  let byteLen = 0;
  let byteTruncated = false;
  for (let i = start; i < lines.length && (i - start) < lim; i++) {
    const row = `${String(i + 1).padStart(6)}\t${lines[i]}`;
    const rowBytes = Buffer.byteLength(row) + 1;
    if (byteLen + rowBytes > MAX_READ_BYTES && rows.length > 0) {
      byteTruncated = true;
      break;
    }
    rows.push(row);
    byteLen += rowBytes;
  }
  const end = start + rows.length;
  const numbered = rows.join('\n');

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
        // Mark KB-ASSISTED (not KB-used): the index annotated this read, but the
        // agent still hasn't chosen a KB tool, so the bash/read hints stay
        // armed for the next call. The stats layer accounts for this read via
        // the kbOutline flag on the result, not by suppressing hints.
        guard?.noteKbAssist?.();
      }
      const hash = rt.files?.byId?.[fileId]?.hash;
      if (hash) tag = hash.slice(0, 8);
    }
  }

  return {
    path: path.relative(process.cwd(), abs) || abs,
    totalLines: lines.length,
    // True when the KB outline was prepended — lets the stats layer count
    // this read as KB-assisted instead of a no-KB fallback.
    kbOutline: outlineBlock ? true : undefined,
    shownLines: `${start + 1}-${end}`,
    ...(byteTruncated ? { truncated: true, note: `byte cap (${Math.floor(MAX_READ_BYTES / 1024)}KB) hit at line ${end} of ${lines.length}; continue with offset=${end + 1} or a smaller limit` } : {}),
    ...(start >= lines.length && lines.length > 0 ? { note: `offset ${offset} is beyond the last line (${lines.length}); nothing to show` } : {}),
    content: hint ? `${hint}\n${outlineBlock}${numbered}` : `${outlineBlock}${numbered}`,
    kbHint: hint || undefined,
    tag,
  };
}

async function toolWrite({ path: p, content }) {
  if (!p) return { error: 'path required' };
  if (typeof content !== 'string') return { error: 'content must be string' };
  const res = await resolvePermitted(p, 'w');
  if (res.error) return { error: res.error };
  const abs = res.abs;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { path: path.relative(process.cwd(), abs) || abs, bytes: Buffer.byteLength(content) };
}

/**
 * Edit tool: single-string replacement with optional multi-edit shorthand.
 */
async function toolEdit({ path: p, old_string, new_string, oldText, newText, edits, tag }) {
  if (!p) return { error: 'path required' };
  const res = await resolvePermitted(p, 'w');
  if (res.error) return { error: res.error };
  const abs = res.abs;
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
      hint: 'The tag comes from the KB index snapshot — run /kb update, then read/kb_outline again to refresh it, or omit tag to skip the safety check.',
    };
  }
  let next = text;
  const eolAdaptations = [];
  for (const e of editList) {
    if (typeof e.old !== 'string' || typeof e.neu !== 'string') return { error: 'edit.oldText/newText must be strings' };
    if (e.old === e.neu) return { error: 'oldText === newText' };
    // EOL-aware anchor matching. read() normalizes CRLF → LF for display, so
    // the model copies an LF-form oldText even when the file on disk is CRLF
    // — and a byte-exact indexOf then fails with "oldText not found" (the
    // read/edit sibling of the "grep 模式没命中" failure class). Try the
    // caller's form verbatim first; when the file is CRLF and the verbatim
    // probe failed, retry with the oldText's LF line breaks converted to CRLF
    // (never the reverse — a CRLF-form oldText on an LF file keeps failing
    // loudly rather than silently matching something else).
    let probe = e.old;
    let eolAdapted = false;
    let idx = next.indexOf(probe);
    if (idx === -1 && text.includes('\r\n') && probe.includes('\n')) {
      const crlfForm = probe.replace(/\n/g, '\r\n');
      if (crlfForm !== probe) {
        const alt = next.indexOf(crlfForm);
        if (alt !== -1) { idx = alt; probe = crlfForm; eolAdapted = true; }
      }
    }
    if (idx === -1) {
      return {
        error: `oldText not found${text.includes('\r\n') ? ' (file uses CRLF line endings; re-read the file and match the exact text)' : ''}`,
        ...(eolAdaptations.length > 0 ? { partial: eolAdaptations } : {}),
      };
    }
    const idx2 = next.indexOf(probe, idx + 1);
    if (idx2 !== -1) return { error: `oldText not unique (matches at ${idx}, ${idx2})` };
    // Replacement text: keep the file's line-ending convention. When the
    // anchor matched in CRLF form, the replacement's LF breaks become CRLF
    // too — otherwise the edit injects mixed line endings into a CRLF file.
    let replacement = e.neu;
    if (eolAdapted) {
      replacement = replacement.replace(/\n/g, '\r\n');
      eolAdaptations.push({ oldText: `${e.old.slice(0, 60)}${e.old.length > 60 ? '…' : ''}`, lineEndings: 'LF→CRLF' });
    }
    next = next.slice(0, idx) + replacement + next.slice(idx + probe.length);
  }
  await fs.writeFile(abs, next);
  return {
    path: path.relative(process.cwd(), abs) || abs,
    applied: editList.length,
    ...(eolAdaptations.length > 0 ? { eolAdapted: eolAdaptations } : {}),
  };
}

async function toolGlob({ pattern, path: cwd, limit }, guard) {
  if (!pattern) return { error: 'pattern required' };
  let root = process.cwd();
  if (cwd) {
    const res = await resolvePermitted(cwd, 'r');
    if (res.error) return { error: res.error };
    root = res.abs;
  }
  const lim = Math.max(1, Math.min(1000, limit || 1000));
  const { files: results, truncated, rootMissing } = await globWalk(root, pattern, lim);
  if (rootMissing) return { error: `path not found: ${cwd}` };
  return {
    cwd: root,
    count: results.length,
    files: results,
    ...(truncated ? { truncated: true, note: `file enumeration capped at ${lim}; narrow the pattern or pass a tighter path to see more` } : {}),
    kbHint: guard?.shouldHintSearchTool?.()
      ? guard.searchToolHint('find/glob', 'kb_outline lists what the KB knows per file')
      : undefined,
  };
}

async function toolGrep({ pattern, path: cwd, glob: globPat, ignoreCase, literal, context, limit }, guard) {
  if (!pattern) return { error: 'pattern required' };
  let root = process.cwd();
  if (cwd) {
    const res = await resolvePermitted(cwd, 'r');
    if (res.error) return { error: res.error };
    root = res.abs;
  }
  const lim = Math.max(1, Math.min(100, limit || 100));
  let re;
  try {
    re = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ignoreCase ? 'i' : '');
  } catch (err) { return { error: `bad regex: ${err.message}` }; }
  const { files, truncated, rootMissing } = await globWalk(root, globPat || '**/*', 2000);
  if (rootMissing) return { error: `path not found: ${cwd}` };
  const matches = [];
  const ctx = Math.max(0, Math.min(5, context || 0));
  for (const f of files) {
    if (matches.length >= lim) break;
    let text;
    try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
    // Normalize line endings: CRLF files would otherwise leave a trailing
    // CR glued to every line (visible in match text, and it can defeat a
    // line-anchored regex like 'foo$').
    const norm = text.replace(/\r\n/g, '\n');
    const lines = norm === '' ? [] : norm.split('\n');
    // split('\n') on a file ending in '\n' yields a trailing PHANTOM empty
    // element — it would surface as a bogus empty context line (and let a
    // '^$' pattern match a line that does not exist). Drop it. An empty
    // file has NO lines at all (not even one empty line).
    if (lines.length > 0 && norm.endsWith('\n')) lines.pop();
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const before = ctx > 0 ? lines.slice(Math.max(0, i - ctx), i) : [];
        const after = ctx > 0 ? lines.slice(i + 1, i + 1 + ctx) : [];
        matches.push({
          file: path.relative(root, f),
          line: i + 1,
          text: lines[i].slice(0, 240),
          // `before` can be SHORTER than ctx near the top of the file — derive
          // each line number from the actual slice length, not from ctx (the
          // old `i - ctx + j + 1` produced 0 / negative line numbers there).
          before: before.map((t, j) => ({ line: i + 1 - before.length + j, text: t.slice(0, 240) })),
          after: after.map((t, j) => ({ line: i + 2 + j, text: t.slice(0, 240) })),
        });
        if (matches.length >= lim) break;
      }
    }
  }
  return {
    count: matches.length,
    scannedFiles: files.length,
    ...(truncated ? { filesTruncated: true, note: `file scan capped at 2000 files — some files beyond the cap were NOT searched; narrow the glob or path to be safe` } : {}),
    matches,
    kbHint: guard?.shouldHintSearchTool?.()
      ? guard.searchToolHint('grep', 'grep is for literal text only')
      : undefined,
  };
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
  let root = process.cwd();
  if (cwd) {
    const res = await resolvePermitted(cwd, 'r');
    if (res.error) return { error: res.error };
    root = res.abs;
  }
  const lim = Math.max(1, Math.min(50, limit || 30));
  const { files, truncated, rootMissing } = await globWalk(root, globPat || '**/*', 2000);
  if (rootMissing) return { error: `path not found: ${cwd}` };
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
  // Generic once-per-call nudge when the pattern is NOT an exact identifier
  // and no KB tool was chosen yet (same scoping rule as the grep/glob hints).
  if (!kbHint && guard?.shouldHintSearchTool?.()) {
    kbHint = guard.searchToolHint('ast_grep');
  }
  return {
    pattern: pat,
    scope: path.relative(process.cwd(), root) || '.',
    matchCount: out.length,
    fileCount: filesWithMatches.size,
    ...(truncated ? { filesTruncated: true, note: `file scan capped at 2000 files — some files beyond the cap were NOT searched; narrow the glob or path to be safe` } : {}),
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

  // Resolve paths to absolute file lists. NOTE: this tool eventually WRITES
  // the matched files (via the staged proposal that `resolve` applies), so
  // the paths must be checked for 'w' — resolving with 'r' would let an
  // outside path granted read-only access be modified, and an inside-project
  // deny:"w" rule (e.g. node_modules) be bypassed. ast_grep (pure search)
  // keeps 'r'.
  const allFiles = [];
  for (const p of paths) {
    const res = await resolvePermitted(p, 'w');
    if (res.error) return { error: res.error };
    const root = res.abs;
    let stat;
    try { stat = await fs.stat(root); } catch { return { error: `not found: ${p}` }; }
    if (stat.isFile()) {
      allFiles.push(root);
    } else if (stat.isDirectory()) {
      const { files: walked } = await globWalk(root, '**/*', 2000);
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
      // Matches are applied in ascending offset order, located via indexOf
      // on the evolving text, so earlier substitutions can shift later
      // offsets.
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

  // Permission gate: applying a proposal WRITES files, so every target
  // needs 'w' (checked per file at apply time, since rules may change
  // between the ast_edit preview and this resolve call). checkReal adds the
  // symlink-resolved re-check — a target swapped to a symlink between stage
  // and apply must not slip through on its lexical spelling. Discard is a
  // pure in-memory operation and stays ungated.
  if (action === 'apply') {
    const svc = getPermissionService();
    for (const f of entry.files) {
      const res = await svc.checkReal(f.abs, 'w');
      if (!res.ok) {
        return { error: `permission denied: ${f.abs}: ${res.reason}. Access is controlled by setting.json (see README section "setting.json — filesystem permissions").` };
      }
    }
  }

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

  // Filesystem permission gate (setting.json): scan the command for explicit
  // absolute / ../-style paths and verify each against the rwx rules. This is
  // best-effort — it cannot be a hard guarantee against a Turing-complete
  // shell, but it stops accidental damage outside the permitted scope.
  const svc = getPermissionService();
  const cmdPerm = await svc.checkCommand(command);
  if (!cmdPerm.ok) {
    return { error: `permission denied: ${cmdPerm.reason}. Access is controlled by setting.json (see README section "setting.json — filesystem permissions").` };
  }

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
  return async ({ query, top_k, skip_rewrite, with_slice = true }, guard) => {
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
        // timeoutMs omitted: default resolved from HK2_LLMAPI_TIMEOUT_MS_SIMPLE
        // (default 300s) inside rewriteQuery — was a hardcoded 15s cap.
        const r = await rewriteQuery(llm, query, {});
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

    // Default top_k lowered 20 -> 10: 20 rarely-helpful snippets inflate the
    // result payload (which both costs context and zeroes out the naive
    // "did the KB save tokens" arithmetic). Callers can still ask for up to 50.
    const results = codeSearch(rt, retrievalQuery, { topK: Math.max(5, Math.min(50, top_k || 10)) });

    // Optional line slices for the top hits: ±15 lines around the symbol's
    // definition, straight from disk. This is what lets the agent "see the
    // implementation" from kb_search alone instead of issuing a full read —
    // the single biggest lever for real (not just re-attributed) savings.
    // Slice loading is best-effort: file missing / too large -> no slice.
    // Files denied by setting.json get NO slice (a read() would be denied,
    // so the slice must be too).
    const sliced = with_slice ? results.slice(0, 3) : [];
    const slices = sliced.length > 0 ? await loadSlices(sliced) : null;

    // Permission filter on the INDEX SNAPSHOT rows themselves: snippets and
    // slices carry real file content, so a deny:'r' rule in setting.json
    // must suppress them exactly as it suppresses a read(). Metadata-only
    // fields (name/kind/signature/line ranges) stay — they carry no file
    // content beyond what the symbol index already exposes.
    const deniedPaths = [];
    let allowed = null; // Map<filePath, contentAbs|null>
    let allowedSet = null;
    if (results.length > 0) {
      const filePaths = results.map(r => r.filePath);
      allowed = await resolveKbContentPaths(filePaths);
      allowedSet = await filterAllowedPaths(
        [...allowed.values()].filter(Boolean));
      for (const [fp, abs] of allowed) {
        if (abs && !allowedSet.has(abs)) deniedPaths.push(abs);
      }
    }
    const contentOk = (filePath) => {
      const abs = allowed?.get(filePath);
      return Boolean(abs && allowedSet?.has(abs));
    };

    const out = {
      query,
      retrievalQuery,
      rewrite: rewriteInfo,
      count: results.length,
      // Non-empty when some hits were suppressed by setting.json so the
      // agent knows why a high-scoring symbol carries no snippet/slice.
      permissionFiltered: deniedPaths.length > 0 ? [...new Set(deniedPaths)] : undefined,
      results: results.map((r, i) => ({
        id: r.id, name: r.name, kind: r.kind,
        filePath: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
        signature: r.signature, score: r.score,
        // Snippet = first lines of the symbol BODY (real file content,
        // mirrored from the index snapshot) — suppressed when the content
        // file is denied. Trimmed to the first 200 chars otherwise: enough
        // to judge relevance without dominating payload.
        snippet: (allowedSet && !contentOk(r.filePath))
          ? undefined : (r.snippet || '').slice(0, 200),
        slice: slices?.[i] || undefined,
      })),
    };
    return out;
  };
}

/**
 * Load ±15-line source slices for the given search results. Returns a map
 * (result index -> slice string) or null when nothing could be loaded.
 * Best-effort: unreadable files, missing paths, and >512KB files are skipped.
 */
async function loadSlices(results) {
  const SLICE_CONTEXT = 15;
  const MAX_FILE_BYTES = 512 * 1024;
  const svc = getPermissionService();
  const out = {};
  await Promise.all(results.map(async (r, i) => {
    if (!r.filePath || typeof r.lineStart !== 'number') return;
    for (const abs of kbPathCandidates(r.filePath)) {
      // Permission gate (setting.json): a slice is file content — the same
      // 'r' a read() would need. Denied / unreadable → no slice (and for
      // absolute candidates, don't fall through to other roots).
      try {
        const res = await svc.checkReal(abs, 'r');
        if (!res.ok) return;
      } catch { return; }
      let text;
      try {
        const st = await fs.stat(abs);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
        text = await fs.readFile(abs, 'utf8');
      } catch { continue; }
      // Display normalization — same rule as toolRead/toolGrep: CRLF → LF
      // so slices never glue a trailing CR onto every numbered line, and the
      // trailing-newline phantom element is popped so the last slice row is a
      // real line (not an empty 00000-padded artifact).
      const norm = text.replace(/\r\n/g, '\n');
      const lines = norm === '' ? [] : norm.split('\n');
      if (lines.length > 0 && norm.endsWith('\n')) lines.pop();
      const start = Math.max(0, (r.lineStart || 1) - 1 - SLICE_CONTEXT);
      const end = Math.min(lines.length, (r.lineEnd || r.lineStart || 1) - 1 + 1 + SLICE_CONTEXT);
      const slice = lines.slice(start, end)
        .map((l, j) => `${String(start + j + 1).padStart(5)}\t${l}`)
        .join('\n');
      out[i] = slice;
      return;
    }
  }));
  return Object.keys(out).length > 0 ? out : null;
}

function toolKbSymbol(rt) {
  return async ({ name }, guard) => {
    if (!name) return { error: 'name required' };
    guard?.noteKbUsage?.();
    const syms = rt.getSymbolsByName(name) || [];
    // Permission filter: docString is file CONTENT (parsed from the source
    // JSDoc) — suppressed when the content file is denied by setting.json.
    // Pure metadata (name/kind/lines/signature) stays visible so navigation
    // still works.
    const fps = [...new Set(syms.map(s => rt.getFilePath(s.fileId)).filter(Boolean))];
    const absByFp = await resolveKbContentPaths(fps);
    const allowedSet = await filterAllowedPaths([...absByFp.values()].filter(Boolean));
    const pathOk = (s) => {
      const abs = absByFp.get(rt.getFilePath(s.fileId));
      return Boolean(abs && allowedSet.has(abs));
    };
    // Doc strings live on the knowledge-graph nodes (parsed from JSDoc), not on
    // the BM25 symbol rows — resolve via the node id ("g<fileId>:<line>").
    const nodeDoc = (s) => {
      if (!pathOk(s)) return '';
      if (s.docString) return s.docString;
      try {
        const node = rt.graph?.nodes?.get?.(rt.toNodeId(s.id));
        return node?.docString || '';
      } catch { return ''; }
    };
    return {
      count: syms.length,
      symbols: syms.map(s => ({
        id: s.id, name: s.name, kind: s.kind,
        filePath: rt.getFilePath(s.fileId),
        lineStart: s.lineStart, lineEnd: s.lineEnd,
        signature: s.signature,
        // Doc string (first 300 chars) so "what does this do" questions can
        // often be answered without a follow-up read. Empty for files denied
        // by setting.json (doc strings are parsed file content).
        docString: nodeDoc(s).slice(0, 300) || undefined,
      })),
    };
  };
}

/**
 * File outline straight from the loaded KB index (index-only; no filesystem
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
    // Permission filter: outline docStrings are parsed file CONTENT — blank
    // them for files denied by setting.json (metadata rows stay visible).
    const contentAbs = await resolveKbContentPath(p);
    const allowedSet = await filterAllowedPaths(contentAbs ? [contentAbs] : []);
    const contentAllowed = Boolean(contentAbs && allowedSet.has(contentAbs));
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
        docString: contentAllowed ? (s.docString || '').slice(0, 200) : '',
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

    // Permission filter (setting.json): docString is file CONTENT (parsed
    // from the class's source JSDoc) — blanked when the file is denied.
    // Pure metadata (name/kind/members/signatures/hierarchy) stays visible
    // so navigation keeps working. Same pattern as kb_symbol/kb_outline;
    // this was the last content outlet not routing through filterAllowedPaths.
    const contentAbs = await resolveKbContentPath(node.filePath);
    const allowedSet = await filterAllowedPaths(contentAbs ? [contentAbs] : []);
    const contentAllowed = Boolean(contentAbs && allowedSet.has(contentAbs));

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
      // Empty string for files denied by setting.json (doc strings are
      // parsed file content, same rule as kb_outline).
      docString: contentAllowed ? (node.docString || '').slice(0, 400) : '',
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
        // Surface the entry's anchor files so callers (and the kb-stats
        // estimator) can see which source files this entry stands in for.
        keyFiles: entry.keyFiles || [],
      })),
    };
  };
}

/**
 * Save a knowledge entry to Holy or Eden space. Replaces kb_save_principle.
 *
 * Space policy - ENFORCED HERE via the confirm callback (not deferred to the
 * caller's good behavior): the previous implementation just called
 * writeKnowledge() directly, silently persisting to Holy Space without ever
 * prompting the user - a serious violation of the "Holy updates ALWAYS require
 * explicit approval" contract that the tool's own guidelines advertise.
 *   - Holy: stable knowledge (design principles, key algorithms). ALWAYS
 *     prompts the user y/N before committing, regardless of env vars.
 *   - Eden: frequently-updated knowledge. Auto-commits when
 *     HK2_ENABLE_AUTO_LEARN=1; otherwise also prompts.
 *
 * `confirm(targetSpace, entry)` returns true (proceed) / false (cancelled) /
 * 'eden' (redirect: save to Eden instead). The 'eden' answer is only offered
 * for NEW Holy entries — entry.isNew tells the callback whether the id already
 * exists in the target space (an update keeps the plain y/N contract). A
 * redirect to Eden does NOT re-confirm: the user already made the choice.
 * When absent (defensive), Holy writes are REFUSED - fail closed rather than
 * silently writing to the source of truth.
 */
function toolKbSaveKnowledge(rt, projectId, confirm) {
  return async ({ space, id, title, intro, key_files, key_symbols, keywords }, guard) => {
    if (!id) return { error: 'id required' };
    if (!title) return { error: 'title required' };
    if (!intro || typeof intro !== 'string') return { error: 'intro required' };
    if (isSupremeCode(id)) {
      return {
        error: `"${SUPREME_CODE_ID}" is the permanent Supreme Code entry. It is managed exclusively via /kb code add and /kb code del (explicit user commands with confirmation) — never via kb_save_knowledge. If the user asks to change the supreme code, tell them to run /kb code add|del themselves.`,
      };
    }
    let targetSpace = space === 'eden' ? 'eden' : 'holy';  // default holy (safer)

    // New-vs-update detection: the (y/N/E) tri-state prompt is only offered
    // when the entry id does NOT already exist in the target space. Updating
    // an existing entry keeps the plain (y/N) contract.
    const { readKnowledge } = await import('../store/kb_store.js');
    const existing = await readKnowledge(rt.name, targetSpace, id).catch(() => null);
    const isNew = !existing;

    // Approval gate. Holy ALWAYS needs explicit confirmation; Eden needs it
    // unless auto-learn is on. Fail closed for Holy when no confirm callback is
    // wired (e.g. a future non-interactive caller) - never silently write to
    // the source of truth.
    const autoLearn = /^(1|yes|true|on)$/i.test((process.env.HK2_ENABLE_AUTO_LEARN || '').trim());
    const needsConfirm = targetSpace === 'holy' || !autoLearn;
    if (needsConfirm) {
      if (typeof confirm !== 'function') {
        return { saved: false, cancelled: true, space: targetSpace, error: `Refused: writing to ${targetSpace} space requires user confirmation, but no confirm callback is wired (non-interactive context).` };
      }
      let approved = false;
      try { approved = await confirm(targetSpace, { id, title, intro, keyFiles: key_files, keySymbols: key_symbols, keywords, isNew }); }
      catch { approved = false; }
      // Tri-state: 'eden' redirects a NEW Holy write into Eden (no re-confirm —
      // the user's single answer IS the approval for the Eden write). Any other
      // non-true answer (false, or 'eden' on an UPDATE where redirect doesn't
      // apply) is a refusal.
      if (approved === 'eden' && targetSpace === 'holy' && isNew) {
        targetSpace = 'eden';
      } else if (approved !== true) {
        return { saved: false, cancelled: true, space: targetSpace, message: `User declined to write "${id}" to ${targetSpace} space. Do NOT retry; respect the user's decision.` };
      }
    }

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

/**
 * Permission-checked path resolution (powered by setting.json).
 *
 * Replaces the old boolean workspace-containment check with the rwx model:
 *   - inside a workspace root → allowed (file rw / dir rwx by default)
 *   - outside → only allowed when a setting.json rule grants the mode
 *
 * @param {string} p       path to resolve
 * @param {'r'|'w'|'x'} mode  access mode required by the calling tool
 * @returns {Promise<{abs:string}|{error:string}>}
 */
async function resolvePermitted(p, mode) {
  if (!p || typeof p !== 'string') return { error: 'path required' };
  const abs = path.resolve(p);
  const svc = getPermissionService();
  // checkReal = lexical decision + symlink-resolved re-check. A path that
  // LOOKS inside-project but is a symlink to an outside file must not slip
  // through on its lexical spelling alone.
  const res = await svc.checkReal(abs, mode);
  if (!res.ok) {
    return { error: `permission denied: ${res.reason}. Access is controlled by setting.json (see README section "setting.json — filesystem permissions").` };
  }
  return { abs };
}

/**
 * Enumerate files under `root` matching a glob pattern.
 *
 * Built on lib/index/walker.js:compileGlob — the SAME glob engine the KB
 * indexer uses (`**` crosses directory levels incl. zero, `*` stays within
 * one segment, matching runs against the FULL path relative to `root`).
 * This fixes the reliability bugs the old segment-wise walker had:
 *   - `path` pointing at a FILE is now honored (single-file scope); the old
 *     walker readdir'd it, got ENOTDIR, swallowed it and returned zero files
 *     — the "read sees it but grep misses it" root cause.
 *   - `./`-prefixed and root-relative-prefixed patterns ('./src/' +
 *     '**' + '/*.js', 'src/' + '**' + '/*.js' with path=src) now match; the
 *     old walker fed the raw segment to a per-NAME matcher, so `.` matched
 *     nothing and a redundant leading dir segment never lined up with the
 *     walk position.
 *   - Truncation is now REPORTED: the caller gets { files, truncated } so a
 *     limit hit surfaces as a visible flag instead of a silent partial scan.
 *
 * Prunes .git/node_modules (the old behavior) and keeps per-directory and
 * per-file permission checks (setting.json) at every level.
 *
 * @param {string} root absolute root (file or directory)
 * @param {string} pattern glob pattern relative to root ('' / undefined → catch-all)
 * @param {number} limit max files to return
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
async function globWalk(root, pattern, limit) {
  const out = [];
  const lim = Math.max(1, limit | 0);
  const pats = expandGlobPatterns(pattern);
  // File root: honor it directly as a single-file scope when its basename
  // matches any expanded pattern (or the pattern is the catch-all).
  let rootStat = null;
  try { rootStat = await fs.stat(root); }
  catch (err) {
    // A missing root previously collapsed to a SILENT zero-file scan — the
    // caller then reported "0 matches" and the agent concluded the pattern
    // was not in the codebase (a "grep claims no match" failure class).
    // ENOENT / ENOTDIR are surfaced as rootMissing; other stat errors
    // (e.g. EACCES) keep the old silent-empty behavior.
    const missing = err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
    return { files: [], truncated: false, ...(missing ? { rootMissing: true } : {}) };
  }
  if (rootStat.isFile()) {
    const base = path.basename(root);
    for (const pat of pats) {
      if (compileGlob(pat).test(base)) return { files: [root], truncated: false };
    }
    return { files: [], truncated: false };
  }
  if (!rootStat.isDirectory()) return { files: [], truncated: false };
  // A pattern may carry a redundant root-relative directory prefix — the
  // user passed path=src AND glob='src/' + '**' + '/*.js'. Match against the
  // pattern verbatim OR against the pattern with the root's own name
  // stripped from the front (when the pattern starts with it).
  const rootName = path.basename(root);
  const res = pats.map(p => compileGlob(p));
  const stripped = pats
    .filter(p => p.startsWith(rootName + '/'))
    .map(p => compileGlob(p.slice(rootName.length + 1)));
  const allRes = stripped.length > 0 ? [...res, ...stripped] : res;
  const state = { truncated: false };
  await walkGlob(root, root, allRes, out, lim, state);
  return { files: out, truncated: state.truncated };
}

/**
 * Expand a glob pattern into ONE OR MORE normalized patterns:
 *   - strip a leading './'
 *   - expand brace alternations ('*.{js,ts}' → ['*.js', '*.ts']) —
 *     compileGlob treats '{}' literally, and '*.{js,ts}' is a very common
 *     way to spell "js or ts"
 * Matching then runs against the path RELATIVE to the walk root. A pattern
 * that still carries a root-relative directory prefix (path=src with glob
 * 'src/' + '**' + '/*.js') is handled by globWalk, which additionally
 * matches the prefix-stripped form.
 */
function expandGlobPatterns(pattern) {
  if (typeof pattern !== 'string') return [];
  let p = pattern.trim();
  if (!p) return ['**/*'];
  if (p.startsWith('./')) p = p.slice(2);
  else if (p.startsWith('/')) p = p.slice(1);   // absolute-style spelling '/f.txt'
  // Brace expansion: only for simple comma alternation without nesting.
  const m = p.match(/\{([^{}]*,[^{}]*)\}/);
  if (m) {
    const alts = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (alts.length > 1) {
      const out = [];
      for (const a of alts) out.push(...expandGlobPatterns(p.slice(0, m.index) + a + p.slice(m.index + m[0].length)));
      return out;
    }
  }
  // A single-segment pattern ('*.js') must match at ANY depth — matching is
  // done against the full root-relative path, where a bare '*.js' would only
  // hit top-level files. Promote it to '**/' + pattern (ripgrep/fd behavior).
  if (!p.includes('/')) return ['**/' + p];
  return [p];
}

async function walkGlob(root, dir, res, out, limit, state) {
  if (out.length >= limit) { state.truncated = true; return; }
  // Permission pruning (setting.json): before LISTING this directory or
  // pushing any file, verify 'r' on it. A deny rule (e.g. deny rwx on
  // "secrets") must also hold when the walk started at an ancestor
  // (project root) — checking only the caller-supplied root would let a
  // recursive grep/find read straight through a denied subtree. Root itself
  // was already checked by the caller; skip the re-check to avoid double
  // logging and a redundant service round-trip.
  if (dir !== root) {
    const svc = getPermissionService();
    const res0 = await svc.checkReal(dir, 'r');
    if (!res0.ok) return; // prune the whole subtree
  }
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  // Shared file-candidate push: glob match + per-file permission gate
  // (deny rule on the FILE itself must suppress it from recursive listings).
  const pushIfMatched = (entPath) => {
    const rel = path.relative(root, entPath).split(path.sep).join('/');
    if (!res.some(re => re.test(rel))) return false;
    const svc = getPermissionService();
    // checkReal is async but the wrapper below awaits it — kept sync-looking
    // via the promise chain outside this loop for clarity.
    return svc.checkReal(entPath, 'r').then((fres) => {
      if (!fres.ok) return false;
      out.push(entPath);
      return true;
    });
  };
  for (const ent of entries) {
    if (out.length >= limit) { state.truncated = true; return; }
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const entPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkGlob(root, entPath, res, out, limit, state);
    } else if (ent.isFile()) {
      await pushIfMatched(entPath);
    } else if (ent.isSymbolicLink()) {
      // readdir(withFileTypes) reports symlinks as isSymbolicLink(), NOT
      // isFile() — a bare isFile() test silently drops every symlinked file
      // (the same "read sees it, grep misses it" failure class). Resolve the
      // link: a symlink to a FILE is a file candidate; a symlink to a
      // directory is treated as a directory (walked, not listed as a file);
      // a broken link is skipped. checkReal below stats the real path, so
      // the permission gate also follows the link.
      let st;
      try { st = await fs.stat(entPath); } catch { continue; }
      if (st.isFile()) await pushIfMatched(entPath);
      else if (st.isDirectory()) await walkGlob(root, entPath, res, out, limit, state);
    }
  }
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

/**
 * Plan-step advancement tool factory.
 *
 * After a plan is confirmed, the agent calls `plan_step` to mark a step as
 * done (optionally with a short note) so the live progress panel above the
 * status bar advances. When no `stepFn` is supplied (non-interactive mode)
 * the call is a no-op echo - progress tracking is an interactive-only UX.
 *
 *   stepFn(stepIndex, note) -> Promise<void>
 *     stepIndex is 1-based to match the plan numbering the agent sees.
 */
/**
 * `remember` tool: persist a session-scoped fact (environment facts — hosts,
 * ports, versions, identifiers, credentials-references, deployment
 * constraints, user preferences — anything the user states that later turns
 * must not forget). The callback does the actual write + message refresh;
 * when absent (non-interactive) the call reports the fact back as recorded-
 * only. Content-agnostic by design: any short string is a valid fact.
 */
function toolRemember(rememberFn) {
  return async ({ fact } = {}, _guard) => {
    const text = typeof fact === 'string' ? fact.trim() : '';
    if (!text) return { error: 'fact required (a short self-contained statement)' };
    if (text.length > 500) return { error: `fact too long (${text.length} chars; max 500) — split it or keep only the durable part` };
    if (typeof rememberFn !== 'function') {
      return { ok: false, message: 'Session facts are not available in this mode; state the fact in your reply instead.' };
    }
    try {
      const out = await rememberFn(text);
      if (out === null || out === false) return { ok: false, message: 'Could not persist the fact (storage unavailable); state it in your reply instead.' };
      return {
        ok: true,
        message: `Fact recorded for the rest of this session: "${text.slice(0, 120)}"`,
        hint: 'It is now always in scope via the "## Session facts" system message and survives context compaction. Record FACTS ONLY (addresses, versions, constraints, preferences) — code-discovery knowledge belongs in the KB via kb_save_knowledge.',
      };
    } catch (err) {
      return { error: `remember failed: ${err.message}` };
    }
  };
}

function toolPlanStep(stepFn) {
  return async ({ step, note } = {}, _guard) => {
    // `marked` is the 1-based step index the callback actually marked done
    // (or null when there is no active plan to advance). The callback is
    // responsible for normalizing sloppy model args (numeric strings,
    // 0-based indices, out-of-range values) - see the planStep callback in
    // interactive.js.
    let marked = null;
    if (typeof stepFn === "function") {
      try { marked = (await stepFn(step, note)) ?? null; } catch { /* best-effort UX */ }
    }
    if (marked) {
      return {
        ok: true,
        message: `Marked plan step ${marked} as done.`,
        hint: 'Call plan_step again after finishing the next step. When all steps are done the progress panel clears automatically.',
      };
    }
    if (typeof stepFn === "function") {
      // Interactive mode but no active plan (e.g. the plan was cleared by a
      // fresh user prompt): be honest so the model stops calling plan_step.
      return { ok: true, message: "No active plan - plan_step ignored (no progress panel to advance)." };
    }
    const idx = typeof step === "number" ? step : null;
    return {
      ok: true,
      message: idx
        ? `Marked plan step ${idx} as done.`
        : "Advanced plan progress.",
      hint: 'Call plan_step again after finishing the next step. When all steps are done the progress panel clears automatically.',
    };
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
  // Optional plan-step advancement callback. When supplied (interactive
  // mode), the `plan_step` tool updates the live progress panel above the
  // status bar as the agent completes each step.
  const planStep = opts.planStep;
  // Optional session-fact write callback. When supplied (interactive mode),
  // the `remember` tool persists a user-stated fact to the session facts
  // store and refreshes the standing "## Session facts" message so later
  // turns (and compaction) never lose it.
  const remember = opts.remember;
  // Optional knowledge-save approval callback. When supplied (interactive
  // mode), the `kb_save_knowledge` tool prompts the user y/N before writing
  // to Holy (always) or Eden (when auto-learn is off). Without it, Holy
  // writes are REFUSED rather than silently persisted - the source of truth
  // must never be written without explicit approval.
  const knowledgeConfirm = opts.knowledgeConfirm;
  const guard = opts.guard || new KbFirstGuard();

  const tools = [
    {
      name: 'read',
      snippet: 'Read a UTF-8 text file (KB outline may be prepended for eligible indexed source files)',
      guidelines: [
        'Use read to examine files instead of cat or sed. Text files only — there is no image or binary content support.',
        'For eligible indexed source files, read prepends a structural Outline (from KB) section. Use kb_outline first when you only need the structure — it is cheaper.',
        'For eligible indexed files the result may include a `tag` — the first 8 hex chars of the hash stored in the KB file registry (an index-snapshot tag, not a hash recomputed from the just-read content). Echo it back as the `tag` argument to edit for stale-anchor protection; if the index is stale, run /kb update and read again to refresh it.',
      ],
      description: `Read a UTF-8 text file. Files larger than 5 MiB are rejected before reading (offset/limit cannot bypass this). Files whose first 8192 decoded characters contain a NUL byte are rejected as binary (a NUL-scan heuristic, not full binary-format detection). Output is capped at ${MAX_READ_LINES} lines or roughly ${Math.floor(MAX_READ_BYTES / 1024)}KB at line boundaries, except that the first requested line is still emitted even when that one line exceeds the nominal byte cap; use offset/limit to continue reading eligible text files. For eligible indexed source files, an outline from the KB may be prepended unless outline=false.`,
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
      description: `Execute a bash command in the current working directory. Returns stdout and stderr, each independently truncated to an approximately ${Math.floor(MAX_BASH_OUTPUT / 1024)} KiB buffer budget (no separate line limit; a KB hint on stderr spends that stream's budget). Timeout in seconds: default 60, maximum 60 (larger values are clamped; 0 falls back to the default; negative values are not validated — do not use them).`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute' },
          timeout: { type: 'number', description: 'Positive timeout in seconds; default 60, maximum 60. Zero falls back to the default. Negative values are currently not validated and should not be used.' },
        },
        required: ['command'],
      },
      execute: toolBash,
    },
    {
      name: 'find',
      snippet: 'Find files by glob pattern (internal walker skips .git and node_modules; does not evaluate .gitignore)',
      guidelines: [],
      description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to 1000 results. Prefer KB tools (kb_outline lists what the KB indexes per file) when you want "what's in this file/module" rather than raw paths.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
          path: { type: 'string', description: 'Directory to search in (default: current directory)' },
          limit: { type: 'number', description: 'Maximum number of results (default: 1000)' },
        },
        required: ['pattern'],
      },
      execute: (args) => toolGlob(args, guard),
    },
    {
      name: 'grep',
      snippet: 'Search file contents for patterns (internal walker skips .git and node_modules; does not evaluate .gitignore)',
      guidelines: [],
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to 100 matches. Long lines are truncated to 240 chars. The search covers up to 2000 files per call; when the cap is hit the result carries filesTruncated + a note. Prefer the KB tools (kb_search for semantic concepts, kb_symbol for exact names) over grep — grep is only for literal text the KB index can't answer.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
          path: { type: 'string', description: 'Directory OR single file to search (default: current directory). A file path scopes the search to that one file.' },
          glob: { type: 'string', description: "Filter files by glob pattern matched against the path relative to the search root, e.g. '*.ts' or '**/*.spec.ts' ('./'-prefixed forms also accepted)" },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
          literal: { type: 'boolean', description: 'Treat pattern as literal string instead of regex (default: false)' },
          context: { type: 'number', description: 'Number of lines to show before and after each match (default: 0)' },
          limit: { type: 'number', description: 'Maximum number of matches to return (default: 100)' },
        },
        required: ['pattern'],
      },
      execute: (args) => toolGrep(args, guard),
    },
    {
      name: 'ast_grep',
      snippet: 'Structural code search with $$$/$_ metavariables (ast-grep style)',
      guidelines: [
        'Pattern syntax: $$$IDENT (multi-wildcard capture), $IDENT (single identifier capture), $_ (anon wildcard), other text is literal.',
        'For exact-identifier lookups across the codebase, prefer kb_symbol; ast_grep is for structural / multi-token patterns.',
      ],
      description: `Structural code search (ast-grep style). The pattern is translated to a regex approximation: $$$IDENT matches any text (multi-line, non-greedy), $IDENT matches a single identifier, $_ matches one token, and other characters are literal. Returns up to 50 matches across up to 2000 files. Examples: 'console.log($$$)' matches any console.log call; 'function $NAME($$$)' captures function names; 'class $NAME' captures class declarations.`,
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
        'Always call ast_edit first to preview; then call resolve with the returned proposalId to apply or discard. Re-validates each staged file before writing; on a read/tag/write failure hk2 attempts a best-effort restoration of files already written — restoration is not transactional and restoration failures are ignored. The rolledBack count in an error reports how many written files entered the restoration attempt, not verified successes.',
        'Template syntax in `out`: $IDENT / $$$IDENT / $_ substitute the captures matched by `pat`.',
        'Optional `tag` (a prior read/kb_outline tag) is compared against EVERY target file — one tag applies to all files, so it mainly suits single-file rewrites; for multi-file proposals omit tag and rely on the per-file re-validation at resolve time.',
      ],
      description: `Structural rewrite across one or more files. Computes proposed writes (never writes to disk itself), returns a unified-diff preview plus a proposalId, then stashes the writes for resolve. The optional tag parameter is checked against every target file, so it is intended for single-file rewrites. Each op is {pat, out}: pat uses ast-grep metavariables ($$$IDENT, $IDENT, $_), out uses the same syntax to substitute captures. Returns { proposed, proposalId, diffs[], summary }. If no matches, returns proposed:false with summary zeroed.`,
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
        'Re-validates each staged file\'s tag before writing; on a read/tag/write failure hk2 attempts a best-effort restoration of files already written — restoration is not transactional and restoration failures are ignored. rolledBack in an error result counts files that entered the restoration attempt, not verified successes.',
      ],
      description: `Two-step preview/apply flow for ast_edit. action:"apply" writes every staged file (re-validating the content tag first). On a failure hk2 attempts to restore already-written files from their previous contents; the rollback is best-effort and non-transactional (a rollback write that itself fails is ignored). action:"discard" drops the stash without writing. Returns { applied, discarded, proposalId } on success or { error, rolledBack } on failure.`,
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
      description: 'Propose an execution plan for the user to confirm. Use this when you, as the triage assistant, decide the task is complex enough to warrant a strategy decision the user should confirm before execution. Provide a `summary` string and a `steps` array of the intended shape (2-5 ordered steps, each with a `goal` and 2-4 `strategies` of { name, description, recommended }, exactly one recommended). That shape is a prompt-level recommendation: runtime validation enforces only a minimum of two usable steps and two usable strategies per step — no maximum, and a wrong number of recommended flags is normalized (first becomes recommended) rather than rejected. The tool surfaces the plan for per-step strategy selection (auto-accepting the recommended strategy in non-interactive mode) and returns the finalized plan text. Returns { confirmed, plan } on acceptance, { cancelled } on cancel, or { error } for an unusable shape.',
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
    {
      name: 'plan_step',
      snippet: 'Mark a plan step as done and advance the live progress panel',
      guidelines: [
        "Call `plan_step` exactly once after you finish the work for a confirmed plan step, to advance the live progress panel above the status bar.",
        "Each call advances the CURRENT in-progress step — the `step` argument is accepted for compatibility but the state machine deliberately ignores it for the mutation (no jumping to arbitrary steps). Call once per finished step.",
        "Do NOT call `plan_step` for steps that were never confirmed, or before the `plan` tool returns a confirmed plan. It is purely a progress UX signal, not a planning interface.",
        "When the last step is marked done the progress panel clears automatically - no separate finish call is needed.",
      ],
      description: "Advance the live progress panel by marking the CURRENT in-progress step of the confirmed plan as done. Use this AFTER finishing each step of a confirmed plan (the plan returned by the `plan` tool). The `step` argument is accepted but deliberately ignored for the mutation — the current in-progress step still advances on every call; invalid, out-of-range, or out-of-order values do not change which step is selected. No-op when no plan is active; when the turn ends normally the panel is finalized (any unfinished steps cleared) as a backstop.",
      parameters: {
        type: 'object',
        properties: {
          step: { type: "number", description: "Optional 1-based step number retained as a compatibility/reporting hint. The interactive state machine always advances the current in-progress step; this value does not select an arbitrary step." },
          note: { type: "string", description: "Optional short note on what was done (<= 160 chars)" },
        },
        required: [],
      },
      execute: toolPlanStep(planStep),
    },
    {
      name: 'remember',
      snippet: 'Persist a session fact (environment facts, constraints, preferences) — always in scope, survives compaction',
      guidelines: [
        "Call `remember` when the user states a durable session-scoped FACT: environment endpoints/addresses, ports, versions, account names (never secrets themselves), deployment constraints, naming conventions, or explicit preferences ('always run tests with X').",
        "Do NOT record task steps, code findings (use kb_save_knowledge for reusable code knowledge), or anything already obvious from the current context.",
        "One fact per call, phrased self-contained ('测试环境地址 10.1.2.3', 'PostgreSQL 16.2', '用 npm 不用 yarn').",
        "When a later turn seems to have lost an earlier fact, check the \"## Session facts\" system message before asking the user again.",
      ],
      description: 'Persist a short self-contained fact for the remainder of the session. The fact is injected into every subsequent turn via a standing "## Session facts" system message and is immune to context compaction. Use it for user-stated environment facts, constraints, and preferences — not for code knowledge (that belongs to kb_save_knowledge).',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact, as a short self-contained statement (<= 500 chars)' },
        },
        required: ['fact'],
      },
      execute: toolRemember(remember),
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
        guidelines: ['Use kb_search instead of grep when looking for semantic concepts; grep is for literal text. When an LLM is attached and skip_rewrite is not true, the query is rewritten before retrieval; pass skip_rewrite=true if you already have identifier-style keywords.'],
        description: 'Search the project knowledge base by natural-language / keyword query. Returns symbols ranked by BM25 + name-match reranking, with file paths, line ranges, and snippets. When an LLM is attached and skip_rewrite is not true, the query is rewritten before retrieval; pass skip_rewrite=true to skip that step (useful when you already have identifiers). By default the top 3 results also carry a ±15-line source slice (with_slice=false to disable) so you can usually judge or use the implementation without a follow-up read.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language or keyword query' },
            top_k: { type: 'number', description: 'Requested result count: default 10, clamped to an effective range of 5-50 (values below 5 still return at least 5).' },
            skip_rewrite: { type: 'boolean', description: 'Skip the LLM query-rewrite step (default false)' },
            with_slice: { type: 'boolean', description: 'Attach ±15-line source slices to the top 3 results (default true)' },
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
        snippet: 'File outline from the loaded KB index — name/kind/lines/signature per symbol',
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
        description: 'Legacy one-hop OUTGOING call-graph neighbors for the symbol (what it calls; there is no direction parameter). Use kb_callchain with direction=backward or both when callers are needed.',
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
        description: 'Bounded breadth-first (BFS) traversal over the call graph. Returns callers and/or callees up to max_depth hops. max_nodes is applied INDEPENDENTLY to each selected direction; the BFS budget includes the starting node, which is omitted from the returned arrays, so for the recommended max_nodes >= 2 each direction returns at most max_nodes - 1 other nodes (0/1/negatives are not validated).',
        parameters: {
          type: 'object',
          properties: {
            symbol_id: { type: 'string', description: 'Starting symbol id ("<fileId>:<line>")' },
            direction: { type: 'string', enum: ['forward', 'backward', 'both'], description: 'forward = callees, backward = callers, both = bidirectional (default both)' },
            max_depth: { type: 'number', description: 'Max hop depth (default 2)' },
            max_nodes: { type: 'number', description: 'Node budget per direction (default 20; use >= 2). Applied independently to forward and backward; the budget includes the start node which is omitted from results, so values >= 2 yield at most max_nodes - 1 other nodes per direction. 0/1/negative are not validated.' },
          },
          required: ['symbol_id'],
        },
        execute: toolKbCallChain(rt),
      },
      {
        name: 'kb_class',
        snippet: 'Look up a class / interface / struct / enum by name with members + implementations',
        guidelines: [
          'When the user asks "what is in class X" or "show the members of Y", use kb_class instead of reading the file directly.',
        ],
        description: 'Look up a class, interface, struct, or enum. `qual_name` performs an exact qualified-name lookup; `name` performs a substring search, and when multiple candidates match the first class/struct/interface/enum candidate is returned — prefer `qual_name` for ambiguous names. Returns: signature, doc string, members (methods + fields), super-classes, and direct implementations.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Class / interface / struct / enum name (substring match)' },
            qual_name: { type: 'string', description: 'Optional fully-qualified name (Namespace.Class) for exact match' },
          },
        },
        execute: toolKbClass(rt),
      },
      {
        name: 'kb_refs',
        snippet: 'Find references to a symbol (callers, importers, derived classes)',
        guidelines: [],
        description: 'Reverse lookup of DIRECT (one-hop) relations: callers (call edges, depth 1), direct importers of the containing file, and directly derived classes (one inheritance hop — not a transitive closure). Pass kind=call|import|inherit|any.',
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
        description: 'Given an interface or base class, list the DIRECT implementers / direct subclasses recorded by the graph (one hop on the inheritance edges — not a recursive transitive closure; query the results again to walk deeper).',
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
          'TIMING: call this AFTER streaming your complete final summary, in the same final assistant message (text first, tool call after). Never mid-task, never with an empty summary. After the save resolves, reply with a one-line confirmation and finish.',
          'Saving to Holy ALWAYS prompts the user before commit, even with HK2_ENABLE_AUTO_LEARN=1 — Holy space is the source of truth and updates require explicit approval. For NEW Holy entries the prompt is (y/N/E): y writes to Holy, N cancels, E saves to Eden instead. Updating an existing Holy entry prompts plain (y/N).',
          'Saving to Eden auto-commits when HK2_ENABLE_AUTO_LEARN=1; otherwise also prompts.',
          'The entry should be self-contained: intro is the concept in prose; keyFiles / keySymbols anchor it to the codebase; keywords help future kb_search_knowledge hit it.',
        ],
        description: 'Persist a knowledge entry into Holy Space (stable, requires user approval) or Eden Space (frequently-updated, auto-learn eligible). Reloads into the in-memory KB runtime immediately. Caveat: an identical kb_knowledge / kb_search_knowledge call that already produced a successful cached result earlier in this same runLoop may still return that cached result until the per-run tool cache is cleared (bash/edit/write/ast_edit/resolve) or a new loop begins.',
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
        execute: toolKbSaveKnowledge(rt, opts.projectId, knowledgeConfirm),
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
    // Error-contract normalization (issue #3): most tools signal failure by
    // RETURNING `{ error: <string> }` rather than throwing — ~60 call sites.
    // Wrapping those in `ok: true` poisoned every downstream consumer
    // (onToolCallEnd UI, transcript logToolCall, stuck-detection
    // fingerprints) and let failed calls enter the per-run tool cache.
    // A result is a "pure error" when `error` is its ONLY own field; results
    // that carry additional data (e.g. `{ error, written }` from a partial
    // multi-file resolve) keep their shape and ok:true so no data is lost.
    const isPureError = result
      && typeof result === 'object'
      && !Array.isArray(result)
      && typeof result.error === 'string'
      && Object.keys(result).every((k) => k === 'error');
    if (isPureError) {
      return {
        ok: false,
        error: result.error,
        guard: tool._guard?.snapshot?.(),
      };
    }
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
