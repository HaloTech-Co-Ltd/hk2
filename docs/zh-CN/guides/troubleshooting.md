# 问题排查

[English](../../en/guides/troubleshooting.md) | 简体中文

本页按症状介绍常见问题及修复方法。每个条目给出症状、原因、解决办法与延伸阅读。
这里引用的错误字符串均来自当前代码。

## 安装与解析

### `/kb init` 日志出现 `tree-sitter parse failed`

- **原因**：Tree-sitter 原生绑定缺失、无法加载或与当前平台 / Node ABI 不匹配；
  也可能是跳过或未完成 `npm install`。仅凭该错误无法确定具体原因。
- **解决**：hk2 已自动回退到正则解析器——有回退解析器的语言会以较低符号精度继续；没有回退的语言（尤其是 C#）不产出符号。
  请使用当前仍受支持的 Node 版本（截至 2026 年 9 月首选 Node 24 Active LTS，Node 22 Maintenance
  LTS 可作兼容选择），并在目标平台核验原生绑定；必要时在安装目录（默认
  `~/.hk2`）内执行 `npm rebuild` 从源码重新编译绑定。
- **参见**：[安装](../getting-started/installation.md)、
  [CLI 与语言支持](../reference/cli-and-language-support.md)。

### 安装器输出 "Warning: npm install failed"

- **原因**：`npm install --omit=optional` 中途失败（例如网络或工具链问题），
  因此复制出的安装目录可能缺少或未完成原生依赖。
- **解决**：解决底层问题后，进入实际安装目录（默认 `~/.hk2`；若设置了
  `HK2_INSTALL_DIR` 请进入该目录）执行 `npm install`。
  向 `install.sh` 传 `--no-npm-install` 则是有意跳过该步骤。

### 启动时出现 "AST dispatcher: tree-sitter not available" 警告

- **原因**：`tree-sitter` 包完全不可加载（未安装、使用了
  `--no-npm-install`，或原生包无法加载）。
- **解决**：在实际安装目录执行 `npm install`。该警告仅为提示；有正则回退的语言
  以较低精度继续解析，没有回退的语言（尤其是 C#）在绑定恢复前不产出符号。

## 模型与提供商

### "No model configured" / REPL 拒绝与模型对话

- **原因**：`models.json` 中没有可解析的默认模型（默认值缺失或其提供商 / 模型
  引用已过期）。
- **解决**：先执行 `/model add <provider> <id> ...`，然后执行
  `/model set-default <provider>/<id>`；也可以在首次运行前导出
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 用来初始化提供商；或者在没有默认模型且
  不存在 `claude` 提供商时运行一次 `hk2 --tui`，从 Claude Code 配置导入。
- **参见**：[模型、项目与会话](models-projects-and-sessions.md)。

### 提供商报"模型代码不存在"类错误

- **原因**：发送的 `name` 带有网关拒绝的修饰（如 `mymodel[1m]`）。
- **解决**：把上下文窗口提示保留在 `id` 上，用
  `/model set <ref> --name=<code>` 把 `name` 设为精确的线上代码。
- **参见**：[模型、项目与会话](models-projects-and-sessions.md#id-与-name)。

### LLM 调用超时或提供商很慢

- **原因**：默认超时已相当宽松（通用 3600 秒，改写 / 评估 300 秒），但慢速
  推理模型仍可能超过 `/kb knowledge learn` 的 300 秒规划预算。
- **解决**：learn 命令加 `--plan-timeout-ms=600000`，或设置
  `HK2_PLAN_TIMEOUT_MS`；用 `HK2_LLMAPI_TIMEOUT_MS` /
  `HK2_LLMAPI_TIMEOUT_MS_SIMPLE` 全局调整（没有 per-call 或 per-model 超时覆盖时，显式 `0`
  才对这两个 LLM 超时变量表示“不设超时”；`HK2_PLAN_TIMEOUT_MS` 的 `0` 会回到默认值）。
- **参见**：[环境变量](../reference/environment-variables.md)。

### 瞬时失败自动重试——请求会不会执行两次？

- **症状**：请求以 HTTP 500/502/503/504 或途中的传输层错误失败后重试。
- **原因**：请求*可能已经执行*的失败（请求发出后的 HTTP 5xx）默认重试
  （`HK2_LLM_RETRY_UNKNOWN_POST=1`）——对交互式使用而言，整轮任务报废比
  偶发重复请求更糟。提供商无幂等键。连接建立失败与 HTTP 408/429 属于
  结果确定安全的失败，始终重试。
- **解决**（若在意重复计费）：设 `HK2_LLM_RETRY_UNKNOWN_POST=0`。重试次数
  受 `HK2_LLMAPI_NUMOFRETRIES`（默认 10）约束。
- **参见**：[环境变量](../reference/environment-variables.md)。

### 阶段模型不可达 / 引用过期

- **过期 / 无法解析的 ref**：不会输出告警；`resolveModelRef` 返回 `null` 时，
  阶段静默使用会话模型。配置中的 ref 仍保留，也不增加 fallback/skip 审计事件。
- **解析异常**：调用方告警并使用会话模型；这不同于过期 ref 返回 `null`。
- **已解析模型的调用失败**：`HK2_ENABLE_PHASEMODEL_FALLBACK`（默认 1）让
  `rewrite-query` / `request-assess` 改用会话模型重跑；设为 0 则告警并跳过。
  审查阶段（`plan-review`、`code-review`）告警并跳过，不替换审查者。这些
  fallback/skip 结果会记入会话记录。
- **解决**：用 `/model list` 检查阶段引用，或用
  `/model set-phase --phase=<name> --clear` 清除覆盖。

### 后续输入被当成新任务

- **原因**：未命中 tier-1 确定性后续规则。tier-2 continuation upgrade 只有在
  请求评估实际运行、启用 `HK2_ENABLE_CONTINUATION_UPGRADE`、assessor 返回
  `followup:true` 且达到 `HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE`（默认 `0.6`），
  并存在可供后续输入引用的先前会话上下文（计划、`lastTask` 或先前对话）时才运行。
  快速通道输入会跳过评估，
  不使用 tier 2。
- **解决**：检查 `HK2_ENABLE_FOLLOWUP_FASTLANE`、
  `HK2_ENABLE_CONTINUATION_UPGRADE` 与置信度阈值。升级复用已有的开启推理的评估
  结果，不增加 LLM 调用。

### 以 `/` 开头的路径被当成命令

- **原因**：只有符合 `^/[A-Za-z][A-Za-z0-9_-]*$` 的单段 ASCII 命令头才具有命令形状。
  `/tmp/example.md` 等路径与路径粘连的正文属于普通输入；`/mdoel` 是命令形状的
  拼写错误，可能得到建议。
- **解决**：将路径样式内容作为普通文本输入。共享守卫覆盖分发、任务中捕获和多行
  粘贴收集。

## 项目与知识库

### "KB not built for project <name>. Run /kb init before chatting."

- **原因**：hk2 以知识库为基础；对话前必须先初始化知识库。
- **解决**：执行 `/kb init`。若项目尚未注册：先
  `/project init --name=... --source=...`。
- **参见**：[快速开始](../getting-started/quick-start.md)。

### `/kb update` 触发全量重建

- **原因**：hk2 版本之间存储的解析器版本发生变化——为保证正确性必须
  全量重建。旧版布局迁移会先把知识条目备份到
  `backup/pre-upgrade-<ts>/`，再按当前迁移代码处理。
- **解决**：无需额外处理，等待其完成即可。

### `/kb knowledge learn` 规划似乎卡住后失败

- **原因**：阶段 1 规划的 LLM 调用超过 300 秒预算，或返回了不可用的计划。
- **解决**：hk2 会先关闭推理后重试一次。在代码模式中，接受的计划会按原结果执行，
  不会自动补回遗漏文件；计划不可用或被丢弃时回退到保证覆盖所选范围内全部索引文件的确定性
  目录分组。文档模式会核对批次是否覆盖每个成功读取、解析且非空的研读分片，并为规划遗漏的文件
  补充单文件批次。其他错误仍可能终止运行或跳过内容。慢速提供商可提高预算：
  `--plan-timeout-ms=600000` 或 `HK2_PLAN_TIMEOUT_MS`。
- **参见**：[知识库工作流](knowledge-workflows.md)。

### `/kb init` 被中断——进度会丢吗？

- **不需要从零开始。**每 N 个文件保存一次检查点（默认 100）；重新运行
  `/kb init` 会从*最近一次*检查点恢复。最近检查点之后、下一次保存之前已
  处理的文件会在恢复时重新处理；若中断发生在首个检查点之前，则还没有任何
  已保存进度。`--no-resume` 从头开始，`--no-checkpoint` 禁用检查点。

## 前端

### TUI 带提示回落到 REPL

- **消息**：`[tui] this terminal does not support the TUI (needs a TTY
  stdin/output and TERM != dumb) — using the line REPL.`
- **原因**：非 TTY 的 stdin / 输出流、`TERM=dumb` 或 CI 控制台。能力检测以 TUI
  实际绘制所用的流为准（默认 stderr，`HK2_TUI_STREAM=stdout` 可切换）。
- **解决**：在真实终端中运行，或继续使用 REPL——两者共享同一套会话、命令
  与管线。
- **参见**：[REPL 与 TUI](repl-and-tui.md)。

### 会话恢复没有还原被中断的计划

- **原因**：仅当 taskstate 中保存的计划还有未完成步骤时才恢复计划面板；已完成
  的计划不会恢复面板（若 taskstate 记录了中断任务，任务上下文仍可能恢复）。
- **解决**：`hk2 --resume` 恢复后，输入继续指令（`continue`）——已保存的
  任务上下文会被注入，智能体会继续而不是重开。
- **参见**：[智能体工作流](../concepts/agent-workflow.md#中断与恢复)。

## 权限

### `permission denied: <path>: denied by setting.json <layer> rule at <rule path>`

- **原因**：路径在项目根之外且没有 `allow` 规则覆盖，或某条 `deny` 规则以
  更长前缀命中。
- **解决**：向 `~/.hk2/setting.json`（全局）或
  `~/.hk2/settings/<project-id>/setting.json`（项目级）添加 `allow` 规则。
  记住：最长前缀优先；同前缀时项目层压过全局、`deny` 压过 `allow`。
- **参见**：[安全与权限](security-and-permissions.md)。

### 项目内的符号链接被拒绝

- **原因**：它实际指向项目之外的位置；真实路径按同一套规则复验。
- **解决**：为*真实*目标路径添加 `allow` 规则（两种拼写均可匹配）。

### 配置规则被忽略并出现加载告警

- **原因**：条目非法——权限字符错误（如 `"allow": "q"`）、缺少
  `allow`/`deny`、或两者同时存在。仅丢弃该条目；其余规则继续生效。
- **解决**：修正被点名的条目。项目根内的 `setting.json` 被忽略是设计行为
  ——请把它移到 `~/.hk2/settings/<project-id>/setting.json`。

## 调试

- `HK2_DEBUG`——设为任意非空值即可打印错误堆栈（斜杠命令出错时同样打印）。
- `HK2_ASCII`——设为任意非空值即可在非 UTF-8 终端上强制使用 ASCII 字符。
- `HK2_NO_COLOR` 或 `NO_COLOR`——设为任意非空值即可禁用 ANSI 颜色（`0` 也算）；
  需要颜色时请移除这些覆盖设置。
- 日志位于 `~/.hk2/logs/`；会话记录（含 `assess`、`rewrite`、`graph`、
  `codeReview` 等轮次元数据）位于 `~/.hk2/sessions/<projectId>/`。

## 相关文档

- [安装](../getting-started/installation.md)
- [安全与权限](security-and-permissions.md)
- [环境变量](../reference/environment-variables.md)
