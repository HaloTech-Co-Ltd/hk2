/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------*/

/**
 * Centralized per-command help text for the slash command system.
 *
 * This module is the single source of truth for detailed usage. It backs:
 *   - `/help`               → one-line command index (from SLASH_COMMANDS descriptions)
 *   - `/help <command>`     → full usage + flags + examples for one command
 *   - `<command> help`      → same full text, reachable from each family
 *   - `<command>` (no args) → same full text via each family's default branch
 *
 * Each entry in HELP_TEXT maps a command name (without the leading slash)
 * to an array of lines. Keep the lines in this style:
 *   - one "Usage:" block listing every subcommand and flag
 *   - a "Flags:" block when flags exist
 *   - a short "Examples:" block
 *   - a trailing hint pointing to deeper help (e.g. `/kb help knowledge`)
 *
 * Help text that must stay in sync with runtime data (phase names) is
 * generated dynamically via functions (see `renderHelp`). For discoverable
 * enums with a dedicated listing command (model types), help points at
 * `/model types` instead of inlining the list.
 */
import { supportedPhaseNames } from '../../lib/config/home.js';

/** @type {Record<string, string[]>} */
export const HELP_TEXT = {
  model: [
    `Usage: /model <subcommand> [args]`,
    `Manage ~/.hk2/models.json — the multi-provider model registry.`,
    ``,
    `Subcommands:`,
    `  list                                              List all providers / models (default marked with *)`,
    `  use <provider>/<model-id>                         Switch model for THIS session only (not persisted)`,
    `  set-default <provider>/<model-id>                 Set the global default model (persisted)`,
    `  set-default current <provider>/<model-id>        Set the CURRENT project's default model`,
    `                                                   (overrides the global default; --clear removes it)`,
    `  set <provider>/<model-id> [--flags]               Modify a model's persisted settings`,
    `  set-phase --phase=<name> <provider>/<model-id>    Per-project model for one pipeline phase`,
    `  add <provider> <model-id> [--flags]               Add a new model (creates provider if needed)`,
    `  add-mcpserver <provider>/<model-id> --type=<t> --name=<n> [--options=JSON]`,
    `                                                   Attach an MCP server to an existing model`,
    `  del <provider>/<model-id>                         Delete a model`,
    `  types                                             List all supported --model-type values`,
    `  show                                              Show the current default model`,
    ``,
    `Flags (set / add):`,
    `  --api=openai|anthropic                            Provider API dialect (provider-level)`,
    `  --base-url=URL                                    API endpoint base URL (provider-level)`,
    `  --api-key=KEY                                     API key (provider-level)`,
    `  --name=NAME                                       Wire model code sent to the API`,
    `  --id=NEW_ID                                       (set only) Rename the model id / ref key`,
    `  --reasoning=on|off                                Reasoning on/off`,
    `  --context-window=N                                Context window size (tokens)`,
    `  --max-tokens=N                                    Max output tokens`,
    `  --temperature=N                                   Sampling temperature`,
    `  --model-type=TYPE                                 Model family (see /model types)`,
    `  --model-options=JSON                              Model-specific options, e.g. '{"enable_thinking":true}'`,
    ``,
    `Flags (set-phase):`,
    `  --phase=<name>            Phase: ${supportedPhaseNames().join(' | ')}`,
    `  --clear                   Clear the phase override`,
    ``,
    `Flags (add-mcpserver) — attach a Model Context Protocol server to a model:`,
    `  --type=http|stdio         MCP server service type (http implemented; stdio reserved)`,
    `  --name=NAME               MCP server name (unique per model; re-adding replaces it)`,
    `  --options=JSON            Type-specific options. http supports:`,
    `                              {"url":"...","headers":{"Authorization":"Bearer $APIKEY"}}`,
    `                            $APIKEY = the provider's --api-key (substituted at use time;`,
    `                            the stored config keeps the placeholder, never the key)`,
    ``,
    `Examples:`,
    `  /model list`,
    `  /model add openai-local gpt-4o --api=openai --base-url=http://... --api-key=sk-... --context-window=128000 --model-type=gpt-5.6-sol`,
    `  /model add bigmodel glm-5.3 --model-type=glm-5.3 --model-options='{"reasoning_effort":"max"}'`,
    `  /model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader --options='{"url":"https://open.bigmodel.cn/api/mcp/web_reader/mcp","headers":{"Authorization":"Bearer $APIKEY"}}'`,
    `  /model use openai-local/gpt-4o                        (this session only)`,
    `  /model set-default openai-local/gpt-4o                (global default, persisted)`,
    `  /model set-default current openai-local/gpt-4o        (project default for the current project)`,
    `  /model set-default current --clear                    (clear the project default override)`,
    `  /model set openai-local/gpt-4o --temperature=0.5 --max-tokens=8192`,
    `  /model set openai-local/gpt-4o --id=gpt-4o-new        (rename the ref key)`,
    `  /model set-phase --phase=rewrite-query openai-local/gpt-4o`,
    `  /model del openai-local/gpt-4o`,
    ``,
    `Details: /model types   (all supported model types)`,
  ],
  project: [
    `Usage: /project <subcommand> [args]`,
    `Manage ~/.hk2/projects.json — the project registry.`,
    ``,
    `Subcommands:`,
    `  init [--name=<name>] --source=<path> [--source-root=<rel>] [--include=...] [--exclude=...] [--extra=<name>:<rel>,...]`,
    `                                       Register a new project (generates UUID)`,
    `  list                                 List all registered projects (current marked with *)`,
    `  set current <id|name>                Switch the current project`,
    `  set name <new-name>                  Rename the current project`,
    `  set source <path>                    Update the source path`,
    `  set source-root <rel-path>           Update the indexed sub-root`,
    `  set include <glob1,glob2,...>        Replace the include glob set`,
    `  set exclude <glob1,glob2,...>        Replace the exclude glob set`,
    `  show                                 Show the current project's settings`,
    `  drop <id|name>                       Remove a project's registration (no confirmation;`,
    `                                       KB dir stays under the old UUID and is NOT`,
    `                                       reattached by re-registering the same path)`,
    ``,
    `Flags (init):`,
    `  --name=<name>            Project display name (defaults to directory name)`,
    `  --source=<path>          (required) Absolute or relative source path`,
    `  --source-root=<rel>      Indexed sub-directory (e.g. src); default = whole tree`,
    `  --include=<globs>        Comma-separated include globs (REPLACES the default set)`,
    `  --exclude=<globs>        Comma-separated exclude globs (REPLACES the default set)`,
    `  --extra=<name>:<rel>,... Named extra roots, e.g. docs:docs,spec:spec`,
    ``,
    `Examples:`,
    `  /project init --name=myapp --source=/path/to/repo --source-root=src`,
    `  /project init --source=. --include=**/*.sql --exclude=vendor/**`,
    `  /project list`,
    `  /project set current <id|name>`,
    `  /project show`,
    `  /project drop myapp`,
  ],
  kb: [
    `Usage: /kb <subcommand> [args]`,
    `Lifecycle and queries for the current project's knowledge base.`,
    ``,
    `Three-space model:`,
    `  Holy Space   stable knowledge (design principles); updates need approval`,
    `  Eden Space   frequently-updated knowledge; auto-updatable`,
    `  Index Space  code index + callgraph; auto-updatable`,
    ``,
    `Subcommands:`,
    `  init [--full] [--checkpoint-interval=N] [--no-checkpoint] [--no-resume] [--skip-summary]`,
    `                          Build the KB (full re-index, with checkpointing)`,
    `  update                  Incremental update (sha256 diff) — Index Space only`,
    `  status                  Show per-space statistics`,
    `  search <query> [--top-k=N]   BM25 symbol search`,
    `  symbol <name>           Look up symbols by exact name`,
    `  neighbors <symbol_id>   Call-graph neighbors (symbol_id looks like <fileId>:<line>)`,
    `  knowledge <sub> [...]   Manage knowledge entries — see /kb help knowledge`,
    `  code <sub> [...]         Manage the permanent Supreme Code — /kb help code`,
    `  transform <id> <from> <to>   Move entry between holy/eden (confirm required)`,
    `  drop                    Delete the whole KB (confirm required)`,
    ``,
    `Examples:`,
    `  /kb init`,
    `  /kb init --skip-summary            (skip LLM-generated summary entries)`,
    `  /kb update`,
    `  /kb status`,
    `  /kb search tokenize --top-k=5`,
    `  /kb symbol parsePlanText`,
    `  /kb neighbors 80:78`,
    `  /kb knowledge learn --dry-run`,
    `  /kb code add --code-content="API keys are strictly forbidden in any code file"`,
    `  /kb code del 2`,
    `  /kb transform sql-commands eden holy`,
    ``,
    `All commands operate on the current project (/project set current).`,
    `Knowledge entry management: /kb help knowledge`,
  ],
  knowledge: [
    `Usage: /kb knowledge <subcommand> [args]`,
    `Manage knowledge entries (Holy + Eden spaces) for the current project.`,
    ``,
    `Subcommands:`,
    `  list [--space=holy|eden]                 List entries (both spaces by default)`,
    `  show <id>                                Show a full entry (searches both spaces)`,
    `  add [--space=holy|eden] --title=<t> [--id=<id>] (--intro=<text> | --intro-file=<path>)`,
    `        [--key-files=<a,b>] [--key-symbols=<a,b>] [--keywords=<a,b>]`,
    `                                           Manually persist an entry (default holy)`,
    `  learn [--space=eden|holy] [--file=<path>] [--base-dir=<dir>] [--per-batch-chars=N]`,
    `        [--dry-run] [--no-survey] [--model=<provider>/<model-id>]`,
    `        [--plan-timeout-ms=N] [instructions...]`,
    `                                           LLM deep-study (DOC or CODE mode) — details below`,
    `  housekeep <eden|holy|all> [--model=<provider>/<model-id>]`,
    `        LLM-assisted: broken-entry scan, duplicate/similar merge`,
    `        (y/N), Eden↔Holy conflict resolution (all mode, per-pair choice).`,
    `        Always confirms; supreme-code never touched; indexes rebuilt.`,
    `  empty <eden|holy|all>                    Bulk delete entries in a space (always confirms y/N)`,
    `  export <eden|holy|all> <path>            Dump entries to JSON (with space tags)`,
    `  import <path> [eden|holy|adaptive] [--overwrite]   Import entries from JSON`,
    `  del <id>                                 Delete one entry (confirm required)`,
    ``,
    `learn — the unified deep-study command (two modes, auto-selected):`,
    `  DOC mode   (--file / --base-dir pointing at documents):`,
    `      deep-study Markdown / PDF / Word / PowerPoint / text files and write`,
    `      extracted entries to the chosen space. Files may live outside the project.`,
    `  CODE mode  (no --file/--base-dir, or --base-dir = an indexed subdirectory):`,
    `      deep-study the project's indexed source. Phase 0 generates project-wide`,
    `      survey entries, Phase 1 plans topic batches, Phase 2 extracts entries.`,
    ``,
    `learn flags:`,
    `  --space=eden|holy        Target space (default eden). CODE mode always targets eden.`,
    `                           Holy writes require interactive confirmation.`,
    `  --file=<path>            Learn a single document (DOC mode).`,
    `  --base-dir=<dir>         Learn every supported file under a directory (DOC mode),`,
    `                           or restrict the CODE-mode study to an indexed subdirectory.`,
    `  --per-batch-chars=N      LLM context budget per batch (default 100000).`,
    `  --dry-run                Show proposed entries without writing.`,
    `  --no-survey              CODE mode: skip Phase 0 survey entries.`,
    `  --model=<provider>/<id>  Drive ALL learn LLM calls with this registry model`,
    `                           (default: the current session model).`,
    `  --plan-timeout-ms=N      Phase 1 planning timeout in ms (default 300000;`,
    `                           env equivalent HK2_PLAN_TIMEOUT_MS).`,
    `  trailing tokens          Free-form instructions passed to every LLM prompt.`,
    ``,
    `Validation: every proposed entry is checked against the existing KB`,
    `before writing (duplicate → skipped with reason; related entry → merged in`,
    `place; conflict → Holy entries always ask y/N, Eden follows the verdict;`,
    `new → written with the reason it is not an update). Disable with`,
    `HK2_KB_LEARN_VALIDATE=0 (legacy heuristic discard).`,
    ``,
    `Examples:`,
    `  /kb knowledge learn                              (whole-project CODE mode)`,
    `  /kb knowledge learn --dry-run                    (preview only)`,
    `  /kb knowledge learn --file=docs/architecture.md  (DOC mode, single file)`,
    `  /kb knowledge learn --base-dir=src/retrieval --no-survey`,
    `  /kb knowledge learn --plan-timeout-ms=600000        (raise the planning timeout)`,
    `  /kb knowledge learn --model=openai/gpt-4o       (use a specific model)`,
    `  /kb knowledge learn focus on error handling      (trailing instructions)`,
    `  /kb knowledge add --title="SPI Pattern" --intro="Use PGXS; ..."`,
    `  /kb knowledge add --space=eden --id=sql-cmds --title="SQL Commands" \\\\`,
    `                     --intro-file=/tmp/sql.md --keywords=sql,commands`,
    `  /kb knowledge list --space=eden`,
    `  /kb knowledge show sql-cmds`,
    `  /kb knowledge export all /tmp/kb-dump.json`,
    `  /kb knowledge import /tmp/kb-dump.json adaptive --overwrite`,
    `  /kb knowledge housekeep all`,
    `  /kb knowledge del sql-cmds`,
    ``,
    `Aliases: ls=list, get=show, create/set=add, study/init/bootstrap/scan=learn,`,
    `         housekeeping/cleanup/clean=housekeep, clear/wipe=empty, rm=del`,
    ``,
    `The supreme-code entry ("hk2-supreme-code") can NOT be deleted, renamed,`,
    `moved, or imported over — see /kb help code.`,
  ],
  code: [
    `Usage: /kb code <subcommand> [args]`,
    `Manage the project's Supreme Code — the permanent Holy entry`,
    `"hk2-supreme-code" holding the fundamental laws EVERY hk2 operation in`,
    `this project must obey. The entry itself can never be deleted, renamed,`,
    `moved, or auto-updated; its items are changed ONLY here, each write`,
    `requires an explicit y/N confirmation.`,
    ``,
    `Limits: max 100 items, 200 characters each, numbered 1..N with no gaps.`,
    `Keep items short and imperative; genuinely complex rules belong in their`,
    `own Holy entry, referenced as **KB(entry-id)** from a code item.`,
    ``,
    `Subcommands:`,
    `  list                                                Show all items`,
    `  add [code-id] (--code-content=<text> | --code-gen=<instructions>)`,
    `        [--model=<provider>/<model-id>]               Add or update one item`,
    `  del <code-id>                                       Delete; later items shift up`,
    ``,
    `add semantics (code-id is optional, 1..N):`,
    `  omitted    append as item N+1`,
    `  id ≤ N     update that item in place`,
    `  id > N+1   rejected (numbering must stay gapless)`,
    ``,
    `Flags (add):`,
    `  --code-content=<text>   full item text, written verbatim (whitespace`,
    `                          collapsed; limit-checked before the prompt)`,
    `  --code-gen=<instructions>  ask a model to draft ONE item from these`,
    `                          instructions; output is sanitized (fences /`,
    `                          numbering / quotes stripped), limit-checked,`,
    `                          then confirmed before writing`,
    `  --model=<provider>/<model-id>  model used for --code-gen (default:`,
    `                          the current session model)`,
    ``,
    `Examples:`,
    `  /kb code list`,
    `  /kb code add --code-content="API keys are strictly forbidden in any code file"`,
    `  /kb code add 1 --code-content="Coding style must strictly follow **KB(project-code-format)**"`,
    `  /kb code add --code-gen="draft one rule about commit message format"`,
    `  /kb code del 2`,
  ],
  session: [
    `Usage: /session <subcommand> [args]`,
    `Session management. Sessions are stored as JSONL at`,
    `~/.hk2/sessions/<projectId>/<sessionId>.jsonl.`,
    ``,
    `Subcommands:`,
    `  info [<sessionId>]  Show session info — current session with no id, or`,
    `                      the stored session's stats for an id (unique prefix`,
    `                      match supported)`,
    `  list [--limit=N]    List recent sessions for the current project (default 20)`,
    `  new                 Start a new session (fresh transcript)`,
    `  resume [<sessionId>]  Resume a previous session (full context restored);`,
    `                      with no id, the project's latest previous session`,
    `  compact             Manually compact the conversation (same as /compact)`,
    ``,
    `Examples:`,
    `  /session info`,
    `  /session info 3f9c1a2e`,
    `  /session list --limit=5`,
    `  /session new`,
    `  /session resume`,
    `  /session resume 3f9c1a2e`,
  ],
  resume: [
    `Usage: /resume [<sessionId>]`,
    `Reopen a previous session's transcript and restore the full conversation`,
    `context (messages, tool-call history, interrupted-task state).`,
    ``,
    `With no id: resumes the project's LATEST previous session.`,
    `With an id (from /session list or the exit hint): resumes that session.`,
    `Equivalent to /session resume — Claude Code's convention.`,
  ],
  clear: [
    `Usage: /clear`,
    `Clear the current in-memory conversation context (the LLM sees a fresh`,
    `history). The session transcript on disk is preserved; use /session list`,
    `to browse past sessions and /session resume <id> to reopen one.`,
  ],
  review: [
    `Usage: /review <phase> [--model=<provider>/<model-id>]`,
    `Manually review the just-completed task in this conversation.`,
    ``,
    `Phases:`,
    `  code    Manual code review of the completed task (implemented)`,
    `  plan    Manual plan review (not implemented yet)`,
    ``,
    `Flags:`,
    `  --model=<provider>/<model-id>   Review with this specific model`,
    `                                  (default: the phase-configured model`,
    `                                   /model set-phase --phase=code-review,`,
    `                                   then the current session model)`,
    ``,
    `How /review code works: only the original task request and the completed`,
    `result (final answer + changed files + working-tree diff) are sent to the`,
    `review model - the task's implementation context is ignored, so it cannot`,
    `influence or pollute the review (fresh-eyes regression check).`,
    ``,
    `The reviewer's analysis streams live while it works: requirement`,
    `re-analysis, per-point coverage check, correctness check, and conclusion.`,
    `Only the machine-readable verdict JSON is never shown raw; an unparseable`,
    `reply is reported as UNKNOWN, never as "no issues found".`,
    ``,
    `Examples:`,
    `  /review code`,
    `  /review code --model=openai-local/gpt-4o`,
  ],
  theme: [
    `Usage: /theme <subcommand> [args]`,
    `Customize tool-card border/title colors (~/.hk2/theme.json).`,
    ``,
    `Subcommands:`,
    `  list                   List current colors vs built-in defaults (default)`,
    `  set <key> <color>      Set and persist a color`,
    `  reset [key]            Drop one key, or the whole file with no arg`,
    `  preview                Print sample cards for the three built-in groups`,
    `  title-follow [on|off]  Toggle the top-border title following the frame`,
    `                         color instead of the fixed muted hue`,
    ``,
    `Keys (resolution priority: exact tool name > group key > * > built-in):`,
    `  bash                Exact name of the bash tool`,
    `  kb_*                Group key: any tool whose name starts with kb_`,
    `  *                   Wildcard: any other tool`,
    `  <exact tool name>   e.g. read, write, edit, grep`,
    ``,
    `Colors:`,
    `  #rrggbb             Truecolor hex, e.g. #ff8800`,
    `  ansi:0-255          256-color palette, e.g. ansi:208`,
    `  <token>             Built-in token: accent muted dim success error`,
    `                      warning border bashMode pythonMode`,
    ``,
    `Examples:`,
    `  /theme`,
    `  /theme set bash #ff8800`,
    `  /theme set kb_* accent`,
    `  /theme set read ansi:208`,
    `  /theme reset bash`,
    `  /theme reset`,
    `  /theme preview`,
    `  /theme title-follow on`,
  ],
  compact: [
    `Usage: /compact`,
    `Summarize the prior conversation into a short brief and continue with it`,
    `in place of the full history — frees context space on long sessions.`,
    `Equivalent to /session compact.`,
  ],
  quit: [
    `Usage: /quit`,
    `Exit the REPL. Same as Ctrl+D. /exit is an alias.`,
  ],
};

/**
 * Render the full help text for one command.
 * @param {string} name command name without the leading slash (e.g. 'kb', 'knowledge')
 * @returns {string[] | null} help lines, or null when unknown
 */
export function renderHelp(name) {
  const key = String(name || '').replace(/^\//, '').toLowerCase();
  return HELP_TEXT[key] ? HELP_TEXT[key].slice() : null;
}

/**
 * Print the full help for one command via ctx.print.
 * @returns {boolean} true when the command was found and printed
 */
export function printCommandHelp(ctx, name) {
  const lines = renderHelp(name);
  if (!lines) return false;
  for (const line of lines) ctx.print(line);
  return true;
}

/**
 * Extract the usage block for ONE subcommand of a command family.
 *
 * Subcommand entries in HELP_TEXT are lines indented by exactly two spaces
 * ("  set <provider>/<model-id> ..."); wrapped continuation lines are indented
 * deeper. The block for a topic runs from its entry line until the next entry
 * line, a blank line, or a section header (any non-indented line).
 *
 * @param {string} name family name, e.g. 'model' or 'knowledge'
 * @param {string} topic subcommand name, matched as an exact first token
 * @returns {string[] | null} ['Usage:', ...entry lines] or null when unknown
 */
export function subcommandHelp(name, topic) {
  const key = String(name || '').replace(/^\//, '').toLowerCase();
  const lines = HELP_TEXT[key];
  if (!lines || !topic) return null;
  const isEntry = (l) => /^ {2}\S/.test(l);
  const firstWord = (l) => l.trim().split(/\s+/)[0];
  const start = lines.findIndex(l => isEntry(l) && firstWord(l) === String(topic));
  if (start < 0) return null;
  const out = ['Usage:'];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (i > start && (l === '' || !/^ /.test(l))) break;            // blank / section header
    if (i > start && isEntry(l) && firstWord(l) !== String(topic)) break; // next entry
    out.push(l);
  }
  // Append related detail sections: any section header (non-indented line
  // like 'Flags (set / add):' or 'learn flags:') whose words contain the
  // topic exactly (punctuation-stripped), plus its contiguous indented body.
  // This is what makes '/model help set' show the flag table and
  // '/kb knowledge help learn' show the DOC/CODE mode notes + learn flags.
  const norm = (w) => w.replace(/^[(:;,]+|[):;,]+$/g, '');
  const headerHasTopic = (l) => l.split(/\s+/).some(w => norm(w) === String(topic));
  const isHeader = (l) => l !== '' && !/^ /.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!isHeader(l) || !headerHasTopic(l)) continue;
    out.push('', l);
    for (let j = i + 1; j < lines.length && /^ /.test(lines[j]); j++) out.push(lines[j]);
  }
  return out;
}
