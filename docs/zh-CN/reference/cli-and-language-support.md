# CLI 与语言支持

[English](../../en/reference/cli-and-language-support.md) | 简体中文

hk2 命令行界面（参数、一次性模式、互斥关系）与各语言解析支持级别的参考。
CLI 事实源是 `src/cli.js`；语言事实源是 `package.json` 与 `lib/parser/*`。

## CLI

### 交互模式（默认）

不带任何参数运行 `hk2` 进入交互式 REPL（智能体循环 + 工具调用 + 自动
知识库上下文）。

```bash
hk2                          # 交互式 REPL（默认）
hk2 --tui                    # Claude Code 风格内联 TUI（无 TTY 时回落 REPL）
hk2 --repl                   # 强制经典行式 REPL
```

### 项目选择与会话恢复

```bash
hk2 --project=myapp                        # 按名称
hk2 --project-id=8ce5c38d-214c-4e0d-8ed1-30045dd3c99d   # 按 UUID
hk2 --project-list                         # 列出所有项目并退出（当前项标记 '*'）
hk2 --resume                               # 恢复当前项目最近的会话
hk2 --resume 3f9c1a2e                      # 恢复指定会话
hk2 --project=otherapp --resume            # 恢复其他项目最近的会话
```

- `--project` 与 `--project-id` **互斥**——二选一。重名会被拒绝并提示改用
  `--project-id`。
- 项目选择为本次会话固定项目（不重写全局共享的 `current` 指针，因此并行的
  `hk2 --project=<其他>` 进程不会翻转本会话的项目）。
- `--resume` 与 `--project*` 仅在默认交互模式下有意义。

### 一次性模式

```bash
# 从 CLI 注册项目（等价于 REPL 中的 /project init）
hk2 --mode=project-init --name=myapp --source=/path/to/repo --source-root=src

# 为当前项目构建知识库（全量重索引）
hk2 --mode=build-kb [--source=<path>] [--source-root=<rel>]

# 增量更新知识库
hk2 --mode=update-kb
```

- `--mode=build-kb` 接受 `--source=<path>` 与 `--source-root=<rel>`。省略
  `--source` 时回退到一个较为特殊的默认值 `../../../`（相对当前工作目录
  解析）——建议显式传入，或改用交互式 REPL 中的 `/kb init`。此处的"当前
  项目"含义是：仅当当前项目的知识库已构建时才使用其项目 ID，否则构建目标
  是名为 `default` 的知识库（`HK2_KB_NAME` 可覆盖）。
- `--mode=project-init` 还接受 `--include=<globs>` 与 `--exclude=<globs>`
  （逗号分隔），与 `/project init` 一致。

### 旧版运行模式

```bash
hk2 --run-mode=serve         # 旧版命令式 REPL（无智能体循环）
```

`--run-mode` 接受 `once` 或 `serve`。`once` 是存在 `--mode` 一次性命令时的
内部默认值；不带 `--mode` 运行 `hk2 --run-mode=once` 会**报错**，不会进入
交互模式。

### 版本与帮助

```bash
hk2 --version                # 或 -V
hk2 --help                   # 或 -h
```

### 参数一览

| 参数 | 取值 | 说明 |
|---|---|---|
| `--tui` / `--repl` | - | 前端覆盖；优先于 `HK2_UI` |
| `--project` | `<名称>` | 与 `--project-id` 互斥 |
| `--project-id` | `<uuid>` | 与 `--project` 互斥 |
| `--project-list` | - | 一次性；输出后退出 |
| `--resume` | 可选 `<sessionId>` | 仅交互模式 |
| `--mode` | `project-init`、`build-kb`、`update-kb` | 一次性模式 |
| `--run-mode` | `once`、`serve` | `serve` = 旧版 REPL |
| `--name` / `--include` / `--exclude` | 字符串 | `--mode=project-init` 的操作数 |
| `--source` / `--source-root` | 字符串 | **同时**是 `--mode=project-init` 与 `--mode=build-kb` 的操作数 |
| `--version` / `-V`、`--help` / `-h` | - | |

## 语言支持

支持是一个阶梯而非开关——请确认你的语言在哪一级。

### 原生 Tree-sitter 解析（AST 精确）

14 个包、15 个语法（`tree-sitter-typescript` 同时导出 `typescript` 与
`tsx`）：

- C（`.c` `.h`）、C++（`.cpp` `.cc` `.cxx` `.hpp`）、C#（`.cs`）
- JavaScript（`.js` `.mjs` `.cjs` `.jsx`）、TypeScript（`.ts`）、TSX
  （`.tsx`）
- Python、Go、Rust
- Java、Kotlin（`.kt` `.kts`）、Scala
- Ruby、PHP
- Bash（`.sh` `.bash` `.zsh`）

Tree-sitter 支持的符号*可以*填充更丰富的字段——限定名、父级链接、基类、
实现接口、导入、文档注释——前提是相应语法与提取器实现了它们；各字段均为
可选（部分语言没有导入提取；某些符号没有父级、继承或文档字符串）。

> **glob 注意**：*默认* include globs（见
> [配置](configuration.md#默认-include--exclude-globs)）不含 `**/*.cs` 与
> `**/*.kts`，因此 C# 与 Kotlin Script 文件虽可解析，默认的 `/kb init`
> **不会扫描**它们。由于 `--include` 是**整体替换**默认集合而非追加，请
> 从配置页复制默认列表、追加 `**/*.cs` 与 `**/*.kts` 后，把完整列表传给
> `/project init --include=...` 或 `/project set include ...`。

### 正则回退解析器

Tree-sitter 不可用时（未 `npm install`、ABI 不匹配、缺少语法），hk2 透明
回退到基于正则的解析器——覆盖率略低，但 `Symbol[]` 结构相同：

- **C / C++**——专用 C 解析器（`.c` `.h` `.cpp` `.cc` `.cxx` `.hpp`）
- **lex / yacc**——专用解析器（`.y` `.l`）
- **通用解析器**——Python、JS/JSX/TS/TSX、Go、Rust、Java、Kotlin、Scala、
  Ruby、PHP、**Swift**、shell

注意两处不对称：**Swift** 在 hk2 中没有 Tree-sitter 语法（仅正则）；**C#**
没有正则回退（仅 Tree-sitter——缺失时 C# 文件不产出符号）。

### 文档格式（文档解析器，标准库）

Markdown（`.md` `.markdown`）、纯文本（`.txt` `.rst` `.adoc`）、JSON、
YAML（`.yaml` `.yml`）、HTML（`.html` `.htm`）、SGML 用标准库解析。无
扩展名的惯例文件（README、LICENSE、CHANGELOG、CONTRIBUTING、AUTHORS、
NOTICE、CHANGES、HISTORY……）可被解析器识别——但*默认* include globs 只
显式列出 README*/LICENSE*/CHANGELOG*/CONTRIBUTING*，AUTHORS/NOTICE/
CHANGES/HISTORY 需加入 include globs 后才会被解析。PDF（`.pdf`）需要可选的 `pdf-parse` 包；Word（`.docx`）需要 `mammoth`。
`.pptx` 经内置 OOXML ZIP/XML 读取器提取；更老的 `.doc` / `.ppt` 二进制经
内置的尽力而为可打印文本启发式提取——内置提取不是完整的 Office 渲染器，
不保证恢复复杂布局、图表、嵌入对象或全部文本。解析后的文档以
`doc:<relpath>` 条目归入 Eden 空间。

### 不覆盖

没有语言映射的扩展名若被 include glob 命中仍会被扫描，但通用解析器对它
返回空符号列表（非文档且无映射的文件进入文件注册表但零符号）。上文列出
的文档格式则交给文档解析器处理。确需从新扩展名产出符号时再添加显式映射。

## 相关文档

- [安装](../getting-started/installation.md)——构建 Tree-sitter 绑定
- [知识图谱与检索](../concepts/knowledge-graph-and-retrieval.md)——解析结果流向哪里
- [问题排查](../guides/troubleshooting.md)——`tree-sitter parse failed` 与 ABI 问题
