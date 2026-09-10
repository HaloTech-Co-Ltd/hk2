# 安装

[English](../../en/getting-started/installation.md) | 简体中文

本页覆盖安装 hk2 所需的一切：环境要求、两条安装路径（`install.sh` 与
`npm link`）、安装器的数据保留行为、可选的 PDF/Word 解析、安装验证与卸载。

## 环境要求

- 软件包声明的最低技术版本：Node.js **>= 18**。Node 18 与 20 已 EOL；截至
  2026 年 9 月，请使用 Node.js 项目仍在维护的版本，首选 Node 24 Active LTS。
  Node 22 Maintenance LTS 可作为兼容选择，但应先在目标平台核验
  Tree-sitter 原生绑定。
- 运行 `npm install` 构建 Tree-sitter 原生绑定（14 个语言包）

以上版本状态以 2026 年 9 月为准；今后选择运行时，请查看
[Node.js 官方发布计划](https://github.com/nodejs/Release/blob/main/schedule.json)。

> **Tree-sitter 兼容性提示**：必须在实际部署的 Node/平台组合上核验原生绑定；
> 本仓库没有覆盖所有版本与平台的绑定矩阵。`/kb init` 日志出现
> `tree-sitter parse failed` 时，请在实际安装目录运行 `npm rebuild`；hk2 会在
> 存在正则回退的语言上继续工作，而没有回退的语言（尤其 C#）不会产生符号——
> 见[CLI 与语言支持](../reference/cli-and-language-support.md)。

以下安装流程使用源码检出。

## 方式 A——install.sh（推荐）

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

`install.sh` 将当前本地源码检出复制到 `~/.hk2`，形成一份自包含目录，并将 `hk2` 符号链接
加入 PATH（默认 `/usr/local/bin/hk2`——写入该位置可能需要提权；普通用户
可传 `--prefix="$HOME/.local"`），并运行 `npm install --omit=optional`
构建 Tree-sitter 原生绑定。脚本本身不会执行 clone；请在完整检出中运行。

### 重装时保留用户数据——按清单文件

`~/.hk2` 同时承担两个角色：它既是**配置 / 数据主目录**（`HK2_HOME`），也是
源码副本的默认**安装目录**。重装时，安装器会暂存
`config/install-data-items.txt` 声明的数据项，刷新代码树后再放回（用户数据
优先于新版本树中的同名条目）。安装器使用可恢复的同级暂存与备份目录；升级
意外中断后，下次运行会继续恢复。这能保护升级过程，但不能代替重要数据的
外部备份：

- **保留**：`models.json`、`projects.json`、`theme.json`、`setting.json`、
  `history.jsonl`、`welcome-seen`、`settings/`、`kb/`、`sessions/` 与
  `logs/`。仓库内的清单文件是权威列表。

保留机制只处理所选 `HK2_INSTALL_DIR` 中已存在、名称匹配的顶层条目；安装器
不会搜索另行设置的 `HK2_HOME` 或 `HK2_KB_DIR`。反过来，位于安装目标之外的
数据也不会因刷新该目标而被触碰。源码树先复制到唯一的同级 stage；已有清单
数据移入 `.hk2-preserve`，旧安装移入 `.hk2-old`。只有新启动器验证成功且清单
记录的每项都已存在后，恢复目录才会删除。后续运行发现中断的 preserve 事务时，
会先尝试恢复已记录条目，再开始下一次升级。这是文件系统层面的尽力恢复，不是
跨目录原子事务；重要数据仍应保留外部备份。

`npm install` 执行失败只会打印警告并继续使用正则解析回退；如果启动器验证
成功，这条警告不会使安装器保留旧安装备份。stage、目录替换、数据恢复或启动器
验证失败时，会在适用情况下留下同级恢复状态，供以后运行继续处理。

启用旧的破坏性擦除行为必须同时传入 `--preserve-data=off` 与
`--confirm-data-loss`。

如果你已有检出并正在开发 hk2 本身，建议改用方式 B（`npm link`），或通过
`HK2_INSTALL_DIR` 把源码副本放到配置主目录之外。

### 安装器参数

| 参数 | 作用 |
|---|---|
| `--prefix=<path>` | `hk2` 符号链接的安装前缀（默认 `/usr/local`；也可通过 `HK2_PREFIX` 环境变量设置） |
| `--install-dir=<path>` | 自包含源码副本的位置（默认 `~/.hk2`；也可通过 `HK2_INSTALL_DIR` 设置） |
| `--no-npm-install` | 跳过 `npm install`；没有原生绑定时，仅有正则回退的语言能产生代码符号 |
| `--preserve-data=off` | 旧行为：重装时不保留安装目标中的清单数据；必须同时传确认参数 |
| `--confirm-data-loss` | `--preserve-data=off` 所需的确认参数；单独使用不会删除数据 |

`--prefix=value` 与 `--prefix value` 两种形式均可，`--install-dir` 同理。

```bash
./install.sh --prefix=$HOME/.local
./install.sh --prefix /usr/local          # 等同于默认值
HK2_INSTALL_DIR="$HOME/.hk2-src" ./install.sh   # 将源码副本置于配置主目录之外
./install.sh --no-npm-install             # 跳过 Tree-sitter（正则回退）
./install.sh --preserve-data=off --confirm-data-loss  # 破坏性重装
```

### 可选的 PDF / Word 解析

`pdf-parse`（PDF）与 `mammoth`（Word `.docx`）是可选依赖——安装器默认跳过
它们以保持基础安装轻量。启用方法：

```bash
cd ~/.hk2 && npm install                  # 安装 pdf-parse + mammoth（若设置了 HK2_INSTALL_DIR 请进入实际安装目录）
```

`.pptx` 经内置 OOXML ZIP/XML 读取器提取；更老的 `.doc` / `.ppt` 二进制经
内置的尽力而为可打印文本启发式提取（两者都不是完整的 Office 渲染器——
不保证恢复复杂布局、图表、嵌入对象或全部文本）。只有 PDF 与 `.docx` 需要
可选包。

## 方式 B——npm link（面向开发者）

创建指向当前工作树的符号链接。如果你正在修改 hk2 本身并希望改动立即生效，
建议采用此方式。

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
npm install
npm link
```

卸载：`npm unlink -g hk2`（或 `npm run uninstall:global`）。

## 验证

```bash
hk2 --help
hk2 --version
```

`hk2 --help` 会打印版本、CLI 用法、斜杠命令族与配置位置。能看到输出即说明
启动器与 Node 运行时均正常。

## 卸载

没有卸载器；删除哪些内容取决于你想保留什么。

**仅停用命令**——移除启动器，其余全部保留：

```bash
rm -f /usr/local/bin/hk2
```

**移除已安装的源码副本**——`install.sh` 把**整个**仓库复制进安装目录，
因此默认 `~/.hk2` 下代码与用户数据（`models.json`、`projects.json`、
`kb/`、`sessions/`、`logs/`）在同一棵树里，没有单条命令能在删除代码的同时
保证数据完好。例如，部分清理可以这样做：

```bash
rm -rf ~/.hk2/node_modules ~/.hk2/bin     # 只删除部分安装文件——不是完整副本
```

之后 `src/`、`lib/`、`package.json`、`install.sh` 等仓库文件仍然留在原处。
这不会影响运行，但**不是**完整移除。

**干净卸载**——若希望代码与数据分开，请在安装时使用独立的源码目录
（`HK2_INSTALL_DIR="$HOME/.hk2-src" ./install.sh`）；卸载只需：

```bash
rm -f /usr/local/bin/hk2
rm -rf "$HOME/.hk2-src"                   # 整份源码副本，数据不受影响
```

要删除**默认数据主目录**及其中的模型、项目、会话与知识库：`rm -rf ~/.hk2`
——先备份需要保留的内容。自定义 `HK2_HOME` / `HK2_KB_DIR` 路径中的数据
和独立的源码安装目录不在这条命令的删除范围内。

## 相关文档

- [快速开始](quick-start.md)——第一个项目、第一个知识库、第一个提问
- [配置](../reference/configuration.md)——`HK2_HOME` 里有什么
- [问题排查](../guides/troubleshooting.md)——Tree-sitter ABI 问题与回退
