# WP04c 大文件视图接线设计

状态：Rust 后端首片和保存重基准修正已接入；TS 会话适配、草稿迁移和原生端到端验收仍未完成。  
范围：Windows 桌面版优先；本文件描述后续接线边界，不把 helper 测试结果当作产品验收。

## 1. 目标与当前边界

大文件模式需要让读取、搜索、替换和保存观察同一份带版本的可见文档。磁盘文件只作为打开时的来源和保存前的外部冲突对象。待接线的 SegmentedTextView 负责在不可变基础上表达原始区段和插入区段；FileBaseSnapshot 负责提供可校验、可限流读取的基础文件。

本阶段新增 `large_file_base.rs` 和 `large_text_view.rs`，并把接线接入 `file.rs` 的大文件会话命令；没有修改依赖或锁文件。生产快照目录位于 Tauri `appLocalDataDir()/large-file-snapshots/<session-id>`，测试使用显式临时根目录，由 session owner 隔离。模块通过 `ImmutableBase` 提供：

- FileBaseSnapshot::create 将源文件流式复制到调用方指定的私有 session 目录；
- 复制时严格验证 UTF-8，保留 BOM、LF、CRLF、CR 和未终止的末行；
- 识别 UTF-8 BOM 的 prefix span；BOM 是文件前缀元数据，不是用户可编辑的第 0 列；
- 建立 BaseLine 的字节范围，read_span 使用有界 IO 缓冲，write_span 始终分块写出；
- 用 SHA-256、文件大小和修改时间记录来源指纹；
- 复制前后检查元数据，并重新读取来源计算哈希；检测到变化时拒绝创建并只清理自己创建的目录；
- 快照对象持有只读文件句柄。默认释放对象时保留快照目录作为恢复材料，只有显式 cleanup 才删除该 session-owned 目录，不删除或写入源文件。

复制完成后的最后检查仍然存在不可避免的 TOCTOU 窗口。它能拒绝在复制期间或校验期间检测到的变化，但不能声称对外部程序的后续修改提供事务锁。保存时仍需独立完成“重新校验来源—写临时文件—校验会话版本—替换目标—故障恢复”的事务设计。

## 2. 会话模型

当前 `SessionState` 已把原来的 `line_offsets` 和裸 `TextEdit` 列表替换为：

~~~text
source_path
base_snapshot: Arc<FileBaseSnapshot>
view: SegmentedTextView<FileBaseSnapshot>
base_fingerprint
revision
pending_patch_log
outline
saved_revision
pending_edit_count
disk_fingerprint
~~~

base_snapshot 只读。所有可见内容都从 view 读取，不能在 read_file_chunk、查找、替换或保存中再次直接读取 source_path。成功编辑批次以当前 revision 为前置条件，成功后单调增加一次；保存本身不消费新的内容 revision。

首片 helper 的批次提交通过候选视图保证失败不改原视图，但复制全部可见区段元数据的成本是 O(visible metadata)。这足以先接通正确性和错误边界，不能被描述成输入热路径的局部复杂度。若发布预算需要局部更新，后续应把会话内部区段结构替换成持久区段树或 rope，并保留本 helper 作为行为 oracle。

ImmutableBase 现在提供默认为空的 prefix。FileBaseSnapshot 和 MemoryBase 都识别 UTF-8 BOM，并让首行 BaseLine 从 BOM 后开始；SegmentedTextView.write_to 先写 prefix，而 read_chunk、edit 和 search 的 UTF-16 列不包含 prefix。这样无操作和编辑后的字节流仍保留 BOM，首行编辑不能删除 BOM，也不会产生一列偏移。其他文件前缀格式仍需单独定义。

## 3. 来源指纹与外部冲突

打开时保存：

~~~text
baseFingerprint = {
  sizeBytes,
  modifiedTime,
  sha256
}
~~~

哈希是冲突判断的权威值，大小和修改时间用于快速提示与诊断。保存边界重新流式计算当前目标的指纹；文件不存在、大小不同、哈希不同或校验期间元数据变化，都返回 ExternalChanged，保留当前 session/view 和草稿，禁止静默覆盖。

源文件改变后，基础快照仍代表打开时的内容。用户可以选择重新载入、另存为或保留恢复材料；不能把新的磁盘内容直接套用旧坐标。保存替换的检查与写入之间仍须由独立事务包处理，当前快照模块不声称解决原子替换、崩溃恢复或同步盘语义。

## 4. IPC 契约

当前 Rust 命令的精确首片签名如下；前端尚未迁移，因此不能把后端接线称为完整产品闭环：

~~~text
open_large_file(path) -> Result<LargeFileSession, LargeFileError>
read_file_chunk(sessionId, startLine, lineCount, expectedRevision, coordinateSpace)
  -> Result<FileChunk, LargeFileError>
apply_file_edits(sessionId, edits, expectedRevision, coordinateSpace)
  -> Result<DirtyState, LargeFileError>
search_large_file(sessionId, query, options, startLine, limit,
                  expectedRevision, coordinateSpace)
  -> Result<LargeFindResult, LargeFileError>
replace_large_file_matches(sessionId, query, replacement, options, currentMatch,
                            expectedRevision, coordinateSpace)
  -> Result<DirtyState, LargeFileError>
save_large_file(sessionId, expectedRevision, coordinateSpace)
  -> Result<LargeSaveReceipt, LargeFileError>
save_large_file_as(sessionId, targetPath, expectedRevision, coordinateSpace,
                   expectedTargetFingerprint)
  -> Result<LargeSaveReceipt, LargeFileError>
close_large_file(sessionId, expectedRevision, disposition)
  -> Result<(), LargeFileError>
~~~

返回结构增加明确版本字段：

- LargeFileSession：revision、baseFingerprint、coordinateSpace、pendingEditCount；
- FileChunk、LargeFindResult、DirtyState：返回产生结果时的 revision；
- 编辑请求：`expectedRevision`、`coordinateSpace: utf16-code-units`、同一 revision 的原子批次。
- `LargeFileError` 至少区分 `session-not-found`、`stale-revision`、`invalid-edit`、`invalid-utf16-boundary`、`external-conflict`、`target-conflict`、`save-write-failed` 和 `save-replace-failed`，并携带会话及版本字段（适用时）。
- `LargeFileError` 还可带 `recoveryArtifact` 与 `cleanupWarning`；替换前失败会清理本次临时文件，替换失败则保留并返回恢复产物路径。
- `close_large_file` 返回 `LargeCloseReceipt`，包含 `closed`、`cleanupCompleted`、可选恢复产物和清理警告；session 已移除而清理失败时也不会返回“未关闭”的误导错误。

旧调用不能通过省略字段而获得隐式兼容。过期 revision 返回结构化 stale 错误，前端重新读取并重新定位；不能把旧请求按新视图坐标自动重放。

读取窗口、字数、查找和替换都针对当前 view。逻辑行的命中列以 UTF-16 code unit 表示，且不把行尾 EOL 当作可编辑列。替换全部匹配时，查找和提交在同一个会话锁和 revision 下完成；带旧 revision 的当前匹配直接拒绝。

## 5. 草稿与旧格式

现有 DraftRecord.pendingEdits 没有坐标空间、基础指纹和批次 revision，属于旧格式。读取这种大文件草稿时：

1. 标记 legacy-large-draft-needs-review；
2. 保留草稿；
3. 不按 UTF-16 或任何其他假定坐标静默重放。

新草稿应保存：

~~~text
schemaVersion: 2
coordinateSpace: utf16-code-units
baseFingerprint
baseSize
batches: [{ expectedRevision, edits }]
viewRevision
~~~

恢复先比较当前来源与 baseFingerprint。匹配后由后端在候选 view 上按顺序验证并一次提交；任一批失败，现有 session 不变且草稿继续保留。坐标不明的旧草稿如需迁移，必须显示预览并由用户确认，不能猜测。

草稿清理只接受带有相同 tab、session、路径和 revision 的成功保存/关闭回执。保存过程中产生的新编辑会使旧回执失效，不能因此清空新 pending。

## 6. 保存、另存和关闭

当前保存流程为：

1. 在 session 锁内捕获 saveRevision、路径、基础指纹、view 和单调 `persistenceGeneration`；
2. 通过 view.write_to 写唯一临时文件；
3. 从稳定临时文件预建新的私有 `FileBaseSnapshot` 和同 revision 的新 view；
4. 在替换边界重新确认 generation、路径、revision、来源指纹和（SaveAs 时）目标指纹；
5. 交给现有文件替换函数执行替换；
6. 替换成功后只发布已经预建好的新 base/view，并更新 `baseFingerprint`、`diskFingerprint`、`savedRevision` 和 pending 计数；发布步骤不再做可失败的磁盘操作；
7. 返回绑定 saveRevision 的成功回执。

revision 或 persistenceGeneration 在写入期间变化时，只删除属于本次保存的临时文件，保留 pending 和 view。固定临时文件名不可接受。替换函数本身仍有检查与写入之间的 TOCTOU、备份窗口和中断恢复限制，本片没有宣称 LM-006 已关闭。

SaveAs 使用单独的命令契约。目标必须带有打开对话框时捕获的 `expectedTargetFingerprint`；目标已存在而未提供指纹时默认拒绝。失败不改变原 session。成功后更新路径和当前磁盘指纹；基础快照仍代表原始打开内容，后续需要独立的重建/重载流程。

关闭必须带明确 disposition。无 pending 时可关闭；有 pending 时只能在保存成功或用户明确丢弃后显式 cleanup session-owned 快照。取消、外部冲突和写入失败保留 session、草稿及可读取的恢复材料。前端只有在后端关闭成功后才能清空 largeFile 投影。

## 7. 快照读取的内存边界

FileBaseSnapshot 的 read_span 返回 Vec，因此调用者要求的长行内容会占用与请求范围成比例的内存；有界 IO 只限制每次底层读取的缓冲，不把 read_span 误称为全程有界内存。write_span 和 view.write_to 是流式的，不需要先物化完整文档。后续若编辑器需要长行的严格内存上限，应增加分块读取接口，并单独定义其列定位契约。

## 8. 验证顺序

后续实现按以下顺序串行接线：

1. Rust 后端首片已接入 session 创建、带 revision 的 view 读写及当前 view 查找/替换；
2. 保存重基准、SaveAs 目标指纹、并发旧 save plan、外部冲突临时文件清理和关闭回执已有命令级测试；离线 Rust 单元测试当前 60 个通过；
3. 由 TS 迁移 appStore、draftStore 和旧草稿提示；
4. 重新建立保存后的基础快照/重载策略；
5. 用隔离临时文件完成保存—关闭—重开、CRLF/BOM、错误编码、保存并发和失败清理闭环。

当前快照模块的测试覆盖跨缓冲 UTF-8、非法编码、长行有界读写、混合 EOL/BOM、同尺寸外部修改、缺失来源、显式清理和失败清理。它没有接触真实笔记，也没有宣称原生保存事务或并发替换已经解决。
