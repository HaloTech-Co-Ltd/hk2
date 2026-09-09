# 快速开始

[English](../../en/getting-started/quick-start.md) | 简体中文

本页带你完成一次完整的首次使用流程：安装、配置模型、注册项目、构建知识库，
并提出第一个问题。下列命令对应当前实现；请将示例中的模型配置和路径替换为
可访问的提供商配置及实际存在的项目路径。

## 1. 安装并启动

```bash
./install.sh        # 在仓库根目录执行（见“安装”）
hk2                 # 进入交互式 REPL
```

默认前端是行式 REPL。`hk2 --tui` 启动 Claude Code 风格的内联 TUI（需要
TTY 终端；不满足条件时自动回退到 REPL）。

## 2. 配置模型（或导入模型）

用 `/model add` 添加模型（全部参数见
[模型、项目与会话](../guides/models-projects-and-sessions.md)）：

```text
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel
```

只有在尚无默认模型、没有 `claude` 提供商、启用自动导入，且 Claude Code 的
`~/.claude/settings.json` 提供 Anthropic 端点与密钥时，`hk2 --tui` 才会
导入其中的模型配置。不满足这些条件时，请手动配置模型。
详见 [REPL 与 TUI](../guides/repl-and-tui.md#零配置首启)。

`/model list` 查看注册表；`/model show` 查看解析后的默认模型。

## 3. 注册项目

```text
/project init --name=myapp --source=/path/to/repo --source-root=src
```

`--source-root` 将索引范围限定为某个子目录（如 `src`）；省略则索引整个
目录树。`--name` 默认取目录名。

## 4. 构建知识库

```text
/kb init
```

该命令解析被索引的源文件（使用 Tree-sitter AST；如果 Tree-sitter 不可用，只有
具备正则回退的语言可以继续解析；C# 没有回退），构建
BM25 符号索引与代码知识图谱。在已配置模型（第 2 步）且未传
`--skip-summary` 时，它还会尝试生成三个 Eden 摘要，分别保存非空的成功结果。
构建过程会保存检查点；中断后重新运行时，若存在已保存的检查点，会从最近
一次检查点继续。

## 5. 深度研读项目（可选）

建库后即可跳到第 6 步提问。深度研读会补充可复用的知识条目，需要额外的
模型调用；耗时与用量取决于项目规模。

```text
/kb knowledge learn
```

统一的深度研读命令：它会概览代码库、规划主题，并写入主题相关的知识条目。
用 `--base-dir=src/storage` 将范围限定为某个子目录，或改为研读文档：

```text
/kb knowledge learn --space=eden --file=docs/spec.pdf
```

## 6. 提问

```text
登录是如何校验密码的？
```

纯文本即发送给智能体的消息。智能体可以结合会话上下文、检索到的知识库上下文
以及源码工具回答项目问题。详细的请求流程见[智能体工作流](../concepts/agent-workflow.md)。

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

上面的符号名、符号 ID 与知识条目 ID 均为示例；请使用你实际项目中搜索和
列表返回的值。

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
