# 问题排查

[English](../../en/guides/troubleshooting.md) | 简体中文

以症状为线索的常见问题修复。每个条目给出症状、原因、解决办法与延伸阅读。
此处引用的错误字符串均来自当前发布的代码。

## 安装与解析

### `/kb init` 日志出现 `tree-sitter parse failed`

- **原因**：Tree-sitter 原生绑定缺失或 ABI 不匹配——通常是过新的 Node
  版本（如 Node 25+）对上预编译二进制，或跳过了 `npm install`。
- **解决**：hk2 已自动回退到正则解析器——有回退解析器的语言以较低符号精度继续；没有回退的语言（尤其是 C#）不产出符号。
  要恢复完整精度：改用 Node 20 LTS，或在安装目录（默认 `~/.hk2`）内执行
  `npm rebuild` 从源码重新编译绑定。
- **参见**：[安装](../getting-started/installation.md)、
  [CLI 与语言支持](../reference/cli-and-language-support.md)。

### 安装器输出 "Warning: npm install failed"

- **原因**：`npm install --omit=optional` 中途失败（网络、工具链）——安装
  本身已完成，hk2 以正则解析器运行。
- **解决**：底层问题解决后在 `~/.hk2` 执行 `cd ~/.hk2 && npm install`。
  向 `install.sh` 传 `--no-npm-install` 则是有意跳过该步骤。

### 启动时出现 "AST dispatcher: tree-sitter not available" 警告

- **原因**：`tree-sitter` 包完全不可加载（未安装，或使用了
  `--no-npm-install`）。
- **解决**：在安装目录执行 `npm install`。该警告仅为提示；有正则回退的语言
  以较低精度继续解析，没有回退的语言（尤其是 C#）在绑定恢复前不产出符号。

## 模型与提供商

### "No model configured" / REPL 拒绝与模型对话

- **原因**：`models.json` 中没有默认模型。
- **解决**：`/model add <provider> <id> ...` 然后
  `/model set-default <provider>/<id>`；或在首次运行前导出
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 自动创建提供商；或运行一次
  `hk2 --tui` 从 Claude Code 配置导入。
- **参见**：[模型、项目与会话](models-projects-and-sessions.md)。

### 提供商报"模型代码不存在"类错误

- **原因**：线上 `name` 带了网关拒绝的修饰（如 `mymodel[1m]`）。
- **解决**：把上下文窗口提示保留在 `id` 上，用
  `/model set <ref> --name=<code>` 把 `name` 设为精确的线上代码。
- **参见**：[模型、项目与会话](models-projects-and-sessions.md#id-与-name)。

### LLM 调用超时或提供商很慢

- **原因**：默认超时已相当宽松（通用 3600 秒，改写 / 评估 300 秒），但慢速
  推理模型仍可能超过 `/kb knowledge learn` 的 300 秒规划预算。
- **解决**：learn 命令加 `--plan-timeout-ms=600000`，或设置
  `HK2_PLAN_TIMEOUT_MS`；用 `HK2_LLMAPI_TIMEOUT_MS` /
  `HK2_LLMAPI_TIMEOUT_MS_SIMPLE` 全局调整（显式 `0` 仅对这两个 LLM 超时
  变量表示“不设超时”；`HK2_PLAN_TIMEOUT_MS` 的 `0` 会回到默认值）。
- **参见**：[环境变量](../reference/environment-variables.md)。

### 瞬时失败自动重试——请求会不会执行两次？

- **症状**：请求以 HTTP 500/502/503/504 或途中的传输层错误失败后重试。
- **原因**：结果*可能已执行*的失败（请求发出后的 HTTP 5xx）默认重试
  （`HK2_LLM_RETRY_UNKNOWN_POST=1`）——对交互式使用而言，整轮任务报废比
  偶发重复请求更糟。提供商无幂等键。连接建立失败与 HTTP 408/429 属于
  结果安全类，始终重试。
- **解决**（若在意重复计费）：设 `HK2_LLM_RETRY_UNKNOWN_POST=0`。重试次数
  受 `HK2_LLMAPI_NUMOFRETRIES`（默认 10）约束。
- **参见**：[环境变量](../reference/environment-variables.md)。

### 阶段模型不可达 / 引用过期

- **症状**（调用失败）：输出告警；`rewrite-query` / `request-assess` 改用
  会话模型重跑或被跳过。
- **原因**（调用失败）：`HK2_ENABLE_PHASEMODEL_FALLBACK`（默认 1）让这些
  阶段改用会话模型；设为 0 则跳过。审查阶段（`plan-review`、
  `code-review`）在模型不可达时始终跳过——绝不静默替换审查者。
- **症状**（引用过期）：*没有*告警，阶段静默使用会话模型。
- **原因**（引用过期）：ref 指向未知提供商 / 模型（`resolveModelRef`
  返回 null）时，当前被静默视为"未配置覆盖"，不走告警 / fallback 路径——
  已知运行时限制。
- **解决**：用 `/model list` 检查阶段引用，或
  `/model set-phase --phase=<name> --clear` 清除覆盖。每次回退 / 跳过都
  记入会话记录供审计。

## 项目与知识库

### "KB not built for project <name>. Run /kb init before chatting."

- **原因**：hk2 是知识库驱动的；对话要求已初始化的知识库。
- **解决**：执行 `/kb init`。若项目尚未注册：先
  `/project init --name=... --source=...`。
- **参见**：[快速开始](../getting-started/quick-start.md)。

### `/kb update` 触发全量重建

- **原因**：hk2 版本之间存储的解析器版本发生了变化——为保证正确性必须
  全量重建。旧版布局迁移会先把知识条目备份到
  `backup/pre-upgrade-<ts>/`，再按当前迁移代码处理。
- **解决**：无需处理，让它跑完即可。

### `/kb knowledge learn` 规划似乎卡住后失败

- **原因**：阶段 1 规划的 LLM 调用超过 300 秒预算，或返回的计划不可用。
- **解决**：hk2 已自动禁用推理重试一次，并最终回退到确定性目录分组
  （不会因 LLM 计划不可用而中止，且保持全覆盖；其他错误仍可能终止运行）。
  慢速提供商可提高预算：
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
- **原因**：管道 stdin/stdout、`TERM=dumb` 或 CI 控制台。能力检测针对 TUI
  实际绘制的流（默认 stderr，`HK2_TUI_STREAM=stdout` 可切换）。
- **解决**：在真实终端中运行，或继续使用 REPL——两者共享同一套会话、命令
  与管线。
- **参见**：[REPL 与 TUI](repl-and-tui.md)。

### 会话恢复没有还原被中断的计划

- **原因**：只有保存的计划存在未完成步骤时才恢复状态；已完成的计划会清除
  状态。
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

- `HK2_DEBUG=1`——打印错误堆栈（斜杠命令出错时同样打印堆栈）。
- `HK2_ASCII=1`——在非 UTF-8 终端上强制使用 ASCII 字符。
- `HK2_NO_COLOR=1`（或 `NO_COLOR`）——禁用 ANSI 颜色。
- 日志位于 `~/.hk2/logs/`；会话记录（含 `assess`、`rewrite`、`graph`、
  `codeReview` 等轮次元数据）位于 `~/.hk2/sessions/<projectId>/`。

## 相关文档

- [安装](../getting-started/installation.md)
- [安全与权限](security-and-permissions.md)
- [环境变量](../reference/environment-variables.md)
