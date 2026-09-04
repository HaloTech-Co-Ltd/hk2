# 文档维护

[English](../../en/development/documentation-maintenance.md) | 简体中文

hk2 文档的组织方式、双语对等规则，以及每页必须对照核验的代码事实源。新增、
移动或删除任何文档页之前，请先阅读本页。

## 目录约定

- `README.md`——英文项目首页：定位、安装、快速开始、文档导航。不是手册。
- `README_zh.md`——中文首页，信息范围与英文首页一致。
- `docs/README.md`——仅作语言选择入口。
- `docs/en/**` 与 `docs/zh-CN/**`——文档树。两个目录**路径同构**：每个
  `docs/en/<路径>.md` 都有相对路径相同的 `docs/zh-CN/<路径>.md` 对应页，
  章节覆盖范围、表格与命令示例一一对应。
- 文件名统一为英文小写短横线形式；中文页面不使用中文文件名，也不使用
  `.zh.md` 后缀。

分区：`getting-started/`、`concepts/`、`guides/`、`reference/`、
`development/`。

## 双语对等规则

1. **路径相同**——`docs/en` 与 `docs/zh-CN` 必须包含完全相同的相对路径
   集合，否则 `npm run docs:check` 失败。
2. **范围相同**——章节、表格、警告与命令示例一一对应。任何一种语言都不得
   成为另一种语言的摘要。
3. **语言切换**——每页 H1 正下方标注：英文页为
   `English | [简体中文](<相对链接>)`，中文页为
   `[English](<相对链接>) | 简体中文`，相对路径按页面所在目录计算。
4. **命令不本地化**——命令名、参数、文件路径、JSON key、环境变量与工具名
   在两种语言中保持原样。注释、示例问题与解释可以本地化。
5. **术语**——中文页面使用约定词表（智能体、知识库、知识图谱、提供商、
   推理、回退、检查点、会话记录、工具调用、请求评估、查询改写、计划审查、
   代码审查）；产品专名保留英文并在首次出现时加中文注释（如 Holy
   Space（稳定知识空间））。不得混用"代理"、"Agent"、"智能体"三套说法。

## 新增页面

1. 在 `docs/en/<分区>/<名称>.md` 编写英文页。
2. 同一次变更中创建 `docs/zh-CN/<分区>/<名称>.md` 中文对应页——绝不留下
   只有单语言的页面。
3. 在两页 H1 下方添加语言切换链接。
4. 从 `docs/en/README.md` 与 `docs/zh-CN/README.md` 索引链接该页，并在相关
   页面的"相关文档"区补充链接。
5. 运行 `npm run docs:check`。

## 移动或删除页面

1. **两种语言版本一起**移动 / 删除。
2. 更新所有指向旧路径的链接（先全库搜索——`docs:check` 能发现失效的本地
   链接，但发现不了本意的变更）。
3. 更新索引与"相关文档"中的引用。
4. 运行 `npm run docs:check`。

## 文档与代码的事实源对照

| 文档领域 | 主要事实源 |
|---|---|
| 斜杠命令 | `src/slash/help.js`、`src/slash/*.js` |
| CLI 参数 | `src/cli.js` |
| 智能体工具 | `lib/agent/tools.js` 及相关 agent 模块 |
| 文件系统权限 | `lib/config/setting.js`、`setting.example.json` |
| 模型配置 | `lib/config/home.js`、`src/slash/model.js`、`lib/llm/*` |
| 环境变量 | 全代码 `process.env` 搜索（`rg -n "process\.env\|HK2_[A-Z0-9_]+" src lib bin install.sh`） |
| 语言支持 | `package.json`、`lib/parser/*` |
| 安装行为 | `install.sh`、`lib/config/home.js` |
| 智能体管线 | `src/commands/turn.js`、`src/commands/turn_support.js`、`lib/agent/*` |
| 测试 | `package.json`、`test/**/*.test.js` |

代码与文档不一致时，修正文档以匹配代码——并在变更说明中注明这次修正。

## 保持根 README 精简

根 README 是首页，不是手册。保留：定位、核心能力、环境要求、最短安装、
5 分钟快速开始、一个示例、文档导航与许可证。**不**保留：完整命令表、工具
表、环境变量表、配置 Schema、TUI 键位表、权限内部实现、源码目录树。改为
链接到详情页。某一节如果感觉像参考资料，它就该放进 `docs/`。

## 检查器

`npm run docs:check` 运行 `scripts/check-docs.mjs`（仅用 Node 标准库），
检查：

- `docs/en` 与 `docs/zh-CN` 包含相同的相对路径集合；
- 每对页面互相链接（语言切换）；
- `README.md`、`README_zh.md` 与 `docs/**/*.md` 中的本地 Markdown 链接与
  图片指向真实存在的文件；
- 质量门禁：文档任何位置都没有未填充的仓库地址占位符与未完成工作标记，两个根
  README 互相链接并各自链接对应语言的文档索引，`docs/README.md` 同时链接
  两种语言入口。

检查器在非零退出前报告全部问题——请把它列出的内容全部修完。

## 内容规则

- 每页一个 H1；标题层级连续不跳级；代码块标注语言（`bash`、`json`、
  `text`、`mermaid`）。
- 不使用裸露的绝对本地路径链接；只用相对路径，且显式写到 `.md` 文件。
- 已提交的文档中不保留未完成工作标记或占位章节。
- 不写无法核验的断言：不编造性能数字，不写"支持一切"，不写"完全安全"。
  尽力而为的机制必须如实标注。
- 示例不得包含真实 API 密钥、内部 IP、内部域名、个人主目录或真实用户
  数据。使用 `sk-example`、`http://localhost:8000/v1`、`/path/to/project`、
  `myapp`。
- 警告与数据删除风险显式标出。

## 相关文档

- [测试与贡献](testing-and-contributing.md)——文档检查在提交前清单中的位置
- [架构](architecture.md)——文档所镜像的模块图
