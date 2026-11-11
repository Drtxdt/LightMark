# 2026-10-24 普通文档异步资源归属

本批在现有未提交工作树上实现；不把旧审计的通过记录视为本次证据。

## 实现边界

`pendingDocumentCommands` 保存 documentId、epoch、会话 lease、数值书签、局部引用绑定与正式源码投影，不保存 view、DOM、dispatch closure。Source 使用真实 ChangeSet；WYS 使用真实 StepMap。新 adapter 在旧 adapter 清理之前注册时先解除旧 lease，再重建新坐标；旧异步投影和旧 cleanup 不能覆盖新定位。

切标签或模式的正式 snapshot 将定位转换为当前精确 Markdown 范围。目标保持打开但未挂载时，操作对最新、相等、版本已核验的源码执行局部 CM 事务，保留 BOM 和混合换行，并记录一个文档历史命令。等待期间目标变为可见时，改走新 live adapter，不写其初始化正文。关闭目标清除命令并保留已生成资源。

资源重链绑定原引用。删除后插入同文引用仍视为原目标删除。允许明确 NodeView attribute-origin 的图片 editing/alt/width 修改，但 URI 变化使绑定失效；通用同宽 replace 不享有此例外。链接标签在边缘继续输入并继承原 href 时，绑定原映射文字的当前完整链接；修改完整链接的 href，保留其新标签和 Markdown title。旧资源面板行不回退到“唯一同名引用”。

图片处理固定原资源路径和设置。完成时通过稳定文档身份找到原文档；另存后按新路径重新生成引用，并在实际局部提交前再次校验路径。WYS 重链成功后以精确局部 raw patch 更新保真基线、历史 checkpoint 和有 revision/tab fence 的 snapshot cache。

## 验证

- `check-pending-document-commands.mjs`：真实 PM/CM maps、重复引用、删除/同文重插、属性修改、链接边缘输入、detach/hydrate、混合换行。
- `check-pending-command-lifecycle.mjs`：执行实际 appStore 协调函数与真实 runtime/CM/history，覆盖继续输入、后台原文档插入、另存改 id/path、挂载重叠、等待期间重新可见、关闭取消；包括 WYS 选区映射为 Source 坐标。
- `check-document-runtime.mjs`、`check-save-transaction.mjs`、`check-document-command-targets.mjs`、`check-snapshot-prime.mjs` 和类型检查通过。
- Windows 隔离 WebView 证据 `.cache/plan-native-tests/lightmark-native-qa-YfPuJC/manifest.json`：四项 `pendingCommands` 全部通过，覆盖真实编辑后重链/正式保存、切标签后图片插入/保存/撤销重做、WYS→Source 后插入、删除同文重插取消。该运行也验证跨标签六次 redo/undo 与原始字节恢复。后续 `FR8mRY` 和完整普通验收 `pPsijf` 同组仍通过；后者七项 P0 的 snapshot/结构/磁盘内容也全绿。运行是开发构建，最终固定 release 仍由主验收记录负责。

## 保守失败

2026-10-25 最后一批新增 own-save 文件监控 fence：旧 stat 回执跨保存基线变化时不再发布、写入期间延后监控、合并期间的新事件会重读，磁盘基线完整采用后端提交 receipt 的 fingerprint。`check-external-save-watch-race.mjs` 先复现误报后通过，`check-save-transaction.mjs` 和类型检查通过；尚未重新运行真实 Windows 保存/监控场景。新增 mounted WYS 富文本中插图用例已写入原生 helper，尚未执行。

HTML 节点整个本地源码被修改时，若没有内部原始输入映射，旧重链绑定会明确取消并刷新，不按相同 URL 的序号猜位置。WYS 无法证明源码投影或跨模式定位时也保留输入与资源并拒绝应用。原生剪贴板文件写入、真实压缩等待与手动 IME 的整体验收以主验收记录为准，不能由此处模块测试替代。
