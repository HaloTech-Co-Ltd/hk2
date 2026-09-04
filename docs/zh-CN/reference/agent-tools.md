# 智能体工具

[English](../../en/reference/agent-tools.md) | 简体中文

hk2 智能体可在回合中途调用的工具参考（OpenAI / Anthropic 原生工具调用）。
注册表位于 `lib/agent/tools.js`——编辑本页时，请对照该文件重新核验。挂载到
当前模型的 MCP 工具在内置工具之后以 `mcp__<server>__<tool>` 形式出现。

## 索引

| 类别 | 工具 |
|---|---|
| 文件 | `read`、`write`、`edit` |
| Shell / 搜索 | `bash`、`find`、`grep` |
| 结构化 | `ast_grep`、`ast_edit`、`resolve` |
| 规划 | `plan`、`plan_step` |
| 知识库查询 | `kb_search`、`kb_symbol`、`kb_outline`、`kb_neighbors`、`kb_callchain`、`kb_class`、`kb_refs`、`kb_implements` |
| 知识库知识 | `kb_knowledge`、`kb_search_knowledge`、`kb_save_knowledge` |
| 会话 | `remember` |
| MCP | `mcp__<server>__<tool>` |

## 文件工具

### `read`

读取 **UTF-8 文本**文件——不支持图片或二进制内容。超过 **5 MiB** 的文件直接拒绝
（`file too large: N bytes`——分页读取也无济于事）。在此限内，输出带行号，
按行边界截断到 2000 行或约 256 KiB——但第一条请求行即使本身超过名义
字节上限也仍会返回；用 `offset`/`limit` 继续读取。
前 8192 个解码字符中含 NUL 字节的文件会按二进制拒绝
（`binary file (NUL byte detected): … — read only supports text files`）
——这是 NUL 扫描启发式，不是完整的二进制格式识别。
对符合条件（eligible）的已索引源文件，内容前附带结构性
`## Outline (from KB)` 章节（`outline=false` 禁用），且结果可能携带用于
陈旧锚点保护的 `tag`（见[陈旧锚点保护](#陈旧锚点保护tag)）；资格跟随工具
注册表的启发式白名单（`SOURCE_EXT_RE`）——比索引器完整解析器/文档支持范围
更窄：`.cs`、`.kts`、`.sgml`、`.doc`、`.ppt`、`.pptx` 与无扩展名惯例文件都
不在其中（反过来说，白名单还包含 `.md`/`.json`/`.pdf` 等文档格式）。这只
影响 `read` 的**自动**附加——直接调用 `kb_outline` 对任何已索引文件（含
`.cs`/`.kts`）仍返回符号与 tag。另注意 `read` 按传入的原始路径匹配 KB 文件
表，绝对路径或不同写法可能无法命中按项目相对路径保存的键。tag 只需文件表
存有哈希；outline 还需至少一个符号。写入：否。

### `write`

创建或覆盖文件；自动创建父目录。写入：是。

### `edit`

在单个文件中做精确字符串替换。接受 `{edits:[{oldText,newText}]}`
（推荐——一次调用完成多组互不相交的编辑）或 `{old_string,new_string}`
（单处编辑）。每个 `oldText` 必须匹配唯一、互不重叠的区域。可选 `tag`
（来自先前 `read`/`kb_outline` 的 shortHash）在文件自 tag 生成后发生变更
时拒绝编辑。写入：是。

## Shell 与搜索

### `bash`

在当前工作目录执行 shell 命令。stdout 与 stderr 各自独立截断到约 8 KiB
的缓冲预算（bash 没有单独的行数上限；stderr 上的 KB 提示会占用该流预算）。
可选超时（秒）：默认 60、上限 60（更大值被钳制；`0` 回退默认；负数未校验
——请勿使用）。权限检查为尽力而为（见[安全与权限](../guides/security-and-permissions.md)）。
可选超时（秒）：默认 60、硬上限 60（更大的值会被钳制；`0` 回退为默认值）。
写入：可能——请视为写入类工具。

### `find`

基于 glob 模式的文件搜索；返回相对搜索目录的路径，超过 1000 条截断。
内部遍历器跳过 `.git` 与 `node_modules`，但**不**应用仓库的
`.gitignore`。写入：否。

### `grep`

正则内容搜索；带 file:line 的匹配行，超过 100 条截断（长行截断到 240
字符），每次调用最多覆盖 2000 个文件。内部遍历器跳过 `.git` 与
`node_modules`，但**不**应用仓库的 `.gitignore`。写入：否。

## 结构化工具

### `ast_grep`

结构化代码搜索，ast-grep 风格——模式被翻译为元变量语法的正则近似（见
[模式语法](#模式语法ast_grep--ast_edit)）。在最多 2000 个文件中返回最多
50 个匹配。当模式为知识库已知的单个精确标识符时，会发出引导至
`kb_symbol` 的知识库优先提示。写入：否。

### `ast_edit`

跨文件结构化重写。每个操作为 `{pat, out}`，使用相同的元变量语法（捕获可
替换进 `out`）。**自身绝不写盘**：返回统一 diff 预览 + `proposalId`，并
暂存写入。可选 `tag` 会与**每个**目标文件比对——一个 tag 应用于全部文件，
因此主要适用于单文件重写；多文件提案请省略 tag，依赖 `resolve` 阶段的
逐文件复验。写入：仅暂存——通过 `resolve` 应用。

### `resolve`

`ast_edit` 的两步预览/应用流程：`action:"apply"` 写入全部暂存文件（逐个
复验 proposal 在预览时记录的逐文件 tag）；失败时**尝试**用先前内容恢复
已写入的文件——回滚是尽力而为、非事务性；回滚写入自身失败时，当前实现
会忽略该错误，不会单独报告。`action:"discard"` 丢弃暂存不写入。写入：
是（apply 时）。

**Proposal 生命周期**：proposal 只存在于进程内存——退出或崩溃即丢失；
TTL 为 10 分钟；每进程最多 16 个活跃 proposal（超出按 LRU 淘汰）。apply、
discard 与读取/tag/写入失败会消费 proposal；权限被拒的 apply 或非法 action
当前不会消费它——它会保留到后续成功 resolve、另一次消费性失败、淘汰、过期
或进程退出。复用已消费/过期的 id 会报错——请重新运行 `ast_edit` 获取新
proposal。错误结果中的 `rolledBack` 表示进入恢复尝试的已写文件数，不是已
验证恢复成功的数量。

**已知限制**：`ast_edit` 的目录展开每个根最多遍历 2000 个候选文件，且
当前不在结果中报告该截断——超大目录树上的 proposal 可能只静默覆盖前
2000 个被遍历的文件。面向大树时请收窄 `paths`。

## 规划工具

### `plan`

提交需用户确认的执行计划——分流助手判定任务足够复杂、需要策略决策时调用
的接口。接受 `summary` 字符串与“2–5 个有序 `steps`、每步含 `goal` 与
2–4 个候选 `strategies`（{name, description, recommended}——恰好一个
推荐）”的预期形状——这是提示词对模型推荐的形状；运行时校验只强制
“至少 2 个有效步骤、每步至少 2 个有效策略”的下限，不强制上限。
该工具把计划呈现给用户逐步选择策略（非交互模式自动采纳推荐策略）并返回
最终计划文本；接受返回 `{confirmed, plan}`，取消返回 `{cancelled}`，形状
非法返回 `{error}`。写入：否。

### `plan_step`

把已确认计划的**当前** in_progress 步骤标记为完成并推进实时进度面板——
每个步骤完成后调用一次。`step` 参数仅作为兼容/报告提示保留（状态机
始终推进当前 in-progress 步骤；该取值不会选择**被推进的是哪一步**——当前
in-progress 步骤仍会被推进）。交互模式使用真实状态机；无状态机时
`plan_step` 仅回显（不维护进度状态）。无活动计划时为
空操作；最后一步完成后面板自动清除，回合正常结束时还有收尾兜底清理未
推进的面板。请勿在 `plan` 返回已确认计划之前调用。写入：否。

## 知识库查询工具

符号与图谱元数据大多来自已加载的内存索引，但这不是“零文件系统访问”的总括
保证：`kb_search` 默认会从磁盘加载源码切片，`kb_knowledge` 也可能回退到
磁盘知识存储（指定 `space` 时直接读盘，或 runtime 缓存未命中时）。镜像被
拒绝源文件的内容会在受过滤通道中被抑制（元数据保持可见——见
[安全与权限](../guides/security-and-permissions.md)）。

| 工具 | 用途 |
|---|---|
| `kb_search` | 自然语言 / 关键词符号搜索——BM25 + 名称匹配重排，返回文件路径、行范围与摘要。有可用 LLM 时默认经 LLM 改写查询（`skip_rewrite=true` 跳过）；前 3 个结果携带 ±15 行源码切片（`with_slice=false` 禁用）。`top_k`：默认 10，有效范围钳制在 5–50（低于 5 的取值仍至少返回 5 条） |
| `kb_symbol` | 按精确标识符查找符号；返回全部匹配候选 |
| `kb_outline` | 来自知识库索引的文件大纲——每个符号的名称 / 种类 / 行号 / 签名 / 父类 / 子项数；对"这个文件里有什么？"比 `read` 更轻量；返回 `tag` 供编辑安全使用 |
| `kb_neighbors` | 某符号的旧版一跳**出向**调用图邻居（它调用了谁；无 direction 参数——要找调用者请用 `kb_callchain` 的 `direction=backward`/`both`） |
| `kb_callchain` | 对调用图做有界 BFS——按 `max_depth` 跳数返回调用者 / 被调用者。`max_nodes` 独立应用于每个所选方向；BFS 预算包含起点（起点不在返回结果中），对推荐的 `max_nodes >= 2`，每个方向最多返回 `max_nodes - 1` 个其他节点；`0`/`1`/负数未校验 |
| `kb_class` | 类 / 接口 / 结构体 / 枚举查询：`qual_name` 精确匹配，`name` 子串匹配取首个候选（歧义名称请用 `qual_name`）；返回签名、docString、成员、父类、直接实现 |
| `kb_refs` | 直接（一跳）反向查找：调用者（深度 1）、直接导入者、直接派生类（`kind=call\|import\|inherit\|any`）——非传递闭包 |
| `kb_implements` | 给定接口或基类，列出图谱记录的**直接**实现类 / 直接子类（一跳，非传递闭包——对结果再次查询可继续下钻） |

## 知识库知识工具

| 工具 | 用途 |
|---|---|
| `kb_knowledge` | 按 id 查找知识条目——同时检索 Holy 与 Eden，返回完整条目（标题、简介、keyFiles、keySymbols、keywords、space） |
| `kb_search_knowledge` | 按自然语言查询搜索两个知识空间（关键词重叠排序）——用于判断知识库是否已有某概念的文档 |
| `kb_save_knowledge` | 把知识条目持久化到 Holy（需用户批准）或 Eden（可自动学习）；KB runtime 立即热重载。注意：同一 `runLoop` 内此前已成功缓存过的相同 `kb_knowledge`/`kb_search_knowledge` 调用，可能继续返回旧缓存，直到发生缓存失效调用或进入新循环。通过该工具保存即视为本轮知识捕获已处理 |

## 会话工具

### `remember`

持久化一条简短、自包含的会话事实（环境端点与地址、端口、版本、账号
或机器名、部署约束、"总是用 X 跑测试"这类显式偏好）。事实通过一条紧跟
主系统提示词之后的常驻 `## Session facts` system 消息注入后续每一轮，
且**免受上下文压缩影响**。写入：仅会话事实文件。

边界（由模型收到的工具准则约束）：

- 每次调用一条事实，表述自包含（"测试环境地址 10.1.2.3"、
  "PostgreSQL 16.2"、"用 npm 不用 yarn"）。
- 只要事实——绝不包括密钥本身。可复用的**代码**知识属于
  `kb_save_knowledge`，不在此处；任务步骤与代码发现不是事实。
- 每会话上限 100 条、每条 500 字符；写入即刷新常驻消息，同一循环中
  后续 LLM 调用立即可见。
- 尽力而为：存储失败降级为"本轮无事实"，绝不阻塞管线。

用户侧由 `/remember` / `/forget` 驱动同一存储；压缩时的一次抽取也会
*尝试*保留即将被总结掉的事实——该抽取属于尽力而为（见
[智能体工作流](../concepts/agent-workflow.md)）。

## MCP 工具

`mcp__<server>__<tool>`——通过 `/model add-mcpserver` 挂载到当前模型的
MCP 服务器提供的工具（如 `mcp__web-reader__webReader`）。每个智能体回合在
内置工具之后挂载；不可达的服务器跳过并警告。见
[模型、项目与会话](../guides/models-projects-and-sessions.md#mcp-服务器)。

## 知识库优先策略

每条代码发现路径都优先使用知识库索引而非重新解析：

- `kb_outline`、`kb_symbol` 与图谱工具主要读取已加载的内存索引，无需
  重新解析。`kb_search` 的排序来自索引中的 BM25，但默认会为前 3 个结果
  从文件系统加载 ±15 行源码切片（受读取权限约束；`with_slice=false` 关闭）。
- 对代码文件调用 `read` 会前置知识库大纲，使智能体在查看内容前先了解
  结构。
- `bash grep/find/cat` 与直接 `read` 会得到 `[kb-first policy hint]` 前置
  提示（仅当该次 LLM 调用尚未使用任何知识库工具）——每次 LLM 调用中，
  bash、read 与共享的独立搜索桶（find / grep / 通用 ast_grep 共用一个桶）
  各最多提示一次；任一知识库工具运行后，本次 LLM 调用内的通用提示停止，
  表明后续 bash/read 回退是有意为之。
- 当 `ast_grep` 的模式为单个精确标识符时，会发出同样的提示引导至
  `kb_symbol`。

当智能体仍然回退到 bash 搜索时，轮末的 `[kb update]` 询问（或
`HK2_ENABLE_AUTOUPDATEKB` 下的静默自动更新）会重新同步索引。

> **白名单注意 / 二进制风险**：`ast_grep` 与 `ast_edit` 使用同一个
> `SOURCE_EXT_RE` 启发式白名单过滤文件，而该白名单同样匹配文档格式
> （`.md`、`.json`、`.pdf`、`.docx`……）。它们因此可能把这类文件当作
> UTF-8 文本读取；对包含文档/二进制文件的目录树执行目录级 `ast_edit`，
> 理论上可能产生错误匹配与破坏性重写。目录级重写请限定在明确的文本
> 源码集合。（两者均为正则近似，非真正 AST 边界匹配——见"暂缓的能力"。）

## 模式语法（`ast_grep` / `ast_edit`）

| 记号 | 含义 |
|---|---|
| `$$$IDENT` | 多通配符捕获——匹配任意文本（多行、非贪婪）。`IDENT` 被捕获到 `meta.IDENT` 以便替换。 |
| `$IDENT` | 单标识符捕获——匹配 `[A-Za-z_][A-Za-z0-9_]*`。 |
| `$_` | 匿名单 token 通配符（不捕获）。 |
| 其他 | 字面文本，按正则转义。 |

示例：

- `ast_grep("console.log($$$)")`——任意 console.log 调用
- `ast_grep("function $NAME($$$)", path="src")`——捕获函数名
- `ast_edit({ops:[{pat:"console.log($$$ARGS)", out:"logger.info($$$ARGS)"}], paths:["src"]})`——把所有 console.log 批量改为 logger.info，参数保留（具名捕获可往返；匿名 `$$$` 不可）

## 陈旧锚点保护（`tag`）

三个不同的东西都被称为 "tag"——请区分：

1. **`read` / `kb_outline` 返回的索引快照 tag**——**索引时记录在 KB 文件
   注册表中的**文件哈希的前 8 位十六进制字符（不是对刚读字节的现算
   哈希；索引之外的文件、或不在工具注册表识别扩展名白名单内的文件，
   没有 tag）。
2. **`edit` 的用户传入 tag**——`edit` 把该快照 tag 与当前磁盘内容的现算
   哈希比对，因此索引过期（文件在上次 `/kb init`/`update` 后变了）时，
   即使文件在你读取之后没有再变，也可能拒绝一次有效编辑。
3. **`ast_edit` 的用户传入单一 tag**——与每个目标文件比对（见上文
   `ast_edit`；仅限单文件重写）。与用户 tag 无关，`ast_edit` 还会为
   proposal 记录各自的逐文件哈希，`resolve` 在应用时复验这些逐文件
   tag。
4. **刷新过期 tag**——被拒绝时，先运行 `/kb update` 再重新
   read/kb_outline 获取更新后的索引标签，或省略 tag。把 tag 回传到后续的
   `edit` 调用（仅限单文件 `ast_edit`）中；若文件自 tag 生成以来已被修改，
   工具将拒绝该变更：

```text
read({path:"src/foo.js"}) -> {tag:"a1b2c3d4", ...}
edit({path:"src/foo.js", old_string:..., new_string:..., tag:"a1b2c3d4"})
  -> 匹配则通过；不匹配则报错："stale tag: file changed since read..."
```

`resolve` 在应用时复验 tag；失败时尝试恢复已写入的文件——尽力而为，
不是事务性保证（回滚写入自身失败会被忽略）。

## 暂缓的能力

以下能力有意**尚未**实现——它们缺乏清晰的知识库优先方案，且需要数千行的
集成工作：

- **LSP 集成**——语言服务器、JSON-RPC 协商、诊断流。知识库符号索引已覆盖
  大多数"IDE 知道什么？"类查询；LSP 仅对实时诊断与跨文件重命名有额外
  价值。
- **DAP 调试**——调试适配器（gdb、lldb-dap、debugpy、dlv）、断点 / 单步 /
  变量协议。范围与 LSP 相当。
- **完整的 hashline 语法**（`SWAP.BLK`、`INS.PRE/POST/HEAD/TAIL`、`MV`、
  `REM`）——v1 仅提供 `tag` 安全机制；完整的行锚定语法待预览 / 接受流程
  验证成熟后再补充。
- **AST 精确的 ast_grep 匹配**——v1 使用正则近似（元变量 → 捕获组）。完全
  对齐 ast-grep 模式（真正的 AST 边界匹配）将逐步迭代。

## 相关文档

- [斜杠命令](slash-commands.md)——*你*可以调用什么
- [知识图谱与检索](../concepts/knowledge-graph-and-retrieval.md)——知识库工具查询什么
- [安全与权限](../guides/security-and-permissions.md)——哪些工具受权限检查、如何检查
