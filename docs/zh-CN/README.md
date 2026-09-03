# hk2 文档

[English](../en/README.md) | 简体中文

欢迎阅读 hk2 文档。hk2 是一个以知识库（KB）驱动、专为编码场景而生的智能体：每个项目拥有自己的知识库——符号、代码知识图谱与沉淀的知识条目——智能体在每次请求时都会查询它，因此每一次新任务都从上一次学到的一切开始。

初次接触 hk2？建议先阅读[安装](getting-started/installation.md)与[快速开始](getting-started/quick-start.md)，再通过[核心概念](#核心概念)理解三空间知识库模型。

## 快速开始

- [安装](getting-started/installation.md)——环境要求、`install.sh`、`npm link`、卸载、PDF/Word 可选依赖
- [快速开始](getting-started/quick-start.md)——几分钟内从零到第一个基于知识库的回答

## 核心概念

- [知识库](concepts/knowledge-base.md)——三空间模型：Holy、Eden、Index；项目最高准则
- [知识图谱与检索](concepts/knowledge-graph-and-retrieval.md)——Tree-sitter 解析、BM25、调用/导入/继承图谱、按请求注入上下文
- [智能体工作流](concepts/agent-workflow.md)——从按下回车到得到回答之间发生了什么

## 使用指南

- [模型、项目与会话](guides/models-projects-and-sessions.md)——提供商、模型注册表、阶段模型、Claude Code 导入、MCP 服务器
- [知识库工作流](guides/knowledge-workflows.md)——构建、更新、研读与维护知识库
- [REPL 与 TUI](guides/repl-and-tui.md)——两个交互前端、按键、补全、状态栏
- [规划与审查](guides/planning-and-review.md)——计划、进度面板、计划审查、代码审查
- [安全与权限](guides/security-and-permissions.md)——r/w/x 权限模型及其边界
- [问题排查](guides/troubleshooting.md)——症状、原因与解决办法

## 参考资料

- [斜杠命令](reference/slash-commands.md)——全部 `/命令`，与 `src/slash/help.js` 核对
- [智能体工具](reference/agent-tools.md)——智能体可在回合中调用的工具注册表
- [配置](reference/configuration.md)——`HK2_HOME` 目录结构、`models.json`、`projects.json`、知识库布局
- [环境变量](reference/environment-variables.md)——完整清单，默认值经代码核验
- [CLI 与语言支持](reference/cli-and-language-support.md)——一次性 CLI 参数；哪些语言使用 Tree-sitter、正则回退或文档解析

## 开发

- [架构](development/architecture.md)——组件、数据流、模块边界
- [测试与贡献](development/testing-and-contributing.md)——运行测试套件、提交前检查清单
- [文档维护](development/documentation-maintenance.md)——本文档体系如何保持双语一致且准确
