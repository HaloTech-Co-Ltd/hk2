# 知识库工作流

[English](../../en/guides/knowledge-workflows.md) | 简体中文

本指南展示如何完成日常知识库任务：构建、更新、检查、深度研读、导入导出、
维护与清理。它聚焦于*如何做成事情*——完整参数参考在
[斜杠命令](../reference/slash-commands.md)，底层模型在
[知识库](../concepts/knowledge-base.md)。

## 构建与刷新索引

```bash
/kb init                                  # 构建（可恢复，自动摘要）
/kb init --skip-summary                   # 跳过 3 个 LLM 摘要条目
/kb init --checkpoint-interval=50         # 每 50 个文件存一次检查点
/kb init --no-resume                      # 忽略已有检查点
/kb update                                # 增量更新（sha256 差异）
/kb status                                # 各空间统计
```

- `/kb init` 全量重索引；被中断的构建从检查点恢复。`--full` 在已存在时
  强制重建。
- `/kb update` 只重新解析变化的文件（Index 空间）。它自动检测旧版知识库并
  无损升级——知识内容先快照到 `backup/pre-upgrade-<ts>/`；解析器版本变化
  触发全量重建。

**什么时候跑什么**：`/project init` 之后跑 `/kb init`；日常编辑后跑
`/kb update`（或让 `HK2_ENABLE_AUTOUPDATEKB=1` 在智能体回退 bash 搜索时
自动执行）；切换分支或大型重构后跑 `/kb init --full`。

## 查询知识库

```
/kb search password verification --top-k=5
/kb symbol login
/kb neighbors 80:78
/kb knowledge list
/kb knowledge list --space=eden
/kb knowledge show spi-extension-pattern
```

`/kb neighbors` 接受形如 `<fileId>:<line>` 的符号 id——可从 `/kb search`
或 `/kb symbol` 输出中获取。

## 用 `/kb knowledge learn` 深度研读

统一的深度研读命令，自动在两种模式间选择：

- **代码模式（CODE mode）**——不带 `--file`，或 `--base-dir` 指向*已索引*
  的子目录。两阶段研读已索引源码：阶段 0 写入三个项目级概览条目
  （`api-docs`、`code-walkthrough`、`usage-examples`；`--no-survey` 跳过），
  阶段 1 规划主题批次，阶段 2 逐主题提取条目。
- **文档模式（DOC mode）**——`--file=<path>`，或 `--base-dir` 指向非索引
  目录。深度研读 Markdown / PDF / Word / PowerPoint / 文本文档并写入所选
  空间。文件可以在项目之外；大文件被切分为顺序分片以保证内容不丢失，且
  每个文档都保证有批次覆盖（规划遗漏的文件获得单文件补漏批次）。

每次运行在写入前都会把候选条目与现有知识库比对校验（重复 → 跳过，相近 →
原地合并，冲突 → 与 Holy 冲突必须由你裁决，Eden 以校验器判定为准并打印
理由）。

```bash
# 研读整个项目（代码模式）
/kb knowledge learn

# 只预览不写入
/kb knowledge learn --dry-run

# 限定到某个已索引子目录，跳过概览
/kb knowledge learn --base-dir=src/retrieval --no-survey

# 研读一份文档到 Eden
/kb knowledge learn --space=eden --file=docs/spec.pdf

# 用指定模型驱动全部学习 LLM 调用；用尾部指令引导
/kb knowledge learn --model=local/mymodel focus on error handling
```

常用参数：`--dry-run`、`--no-survey`、`--base-dir=DIR`、`--file=PATH`、
`--space=eden|holy`（文档模式默认 `eden`；代码模式始终写 Eden）、
`--per-batch-chars=N`（每批次 LLM 上下文预算，默认 100000）、
`--model=<provider>/<model-id>`、`--plan-timeout-ms=N`，以及传入每个 LLM
提示词的自由格式尾部指令。

### 大型项目与回退

索引文件超过 **300 个**时，阶段 1 规划器从文件级切换为**目录级规划**——
LLM 只分组目录（规划图大幅缩小），每个目录令牌再被确定性展开为具体文件，
切分为 ≤30 文件的批次。若 LLM 计划仍不可用（推理模型可能把全部预算耗在
思考阶段），命令会先禁用推理重试一次，最终回退到确定性目录分组——研读
永远以全覆盖继续，绝不中断。

**慢速提供商**：阶段 1 规划调用默认 300 秒预算；若你的提供商超时，传入
`--plan-timeout-ms=600000`（或设置 `HK2_PLAN_TIMEOUT_MS`）。

## 手动条目与导入导出

```bash
/kb knowledge add --title="SPI Pattern" --intro="Use PGXS; ..." --keywords=spi,extension
/kb knowledge add --space=eden --id=sql-cmds --title="SQL Commands" --intro-file=/tmp/sql.md
/kb knowledge export all /tmp/kb-dump.json
/kb knowledge import /tmp/kb-dump.json adaptive --overwrite
```

- `add` 默认写入 **holy**；`--intro-file` 从文件读取正文；可选 `--id`、
  `--key-files`、`--key-symbols`、`--keywords` 为条目标注便于后续检索。
- `export <eden|holy|all> <path>` 导出带每条 `space` 标签的版本 2 JSON
  文件。
- `import <path> [eden|holy|adaptive] [--overwrite]`——`adaptive` 按条目
  原始空间路由。导入到 **Holy 始终提示 y/N**。

## 维护：移动与整理

```bash
/kb transform sql-commands eden holy       # 移动条目（需确认）
/kb knowledge housekeep all                # LLM 辅助清理
```

`housekeep` 扫描破损条目、合并重复 / 相近条目（y/N），并以 `all` 模式通过
逐对选择菜单裁决 Eden↔Holy 冲突。绝不触碰最高准则条目；有变更则重建知识
索引。`--model=<provider>/<model-id>` 指定所用模型。

## 最高准则操作

```bash
/kb code list
/kb code add --code-content="API 密钥严禁出现在任何代码文件中"
/kb code add 1 --code-content="..."       # 原地更新第 1 条
/kb code add --code-gen="起草一条关于提交信息格式的规则"
/kb code del 2
```

限制与保护规则见
[知识库](../concepts/knowledge-base.md#项目最高准则hk2-supreme-code)。

## 删除与重置

```bash
/kb knowledge del <id>          # 单个条目（需确认）
/kb knowledge empty eden        # 清空某空间全部条目——不可逆，始终确认
/kb drop                        # 删除整个知识库（需确认）
```

> **警告**：`/kb knowledge empty` 与 `/kb drop` 会销毁数据。若之后可能需要，
> 请先执行 `/kb knowledge export all <path>` 导出。

## 常见组合

- **新成员上手**——`/kb init` → `/kb knowledge learn` → 让他看
  `/kb knowledge show project-overview`。
- **吸收设计文档**——`/kb knowledge learn --file=docs/design.md
  --space=eden`，然后 `/kb knowledge housekeep eden` 去重。
- **大型重构之后**——`/kb init --full`（图谱结构变了），再
  `/kb knowledge learn` 刷新主题条目。
- **知识库陈旧 / 重复**——`/kb update`，然后
  `/kb knowledge housekeep all`。

## 相关文档

- [知识库](../concepts/knowledge-base.md)——空间、生命周期、最高准则
- [斜杠命令](../reference/slash-commands.md)——完整 `/kb` 参考
- [问题排查](troubleshooting.md)——超时、检查点与恢复
