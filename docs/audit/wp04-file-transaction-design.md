# LM-006 Windows 文件替换事务设计

状态：仅设计，未修改 Rust、TypeScript、测试、依赖或配置。本文供主负责人审查，不能作为 LM-006 已修复或已通过 Windows 验收的证据。

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

- [`ReplaceFileW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) 可以同时替换目标并创建 backup，但 `REPLACEFILE_WRITE_THROUGH` 明确标为不支持；文档还列出 1175、1176、1177 三类失败状态，其中 replacement、backup 和目标可能保留不同名称，错误返回不能简单等同于“原文件仍在、替换完全没有发生”。
- [`MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) 的 `MOVEFILE_REPLACE_EXISTING` 会替换已有目标，Save As 目标原本不存在时不得使用该标志。`MOVEFILE_WRITE_THROUGH` 只描述移动作为复制/删除执行时的刷新行为，不能作为整个替换事务的断电证明。
- [`FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) 能把文件缓冲写向设备；它不提供目录项更新与“替换动作整体提交”的跨平台事务语义。Rust 的 `File::sync_all` 可作为实现抽象，但测试和产品文档仍不能把它描述为断电不丢失保证。

不使用 TxF/`MoveFileTransacted` 作为新方案。它不是当前产品已有能力，且会增加部署和系统版本边界；本包的目标是先让普通保存和大文件保存共享一条可解释的恢复路径。

## 3. 最小可验收目标

实现必须先满足以下目标，再讨论性能或更强的持久性：

1. 每次保存拥有自己的临时文件、事务目录和 backup 名称；创建失败时绝不删除预置的同名文件。
2. 目标存在时，默认拒绝未经授权的覆盖。普通保存以打开时的目标 fingerprint 为期望值；Save As 只有用户明确确认后才携带已有目标 fingerprint，目标原本不存在时使用 `None` 表示“只能创建，不得覆盖”。
3. 同尺寸、时间粒度不足以区分的外部修改也必须由内容哈希发现；发现后保留编辑缓冲和本次生成的完整新内容。
4. 最终 fingerprint 检查之后立即进入替换调用，不做可失败的分配、清理或状态发布；应用内同一路径保存串行化。
5. 已能证明目标已经写入新内容时，后续 backup、事务目录或 manifest 清理失败只产生成功回执中的 warning 和 recovery artifact，不能返回“保存失败”。
6. Save As 目标在最终检查后新出现时，创建分支必须失败而不能覆盖；原 session 仍指向原文，用户的新内容和新出现的目标都保留。
7. 替换失败或进程中断后，恢复程序能区分“未提交”“已提交但待清理”和“状态不明”。状态不明时保留双方版本，不自动删除或静默选择一方。
8. 目标已有的字节、ACL/属性在未提交失败路径中保持不变；已有目标成功替换时不使用忽略 ACL/属性合并错误的 flag。成功字节必须与已校验的 replacement fingerprint 相等。

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
backupPath          transactionDir 内的旧内容备份路径
manifestPath        transactionDir 内的事务记录
stage               Prepared/Committing/Committed/CleanupPending
```

事务目录必须创建在目标所在卷上，优先使用目标父目录下的随机目录，例如 `.lightmark-txn-<id>`。这样 replacement、backup 和目标满足同卷约束，也不会因为 appLocalData 与笔记目录跨卷而退回到复制加删除。目录创建使用独占语义；遇到同名路径重试新 id，绝不删除不属于本事务的目录。

replacement 使用 `create_new` 打开并记录“本次创建成功”后才拥有清理权。backup 在调用 Windows 替换 API 前不预创建、不删除旧同名文件；它位于独占事务目录，调用成功后才成为本事务拥有的恢复材料。任何清理前都要确认路径仍属于当前事务；无法证明时留下 artifact 并报告 warning。

### 4.2 准备阶段

1. 在 session/path 锁内捕获会话 revision、路径、期望目标 fingerprint 和保存 generation。
2. 创建事务目录和 manifest。manifest 至少记录目标绝对路径、期望旧 fingerprint、输出 fingerprint、replacement/backup 相对路径和当前 stage。manifest 写入使用独占临时名、`sync_all`，再以同卷重命名；manifest 无法建立时不得进入替换阶段。
3. 把 view 流式写入 replacement，调用 `sync_all`，重新计算 replacement fingerprint；任何写入、flush、哈希失败都只清理本事务已创建的文件，清理失败则返回 recovery artifact。
4. 预建大文件的新 base/view仍按 WP04c 执行；这一步不能改变磁盘目标，也不能清除当前 pending。
5. 写入 `Prepared` manifest 后，最后读取目标 fingerprint。目标不存在时必须得到 `None`；目标存在时必须等于 `expectedTarget`。不匹配返回结构化冲突，保留 replacement 和 manifest。

### 4.3 提交已有目标

Windows 路径优先调用 `ReplaceFileW(target, replacement, backup, flags=0, ...)`，不设置 `REPLACEFILE_WRITE_THROUGH`，不忽略 ACL/属性合并错误。replacement 和 backup 都在目标卷上的独占事务目录中。调用前只做必要的句柄/路径准备；不在 final check 和 API 调用之间做日志写盘、清理或重新构造 view。

调用返回后必须检查实际路径和哈希：

- 目标存在且内容等于 `outputFingerprint`，视为已提交；backup 若存在则保存为旧版本恢复 artifact。
- 目标仍等于期望旧 fingerprint、replacement 仍存在，视为未提交；保留 replacement，返回可重试的替换失败。
- 目标、replacement、backup 的组合与上述两类不一致，视为状态不明；保留全部路径并返回结构化 `save-replace-ambiguous`，不得盲目再做 rename 或删除。

1175/1176/1177 等 Windows 错误必须结合实际路径和哈希解释，不能统一调用“恢复 backup”而覆盖可能已经出现的新版本。只有确认目标不存在、replacement 未提交且 backup 的哈希等于旧 fingerprint 时，才允许自动恢复旧目标；否则保留双方版本交给恢复界面。

### 4.4 提交不存在的目标

Save As 的期望 fingerprint 为 `None` 时使用不覆盖的同卷移动路径，例如 `MoveFileExW` 不带 `MOVEFILE_REPLACE_EXISTING`，或经过 Windows 实测证明等价的 Rust 封装。不能调用 `replace_or_create_file` 这种先 `exists` 再分支的无锁实现，也不能把“目标仍不存在”当成文件系统级 CAS。

若目标在 final check 后出现，移动操作必须失败并返回 `target-conflict`；不得覆盖这个新目标。失败后 replacement、manifest 和原 session 均保留。若实现所选 API 在该竞态下有任何覆盖可能，方案不合格，应改用能证明“不覆盖”的原生调用或在提交前建立 Windows 级别的独占保护。

### 4.5 发布与 cleanup

目标哈希确认等于 output 后，先把 manifest 标为 `Committed` 并尽可能同步，再发布 WP04c 的新 base/view/saved revision。发布步骤不得再包含会导致磁盘状态回滚的可失败操作。

之后才清理 replacement、backup、manifest 和事务目录：

- 清理成功：返回普通成功回执；
- 目标已确认提交但某项清理失败：仍返回成功，附 `cleanupWarning` 和真实事务目录路径；下次启动继续发现和清理；
- 目标提交状态无法确认：返回结构化错误，所有可恢复材料保留；不能把 cleanup 错误伪装成普通写入失败。

普通 `write_text_file` 当前返回 `Result<(), String>`，实现时需在内部保留 `Committed` 与 `NotCommitted/Ambiguous` 的区分。若暂时不能扩展 IPC 回执，至少必须记录 warning 并保留 artifact，禁止把已提交的 cleanup failure 映射成可重复保存的普通 `Err`；更完整的做法是返回包含 `committed`、`cleanupWarning` 和 `recoveryArtifact` 的结构化 receipt。大文件命令已有 `LargeSaveReceipt`，可直接承载这些字段。

## 5. 崩溃和重启恢复状态机

manifest 与事务目录是恢复的依据；扫描只接受应用生成的随机目录和格式正确的 manifest，不按全盘文件名猜测或删除。

| 可能中断阶段 | 可观察状态 | 重启处理 |
|---|---|---|
| 创建目录/manifest 前 | 目标旧内容；可能有不完整空目录 | 只清理明确由本次启动创建且未含用户文件的目录；否则保留并记录 |
| replacement 写入或 flush 中 | 目标旧内容；replacement 可能不完整 | 校验哈希不符就标为未提交，保留或由用户丢弃；不碰目标 |
| `Prepared`、final check 前后 | 目标旧内容；replacement 完整 | 重新校验目标；旧 fingerprint 不符则报告外部冲突，保留双方 |
| 目标移动到 backup 后、replacement 尚未成为目标 | 目标可能缺失；backup=旧；replacement=新 | 仅在目标缺失且 backup 哈希正确、replacement 未提交时恢复旧目标；否则标为状态不明并保留 |
| Windows 替换调用返回但 manifest 尚未更新 | 目标/backup/replacement 组合不定 | 按目标和 replacement 哈希分类；目标等于新内容则视为已提交，目标等于旧内容则未提交，其余状态不明 |
| 目标已是新内容、backup 尚在 | 新目标；旧 backup；manifest 为 Committed 或 CleanupPending | 先保留旧 backup，更新为已提交；cleanup 失败只产生 warning |
| backup/manifest 清理中 | 新目标；部分 artifact 已删 | 目标哈希正确即保持成功；继续清理剩余 artifact，不能回滚新目标 |

断电后不能保证 manifest 本身已落盘，因此恢复器必须把存在的 artifact、目标哈希和 manifest 一起作为证据；不存在足够证据时进入状态不明，而不是猜测。恢复器不得静默覆盖目标，也不得为了“清理干净”删除唯一的旧/新版本。

## 6. 并发、权限和断电语义

### 可以保证的范围

- 本应用内同一路径的保存可以通过锁/generation 串行化；旧 plan 在提交边界被拒绝，不能清掉后来的 pending。
- final check 之前已完成的外部同尺寸修改会被 SHA-256 fingerprint 拒绝。
- Save As 目标原本不存在时，经过不覆盖移动调用，最终出现的新目标不会被覆盖；失败会保留用户 replacement。
- 目标已经被验证为新内容后，cleanup 失败不会被报告为保存失败；旧版本 artifact 可供恢复。
- 目标写入失败或权限不足时，原始目标字节保持不变，事务材料可诊断；ACL/属性合并错误不被忽略。

### 不能无条件保证的范围

- fingerprint 比较与替换 API 之间仍存在外部进程写入窗口。`ReplaceFileW` 本身不是带 expected hash 的 CAS；最后检查只能缩小窗口，不能消除它。
- 如果外部程序在替换成功后立即再次写入，应用无法仅凭一次回执证明稍后读取到的仍是自己的版本。提交后校验发现不一致时必须报告 post-commit conflict 并保留 replacement，不得静默覆盖外部版本。
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
5. **提交后 cleanup 失败**：在目标替换成功后拒绝删除 backup/事务目录；目标新哈希正确，命令必须返回成功加 warning/recovery artifact，而不是 `Err`。

### 7.2 外部变化和 Save As

6. **同尺寸外部修改**：在初始 fingerprint 之后把目标改成相同长度，并尽量恢复相同修改时间；保存必须返回 external conflict，旧 session/pending 保留，外部字节不被覆盖。
7. **final check→replace 窗口**：提供确定性 barrier，在 final fingerprint 返回后、替换调用前由另一进程写入同尺寸不同内容。当前方案应红；合格实现要么由 Windows 级保护使外部写入失败，要么在 post-commit 检查后返回明确 ambiguous/post-commit conflict 并保留双方版本，不能静默声称保存成功。
8. **Save As 缺失目标出现**：捕获 expected target `None` 后，在 final check 后创建同名文件；提交必须失败为 target conflict，不能覆盖新文件，replacement 和原 session 均保留。
9. **Save As 已有目标**：无 expected fingerprint 时必须拒绝；有 fingerprint 时同尺寸外部变化必须拒绝；失败不改变原路径、base 或 dirty 状态。

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

每个 stage 都检查：目标是否存在、目标 hash、replacement 是否存在且 hash 是否完整、backup 是否存在且仍为旧 hash、manifest stage、恢复器分类，以及是否误删了测试目录外文件。对于 `ReplaceFileW` 的 1175/1176/1177，要构造或模拟对应路径组合，不能只断言错误字符串。

### 7.4 共享实现的验收

普通 `write_text_file_safely` 和 large `save_large_file`/`save_large_file_as` 必须使用同一事务 helper，并用同一组 fixture 验收：LF/CRLF/BOM/非 ASCII 字节精确比较、权限失败、同尺寸冲突、Save As 新目标出现、cleanup warning 和恢复 artifact。大文件 view 的 revision/新 base 断言沿用 WP04c；本包只新增最终磁盘状态断言。

## 8. 实施顺序和停止条件

1. 先抽取内部事务结果类型和测试 hook，不改变 UI；让普通保存和 large 保存都能返回 `Committed`、`NotCommitted`、`Ambiguous` 三态。
2. 在 Windows 上加入现有 `windows` crate 的 `Win32_Storage_FileSystem` feature，封装 `ReplaceFileW`、不覆盖移动和必要的 flush；不引入新依赖。
3. 实现独占事务目录、manifest、阶段恢复和 artifact 所有权；删除固定 temp/backup 名称及无条件清理。
4. 先让决定性红灯测试转绿，再接入普通命令和 large 命令的 receipt/错误映射。
5. 完成真实 Windows 文件、ACL、异常退出和 Save As 竞态测试后，才更新 LM-006 状态。

若无法证明 final check 后的 Save As 创建分支不会覆盖新出现的目标，停止并保留 `target-conflict`，不得退回 `REPLACE_EXISTING`。若替换 API 返回后无法分类目标/backup/replacement 的状态，停止自动恢复，保留双方版本并报告 ambiguous。若 cleanup 失败但目标已校验为新内容，必须保持成功回执语义，不能为了让测试“全绿”把它改成失败。

当前结论：现有代码已经有较好的大文件 fingerprint、revision、唯一 replacement 和 pending 保留基础；普通保存仍使用固定临时/backup 和手写目标移走流程。LM-006 仍是发布前未定界的问题，不能把 `ReplaceFileW` 或任意 `rename` 的函数名当作 CAS、事务或断电原子性的证明。
