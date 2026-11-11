# 2026-10-24 生产块级事务保真

`sourcePieceAdapter` 原有入口只为纯文本单 leaf 提供严格证明；包含 marks、公式、代码等块时不能用它直接覆盖整个 WYS 文档。本批将现有 persistent `sourcePieceState` 接入生产保真边界，并用真实 PM 模型事务建立块级 provenance。

## 已接入生产

`sourceTransactionProvenance` 的输入路径只记录受影响顶层块的不可变模型边。普通多 step 命令保留每个实际中间根；presentation 语法以 canonical 模型为端点。记录路径不解析 Markdown、不创建 DOM、不物化正文，不持有 view/NodeView 或 dispatcher。节点重用的 undo 不反向连边，避免环。

正式 snapshot 通过 fine-source helper 重放每个局部模型变更；每一步仍须完整块的 parser/model 证明。成功候选再作为带 expected 内容和 revision 的最小 raw patch 写入 persistent pieces，保留变更之间的链接、公式、原分隔符与空白。已有精确块 checkpoint 可以复用；历史版本仍持有自己的不可变根和必要祖先。

256 层待提交局部边会安排当前变化块的空闲 checkpoint。该工作不遍历/序列化整个文档；每轮在处理完一个块后检查时间预算。超过 4096 层则进入明确的保真恢复错误，保留当前模型和原始源码，阻止按失效来源静默覆盖。这个上限属于失败保护，不代表无需进行大块长任务的性能验收。

WYS remount 使用新 schema，PM 的 `.eq()` 因 NodeType identity 可能为 false。生产 no-op guard 在 schema 不同时递归比较 type/mark 名称、attrs 与树，命中后投影到新 schema 并保留原文档书签；之后使用同 schema 的 `.eq()`。它不创建每键 JSON 副本，不截断 redo，不把 Source 选区当 WYS 坐标。显式格式化仍由独立 handler 记录 raw 拼写变化。

## 已验证范围

- `check-source-transaction-provenance.mjs`：真实 PM 单键与多 step 模型边、跨未改公式/链接的两个远处文字修改、persistent pieces、checkpoint、旧节点 undo、256 层 compact、4097 层明确拒绝；断言输入路径物化次数为零。
- `check-wys-noop-history.mjs`：提取实际生产 onUpdate，验证同 schema clone 与新 schema remount 保 redo/书签，真实正文、公式、code.raw 变化仍记录。
- `check-source-piece-adapter.mjs` 原 text-only 证明层继续保留，没有扩大其支持声明。
- Windows 普通原生 pPsijf：七类 P0 的正式 snapshot/结构/磁盘内容、17 fine-source cases、四种局部 NodeView、精准模式/历史书签、跨标签历史与四项异步归属均通过。此运行覆盖生产接线的现有行为；不能替代下面新增特定场景。

## 2026-10-26 原生接线与复验

`native-source-provenance-cases.ts` 已接入普通原生 probe 的正式结果门禁：六项必须全部存在且通过；异步资源用例也要求包含新增 mounted rich image 的五项。host orchestration 检查覆盖 helper 拒绝、缺少用例及单项失败，不能由 helper 自报 passed 掩盖。

首个已验证隔离归属的运行 `.cache/plan-native-tests/normal-final-owned-2026-10-26/manifest.json` 中，两远处键入、多 step 命令、公式属性以及普通 Source→WYS 精确光标与焦点通过。光标用例直接输入 `新增`，未进行 IME 交互。formatter 预期空行数和链接后输入继承 mark 的夹具问题已纠正，尚待下一轮复验；该运行的 own-save 外部修改误报为真实失败，整轮保持 failed。

第二轮 `.cache/plan-native-tests/normal-final-fixed-2026-10-26/manifest.json` 确认 own-save 修复：五项异步资源全部通过；formatter 后续修改与 undo/redo checkpoint 通过，精确模式光标与焦点仍通过。新格式输入仍将既有 `__keep__` 和多空格规范化，属于真实剩余保真缺口，运行保持 failed。

该缺口由合并后的 canonical insert+mark 变更触发：纯文字路径会转义新语法，而原 mark 路径要求正文相同；尾部 link label 的可见位置映射还缺少跳出 URI/title 的边界候选。`sourceInlineChangeCandidates` 仅序列化变化的 inline fragment，并从原语法树补充 wrapper 内外边界；仍须原有完整块 parser/model 证明才能接受。单元回归先在错误的 link 内插入位置复现，再在补充边界后通过。真实 production parser 用例已加入普通原生 probe，等待最终复验。

## 后续验收边界

上述原生 helper 还检查显式格式化后的再次修改、undo/redo checkpoint，以及新格式保留既有富文本源码。最终通过证据须以修复后的新运行记录为准。

2026-10-25 停止前的最后原子批次已将 `sourceAtomicPatches` 数学体候选接入 fine-source 的完整块重解析证明，并将 `sourceBlockInsertionCandidates` 接入 WYS 图片命令：先用自定义 state 的真实 Tiptap CommandManager 建立尚未 dispatch 的事务，只有候选全文解析模型与 staged 模型一致才局部提交并 prime 精确 raw。显式格式化也使用同一精确 checkpoint 入口，避免后续 snapshot 恢复旧拼写。类型检查、候选检查（含实际 Tiptap staging API）、watch race 与保存事务检查通过；这些新增路径尚未重新运行原生验收，不能沿用 pPsijf 的旧批通过记录。

未知结构或无法证明的局部变化仍需明确区分安全局部重建与保真失败；最终整轮完成必须以主验收矩阵为准。
