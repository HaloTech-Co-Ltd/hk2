# hk2

一个由知识库（KB）驱动的编码智能体。将交互式 REPL 与工具调用相结合，并以每个项目的知识库作为唯一可信来源。

[English](README.md) | 简体中文

## 核心理念

- **Tree-sitter AST 解析**：hk2 使用原生 tree-sitter 语法对符号进行精确提取，覆盖 14 个包（15 个语法，因为 `tree-sitter-typescript` 同时导出 `typescript` 与 `tsx`）。若未安装对应语法，则回退到基于正则的解析器。
- **代码知识图谱**：调用链、类继承关系、导入与继承关系以图谱形式存储于 `~/.hk2/kb/<projectId>/graph/` 之下，可通过 `kb_callchain`、`kb_class`、`kb_refs`、`kb_implements` 遍历。
- **三空间知识库**：每个项目的知识库被划分为 Holy Space（稳定的设计知识）、Eden Space（频繁更新的目录/模式）与 Index Space（BM25 + 图谱 + 各空间索引）。
- **文档解析**：Markdown、JSON、YAML、HTML、SGML、纯文本使用标准库解析；PDF 与 Word（.docx）通过可选的 `pdf-parse` 与 `mammoth` 支持；旧版 Office 二进制（.doc、.pptx、.ppt）采用无依赖方式提取。文档以 `doc:<relpath>` 条目形式归入 Eden Space。
- **按请求构建知识图谱**：对每条用户消息，hk2 会从知识库中检索相关符号、调用链、类成员、知识条目与文档，并在 LLM 响应前将其作为上下文注入。
- **知识库优先策略**：代理总是优先使用知识库工具（`kb_search`、`kb_symbol`、`kb_callchain`、`kb_class`、`kb_refs`、`kb_implements`、`kb_knowledge` 等），再回退到 `bash grep`/`find`。中途的守卫逻辑会检测违规行为并将代理引导回知识库。
- **可恢复构建**：`/kb init` 每处理 100 个文件保存一次检查点（可配置）。若被中断，重新运行会从检查点恢复，无需重新解析。
- **自动生成摘要**：在 `/kb init` 结束时，LLM 会撰写三个 Eden 条目：`project-overview`、`architecture-diagram`、`architecture-decisions`，始终可通过 `kb_knowledge` 获取。
- **多项目、多模型**：一份 `~/.hk2/` 安装可管理不限数量的项目（以 UUID 隔离的知识库）与不限数量的 LLM 提供商/模型。
- **支持任意语言**：C/C++、C#、JavaScript/TypeScript、Python、Go、Rust、Java、Kotlin、Scala、Ruby、PHP、Swift、Bash/Zsh、lex/yacc。

## 环境要求

- Node.js >= 18（推荐 Node 20 LTS，以获得最佳的 tree-sitter 原生兼容性）
- 运行 `npm install` 以安装 tree-sitter 原生绑定（14 个语言包）

> **Tree-sitter 兼容性提示**：过新的 Node 版本（如 Node 25+）
> 在某些平台上可能与预编译的 tree-sitter 二进制存在 N-API / V8 ABI 不匹配。
> 若 `/kb init` 日志出现 `tree-sitter parse failed`，hk2 会透明地回退到
> 基于正则的解析器——符号覆盖率会略低，但系统功能完全正常。如需最高精度，
> 请在 Node 20 LTS 上安装，或运行 `npm rebuild` 从源码重新编译。

## 安装

hk2 未发布到 npm。请从源码安装：

### 方式 A——install.sh（推荐）

在 `~/.hk2` 创建一份源码树的自包含副本，把 `hk2` 通过符号链接加入 PATH，并运行 `npm install` 构建 tree-sitter 原生绑定。

> `~/.hk2` 同时承担两个角色：它既是**配置 / 数据主目录**（`HK2_HOME`—
> `models.json`、`projects.json`、`kb/`、`sessions/`、`logs/`），也是源码副本的默认**安装目录**。
> 由于两者重叠，若你已有仓库检出，建议改用 `npm link`；或通过 `HK2_INSTALL_DIR` 指定一个独立路径。

```bash
git clone <repo-url> hk2 && cd hk2
./install.sh
```

自定义安装前缀或安装位置（前缀也可通过 `HK2_PREFIX` 环境变量设置）：

```bash
./install.sh --prefix=$HOME/.local
./install.sh --prefix /usr/local          # 等同于默认值
HK2_INSTALL_DIR=~/.hk2-src ./install.sh   # 将源码副本置于配置主目录之外
./install.sh --no-npm-install             # 跳过 tree-sitter（使用正则回退）
```

可选的 PDF / Word 解析：

```bash
cd ~/.hk2 && npm install                  # 安装 pdf-parse + mammoth
```

卸载：移除符号链接与源码副本。由于 `~/.hk2` 同时存放你的配置与知识库，
直接删除整个目录会一并清除它们—请先备份 `models.json` / `projects.json` / `kb/`，
或仅移除符号链接：

```bash
rm -f /usr/local/bin/hk2                  # 移除启动器
rm -rf ~/.hk2/node_modules ~/.hk2/bin      # 移除已安装的源码副本，保留配置与知识库
```

### 方式 B——npm link（面向开发者）

创建指向工作目录的实时符号链接。如果你正在修改 hk2 本身并希望改动立即生效，这种方式比较方便。

```bash
git clone <repo-url> hk2 && cd hk2
npm link
```

卸载：`npm unlink -g hk2`

### 验证

```bash
hk2 --help
```

## 快速开始

```bash
# 进入交互式 REPL
hk2
```

在 REPL 中：

```
# 1. 注册一个项目
/project init --name=myapp --source=/path/to/repo --source-root=src

# 2. 构建代码索引（Index Space）
/kb init

# 3. 深度研读整个项目 -> 自动生成 Eden 知识条目
/kb knowledge learn

#    或深度研读文档（PDF / Word / PPT / Markdown）到指定空间：
/kb knowledge learn --space=eden --file=docs/spec.pdf

#    或将代码研读限定到某个子目录：
/kb knowledge learn --base-dir=src/storage

# 4. 提问（代理会自动检索知识库上下文并调用工具）
登录是如何校验密码的？

# 5. 显式知识库查询
/kb search password verification
/kb symbol login
/kb neighbors 12:345
/kb knowledge list
/kb knowledge show spi-extension-pattern

# 6. 切换项目 / 模型
/model list
/model set-default local/gpt-4o
/model use local/gpt-4o          # 仅当前会话
/project list
/quit
```

## 三空间知识库模型

| 空间 | 内容 | 更新策略 |
|---|---|---|
| **Holy** | 稳定的设计知识（架构、算法、关键模式）。由人工撰写或从权威来源导入。 | **始终需要用户明确批准**，即便设置了 `HK2_ENABLE_AUTOUPDATEKB=1` 或 `HK2_ENABLE_AUTO_LEARN=1`。 |
| **Eden** | 频繁更新的知识（函数目录、命令列表、观察到的模式、模块摘要、**解析的文档**、**自动生成的摘要**）。 | 当 `HK2_ENABLE_AUTO_LEARN=1` 时可自动更新；否则提示 y/N 确认。 |
| **Index** | 代码索引（基于符号的 BM25）、知识图谱（调用链 / 类继承 / 导入 / 继承），以及 Holy/Eden 条目的各空间索引。 | 当 `HK2_ENABLE_AUTOUPDATEKB=1` 时可自动更新；否则提示 y/N 确认。 |

### 知识图谱

在 `/kb init` 时，hk2 会基于 AST 构建代码知识图谱：

```
~/.hk2/kb/<projectId>/graph/
  nodes.json            id -> 节点记录（函数 / 方法 / 类 / 接口 / 结构体 / 字段）
  edges.calls.json      srcId -> [calleeIds, ...]
  edges.imports.json    srcId -> [被导入文件节点 ids, ...]
  edges.inherits.json   srcId -> [基类 ids, ...]
  edges.contains.json   srcId -> [成员 ids, ...]
  by_kind.json          kind -> [nodeIds, ...]
  by_qual.json          qualName -> nodeId
  meta.json             计数 + 版本
```

可通过以下方式查询图谱：

- **kb_callchain**——对调用图做有界 DFS（前向、后向、双向）
- **kb_class**——类 / 接口 / 结构体查询，含成员与实现
- **kb_refs**——谁调用了 / 导入了 / 继承了某符号
- **kb_implements**——查找实现某接口的所有类

### 自动生成的 Eden 条目

`/kb init` 与 `/kb knowledge learn` 会生成互补的、由 LLM 撰写的 Eden 条目集合。两者均无需手写——每次运行都会覆盖之前的版本。

**`/kb init`** 写入 3 个高层结构条目（可用 `--skip-summary` 跳过）：

| 条目 id | 内容 |
|---|---|
| `project-overview` | 600–900 字的散文摘要：项目用途、高层架构、关键模块、显著模式。 |
| `architecture-diagram` | 模块 / 层级关系的 Mermaid 流程图，附带简短图例。 |
| `architecture-decisions` | 基于检测到的技术推断出的 4–8 条 ADR 风格条目，每条附带具体的修改建议。 |

**`/kb knowledge learn`** 是合并后的统一深度研读命令（原 `/kb knowledge init` 现在是它的别名）。它有两种模式。**CODE 模式**（不带 `--file`；`--base-dir` 匹配已索引子目录，或裸调用）在 Phase 0 写入 3 个项目级概览条目，随后在 Phase 2 写入 N 个主题相关条目。**DOC 模式**（`--file=<path>` 或未索引的 `--base-dir`）深度研读 Markdown / PDF / Word / PowerPoint 文档并写入所选空间：

| 条目 id | 阶段 | 内容 |
|---|---|---|
| `api-docs` | 0 | 对全项目最重要的公开 / 导出符号的编号参考。 |
| `code-walkthrough` | 0 | 4–8 个章节，逐步剖析最核心的抽象。 |
| `usage-examples` | 0 | 3–5 个使用真实公开符号的编号快速上手示例。 |
| `<topic-id>`（动态） | 2 | 每个 LLM 规划的主题一个条目，每个聚焦一个连贯的子系统（如 `buffer-pool`、`transaction-mgmt`、`wal-replay`）。 |

DOC 模式（`--file` / 未索引的 `--base-dir`）从文档中提取条目；大文件会被切分为顺序分片以保证内容不丢失，且每个文档都保证被某个批次覆盖（规划遗漏的文件会获得单文件兜底批次）。

**规模化行为（postgres 等大项目，约 3500 文件）：**索引文件超过 300 个时，规划器从文件级切换为**目录级规划**——LLM 只分组目录（map 缩小约 30 倍），每个目录令牌再被确定性展开为具体文件并切分为 ≤30 文件的批次。若 LLM 计划仍不可用（推理模型可能把整个预算耗在思考上），命令会先禁用推理重试一次，最终回退到确定性目录分组——研读永远以全覆盖继续，绝不中断。

**规划超时：**慢速供应商可能超过默认 300 秒规划预算；可用 `--plan-timeout-ms=N`（或环境变量 `HK2_PLAN_TIMEOUT_MS`）覆盖。

可通过 `kb_knowledge("<id>")` 或 `kb_search_knowledge("overview")` 检索其中任意条目。

### 知识命令

| 命令 | 说明 |
|---|---|
| `/kb knowledge list [--space=holy\|eden]` | 列出知识条目 |
| `/kb knowledge show <id>` | 显示条目全文（同时检索两个空间） |
| `/kb knowledge add [--space=holy\|eden] [--id=...] --title="..." [--intro="..." \| --intro-file=PATH] [--key-files=...] [--key-symbols=...] [--keywords=...]` | 手动添加条目 |
| `/kb knowledge learn [--space=eden\|holy] [--file=路径] [--base-dir=目录] [--per-batch-chars=N] [--dry-run] [--no-survey] [--plan-timeout-ms=N]` | 统一的深度研读命令。CODE 模式（裸调用，或 `--base-dir` 匹配已索引子目录）：两阶段研读已索引源码；Phase 0 写入三个项目级概览条目；Phase 1 规划主题批次（对 postgres 等大项目按规模自适应），Phase 2 逐批执行。LLM 计划不可用时回退到确定性目录分组——绝不中断。DOC 模式（`--file` 或未索引的 `--base-dir`）：深度研读 Markdown / PDF / Word / PowerPoint / 文本文档并写入 `--space`。旧别名 `init`/`bootstrap`/`scan` 路由到此处（全项目 CODE 模式）。 |
| `/kb knowledge export <eden\|holy\|all> <path>` | 将条目导出为 JSON 文件（版本 2 格式，每个条目带 `space` 标签） |
| `/kb knowledge import <path> [eden\|holy\|adaptive] [--overwrite]` | 从 JSON 导入条目。`adaptive` 会按条目原始空间路由。导入到 Holy 始终提示 y/N。 |
| `/kb knowledge housekeep <eden\|holy\|all>` | 移除缺失字段、重复 id 或标题/关键词近似的条目。Holy 始终提示确认。 |
| `/kb knowledge empty <eden\|holy\|all>` | 删除指定空间（们）的全部条目。不可逆，始终提示 y/N。 |
| `/kb knowledge del <id>` | 删除条目（需确认） |
| `/kb transform <id> <from> <to>` | 在 Holy 与 Eden 之间移动条目（需确认） |

## REPL 命令参考

输入 `/help` 查看完整列表；输入 `/help <命令>`（如 `/help kb`、`/help knowledge`）查看单个命令的详细用法与参数。每个命令族也支持 `<命令> help` 下钻（如 `/model help set`、`/kb knowledge help learn`）。常用命令：

| 命令 | 说明 |
|---|---|
| `/model list` | 列出所有提供商 / 模型 |
| `/model add <prov> <id> [--api=...] [--base-url=...] [--api-key=...] [--reasoning] [--context-window=N] [--model-options=JSON]` | 添加模型（`--model-options` 以 JSON 对象设置模型特性参数，如 `--model-options='{"enable_thinking":true}'`；默认无特性参数；声明了特性的模型类型会校验取值，如 `--model-type=glm-5.3` 接受 `{"reasoning_effort":"max"}`，默认且推荐 max（深度推理），可选 high（增强）/ low（轻度）） |
| `/model set <prov>/<id> [--name=...] [--id=NEW_ID] [--reasoning=on\|off] [--context-window=N] [--max-tokens=N] [--temperature=N] [--model-options=JSON] [--api=...] [--base-url=...] [--api-key=...]` | 修改模型配置（持久化；`--id` 重命名模型 id / 引用键，不影响发送给 API 的模型代码；`--model-options` 整体替换特性参数对象，传 `'{}'` 即清空；取值会按模型类型声明的特性校验，如 glm-5.3 的 `reasoning_effort` ∈ max/high/low） |
| `/model set-default <prov>/<id>` | 设为全局默认（持久化） |
| `/model use <prov>/<id>` | 仅当前会话选用模型 |
| `/model del <prov>/<id>` | 删除 |
| `/model show` | 显示当前默认模型详情 |
| `/model types` | 列出所有支持的 `--model-type` 取值 |
| `/model help [子命令]` | 显示 `/model` 完整用法；`/model help set` 可下钻到单个子命令 |
| `/project init --name=... --source=... [--source-root=...]` | 注册新项目 |
| `/project list` | 列出所有项目 |
| `/project set current <id\|name>` | 切换当前项目 |
| `/project set name <new-name>` | 重命名 |
| `/project show` | 当前项目详情 |
| `/project drop <id\|name>` | 移除项目（保留知识库） |
| `/kb init [--full] [--checkpoint-interval=N] [--no-resume] [--no-checkpoint] [--skip-summary]` | 为当前项目构建知识库（可恢复，自动生成摘要） |
| `/kb update` | 增量更新（Index Space） |
| `/kb status` | 知识库统计（各空间计数） |
| `/kb search <query> [--top-k=N]` | BM25 + 重排序的符号搜索 |
| `/kb symbol <name>` | 按精确名称查找符号 |
| `/kb neighbors <symbol_id>` | 调用图谱邻居 |
| `/kb knowledge list` | 列出 Holy + Eden 条目 |
| `/kb knowledge show <id>` | 显示条目全文 |
| `/kb knowledge add [...]` | 手动添加条目 |
| `/kb knowledge learn [--dry-run] [--base-dir=路径] [--file=路径] [--space=eden\|holy] [--per-batch-chars=N] [--no-survey] [--plan-timeout-ms=N]` | 深度研读项目代码（或单个子目录 / 文档）-> 自动生成知识条目。完整参数说明见 `/help knowledge` |
| `/kb knowledge export <scope> <path>` | 将条目导出为 JSON |
| `/kb knowledge import <path> [eden\|holy\|adaptive] [--overwrite]` | 导入条目（adaptive 按原始空间路由） |
| `/kb knowledge housekeep <scope>` | 移除重复与无效条目 |
| `/kb knowledge empty <scope>` | 删除指定空间（们）的全部条目 |
| `/kb knowledge del <id>` | 删除条目 |
| `/kb transform <id> <from> <to>` | 在 Holy 与 Eden 之间移动 |
| `/kb drop` | 删除知识库（需确认） |
| `/session info` | 当前会话 id、项目、消息数 |
| `/session list` | 最近的会话 |
| `/session new` | 开始新会话 |
| `/session resume <id>` | 恢复之前的会话 |
| `/clear` | 清空对话上下文 |
| `/compact` | 摘要压缩早期消息 |
| `/help` `/quit` `/exit` | 帮助 / 退出 |

## 代理工具

代理可在每轮中途调用以下工具（OpenAI/Anthropic 原生工具调用）：

| 工具 | 说明 |
|---|---|
| `read` | 读取文件内容（带行号、offset/limit）。知识库已知的代码文件会在内容前附带 `## Outline (from KB)` 章节，并返回 `tag` 字段用于陈旧锚点保护。 |
| `write` | 创建或覆盖文件 |
| `edit` | 精确字符串替换（支持多组互不相交的编辑）。可选 `tag` 拒绝陈旧锚点编辑。 |
| `bash` | 执行 shell 命令（沙箱限制在工作区） |
| `find` | 基于 glob 模式的文件搜索 |
| `grep` | 正则内容搜索 |
| `ast_grep` | 使用 `$$$IDENT` / `$IDENT` / `$_` 元变量的结构化代码搜索（ast-grep 风格）。当模式为知识库已知的单个精确标识符时，会前置一条引导至 `kb_symbol` 的知识库优先提示。 |
| `ast_edit` | 跨文件结构化重写。返回统一 diff 预览 + `proposalId`；自身不写入。可选 `tag` 在预览时校验目标文件。 |
| `resolve` | 应用或丢弃先前预览的 `ast_edit` 提案。应用时重新校验 tag，任一失败则回滚。 |
| `plan` | 分流助手用于呈现需用户确认的执行计划的接口。当 LLM 判定某任务足够复杂、需要策略决策（多个独立阶段、需用户确认的设计选择、或涉及多个子系统）时调用此工具；简单任务则直接进入执行。它返回一行摘要 + 2–5 个有序步骤，每步含 2–4 个候选策略（其中一个标记为推荐），并呈现该计划供逐步选择策略。 |
| `plan_step` | 将当前已确认计划的某一步标记为完成，并推进实时进度面板。在每个已确认计划步骤（由 `plan` 返回）完成后调用一次；`step` 为从 1 开始的序号（省略则推进当前步骤）。纯进度 UX 信号——无活动计划时为空操作，最后一步完成后面板自动清除。请勿在 `plan` 返回已确认计划之前调用。 |
| `kb_search` | BM25 符号搜索（默认用 LLM 重写查询） |
| `kb_symbol` | 按精确名称查找符号 |
| `kb_outline` | 来自知识库索引的文件大纲——每个符号的名称 / 类型 / 行号 / 签名。对“这个文件里有什么？”这类问题比 `read` 更轻量。返回 `tag` 供后续编辑安全使用。 |
| `kb_neighbors` | 调用图谱 1 跳邻居（旧版） |
| `kb_callchain` | 对调用图做有界 DFS（前向 / 后向 / 双向） |
| `kb_class` | 类 / 接口 / 结构体查询，含成员、父类、实现 |
| `kb_refs` | 查找某符号的调用者、导入者、派生类 |
| `kb_implements` | 查找实现某接口或继承某基类的所有类 |
| `kb_knowledge` | 按 id 查找知识条目（Holy + Eden） |
| `kb_search_knowledge` | 按自然语言查询搜索知识条目 |
| `kb_save_knowledge` | 将新的知识条目保存到 Holy 或 Eden |
| `mcp__<server>__<tool>` | 通过 `/model add-mcpserver` 附加到当前模型的 MCP 服务器提供的工具（如 `mcp__web-reader__webReader`）。每个 agent 回合在内置工具之后挂载；不可达的服务器跳过并警告 |

### 知识库优先策略

每条代码发现路径都优先使用知识库索引而非重新解析：

- `kb_outline`、`kb_symbol`、`kb_search` 及图谱工具直接读取索引——无文件系统访问，无重新解析。
- 对代码文件调用 `read` 会前置知识库大纲，使代理在查看内容前先了解结构。
- 若未先使用知识库工具就调用 `bash grep/find/cat` 或直接 `read`，会得到一次性的 `[kb-first policy hint]` 前置提示；当代理使用任意知识库工具后，该提示停止出现，表明后续的 bash/read 回退是有意为之。
- 当 `ast_grep` 的模式为单个精确标识符时，会发出同样的提示引导至 `kb_symbol`。

### 模式语法（ast_grep / ast_edit）

| 记号 | 含义 |
|---|---|
| `$$$IDENT` | 多通配符捕获——匹配任意文本（多行、非贪婪）。`IDENT` 会被捕获到 `meta.IDENT` 以便替换。 |
| `$IDENT` | 单标识符捕获——匹配 `[A-Za-z_][A-Za-z0-9_]*`。 |
| `$_` | 匿名单 token 通配符（不捕获）。 |
| 其他 | 字面文本，按正则转义。 |

示例：

- `ast_grep("console.log($$$)")`——任意 console.log 调用
- `ast_grep("function $NAME($$$)", path="src")`——捕获函数名
- `ast_edit({ops:[{pat:"console.log($$$ARGS)", out:"logger.info($$$ARGS)"}], paths:["src"]})`——将所有 console.log 批量改为 logger.info，参数保留（具名捕获可往返；匿名 `$$$` 不可）

### Hashline 风格的锚定编辑

`read` 与 `kb_outline` 的结果包含一个 `tag`（文件内容哈希的前 8 位十六进制字符）。将其回传到后续的 `edit` 或 `ast_edit` 调用中，若文件自 tag 生成以来已被修改，工具将拒绝该变更：

```
read({path:"src/foo.js"}) -> {tag:"a1b2c3d4", ...}
edit({path:"src/foo.js", old_string:..., new_string:..., tag:"a1b2c3d4"})
  -> 匹配则通过；不匹配则报错："stale tag: file changed since read..."
```

### 暂缓的能力

以下能力**尚未**实现，因为它们缺乏清晰的知识库优先方案，且需要数千行的集成工作：

- **LSP 集成**——需要启动语言服务器、JSON-RPC 能力协商与诊断流。知识库符号索引已覆盖大多数“IDE 知道什么？”类查询；LSP 仅对实时诊断与跨未索引文件的重命名重构有额外价值。待该缺口成为阻碍时再做。
- **DAP 调试**——需要启动调试适配器（gdb、lldb-dap、debugpy、dlv）、断点/单步/变量协议。范围与 LSP 相当。待出现具体调试工作流需求时再做。
- **完整的 hashline 语法**（`SWAP.BLK`、`INS.PRE/POST/HEAD/TAIL`、`MV`、`REM`）——v1 仅提供 `tag` 安全机制。完整的行锚定语法将在预览/接受流程验证成熟后作为后续补充。
- **AST 感知的 ast_grep 匹配**——v1 使用正则近似（将元变量转换为捕获组）。完全对齐 ast-grep 模式（真正的 AST 边界匹配）将逐步迭代。

## 状态栏

终端底部固定一条状态栏（仅 TTY 模式）：

```
streaming │ postgres|kb|glm-5.2 │ ↑1.4k ↓120 0.1%/1.0M │ 4.2s
```

- `↑1.4k`——最近一次 LLM 调用的输入 token 数
- `↓120`——最近一次 LLM 调用的输出 token 数
- `0.1%`——当前上下文使用率（最近输入 / 上下文窗口）
- `1.0M`——上下文窗口大小

在流式输出、工具调用与阶段切换期间实时更新。

### 进度面板

当某任务足够复杂时，代理会调用 `plan` 呈现一个需用户确认的执行计划。随后会在状态栏上方固定一个实时进度面板，展示计划的各个步骤--哪些已完成、哪个进行中、哪些待处理：

```
▣ Plan: 同步 README 文档与代码
  ✓ 1. 补全缺失的 plan_step 工具
  ▶ 2. 记录进度面板
    3. 修正 tree-sitter 包数量
    4. 提交并推送
```

每完成一个已确认步骤后，代理调用一次 `plan_step` 以推进面板。标记最后一步完成后，面板会自动清除--无需单独的完成调用。跳过 `plan` 的简单任务不会显示面板。详见 [代理工具](#代理工具) 中的 `plan` 与 `plan_step` 条目。

当 `HK2_ENABLE_PLANREVIEW=1`（默认关闭）时，用户确认计划后，LLM 会复审该计划，并在执行开始前将发现的问题逐一呈现给用户确认；详见环境变量表。

当 `HK2_ENABLE_CODEREVIEW=1`（默认关闭）时，整个计划执行完成后，hk2 会执行一步 Code Review，检查完成结果（工作区 diff、变更文件、代理的最终总结）的正确性、完整性与质量，并将发现的问题逐一列出、给出详细说明与建议。审查模型可通过 `/model set-phase --phase=code-review <ref>` 配置（与 `plan-review` 机制相同）；未设置时使用会话模型。详见环境变量表。

## 配置布局

```
~/.hk2/
├── models.json                       # 多提供商模型注册表
├── projects.json                     # 项目注册表 + 当前指针
├── kb/
│   └── <projectId>/                  # 每个项目的知识库
│       ├── meta.json                 # 知识库元数据
│       ├── holy/                     # Holy Space —— 稳定的知识条目
│       │   └── <entry-id>.json
│       ├── eden/                     # Eden Space —— 频繁更新的知识
│       │   └── <entry-id>.json
│       ├── graph/                    # 知识图谱（Index Space）
│       │   ├── nodes.json
│       │   ├── edges.calls.json
│       │   ├── edges.imports.json
│       │   ├── edges.inherits.json
│       │   ├── edges.contains.json
│       │   ├── by_kind.json
│       │   ├── by_qual.json
│       │   └── meta.json
│       ├── files.json                # Index Space —— 文件注册表
│       ├── inverted.json             # Index Space —— BM25 倒排索引
│       ├── callgraph.json            # Index Space —— 旧版调用图（由 graph 派生）
│       ├── symbols.0000.json         # Index Space —— 分片符号表
│       ├── stats.json                # Index Space —— 构建统计
│       ├── checkpoint.json           # 可恢复构建状态（临时）
│       └── summaries/                # 每符号摘要（按需）
├── sessions/
│   └── <projectId>/
│       └── <sessionId>.jsonl         # 会话记录（JSONL）
└── logs/
```

### models.json 结构

每个模型有 `id` 和 `name` 两个字段。`id` 是 `provider/id` 引用（如 `local/glm-4.7`）里的账户/索引键，可以携带尾部括号形式的上下文窗口提示（例如 `[1m]`）。`name` 才是**实际发送到 API 请求体**的模型代码（wire `model` 字段）——请把它设为服务商期望的精确字符串（例如 `glm-4.7`，而非 `GLM 4.7`）。把提示留在 `id` 上、把干净代码放在 `name` 里，可避免部分网关拒绝 `glm-4.7[1m]` 而报 `[modelCode不存在]`。

```json
{
  "providers": {
    "local": {
      "api": "openai",
      "baseUrl": "http://10.16.6.162:18000",
      "apiKey": "sk-glm4-local",
      "models": [
        {
          "id": "glm-4.7",
          "name": "glm-4.7",
          "contextWindow": 131072,
          "maxTokens": 32768,
          "temperature": 0.2,
          "reasoning": true
        }
      ]
    },
    "anthropic": {
      "api": "anthropic",
      "apiKey": "...",
      "models": [
        { "id": "claude-opus-4-7", "name": "claude-opus-4-7", "contextWindow": 200000, "maxTokens": 32000, "reasoning": true }
      ]
    }
  },
  "default": "local/glm-4.7"
}
```

### projects.json 结构

```json
{
  "current": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
  "projects": {
    "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d": {
      "id": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
      "name": "myapp",
      "sourcePath": "/path/to/repo",
      "sourceRoot": "src",
      "includeGlobs": ["**/*.js", "**/*.ts", "**/*.py", "..."],
      "excludeGlobs": ["**/node_modules/**", "..."],
      "extraRoots": [],
      "kbBuiltAt": "2026-07-24T16:41:44.248Z",
      "createdAt": "2026-07-24T16:41:43.000Z"
    }
  }
}
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `HK2_HOME` | 覆盖 `~/.hk2` 位置 | `~/.hk2` |
| `HK2_KB_DIR` | 覆盖知识库根目录 | `$HK2_HOME/kb` |
| `HK2_KB_NAME` | 旧版 `--mode` 命令使用的知识库名 | 当前项目 id，或 `default` |
| `HK2_PROJECT_SOURCE` | 工具沙箱的项目源码根（交互模式下自动设置） | - |
| `HK2_PREFIX` | `install.sh` 用于放置 `hk2` 符号链接的安装前缀 | `/usr/local` |
| `HK2_INSTALL_DIR` | `install.sh` 创建的自包含副本位置（默认为 `HK2_HOME`，即 `~/.hk2`） | `~/.hk2` |
| `HK2_ENABLE_QUERYREWRITE` | 为 1 时，hk2 会在 BM25 检索前（每轮开始及每次 `kb_search` 工具调用时）用一次 LLM 调用将用户查询重写为英文函数名 + 关键词。 | `1` |
| `HK2_ENABLE_REQUEST_ASSESS` | 为 1 时（且 `HK2_ENABLE_QUERYREWRITE=1`），hk2 会先询问 LLM 用户请求是否清晰。若不清晰，则以编号菜单（含“其他（自定义）”自由文本选项）呈现不清晰的方面与候选解读，并将用户选定的澄清反馈回查询重写。仅在交互式 TTY 模式下启用；仅一轮有界交互。尽力而为：任何失败都回退到正常重写流程。 | `1` |
| `HK2_ENABLE_PLANREVIEW` | 为 1 时，在用户确认计划后，hk2 会请求 LLM 复审已定稿的计划，查找问题（缺失步骤、顺序错误、目标模糊、策略有风险等）。若复审发现有问题，会将每个问题逐一呈现给用户确认（采纳复审建议 / 忽略该问题 / 自定义解决方案）；确认后的解决方案会附加到返回给代理的计划中。复审模型可通过 `/model set-phase --phase=plan-review <ref>` 配置（与 `rewrite-query` 机制相同）；未设置时使用会话模型。仅在交互式 TTY 模式下启用。尽力而为：任何失败都返回已确认的计划，不做更改。 | `0` |
| `HK2_ENABLE_CODEREVIEW` | 为 1 时，整个计划执行完成后，hk2 会对完成结果（工作区 diff、变更文件、代理的最终总结）执行一步 Code Review，检查正确性、完整性与质量，并将发现的问题逐一列出，给出详细说明与建议。审查模型可通过 `/model set-phase --phase=code-review <ref>` 配置（与 `plan-review` 机制相同）；未设置时使用会话模型。仅在交互式 TTY 模式下启用。尽力而为：任何失败都会被报告，本轮仍正常结束。 | `0` |
| `HK2_ENABLE_AUTOUPDATEKB` | 为 1 时，若某轮代理回退到 bash 搜索源文件，hk2 会在该轮结束时静默执行一次增量 `/kb update`（Index Space）。 | `0` |
| `HK2_ENABLE_AUTO_LEARN` | 为 1 时，hk2 会静默地让模型从刚结束的对话中抽取一条可复用知识条目并存入 Eden Space。无论此标志如何，Holy Space 始终提示 y/N。 | `0` |
| `HK2_ENABLE_AUTOCOMPACT` | 为 1 时，当已使用的上下文长度达到模型上下文窗口的 `HK2_AUTOCOMPACT_PCTUSED`% 后，hk2 会在下一轮开始时自动压缩历史对话。压缩会原样保留最近 4 轮 user/assistant，并将其之前的对话（含工具结果）用 LLM 总结为一条 system 消息；LLM 失败时回退为朴素截断。仅在轮次边界触发，绝不中断正在进行的动作。 | `0` |
| `HK2_AUTOCOMPACT_PCTUSED` | 1-100 的整数，上下文使用率触发阈值。仅当已使用的上下文长度 ≥ `模型上下文窗口 × HK2_AUTOCOMPACT_PCTUSED / 100` 时才触发自动压缩。 | `90` |
| `HK2_KB_CHECKPOINT_INTERVAL` | 每 N 个文件保存一次 `/kb init` 检查点 | `100` |
| `HK2_PLAN_TIMEOUT_MS` | `/kb knowledge learn` Phase 1 规划调用超时（毫秒）。慢速供应商（大文件映射上的推理模型）可能超过默认 300 秒。单次运行可用 `--plan-timeout-ms=N` 覆盖。 | `300000` |
| `HK2_INDEX_PARALLEL` | KB 索引解析池的并行度（`/kb init` / `/kb update`）。`0` 或未设置 = 自动（取当前系统 CPU 数）；正整数 N 则固定为 N。 | `0` |
| `HK2_DEBUG` | 打印错误堆栈 | - |
| `HK2_NO_COLOR` | 为 1 时禁用 ANSI 颜色（亦遵从标准 `NO_COLOR` 环境变量）。 | - |
| `HK2_ASCII` | 为 1 时，强制使用 ASCII 字符替代 UTF-8 的制表/加载动画/图标（适用于非 UTF-8 终端）。 | - |
| `ANTHROPIC_API_KEY` | 首次初始化时自动创建 `anthropic` 提供商 | - |
| `OPENAI_API_KEY` | 首次初始化时自动创建 `openai` 提供商 | - |

## 一次性模式（CLI）

```bash
# 从 CLI 注册项目（等价于 REPL 中的 /project init）
hk2 --mode=project-init --name=myapp --source=/path/to/repo --source-root=src

# 为当前项目构建知识库
hk2 --mode=build-kb

# 增量更新知识库
hk2 --mode=update-kb

# 以预选的指定项目进入 REPL
hk2 --project=myapp                       # 按名称
hk2 --project-id=8ce5c38d-214c-4e0d-8ed1-30045dd3c99d   # 按 UUID

# 列出所有已注册的项目并退出（当前项目标记为 '*'）
hk2 --project-list

# 旧版 REPL（命令式，无代理循环）
hk2 --run-mode=serve
```

## 支持的语言

知识库索引器优先使用 **原生 tree-sitter 语法** 进行 AST 精确符号提取，覆盖 14 个包（15 个语法，因为 `tree-sitter-typescript` 同时导出 `typescript` 与 `tsx`）：

- C、C++、C#
- JavaScript、TypeScript、JSX/TSX
- Python、Go、Rust
- Java、Kotlin、Scala
- Ruby、PHP
- Bash / Zsh

若某个语法或 `tree-sitter` 原生绑定不可用，hk2 会透明回退到基于正则的解析器（覆盖率略低，但 Symbol[] 结构相同）。C/C++ 与 lex/yacc（`.y`/`.l`）源码在回退路径中还额外配有专用正则解析器。

## 目录结构

```
hk2/
├── bin/
│   └── hk2                    # 单一入口（#!/usr/bin/env node）
├── install.sh                 # 安装脚本（复制目录树、符号链接 bin、运行 npm install）
├── src/
│   ├── cli.js                 # 参数解析 + 分发（默认进入交互模式）
│   ├── commands/
│   │   ├── interactive.js     # 默认交互式 REPL（代理循环 + 状态栏）
│   │   ├── build_kb.js        # --mode=build-kb
│   │   ├── update_kb.js       # --mode=update-kb
│   │   ├── search.js          # 旧版 serve 模式代码搜索辅助
│   │   ├── explain.js         # 旧版 serve 模式解释辅助
│   │   └── serve.js           # --run-mode=serve（旧版 REPL）
│   └── slash/
│       ├── index.js           # 斜杠命令分发器（引号感知分词器）
│       ├── model.js           # /model
│       ├── project.js         # /project
│       ├── kb.js              # /kb（含 knowledge learn/export/import/transform）
│       └── session.js         # /session
├── lib/
│   ├── config/
│   │   └── home.js            # $HOME/.hk2 配置层
│   ├── agent/
│   │   ├── loop.js            # 代理轮次循环（卡死检测、工具缓存）
│   │   ├── tools.js           # 工具注册表 + KbFirstGuard（含图谱工具）
│   │   ├── system_prompt.js   # 系统提示构建器 + 知识库策略
│   │   ├── graph.js           # 按请求构建知识图谱
│   │   ├── statusbar.js       # 底部常驻状态栏
│   │   └── transcript.js      # JSONL 会话记录
│   ├── parser/
│   │   ├── ast.js             # AST 分发器（tree-sitter -> 正则回退）
│   │   ├── ts_parser.js       # tree-sitter 多语言解析器
│   │   ├── doc_parser.js      # 文档解析器（md/json/yaml/html/sgml/pdf/docx/doc/pptx/ppt）
│   │   ├── c_parser.js        # 旧版 C 解析器（回退）
│   │   ├── ylex_parser.js     # 旧版 Y/L 解析器（回退）
│   │   └── generic_parser.js  # 其他语言的旧版正则解析器（回退）
│   ├── graph/
│   │   ├── builder.js         # 从 Symbol[] 构建节点 + 边
│   │   └── traverse.js        # 纯 BFS / 调用链辅助函数
│   ├── index/
│   │   ├── indexer.js         # 遍历 -> 解析 -> BM25 + 调用图 + 图谱 + Eden 文档
│   │   ├── walker.js          # glob 遍历器（include/exclude + .gitignore）
│   │   ├── gitignore.js       # .gitignore 加载器
│   │   ├── checkpoint.js      # 可恢复构建检查点
│   │   ├── summarize.js       # LLM 撰写的 Eden 摘要
│   │   ├── bm25.js            # BM25 索引
│   │   ├── callgraph.js       # 旧版调用图（由图谱派生）
│   │   ├── text_tokenizer.js  # BM25 分词器
│   │   └── registry.js        # 知识库注册 + PARSER_VERSION
│   ├── retrieval/             # 知识库检索 + 运行时缓存（code_search、kb_runtime）
│   ├── llm/                   # LLM 客户端（OpenAI / Anthropic，工具调用 + 用量）
│   ├── store/                 # 知识库存储（holy/eden/index/graph 路径）
│   └── util/
└── package.json
```
