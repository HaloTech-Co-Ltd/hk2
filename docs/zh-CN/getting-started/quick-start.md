# 快速开始

[English](../../en/getting-started/quick-start.md) | 简体中文

本页带你完成一次完整的首次体验：安装、配置模型、注册项目、构建知识库，
并提出第一个问题。这里出现的每一条命令都存在于当前发布的 hk2
中——从头到尾跟随操作，你将得到一个可用的知识库驱动智能体。

## 1. 安装并启动

```bash
./install.sh        # 在仓库根目录执行（见“安装”）
hk2                 # 进入交互式 REPL
```

默认前端是行式 REPL。`hk2 --tui` 启动 Claude Code 风格的内联 TUI（需要
TTY 终端；条件不满足时自动回落到 REPL）。

## 2. 配置模型（或导入模型）

用 `/model add` 添加模型（全部参数见
[模型、项目与会话](../guides/models-projects-and-sessions.md)）：

```text
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel
```

如果你在使用 Claude Code，`hk2 --tui` 可以完全跳过这一步：首次运行且未
配置模型时，它会从 Claude Code 的 `~/.claude/settings.json` 导入一个模型。
详见 [REPL 与 TUI](../guides/repl-and-tui.md#零配置首启)。

`/model list` 查看注册表；`/model show` 查看解析后的默认模型。

## 3. 注册项目

```text
/project init --name=myapp --source=/path/to/repo --source-root=src
```

`--source-root` 把索引范围限定到某个子目录（如 `src`）；省略则索引整个
目录树。`--name` 默认取目录名。

## 4. 构建知识库

```text
/kb init
```

该命令解析每个被索引的源文件（Tree-sitter AST，不可用时回退正则），构建
BM25 符号索引与代码知识图谱。在已配置模型（第 2 步）且未传
`--skip-summary` 时，它还会让 LLM 撰写三个摘要条目写入 Eden 空间。构建
过程有检查点、可恢复——被中断后重新运行会从检查点继续。

## 5. 深度研读项目

```text
/kb knowledge learn
```

统一的深度研读命令：它会概览代码库、规划主题，并写入主题相关的知识条目。
用 `--base-dir=src/storage` 限定到某个子目录，或改为研读文档：

```text
/kb knowledge learn --space=eden --file=docs/spec.pdf
```

## 6. 提问

```text
登录是如何校验密码的？
```

纯文本即发送给智能体的消息。hk2 会从知识库检索相关符号、调用链与知识
条目并注入上下文，智能体按需调用工具作答。

## 7. 显式查询知识库

```text
/kb search password verification
/kb symbol login
/kb neighbors 12:345
/kb knowledge list
/kb knowledge show spi-extension-pattern
```

- `/kb search`——BM25 + 重排序的符号搜索
- `/kb symbol`——按精确名称查找符号
- `/kb neighbors <fileId>:<line>`——某符号 id 的调用图邻居
- `/kb knowledge list` / `show`——浏览 Holy 与 Eden 知识条目

## 8. 切换项目或恢复会话

```text
/model use local/mymodel           # 仅当前会话
/project list
/project set current otherapp      # 切换（当前会话保存到原项目下）
/session list
/session resume                    # 最近一次之前的会话
/quit
```

在 shell 中：`hk2 --project=otherapp`、`hk2 --resume`，或
`hk2 --project=otherapp --resume`。

## 下一步

- [知识库](../concepts/knowledge-base.md)——三空间模型与项目最高准则
- [知识库工作流](../guides/knowledge-workflows.md)——日常工作流：更新、研读、整理
- [斜杠命令](../reference/slash-commands.md)——完整命令参考
