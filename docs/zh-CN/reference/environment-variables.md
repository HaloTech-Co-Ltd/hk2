# 环境变量

[English](../../en/reference/environment-variables.md) | 简体中文

hk2 专有环境变量的完整清单，通过全代码范围 `process.env` 搜索重新生成——
而非照搬旧文档。默认值来自解析代码。新增或修改变量时，请重新执行搜索并
同步更新两种语言的本页。hk2 遵从的标准终端变量在文末单独列出。

约定：`HK2_ENABLE_*` 功能开关经 `envFlag()` 解析——`1`、`yes`、`true`、`on`（不区分大小写）为开；其余任何值（含 `0`/`no`/`false`/`off`/未识别字符串）为关。另外，`HK2_NO_COLOR`、`HK2_ASCII` 与 `NO_COLOR` 使用存在性语义：任意非空值（即使为 `0`）即启用，取消设置才关闭。数值类各不相同——LLM 超时 / 重试 / 并行度
变量把未设置 / 空 / 非法 / 负数视为"使用默认值"（超时类显式 `0` 表示
"不设超时"，重试类表示"仅尝试一次"）；`HK2_AUTOCOMPACT_PCTUSED` 这类
阈值变量则按各自范围钳制。每个条目都写明自己的解析规则。

## 路径与安装

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_HOME` | 配置 / 数据主目录 | `~/.hk2` | 存放 models.json、projects.json、sessions/、logs/；仅当未设置 `HK2_KB_DIR` 时 KB 才位于 `HK2_HOME/kb/` |
| `HK2_KB_DIR` | 知识库根目录覆盖 | `$HK2_HOME/kb` | 注意：legacy `--mode` 命令按默认 `$HK2_HOME/kb` 路径检测当前项目知识库——自定义 `HK2_KB_DIR` 时该自动检测可能看不到真实 KB 而回退 `default`；此时请显式设置 `HK2_KB_NAME` |
| `HK2_KB_NAME` | 旧版 `--mode` 命令使用的知识库名。解析顺序：非空 `HK2_KB_NAME` 优先；否则当共享当前项目的知识库目录已有 `meta.json` 时用其 UUID；否则用字面量 `default` | 非空值 / 项目 UUID / `default` | |
| `HK2_PREFIX` | `install.sh` 放置符号链接的安装前缀 | `/usr/local` | 仅 install.sh |
| `HK2_INSTALL_DIR` | `install.sh` 自包含源码副本位置 | `~/.hk2` | 仅 install.sh |
| `HK2_PROJECT_SOURCE` | 工具沙箱的项目源码根 | - | 交互模式下自动设置 |
| `HK2_PROJECT_ID` | 定位项目级权限文件的项目 id | - | 交互模式下自动设置；缺省时按 source 路径反查 `projects.json` |

## UI 与显示

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_UI` | 交互前端：`tui` 或 `repl` | `repl` | `--tui` / `--repl` 旗标优先 |
| `HK2_TUI_STREAM` | TUI 绘制的流：`stdout` 切换默认值 | `stderr` | TTY 能力检测跟随该流 |
| `HK2_WELCOME` | TUI 欢迎卡档位：`full` / `compact` / `auto` | `auto` | `auto`：首启完整；老用户 / 矮屏（<30 行）紧凑。完整档需 ≥88 列；更窄自动降级 |
| `HK2_REPL_HINTS` | `0` 禁用 REPL 的实时斜杠补全提示 | 开 | 恢复无提示的朴素提示符 |
| `HK2_HIDE_THINKING` | `1`（默认）：`✎ thinking` 窗口最多渲染 9 行，TUI 思考过程折叠为 `Thought for Ns`；`0`：完整流式显示 | `1` | |
| `HK2_NO_COLOR` | 设为**任意非空值**即禁用 ANSI 颜色——`HK2_NO_COLOR=0` 依然禁用（字符串 "0" 非空）；取消设置以恢复。标准 `NO_COLOR` 同样按存在性语义遵从 | 未设置 |
| `HK2_ASCII` | 设为**任意非空值**即强制用 ASCII 字符替代制表 / 加载动画 / 图标（`0` 依然启用——字符串 "0" 非空；取消设置以禁用） | 未设置 | 适用于非 UTF-8 终端 |

## LLM 请求、超时与重试

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_LLMAPI_TIMEOUT_MS` | 所有 LLM API 请求（流式与非流式）的默认超时（毫秒） | `3600000`（3600 秒） | 优先级：单次调用 `opts.timeoutMs` > 每模型 `config.timeout` > 本环境变量。显式 `0` = 不设超时（不启动中止定时器——计划 / 代码审查依赖此行为）。未设置 / 非法 / 负数回退默认值 |
| `HK2_LLMAPI_TIMEOUT_MS_SIMPLE` | 轻量单次 LLM 阶段的超时（毫秒）：查询改写与请求清晰度评估（轮次开始的两趟调用与 `kb_search` 的内联改写） | `300000`（300 秒） | 由 `lib/llm/timeout.js` 的 `llmApiTimeoutMsSimple()` 解析；单次调用传入 `opts.timeoutMs` 仍优先。显式 `0` = 不设超时。此前硬编码为 15000ms |
| `HK2_LLMAPI_NUMOFRETRIES` | 瞬时 LLM 故障（网络错误、HTTP 408/429/5xx、请求超时）的最大连续重试次数；指数退避 1s 起、封顶 30s；尝试间发出 `{type:'retry'}` 事件。确定性 4xx 与用户中止不重试。显式 `0` = 仅尝试一次 | `10` | |
| `HK2_LLM_RETRY_UNKNOWN_POST` | 结果未知的失败（请求发出后的传输层错误——被重置、读 / 写阶段超时——以及 HTTP 500/502/503/504，反向代理可能在上游已执行后才返回）默认重试；设 `0` 显式关闭（担忧重复请求 / 重复计费时——提供商无幂等键）。连接建立失败（拒绝 / DNS / 建连超时，错误消息呈现为 `(CODE)` 或 `(CODE/connect)`）与 HTTP 408/429 属结果安全类，始终重试。受 `HK2_LLMAPI_NUMOFRETRIES` 约束 | `1` | |

## 请求管线（评估、改写、快速通道）

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_ENABLE_QUERYREWRITE` | `1`：BM25 检索前先用 LLM 把实质性查询改写为英文函数名 + 关键词（轮次开始；fast-lane 后续输入跳过整个前置管线）。`kb_search` 工具仅在有可用 LLM 且未传 `skip_rewrite=true` 时才内联改写 | `1` | 是评估与快速通道的前提 |
| `HK2_ENABLE_REQUEST_ASSESS` | `1`（且改写开启）：在第一次查询改写**和**知识库检索**之后**，LLM 才判断请求是否清晰——刻意让评估模型手握已检索的项目上下文；不清晰的请求弹出编号澄清菜单，选定答案驱动第二次改写 + 检索。结合会话摘要判断以免误判后续输入；仅交互式 TTY；一轮有界；尽力而为。判定字段记入会话记录的 `assess` 元数据 | `1` | |
| `HK2_ASSESS_MIN_CONFIDENCE` | 置信度阈值（0.0–1.0），低于该值的"不清晰"结论按清晰处理 | `0.8` | 误弹菜单的代价高于让主智能体内联追问 |
| `HK2_ASSESS_REASONING` | `1`：清晰度评估启用深度推理（强模型上有助于语用指代消解；增加延迟） | `0` | |
| `HK2_ENABLE_FOLLOWUP_FASTLANE` | `1`（且改写开启）：确定为会话性后续输入的内容（继续指令、纯确认词、恰逢刚给出菜单时的纯数字选择、有活跃计划时的推进指令）跳过整个前置管线，直接进入智能体循环 | `1` | 设 `0` 恢复完整管线以便 A/B 对比 |
| `HK2_ENABLE_PHASEMODEL_FALLBACK` | 阶段模型（`rewrite-query`、`request-assess`）不可达时：`1` 告警并改用会话模型重跑；`0` 告警并跳过。审查阶段始终跳过（绝不替换审查者）。回退 / 跳过记入会话记录 | `1` | |

## 计划审查与代码审查

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_ENABLE_PLANREVIEW` | `1`：用户确认计划后、执行开始前，LLM 复审定稿计划（需求清单、逐点覆盖、顺序、可行性、风险）；问题逐一确认；无法解析判定 = UNKNOWN。仅交互式 TTY；尽力而为 | `0` | |
| `HK2_ENABLE_CODEREVIEW` | `1`：本轮确认了计划或开始时正在继续计划，且智能体正常返回时，收尾可能清除面板并触发对 diff、变更文件与最终摘要的代码审查；普通的计划中提问也可能触发。问题逐条列出；无法解析的结论 = UNKNOWN。仅交互式 TTY；尽力而为 | `0` | |

## 知识库构建与学习

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_KB_CHECKPOINT_INTERVAL` | 检查点间隔输入。交互式 `/kb init` 会对 `parseInt(value, 10)` 套用 `|| 100`；直接 indexer 调用则把解析值原样传入，因此不同入口的 cadence 不同。详见下方详细表格。 | `100` | 单次运行可用 `--checkpoint-interval=N` / `--no-checkpoint` |
| `HK2_INDEX_PARALLEL` | 知识库解析池并行度。只有严格的正整数字符串（`1`、`4`、`+8`）生效；未设置、空串、`0`、负数、非法值、小数（`1.5`）和科学计数法（`1e3`）走自动：`availableParallelism()`，再 `cpus().length`，最后 4 | `0` | |
| `HK2_PLAN_TIMEOUT_MS` | `/kb knowledge learn` 阶段 1 规划超时（毫秒）。按 `parseInt(value) \|\| 300000` 解析：`0` 与非法值都会回到默认值（与 LLM 超时不同，这**不是** "0 = 禁用" 变量） | `300000` | 单次运行可用 `--plan-timeout-ms=N` |
| `HK2_ENABLE_AUTOUPDATEKB` | `1`：当某轮智能体回退到 bash 搜索源文件时，轮末静默执行增量 `/kb update`。该更新重建派生索引，**并同步解析器管理的 `doc:<relpath>` Eden 条目**（见 `/kb update`） | `0` | 否则提示 y/N |
| `HK2_ENABLE_AUTO_LEARN` | `1`：轮末抽取的知识条目静默写入 Eden。Holy 无论此标志如何始终提示 y/N | `0` | |
| `HK2_KB_LEARN_COOLDOWN_MIN` | 正数分钟：若本会话任务的知识捕获在该窗口内已处理（智能体保存、已回答的提案、或模型跳过），则跳过轮末 `[kb learn]` 询问。锚点经 `--resume` 恢复。智能体本轮通过 `kb_save_knowledge` 保存时始终跳过询问 | `0`（关闭） | |
| `HK2_KB_LEARN_VALIDATE` | `1`：学习的条目写盘前对照现有知识库校验（预筛 + 一次语义判定）——重复跳过、相近合并、冲突裁决（Holy 交由用户）。尽力而为 | `1` | |

### 按入口解析检查点

交互式 `/kb init` 对环境值使用 `parseInt(value, 10) || 100`：未设置、空值、`0` 和
非数字为 100，正整数照用，负整数原样传入并导致近乎每文件保存。显式
`--checkpoint-interval=<value>` 直接 `parseInt()`；`0`、负数或 `NaN` 同样导致近乎每
文件保存。显式空值 `--checkpoint-interval=` 是假值，会回到环境变量/默认值包装，
而不是变成 `NaN`。`/kb update`、自动更新和 legacy 直接 indexer 调用不经过该
`|| 100` 包装；禁用请使用 `/kb init --no-checkpoint`。

## 压缩

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_ENABLE_AUTOCOMPACT` | `1`（默认开启）：轮次开始时，若上下文使用率达到阈值则压缩。最近 4 条 user/assistant **消息**原样保留（不是 4 个完整轮次），更早的由 LLM 总结为一条 system 消息；朴素截断回退只是把待压缩消息拼接并截断为有限长度的 system 消息，不做语义总结。仅在轮次边界触发，绝不中途。显式保存的事实（经 `/remember` 或 `remember` 工具）在设计上**必然**免受压缩；而保护开头陈述事实的压缩时抽取与"头部+尾部"摘要器输入属于**尽力而为**（抽取失败即放行；朴素截断回退不做任何总结） | `1` | |
| `HK2_AUTOCOMPACT_PCTUSED` | 上下文使用率触发阈值（1–100） | `90` | |

## 首启导入

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_AUTOIMPORT_CLAUDE` | `0` 禁用首启时从 Claude Code 的 `~/.claude/settings.json` 导入模型（仅 TUI） | 开 | 仅填充；绝不覆盖已有默认 |

## 调试与兼容性

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `HK2_DEBUG` | 打印错误堆栈（致命错误、斜杠命令错误） | - | |

## 提供商 API 密钥

| 变量 | 用途 | 默认值 | 说明 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | 进程环境变量：模型注册表文件首次创建时种子化 `anthropic` 提供商（之后的启动不再扫描） | - | Claude Code 导入读取的是 `~/.claude/settings.json` 中的同名字段——另一条来源（见下文） |
| `OPENAI_API_KEY` | 进程环境变量：模型注册表文件首次创建时种子化 `openai` 提供商 | - | |

## 遵从的标准终端环境变量

这些并非 hk2 专有；hk2 按终端工具的惯例读取它们：

| 变量 | 用途 |
|---|---|
| `NO_COLOR` | 禁用 ANSI 颜色（效果同 `HK2_NO_COLOR=1`） |
| `TERM` | 颜色模式与 TUI 能力检测：`dumb` 禁用颜色并阻止 TUI；`linux` 或空值选择 ANSI 256 色；其他 TERM（含 `xterm-256color`）回退到真彩色。`xterm-256color` 另作为 Windows UTF-8 推断信号 |
| `COLORTERM` | 真彩色检测（`truecolor` / `24bit` → 24 位颜色模式） |
| `WT_SESSION` | Windows Terminal 检测：真彩色推断 + Windows UTF-8 能力推断 |
| `TERM_PROGRAM` | `vscode` 参与 Windows UTF-8 能力推断（不用于真彩色判定） |
| `LC_ALL` / `LC_CTYPE` / `LANG` | UTF-8 区域检测（字形与 ASCII 回退渲染） |

## Claude Code settings 首启导入消费的 env 键

TUI 首启导入从 `~/.claude/settings.json` 的 `env` 对象读取以下键——
**不是** hk2 进程环境变量：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_MODEL`

进程级 `ANTHROPIC_API_KEY` 走另一条路径种子化注册表（首次创建时）；
settings 文件中的同名键只供导入使用。

## 相关文档

- [智能体工作流](../concepts/agent-workflow.md)——各管线开关作用在哪里
- [配置](configuration.md)——这些变量指向的文件
- [问题排查](../guides/troubleshooting.md)——超时与重试诊断
