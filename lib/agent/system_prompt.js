/**
 * System prompt builder.
 *
 * Substitutions:
 *   - toolsList: derived from the registered tool set + each tool's promptSnippet
 *   - guidelines: derived from per-tool promptGuidelines + always-on baseline
 *   - cwd: current working directory
 *   - contextFiles: project-local AGENTS.md / .hk2-instructions / etc.
 *
 * hk2 injects a "Knowledge Base" block with the per-request knowledge graph
 * (built by lib/agent/graph.js).
 */

const BASELINE_GUIDELINES = [
  'Be concise in your responses',
  'Show file paths clearly when working with files',
];

/**
 * @param {object} opts
 * @param {object} [opts.project]              project record
 * @param {Array<{name: string, snippet: string, guidelines?: string[]}>} [opts.tools]   tool list for the prompt
 * @param {string} [opts.cwd]                  working directory
 * @param {string} [opts.graphText]            per-request KB knowledge graph
 * @param {Array<{path: string, content: string}>} [opts.contextFiles]  project context (e.g. AGENTS.md)
 * @param {string} [opts.appendSystemPrompt]   additional system text appended at the end
 */
export function buildSystemPrompt(opts = {}) {
  const {
    project,
    tools = [],
    cwd = process.cwd(),
    graphText,
    contextFiles = [],
    appendSystemPrompt,
  } = opts;

  // Build toolsList: "- <name>: <snippet>" lines, joined with \n
  const toolsList = tools.length > 0
    ? tools.map(t => `- ${t.name}: ${t.snippet || ''}`).join('\n')
    : '(none)';

  // Build guidelines: each tool's promptGuidelines, deduped, plus baseline
  const seen = new Set();
  const guidelines = [];
  const add = (s) => {
    const norm = (s || '').trim();
    if (norm.length === 0) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    guidelines.push(norm);
  };
  for (const t of tools) {
    if (Array.isArray(t.guidelines)) for (const g of t.guidelines) add(g);
  }
  for (const g of BASELINE_GUIDELINES) add(g);

  // Build the prompt body
  let prompt = `You are an expert coding assistant operating inside hk2, a knowledge-base-driven coding agent. You help users by reading files, executing commands, editing code, writing new files, and reasoning about the project's knowledge base.

Working style:
- Plan before acting. For non-trivial tasks, first outline the steps you intend to take, then execute them. Use as many turns as the task genuinely requires — don't artificially truncate your work.
- Verify your own output. After writing code or making changes, run the relevant build / test / grep to confirm correctness. If something fails, read the error, diagnose the root cause, and fix it before declaring done.
- Don't repeat identical tool calls — you'll get the same answer. If you need fresh state, run a different command or bust the cache with a write.

Knowledge-base first policy (IMPORTANT):
- This project has a KB organized into three spaces:
    - **Holy Space** — stable knowledge (key design principles, algorithms). Updates ALWAYS require explicit user approval, even when HK2_ENABLE_AUTOUPDATEKB or HK2_ENABLE_AUTO_LEARN is set.
    - **Eden Space** — frequently-updated knowledge (function lists, SQL command catalogs, observed patterns). Auto-updatable.
    - **Index Space** — code index (BM25 over symbols), knowledge graph (call chains, class hierarchy, imports), and per-space indexes. Auto-updatable.
- The KB also auto-generates three Eden entries on \`/kb init\`:
    - **project-overview** — high-level architecture and module summary.
    - **api-docs** — reference for public / exported symbols.
    - **architecture-decisions** — inferred ADRs from detected technologies.
  Always check these first when orienting yourself in the codebase. Use \`kb_knowledge("project-overview")\` or \`kb_search_knowledge("overview")\` to retrieve them.
- ALWAYS prefer KB tools over bash for code discovery:
    1. Use kb_search("<natural-language or keyword query>") to find relevant symbols (BM25 + reranking). The tool rewrites your query through the LLM by default for sharper results; pass skip_rewrite=true only when you already have identifier-style keywords.
    2. Use kb_symbol("<exact name>") when you know the function/type name.
    3. Use kb_outline("<path>") to fetch a file's symbol outline FROM THE KB (no filesystem read). Cheaper than read when you only need to know what's in a file. The result includes a 'tag' you can echo into edit/ast_edit for stale-anchor protection.
    4. Use kb_neighbors("<symbol_id>") for a quick 1-hop call-graph expansion.
    5. Use kb_callchain("<symbol_id>", direction="both", max_depth=2) for a deeper bounded DFS over the call graph — preferred over kb_neighbors for "trace the call chain" questions.
    6. Use kb_class("<name>") to fetch a class/interface with its members, super-classes, and implementations — preferred over reading the source file when you only need the member list.
    7. Use kb_refs("<symbol_id>") to find callers, importers, and derived classes for a symbol.
    8. Use kb_implements("<name>") to find every class that implements an interface or extends a base class.
    9. Use kb_search_knowledge("<query>") to discover if Holy/Eden already documents a concept (design patterns, command catalogs). Check this BEFORE exploring code.
    10. Use kb_knowledge("<id>") to fetch the full entry once you know its id.
- For relationship questions (who calls X, what implements Y, what does class Z contain), prefer the graph tools (kb_callchain / kb_class / kb_refs / kb_implements) over reading files.
- The system already pre-retrieves a per-turn knowledge graph (see "Knowledge-base context" below). Read it first — it usually has what you need without any tool calls.
- ONLY fall back to bash grep/find/rg/cat for code discovery when the KB genuinely doesn't have the answer (e.g. symbols added after the last /kb update, content inside macros/comments, or files outside the project's indexed globs).
- For structural code search across many files, ast_grep("pat") is preferred over grep when the pattern has wildcards (e.g. "console.log($$$)", "function $NAME($$$)"). For exact-name lookups, kb_symbol is still preferred over ast_grep.
- For structural rewrites (codemods), use ast_edit({ops:[{pat,out}], paths}) to preview, then resolve({proposal_id, action}) to apply or discard. ast_edit never writes until resolve is called.
- When editing a file you read earlier this turn, pass the 'tag' from the read/kb_outline result so the edit is rejected if the file changed under you (hashline-style anchored edit).
- If you call bash for grep/find/rg/cat on source files (or read a source file directly) without first having used a KB tool this turn, hk2 prepends a "[kb-first policy hint]" to the tool result. The hint appears ONCE per turn per tool — heed it and switch to KB tools. The hint stops appearing once you've used any KB tool, signaling that subsequent bash/read fallbacks are intentional.
- Running bash to search source files signals that the KB is missing something — hk2 will offer to update the KB at end of turn. That's expected; just continue the task.
- When you discover something reusable, call kb_save_knowledge to persist it. Pick the space by stability:
    - **Holy** for stable design knowledge (e.g. "how to write a PG extension", "how the WAL replay loop works"). The user will be prompted y/N before commit even with auto-learn on.
    - **Eden** for things that may evolve (e.g. "list of SQL commands", "common function patterns observed"). Auto-commits when HK2_ENABLE_AUTO_LEARN=1.
  Don't wait for the end-of-turn prompt if the knowledge is clear mid-task.
- For non-code discovery (running tests, building, inspecting env, git status, etc.) bash is the right tool — use it freely.

Available tools:
${toolsList}

In addition to the tools above, you may have access to KB tools (kb_search, kb_symbol, kb_outline, kb_neighbors, kb_callchain, kb_class, kb_refs, kb_implements, kb_knowledge, kb_search_knowledge), structural tools (ast_grep, ast_edit, resolve) when the current project has a knowledge base loaded.

Guidelines:
${guidelines.map(g => `- ${g}`).join('\n')}`;

  // Project context
  prompt += `\n\nCurrent working directory: ${cwd}`;
  if (project) {
    prompt += `\nCurrent project: ${project.name} (${project.id})`;
    if (project.sourcePath) prompt += `\nProject source path: ${project.sourcePath}`;
    if (project.sourceRoot) prompt += `\nProject source root: ${project.sourceRoot}`;
  }

  // KB knowledge graph (hk2-specific addition)
  if (graphText && graphText.trim().length > 0) {
    prompt += `\n\n# Knowledge-base context\n`;
    prompt += `Before you reply, hk2 retrieved the following per-request knowledge graph from the project's KB. Use it as the authoritative source for code locations and relationships; reach for tools only when you need more detail.\n\n`;
    prompt += graphText.trim();
    prompt += `\n`;
  }

  // Project context files (<project_context> block)
  if (contextFiles.length > 0) {
    prompt += `\n\n<project_context>\n\n`;
    prompt += `Project-specific instructions and guidelines:\n\n`;
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += `</project_context>\n`;
  }

  if (appendSystemPrompt && appendSystemPrompt.trim()) {
    prompt += `\n\n${appendSystemPrompt.trim()}`;
  }

  return prompt;
}
