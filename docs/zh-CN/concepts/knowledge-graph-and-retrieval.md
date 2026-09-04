# 知识图谱与检索

[English](../../en/concepts/knowledge-graph-and-retrieval.md) | 简体中文

本页解释 hk2 如何把源码树变成可检索的知识库：文件扫描、带正则回退的
Tree-sitter AST 解析、符号模型、BM25 索引、代码知识图谱，以及按请求检索
如何为智能体提供上下文。

## 索引管线

`/kb init`（以及增量 `/kb update`）执行以下管线：

```mermaid
flowchart LR
    A[遍历文件<br/>include/exclude globs<br/>+ .gitignore] --> B[逐文件解析<br/>Tree-sitter AST<br/>或正则回退]
    B --> C[Symbol 记录]
    C --> D[BM25 倒排索引]
    C --> E[知识图谱<br/>节点 + 边]
    C --> F[文件注册表<br/>+ 分片符号表]
    G[文档<br/>md/pdf/docx/...] --> H[文档解析器] --> I[Eden doc: 条目]
    G --> K[文档图谱<br/>链接、表格、代码块、<br/>文档间 + 文档到符号引用]
    K --> L[doc_index.json]
    C --> J[LLM 摘要<br/>project-overview 等]
```

1. **文件扫描**——`lib/index/walker.js` 遍历项目根，遵循 include/exclude
   globs（默认覆盖常见源码与文档扩展名）与 `.gitignore` 规则
   （`lib/index/gitignore.js`）。项目注册的 `sourceRoot` 与额外根都会被
   遍历。
2. **解析**——`lib/parser/ast.js` 按文件扩展名分发。Tree-sitter 原生绑定
   可用且存在对应语法时，`lib/parser/ts_parser.js` 执行 AST 遍历；否则
   回退到专用正则解析器（C/C++、lex/yacc）或通用正则解析器。文档
   （Markdown、JSON、YAML、HTML、SGML、PDF、Word、PowerPoint、纯文本）
   经 `lib/parser/doc_parser.js` 处理，以 `doc:<relpath>` 条目归入 Eden
   空间。
3. **符号提取**——每次解析返回 `Symbol[]` 记录：名称、种类（函数 / 方法 /
   类 / 接口 / 结构体 / 字段）、行范围、签名、限定名、父级、基类、实现
   接口、导入与文档注释。
4. **索引构建**——BM25 倒排索引（`lib/index/bm25.js`，分词器在
   `lib/index/text_tokenizer.js`，含中英混查词典）、旧版调用图、知识图谱
   （`lib/graph/builder.js`）与文件 / 符号注册表写入
   `~/.hk2/kb/<projectId>/`。
5. **摘要**——`/kb init` 结束时，**在已配置模型且未传 `--skip-summary` 的
   情况下**，LLM 才会撰写三个结构性 Eden 条目。未配置 LLM 时索引照常构建，
   仅跳过摘要条目。

解析运行在有界并行池中——`HK2_INDEX_PARALLEL` 固定并行度（默认：自动，
取宿主 CPU 数并遵循 cgroup 配额）。

## 符号模型

Symbol 记录是知识库的通用货币。Tree-sitter 路径与正则回退路径产出相同
结构；AST 路径额外填充 `qualName`、`parentSymbolId`、`superClass`、
`implements`、`imports` 与 `docString`。下游一切——BM25、图谱、大纲、调用
链——都消费 Symbol，因此缺失语法对*有*正则回退的语言只是降低精度；对
没有回退解析器的语言（尤其是 C#）则完全不产出符号。

## 知识图谱

`/kb init` 时，hk2 基于 Symbol 构建代码知识图谱：

```text
~/.hk2/kb/<projectId>/graph/
  nodes.json            id -> 节点记录（函数 / 方法 / 类 / 接口 / 结构体 / 字段）
  edges.calls.json      srcId -> [calleeIds, ...]
  edges.imports.json    srcId -> [被导入文件节点 ids, ...]
  edges.inherits.json   srcId -> [基类 ids, ...]
  edges.contains.json   srcId -> [成员 ids, ...]
  by_kind.json          kind -> [nodeIds, ...]
  by_qual.json          qualName -> nodeId
  meta.json             计数 + 版本
```

边的种类：

- **calls**——函数 / 方法调用关系（尽可能解析为符号 id）
- **imports**——文件级导入边，指向被导入文件中的符号
- **inherits**——类 → 基类边
- **contains**——类 → 成员（方法 / 字段）包含关系

除符号图谱外，hk2 还构建**文档图谱**（`lib/index/doc_graph.js`，经
`doc_index.json` 持久化）：文档间的 Markdown 链接、从文档提取的表格与
代码块、文档之间的引用，以及文档对已索引源码符号的引用。与查询相关的
结构化表格和文档↔代码引用会随按请求上下文一起呈现。

图谱通过智能体工具查询（见[智能体工具](../reference/agent-tools.md)）：

- `kb_callchain`——对调用图做有界 BFS（前向、后向、双向）
- `kb_class`——类 / 接口 / 结构体查询，含成员与实现
- `kb_refs`——谁调用了 / 导入了 / 继承了某符号
- `kb_implements`——查找实现某接口的所有类

REPL 侧的等价命令是 `/kb neighbors`（1 跳）及上述工具。

## BM25 检索

`/kb search <query>` 与 `kb_search` 工具按 BM25 倒排索引对符号排序，再按
名称匹配重排。默认先由 LLM 把用户查询改写为英文函数名 + 关键词
（`HK2_ENABLE_QUERYREWRITE`，默认开启；`kb_search` 接受 `skip_rewrite`
在你已有标识符时跳过改写）。头部结果可携带 ±15 行源码切片，智能体通常
无需再 `read`。

知识条目由 `kb_search_knowledge` 单独检索（对 Holy + Eden 的标题、关键词
**与 intro 正文**做重叠匹配——标题 / 关键词命中主导排序，intro 命中让仅在
正文提到该事实的条目也能浮现）。

## 按请求注入上下文

对每条实质性用户消息，智能体循环开始之前，hk2 *可能*执行以下阶段
（每个阶段都有开关——明确的会话性后续输入走快速通道全部跳过；改写与
评估可经环境变量关闭；评估仅在可交互提示的场景运行）：

1. 把查询改写为检索词（LLM 调用——完整前置管线见
   [智能体工作流](agent-workflow.md)）。
2. 从知识库检索相关**符号**、**调用链**、**类成员**、**知识条目**与
   **解析的文档**（`lib/agent/graph.js` +
   `lib/retrieval/context_builder.js`）。
3. **之后**才评估请求清晰度——刻意放在首次检索**之后**，让评估模型对照
   已检索到的项目上下文判断；不清晰时弹出澄清菜单，随后执行第二次改写 +
   检索。
4. 将结果作为 `# Knowledge-base context` 章节注入系统提示词——位于项目
   最高准则章节**之后**，因此项目法则始终优先于检索到的知识。

镜像真实文件的知识库内容遵循与读取源文件相同的 `r` 权限——被拒绝的源
文件会从摘要、切片与注入上下文中抑制，而纯元数据保持可见（见
[安全与权限](../guides/security-and-permissions.md)）。

## 增量更新、检查点与恢复

- **增量更新**——`/kb update` 对文件重新计算 sha256，仅重新解析变化的
  文件，然后重建派生索引。它还会自动检测旧版知识库布局：先把
  知识条目备份到 `backup/pre-upgrade-<ts>/`，再按当前迁移代码处理（解析器
  版本变化会触发全量重建）。
- **检查点**——`/kb init` 每处理 N 个文件保存一次检查点
  （`--checkpoint-interval=N`，默认 `HK2_KB_CHECKPOINT_INTERVAL=100`）。中断
  后重新运行从*最近一次*已保存的检查点恢复：其中记录的文件被跳过，而该
  检查点之后、下次保存之前完成的工作会被重做。`--no-checkpoint` 禁用
  检查点，`--no-resume` 从头开始。
- **大型项目**——解析并行度随 CPU 数扩展；`/kb knowledge learn` 的规划器
  在索引文件超过 300 个时从文件级切换为目录级规划（见
  [知识库工作流](../guides/knowledge-workflows.md)）。

## 相关文档

- [知识库](knowledge-base.md)——三空间模型
- [智能体工作流](agent-workflow.md)——检索在回合管线中的位置
- [CLI 与语言支持](../reference/cli-and-language-support.md)——哪些语言用 Tree-sitter、哪些用正则回退
