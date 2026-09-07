# WP05 精细源码保真接线设计

本文只定义 WYSIWYG 到原始 Markdown 的局部保真接线，当前不接入生产核心。它依赖已经通过独立检查的 `sourceLeafProvenance` 受限首片，以及版本化专用 recovery codec。设计目标是：一次 WYSIWYG 事务只记录受影响的原文范围，未改变的范围继续引用最近一次 snapshot 的原始片段；完整 UTF-16 字符串和 UTF-8 bytes 只在明确的 snapshot/保存/恢复边界物化，不能在每个输入事务中重新创建整篇 raw string。

## 边界对象与版本

接线层在导入或快照边界建立一个不可变 baseline：

```ts
type SourcePreservationSnapshot = {
  rawSource: string;
  rawBytes: Uint8Array;
  baseRevision: number;
  doc: ProseMirrorNode;
  blocks: readonly SourceBlockBaseline[];
  pendingMathVersion: number;
};

type SourcePreservationState = {
  base: SourcePreservationSnapshot;
  logicalRevision: number;
  deltas: readonly SourceBlockDelta[];
  dirtyBlocks: PersistentDirtyBlockMap;
  historyCheckpointId: string;
};

type SourceBlockBaseline = {
  id: string;
  pmPath: readonly number[];
  pmFrom: number;
  pmTo: number;
  rawFrom: number;
  rawTo: number;
  contentFrom: number;
  contentTo: number;
  separatorFrom: number;
  separatorTo: number;
  kind: string;
  leaves: readonly SourceLeafSpan[];
};

type SourceBlockDelta = {
  sequence: number;
  beforeRevision: number;
  afterRevision: number;
  blockId: string;
  forward: readonly SourcePatch[];
  inverse: readonly SourcePatch[];
  pmTransactionId: string;
};

type DirtyBlockState = {
  blockId: string;
  baseBlock: SourceBlockBaseline;
  pieces: PersistentPieceTree;
  localRevision: number;
};

// These are persistent/path-copy structures or an equivalent piece implementation;
// copying a whole block table or raw document for every keystroke is out of scope.
type PersistentDirtyBlockMap = unknown;
type PersistentPieceTree = unknown;
```

`rawFrom/rawTo`、`contentFrom/contentTo` 和 separator 均来自同一 Markdown 解析/预处理 pipeline 的真实 token 或 observer span。它们是 JS 字符串的 UTF-16 code-unit 坐标；磁盘 byte offset 只在 snapshot、bundle/保存边界使用。所有范围必须单调、不重叠、覆盖正文及其 separator。`pmPath` 与不可变 `doc` 身份用于防止同结构但不同内容的旧 snapshot 被误用，`baseRevision` 与增量的 `beforeRevision` 用于拒绝旧原文。

### 输入热路径与 snapshot checkpoint

输入事务不调用 `applySourceLeafPatches(rawSource, ...)`，也不生成下一版完整 `rawSource`。它只把 StepMap 反向得到的受影响 block 追加为一个有界 `SourceBlockDelta`，并在该 block 的持久 piece tree 中更新局部片段；未改变 block 仍指向 `base.blocks`。局部 block 若很长，也必须使用 piece/chunk 结构，不能把整块字符串复制到每个 delta。

`materializeSourceSnapshot(state)` 只在显式 snapshot、保存、模式切换、恢复导出或日志压力边界执行：它按 block 顺序折叠 dirty piece，直接复制未改变 block 与 gap/separator 的 base span，生成一次新的完整 `rawSource/rawBytes`，并重建受影响 blocks 的 token/leaf metadata。成功后 `baseRevision = logicalRevision`、清空 `deltas/dirtyBlocks`，并把新的 PM doc、pending version 和 history checkpoint 一起记录。普通输入不经过这个物化函数。

日志必须有可观察的界限：最大 delta 数、累计插入/删除 UTF-16 长度、dirty block 数、单 block piece 数和最长未 snapshot 时间均配置在状态契约中。达到任一上限时只触发一次明确的 checkpoint；若 checkpoint 不能完成，保留 raw base、PM doc 和 local buffers，进入 recovery/重试状态，不偷偷创建全文字符串或规范化保存。checkpoint 不得删掉仍被 PM history 引用的旧 checkpoint；历史需要的 inverse delta 或旧 piece root 保留到对应 history branch 被丢弃。新的编辑和 undo/redo 都以当前 `logicalRevision` 追加 forward/inverse delta，再次 snapshot 重新建立基线，不能把旧 baseline 的全文覆盖当前文档。

每次事务映射返回一个有界结果，而不是直接返回整篇 Markdown：

```ts
type SourcePatchSet = {
  beforeRevision: number;
  afterRevision: number;
  forward: readonly SourcePatch[];
  inverse: readonly SourcePatch[];
  changedBlockIds: readonly string[];
  pmTransactionId: string;
};

type SourcePatch = {
  blockId: string;
  // UTF-16 offsets in this block's piece view immediately before beforeRevision.
  // These are not absolute offsets in base.rawSource.
  pieceFrom: number;
  pieceTo: number;
  expected: string;
  insert: string;
};

type SourceMappingResult =
  | { ok: true; value: SourcePatchSet }
  | { ok: false; error: SourceProvenanceMappingError };
```

局部 delta 应用前检查 `beforeRevision`、block piece revision、PM transaction identity 和每个局部 `expected`；`pieceFrom/pieceTo` 只对这个 `beforeRevision` 的 block piece root 有效，不得当作 `base.rawSource` 的绝对坐标。这里不要求也不接受整篇 `rawSource` 参数。snapshot 物化前后再以完整 source hash/bytes 做一次边界校验。未改变 block 的 `SourceBlockBaseline` 和 leaf 数组按引用复用；输入时只更新受影响 block 的持久 piece/log，不复制整篇 metadata 或全文字符串。

### 多次编辑的坐标契约

`SourceBlockBaseline.rawFrom/rawTo` 是最近一次 snapshot 中完整原文的绝对 UTF-16 区间；`SourcePatch.pieceFrom/pieceTo` 是某个 `beforeRevision` 下该 block 的当前 piece 坐标。两者故意使用不同字段，不能把 dirty piece 坐标复用成 baseline raw 坐标。若实现需要跨 checkpoint 定位，应额外保存不可变 base piece id/offset 或逐段 parent revision 链，而不是改变上述字段含义。

一个事务的 `StepMap` 只能够逆映射当前 transaction 的 before/after 文档。连续编辑之后，单独逆映射最后一个 `StepMap` 不能得到更早 baseline 的 raw span；接线层需要持久的 PM block/path 到 piece-root 索引，并在每个 delta 中保存 `beforeRevision`、`afterRevision`、block identity 和 forward/inverse piece operations。undo/redo 先在当前 piece root 上验证 expected，再沿 revision 链应用 inverse/forward；重新 snapshot 后只允许新的 baseline 坐标进入 `SourceBlockBaseline`。这也是为什么实现不能用“当前 transaction StepMap + 全文 raw diff”替代持久映射。

## 事务路径

1. WYS 事务到达接线层时，先用真实 `StepMap` 将每个 step 的旧范围映射到当前 before/after 文档，再通过持久 PM block/path 到 piece 索引得到受影响的 block。`StepMap` 本身不被当作跨多次编辑的 baseline 映射；不扫描整篇文本、不对当前文档做规范化 diff。
2. 若范围只落在一个已有 block 的一个或多个 text leaf 内，取该 block 的 raw span 和 PM 子树，调用 parser-backed leaf mapper。mapper 只能返回 raw span 内的非重叠 patch；同一事务的多个 leaf patch 按 raw 起点合并，只有 exact 等长连续片段或同一 raw span 才允许合并。
3. 若同一事务触及多个 block，分别映射各 block，再以一个 `SourcePatchSet` 应用；block 之间的原文 gap 和 separator 原样保留。任何 patch 越过 block/content/separator 边界都返回 typed failure。
4. block 结构变化（新增/删除 list item、table row/column、段落拆分/合并）走显式结构适配器。适配器必须返回受影响 block 与 separator 的完整 raw span；不能把整个旧 list/table/cell 重新 Turndown 后冒充局部保真。尚未有适配器的结构事务返回 `structure-changed`，但保留当前 PM 文档和恢复材料。
5. 局部 patch 成功后只追加 forward/inverse delta，并更新受影响 block 的 piece root、logical revision 和 dirty metadata；不生成下一版全文 baseline。源码编辑器自己的 history 仍保存 CM 文本和换行 metadata；本设计不把 WYS 与源码模式的 history 宣称为同一历史。WYS undo/redo 也追加对应 inverse/forward delta，直到显式 snapshot 才折叠为新的完整 base。

## block 与真实 parser span

顶层 block 列表必须来自生产 `markSpecialBlocksForEditor` 的同一 pipeline。每个 transform 通过 observer 记录实际 replacement 的原始 `[from,to)`，并把占位片段继承为完整 raw span；生成节点可以是 `[EOF,EOF)` 的 zero-width span。不能维护第二套正则预处理，也不能用最终字符串 diff、全文 `indexOf` 或“节点数量相等”推断来源。

每个 block 需要同时记录正文和 separator 的所有权。普通段落/列表项的 marker、表格 pipe/delimiter、块公式 fence、frontmatter、mermaid、HTML、脚注定义等语法范围属于 block span；未编辑 block 直接复制其 snapshot `rawFrom/rawTo` 内字节，dirty block 则按当前 piece root 物化。相邻 block 的空行归前一个 block 的 separator 或由明确的左右 boundary policy 分配，不能在 patch 时临时 `trim()`。

首片只接入已经证明的 plain text leaf、空表格 cell slot 和同一 block 的多个 leaf。空 slot 必须有 parser 产生的唯一 raw 空区间、真实 PM paragraph/cell path、padding 及 UTF-16 PM 位置；找不到唯一区间就 typed fail。公式和特殊块未编辑时复用原 span；编辑它们需要各自 token span 适配器，不能把公式节点当普通 text。

## 语法与 marks 的取证规则

Markdown-it 的 token `content` 只能在 raw region 与 token content 完全相等时证明 plain leaf。实体、反斜线 escape、strong/emphasis、link label/destination、inline code、HTML、项目扩展 `$ ~ ^ ==` 只要 parser 没有给出实际 inline source span，就返回 `unsupported-inline` 或专用 typed code。

后续支持这些语法时，必须从真实解析过程取得区间：为 inline rule/transform 加可选 `onReplace(from,to,replacement)` observer，或让 token 携带 parser 产生的 child span。link 的 label 与 destination 是不同 span；只改变 label 时只 patch label，改变结构 delimiter/destination 时扩大到该 link 的完整 raw span。任何 span 缺失、重叠、逆序或重解析后 token/PM 结构不相等都失败，不以更多保护 regex 补洞。

marks 变化首先作为 typed failure；有适配器后需在受影响 raw span 内同时核对 mark 集合和 parser token 结构，未编辑的相邻 mark/text 片段仍按原 span 复用。实体解码后的 PM 文本不能直接写回 raw 字符串，否则会把 `&amp;` 变成 `&` 并改变语义。

## 失败与恢复出口

映射失败不调用同一 serializer 作为恢复手段，也不把 Turndown 结果称为精确 Markdown。接线层必须通过通用 local-buffer registry 捕获以下状态，而不能只捕获 pending math：

```ts
type RecoveryLocalBuffer = {
  id: string;
  kind: "frontmatter" | "htmlBlock" | "footnote" | "toc" | "mermaid" | "math" | "exposedMarkdown" | string;
  version: number;
  pmPath?: readonly number[];
  rawSpan?: { from: number; to: number };
  payload: unknown; // versioned, schema-validated JSON data; never executable
};

type RecoveryLocalState = {
  buffers: readonly RecoveryLocalBuffer[];
  exposedMarkdown?: unknown;
  pluginStateVersions: Readonly<Record<string, number>>;
  sourceBaseRevision: number;
  deltaSequence: number;
  historyCheckpointId: string;
};
```

`frontMatter`/`htmlBlock`/`footnote`/`toc`/`mermaid` 的 textarea 或局部编辑缓冲、special-block provenance、`exposedMarkdown` 插件态、公式 accepted/local payload 和 composition/blur 状态都必须注册到该接口；payload 中的原始 HTML、代码、脚注文本可以作为数据保存，但不能在 codec 或导入时执行。后续 history 接口还需保存当前 history branch/cursor、可回到的 source checkpoint、forward/inverse delta 序列及其版本关联，不能仅凭当前 PM doc 猜回撤销状态。

当前 v2 recovery codec 只完整校验 PM doc、selection/scroll、origin 和 pending math；pending math 的 `linked` binding 必须匹配当前节点及 accepted attrs，`conflicted`/`orphaned` binding 只保存带原因的未关联 accepted/local payload 与可选旧位置提示，恢复方不得按位置自动提交。它不宣称捕获上述通用 local state 或 WYS history。生产恢复接线必须先扩展为版本化 `localState`/`history` 字段并为每种 buffer 提供 schema validator，再把 `RecoveryLocalState` 传入 codec；未知版本/未知必需字段拒绝，不能静默丢局部状态。映射失败时保留 raw base/piece roots、当前 PM doc JSON、selection/scroll、local buffers、pending payload、logical/base revision 和来源元数据，然后调用纯 recovery codec 生成专用 JSON。原会话继续保留 PM 文档和未提交局部状态，用户可以重试或导出恢复文件；导出失败不销毁会话。

恢复读入在新未命名会话中进行，校验版本、大小、UTF-8 bytes、PM schema canonical JSON、Selection/CellSelection 边界、数学节点关联、local buffer schemas 和 history checkpoint 关联，不覆盖原文件路径。恢复 renderer 的 HTML/脚注/公式安全边界仍由后续 WYS 接线负责；codec 本身只处理数据，不执行 JSON 中字符串。一个 syntax adapter 的失败只阻止该次精确回写并进入可重试的 dirty/recovery 状态，不把整个产品的保存能力改成广泛拒绝清单，也不允许用规范化输出掩盖失败。

## 可逐片验收的顺序

1. **局部 plain leaf**：普通段落、列表项、已有表格 cell 的单字增删替换；同事务两个 block；BOM、LF/CRLF/CR、中文和 surrogate pair。验收未编辑 marker/header/pipe/separator 的 bytes 完全相等。
2. **empty slot**：空 table cell 插入、删空后重建 baseline 再插入、多个空 cell 的非目标 cell 原样保留；无法唯一映射的 synthetic 空 paragraph 必须 typed fail。
3. **局部结构**：单个 list item、table row/cell 的插入和删除，明确 separator 所有权；覆盖前后相邻 block、首尾 EOF、同一事务多结构 step。每个适配器都要给真实 PM transaction 和 parser token span，而不是 mock range。
4. **特殊 block**：frontmatter、block math、mermaid、HTML、footnote、代码 fence、TOC 等每个变行数 transform 使用同一 observer pipeline；未改块 exact 复用，块内编辑单独通过或 typed fail。
5. **语法叶**：marks、实体、escape、link、inline code 和项目扩展按真实 parser span 逐类接入；在 span 证据完成前保留 typed failure，不改变既有产品路径。
6. **unsupported recovery**：注入每类 mapping failure，验证 PM 文档、raw base/piece roots、FrontMatter/HTML/footnote/TOC/mermaid/exposedMarkdown 等 local buffers、pending payload 和 history checkpoint 都保留；bundle 导出/读入闭环不调用失败 serializer，也不覆盖原路径。当前 v2 codec 缺少这些字段时，测试必须明确标为集成前置条件。
7. **性能**：用 100/1000/5000 个同构 block 重复测量热路径的 delta/piece 数量和耗时，以及显式 snapshot 的按块物化耗时/峰值内存；分别比较未改 block 复用、一个 block 改动、多个 block 改动和日志到达上限的 checkpoint。未有重复样本前只报告诊断，不宣称输入 O(local)、全文线性或满足帧预算；任何完整 raw string 创建都必须出现在记录的 snapshot/保存边界。

这套接线不会把 unsupported 范围扩张成产品禁用清单。每一片都先证明来源 span、局部 patch、失败保留和恢复读入，再扩大语法或结构覆盖。

## 局部状态恢复审计与 v3 设计（仅设计，不接入生产）

本节依据当前 `WysiwygEditor.vue`、`MermaidNode.ts`、`wysiwygMarkdownEditing.ts`、`MathNodes.ts` 和 `DocumentTab` 的真实生命周期补齐恢复边界。当前 v2 codec 仍只负责已经实现的 document/selection/scroll/origin/pending-math 数据；本节不改变 codec、WYS、store 或导入路径，也不把设计项写成已实现能力。

### 现有局部缓冲和只读捕获契约

现有 NodeView 的输入大多先写入闭包变量，失焦或显式提交时才 dispatch 到 PM attrs。因此只读恢复捕获必须在 NodeView 注册一个 callback，在导出边界读取闭包和 DOM，不能只从 `editor.state.doc` 推断。每个 callback 返回 `ok` 或带 `kind/id/positionHint/reason` 的 typed failure；某个节点被销毁、`getPos()` 失效或 DOM 尚未挂载时，保留该条 orphan 数据并继续捕获其他条目。

| 局部状态 | 当前真实来源和生命周期 | 只读捕获字段 | 重建边界和限制 |
| --- | --- | --- | --- |
| FrontMatter | `WysiwygEditor.vue` 的 `FrontMatterNode` NodeView。PM attrs 是 `yaml/editing`；textarea input 只更新闭包 `yaml`，blur 的 `updateYaml()` 才写回 attrs。当前没有 registry/destroy callback。 | 稳定 buffer id、PM path/position hint、accepted `{yaml, editing}`、未提交 `yaml`、编辑中标志、textarea selection/focus/composition 证据。 | 新 PM doc 先恢复 attrs，再由挂载后的 callback 写入 local draft；draft 不自动当作已提交 YAML。position 过期时保存 orphan，不按旧位置写入。YAML 只作为数据，不能把它当 DOM。 |
| HtmlBlock | `HtmlBlockNode` NodeView 持有 `html/editing/committing`。初始化会对 attrs 做 `decodeHtmlEntities` 与 `sanitizeHtmlFragment`；textarea input 只改闭包，commit/blur 才 dispatch。显示路径使用 `renderInlineMarkdownInHtml`。 | 同时保留 accepted attrs、当前 textarea 文本和其“已解码/已清理”状态；编辑标志、committing、position hint、selection/focus/composition。若要保留用户尚未提交的原始输入，必须捕获 textarea 当前值，不能从已经清理的 PM attr 反推。 | 恢复只构造受校验的 node attrs，并在 NodeView 的既有 sanitizer/render 路径显示。恢复 JSON 里的 `<script>` 等字符串可以保留为数据，但不得直接 `innerHTML` 或执行；渲染失败保留 local buffer。 |
| Footnotes | `FootnotesNode` 闭包有 `markdown/fallbackHtml/editing/committing/frame`。textarea input 只改 markdown；commit 调 `normalizeFootnoteSource`，会把 CRLF 归一化为 LF 并 trim。`renderFootnotesView()` 对空 source 直接执行 `dom.innerHTML = fallbackHtml`，这是必须保留数据和渲染安全分离的边界。 | accepted `{markdown, html, editing}`、未归一化 textarea markdown、fallbackHtml 原值、commit/frame 状态、position hint、selection/focus/composition；ref id/order/preview 不作为可信缓冲，需由 PM doc 重建。 | 恢复先保留原 fallbackHtml 作为不透明数据，再经过未来 renderer 的过滤/capability 边界后显示；尤其不能让 recovery importer 直接把 `fallbackHtml` 送入当前空 source 分支。空 markdown、HTML-only fallback、提交前 CRLF 是必测例。 |
| TOC | `TableOfContentsNode` 只有 `editing` PM attr；展示列表每次从当前 doc headings 派生。编辑时的 input 只暂存 `[TOC]` 或用户替换候选值，blur 后可能调用 `replaceTocWithText()` 删除节点。NodeView destroy 会解绑 update listener。 | PM node 状态、当前 input candidate、editing、input selection/focus/composition、position hint；不保存由 headings 派生的 item 列表。 | 先恢复 PM TOC node，再把未提交 candidate 作为待确认 local input；不自动执行 replacement。若 bundle 只含已提交文档，重新从 doc 生成列表。 |
| Mermaid | `MermaidNode.ts` 闭包保存 `code/editing/previewTimer/previewVersion`；textarea input 改 code 并异步预览，blur 延迟提交。`destroy()` 清 timer 并递增 version。SVG/错误 `<pre>` 是可重建缓存，不是源状态。 | accepted code、当前 textarea code、editing、selection/focus/composition、position hint，以及可选的 preview generation/status（只作诊断）。不保存 SVG、timer handle 或异步结果 HTML。 | 新 doc 恢复 code/editing，NodeView 以新 generation 重新渲染；使用既有 Mermaid strict security 选项，旧 generation 的异步结果必须被丢弃。捕获不 flush、等待 timer 或触发 render。 |
| Footnote refs / special derived DOM | `FootnoteRefNode` 的 preview 与索引从 attrs/doc 和 `renderMarkdownForEditorWithAssets` 派生，没单独用户输入。frontmatter/HTML/footnote/mermaid 的 display DOM 同样是派生物。 | 只捕获真正的 local input/accepted attrs；preview、编号、装饰和 DOM HTML 作为可重建缓存，不冒充 raw source。 | 先恢复 PM 数据，再以现有 parser/sanitizer/capability renderer 构造 DOM；不能从截图或 `innerHTML` 反推原文。 |
| exposedMarkdown | `ExposedMarkdownLifecycle` 的 `PluginKey` 状态是 `ExposedMarkdownRange | null`，由 `exposeMarkdownMeta` 写入，随 transaction mapping 移动，`clearExposeMarkdownMeta` 清除；presentation transaction 标记 `addToHistory:false`。 | 当前 range 的 `kind/from/to/blockFrom/open/close/markName/headingLevel/headingInvalid`、PM doc revision/identity、当前 anchor/head/direction，以及 presentation 是否处于 active 生命周期。所有位置是 PM UTF-16 positions。 | PM doc 恢复且位置/节点/mark 校验通过后，再以受控 `addToHistory:false` presentation transaction 恢复生命周期；不直接向 doc 注入 marker。范围无法验证时保存 exposed payload 为 orphan/local state，并清除运行时装饰。 |
| IME composition | 普通 WYS 输入的 composition 状态由 `EditorView.composing` 提供；FrontMatter/HTML/Footnotes/Mermaid textarea 当前没有统一 composition registry；Math NodeView 自己有 `composing` 和 compositionstart/end listener。 | editor `view.composing`、活动 local buffer 的 composing、selection/focus、value revision；不得读取或伪造浏览器 composition event payload。 | 恢复为“正在编辑的 dirty buffer”并在 UI 可用时放回文本/selection；不承诺跨进程继续原生 IME 会话，也不合成 compositionend。 |
| WYS format history | `DocumentTab.wysiwygFormatHistory` 是运行时 plain data，`undo/redo` 最多保留 20 项，每项为 `before/after` Markdown 和四个 UTF-16 anchor/head。恢复时校验 `tab.content===expected`，重解析 Markdown，PM transaction 标记 `addToHistory:false`，再写回 tab content。 | 两个栈的完整 entry、栈顺序、limit、当前 source identity/content revision、selection offsets；entry 字符串不得被重新格式化。 | 只有 source identity/expected content 校验通过才重建 custom stack；恢复 entry 不应当进入 PM semantic history。不能把它与 PM history 或源码 CM history 合并。 |
| PM/CM history | StarterKit 默认提供 PM history plugin，但当前没有公开、版本化的 branch/cursor/checkpoint codec；`SourceEditor` 的 CodeMirror history 及换行 StateField 也是独立历史。 | 需要后续明确 adapter 才能捕获 branch、event grouping、inverse steps、checkpoint/source revision；没有 adapter 时状态为 `unavailable`，不能用当前 doc 猜历史。CM history 同理，跨模式 history 当前不在本包承诺内。 | 只有同版本、同 schema、同 source/piece checkpoint 的专用 history adapter 才能恢复。未知 plugin 状态拒绝静默丢弃；至少先保留 bundle 中的 history-unavailable 原因和当前 PM/source snapshot。 |

这些字段都要求同一只读规则：capture 不得 flush、dispatch、blur、focus、destroy、更新 NodeView registry version 或等待异步 preview；读取失败只标记该 buffer，不能抛掉其他 buffer。DOM selection 是辅助 UI 状态，不能替代 PM selection，也不能在捕获期间修改 DOM。

### v3 最小 schema 增量

v3 在 v2 的完整原文 bytes、canonical PM document、selection/scroll、origin 和 pending math 之外增加版本化 `localState`；字段采用显式 kind/状态联合，未知必需字段或未知 schema 版本拒绝，不能静默降级为 Turndown：

```ts
type RecoveryLocalTextUi = {
  anchor: number; // UTF-16 offset in the local buffer
  head: number;
  direction: "forward" | "backward" | "none";
  focused: boolean;
  composing: boolean;
};

type RecoveryLocalBufferV3 = {
  id: string;
  kind: "frontmatter" | "htmlBlock" | "footnote" | "toc" | "mermaid" | "math";
  status: "accepted" | "editing" | "conflicted" | "orphaned";
  sourceRevision: number;
  pmPath?: number[];
  positionHint?: number | null;
  rawSpan?: { from: number; to: number }; // source UTF-16, if provenance is known
  payload: unknown; // kind-specific, schema-validated opaque data
  ui?: RecoveryLocalTextUi;
  error?: { code: string; message: string };
};

type RecoveryExposedMarkdownV3 = {
  active: boolean;
  range: ExposedMarkdownRange;
  docRevision: number;
  selection: { anchor: number; head: number };
};

type RecoveryHistoryV3 = {
  sourceCheckpointId: string;
  format: { undo: WysiwygFormatHistoryEntry[]; redo: WysiwygFormatHistoryEntry[] };
  pm: { status: "captured" | "unavailable"; reason?: string; checkpointId?: string };
  source: { status: "captured" | "unavailable"; reason?: string; checkpointId?: string };
};

type RecoveryLocalStateV3 = {
  schema: "lightmark.local-state";
  revision: number;
  buffers: RecoveryLocalBufferV3[];
  exposedMarkdown: RecoveryExposedMarkdownV3 | null;
  composition: { active: boolean; source: "pm" | "node-view"; revision: number } | null;
  history: RecoveryHistoryV3;
};
```

`payload` 必须按 kind 再做严格验证：FrontMatter 保存 accepted YAML 与 draft；HtmlBlock 保存 accepted/sanitized attrs 与 textarea draft 的状态标记；Footnote 保存 markdown、fallbackHtml 和“是否已 normalize”的状态；TOC 保存 replacement candidate；Mermaid 保存 code 和 editing 状态，不保存 SVG。HTML、脚注 fallback、Mermaid code 仍是数据字符串，codec 不执行。`rawSpan` 只有来自真实 provenance 时才出现，禁止用节点序号或全文 `indexOf` 猜测。

公式现有 capture 已保存 accepted/local/conflict/orphan 状态，但尚未保存 NodeView 内的 DOM 光标。v3 可在 math payload 增加可选 `ui`：block math 从 `.math-block-editor` 读取 `selectionStart/selectionEnd/selectionDirection`；inline math 目前 `getContentEditableCaret()` 只返回单个 UTF-16 caret，若要保留反向选择需新增只读 range adapter，从 `window.getSelection()` 映射到 `.math-inline-source-editor`，映射失败则写 `ui:null` 和 typed reason，不能猜 offset。两者都记录 `focused`、`composing` 和 capture-local `valueRevision`；focus 是恢复提示，不是 PM 语义。恢复在 NodeView mount 后以 opt-in 的 requestAnimationFrame callback 写回 text/selection，不能在 capture 阶段 focus，也不能声称恢复原生 composition 会话。

### 恢复顺序、安全边界和失败出口

未来 v3 importer 的顺序应固定为：

1. 先限制 bundle 大小、校验版本/字段集合/base64/UTF-8 bytes、PM schema `doc.check()` 和 canonical `doc.toJSON()`，再校验 selection、CellSelection、math binding、local buffer schema 与 revision/position 关系。
2. 在新未命名会话创建 PM doc，挂载插件和 NodeView registry；不覆盖原路径，也不把字符串放进 HTML parser 作为可信模板。
3. 对每个 buffer 调用 typed restore callback。先恢复 local text/accepted attrs，再恢复 exposedMarkdown 的可验证 presentation 状态；每项失败保留 orphan payload 和原因，不能用失败 serializer 生成 Markdown 替代。
4. 所有 renderer 从恢复后的数据重新走现有 sanitizer/capability 边界。特别是 `renderFootnotesView()` 的空 source 分支当前把 `fallbackHtml` 交给 `dom.innerHTML`；v3 接入前必须让该值经过与其他 HTML 相同的过滤边界。HtmlBlock 的 display HTML 也遵守相同规则，Mermaid 只重新渲染 code，不恢复存档 SVG。
5. 最后恢复 PM selection、scroll、format history 与可用的 UI selection/focus。PM/CM history 没有同版本 adapter 时保持 `unavailable`，不静默清空，也不伪造可以 undo 的状态。

捕获或导入失败时原会话保持 doc、未提交闭包、pending math、exposed lifecycle 和 history 不变；导出可以重试。专用恢复文件只在全部必要字段通过校验后打开新未命名会话。`fallbackHtml`、`<script>`、Mermaid code 等可能包含 HTML/代码的值可以被完整保存为 JSON 数据，但任何后续执行或 `innerHTML` 写入都必须发生在明确的 renderer 安全边界，而不是 codec 或恢复标记中。

### 最小验收夹具与当前覆盖状态

后续接线前至少应有真实 NodeView/PM fixtures：未 blur 的 frontmatter YAML、包含 `<script>` 字符串的 HtmlBlock、空 markdown + fallbackHtml 的 footnotes、Footnotes textarea 在 CRLF 尚未 normalize 时导出、TOC 输入候选未提交、Mermaid code 修改后 preview timer 尚未完成、exposed heading/inline range 在 presentation transaction 后导出、PM/Math/textarea composition active、公式 block 反向选择与 inline selection、custom format history undo/redo，以及 PM history/CM history 被标为 unavailable 的显式负例。每个 fixture 要检查 capture 前后 doc/version/local text/DOM 不变，并验证恢复失败不影响其他 buffer。

本节是源代码生命周期审计和 v3 设计，不是运行时实现或 UI/导入验收。当前已验收的 Math 只读 capture、recovery codec v2 仍按各自实现边界记录；FrontMatter/HTML/Footnotes/TOC/Mermaid 通用 registry、formula DOM selection、exposed lifecycle restore、PM/CM history checkpoint 和安全 importer 仍是后续独立切片。

## source leaf 到 piece 的局部适配器设计（审查前，不接入生产）

本节只定义把真实 ProseMirror transaction、生产 Markdown 解析 span 和 `sourcePieceState` 对接起来的边界；不修改 WYS、`SourceEditor`、serializer 或现有 `sourceLeafProvenance` 接线。当前首片 helper 仍是独立的、受限的 provenance 证明工具，不能据此宣称 WP05 已经接入产品。

### 数据契约与坐标分层

适配器需要把最近一次 source checkpoint 的原文坐标、当前 dirty piece 坐标和 PM 文档身份分开保存。建议接口如下：

```ts
type PieceLeafBaseline = {
  documentId: string;
  revision: number;
  doc: ProseMirrorNode; // identity check, not a structural substitute
  sourceCheckpointId: string;
  blocks: readonly PieceBlockMetadata[];
  leaves: readonly PieceLeafMetadata[];
};

type PieceBlockMetadata = {
  id: string;
  index: number;
  kind: string;
  rawFrom: number;
  rawTo: number;
  contentFrom: number;
  contentTo: number;
  separatorFrom: number;
  separatorTo: number;
  leafRange: { start: number; end: number };
  pieceRoot: SourcePieceRoot;
};

type PieceLeafMetadata = {
  id: string;
  blockId: string;
  pmPath: readonly number[];
  pmFrom: number;
  pmTo: number;
  rawFrom: number;
  rawTo: number;
  text: string;
  rawText: string;
  marks: readonly string[];
  parserEvidence: { tokenKind: string; childIndex: number; exact: true };
  emptySlot?: {
    leadingPadding: string;
    trailingPadding: string;
  };
};

type PieceTransactionResult =
  | {
      ok: true;
      patchBatch: SourcePiecePatchBatch;
      metadataDelta: PieceMetadataDelta;
    }
  | { ok: false; error: SourceProvenanceFailure };
```

`rawFrom/rawTo` 和 `content*/separator*` 是最近 checkpoint 的完整原文 UTF-16 code-unit 坐标；`pieceFrom/pieceTo` 则是同一 block 在 `beforeRevision` 下的当前 piece 坐标。二者不能互换，也不能把一个连续 transaction 的 piece 坐标重新解释成旧 baseline 的绝对 raw 坐标。磁盘 UTF-8 bytes 只在 snapshot、恢复或保存边界比较。所有 block span 要单调、不重叠并覆盖正文及 separator；生成 block 允许显式 `[EOF, EOF)`，但不能以 `undefined` 或最终字符串 diff 代替来源。

适配器在入口验证 `transaction.before === baseline.doc`、`documentId`、`sourceCheckpointId` 和 `beforeRevision`。PM doc 身份是必要条件；同结构、同长度但文本已经不同的旧 baseline 必须返回 `stale-baseline`。一个 `StepMap` 只能映射本次 transaction 的 before/after 范围，不能逆推出多次编辑前的 raw span。跨事务定位依赖持久的 block/leaf ID、PM path/position 索引和 piece root，而不是重新扫描全文。

### 一次 transaction 的局部流程

1. 首次 baseline 建立时，用真实 Markdown-it、生产 observer/token span 和 PM 文档生成 `exact` leaf 索引；span 必须能证明 raw region、token content 和 PM text 相等。禁止全文 `indexOf`、最终字符串 diff 或第二套正则预处理。这个证明结果属于最近的 validated checkpoint。
2. 每个 step 的 `StepMap` 只用于从持久 PM block/path→leaf 索引收集受影响 block/leaf；未受影响 block 不解析、不复制 metadata，仍按引用指向旧 block state。连续编辑通过持久 mapping 链把旧 PM 坐标映射到 checkpoint leaf，再把该 leaf 的当前范围映射到 transaction.after。
3. 在已证明的 exact plain leaf 内生成当前 piece 坐标的局部 patch。patch 的 `expected` 来自该 leaf 当前 piece span，`pieceFrom/pieceTo` 相对本次 `beforeRevision`；raw span 只用于保留来源和更新 metadata。marker、pipe、delimiter、separator 和相邻未编辑 leaf 不得被 patch 吞掉。输入阶段只做有限的 plain-text/marks/边界守卫，不重解析整块或物化完整 rawSource。
4. 事务成功后状态标记为 `provisional`：所有 block 的 patch 在一个 `SourcePiecePatchBatch` 中原子应用，只 path-copy 被触及的 block metadata、piece root 和 PM→piece leaf index。任一 step 跨 block/content/separator、删除来源 span、改变结构或无法被已证明 leaf 覆盖时，整个 transaction typed failure，不能先应用其他 patch。
5. 显式 snapshot/checkpoint 才物化当前 piece source，并对 dirty block（实现首片可对完整 materialized source）重新走同一 parser/observer pipeline，核对 token/PM leaf 结构、文本、marks 和边界；成功后建立新的 validated baseline，失败则保留旧 validated baseline、当前 PM doc/pieces 和 local buffers 供 recovery，不把 provisional source 当精确 Markdown 保存。
6. 连续 transaction 以新的 revision 和当前 piece root 继续，不用旧 raw 坐标。undo/redo 消费 piece state 的 forward/inverse delta；其 transition delta 必须描述当前 state 的 `beforeRevision → afterRevision`，而不是重新把原始 history entry 当作当前事件。只有显式 checkpoint 才重建受影响 block 的 parser/leaf metadata。

适配器的热路径目标是 `O(log B + Σ affectedBlock(log pieces + affected leaves))` 加已证明 leaf 的局部守卫；这是设计目标，未实现和重复 benchmark 前不宣称已满足。完整 raw string、全量 token/leaf 数组和全树结构扫描只能出现在显式 snapshot、保存、恢复导出或日志界限触发的 checkpoint。状态显式区分 `provisional` 与 `validated`；未通过 checkpoint parser 校验的 provisional source 不进入精确保存。日志需记录 delta 数、插入/删除 UTF-16 长度、dirty block 数和单 block piece 数；达到界限时明确 checkpoint，失败则进入可重试 recovery 状态，不偷偷 materialize。

### 列表、表格和首次接入边界

首片只接入已由真实 parser span 证明的纯文本 leaf、空表格 cell slot，以及同一 transaction 内多个已有 leaf 的 text 增删替换。

- **普通段落和列表项**：列表 marker 不属于 paragraph text leaf。`3. 3` 必须把 PM 文本 `3` 绑定到 marker 后的真实 inline region，不能命中源码中第一个相同字符。纯文本编辑只 patch leaf，保留 marker、缩进、相邻空行和 EOF；新增/删除 list item、拆分/合并段落属于结构变化，首片 typed fail。
- **表格 body cell**：cell 文本 span 必须由实际 table row/inline token 和 pipe-aware region 给出。只编辑 body `x` 时，header、delimiter、cell padding、pipe 和其他 cell 的 raw bytes 仍由旧 span 复用。空 cell 只有在 parser 给出唯一 raw interval、PM cell path、padding 和 UTF-16 位置时才能插入；无法唯一归属时返回 `empty-slot-not-unique`，不能静默丢输入。新增/删除 row/column、改变 pipe 结构和 delimiter 暂由结构适配器处理。
- **同事务多处编辑**：多个 leaf 或多个 block 先分别验证，按当前 before piece 坐标形成一个原子 batch；任一 leaf unsupported 时整批不变。连续两次编辑使用上次结果的 revision/piece root，不重新以 initial raw source 计算。
- **编码和换行**：BOM、LF/CRLF/CR、中文和 emoji 都以 UTF-16 code-unit 坐标处理；surrogate 中间的 patch 边界 typed reject。未编辑换行、BOM 和 block separator 从 piece/base 原样复用，新输入换行策略仍由已有 SourceEditor 契约负责，不在此适配器中规范化。

首片明确不接入 marks、实体/HTML entity、反斜线 escape、link label/destination、inline code、项目扩展语法、公式、frontmatter、mermaid、footnote、TOC、HTML block 或其他特殊 block 的编辑。遇到这些语法不是改变既有产品行为，而是 adapter 返回 `unsupported-inline`/相应 typed failure，并将 PM 当前状态和恢复材料留给独立恢复出口。支持这些语法时必须从真实 inline rule/observer span 取得 label、destination、escape 等不同来源区间，不能继续添加黑名单 regex；每类适配器还要通过局部重解析核对 token/marks 结构。

### 元数据的局部更新与不变量

每个 block 保存自己的 piece root、leaf sequence 和 PM path index；全局还保存一个按稳定 leaf 序号的持久 point-delta index。普通 text edit 只 path-copy 该 block，并在 leaf 序号边界追加长度 delta；未改变 block 的 `PieceBlockMetadata`、piece root、leaf metadata 和 separator 都按引用复用。当前 PM 位置通过 baseline leaf span 加 delta-index 前缀和取得，范围查找用二分，不遍历 checkpoint 以来的 transaction history。若一个 block 有较多 leaf，leaf sequence 也用持久 rope/vector 或等价 path-copy 索引；允许短 block 的局部 slice，但不能把长 block 的完整 leaves 数组复制到每次 input。受影响 leaf 的局部 ancestor spine 用 step 前后的节点类型、attrs、非文本 child count 核对；不对整棵 doc 调 `toJSON`。raw baseline span 仍固定到 checkpoint；新的 dirty piece 坐标只存在于当前 revision 的 delta/index 中。

每次成功更新必须保持以下不变量：

1. block ID、leaf ID、piece root 和 PM doc identity 属于同一个 `documentId`/revision 链；旧 transaction 或其他文档即使数字 revision 相同也拒绝。
2. 一个 block 的 raw ranges 单调、不重叠，正文与 separator 有明确 owner；相邻 span 不能因为 concat 合并而吞掉不同的 non-exact 原子边界。
3. 每个 patch 的 expected 来自其 `beforeRevision` 的 piece root；inverse patch 在 after 坐标可直接恢复，不依赖再次全文解析。相邻删除的逆插入必须按同一 after offset 的安全顺序应用。
4. transaction 的每个 doc-changing step 都被某个已证明 leaf 或明确结构适配器覆盖。空 paragraph/cell 没有 text leaf 时不能返回空 patch 成功；若没有唯一 empty slot，必须 typed fail。
5. checkpoint 局部/完整重解析后，PM leaf 文本、token kind/child 顺序、marks 和 block 边界仍一致；不一致就不提升为 validated，也不修改旧 validated state。输入阶段只允许已证明 plain leaf 的局部 text 变化；新 candidate 的完整 Markdown 语义在 checkpoint 验证，未验证的 provisional source 不得保存；未编辑 leaf 的 raw bytes 不从 PM/Turndown 重建。

### 分片实施和真实验收

适配器实现按下列顺序独立验收，期间不接 WYS：

1. 用真实 Markdown-it、生产特殊块 observer 和真实 Tiptap/ProseMirror schema，构造普通段落、bullet/ordered list、table body 的 baseline；验证单字增删替换、BOM/EOL/中文/emoji，以及列表 `3. 3`、表格 delimiter/heading padding 不被误选。
2. 在同一 block 连续执行多个 transaction，每次消费新的 piece revision；同一 transaction 修改两个 leaf/两个 block，验证一处失败时另一处也不落地。加入空 table cell 插入、删空后重建 baseline 再插入。
3. 复用 source-piece 的 event consumer，覆盖 apply、checkpoint、undo、redo 和新 branch；每个事件都以当前 transition delta 重放到 oracle，比较每个 block 的 materialized source 和 metadata identity。
4. 给结构变化、syntax-sensitive 文本、entity/escape/mark/link/code、特殊 block 编辑注入 typed failure，验证 PM doc、old piece roots、local buffers 和 recovery payload 保持不变；不把失败交给同一 serializer 生成“精确” Markdown。
5. 在 100/1000/5000 个同构 block 上重复测量 baseline/局部 transaction 的 block 数、piece 数和耗时，再单独测显式 snapshot 的物化成本。保留原始样本和构建版本，区分 parser 旧成本、mapping 新成本和 snapshot 成本；未有重复样本前不宣称线性或帧预算。

通过这些纯 helper/真实 PM 测试后，才审查接线到 WYS 的接口。接线必须保留前述局部 buffer、exposedMarkdown、PM/CM history 和恢复 codec 依赖；本节没有关闭既有格式功能，也没有将 unsupported 首片当作 WP05 完成。
