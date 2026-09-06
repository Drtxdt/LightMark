# LightMark 行为验收矩阵

> 状态只能使用：通过、失败、未验证、不适用。代码检查通过不等于桌面行为通过。

## 验收环境

| 字段 | 值 |
| --- | --- |
| 基线提交 | `d0bf357` |
| 首轮修复工作树 | 未提交 |
| 操作系统 | Windows（待记录具体版本） |
| CPU / 内存 | 未验证 |
| WebView2 | 未验证 |
| 显示缩放 | 未验证 |
| 当前可执行文件 | `src-tauri/target/release/lightmark.exe` |
| 自动化基线 | 前端生产构建、29 项检查、29 项 Rust 测试通过 |

## P0 / P1 止损用例

| ID | 任务 | 入口与操作 | 预期 | 实际 | 状态 | 构建 | 复现材料 / 回归用例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MATH-001 | 行内公式 Escape 后输入 | 点击行内公式，Escape，输入 `a` | 公式提交并退出，`a` 出现在公式后的正文 | 旧构建中正文不接收输入；当前构建待桌面复验 | 未验证 | 当前未提交构建 | `scripts/check-math.mjs`（代码路径回归） |
| MATH-002 | 行内公式立即保存 | 编辑公式源码，不失焦，立即 Ctrl+S，重新打开 | 磁盘文件包含最后一次输入 | 已修复快照前 flush 路径；原生保存待复验 | 未验证 | 当前未提交构建 | `scripts/check-document-runtime.mjs` |
| MATH-003 | 行内公式立即切换 | 编辑公式，不失焦，切换源码模式或标签页 | 新公式值在新视图中保留 | 快照边界已接入 flush；待桌面复验 | 未验证 | 当前未提交构建 | `scripts/check-document-runtime.mjs` |
| MATH-004 | IME 组合期保存 | 拼音组合未结束时触发保存 | 等待 compositionend，不读取半成品且不抢焦点 | flush 会等待 compositionend；待真实中文输入法复验 | 未验证 | 当前未提交构建 | `scripts/check-math.mjs`（代码路径回归） |
| MATH-005 | 左右侧进入 | 分别点击公式左、右半区 | 源码光标分别在开头、末尾 | 已按点击位置设置初始光标；待桌面复验 | 未验证 | 当前未提交构建 | `src/extensions/MathNodes.ts` |
| SAVE-001 | 快照期间继续输入 | 触发保存，序列化期间继续输入 | 旧快照不清除新修改的脏状态 | 已有版本拒绝逻辑；待桌面竞态复验 | 未验证 | 当前未提交构建 | `scripts/check-document-runtime.mjs` |
| FID-001 | 无编辑保存字节不变 | 打开包含 BOM、CRLF、特殊空白的夹具，不编辑直接保存 | 文件字节完全相同 | 已实现无编辑快照短路，完全绕过 HTML 序列化 | 通过 | 当前未提交构建 | `scripts/check-source-preservation.mjs`、`scripts/check-document-runtime.mjs` |
| FID-002 | 局部编辑保留其他块 | 修改中间段落，保存包含 BOM、CRLF、非标准标题/列表空白的文档 | 仅变更段落重新序列化，其他块原样拼回 | 顶层源码范围与不可变节点映射已接入快照 | 通过 | 当前未提交构建 | `scripts/check-source-preservation.mjs` |
| FID-003 | 映射失效防静默覆盖 | 使用无法建立顶层映射的语法并编辑保存 | 阻止覆盖，提示切换源码或另存副本 | 快照组合器失败关闭 | 通过 | 当前未提交构建 | `scripts/check-source-preservation.mjs` |
| TABLE-001 | 工具栏插入表格 | 在可视化模式点击表格图标 | 插入 3×3 表格，首行为表头，光标可继续编辑 | 已接通 Tiptap 表格命令；待桌面复验 | 未验证 | 当前未提交构建 | `scripts/check-table-roundtrip.mjs` |
| INLINE-001 | 对称标记首次进入与左侧退出 | 从左右侧用方向键进入/退出 `**粗体**` | 首次进入即显示可编辑标记，正文保持粗体；左侧退出不弹回 | Edge CDP 真实 DOM 与键盘路径通过 | 通过 | 当前未提交构建 | `scripts/webview-markdown-editing-qa.mjs` |
| INLINE-002 | 删除分隔符去格式 | 删除 `**` 中任一字符 | 删除两侧整组标记并取消粗体，正文保留 | Edge CDP 与八类语法单元测试通过 | 通过 | 当前未提交构建 | `scripts/webview-markdown-editing-qa.mjs`、`scripts/check-input-rules.mjs` |
| HEADING-001 | 标题无效前缀恢复 | `# Title` 左侧输入 `x` 后删除 `x` | 普通段落立即恢复 H1，正文与光标偏移保留 | Edge CDP 真实输入路径通过 | 通过 | 当前未提交构建 | `scripts/webview-markdown-editing-qa.mjs` |

## 完整任务清单

| 分类 | 验收项 | 状态 | 证据 / 备注 |
| --- | --- | --- | --- |
| 写作 | 中文输入、英文输入、选区、剪切、粘贴 | 未验证 | 需真实 IME 与 WebView2 |
| 写作 | 格式快捷键、列表嵌套、任务列表 | 未验证 | 有代码检查，未完成桌面任务 |
| 写作 | 代码、表格、公式、脚注、HTML、Mermaid、Front Matter | 未验证 | 已有部分往返检查 |
| 导航 | 源码/可视化切换、标签页、分屏、大纲、折叠 | 未验证 | 已有代码检查 |
| 导航 | 查找替换、跳转、历史导航 | 未验证 | 需窄窗口和键盘复验 |
| 文件 | 打开、保存、另存为、关闭、恢复草稿 | 未验证 | 需隔离测试目录与配置 |
| 文件 | 外部修改冲突、重命名、附件路径 | 未验证 | 需磁盘竞态夹具 |
| 输出 | HTML、原生 PDF、PNG | 未验证 | 必须检查文件内容和排版 |
| 输出 | Pandoc 以及已公开的其他格式 | 未验证 | 需区分依赖已安装/缺失 |
| 界面 | 浅深主题、键盘访问、焦点返回、弹层遮挡 | 未验证 | 需视觉验收截图 |
| 界面 | 窄窗口、Windows 缩放、长文件名、错误状态 | 未验证 | 需 100%/125%/150% 缩放 |

## 证据记录

| 日期 | 构建 | 证据 | 结果 |
| --- | --- | --- | --- |
| 2026-09-06 | 当前未提交构建 | `pnpm build` | 通过 |
| 2026-09-06 | 当前未提交构建 | 29 项 `check:*` | 通过（含 Edge CDP Markdown 编辑行为检查） |
| 2026-09-06 | 当前未提交构建 | `cargo test` | 29 通过，0 失败 |
| 2026-09-06 | 当前未提交构建 | `pnpm tauri:build:app` | 通过，生成 `src-tauri/target/release/lightmark.exe` |
| 2026-09-06 | 当前未提交构建 | `pnpm tauri build --bundles nsis` | 通过，生成 `src-tauri/target/release/bundle/nsis/LightMark_0.1.0_x64-setup.exe` |
| 2026-09-06 | 当前未提交构建 | `pnpm tauri build --bundles msi` | 失败：本机 WiX 3.14 `light.exe` 链接阶段失败；应用本体与 NSIS 不受影响 |
| 2026-09-06 | 当前未提交构建 | Windows 原生交互自动化 | 未验证：当前任务未提供原生应用控制面 |
