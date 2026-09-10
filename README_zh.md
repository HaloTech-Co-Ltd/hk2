# hk2

[English](README.md) | 简体中文

**让项目知识成为下一次开发的起点。**

hk2 是一个以知识库驱动的编码智能体。它将代码结构、设计知识与任务经验
组织成可检索的项目上下文，帮助你理解代码、推进修改，并将有价值的发现
沉淀下来，供后续任务检索复用。

[快速开始](#快速开始) · [文档](docs/zh-CN/README.md) · [架构](docs/zh-CN/development/architecture.md)

<img width="886" height="223" alt="hk2 终端界面" src="https://github.com/user-attachments/assets/f64c2197-5301-46d2-8984-d659dac5e556" />

## 为什么是 hk2

理解一个项目，需要知道代码如何连接、设计为何如此、修改应遵循哪些约定。
这些认识值得跨越一次会话，成为项目持续积累的资产。

hk2 将符号索引、代码知识图谱与可维护的知识条目结合起来，引导智能体优先
检索项目知识，再结合源码核验并执行任务。你可以沿调用链探索陌生代码，
让复杂修改经过计划与审查，也可以保存设计决策与任务经验，供下一次工作使用。

知识的价值来自持续维护与实际检索；hk2 不会自动记住每段对话。
了解[知识库如何组织](docs/zh-CN/concepts/knowledge-base.md)与
[上下文如何进入任务](docs/zh-CN/concepts/agent-workflow.md)。

## 核心能力

- **沿代码关系理解项目**——基于 Tree-sitter 的符号索引与代码知识图谱，
  查询调用链、类继承和导入关系，将检索结果与源码关联起来。
- **让知识跨任务复用**——Holy Space（稳定设计知识）、Eden Space（目录与
  摘要）、Index Space（检索索引与图谱）分层组织项目上下文；深度研读可从
  代码与文档中提炼可复用的知识条目。
- **让项目约定进入工作流**——项目最高准则（Project Supreme Code）将已保存
  的规则作为高优先级指引注入系统提示；模型遵从仍需核验。本地工具提供
  读、写、执行权限控制，详见[安全与权限](docs/zh-CN/guides/security-and-permissions.md)。
- **让复杂任务有迹可循**——交互式计划确认、实时进度，以及可选的计划审查
  与代码审查，帮助你评估方案并检查完成结果。
- **选择适合你的终端体验**——经典行式 REPL 与内联 TUI（`hk2 --tui`）
  共享智能体能力、会话与命令。

## 环境要求

- 软件包要求 Node.js >= 18；受支持版本的选择与原生绑定兼容性见
  [安装指南](docs/zh-CN/getting-started/installation.md)。
- `npm install` 构建 Tree-sitter 原生绑定。绑定不可用时，多数语言可回退到
  正则解析；C# 没有此回退。

## 安装

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

在 `~/.hk2` 安装一份自包含副本，并将 `hk2` 符号链接加入 PATH；重装时保留
`config/install-data-items.txt` 声明的用户数据项。升级意外中断后可恢复；若要
主动丢弃数据，必须同时传入 `--preserve-data=off` 与 `--confirm-data-loss`。
自定义安装路径、重装选项与开发安装方式详见
[安装](docs/zh-CN/getting-started/installation.md)。

## 快速开始

```bash
hk2
```

在 REPL 中完成以下三步。将模型名称、服务地址、密钥与项目路径替换为你的
实际配置；示例使用本地 OpenAI 兼容服务，`src` 表示项目的源码子目录。

```text
# 1. 连接模型
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel

# 2. 注册项目并构建知识库
/project init --name=myapp --source=/path/to/repo --source-root=src
/kb init

# 3. 开始探索项目
登录是如何校验密码的？
```

建库后即可提问。需要进一步提炼项目知识时，可选运行 `/kb knowledge learn`；
处理大型项目可能需要更多时间与模型用量。`hk2 --tui` 也支持从 Claude Code
导入模型配置，见[模型配置](docs/zh-CN/guides/models-projects-and-sessions.md)。

下面以包含登录模块的项目为例，展示检索与源码阅读的交互形式（示意输出）：

```text
hk2(myapp|Eden/9 Holy/1|local/mymodel)> 登录是如何校验密码的？
✎ thinking …
⚡ kb_search("verify password login")
⚡ read(<检索命中的源码文件>)
login() 将输入口令与已存哈希比对——相关符号与知识条目均来自知识库检索。
```

更多见[快速开始](docs/zh-CN/getting-started/quick-start.md)。

## 文档

完整文档位于 `docs/`，中英文一一对应：

- **快速开始**——[安装](docs/zh-CN/getting-started/installation.md) ·
  [快速开始](docs/zh-CN/getting-started/quick-start.md)
- **核心概念**——[知识库](docs/zh-CN/concepts/knowledge-base.md) ·
  [知识图谱与检索](docs/zh-CN/concepts/knowledge-graph-and-retrieval.md) ·
  [智能体工作流](docs/zh-CN/concepts/agent-workflow.md)
- **使用指南**——[模型、项目与会话](docs/zh-CN/guides/models-projects-and-sessions.md) ·
  [知识库工作流](docs/zh-CN/guides/knowledge-workflows.md) ·
  [REPL 与 TUI](docs/zh-CN/guides/repl-and-tui.md) ·
  [规划与审查](docs/zh-CN/guides/planning-and-review.md) ·
  [安全与权限](docs/zh-CN/guides/security-and-permissions.md) ·
  [问题排查](docs/zh-CN/guides/troubleshooting.md)
- **参考资料**——[斜杠命令](docs/zh-CN/reference/slash-commands.md) ·
  [智能体工具](docs/zh-CN/reference/agent-tools.md) ·
  [配置](docs/zh-CN/reference/configuration.md) ·
  [环境变量](docs/zh-CN/reference/environment-variables.md) ·
  [CLI 与语言支持](docs/zh-CN/reference/cli-and-language-support.md)
- **开发**——[架构](docs/zh-CN/development/architecture.md) ·
  [测试与贡献](docs/zh-CN/development/testing-and-contributing.md) ·
  [文档维护](docs/zh-CN/development/documentation-maintenance.md)

从[文档索引](docs/zh-CN/README.md)开始，或在 hk2 内用 `/help` 查看全部
命令。

## 支持的语言

C/C++、C#、JavaScript/TypeScript/TSX、Python、Go、Rust、Java、Kotlin、
Scala、Ruby、PHP、Bash/Zsh 使用原生 Tree-sitter 解析；语法不可用时多数语言
可回退到正则解析（C# 除外），Swift、lex/yacc 也有正则解析支持。
Markdown、JSON、YAML、HTML、SGML、PDF、
Word 与 PowerPoint 走文档解析。详见
[CLI 与语言支持](docs/zh-CN/reference/cli-and-language-support.md)。

## 开发

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
npm install
npm test              # node --test 'test/**/*.test.js'
npm run docs:check    # 双语文档一致性检查
node bin/hk2 --help
```

见[架构](docs/zh-CN/development/architecture.md)与
[测试与贡献](docs/zh-CN/development/testing-and-contributing.md)。
