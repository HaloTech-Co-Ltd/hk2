# 知识库

[English](../../en/concepts/knowledge-base.md) | 简体中文

本页解释 hk2 的项目级知识库：三空间模型（Holy / Eden / Index）、每个空间
存放什么、条目如何更新，以及优先级高于一切的项目最高准则（Project
Supreme Code）。

每个项目在 `/project init` 注册、`/kb init` 构建后拥有独立的知识库，以
项目 UUID 隔离在 `~/.hk2/kb/<projectId>/` 下。项目之间互不共享；移除项目
注册会保留其知识库目录，直到你显式删除。

## 三空间模型

| 空间 | 内容 | 更新策略 |
|---|---|---|
| **Holy**（稳定知识空间） | 稳定的设计知识（架构、算法、关键模式）。由人工撰写或从权威来源导入。 | **始终需要用户明确批准**，即便设置了 `HK2_ENABLE_AUTOUPDATEKB=1` 或 `HK2_ENABLE_AUTO_LEARN=1`。 |
| **Eden**（演进知识空间） | 频繁更新的知识（函数目录、命令列表、观察到的模式、模块摘要、**解析的文档**、**自动生成的摘要**）。 | 当 `HK2_ENABLE_AUTO_LEARN=1` 时可自动更新；否则提示 y/N 确认。 |
| **Index**（索引空间） | 代码索引（基于符号的 BM25）、知识图谱（调用链 / 类继承 / 导入 / 继承），以及 Holy/Eden 条目的各空间索引。 | 当 `HK2_ENABLE_AUTOUPDATEKB=1` 时可自动更新；否则提示 y/N 确认。 |

这种划分关乎**信任与变更频率**，而非存储位置：Holy 存放只应随人工决策
而变化的内容；Eden 存放天然频繁变化的内容；Index 是随时可从源码重建的
派生数据。

## 每个空间存放什么

- **Holy Space**——设计原则、架构决策、项目法则与最高准则条目。写入途径：
  `/kb knowledge add --space=holy`、`/kb knowledge import`，或用
  `/kb transform` 把 Eden 条目提升上来。
- **Eden Space**——LLM 撰写的摘要（`/kb init`、`/kb knowledge learn`）、
  轮末自动捕获的知识（`[kb learn]`）、解析的文档（`doc:<relpath>` 条目），
  以及手动添加的快速变化事实。
- **Index Space**——BM25 倒排索引、分片符号表、文件注册表、代码知识图谱，
  以及 Holy/Eden 的各空间关键词索引。纯派生数据；`/kb update` 增量刷新，
  `/kb init`（始终为全量构建）重建。

## 条目生命周期

1. **创建**——条目进入 Holy 或 Eden 的途径：手动 `/kb knowledge add`、
   深度研读（`/kb knowledge learn`）、导入（`/kb knowledge import`）、
   轮末 `[kb learn]` 捕获，或 `/kb init` 的自动摘要。`/kb knowledge add
   --space=holy` 这类直接用户命令本身就是显式意图，立即写入；y/N 确认
   针对的是*智能体提议*路径（`kb_save_knowledge`、`[kb learn]`、导入
   Holy、housekeep 合并与冲突裁决）。
2. **使用**——智能体通过 `kb_knowledge` / `kb_search_knowledge` 检索条目，
   相关条目会作为按请求上下文注入。
3. **写入校验**——默认（`HK2_KB_LEARN_VALIDATE=1`）对*学习*路径提出的
   条目与现有条目比对：重复跳过、相近条目原地合并、冲突裁决——与 Holy
   冲突必须由用户裁决。设 `HK2_KB_LEARN_VALIDATE=0` 时改走旧式启发式
   丢弃路径；校验自身失败则按普通新条目落盘。
4. **维护**——`/kb knowledge housekeep` 合并重复条目并裁决 Eden↔Holy
   冲突；`/kb transform` 在空间之间移动条目（需确认）。
5. **删除**——`/kb knowledge del <id>` 删除单个条目（需确认）；
   `/kb knowledge empty <scope>` 清空某空间的**全部**条目（不可逆，始终
   确认）。

## 项目最高准则（`hk2-supreme-code`）

每个项目的 Holy Space 中都有一个**永久的、受保护的条目**——
`hk2-supreme-code`——存放项目的**最高准则**：一组简短、祈使语气的强制
规则，hk2 在本项目中的**一切操作**（读、写、编辑、规划、回答）都会被以
最高优先级指示遵守（模型层遵从；见下方注入说明）。它由 `/kb init` 创建，
初始为**空**（旧项目会自动补建一个空条目），因此在写入规则之前不会注入
任何内容。

- **设计目的**：为项目所有者提供一个单一、始终可见的位置，定义不可协商的
  约束——安全策略、代码规范、合规要求等——其优先级高于智能体的一般偏好
  与任何其他知识库条目。
- **注入（模型层）**：条目非空时，每次请求把规则渲染进系统提示词的
  `# Project Supreme Code (MUST OBEY — never violate)` 章节，位于**所有**
  其他注入上下文*之前*，指示智能体拒绝违规操作、引用规则编号并提出合规
  替代方案。遵从是高优先级的模型指令，不是形式化验证的执行保证。空条目
  不注入任何内容。
- **保护（硬限制）**：该条目本身不能被删除、重命名、移动、清空、导入
  覆盖或自动更新——在命令层与存储层双重强制。

用法（修改它的唯一途径；每次写入都需显式 y/N 确认）：

```text
/kb code list                                # 查看全部规则
/kb code add --code-content="API 密钥严禁出现在任何代码文件中"
/kb code add 1 --code-content="..."          # 原地更新第 1 条
/kb code add --code-gen="起草一条关于提交信息格式的规则"
/kb code del 2                               # 删除第 2 条；后续条目自动上移
```

限制：最多 **100 条**、每条 **200 字符**，编号 1..N 连续无空洞（省略编号
的 `/kb code add` 追加为第 N+1 条；编号 > N+1 会被拒绝）。规则应保持简短、
祈使；真正复杂的规则应放入独立的 Holy 条目，并在准则中以
`**KB(entry-id)**` 引用。`/kb status` 会显示当前条数。

## 自动生成的 Eden 条目

`/kb init` 与 `/kb knowledge learn` 会生成互补的、由 LLM 撰写的 Eden 条目
集合——无需手写。

**`/kb init`** 在**已配置模型且未传 `--skip-summary`** 时重写 3 个固定 id
的结构条目（未配置 LLM 时索引照常构建，仅跳过这些条目）：

| 条目 id | 内容 |
|---|---|
| `project-overview` | 600–900 字的连贯文字摘要：项目用途、高层架构、关键模块、显著模式。 |
| `architecture-diagram` | 模块 / 层级关系的 Mermaid 流程图，附带简短图例。 |
| `architecture-decisions` | 基于检测到的技术推断出的 4–8 条 ADR 风格条目，每条附带具体的修改建议。 |

**`/kb knowledge learn`** 的代码模式写入可选的阶段 0 概览（下列固定
id——仅在非 `--dry-run`、无 `--base-dir`、无 `--no-survey` 时生成）与经
校验的动态主题条目（完整模式矩阵见
[知识库工作流](../guides/knowledge-workflows.md)）：

| 条目 id | 阶段 | 内容 |
|---|---|---|
| `api-docs` | 0 | 对全项目最重要的公开 / 导出符号的编号参考。 |
| `code-walkthrough` | 0 | 4–8 个章节，逐步剖析最核心的抽象。 |
| `usage-examples` | 0 | 3–5 个使用真实公开符号的编号快速上手示例。 |
| `<主题 id>`（动态） | 2 | 每个 LLM 规划的主题一个条目，每个聚焦一个连贯的子系统（如 `buffer-pool`、`transaction-mgmt`、`wal-replay`）。 |

可通过 `kb_knowledge("<id>")` 或 `kb_search_knowledge("overview")` 检索其中
任意条目。

## 自动学习与自动更新的边界

两个环境变量决定智能体可以不经询问写入什么：

- `HK2_ENABLE_AUTO_LEARN=1`——轮末知识捕获静默写入 Eden。**Holy 始终提示
  y/N**，无论此标志如何（该确认针对智能体提议的捕获；`/kb knowledge add
  --space=holy` 这类直接命令是用户自己的显式意图）。
- `HK2_ENABLE_AUTOUPDATEKB=1`——当某轮智能体回退到用 `bash` 搜索源文件时，
  轮末静默执行一次增量 `/kb update`（Index 空间）。这只刷新派生索引数据，
  绝不触碰 Holy 或 Eden 条目。

两者默认为 `0`（关闭）。见[环境变量](../reference/environment-variables.md)。

## 相关文档

- [知识图谱与检索](knowledge-graph-and-retrieval.md)——Index 空间包含什么、如何查询
- [知识库工作流](../guides/knowledge-workflows.md)——构建与维护知识库的命令
- [配置](../reference/configuration.md)——知识库的磁盘布局
