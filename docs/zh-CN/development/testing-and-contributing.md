# 测试与贡献

[English](../../en/development/testing-and-contributing.md) | 简体中文

如何运行 hk2 的测试套件、测试对环境有什么期望，以及提交变更前需要满足的
技术清单。本页只描述仓库中确实存在的流程——除这里写明的之外，不附加任何
CLA、DCO 或分支策略要求。

## 环境要求

- Node.js >= 18（推荐 Node 20 LTS——Tree-sitter 兼容性说明见
  [安装](../getting-started/installation.md)）
- 一份仓库检出并已安装依赖：

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
npm install
```

## 运行测试

套件使用 Node 内置测试运行器（`node:test`）——无需安装额外测试框架。

```bash
npm test                              # node --test 'test/**/*.test.js'
node --test 'test/**/*.test.js'       # 等价的直接调用
node --test test/permissions.test.js  # 单个文件
```

按名称运行单个用例：

```bash
node --test --test-name-pattern="deny beats allow" test/permissions.test.js
```

## 测试的位置与命名

- 测试位于 `test/`，文件名为 `*.test.js`（辅助文件为 `_*.js` / `_*.mjs`，
  如 `_tty_env.js`、`_pty_runner.js`、`_learn_setup.js`——不会被运行器的
  glob 匹配）。
- 文件名与被测模块对应：`permissions.test.js` → `lib/config/setting.js`、
  `tui_keys.test.js` → `src/tui/keys.js`、`llm_retry.test.js` →
  `lib/llm/retries.js`，依此类推。
- 需要真实终端的套件使用 PTY 运行器（`_pty_runner.js`）或经 `_tty_env.js`
  构造类 TTY 环境；这些测试在管道 / CI 环境中行为可能不同（或被跳过）——
  改动 TUI/REPL 代码时，建议在真实终端中运行完整套件。
- 测试是封闭的：它们把 `HK2_HOME` 重定向到临时目录，绝不触碰你真实的
  `~/.hk2`。新测试请沿用该模式。

## 改了 X 要同步更新什么

| 你改了…… | 需要更新…… |
|---|---|
| 斜杠命令或其参数 | `src/slash/help.js`（帮助文本与补全都派生自它）、命令实现、适用的 `test/help_system.test.js` / `test/slash_completion.test.js`，以及两种语言的[斜杠命令](../reference/slash-commands.md) |
| 环境变量 | 解析代码、相关测试（如 `llm_timeout_env.test.js`），以及两种语言的[环境变量](../reference/environment-variables.md) |
| 工具注册表 | `lib/agent/tools.js`、工具测试，以及两种语言的[智能体工具](../reference/agent-tools.md) |
| 权限规则语义 | `lib/config/setting.js`、`test/permissions.test.js`，以及两种语言的[安全与权限](../guides/security-and-permissions.md) |
| 配置 Schema 字段 | `lib/config/home.js`、权限相关时的 `setting.example.json`，以及两种语言的[配置](../reference/configuration.md) |
| 解析器 / 语言映射 | `lib/parser/*`、`package.json`（语法依赖），以及两种语言的[CLI 与语言支持](../reference/cli-and-language-support.md) |
| 文档 | 你所改页面的**两种语言版本**（`docs/en/` 与 `docs/zh-CN/`）——见[文档维护](documentation-maintenance.md) |

## 提交前检查清单

认为改动完成之前：

1. `npm test` 通过。
2. `npm run docs:check` 通过（双语文档保持同步、链接有效）。
3. 若改动了 CLI 或帮助相关内容，`node bin/hk2 --help` 仍打印正确用法。
4. 新增 / 变更的行为有对应测试——没有该改动时测试应当失败。
5. 文档与示例中没有引入密钥、内部 URL 或个人路径——使用 `sk-example`、
   `http://localhost:8000/v1`、`/path/to/project`。
6. 你触碰的任何文档的两种语言版本是一起更新的。

## 仓库工具

- `npm run install:global`——对检出执行 `npm link`（开发者安装）。
- `npm run uninstall:global`——`npm unlink -g hk2`。
- `npm run docs:check`——文档一致性检查（双语同构、链接目标、质量门禁）；
  见[文档维护](documentation-maintenance.md)。
- `scripts/close-issues.mjs`、`scripts/learn-once.js`——仓库维护辅助；
  使用前请先阅读文件头注释。

## 相关文档

- [文档维护](documentation-maintenance.md)——文档检查在提交前清单中的位置
- [架构](architecture.md)——你的改动落在哪一层
- [安装](../getting-started/installation.md)——`npm link` 开发者安装
