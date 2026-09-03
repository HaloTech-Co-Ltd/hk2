# Quick start

English | [简体中文](../../zh-CN/getting-started/quick-start.md)

This page walks through a complete first session: install, configure a model,
register a project, build its knowledge base, and ask your first questions.
Every command here is available in the shipped hk2 — follow it top to bottom
and you will have a working KB-driven agent.

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

```
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel
```

If you use Claude Code, `hk2 --tui` can skip this step entirely: on first run
with no model configured it imports one from Claude Code's
`~/.claude/settings.json`. See
[REPL and TUI](../guides/repl-and-tui.md#zero-setup-first-run) for details.

`/model list` shows the registry; `/model show` shows the resolved default.

## 3. Register a project

```
/project init --name=myapp --source=/path/to/repo --source-root=src
```

`--source-root` restricts indexing to a subdirectory (e.g. `src`); omit it to
index the whole tree. `--name` defaults to the directory name.

## 4. Build the knowledge base

```
/kb init
```

This parses every indexed source file (Tree-sitter AST, regex fallback where
unavailable), builds the BM25 symbol index and the code knowledge graph, and
asks an LLM to write three summary entries into Eden Space. Builds are
checkpointed and resumable — if interrupted, re-running continues from the
checkpoint.

## 5. Deep-study the project

```
/kb knowledge learn
```

The unified deep-study command: it surveys the codebase, plans topics, and
writes topic-specific knowledge entries. Scope it to a subdirectory with
`--base-dir=src/storage`, or deep-study documents instead:

```
/kb knowledge learn --space=eden --file=docs/spec.pdf
```

## 6. Ask a question

```
How does login verify the password?
```

Plain text is a message to the agent. hk2 retrieves related symbols, call
chains, and knowledge entries from the KB, injects them as context, and the
agent answers using tools as needed.

## 7. Query the KB explicitly

```
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

## 8. Switch projects or resume a session

```
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
