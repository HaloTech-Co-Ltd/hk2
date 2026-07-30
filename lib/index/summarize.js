/**
 * End-of-build LLM-authored Eden entries.
 *
 * Three entries written by /kb init (overwriting any prior versions):
 *   - project-overview           High-level description, key modules, patterns
 *   - architecture-diagram       Mermaid diagram of module / layer relationships
 *   - architecture-decisions     Auto-inferred ADRs from detected tech signals
 *                                (with modification-suggestions per ADR)
 *
 * The deeper / project-wide survey entries (api-docs, code-walkthrough,
 * usage-examples) are produced by /kb knowledge init via
 * `generateSurveyEntries()` in this same module.
 *
 * All prompts are English-only, per project conventions. The entries are
 * saved to Eden Space (auto-updatable) and surface in kb_search_knowledge
 * and the per-request knowledge graph.
 *
 * If `llm` / `streamLLM` is not provided, this module is a no-op.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeKnowledge } from '../store/kb_store.js';
import { exists } from '../util/fs_atomic.js';
import log from '../util/log.js';

const SUMMARY_TIMEOUT_MS = 60_000;

/**
 * Build a unified LLM-call helper that supports both `llm.chat` (returning an
 * object with .text / .content) and `streamLLM` (an async-generator yielding
 * { type: 'delta' | 'reasoning' | 'usage', text? } events, like ctx.streamLLM).
 *
 * Returns: async (sysPrompt, userPrompt) => string
 */
function makeCallLLM(llm, streamLLM) {
  if (streamLLM) {
    return async (sys, user) => {
      try {
        let out = '';
        for await (const evt of streamLLM(
          [{ role: 'system', content: sys }, { role: 'user', content: user }],
          { maxChars: 12_000, enableReasoning: false, timeoutMs: SUMMARY_TIMEOUT_MS },
        )) {
          if (evt.type === 'delta' && typeof evt.text === 'string') out += evt.text;
        }
        return out;
      } catch (err) {
        log.warn('LLM stream failed', { msg: err.message });
        return '';
      }
    };
  }
  if (llm) {
    return async (sys, user) => {
      try {
        const result = await llm.chat([
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ], { maxChars: 12_000, enableReasoning: false });
        return result?.text || result?.content || '';
      } catch (err) {
        log.warn('LLM chat failed', { msg: err.message });
        return '';
      }
    };
  }
  return async () => '';
}

/**
 * Drive all three summaries. Idempotent — overwrites prior entries.
 *
 * @param {string} kbName
 * @param {object} opts
 * @param {object} [opts.llm]               LLMClient (optional)
 * @param {function} [opts.streamLLM]       Async-generator streaming wrapper (ctx.streamLLM) (optional)
 * @param {object} opts.stats               Indexer stats
 * @param {Array} opts.allSymbols           Symbol[] from indexer
 * @param {object} opts.filesIndex          files.json byId/byPath
 * @param {function} [opts.onProgress]      Called for each summary
 */
export async function generateSummaries(kbName, opts = {}) {
  const { llm, streamLLM, stats, allSymbols, filesIndex, onProgress, onSummaryProgress } = opts;
  const summaryCb = onSummaryProgress || onProgress;
  if (!llm && !streamLLM) {
    log.info('summarize: no LLM available; skipping auto-generated Eden entries');
    return;
  }

  const callLLM = makeCallLLM(llm, streamLLM);

  const meta = await loadProjectMeta(kbName);
  const projectMap = buildProjectMap(allSymbols, filesIndex, meta);

  // 1) project-overview
  if (summaryCb) summaryCb('project-overview');
  const overviewText = await callLLM(OVERVIEW_SYS, OVERVIEW_USER(projectMap));
  if (overviewText) {
    await writeKnowledge(kbName, 'eden', {
      id: 'project-overview',
      title: 'Project Overview (auto-generated)',
      intro: overviewText,
      keyFiles: topFiles(projectMap, 5),
      keySymbols: [],
      keywords: ['overview', 'architecture', 'intro', 'project', 'summary'],
      source: 'kb-init-summary',
      createdAt: new Date().toISOString(),
    });
    log.info('wrote Eden entry: project-overview');
  }

  // 2) architecture-diagram (Mermaid)
  if (summaryCb) summaryCb('architecture-diagram');
  const diagramText = await callLLM(DIAGRAM_SYS, DIAGRAM_USER(projectMap, allSymbols));
  if (diagramText) {
    await writeKnowledge(kbName, 'eden', {
      id: 'architecture-diagram',
      title: 'Architecture Diagram (Mermaid, auto-generated)',
      intro: diagramText,
      keyFiles: topFiles(projectMap, 5),
      keySymbols: [],
      keywords: ['diagram', 'mermaid', 'architecture', 'modules', 'layers', 'visualization'],
      source: 'kb-init-summary',
      createdAt: new Date().toISOString(),
    });
    log.info('wrote Eden entry: architecture-diagram');
  }

  // 3) architecture-decisions (with modification suggestions)
  if (summaryCb) summaryCb('architecture-decisions');
  const techSignals = await detectTechSignals(meta);
  const adrText = await callLLM(ADR_SYS, ADR_USER(projectMap, techSignals));
  if (adrText) {
    await writeKnowledge(kbName, 'eden', {
      id: 'architecture-decisions',
      title: 'Architecture Decision Records + Modification Suggestions (auto-inferred)',
      intro: adrText,
      keyFiles: topFiles(projectMap, 5),
      keySymbols: [],
      keywords: ['adr', 'architecture', 'decisions', 'design', 'rationale', 'modification', 'suggestions', 'improvements'],
      source: 'kb-init-summary',
      createdAt: new Date().toISOString(),
    });
    log.info('wrote Eden entry: architecture-decisions');
  }
}

/**
 * Generate the three project-wide survey entries that used to be part of
 * /kb init but are now produced by /kb knowledge init as Phase 0 (before
 * the per-topic deep-dive):
 *   - api-docs
 *   - code-walkthrough
 *   - usage-examples
 *
 * Same prompt shapes and entry ids as before so existing references stay valid.
 *
 * @param {string} kbName
 * @param {object} opts    { llm?, streamLLM?, allSymbols, filesIndex?, meta?, onProgress? }
 */
export async function generateSurveyEntries(kbName, opts = {}) {
  const { llm, streamLLM, allSymbols, filesIndex, meta, onProgress } = opts;
  const summaryCb = onProgress;
  if (!llm && !streamLLM) {
    log.info('survey: no LLM available; skipping project-wide survey entries');
    return;
  }

  const callLLM = makeCallLLM(llm, streamLLM);
  const projectMap = buildProjectMap(allSymbols, filesIndex || { byId: {}, byPath: {}, nextId: 1 }, meta || {});

  // 1) api-docs
  if (summaryCb) summaryCb('api-docs');
  const apiText = await callLLM(API_SYS, API_USER(projectMap, allSymbols));
  if (apiText) {
    await writeKnowledge(kbName, 'eden', {
      id: 'api-docs',
      title: 'Public API Reference (auto-generated)',
      intro: apiText,
      keyFiles: topFiles(projectMap, 5),
      keySymbols: topApiSymbols(allSymbols),
      keywords: ['api', 'reference', 'public', 'exported', 'documentation'],
      source: 'kb-knowledge-init-survey',
      createdAt: new Date().toISOString(),
    });
    log.info('wrote Eden entry: api-docs');
  }

  // 2) code-walkthrough
  if (summaryCb) summaryCb('code-walkthrough');
  const walkthroughText = await callLLM(WALKTHROUGH_SYS, WALKTHROUGH_USER(projectMap, allSymbols));
  if (walkthroughText) {
    await writeKnowledge(kbName, 'eden', {
      id: 'code-walkthrough',
      title: 'Code Walkthrough (auto-generated)',
      intro: walkthroughText,
      keyFiles: topFiles(projectMap, 5),
      keySymbols: topApiSymbols(allSymbols),
      keywords: ['walkthrough', 'explanation', 'code', 'core', 'abstraction', 'how it works'],
      source: 'kb-knowledge-init-survey',
      createdAt: new Date().toISOString(),
    });
    log.info('wrote Eden entry: code-walkthrough');
  }

  // 3) usage-examples
  if (summaryCb) summaryCb('usage-examples');
  const examplesText = await callLLM(EXAMPLES_SYS, EXAMPLES_USER(projectMap, allSymbols));
  if (examplesText) {
    await writeKnowledge(kbName, 'eden', {
      id: 'usage-examples',
      title: 'Usage Examples (auto-generated)',
      intro: examplesText,
      keyFiles: topFiles(projectMap, 5),
      keySymbols: topApiSymbols(allSymbols),
      keywords: ['usage', 'example', 'how to', 'quickstart', 'tutorial', 'sample'],
      source: 'kb-knowledge-init-survey',
      createdAt: new Date().toISOString(),
    });
    log.info('wrote Eden entry: usage-examples');
  }
}

async function loadProjectMeta(kbName) {
  const { getMeta } = await import('../store/kb_store.js');
  return await getMeta(kbName);
}

/**
 * Build a compact one-screen project map for the LLM.
 */
function buildProjectMap(allSymbols, filesIndex, meta) {
  const files = Object.values(filesIndex?.byId || {});
  const totalFiles = files.length;
  const totalSymbols = allSymbols.length;

  // Top-level directory breakdown
  const dirs = new Map();
  for (const f of files) {
    const top = (f.path || '').split('/')[0] || '(root)';
    if (!dirs.has(top)) dirs.set(top, { files: 0, symbols: 0 });
    dirs.get(top).files++;
  }
  const dirSummary = Array.from(dirs.entries())
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 12)
    .map(([d, c]) => `${d}/ (${c.files} files)`)
    .join('\n');

  // Language breakdown by extension
  const langs = new Map();
  for (const f of files) {
    const ext = path.extname(f.path || '').slice(1).toLowerCase();
    if (!ext) continue;
    langs.set(ext, (langs.get(ext) || 0) + 1);
  }
  const langSummary = Array.from(langs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, n]) => `.${ext}: ${n} files`)
    .join('\n');

  // Top symbols by kind
  const byKind = new Map();
  for (const s of allSymbols) {
    byKind.set(s.kind, (byKind.get(s.kind) || 0) + 1);
  }
  const kindSummary = Array.from(byKind.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}: ${n}`)
    .join(', ');

  // Sample of top-level symbol names (functions/classes)
  const topLevel = allSymbols
    .filter(s => !s.parentSymbolId)
    .slice(0, 60)
    .map(s => `${s.name} [${s.kind}] (${s.qualName || s.name})`)
    .join('\n');

  return {
    projectName: meta?.projectName || meta?.name || '(unknown)',
    sourcePath: meta?.sourcePath || '',
    sourceRoot: meta?.sourceRoot || '',
    totalFiles,
    totalSymbols,
    dirSummary,
    langSummary,
    kindSummary,
    topLevel,
  };
}

function topFiles(projectMap, n) {
  return projectMap.dirSummary.split('\n').slice(0, n);
}

function topApiSymbols(allSymbols) {
  return allSymbols
    .filter(s => isPublicOrExported(s))
    .slice(0, 12)
    .map(s => s.qualName || s.name);
}

function isPublicOrExported(s) {
  if (!s) return false;
  if (Array.isArray(s.modifiers) && s.modifiers.some(m => ['export', 'public', 'pub'].includes(m))) return true;
  // Go: exported if name starts with uppercase
  if (/^[A-Z]/.test(s.name || '')) return true;
  return false;
}

/**
 * Detect framework / library signals from project config files.
 */
async function detectTechSignals(meta) {
  const out = [];
  if (!meta?.sourcePath) return out;
  const root = meta.sourceRoot ? path.join(meta.sourcePath, meta.sourceRoot) : meta.sourcePath;

  // package.json
  try {
    const pj = path.join(meta.sourcePath, 'package.json');
    if (await exists(pj)) {
      const txt = await fs.readFile(pj, 'utf8');
      const pkg = JSON.parse(txt);
      out.push("Node.js package: " + (pkg.name || "(no name)") + "@" + (pkg.version || "?"));
      if (pkg.dependencies) out.push('dependencies: ' + Object.keys(pkg.dependencies).join(', '));
      if (pkg.devDependencies) out.push('devDependencies: ' + Object.keys(pkg.devDependencies).join(', '));
    }
  } catch {}

  // requirements.txt / pyproject.toml
  try {
    const rt = path.join(meta.sourcePath, 'requirements.txt');
    if (await exists(rt)) {
      const txt = await fs.readFile(rt, 'utf8');
      const lines = txt.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 30);
      out.push('Python requirements:\n' + lines.join('\n'));
    }
  } catch {}

  // go.mod
  try {
    const gm = path.join(meta.sourcePath, 'go.mod');
    if (await exists(gm)) {
      const txt = await fs.readFile(gm, 'utf8');
      out.push('go.mod:\n' + txt.split('\n').slice(0, 30).join('\n'));
    }
  } catch {}

  // Cargo.toml
  try {
    const ct = path.join(meta.sourcePath, 'Cargo.toml');
    if (await exists(ct)) {
      const txt = await fs.readFile(ct, 'utf8');
      out.push('Cargo.toml:\n' + txt.split('\n').slice(0, 40).join('\n'));
    }
  } catch {}

  // Dockerfile
  try {
    for (const cand of ['Dockerfile', 'docker/Dockerfile', path.join(root, 'Dockerfile')]) {
      if (await exists(cand)) {
        const txt = await fs.readFile(cand, 'utf8');
        out.push(`Dockerfile (${cand}):\n` + txt.split('\n').slice(0, 20).join('\n'));
        break;
      }
    }
  } catch {}

  // CI
  try {
    const gh = path.join(meta.sourcePath, '.github', 'workflows');
    if (await exists(gh)) {
      const files = await fs.readdir(gh);
      out.push('GitHub Actions workflows: ' + files.join(', '));
    }
  } catch {}

  return out;
}

/* --- Prompts (English only) --- */

const OVERVIEW_SYS = `You are a senior software architect reviewing a codebase to produce a project overview.
Output prose only. No headers, no markdown formatting, no preamble like "Here is...".
Length: 600-900 words. Focus on:
- What the project does (its purpose, problem domain)
- High-level architecture (modules, layers, key abstractions)
- Notable patterns (dependency injection, plugin systems, state machines, etc.)
- Key modules and their responsibilities
- Anything notable about testing, build, or deployment
Be specific and concrete. Avoid filler.`;

function OVERVIEW_USER(pm) {
  return `Project: ${pm.projectName}
Source: ${pm.sourcePath}${pm.sourceRoot ? ` (root: ${pm.sourceRoot})` : ''}
Files: ${pm.totalFiles}  Symbols: ${pm.totalSymbols}
Symbol kinds: ${pm.kindSummary}

Top-level directories:
${pm.dirSummary}

Language breakdown:
${pm.langSummary}

Sample of top-level symbols:
${pm.topLevel}

Write the project overview now.`;
}

const API_SYS = `You are documenting the public API surface of a codebase.
For each entry, give a 1-3 sentence description covering its signature, purpose, and notable callers/callees if visible.
Output as a numbered list. Be terse and factual. No preamble.
Limit to ~30 entries; pick the most important / public / exported ones.`;

function API_USER(pm, allSymbols) {
  const publics = allSymbols
    .filter(isPublicOrExported)
    .slice(0, 60)
    .map(s => {
      const sig = (s.signature || '').trim().slice(0, 160);
      const fp = s.filePath || '';
      return `- ${s.qualName || s.name}  [${s.kind}]  ${fp}:${s.lineStart}\n    ${sig}`;
    })
    .join('\n');
  return `Project: ${pm.projectName}

Public/exported symbols:
${publics}

Document the most important of these as a numbered API reference.`;
}

/* --- Architecture diagram (Mermaid) --- */

const DIAGRAM_SYS = `You are a software architect producing a Mermaid diagram of a codebase's high-level structure.
Output a single Mermaid flowchart (use \`\`\`mermaid ... \`\`\` fenced block).
Constraints:
- Use \`flowchart TD\` (top-down) or \`flowchart LR\` (left-right).
- Nodes are modules / packages / major subsystems, NOT individual files.
- Edges represent data flow or dependency ("A --> B" means A depends on B).
- Use subgraphs to group related modules into layers (e.g. "API Layer", "Core", "Storage").
- Aim for 8-20 nodes total. Avoid clutter — merge tangential modules.
- After the diagram, add a short legend (3-6 lines) explaining edge types and abbreviations.
No prose preamble. Start with the fenced code block immediately.`;

function DIAGRAM_USER(pm, allSymbols) {
  // Surface the most "central" symbols (those likely representing subsystems)
  const subsystems = allSymbols
    .filter(s => ['class', 'interface', 'struct', 'function'].includes(s.kind))
    .filter(s => !s.parentSymbolId)
    .slice(0, 30)
    .map(s => `- ${s.qualName || s.name} [${s.kind}]  ${s.filePath || ''}:${s.lineStart}`)
    .join('\n');
  return `Project: ${pm.projectName}

Top-level directories:
${pm.dirSummary}

Symbol kinds: ${pm.kindSummary}

Top-level classes / interfaces / functions (potential subsystem anchors):
${subsystems}

Produce the Mermaid architecture diagram now.`;
}

/* --- Code walkthrough (detailed explanation of core abstractions) --- */

const WALKTHROUGH_SYS = `You are a senior engineer onboarding a new team member by walking them through the core of the codebase.
Output 4-8 sections, each focused on ONE core abstraction (class, subsystem, or pivotal function).
Each section should be 80-200 words and cover:
- What problem this abstraction solves
- Its key responsibilities (the methods / fields that matter)
- How it collaborates with other abstractions (callers, callees, dependencies)
- Any non-obvious invariants or gotchas the reader should know

Use Markdown H2 (##) headings for each section. Reference real symbol names and file paths.
No preamble. Start with the first ## heading.`;

function WALKTHROUGH_USER(pm, allSymbols) {
  // Pick the symbols with the highest fan-in+fan-out (most "central")
  const centrality = new Map();
  for (const s of allSymbols) {
    if (!s.id) continue;
    let deg = (s.references?.length || 0);
    // Boost classes and functions with public modifiers
    if (s.kind === 'class' || s.kind === 'interface') deg += 5;
    if (Array.isArray(s.modifiers) && s.modifiers.some(m => ['export', 'public', 'pub'].includes(m))) deg += 2;
    centrality.set(s.id, deg);
  }
  const topIds = Array.from(centrality.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id);
  const list = topIds
    .map(id => {
      const s = allSymbols.find(x => x.id === id);
      if (!s) return null;
      const sig = (s.signature || '').trim().slice(0, 200);
      return `- ${s.qualName || s.name}  [${s.kind}]  ${s.filePath || ''}:${s.lineStart}\n    ${sig}\n    refs: ${(s.references || []).slice(0, 8).join(', ')}`;
    })
    .filter(Boolean)
    .join('\n');
  return `Project: ${pm.projectName}

Most central symbols (by reference count + kind weight):
${list}

Walk the reader through the core abstractions of this codebase.`;
}

/* --- Usage examples --- */

const EXAMPLES_SYS = `You are writing a "Quickstart" guide for a codebase, showing how a new user would accomplish the most common tasks.
Output 3-5 numbered examples. Each example has:
1. A one-sentence goal (what the user is trying to do)
2. A fenced code block showing the API call(s) — use the project's actual public symbols
3. A 1-2 sentence note explaining what the code does and any common pitfalls

Be concrete and syntactically correct. Use the public symbols from the project (not made-up APIs).
No preamble. Start with example 1.`;

function EXAMPLES_USER(pm, allSymbols) {
  const publics = allSymbols
    .filter(isPublicOrExported)
    .filter(s => ['function', 'method', 'class'].includes(s.kind))
    .slice(0, 40)
    .map(s => {
      const sig = (s.signature || '').trim().slice(0, 200);
      return `- ${s.qualName || s.name}  [${s.kind}]  ${s.filePath || ''}:${s.lineStart}\n    ${sig}`;
    })
    .join('\n');
  return `Project: ${pm.projectName}
Source root: ${pm.sourcePath}${pm.sourceRoot ? `/${pm.sourceRoot}` : ''}

Public API surface:
${publics}

Write the usage examples now.`;
}

const ADR_SYS = `You are inferring architectural decisions AND proposing improvements for a codebase.
Output 4-8 sections, each with two parts:
### ADR-N: <decision title>
**Decision:** <1-2 sentence statement of the architectural choice>
**Rationale:** <1-2 sentence reasoning>
**Modification suggestions:** <1-3 concrete, actionable suggestions for how to evolve or improve this decision. Be specific (e.g. "extract X into module Y", "add a Z layer for W"). Avoid generic advice like "add tests".

Focus on: framework/runtime choice, persistence/storage strategy, communication protocols,
deployment topology, testing approach, security model. Skip generic statements like "uses version control".
No preamble.`;

function ADR_USER(pm, techSignals) {
  return `Project: ${pm.projectName}

Detected technology signals:
${techSignals.length > 0 ? techSignals.join('\n\n') : '(no manifest files detected)'}

Project structure:
${pm.dirSummary}

Symbol breakdown:
${pm.kindSummary}

Infer the major architectural decisions and propose concrete modifications now.`;
}
