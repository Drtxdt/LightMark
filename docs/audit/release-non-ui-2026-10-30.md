# Windows 正式产物非界面复核（2026-10-30）

按用户要求未使用 Computer Use，未操作、关闭或卸载既有安装，未修改用户默认配置。

## 旧安装状态

2026-10-27 的 `final-2026-10-27/results/command-result.json` 已完成 `saved-1`：`exactSavedBytes=true`、`webviewProfileIsolated=true`，保存与预期 SHA256 均为 `6f1c682d7dedd4395f620e32ef3a6a25a14db39540ee8f57de61e549970b0e21`。历史 `sandbox-report.json` 仍为 `manual-ui-ready` / `manualAcceptance=not-run`，不是完成凭据。

2026-10-30 通过提升权限的 Win32_Process 只读查询，没有发现运行中的 `lightmark.exe` 或先前监督脚本。历史 PID 不再可用于操作；没有发送 mailbox 命令。安装目录与注册状态尚未清理，当前复核不认定卸载通过。

正式验收 runner 的打开指引已由不存在的 `Ctrl+O` 改为实际 Open File 按钮；对应准备检查通过。历史构建 payload/报告保留原样。

## 已安装旧正式 CLI

运行脚本 `.cache/release-cli-review-20261030.mjs`、证据目录 `.cache/release-cli-review-20261030/`。运行前校验安装目录完整哈希：

- 主程序 `7d8803eb6cb25c71a2fe52f47761eaaaccfca072c64db1bb4f84f8010af03e51`。
- CLI `7ca5e7ca2e88a18b11401794b98b7b147840e38d15fa72dc7bd5b4d52d98f00e`。

使用全新官方命名 profile `cli-review-20261030`，独立 TEMP 与工作区夹具；没有继承 QA、WebView 或其他 profile 环境覆盖。`formats`、HTML 兼容性检查、HTML/PDF/PNG 实际导出，以及三种格式拒绝覆盖已有目标，共 8 项返回码符合预期。源文件字节哈希保持不变，每份输出大小与完整 SHA256 记录于 manifest。

HTML 包含首尾中文标记。PDF 3 页，NFKC 并去除文本提取的布局空白后首尾中文标记齐全；PNG 文件头有效、尺寸 900×2807。提取器在 ASCII 标记与中文之间加入空白，最初严格子串检查失败，校验改用明确记录的布局空白归一化。没有进行新输出的视觉检查。

这些结果仅验证 2026-10-27 安装产物的生产 CLI；不代表后来保存响应式修复的产物已验证，也不代替真实 GUI 的保存、草稿恢复、菜单导出或视觉验收。

## 仍需界面或桌面验收

更新正式构建后的标签保存反馈、关闭重开可见内容、真实未保存输入触发草稿与崩溃恢复、菜单导出、5MiB 边界及 50/100/500MiB 桌面窗口行为、键盘/焦点/缩放矩阵仍未执行。既有独立 backend/QA bridge 证据继续保留其原有适用范围。真实 IME 按用户要求跳过，macOS 仍延期。最终卸载与默认 profile/注册表基线复核仍待执行。
