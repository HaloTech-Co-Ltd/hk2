# 安装

[English](../../en/getting-started/installation.md) | 简体中文

本页覆盖安装 hk2 所需的一切：环境要求、两条安装路径（`install.sh` 与
`npm link`）、安装器的数据保留行为、可选的 PDF/Word 解析、安装验证与卸载。

## 环境要求

- Node.js **>= 18**（推荐 Node 20 LTS，以获得最佳的 Tree-sitter 原生兼容性）
- 运行 `npm install` 构建 Tree-sitter 原生绑定（14 个语言包）

> **Tree-sitter 兼容性提示**：过新的 Node 版本（如 Node 25+）在某些平台上
> 可能与预编译的 Tree-sitter 二进制存在 N-API / V8 ABI 不匹配。若
> `/kb init` 日志出现 `tree-sitter parse failed`，hk2 会透明地回退到基于
> 正则的解析器：有正则回退的语言以较低的符号精度继续工作，但**没有**回退
> 解析器的语言（尤其是 C#）将完全不产出符号——见
> [CLI 与语言支持](../reference/cli-and-language-support.md)。如需最高精度，
> 请在 Node 20 LTS 上安装，或运行 `npm rebuild` 从源码重新编译。

hk2 未发布到 npm，请从源码安装。

## 方式 A——install.sh（推荐）

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

`install.sh` 把当前本地源码检出复制为 `~/.hk2` 下的一份自包含树，把 `hk2` 符号链接
加入 PATH（默认 `/usr/local/bin/hk2`——写入该位置可能需要提权；普通用户
可传 `--prefix="$HOME/.local"`），并运行 `npm install --omit=optional`
构建 Tree-sitter 原生绑定。脚本自身从不执行 clone——请从完整检出中运行。

### 重装时保留用户数据——按固定清单

`~/.hk2` 同时承担两个角色：它既是**配置 / 数据主目录**（`HK2_HOME`），也是
源码副本的默认**安装目录**。重装时，安装器会把一份**固定清单**里的数据项
移到一边，刷新代码树，再移回来（用户数据优先于新版本树中的同名条目）：

- **保留**：`models.json`、`projects.json`、`theme.json`、`kb/`、
  `sessions/`、`logs/`
- **不保留**：`setting.json`（全局权限基线）、`settings/`（项目级权限
  覆盖）与 `history.jsonl`（输入历史）——默认布局下，安装目录刷新时它们
  会被**删除**。重装前请先备份，或用 `HK2_INSTALL_DIR` 把源码副本放在
  配置主目录之外。

传入 `--preserve-data=off` 恢复旧的擦除行为（什么都不保留）。

如果你已有检出并正在开发 hk2 本身，建议改用方式 B（`npm link`），或通过
`HK2_INSTALL_DIR` 把源码副本放到配置主目录之外。

### 安装器参数

| 参数 | 作用 |
|---|---|
| `--prefix=<path>` | `hk2` 符号链接的安装前缀（默认 `/usr/local`；也可通过 `HK2_PREFIX` 环境变量设置） |
| `--install-dir=<path>` | 自包含源码副本的位置（默认 `~/.hk2`；也可通过 `HK2_INSTALL_DIR` 设置） |
| `--no-npm-install` | 跳过 `npm install`——hk2 运行时使用基于正则的解析器 |
| `--preserve-data=off` | 旧行为：重装时**不**保留用户数据——安装目录被擦除 |

`--prefix=value` 与 `--prefix value` 两种形式均可，`--install-dir` 同理。

```bash
./install.sh --prefix=$HOME/.local
./install.sh --prefix /usr/local          # 等同于默认值
HK2_INSTALL_DIR="$HOME/.hk2-src" ./install.sh   # 将源码副本置于配置主目录之外
./install.sh --no-npm-install             # 跳过 Tree-sitter（正则回退）
./install.sh --preserve-data=off          # 旧版擦除：重装时不保留用户数据
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

没有卸载器；删什么取决于你想保留什么。

**仅停用命令**——移除启动器，其余全部保留：

```bash
rm -f /usr/local/bin/hk2
```

**移除已安装的源码副本**——`install.sh` 把**整个**仓库复制进安装目录，
因此默认 `~/.hk2` 下代码与用户数据（`models.json`、`projects.json`、
`kb/`、`sessions/`、`logs/`）在同一棵树里，没有任何一条命令能在删除代码
的同时确保数据完好。部分清理例如：

```bash
rm -rf ~/.hk2/node_modules ~/.hk2/bin     # 只删除部分安装文件——不是完整副本
```

之后 `src/`、`lib/`、`package.json`、`install.sh` 等仓库文件仍然留在原处。
这无伤大雅，但**不是**完整移除。

**干净卸载**——若希望代码与数据可分离，安装时就使用独立的源码目录
（`HK2_INSTALL_DIR="$HOME/.hk2-src" ./install.sh`）；卸载只需：

```bash
rm -f /usr/local/bin/hk2
rm -rf "$HOME/.hk2-src"                   # 整份源码副本，数据不受影响
```

要连同样式、项目、会话与知识库**全部**删除：`rm -rf ~/.hk2`——先备份需要
保留的内容。

## 相关文档

- [快速开始](quick-start.md)——第一个项目、第一个知识库、第一个提问
- [配置](../reference/configuration.md)——`HK2_HOME` 里有什么
- [问题排查](../guides/troubleshooting.md)——Tree-sitter ABI 问题与回退
