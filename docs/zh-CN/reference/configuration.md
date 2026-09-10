# 配置

[English](../../en/reference/configuration.md) | 简体中文

hk2 磁盘上的配置参考：`HK2_HOME` 目录、模型注册表、项目注册表、项目级设置、
知识库布局、会话记录与日志。解析逻辑位于 `lib/config/home.js`——编辑本页
时，请对照该文件与 `src/slash/model.js` / `src/slash/project.js` 重新核验。

## `HK2_HOME` 目录结构

`HK2_HOME` 默认为 `~/.hk2`，可通过 `HK2_HOME` 环境变量覆盖。创建目录时，hk2
会将目录 chmod 为 0700、存放密钥的文件（`models.json`、`projects.json`）
chmod 为 0600（尽力而为——chmod 失败会被忽略；其他平台未必具备 POSIX 权限
语义）。

```text
~/.hk2/
├── models.json                       # 多提供商模型注册表
├── projects.json                     # 项目注册表 + 当前指针
├── setting.json                      # 全局文件系统权限基线（可选）
├── settings/
│   └── <project-id>/setting.json     # 托管的项目级权限覆盖
├── theme.json                        # 工具卡片颜色自定义（/theme）
├── history.jsonl                     # REPL 输入历史（上限 1000 条）
├── kb/                               # 默认知识库根目录；可由 HK2_KB_DIR 覆盖
│   └── <projectId>/                  # 每个项目的知识库（见下文）
├── sessions/
│   └── <projectId>/
│       ├── taskstate.json            # 中断任务状态（--resume 时还原）
│       ├── <sessionId>.jsonl         # 会话记录（JSONL）
│       └── <sessionId>.facts.json    # 会话事实存储（/remember）
└── logs/
```

> 通过 `install.sh` 安装时，`~/.hk2` 同时是源码副本的默认**安装目录**。
> 重装时的数据保留行为见[安装](../getting-started/installation.md)。

## `models.json`

```json
{
  "providers": {
    "local": {
      "api": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "sk-example",
      "models": [
        {
          "id": "mymodel",
          "name": "mymodel",
          "contextWindow": 131072,
          "maxTokens": 32768,
          "temperature": 0.2,
          "reasoning": true,
          "modelType": "generic",
          "modelOptions": {}
        }
      ]
    },
    "anthropic": {
      "api": "anthropic",
      "apiKey": "sk-example",
      "models": [
        { "id": "claude-opus-4-8", "name": "claude-opus-4-8", "contextWindow": 200000, "maxTokens": 32000, "reasoning": true }
      ]
    }
  },
  "default": "local/mymodel"
}
```

字段说明：

- `api`——提供商级方言：`openai` 或 `anthropic`。
- `id`——`provider/id` 中的引用键；可携带尾部上下文窗口提示如 `[1m]`。
- `name`——实际发送到 API 请求体的模型代码；请设为提供商期望的精确
  字符串。将提示后缀保留在 `id` 上，`name` 只填写提供商要求的模型名称，可避免网关报“模型代码
  不存在”。
- `modelType`——`/model add|set --model-type` 校验的家族声明；默认
  `generic`。`/model types` 列出全部取值。
- `modelOptions`——模型专属的选项对象（如 glm-5.3 家族的
  `{"reasoning_effort":"max"}`），并根据类型声明的特性进行校验。由
  `/model add|set --model-options` 写入；运行时读取的是 `modelOptions`
  键，手工编辑时必须使用这个精确名称。
- 提供商级可选字段：`headers`（每次调用时并入 LLM 配置的额外 HTTP
  头）与导入器元数据 `importedFrom` / `importedAt`（由 Claude Code 首启
  导入写入）。下文的 `mcpServers` 是**模型级**字段，不在提供商级。
- `mcpServers`——可选数组，由 `/model add-mcpserver` 添加的 MCP 服务器挂载
  （类型、名称、含 `$APIKEY` 占位符的 options）。
- `timeout` **不是可持久化字段**——`/model add|set` 没有 `--timeout` 参数。
  运行时解析模型配置时始终从 `HK2_LLMAPI_TIMEOUT_MS` 取得生效超时。

建议通过 `/model` 命令而不是直接编辑文件来修改模型配置——命令会校验类型、参数与
引用。

## `projects.json`

```json
{
  "current": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
  "projects": {
    "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d": {
      "id": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
      "name": "myapp",
      "sourcePath": "/path/to/repo",
      "sourceRoot": "src",
      "includeGlobs": ["**/*.js", "**/*.ts", "**/*.py"],
      "excludeGlobs": ["**/node_modules/**"],
      "extraRoots": [{ "name": "docs", "relRoot": "docs" }],
      "defaultModel": "local/mymodel",
      "phaseModels": { "rewriteQuery": "local/mymodel" },
      "kbBuiltAt": "2026-07-24T16:41:44.248Z",
      "createdAt": "2026-07-24T16:41:43.000Z",
      "updatedAt": "2026-07-24T16:41:44.000Z"
    }
  }
}
```

字段说明：

- `current`——共享注册表的默认项目指针（UUID）；`/project list` 用 `*`
标记它，`/project set current` 修改它。`hk2 --project=<名称>` /
  `--project-id=<id>` 只为该会话固定项目，不改写该指针；多个进程可同时各自固定
  不同的项目。
- `sourcePath`——项目所在路径；`sourceRoot`——被索引的子目录（为空时整棵
  树）。
- `includeGlobs` / `excludeGlobs`——`/kb init` 使用的 glob 集合；默认值
  覆盖常见源码与文档扩展名。
- `extraRoots`——通过 `/project init --extra=<名称>:<相对路径>,...` 注册的命名
  额外根目录；直接 CLI 的 `--mode=project-init` 不解析此参数。额外根会在主根之外
  一并遍历，每个元素的格式为 `{ "name": "...", "relRoot": "..." }`。
- `defaultModel`——`/model set-default current <ref>` 写入的项目级默认模型
  覆盖；`--clear` 移除。
- `updatedAt`——项目写入时维护的最后修改时间戳。
- `phaseModels`——`/model set-phase` 写入的项目级阶段模型覆盖（存储键为
  `rewriteQuery`、`requestAssess`、`planReview`、`codeReview`）。

## 默认 include / exclude globs

项目未覆盖时，`/kb init` 使用以下默认值（`lib/config/home.js`）。项目的
`includeGlobs`/`excludeGlobs`——经 `/project init --include/--exclude` 或
`/project set include/exclude` 设置——会**整体替换**以下列表，不做合并。

- **Include**——C/C++（`.c .h .cpp .cc .hpp .cxx`）、JS/TS
  （`.js .jsx .mjs .cjs .ts .tsx`）、Python、Go、Rust、Java、Kotlin、
  Scala、Ruby、PHP、Swift、shell（`.sh .bash .zsh`）、lex/yacc（`.y .l`），
  以及文档（`.md .markdown .txt .rst .adoc`，`README*`、`LICENSE*`、
  `CHANGELOG*`、`CONTRIBUTING*`，`.json .yaml .yml .html .htm .sgml .pdf
  .doc .docx .ppt .pptx`）。
- **Exclude**——生成的解析器文件（`gram.c`、`scan.c`、`kwlist.c`）、第三方
  / 构建产物（`node_modules`、`dist`、`build`、`target`、`.venv`、
  `vendor`、`__pycache__`）、版本控制目录（`.git`、`.svn`、`.hg`）与编辑器
  状态（`.idea`、`.vscode`、`.DS_Store`）。

## 知识库布局

```text
$HK2_KB_DIR/<projectId>/  # 默认：$HK2_HOME/kb/<projectId>/
├── meta.json                 # 知识库元数据
├── holy/                     # Holy Space——稳定的知识条目
│   └── <entry-id>.json
├── eden/                     # Eden Space——频繁更新的知识
│   └── <entry-id>.json
├── graph/                    # 知识图谱（Index Space）
│   ├── nodes.json            # id -> 节点记录
│   ├── edges.calls.json      # srcId -> [calleeIds, ...]
│   ├── edges.imports.json
│   ├── edges.inherits.json
│   ├── edges.contains.json
│   ├── by_kind.json          # kind -> [nodeIds, ...]
│   ├── by_qual.json          # qualName -> nodeId
│   └── meta.json             # 计数 + 版本
├── files.json                # Index Space——文件注册表
├── inverted.json             # Index Space——BM25 倒排索引
├── holy.idx.json             # Holy 知识条目的 BM25 索引
├── eden.idx.json             # Eden 知识条目的 BM25 索引
├── doc_index.json            # 解析文档索引（文档引用图）
├── callgraph.json            # Index Space——旧版调用图（由 graph 派生）
├── symbols.0000.json         # Index Space——分片符号表
├── stats.json                # Index Space——构建统计
├── checkpoint.json           # 可恢复构建状态（临时——成功后清除）
├── summaries/                # 每符号摘要（按需）
└── backup/                   # 升级前知识快照
```

解析器管理的文档条目使用 `doc:<relpath>` Eden 命名空间。磁盘文件名会做清理处理，
但条目 id 保留 `doc:` 前缀；文档变化、删除或排除后，`/kb init` 与 `/kb update`
可能覆盖或移除这些条目。手工撰写的文档知识应使用其他 id。

## 会话与日志

- **中断任务状态**——`~/.hk2/sessions/<projectId>/taskstate.json` 持久化
  被中断的任务（原始请求、摘要、计划进度），`--resume` 时还原。
  全新启动时也可加载任务锚点，并暂存未完成计划，直到首个智能体回合选择继续
  任务或开始新任务；见[中断与恢复](../concepts/agent-workflow.md#中断与恢复)。
- **续接分类状态**——`lastCompletedTask` 的原始请求快照仅存在于当前进程内存，
  不写入磁盘。`/session new`、任何恢复操作以及切换到不同项目时会清理它；
  `/project set current` 指向本会话已经绑定的同一项目时是 no-op，不会清理。
  恢复的会话会回退到确定性的会话记录扫描。tier-2 continuation upgrade 由
  `HK2_ENABLE_CONTINUATION_UPGRADE` 与
  `HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE` 控制。
- **会话记录**——`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`。每个成功完成的
  工具轮次会先记录完整 assistant 消息，再记录关联的工具结果，以保留调用/结果
  顺序；最终那条不含工具调用的回答是独立消息。回合还会记录元数据（`assess`、`rewrite`、
  `graph`、`codeReview`、`learned_knowledge`、用量统计）。中断时，已流式显示的
  partial assistant 文本留在屏幕上，不作为完整 assistant 回合写入；悬空的工具调用
  会被清理，中断任务状态单独写入 `taskstate.json`。`--resume` 重放会话记录
  并恢复 task state。`session.lastAnswer` 与代码审查输入只使用最终那条不含工具调用
  的回答；旧版扁平记录只能按原有保真度原样重放。
- **会话事实**——`~/.hk2/sessions/<projectId>/<sessionId>.facts.json` 存放
  经 `/remember` / `remember` 工具记录的、免受压缩影响的事实（每会话上限
  100 条）。`/remember --project` 还会追加到项目级 Eden 条目 `env-facts`
  ——它位于常规知识库布局中，可跨会话检索。
- **日志**——`~/.hk2/logs/`。

## 注册表并发写入

常规模型 / 项目变更辅助函数会在重新读取、修改、写回期间使用对应注册表的
advisory lockfile（`models.json.lock` 与 `projects.json.lock`）。它们会串行化同一
进程的调用，并协调配合该协议的多个 hk2 进程。锁元数据包含 PID、Linux
`/proc` 可用时的进程启动标识，以及随机所有权 token。释放时只有 token 仍匹配
才删除锁；进程死亡、PID 复用与遗留的 recovery gate（恢复关卡）也可被回收。

这层保护只覆盖使用 `withModels()` 或 `withProjects()` 的变更；它不是横跨两个
注册表、知识库文件或手工编辑的事务。锁属于 advisory 机制；无法提供所需独占
创建 / 链接语义的文件系统会降级为不加锁的 last-writer-wins 更新。其他情况下
默认最多重试获取锁 10 秒，随后失败。原子 JSON 替换能避免目标文件处于半写状态，
但不会把这层锁扩展成多文件事务。

Claude Code 首启导入会先做一次不加锁的快速 no-op 检查；真正写入前会在
`models.json` 锁内重新读取，并再次检查当前默认模型与 `claude` provider。因此，
并发发生的用户配置会优先于导入器。

## 权限配置

`setting.json`（全局）与 `settings/<project-id>/setting.json`（项目级）存放
文件系统权限规则。完整语义——最长前缀解析、deny/allow 优先级、符号链接
处理、智能体只读保证——统一在
[安全与权限](../guides/security-and-permissions.md) 中说明，此处不再重复；带
注释的示例见 `setting.example.json`。

## 相关文档

- [模型、项目与会话](../guides/models-projects-and-sessions.md)——这些注册表的日常管理
- [环境变量](environment-variables.md)——`HK2_HOME`、`HK2_KB_DIR` 等
- [安全与权限](../guides/security-and-permissions.md)——权限规则语义
