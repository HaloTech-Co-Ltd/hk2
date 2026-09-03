<img width="886" height="223" alt="Screenshot 2026-08-23 at 09 02 34" src="https://github.com/user-attachments/assets/f64c2197-5301-46d2-8984-d659dac5e556" />

# hk2

一个以知识库（KB）驱动、专为编码场景而生的智能体。每次会话的收获都会沉淀
为可复用的知识，下一次任务开始时，它已经掌握上一次学到的一切。

[English](README.md) | 简体中文

## 为什么是 hk2

编码智能体会"失忆"。每个新会话都要重新读同样的文件、重新推导同样的架构、
重新犯同样的错误。hk2 反其道而行：每个项目拥有一个**知识库**——符号、代码
知识图谱与沉淀的知识条目——智能体在**每次请求**时都会查询它。让知识库成为
唯一可信来源，智能体就越用越聪明。

## 核心能力

- **项目级三空间知识库**——Holy Space（稳定的设计知识）、Eden Space（频繁
  更新的目录与摘要）、Index Space（BM25 + 图谱），各有独立的更新与批准
  策略。
- **Tree-sitter AST 索引**——15 个语法（14 个包）的原生解析，正则透明
  回退；符号、调用链、类继承与导入成为可查询的图谱。
- **按请求注入上下文**——相关符号、调用链、类成员、知识条目与文档会在
  LLM 回答前被检索并注入。
- **知识库优先的智能体**——工具注册表引导智能体先查知识库工具再用
  `bash grep`，中途守卫兜底；所有触碰路径的工具都运行在项目外默认拒绝的
  r/w/x 权限模型之后。
- **深度研读**——`/kb knowledge learn` 让 LLM 通读代码库（或文档）并撰写
  可复用的知识条目；大项目自动切换为目录级规划。
- **项目最高准则（Project Supreme Code）**——一个受保护、始终注入的条目，
  存放项目不可协商的法则，智能体的一切操作都必须遵守。
- **规划与审查**——需用户确认的计划与实时进度面板，可选的计划审查与对
  完成结果的代码审查。
- **两个前端，同一个智能体**——经典行式 REPL 与 Claude Code 风格 TUI
  （`hk2 --tui`）共享会话、命令与管线。

## 环境要求

- Node.js >= 18（推荐 Node 20 LTS，以获得 Tree-sitter 原生兼容性）
- `npm install` 构建 Tree-sitter 原生绑定；缺失时 hk2 回退到正则解析器

## 安装

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

在 `~/.hk2` 安装一份自包含副本，把 `hk2` 符号链接加入 PATH，重装时保留你的
数据（模型、项目、知识库）。可用参数：`--prefix=<path>`、
`--install-dir=<path>`、`--no-npm-install`、`--preserve-data=off`——开发
者可用 `npm link`。详见[安装](docs/zh-CN/getting-started/installation.md)。

## 快速开始

```bash
hk2
```

在 REPL 中：

```
# 1. 注册项目并构建知识库
/project init --name=myapp --source=/path/to/repo --source-root=src
/kb init

# 2. 添加模型（或用 `hk2 --tui` 从 Claude Code 导入一个）
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel

# 3. 深度研读项目 -> 自动生成知识条目
/kb knowledge learn

# 4. 提问——智能体自动检索知识库上下文并调用工具
登录是如何校验密码的？
```

一次真实的交互大致如下：

```text
hk2(myapp|Eden/9 Holy/1|mymodel)> 登录是如何校验密码的？
✎ thinking …
⚡ kb_search("verify password login")
⚡ read(src/auth/password.js)
login() 使用 bcrypt.compare 将输入与 user.password_hash 比对（第 42 行）——
完整认证流程见知识条目 `auth-password-flow`。
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
Scala、Ruby、PHP、Bash/Zsh 使用原生 Tree-sitter 解析；语法不可用时回退到
正则解析（含 Swift、lex/yacc）；Markdown、JSON、YAML、HTML、SGML、PDF、
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

## 许可证

[MIT](LICENSE)
