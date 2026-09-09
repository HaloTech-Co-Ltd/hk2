# Quick start

English | [简体中文](../../zh-CN/getting-started/quick-start.md)

This page walks through a complete first session: install, configure a model,
register a project, build its knowledge base, and ask your first questions.
The commands below follow the current implementation. Replace example model
settings and paths with a reachable provider and an existing project.

## 1. Install and launch

```bash
./install.sh        # from the repo root (see Installation)
hk2                 # enter the interactive REPL
```

The default front-end is the line REPL. `hk2 --tui` starts the Claude
Code-style inline TUI instead (it needs a TTY terminal; anything less falls
back to the REPL automatically).

## 2. Configure a model (or import one)

Add a model with `/model add` (see
[Models, projects, and sessions](../guides/models-projects-and-sessions.md)
for all flags):

```text
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel
```

`hk2 --tui` can import model configuration from Claude Code's
`~/.claude/settings.json` when neither a default model nor a `claude` provider exists,
auto-import is enabled, and the file supplies an Anthropic endpoint and key.
If these conditions are not met, configure a model manually. See
[REPL and TUI](../guides/repl-and-tui.md#zero-setup-first-run) for details.

`/model list` shows the registry; `/model show` shows the resolved default.

## 3. Register a project

```text
/project init --name=myapp --source=/path/to/repo --source-root=src
```

`--source-root` restricts indexing to a subdirectory (e.g. `src`); omit it to
index the whole tree. `--name` defaults to the directory name.

## 4. Build the knowledge base

```text
/kb init
```

This parses indexed source files (Tree-sitter AST, with regex fallback for
supported languages; C# has no fallback) and builds the BM25 symbol index and
the code knowledge graph.
When a model is configured (step 2) and `--skip-summary` is not passed, it
also attempts three Eden summaries, saving each non-empty successful result
independently. Builds are checkpointed: after an interruption, re-running
resumes from the latest saved checkpoint, if one exists.

## 5. Deep-study the project (optional)

You can skip to step 6 and ask questions immediately after building the KB.
Deep-study adds reusable knowledge entries and requires additional model
calls; the time and usage depend on project size.

```text
/kb knowledge learn
```

The unified deep-study command: it surveys the codebase, plans topics, and
writes topic-specific knowledge entries. Scope it to a subdirectory with
`--base-dir=src/storage`, or deep-study documents instead:

```text
/kb knowledge learn --space=eden --file=docs/spec.pdf
```

## 6. Ask a question

```text
How does login verify the password?
```

Plain text is a message to the agent. The agent can combine session context,
retrieved knowledge-base context, and source-code tools when answering project
questions. See [Agent workflow](../concepts/agent-workflow.md) for the detailed
request flow.

## 7. Query the KB explicitly

```text
/kb search password verification
/kb symbol login
/kb neighbors 12:345
/kb knowledge list
/kb knowledge show spi-extension-pattern
```

- `/kb search` — BM25 + reranking symbol search
- `/kb symbol` — exact-name symbol lookup
- `/kb neighbors <fileId>:<line>` — call-graph neighbors of a symbol id
- `/kb knowledge list` / `show` — browse Holy and Eden knowledge entries

The symbol name, symbol ID, and knowledge-entry ID above are examples; use
values returned by searches and listings in your own project.

## 8. Switch projects or resume a session

```text
/model use local/mymodel           # this session only
/project list
/project set current otherapp      # switch (session saved under old project)
/session list
/session resume                    # latest previous session
/quit
```

From the shell: `hk2 --project=otherapp`, `hk2 --resume`, or
`hk2 --project=otherapp --resume`.

## Next steps

- [Knowledge base](../concepts/knowledge-base.md) — the three-space model and Project Supreme Code
- [Knowledge workflows](../guides/knowledge-workflows.md) — day-2 workflows: update, learn, housekeep
- [Slash commands](../reference/slash-commands.md) — the full command reference
