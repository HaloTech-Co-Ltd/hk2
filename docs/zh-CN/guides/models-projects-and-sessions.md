# 模型、项目与会话

[English](../../en/guides/models-projects-and-sessions.md) | 简体中文

本指南讲解塑造一次 hk2 会话的三个注册表：多提供商模型注册表
（`models.json`）、项目注册表（`projects.json`）与会话记录——外加阶段模型、
Claude Code 首启导入与 MCP 服务器。完整参数参考见
[斜杠命令](../reference/slash-commands.md)；文件布局见[配置](../reference/configuration.md)。

## 提供商与模型

**提供商（provider）**是一个端点：一种 API 方言（`openai` 或
`anthropic`）、一个 base URL 与一个 API 密钥。**模型（model）**是提供商
下的一个条目，拥有独立的调优参数。引用一律使用 `<provider>/<model-id>`
形式，如 `local/mymodel`。

- hk2 支持两种 API 方言：OpenAI 兼容的 chat-completions 协议
  （`--api=openai`，自建网关的常见选择）与 Anthropic messages 协议
  （`--api=anthropic`）。
- 一份安装可管理多个提供商与模型。

### `id` 与 `name`

每个模型有 `id` 和 `name`：

- `id`——`provider/id` 引用中的索引键；可携带尾部括号形式的上下文窗口
  提示（如 `[1m]`）。
- `name`——实际**发送到 API 请求体**的模型代码（请求中的 `model` 字段）。
  请设为服务商期望的精确字符串（如 `mymodel`，而非 `MY MODEL`）。

把提示后缀保留在 `id` 上、把干净代码写入 `name`，可避免部分网关拒绝
`mymodel[1m]` 之类的 `model` 值而报"模型代码不存在"错误。`/model set
--id=NEW_ID` 只重命名引用键——线上的 `name` 不受影响。

### 默认模型解析顺序

1. **会话模型**——`/model use <ref>`（仅当前会话，不持久化）
2. **项目默认**——`/model set-default current <ref>`（覆盖该项目内的全局
   默认；`--clear` 清除）
3. **全局默认**——`/model set-default <ref>`（持久化在 `models.json`）

## 配置模型

```text
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example --context-window=128000
/model set-default local/mymodel
/model list
/model show
```

常用参数（完整列表见[斜杠命令](../reference/slash-commands.md)）：

| 参数 | 含义 |
|---|---|
| `--api=openai\|anthropic` | 提供商 API 方言（提供商级） |
| `--base-url=URL` | API 端点 base URL（提供商级） |
| `--api-key=KEY` | API 密钥（提供商级） |
| `--name=NAME` | 发送给 API 的线上模型代码 |
| `--reasoning=on\|off` | 开启 / 关闭推理 |
| `--context-window=N` | 上下文窗口大小（token 数） |
| `--max-tokens=N` | 最大输出 token 数 |
| `--temperature=N` | 采样温度 |
| `--model-type=TYPE` | 模型家族（`/model types` 列出全部取值） |
| `--model-options=JSON` | 模型特性参数，如 `'{"enable_thinking":true}'` |

`--model-type` 声明模型家族，hk2 据此应用家族专属行为。声明了特性的类型会
校验 `--model-options` 取值——例如 `--model-type=glm-5.3`（与
`glm-5.3-flash`）接受 `{"reasoning_effort":"max"}`，默认且推荐 max（深度
推理），可选 high（增强）/ low（轻度）。省略该参数（或旧记录缺少该字段）
默认 `generic`；传入**未知**类型会被命令拒绝。

除手动录入外，模型注册表文件**首次创建时**，环境中的 `ANTHROPIC_API_KEY`
或 `OPENAI_API_KEY` 会种子化对应的提供商——之后的启动不会重新扫描或追加。

## 阶段模型

四个管线阶段可以为每个项目单独使用不同于会话模型的模型：

| 阶段 | 运行内容 |
|---|---|
| `rewrite-query` | BM25 检索前的查询改写 |
| `request-assess` | 请求清晰度评估 |
| `plan-review` | 已确认计划的复审（`HK2_ENABLE_PLANREVIEW=1`） |
| `code-review` | 已完成任务的审查（`HK2_ENABLE_CODEREVIEW=1` 与 `/review code`） |

```text
/model set-phase --phase=rewrite-query local/mymodel
/model set-phase --phase=code-review --clear
```

未设置时阶段使用会话模型。两类不同的失败：

- **过期 / 无法解析的注册表引用**（未知提供商或模型——`resolveModelRef`
  返回 null）：当前被**静默**视为"未配置覆盖"——阶段直接使用会话模型，
  无告警、也不走 fallback/skip 路径，该引用形同消失。
- **解析成功但调用失败**（传输 / HTTP / 超时）：`rewrite-query` /
  `request-assess` 按 `HK2_ENABLE_PHASEMODEL_FALLBACK` 处理（默认告警并
  改用会话模型重跑；`0` = 告警并跳过）；审查阶段始终只告警并跳过，绝不
  静默替换审查者。

见[规划与审查](planning-and-review.md)；静默的过期引用行为是已知限制。

## Claude Code 首启导入

未配置任何模型时，`hk2 --tui` 会自动从 Claude Code 的
`~/.claude/settings.json` 导入一个模型——取 `env` 块的
`ANTHROPIC_BASE_URL` 加 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`，
模型列表来自 `ANTHROPIC_DEFAULT_*_MODEL`。欢迎卡下方会显示导入提示。

- **仅填充**——已有默认模型时绝不覆盖。
- **幂等**——第二次启动若没有 Claude 配置则为空操作。
- **开关**——`HK2_AUTOIMPORT_CLAUDE=0` 禁用导入。

Anthropic 适配器同时发送 `x-api-key` 与 `Authorization: Bearer`，因此
`ANTHROPIC_AUTH_TOKEN` 类网关无需改动即可通过认证。

## MCP 服务器

为模型挂载 Model Context Protocol 服务器；其工具以
`mcp__<name>__<tool>` 形式提供给智能体：

```text
/model add-mcpserver local/mymodel --type=http --name=web-reader \
  --options='{"url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer $APIKEY"}}'
```

- `--type=http` 已实现；`stdio` 为预留。
- `--name` 在模型内唯一；重名再添加会替换该服务器。
- options 中的 `$APIKEY` 在**使用时**替换为该提供商的 `--api-key`——存储的
  配置只保留占位符，绝不保存密钥。
- 每个智能体回合在内置工具之后挂载 MCP 工具；不可达的服务器跳过并警告。

## 项目

项目注册在 `~/.hk2/projects.json`，使用生成的 UUID。`current` 是共享 registry
中的默认项目指针：`/project list` 用 `*` 标记，`/project set current` 修改它。
`hk2 --project=<名称>` 与 `--project-id=<id>` 只固定当前会话，因此会话 pin 可以
不同于共享指针，多个进程也可使用不同 pin。

```text
/project init --name=myapp --source=/path/to/repo --source-root=src
/project list
/project set current <id|name>
/project set name new-name
/project set source /new/path
/project set source-root src
/project set include <完整glob列表并加上你的新增项>
/project set exclude <完整glob列表并加上你的新增项>   # 两者都会整体替换默认集合
/project show
/project drop myapp
```

注册参数（`/project init`）：

| 参数 | 含义 |
|---|---|
| `--name=<name>` | 显示名称（默认取目录名） |
| `--source=<path>` | 源码路径（必填） |
| `--source-root=<rel>` | 被索引的子目录（如 `src`）；默认整棵树 |
| `--include=<globs>` | 逗号分隔的 include globs——**整体替换默认集合**（见下方警告） |
| `--exclude=<globs>` | 逗号分隔的 exclude globs——**整体替换默认集合**（见下方警告） |
| `--extra=<name>:<rel>,...` | 命名的额外根，如 `docs:docs,spec:spec` |

- **`sourceRoot` / `extraRoots`**——项目的被索引根。主源码根与所有命名
  额外根都会被 `/kb init` 遍历。
- **include/exclude globs——整体替换，不是追加。**传入任一项都会完整替换
  该项目的默认 glob 列表（`/project set include` / `set exclude` 同样覆盖
  整个数组）。因此 `/project init --include=**/*.cs` 只会扫描 `.cs` 文件，
  而 `/project set exclude vendor/**` 会静默丢掉默认的 `node_modules` /
  `.git` / 构建产物排除项。要新增扩展名，请从
  [配置](../reference/configuration.md) 复制默认集合并自行追加。
- **切换**——`/project set current` 把当前会话保存到原项目下，并在目标
  项目上开启新会话（等同 `/quit` 后 `hk2 --project=<目标>`）；切到当前已
  选中的项目为空操作。
- **`/project drop`** 移除注册时**没有确认提示**。知识库目录会留在磁盘上，
  但它挂在项目 UUID 之下——由于 `/project init` 每次生成**新的 UUID**，
  重新注册同一路径**不会**自动接回旧知识库，而是从新库开始。旧目录成为
  `$HK2_KB_DIR/<旧 UUID>/` 下的孤立目录（默认根目录为 `$HK2_HOME/kb/`；需要的话请手动删除）。目前要复用
  旧库只能恢复带原 UUID 的原项目记录，CLI 尚无对应命令。

同样的注册也可在 shell 中完成：
`hk2 --mode=project-init --name=myapp --source=/path/to/repo`。

### 共享 current 指针与会话 pin

`projects.json.current` 是共享 registry 的默认项目指针；`/project list` 用 `*` 标记它，
`/project set current` 修改它并切换当前交互会话。`hk2 --project=<name>` 与
`--project-id=<id>` 只固定当前会话，不修改共享指针。因此 session pin 可以不同于
`current`，多个进程可以同时使用不同 pin。

## 会话

会话以 JSONL 记录存储在
`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`。

```text
/session info
/session list --limit=5
/session new
/session resume            # 最近一次之前的会话
/session resume 3f9c1a2e   # 按 id（支持唯一前缀匹配）
/compact                   # 摘要压缩之前的对话
```

- `hk2 --resume`（可选 `--resume <id>`）在启动时恢复会话，还原完整对话
  上下文、工具调用历史与中断任务状态。配合 `--project`/`--project-id`
  可恢复其他项目的会话。
- `/session compact` 与 `/compact` 把之前的对话总结为简短摘要以释放上下文
  空间；自动压缩默认开启（`HK2_ENABLE_AUTOCOMPACT`，见
  [环境变量](../reference/environment-variables.md)）。
- `/remember <事实>` 成功持久化后，会把环境事实保持在整个会话上下文内并按设计免受
  压缩影响；`/forget` 删除它。见
  [斜杠命令](../reference/slash-commands.md#remember)。
- `/clear` 只清空内存中的上下文——磁盘上的会话记录保留，之后可恢复。

## 相关文档

- [斜杠命令](../reference/slash-commands.md)——完整的 `/model`、`/project`、`/session` 参考
- [配置](../reference/configuration.md)——`models.json` / `projects.json` 结构
- [REPL 与 TUI](repl-and-tui.md)——这些命令的使用场景
