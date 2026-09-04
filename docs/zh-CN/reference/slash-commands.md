# 斜杠命令

[English](../../en/reference/slash-commands.md) | 简体中文

hk2 REPL/TUI 斜杠命令的完整参考。运行时的事实源是 `src/slash/help.js`
（支撑 `/help` 与 `/help <命令>`）——编辑本页时，请对照该文件与
`src/slash/*.js` 中的命令实现重新核验。最新帮助始终可在 hk2 内通过
`/help` 与 `/help <命令>`（如 `/help kb`、`/help knowledge`）查看；每个
命令族也支持 `<命令> help` 下钻（如 `/model help set`、
`/kb knowledge help learn`）。

命令按 shell 风格分词，因此带引号的参数值可以包含空格：
`--title="SPI Extension Pattern"`。

## 命令索引

| 命令 | 用途 |
|---|---|
| [`/model`](#model) | 管理 `models.json`——提供商、模型、默认值、阶段模型、MCP 服务器 |
| [`/project`](#project) | 管理 `projects.json`——注册、列出、切换、重命名、移除 |
| [`/kb`](#kb) | 当前项目的知识库生命周期与查询 |
| [`/kb knowledge`](#kb-knowledge) | 管理知识条目（Holy + Eden） |
| [`/kb code`](#kb-code) | 管理永久的最高准则 |
| [`/session`](#session) | 会话管理 |
| [`/resume`](#resume) | 恢复之前的会话（Claude Code 惯例） |
| [`/remember`](#remember) / [`/forget`](#forget) | 记录 / 删除会话事实（免受压缩影响） |
| [`/review`](#review) | 手动审查已完成的任务 |
| [`/theme`](#theme) | 自定义工具卡片颜色 |
| [`/clear`](#clear) | 清空内存中的对话上下文 |
| [`/compact`](#compact) | 摘要压缩之前的对话 |
| [`/help`](#help) | 显示帮助 |
| [`/quit` / `/exit`](#quit--exit) | 退出（同 Ctrl+D） |

## `/model`

用法：`/model <子命令> [参数]`——管理 `~/.hk2/models.json`。

| 子命令 | 作用 |
|---|---|
| `list` | 列出所有提供商 / 模型（默认项标记 `*`） |
| `use <provider>/<model-id>` | **仅当前会话**切换模型（不持久化） |
| `set-default <provider>/<model-id>` | 设为全局默认（持久化） |
| `set-default current <provider>/<model-id>` | 设置当前项目的默认模型（优先于全局；`--clear` 清除） |
| `set <provider>/<model-id> [--参数]` | 修改持久化配置 |
| `set-phase --phase=<名称> <provider>/<model-id>` | 为某个管线阶段配置项目级模型；`--clear` 清除覆盖 |
| `add <provider> <model-id> [--参数]` | 添加模型（提供商不存在则创建） |
| `add-mcpserver <provider>/<model-id> --type=<t> --name=<n> [--options=JSON]` | 为已有模型挂载 MCP 服务器 |
| `del <provider>/<model-id>` | 删除模型 |
| `types` | 列出所有支持的 `--model-type` 取值 |
| `show` | 显示当前默认模型 |

`set` / `add` 参数：

| 参数 | 含义 |
|---|---|
| `--api=openai\|anthropic` | 提供商 API 方言（提供商级） |
| `--base-url=URL` | API 端点 base URL（提供商级） |
| `--api-key=KEY` | API 密钥（提供商级） |
| `--name=NAME` | 发送给 API 的线上模型代码 |
| `--id=NEW_ID` | （仅 `set`）重命名模型 id / 引用键——不影响线上代码 |
| `--reasoning=on\|off` | 开启 / 关闭推理 |
| `--context-window=N` | 上下文窗口大小（token 数） |
| `--max-tokens=N` | 最大输出 token 数 |
| `--temperature=N` | 采样温度 |
| `--model-type=TYPE` | 模型家族（见 `/model types`；默认 `generic`） |
| `--model-options=JSON` | 模型特性参数，如 `'{"enable_thinking":true}'`；传 `'{}'` 即清空；按类型声明的特性校验 |

`set-phase` 阶段：`rewrite-query`、`request-assess`、`plan-review`、
`code-review`。

`add-mcpserver`：`--type=http` 已实现（`stdio` 预留）；`--name` 在模型内
唯一（重名再添加即替换）。http 的 `--options`：
`{"url":"...","headers":{"Authorization":"Bearer $APIKEY"}}`——`$APIKEY`
在使用时替换为该提供商的 `--api-key`；存储的配置只保留占位符，绝不保存
密钥。

示例：

```bash
/model list
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel
/model set-default current local/mymodel        # 项目默认
/model set-default current --clear
/model set local/mymodel --temperature=0.5 --max-tokens=8192
/model set local/mymodel --id=mymodel-v2        # 重命名引用键
/model set-phase --phase=rewrite-query local/mymodel
/model del local/mymodel
```

## `/project`

用法：`/project <子命令> [参数]`——管理 `~/.hk2/projects.json`。

| 子命令 | 作用 |
|---|---|
| `init [--name=<名称>] --source=<路径> [--source-root=<相对路径>] [--include=...] [--exclude=...] [--extra=...]` | 注册新项目（生成 UUID） |
| `list` | 列出所有项目（当前项标记 `*`） |
| `set current <id\|名称>` | 切换当前项目——把当前会话保存到原项目下并在目标项目开启新会话；切到当前已选中的项目为空操作 |
| `set name <新名称>` | 重命名当前项目 |
| `set source <路径>` | 更新源码路径 |
| `set source-root <相对路径>` | 更新被索引的子根 |
| `set include <glob1,glob2,...>` | **整体替换** include glob 集合（默认集合被丢弃） |
| `set exclude <glob1,glob2,...>` | **整体替换** exclude glob 集合（默认集合被丢弃） |
| `show` | 显示当前项目配置 |
| `drop <id\|名称>` | 移除项目注册——**没有确认提示**。知识库目录以旧 UUID 成为孤立目录保留，重新注册同一路径**不会**接回（新 UUID）；见[模型、项目与会话](../guides/models-projects-and-sessions.md#项目) |

`init` 参数：`--name`（默认取目录名）、`--source`（必填）、`--source-root`
（被索引子目录，默认整棵树）、`--include`/`--exclude`（逗号分隔 globs，
**整体替换**默认集合——见
[模型、项目与会话](../guides/models-projects-and-sessions.md#项目)）、
`--extra=<名称>:<相对路径>,...`（命名额外根，如 `docs:docs,spec:spec`）。

## `/kb`

用法：`/kb <子命令> [参数]`——当前项目知识库的生命周期与查询。所有命令
作用于当前项目。

| 子命令 | 作用 |
|---|---|
| `init [--full] [--checkpoint-interval=N] [--no-checkpoint] [--no-resume] [--skip-summary]` | 构建知识库——当前实现**始终全量重索引**（`--full` 被接受但为冗余参数；增量请用 `/kb update`），带检查点、可恢复；已配置模型且未传 `--skip-summary` 时生成 LLM 摘要条目 |
| `update` | 增量更新（sha256 差异）——重建派生的符号索引与图谱，并**同步解析器管理的 `doc:<relpath>` Eden 条目**（新增/变化文档写入或覆盖，已删除或被排除文档的 parser-owned 条目被移除，Eden 知识索引可能重建）；旧版知识库先备份到 `backup/pre-upgrade-<ts>/` 再迁移；解析器版本变化触发全量重建 |
| `status` | 各空间统计 |
| `search <查询> [--top-k=N]` | BM25 + 重排序的符号搜索 |
| `symbol <名称>` | 按精确名称查找符号 |
| `neighbors <symbol_id>` | 调用图邻居（符号 id 形如 `<fileId>:<line>`） |
| `knowledge <子命令> [...]` | 见 [`/kb knowledge`](#kb-knowledge) |
| `code <子命令> [...]` | 见 [`/kb code`](#kb-code) |
| `transform <id> <from> <to>` | 在 holy/eden 之间移动条目（需确认） |
| `drop` | 删除整个知识库（需确认） |

## `/kb knowledge`

用法：`/kb knowledge <子命令> [参数]`。

| 子命令 | 作用 |
|---|---|
| `list [--space=holy\|eden]` | 列出条目（默认两个空间） |
| `show <id>` | 显示条目全文（同时检索两个空间） |
| `add [--space=holy\|eden] --title=<t> [--id=<id>] (--intro=<文本> \| --intro-file=<路径>) [--key-files=<a,b>] [--key-symbols=<a,b>] [--keywords=<a,b>]` | 手动持久化条目（默认 holy） |
| `learn [--space=eden\|holy] [--file=<路径>] [--base-dir=<目录>] [--per-batch-chars=N] [--dry-run] [--no-survey] [--model=<provider>/<model-id>] [--plan-timeout-ms=N] [指令...]` | 统一的 LLM 深度研读（DOC 或 CODE 模式）——见下文 |
| `housekeep <eden\|holy\|all> [--model=<provider>/<model-id>]` | LLM 辅助：破损条目扫描、重复 / 相近条目合并（y/N）、Eden↔Holy 冲突裁决（`all`，逐对选择）。绝不触碰最高准则；有变更则重建索引 |
| `empty <eden\|holy\|all>` | 删除所选空间的全部**普通**条目；永久的最高准则条目会被保留——不可逆，始终确认 y/N |
| `export <eden\|holy\|all> <路径>` | 导出条目为 JSON（版本 2，每条带 `space` 标签） |
| `import <路径> [eden\|holy\|adaptive] [--overwrite]` | 导入条目；`adaptive` 按原始空间路由；导入 Holy 始终提示 y/N |
| `del <id>` | 删除单个条目（需确认） |

`learn` 自动选择模式：**文档模式（DOC mode）**（`--file`，或 `--base-dir`
指向文档）深度研读 Markdown / PDF / Word / PowerPoint / 文本文件并写入所选
空间（文件可在项目之外）；**代码模式（CODE mode）**（裸调用，或
`--base-dir` 为已索引子目录）研读已索引源码——可选的阶段 0 概览（仅当
非 `--dry-run`、无 `--base-dir`、无 `--no-survey` 时运行）、阶段 1 主题
规划、阶段 2 提取。默认 `HK2_KB_LEARN_VALIDATE=1` 时候选条目写入前对照现有知识库校验
（设 `0` 改走旧式启发式路径）。参数：`--space`（默认 eden；代码模式始终
写 Eden）、`--file`、`--base-dir`、`--per-batch-chars`（默认 100000）、
`--dry-run`、`--no-survey`（跳过阶段 0）、`--model`、`--plan-timeout-ms`
（默认 300000），以及传入每个 LLM 提示词的自由格式尾部指令。

别名：`ls`→list、`get`→show、`create`/`set`→add、
`study`/`init`/`bootstrap`/`scan`→learn、
`housekeeping`/`cleanup`/`clean`→housekeep、`clear`/`wipe`→empty、
`rm`→del。

## `/kb code`

用法：`/kb code <子命令> [参数]`——管理最高准则条目 `hk2-supreme-code`。
该条目永远不能被删除、重命名、移动或自动更新；条目内容只能在此修改，每次
写入都需显式 y/N 确认。限制：最多 100 条、每条 200 字符，编号 1..N 连续
无空洞（省略编号的 `add` 追加为 N+1；编号 > N+1 被拒绝）。

| 子命令 | 作用 |
|---|---|
| `list` | 查看全部规则 |
| `add [code-id] (--code-content=<文本> \| --code-gen=<指令>) [--model=<provider>/<model-id>]` | 添加或更新一条规则（`--code-content` 原样写入；`--code-gen` 请模型起草一条，经清洗与确认后写入） |
| `del <code-id>` | 删除一条；后续条目自动上移 |

## `/session`

用法：`/session <子命令> [参数]`。会话以 JSONL 存储在
`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`。

| 子命令 | 作用 |
|---|---|
| `info [<sessionId>]` | 会话信息——无 id 显示当前会话；有 id 显示已存会话的统计（支持唯一前缀匹配） |
| `list [--limit=N]` | 当前项目的最近会话（默认 20） |
| `new` | 开始新会话（全新记录） |
| `resume [<sessionId>]` | 恢复之前的会话（完整还原上下文）；无 id 时恢复项目最近一次之前的会话 |
| `compact` | 手动压缩对话（同 `/compact`） |

## `/resume`

用法：`/resume [<sessionId>]`——重新打开之前会话的记录并还原完整对话上下
文（消息、工具调用历史、中断任务状态）。无 id：项目最近一次之前的会话。
等价于 `/session resume`——Claude Code 的惯例。

## `/remember`

用法：`/remember [事实] [--project|-p]`——记录一条整个会话始终在上下文
内、且免受压缩影响的会话事实。

- 无参数——列出已记录的事实。
- 带事实——持久化该条（每会话上限 100 条，每条裁剪到 500 字符；规范化
  去重）。事实通过一条常驻的 `## Session facts` system 消息注入后续每一
  轮，并实时刷新。
- `--project` / `-p`——同时把事实追加到项目级 Eden 条目 `env-facts`
  （跨会话，可被 `kb_search_knowledge` 检索；上限 200 行，追加时去重）。
- 需要处于活动项目会话中；没有则干净地拒绝。

事实用于环境信息 / 约束 / 偏好（端点、端口、版本、账号名——绝不包括
密钥本身）；可复用的代码知识属于知识库（`kb_save_knowledge`、
`/kb knowledge add`）。智能体有对应的 `remember` 工具，压缩时也会运行
一次事实抽取。

## `/forget`

用法：`/forget [子串]`——删除会话事实。

- 带子串——删除所有包含该子串的事实；打印删除了多少条、剩多少条。
- 无参数——y/N 确认后删除**全部**事实。
- 无匹配——打印当前事实列表，便于选择子串。

## `/review`

用法：`/review <阶段> [--model=<provider>/<model-id>]`——手动审查当前会话
中刚完成的任务。

| 阶段 | 状态 |
|---|---|
| `code` | 已实现——对已完成任务的手动代码审查 |
| `plan` | 尚未实现 |

只有原始任务请求与完成结果（最终回答 + 变更文件 + 工作区 diff）会发送给
审查模型——实现上下文被忽略，因此无法影响审查（全新视角的回归检查）。
审查过程实时流式展示；无法解析出判定时显式报 UNKNOWN，绝不伪装成"未发现
问题"。`--model` 覆盖阶段配置的模型
（`/model set-phase --phase=code-review`），其次会话模型。

## `/theme`

用法：`/theme <子命令> [参数]`——自定义工具卡片边框 / 标题颜色
（`~/.hk2/theme.json`）。

| 子命令 | 作用 |
|---|---|
| `list` | 列出当前颜色与内置默认值（默认动作） |
| `set <key> <color>` | 设置并持久化颜色 |
| `reset [key]` | 重置单个 key，无参数重置整个自定义主题 |
| `preview` | 以当前颜色打印三组内置分组的示例卡片 |
| `title-follow [on\|off]` | 切换顶边标题跟随边框颜色（而非固定 muted 色调） |

key（解析优先级：精确工具名 > 分组 key > `*` > 内置默认）：`bash`（精确
工具名）、`kb_*`（任何 `kb_` 前缀工具）、`*`（其他工具），或精确工具名如
`read`。颜色：`#rrggbb` 真彩色、`ansi:0-255` 调色板，或内置 token
（`accent`、`muted`、`dim`、`success`、`error`、`warning`、`border`、
`bashMode`、`pythonMode`）。

## `/clear`

清空当前内存中的对话上下文（LLM 看到全新历史）。磁盘上的会话记录保留；
用 `/session list` 浏览历史会话，`/session resume <id>` 重新打开。

## `/compact`

把之前的对话总结为简短摘要并以此替代完整历史继续——在长会话中释放上下文
空间。等价于 `/session compact`。轮次边界的自动压缩默认开启
（`HK2_ENABLE_AUTOCOMPACT`）；对话被总结掉之前会先抽取持久会话事实
（见 [`/remember`](#remember)）。

## `/help`

`/help` 列出全部命令；`/help <命令>` 打印单个命令族的完整用法、参数与
示例。同样的文本可通过 `<命令> help` 查看（如
`/model help set-phase`）。

## `/quit` / `/exit`

退出 REPL。同 Ctrl+D。`/exit` 是 `/quit` 的别名。

## 相关文档

- [REPL 与 TUI](../guides/repl-and-tui.md)——命令在哪里运行、如何补全
- [智能体工具](agent-tools.md)——*智能体*（而非你）可以调用什么
- [环境变量](environment-variables.md)——控制相关行为的开关
