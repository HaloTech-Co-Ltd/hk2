# 配置

[English](../../en/reference/configuration.md) | 简体中文

hk2 磁盘配置参考：`HK2_HOME` 目录、模型注册表、项目注册表、项目级设置、
知识库布局、会话记录与日志。解析逻辑位于 `lib/config/home.js`——编辑本页
时，请对照该文件与 `src/slash/model.js` / `src/slash/project.js` 重新核验。

## `HK2_HOME` 目录结构

`HK2_HOME` 默认为 `~/.hk2`，可通过 `HK2_HOME` 环境变量覆盖。创建时 hk2
会把目录 chmod 为 0700、存放密钥的文件（`models.json`、`projects.json`）
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
├── kb/                               # HK2_KB_DIR 未设置时才存在
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
- `name`——实际发送到 API 请求体的线上模型代码；请设为服务商期望的精确
  字符串。把提示留在 `id` 上、干净代码写入 `name`，可避免网关报"模型代码
  不存在"。
- `modelType`——`/model add|set --model-type` 校验的家族声明；默认
  `generic`。`/model types` 列出全部取值。
- `modelOptions`——模型特性参数对象（如 glm-5.3 家族的
  `{"reasoning_effort":"max"}`），按类型声明的特性校验。由
  `/model add|set --model-options` 写入；运行时读取的是 `modelOptions`
  键，手工编辑时必须使用这个精确名称。
- 提供商级可选字段：`headers`（随每次调用解析进 LLM 配置的额外 HTTP
  头）与导入器元数据 `importedFrom` / `importedAt`（由 Claude Code 首启
  导入写入）。下文的 `mcpServers` 是**模型级**字段，不在提供商级。
- `mcpServers`——可选数组，由 `/model add-mcpserver` 添加的 MCP 服务器挂载
  （类型、名称、含 `$APIKEY` 占位符的 options）。
- `timeout` **不是可持久化字段**——`/model add|set` 没有 `--timeout` 参数。
  运行时解析模型配置时始终从 `HK2_LLMAPI_TIMEOUT_MS` 取得生效超时。

建议通过 `/model` 命令而非手改文件来编辑模型——命令会校验类型、参数与
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

- `current`——共享 registry 的默认项目指针（UUID）；`/project list` 用 `*`
标记它，`/project set current` 修改它。`hk2 --project=<名称>` /
`--project-id=<id>` 只固定当前会话，不改写该指针；多个进程可以同时使用不同
的 session pin。
- `sourcePath`——项目所在路径；`sourceRoot`——被索引的子目录（为空时整棵
  树）。
- `includeGlobs` / `excludeGlobs`——`/kb init` 使用的 glob 集合；默认值
  覆盖常见源码与文档扩展名。
- `extraRoots`——通过 `--extra=<名称>:<相对路径>,...` 注册的命名额外根；
  在主根之外一并遍历。元素形状为 `{ "name": "...", "relRoot": "..." }`。
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

解析器管理的文档条目使用 `doc:<relpath>` Eden 命名空间。磁盘文件名会被安全化，
但条目 id 保留 `doc:` 前缀；文档变化、删除或排除后，`/kb init` 与 `/kb update`
可能覆盖或移除这些条目。手工撰写的文档知识应使用其他 id。

## 会话与日志

- **中断任务状态**——`~/.hk2/sessions/<projectId>/taskstate.json` 持久化
  被中断的任务（原始请求、摘要、计划进度），`--resume` 时还原。
- **后续分类状态**——`lastCompletedTask` 的原始请求快照仅存在于当前进程内存，
  不写入磁盘，并会由 `/project set current` 清理。恢复的会话会回退到确定性的
  transcript 扫描。tier-2 continuation upgrade 由
  `HK2_ENABLE_CONTINUATION_UPGRADE` 与
  `HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE` 控制。
- **会话记录**——`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`。正常完成的回合
  记录用户消息、工具调用、完整 assistant 回复与元数据（`assess`、`rewrite`、
  `graph`、`codeReview`、`learned_knowledge`、用量统计）。中断时，已流式显示的
  partial assistant 文本留在屏幕上，不作为完整 assistant 回合写入；dangling tool
  call 会清理，中断任务状态单独写入 `taskstate.json`。`--resume` 重放 transcript
  并恢复 task state。
- **会话事实**——`~/.hk2/sessions/<projectId>/<sessionId>.facts.json` 存放
  经 `/remember` / `remember` 工具记录的、免受压缩影响的事实（每会话上限
  100 条）。`/remember --project` 还会追加到项目级 Eden 条目 `env-facts`
  ——它位于常规知识库布局中，可跨会话检索。
- **日志**——`~/.hk2/logs/`。

## 权限配置

`setting.json`（全局）与 `settings/<project-id>/setting.json`（项目级）存放
文件系统权限规则。完整语义——最长前缀解析、deny/allow 优先级、符号链接
处理、智能体只读保证——在
[安全与权限](../guides/security-and-permissions.md) 中只讲一次；带注释的
示例见 `setting.example.json`。

## 相关文档

- [模型、项目与会话](../guides/models-projects-and-sessions.md)——这些注册表的日常管理
- [环境变量](environment-variables.md)——`HK2_HOME`、`HK2_KB_DIR` 等
- [安全与权限](../guides/security-and-permissions.md)——权限规则语义
