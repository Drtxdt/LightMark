# LM-006 Windows 文件替换事务设计

状态：修正版设计，当前只修改本文，未修改 Rust、TypeScript、测试、依赖或配置。本文供主负责人审查，不能作为 LM-006 已修复或已通过 Windows 验收的证据。

本轮修正版的硬约束：`ReplaceFileW` 不是带期望版本的 CAS。最终 fingerprint 检查和 API 调用之间仍可发生外部写入；API 返回成功后也可能有外部写入。因此，`target == N` 不能单独证明保存成功。已有目标的成功条件必须同时核对替换后 backup 是否仍等于期望旧版本 `B`；例如最终得到 `target == N`、`backup == E` 时，说明外部版本 `E` 被本次替换覆盖但已被 API 留在 backup，必须报告并发冲突，保留 `E` 和独立的 `N` 恢复材料，不能按普通成功清理。若外部程序在 API 返回后再把 target 改为 `E2`，replacement 已经离开原路径，仍必须依靠独立 output artifact 恢复 `N`；同 inode 硬链接不满足这个条件。

事务 helper 对普通保存和大文件保存都返回四态结果 `Committed`、`Conflict`、`NotCommitted`、`Ambiguous`，并同时报告当前 target 状态、磁盘是否已经写入本次输出、session dirty 是否清除以及可恢复路径。只有确认 target 当前等于输出且旧 backup 等于期望 `B`（或创建分支确认 target 为输出）时才是普通 `Committed`。已确认提交后的清理失败仍是成功回执中的 warning；任何冲突或状态不明都必须保留材料，不能映射成普通成功或静默 cleanup。

范围：Windows 桌面版的普通 Markdown 保存和大文件保存/另存。本文只讨论“已经生成完整新内容之后，如何把它交给目标路径”，不重新设计文档 revision、源码保真或大文件视图。

## 1. 当前实现与风险证据

普通保存入口 `src-tauri/src/commands/file.rs` 的 `write_text_file_safely`（约 1113 行）使用固定的 `<目标扩展名>.lightmark-tmp`，直接 `fs::write`，然后用 `path.exists()` 决定 `replace_file` 或 `fs::rename`。固定临时名会让两个保存相互覆盖，也无法证明清理动作只作用于本次保存创建的文件。

当前 `replace_file`（约 2073 行）执行以下步骤：

1. 计算固定的 `<目标扩展名>.lightmark-bak`；
2. 无条件删除已有 backup；
3. 把目标先重命名为 backup；
4. 把 replacement 重命名为目标；失败时尽力把 backup 重命名回去；
5. 删除 backup，并把删除失败作为整个调用的 `Err` 返回。

因此存在四个可以直接从代码推出的边界：

- 目标被移走到 replacement 成功之间存在目标路径暂时不存在的窗口；进程中断可能留下目标、backup、replacement 三者之一或多个。
- backup 不是本次调用独占的。删除旧 backup 可能删除另一会话的恢复材料。
- replacement 已经成为目标后，backup 清理失败仍返回失败。调用方可能再次保存，造成“磁盘已写入但 UI 认为失败”的重复写入或覆盖。
- `path.exists()`、`fs::rename` 和替换之间不是比较并交换。外部程序可以在检查后改变目标；当前 fingerprint 检查也不能覆盖最后一次检查到替换之间的窗口。

大文件保存（约 378 行起）已经使用唯一临时名、输出哈希、session revision 和 `persistence_generation`，并在替换前重新检查来源 fingerprint；另存（约 514 行起）也检查 `expected_target_fingerprint`。这些检查能拒绝检查发生前已经观察到的外部变化，但当前最终动作仍调用同一个 `replace_file`/`replace_or_create_file`。它们不是 Windows 文件系统级 CAS，因此不能据此宣称 LM-006 已关闭。

`FileBaseSnapshot` 的 SHA-256、大小和修改时间适合做内容冲突证据；大小和时间不能单独作为冲突判据，尤其不能漏掉同尺寸修改。成功后的新 base/revision 发布已经由 WP04c 处理，本文不改变那条链路。

## 2. 依赖和 Windows API 核查

只读核查结果：`src-tauri/Cargo.toml` 已有 `sha2 = 0.10` 和 `windows = 0.61`，离线 `cargo tree` 解析到 `windows v0.61.3`。当前直接声明的 Windows features 只有 `Win32_Foundation` 和 `Win32_Graphics_Dwm`；`ReplaceFileW`、`MoveFileExW`、`CreateFileW`、`FlushFileBuffers` 所在的 `Win32_Storage_FileSystem` feature 尚未启用。实现阶段若选择这些绑定，只需扩展现有 `windows` feature 集，不需要引入新 crate；本设计阶段不改 `Cargo.toml` 或锁文件。

官方文档给出的约束必须作为实现验收条件：

- [`ReplaceFileW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) 可以同时替换目标并创建 backup，但 `REPLACEFILE_WRITE_THROUGH` 明确标为不支持；文档还列出 1175、1176、1177 三类失败状态，其中 replacement、backup 和目标可能保留不同名称，错误返回不能简单等同于“原文件仍在、替换完全没有发生”。文档要求 backup、被替换文件和 replacement 位于同一 volume，并说明不使用忽略 ACL/属性合并错误的 flag 才能保留这些安全属性。
- [`MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) 只在提供 `MOVEFILE_REPLACE_EXISTING` 时替换已有目标；Save As 目标原本不存在时不得使用该标志，必须在同卷上调用不覆盖分支并用真实 Windows 竞态测试确认目标出现时调用失败。不能使用 `MOVEFILE_COPY_ALLOWED` 把事务退化为跨卷复制/删除。`MOVEFILE_WRITE_THROUGH` 只描述移动作为复制/删除执行时的刷新行为，不能作为整个替换事务的断电证明。
- [`FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) 能把文件缓冲写向设备；它不提供目录项更新与“替换动作整体提交”的跨平台事务语义。Rust 的 `File::sync_all` 可作为实现抽象，但测试和产品文档仍不能把它描述为断电不丢失保证。

不使用 TxF/`MoveFileTransacted` 作为新方案。它不是当前产品已有能力，且会增加部署和系统版本边界；本包的目标是先让普通保存和大文件保存共享一条可解释的恢复路径。

## 3. 最小可验收目标

实现必须先满足以下目标，再讨论性能或更强的持久性：

1. 每次保存拥有自己的临时文件、事务目录和 backup 名称；创建失败时绝不删除预置的同名文件。
2. 目标存在时，默认拒绝未经授权的覆盖。普通保存以打开时的目标 fingerprint 为期望值；Save As 只有用户明确确认后才携带已有目标 fingerprint，目标原本不存在时使用 `None` 表示“只能创建，不得覆盖”。
3. 同尺寸、时间粒度不足以区分的外部修改也必须由内容哈希发现；发现后保留编辑缓冲和本次生成的完整新内容。
4. 最终 fingerprint 检查之后立即进入替换调用，不做可失败的分配、清理或状态发布；应用内同一路径保存串行化。
5. `ReplaceFileW` 返回后同时检查 target、backup、replacement/output artifact 的实际存在性和内容 fingerprint。只有 `target == N` 且 `backup == B`（已有目标）或无 backup 的创建分支确认 `target == N` 时才给普通 `Committed`；`target == N`、`backup == E != B` 必须是 `Conflict`。
6. 在调用会消耗 replacement 的 API 前，先准备一个不同 inode 的独立 output artifact。普通保存必须创建并拥有该副本；大文件可以复用已经校验且不可变的 private `FileBaseSnapshot` 作为借用的 output artifact，但 helper 不得把它当作自己可以任意删除的路径。
7. 已能证明目标已经写入新内容且没有并发冲突时，后续 backup、事务目录或 manifest 清理失败只产生成功回执中的 warning 和 recovery artifact，不能返回“保存失败”。若 target 已被外部再次改写，必须报告 `Conflict` 并保留 output artifact，即使 API 之前返回成功。
8. Save As 目标在最终检查后新出现时，创建分支必须调用操作系统的不覆盖创建/移动语义而失败，不能使用 `exists` 加普通 `rename` 的竞态分支；原 session、用户新内容和新出现的目标都保留。
9. 替换失败或进程中断后，恢复程序能区分 `NotCommitted`、`Committed`、`Conflict` 和 `Ambiguous`。状态不明时保留双方版本，不自动删除或静默选择一方；每个结果明确磁盘是否已写、session dirty 是否仍在以及 artifact 路径。
10. 目标已有的字节、ACL/属性在未提交失败路径中保持不变；已有目标成功替换时不使用忽略 ACL/属性合并错误的 flag。成功字节必须与已校验的 output fingerprint 相等。

## 4. 推荐的局部事务模型

### 4.1 事务对象和所有权

普通保存和大文件保存都应调用同一个内部 `FileReplaceTransaction`（名称仅为设计名，不要求照抄），而不是各自拼接 `fs::write`、`rename` 和 cleanup。最小字段如下：

```text
transactionId       随机/单调组合值，不能只用固定扩展名
targetPath          规范化后的目标路径
expectedTarget      Option<Fingerprint>；None 表示只允许创建
outputFingerprint   临时文件完成后计算的 SHA-256/size/mtime 诊断值
transactionDir      目标所在卷上的本次独占目录
replacementPath    transactionDir 内的完整新内容
outputPath          与 replacement 不同 inode 的独立 N 恢复材料；或已校验的借用 private base
backupPath          transactionDir 内的旧内容备份路径
manifestPath        transactionDir 内的事务记录
indexRecord         app-local private recovery index 中的发现提示，不是路径授权
stage               Prepared/Committing/Committed/Conflict/CleanupPending
```

事务目录必须创建在目标所在卷上，优先使用目标父目录下的受控事务根和随机目录，例如 `.lightmark-txn/<id>`。这样 replacement、backup 和目标满足同卷约束，也不会因为 appLocalData 与笔记目录跨卷而退回到复制加删除。目录创建使用独占语义；遇到同名路径重试新 id，绝不删除不属于本事务的目录。

replacement 使用 `create_new` 打开并记录“本次创建成功”后才拥有清理权。普通保存还要用 `create_new` 在事务目录中生成 output 副本，流式复制、`sync_all`、重新 fingerprint，确认与 `N` 相等后才能进入最终检查；不得用硬链接、同 inode 复制或只保存目标路径充当 output。大文件的 `FileBaseSnapshot` 已经是独立、只读、哈希校验的副本，可以作为借用 output，但必须记录其 private owner 目录，helper 只能读取/保留，不能按事务 cleanup 规则删除它。

backup 在调用 Windows 替换 API 前不预创建、不删除旧同名文件；它位于独占事务目录，只有 API 返回后通过路径和 fingerprint 证明是本事务产生的材料时才可由本事务清理。任何清理前都要确认路径仍属于当前事务；无法证明时留下 artifact 并报告 warning。若 backup 路径在调用前已存在，事务应停止并保留该文件；不能先删掉它“腾位置”。

事务目录和 manifest 中的 artifact 名称由 helper 固定生成（例如 `replacement`、`output`、`backup`、`manifest`），恢复代码从已验证的 transaction id 派生这些路径，不执行 manifest 提供的绝对路径或含 `..` 的路径。manifest 是状态证据，不是向事务根之外写入、恢复或删除的授权。

### 4.2 准备阶段

1. 在 session/path 锁内捕获会话 revision、路径、期望目标 fingerprint 和保存 generation。
2. 创建事务目录和 manifest，并在 app-local private recovery index 注册该事务。manifest 至少记录目标绝对路径、期望旧 fingerprint、输出 fingerprint、固定 artifact 名称和当前 stage。manifest/index 写入使用独占临时名、`sync_all`，再以各自文件系统允许的方式发布；任一记录无法建立时不得进入替换阶段。
3. 把 view 流式写入 replacement，调用 `sync_all`，重新计算 replacement fingerprint。普通保存随后创建独立 output 副本，调用 `sync_all` 并重新 fingerprint；任何写入、flush、哈希失败都只清理本事务已创建且可证明归属的文件，清理失败则返回 recovery artifact。
4. 预建大文件的新 base/view 仍按 WP04c 执行；现有 private base 可作为只读、独立 inode 的 output recovery artifact，但必须在 final check 前确认其 fingerprint 等于 `N`，且事务 helper 不取得删除该 private base 的权限。这一步不能改变磁盘目标，也不能清除当前 pending。
5. 在所有路径、句柄、artifact 和错误回执都准备好后写入 `Prepared` manifest，最后读取目标 fingerprint。目标不存在时必须得到 `None`；目标存在时必须等于 `expectedTarget`。不匹配返回 `Conflict`，磁盘写入标记为 `false`，保留 replacement、output 和 manifest。
6. `Prepared` 之后到 Windows 替换调用之间只允许最后一次已准备好的 fingerprint 检查和一个不再分配/清理/发布状态的 OS 调用；应用内 path lock 必须覆盖这一段。该 lock 只串行化本应用，不能被描述为跨进程 CAS。

### 4.3 提交已有目标

Windows 路径优先调用 `ReplaceFileW(target, replacement, backup, flags=0, ...)`，不设置 `REPLACEFILE_WRITE_THROUGH`，不忽略 ACL/属性合并错误。replacement 和 backup 都在目标卷上的独占事务目录中。调用前只做必要的句柄/路径准备；不在 final check 和 API 调用之间做日志写盘、清理或重新构造 view。

调用返回后必须检查实际路径和哈希：

- 目标存在且内容等于 `N = outputFingerprint`、backup 存在且内容等于期望旧版本 `B`，并且独立 output artifact 仍存在且等于 `N`，才是普通 `Committed`。`target == N` 本身永远不够。
- 若观察到 `target == N` 且 `backup == E`，其中 `E != B`，则是 `Conflict`：本次新内容确实写到了 target，但 final check 之后的外部版本 `E` 被覆盖并由 backup 保留。必须保留 `E`、独立 output `N` 和 manifest，磁盘写入标记为 `true`，session dirty 不清除，不得执行普通成功 cleanup。
- 若 API 已返回成功而 target 随后变成 `E2 != N`，replacement 原路径已经消失；只要独立 output `N` 仍可校验，就报告 `Conflict`，保留当前 target `E2`、output `N` 以及可用的 backup。回执应说明 API 曾提交过本次输出但 target 当前不是它，不能只返回普通成功。
- 若 target 仍等于期望 `B` 且 replacement 仍存在并等于 `N`，可确定为 `NotCommitted`；磁盘写入标记为 `false`，保留 replacement、output 和 manifest 供重试或人工处理。
- 目标、replacement、backup、output 的组合无法证明上述任一事实时，视为 `Ambiguous`，磁盘写入标记为 `unknown`，session dirty 不清除，保留全部可恢复材料。即使 API 返回错误，也不得仅按错误码猜测并删除路径。

1175/1176/1177 等 Windows 错误必须结合实际路径和哈希解释，不能统一调用“恢复 backup”而覆盖可能已经出现的新版本。目标不存在、replacement 仍是完整 `N`、backup 完整且等于 `B` 时只能分类为 `NotCommitted` 并展示可恢复材料；恢复器不得自动写回旧目标。只有用户明确选择恢复、再次验证目标仍不存在（或明确授权的期望 fingerprint）并使用不覆盖语义时，才允许单独执行恢复动作，且该动作不改变原始替换结果的分类。

### 4.4 提交不存在的目标

Save As 的期望 fingerprint 为 `None` 时使用操作系统的不覆盖同卷移动路径，例如 `MoveFileExW` 不带 `MOVEFILE_REPLACE_EXISTING`（只在目标和 replacement 同卷时使用；`MOVEFILE_COPY_ALLOWED` 会退化为复制/删除，不能作为本事务的替换证明），或经过 Windows 实测证明等价的原生调用。不能调用 `replace_or_create_file` 这种先 `exists` 再普通 `rename` 的无锁实现，也不能把“目标仍不存在”当成文件系统级 CAS。目标存在时由 OS 调用失败，不能覆盖它。

若目标在 final check 后出现，移动操作必须失败并返回 `target-conflict`；不得覆盖这个新目标。失败后 replacement、独立 output、manifest 和原 session 均保留，磁盘写入标记为 `false`。`MoveFileExW` 的成功返回也要重新校验 target 为 `N`，否则按 `Conflict`/`Ambiguous` 处理。若实现所选 API 在该竞态下有任何覆盖可能，方案不合格，应改用能证明“不覆盖”的原生调用或在提交前建立 Windows 级别的独占保护；不能用 `exists` 检查加 rename 补救。

### 4.5 发布与 cleanup

只有 helper 已返回普通 `Committed`，目标内容等于 `N` 且旧版本证据等于 `B` 后，才把 manifest 标为 `Committed` 并尽可能同步，再发布 WP04c 的新 base/view/saved revision。发布步骤不得再包含会导致磁盘状态回滚的可失败操作。`Conflict` 即使 target 曾短暂等于 `N` 也不能发布为普通已保存状态；保留当前 session dirty，等待用户选择 `E`/`E2` 或独立 `N`。

之后才清理 replacement、backup、manifest 和事务目录：

- 清理成功：返回普通成功回执；
- 目标已确认提交但某项清理失败：仍返回成功，附 `cleanupWarning` 和真实事务目录路径；下次启动继续发现和清理；
- 目标提交状态无法确认：返回结构化 `Ambiguous`，所有可恢复材料保留；不能把 cleanup 错误伪装成普通写入失败。
- `Conflict`、`NotCommitted` 和 `Ambiguous` 都必须在结果中带 `diskWritten`（`true`、`false` 或 `unknown`）、`dirty`（保持为 `true`）和 recovery artifact 路径。`Conflict` 的 `diskWritten` 可以是 `true`（已观察到 `N` 到达 target）但仍不是普通成功。

普通 `write_text_file` 当前返回 `Result<(), String>`，实现时需在内部保留四态结果；调用方必须提供或捕获打开时的期望 target fingerprint，不能再有无条件覆盖路径。若暂时不能扩展 IPC 回执，至少必须把 `Conflict`/`NotCommitted`/`Ambiguous` 的状态、磁盘写入结论、dirty 保留和 recovery artifact 编入错误信息；已确认提交的 cleanup failure 必须保持 `Ok` 并附 warning/artifact，不能映射成可重复保存的普通 `Err`。更完整的做法是返回包含 `outcome`、`diskWritten`、`dirty`、`cleanupWarning` 和 `recoveryArtifact` 的结构化 receipt。大文件命令已有 `LargeSaveReceipt`，可直接承载这些字段。

### 4.6 恢复索引和路径权限

事务目录在目标父目录下的受控 `.lightmark-txn` 根内，app-local data 只保存一个 private recovery index 作为发现提示。index 记录 transaction id、目标父目录的规范路径和目标规范路径；创建事务时先以 `create_new` 建目录，再写入并同步 index/manifest，清理完成后才移除 index 记录。index 丢失或断电未落盘时不能证明事务不存在；目标下一次被打开时可以只扫描该目标父目录下的受控事务根，不能全盘按文件名猜测。

恢复器不把任意 JSON manifest 当作权限凭证。对每条 index 记录，先验证 transaction id 只含安全字符，再由已存在的规范目标父目录重新派生唯一候选路径 `.lightmark-txn/<id>`；候选路径必须仍位于该父目录内，且事务目录、artifact 和 manifest 不能是符号链接、junction 或其他 reparse point。manifest 中的目标路径必须与 index/候选路径记录的规范目标一致，artifact 名称必须是 helper 的固定白名单；绝对路径、`..`、路径分隔符、未注册目标或越界路径一律标为不可信并原地保留。

恢复器只可删除本事务目录下已由 helper 固定派生且已证明归属的 `replacement`、`output`、`backup`、`manifest`，以及最后的空事务目录。它不能依据 manifest 中的路径去删除或写入事务根外的任何文件，也不能在重启时自动覆盖 target。target 的恢复/写入必须重新经过当前 helper 的 fingerprint 和不覆盖规则，并要求明确的用户动作；private large-file base 是借用的只读 artifact，事务 cleanup 不拥有删除权。无法证明归属、路径安全或状态的条目只产生 `Ambiguous` 记录并保留全部材料。

## 5. 崩溃和重启恢复状态机

private index、事务目录和 manifest 是恢复的发现依据；扫描只接受 index 指向的受控事务根和格式正确且路径一致的 manifest，不按全盘文件名猜测或删除。manifest 本身不能授权越界写入或删除。

| 可能中断阶段 | 可观察状态 | 重启处理 |
|---|---|---|
| 创建目录/manifest 前 | 目标旧内容；可能有不完整空目录 | 只清理明确由本次启动创建且未含用户文件的目录；否则保留并记录 |
| replacement/output 写入或 flush 中 | 目标旧内容；replacement 或 output 可能不完整 | 校验哈希不符就标为未提交，保留或由用户丢弃；不碰目标 |
| `Prepared`、final check 前后 | 目标旧内容；replacement 和独立 output 完整 | 重新校验目标；旧 fingerprint 不符则报告 `Conflict`，保留 `N`、manifest 和外部版本 |
| 目标移动到 backup 后、replacement 尚未成为目标 | 目标可能缺失；backup=旧；replacement=新 | 仅检测并报告 `NotCommitted`；恢复器不得自动写回旧目标。只有用户明确选择恢复且再次通过不覆盖/期望 fingerprint 检查时，才允许单独执行恢复动作 |
| Windows 替换调用返回但 manifest 尚未更新 | 目标/backup/replacement/output 组合不定 | `target == N` 还必须核对 `backup == B` 和独立 output；`backup == E != B` 是 `Conflict`，target 不是 N 或证据不足则 `NotCommitted`/`Ambiguous`，不能只看 target |
| 目标已是新内容、backup 为期望旧版本 | `target == N`、`backup == B`、output=`N` | 才能更新为普通 `Committed`；先保留旧 backup 直到 manifest 已同步 |
| 目标已是新内容、backup 是外部版本 | `target == N`、`backup == E != B`、output=`N` | 更新为 `Conflict`；保留 `E` 和独立 `N`，session dirty 不清除，不能 cleanup 为普通成功 |
| API 成功后 target 又被外部改写 | target=`E2 != N`；replacement 已消失；output=`N` | 报告 `Conflict`，保留当前 `E2`、独立 `N` 和可用 backup；不能依靠 replacement 路径恢复 |
| backup/manifest 清理中 | 新目标；部分 artifact 已删 | 只有普通 `Committed` 才能保持成功；确认过并发冲突或证据不足时继续保留 artifact，不能回滚或静默清理 |

断电后不能保证 manifest 本身已落盘，因此恢复器必须把存在的 artifact、目标哈希和 manifest 一起作为证据；不存在足够证据时进入状态不明，而不是猜测。恢复器不得静默覆盖目标，也不得为了“清理干净”删除唯一的旧/新版本。

## 6. 并发、权限和断电语义

### 可以保证的范围

- 本应用内同一路径的保存可以通过锁/generation 串行化；旧 plan 在提交边界被拒绝，不能清掉后来的 pending。
- final check 之前已完成的外部同尺寸修改会被 SHA-256 fingerprint 拒绝。
- Save As 目标原本不存在时，经过不覆盖移动调用，最终出现的新目标不会被覆盖；失败会保留用户 replacement。
- 只有同时验证 target=`N`、旧 backup=`B`（已有目标）和独立 output=`N` 的普通提交，cleanup 失败才不会被报告为保存失败；这时回执带 warning/artifact，session dirty 已明确清除。若 backup 是 `E` 或 target 已变为 `E2`，即使曾写入 `N` 也只报告 `Conflict`，保留双方版本且 dirty 不清除。
- 只有在实际路径/fingerprint 证据证明替换未提交时，才能声称权限失败保留原始目标字节；任何 ReplaceFileW 错误都必须先做路径分类，不能统一作此保证。ACL/属性合并错误不被忽略。

### 不能无条件保证的范围

- fingerprint 比较与替换 API 之间仍存在外部进程写入窗口。`ReplaceFileW` 本身不是带 expected hash 的 CAS；最后检查只能缩小窗口，不能消除它。API 返回成功后也存在外部改写窗口，因此必须保留独立 output 并核对 backup，不能只看 target。
- 如果外部程序在替换成功后立即再次写入，应用无法仅凭一次回执证明稍后读取到的仍是自己的版本。提交后校验发现不一致时必须报告 post-commit conflict 并保留独立 output artifact，不得静默覆盖外部版本或依赖已经消失的 replacement 路径。
- `ReplaceFileW` 的官方错误状态允许 replacement、backup、目标处于不同命名状态；不能把 API 名字解释成任意阶段崩溃都自动回滚。
- 文件 flush、rename 或 `MOVEFILE_WRITE_THROUGH` 不能单独证明目录项和整笔事务在断电后持久化。Windows 本地 NTFS、同步盘、SMB、云盘和杀毒/索引器的行为要分别实测；发布文档只能声称“有恢复材料和明确状态”，不能声称断电零丢失。
- 目标路径的 reparse point、跨卷 Save As、远程共享和第三方同步冲突不在本设计的自动保证内；未覆盖前应拒绝或明确降级为另存副本。

## 7. 决定性红灯测试与测试钩子

以下测试应先在当前实现或临时测试替身上得到红灯，修复后再逐项转绿。本节只定义测试，不在本次设计提交中添加测试代码。

### 7.1 所有权和普通保存

1. **固定 temp 碰撞**：预置 `<target>.lightmark-tmp` sentinel，调用普通保存；当前 `fs::write` 会覆盖 sentinel，应红。通过标准是 sentinel 原字节不变，保存要么使用新独占事务目录，要么在创建冲突时失败并保留 sentinel。
2. **backup 碰撞**：预置旧命名 `.lightmark-bak`，保存失败或成功；当前实现会先删除它，应红。通过标准是不删除任何非本事务 artifact。
3. **写入中断**：在 replacement 写入后、flush 前注入失败；检查目标旧哈希不变，partial replacement 只在本事务目录，清理失败时返回真实 artifact。
4. **权限/属性**：对目标设置只读属性或 ACL，注入 replacement；检查命令返回结构化权限错误、旧字节和 ACL/属性不变，不能把 backup 误当成功。
5. **独立 output**：替换成功后再把 target 改写为外部 `E2`；replacement 原路径已经消失时，独立 output 仍必须读出完整 `N`。用硬链接替身应红，因为 target 与 output 会共享 inode；真实副本应转绿。
6. **提交后 cleanup 失败**：在 `target == N`、`backup == B` 已确认后拒绝删除 backup/事务目录；命令必须返回 `Committed` 成功加 warning/recovery artifact，dirty 明确为 false，而不是 `Err`。
7. **backup 外部版本**：在 final check 后写入 `E`，让替换结果形成 `target == N`、`backup == E != B`；必须返回 `Conflict`，磁盘写入为 true、dirty 保持、`E` 与独立 `N` 均保留，不得普通成功 cleanup。

### 7.2 外部变化和 Save As

8. **同尺寸外部修改**：在初始 fingerprint 之后把目标改成相同长度，并尽量恢复相同修改时间；保存必须返回 `Conflict`，旧 session/pending 保留，外部字节不被覆盖。
9. **final check→replace 窗口**：提供确定性 barrier，在 final fingerprint 返回后、替换调用前由另一进程写入同尺寸不同内容。当前方案应红；合格实现必须返回 `Conflict`/`Ambiguous` 并保留外部版本与独立 `N`，不能静默声称普通保存成功。
10. **Save As 缺失目标出现**：捕获 expected target `None` 后，在 final check 后创建同名文件；不覆盖 OS 移动必须失败为 `Conflict`，不能覆盖新文件，replacement、独立 output 和原 session 均保留。
11. **Save As 已有目标**：无 expected fingerprint 时必须拒绝；有 fingerprint 时同尺寸外部变化必须拒绝；失败不改变原路径、base 或 dirty 状态。
12. **恢复路径越界**：构造 JSON 语法正确但 artifact 使用绝对路径或 `..` 的 manifest/index；恢复器必须拒绝并保留条目，不能按该路径写入或删除事务根外文件。

### 7.3 崩溃注入

测试 helper 使用环境变量或仅测试构建的 hook，在下列 stage 让子进程异常退出；父进程重启恢复扫描器并记录每个路径哈希。不能用产品中的无条件 `process::exit` 掩盖句柄泄漏。

```text
after_transaction_dir_create
after_manifest_prepared
after_replacement_flush
after_final_fingerprint
after_target_to_backup          仅用于手写 fallback/故障替身
after_replace_api_return
after_committed_manifest
before_backup_cleanup
after_backup_cleanup
```

每个 stage 都检查：目标是否存在、目标 hash、replacement 是否存在且 hash 是否完整、独立 output 是否存在且仍为 `N`、backup 是否存在且为 `B` 或外部 `E`、manifest stage、index 发现结果、恢复器分类，以及是否误删了测试目录外文件。必须覆盖 `target == N/backup == E` 和 API 成功后 `target == E2/output == N` 两种竞态。对于 `ReplaceFileW` 的 1175/1176/1177，要构造或模拟对应路径组合，不能只断言错误字符串。

### 7.4 共享实现的验收

普通 `write_text_file_safely` 和 large `save_large_file`/`save_large_file_as` 必须使用同一事务 helper，并用同一组 fixture 验收：LF/CRLF/BOM/非 ASCII 字节精确比较、权限失败、同尺寸冲突、`target == N/backup == E`、API 后 target 改写、Save As 新目标出现、cleanup warning 和恢复 artifact。四态结果都要断言 `diskWritten`、dirty 和路径；大文件 view 的 revision/新 base 断言沿用 WP04c，本包只新增最终磁盘状态断言。

## 8. 实施顺序和停止条件

1. 先抽取内部事务结果类型和测试 hook，不改变 UI；让普通保存和 large 保存都能返回 `Committed`、`Conflict`、`NotCommitted`、`Ambiguous` 四态，并带 `diskWritten`、dirty 和 recovery artifact。
2. 在 Windows 上加入现有 `windows` crate 的 `Win32_Storage_FileSystem` feature，封装 `ReplaceFileW`、不覆盖移动和必要的 flush；不引入新依赖。
3. 实现独占事务目录、manifest、阶段恢复和 artifact 所有权；删除固定 temp/backup 名称及无条件清理。
4. 先让决定性红灯测试转绿，再接入普通命令和 large 命令的 receipt/错误映射。
5. 完成真实 Windows 文件、ACL、异常退出和 Save As 竞态测试后，才更新 LM-006 状态。

若无法证明 final check 后的 Save As 创建分支不会覆盖新出现的目标，停止并保留 `target-conflict`，不得退回 `REPLACE_EXISTING`。若替换 API 返回后无法分类目标/backup/replacement 的状态，停止自动恢复，保留双方版本并报告 ambiguous。若 cleanup 失败但目标已校验为新内容，必须保持成功回执语义，不能为了让测试“全绿”把它改成失败。

若无法在 API 调用前证明 output 是独立 inode、完整且可恢复的 `N`，停止提交；不能把 replacement 的旧路径、target 当前路径或硬链接当作 output。若 private index/manifest 的路径边界无法验证，停止自动 cleanup/restore，只报告 `Ambiguous` 并保留条目。实现只可声明 Windows 上经过实测的文件状态和恢复材料语义，不可声明断电原子、跨卷事务或全跨平台保证。

当前结论：现有代码已经有较好的大文件 fingerprint、revision、唯一 replacement 和 pending 保留基础；普通保存仍使用固定临时/backup 和手写目标移走流程。LM-006 仍是发布前未定界的问题，不能把 `ReplaceFileW` 或任意 `rename` 的函数名当作 CAS、事务或断电原子性的证明。
