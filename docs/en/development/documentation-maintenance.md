# Documentation maintenance

English | [简体中文](../../zh-CN/development/documentation-maintenance.md)

How hk2's documentation is organized, the bilingual parity rules, and the
code sources of truth each page must be checked against. Read this before
adding, moving, or deleting any documentation page.

## Layout

- `README.md` — English project homepage: positioning, install, quick
  start, documentation navigation. Not a manual.
- `README_zh.md` — the Chinese homepage, same information scope as the
  English one.
- `docs/README.md` — language picker only.
- `docs/en/**` and `docs/zh-CN/**` — the documentation tree. The two
  directories are **path-isomorphic**: every `docs/en/<path>.md` has a
  `docs/zh-CN/<path>.md` counterpart with the same relative path, the same
  section coverage, the same tables and command examples.
- File names are English lower-kebab-case; Chinese pages never get Chinese
  file names or `.zh.md` suffixes.

Sections: `getting-started/`, `concepts/`, `guides/`, `reference/`,
`development/`.

## Bilingual parity rules

1. **Same paths** — `docs/en` and `docs/zh-CN` must contain exactly the same
   set of relative paths. `npm run docs:check` fails otherwise.
2. **Same scope** — sections, tables, warnings, and command examples
   correspond one-to-one. Neither language may be a summary of the other.
3. **Language switch** — every page carries, directly under its H1:
   `English | [简体中文](<relative link>)` (on English pages) or
   `[English](<relative link>) | 简体中文` (on Chinese pages), with the
   relative path computed from the page's own directory.
4. **Commands are not localized** — command names, flags, file paths, JSON
   keys, environment variables, and tool names stay verbatim in both
   languages. Comments, example questions, and explanations may be
   localized.
5. **Terminology** — Chinese pages use the agreed glossary (智能体, 知识库,
   知识图谱, 提供商, 推理, 回退, 检查点, 会话记录, 工具调用, 请求评估,
   查询改写, 计划审查, 代码审查); product names stay English with the
   Chinese gloss on first mention (Holy Space（稳定知识空间）etc.). Do not
   mix 代理 / Agent / 智能体.

## Adding a page

1. Write the English page at `docs/en/<section>/<name>.md`.
2. Create the Chinese counterpart at `docs/zh-CN/<section>/<name>.md` in
   the same change — never leave one language without the other.
3. Add the language-switch link under the H1 of both pages.
4. Link the page from `docs/en/README.md` and `docs/zh-CN/README.md`
   indexes, and from related pages' "Related documentation" sections.
5. Run `npm run docs:check`.

## Moving or deleting a page

1. Move/delete **both** language versions together.
2. Update every link that pointed at the old path (grep the repo —
   `docs:check` catches broken local links, but not redirected intent).
3. Update the indexes and any "Related documentation" references.
4. Run `npm run docs:check`.

## Documentation ↔ code sources of truth

| Documentation area | Primary source |
|---|---|
| Slash commands | `src/slash/help.js`, `src/slash/*.js` |
| CLI flags | `src/cli.js` |
| Runtime system prompt claims | `lib/agent/system_prompt.js` |
| Agent tools | `lib/agent/tools.js`, related agent modules |
| Status bar and plan progress | `src/commands/status_format.js` |
| Session facts | `lib/agent/session_facts.js` |
| Interrupted task state | `lib/agent/task_state.js` |
| Document graph / doc index | `lib/index/doc_graph.js`, `lib/store/doc_index_store.js` |
| Filesystem permissions | `lib/config/setting.js`, `setting.example.json` |
| Model configuration | `lib/config/home.js`, `src/slash/model.js`, `lib/llm/*` |
| Environment variables | Code-wide `process.env` search (`rg -n "process\.env\|HK2_[A-Z0-9_]+" src lib bin install.sh`) |
| Language support | `package.json`, `lib/parser/*` |
| Install behavior | `install.sh`, `lib/config/home.js` |
| Agent pipeline | `src/commands/turn.js`, `src/commands/turn_support.js`, `lib/agent/*` |
| Tests | `package.json`, `test/**/*.test.js` |

When code and docs disagree, fix the docs to match the code — and note the
correction in your change description.

## Keeping the root READMEs lean

The root READMEs are homepages, not manuals. They keep: positioning, the
capability highlights, requirements, the shortest install, a 5-minute quick
start, one example, documentation navigation, and license. They do **not**
keep: full command tables, tool tables, environment-variable tables, config
schemas, TUI key tables, permission internals, or the source tree. Link to
the detail pages instead. If a section feels like reference material, it
belongs in `docs/`.

## The checker

`npm run docs:check` runs `scripts/check-docs.mjs` (Node stdlib only), which
verifies:

- `docs/en` and `docs/zh-CN` contain the same relative paths;
- every page pair links to each other (language switch);
- every page has exactly one H1, the language switch is in the first block
  after it, and heading levels do not skip;
- each page pair has the same ordered heading-level sequence, table count and
  column/row signatures, and fenced-code language sequence;
- local Markdown links and images in `README.md`, `README_zh.md`, and
  every file under `docs/` resolve to real files;
- every fenced code block (backtick or tilde fences, any length ≥ 3)
  carries a language tag, and no fence is left unclosed;
- quality gates: no unfilled repository-URL placeholders and no
  unfinished-work markers anywhere in docs (raw text, including code
  examples), the root READMEs link to each other, to their language's docs
  index, and `docs/README.md` links both language indexes.

The checker enforces path, link, fence, and structural parity. It cannot prove
that translated prose makes the same factual claims; semantic parity remains a
review responsibility.

All problems are reported before a non-zero exit — fix everything it lists.

## Content rules

- One H1 per page; heading levels step without gaps; code blocks carry a
  language tag (`bash`, `json`, `text`, `mermaid`).
- No absolute local links; relative paths only, written to the `.md` file.
- No unfinished-work markers or placeholder sections in committed docs.
- No unverifiable claims: no invented performance numbers, no "supports
  everything", no "completely safe". Best-effort mechanisms are labeled as
  such.
- Examples must not contain real API keys, internal IPs, internal hostnames,
  personal home directories, or real user data. Use `sk-example`,
  `http://localhost:8000/v1`, `/path/to/project`, `myapp`.
- Warnings and data-loss risks are marked explicitly.

## Related documentation

- [Testing and contributing](testing-and-contributing.md) — where docs checks sit in the pre-flight list
- [Architecture](architecture.md) — the module map the docs mirror
