# LightMark 实施状态

更新时间：2026-10-30。当前状态见下方最新续作及交接记录；后续按日期保留的章节属于历史实施记录，不能把当时的检查数量或待验结论当作当前全量验收。

## 最新续作：2026-10-30

本批未使用 Computer Use，保留用户未提交工作树，未提交或重置 Git。修复了保存回执直接修改 raw tab 导致标签脏标记不刷新的问题；修复公式 NodeView 对内容完全相等的 PM 节点重建误报冲突；将公式评估缓存从按历史文档根保留整份 KaTeX HTML 改为每个编辑器只保留当前文档，解决连续公式编辑的内存耗尽。新增七类 NodeView 各两次实际写盘、焦点/选区/pending/标签 DOM 检查。

最终前端统一检查 **94/94**；本轮 Rust 默认并行 **123 通过、0 失败、1 项物理矩阵另行执行**，其后 Rust 源码未变。最终真实普通文档原生回归、两次保存、保真/连续历史/异步归属均通过。修复后的完整 release QA 性能采样 **3920 个样本全部正常、39 项正确性全部通过**，源码前后哈希一致；这只建立有效测量与内容正确性，不代表流畅度已达标。

WYS 50,000 段落 Enter/Delete 的 rAF 可观察边界 P95 仍约 **974/825ms**，最终该夹具进程树 private bytes 约 **4.53GB**，性能和内存仍需收敛。正式 Windows 安装包已生成，CLI 八项及实际 HTML/PDF/PNG 导出通过，PDF/PNG 已作本地可视检查。最终安装版保存重开、真实草稿崩溃恢复、大文件桌面/剪贴板/缩放/键盘矩阵及旧验收安装卸载仍待执行；真实 IME 按用户要求跳过，macOS 延后。

**整轮计划尚未完成，不标记可发布。** 详见 [本批交接](handoff-2026-10-30.md) 与 [完整性能报告](performance-2026-10-30-release.md)。下方 2026-09-08 等章节保留为历史记录。

本文记录批准计划的实施状态。`lightmark-audit.md` 与 `lightmark-recovery-plan.md` 是审计原文归档，保留原审计时间、证据状态和未修复结论；本文不回写或改写两份归档。

## 本次续作：2026-09-08

当前仍未达到发布门槛，WP01–WP11 尚未全部执行完成。续作起点为 `12fe8c9c3ff2aea5f4925ced26532be30b697a66`，开始时工作区干净；之前的实现已由用户提交。本次新增代码仍全部由显式配置为 `gpt-5.6-luna / max` 的三个编码子代理完成。客户端工具声明与各代理 `turn_context` 均确认此配置；没有独立服务端路由证明。主负责人负责设计、实际 diff 审查和独立检查。本次只使用隔离测试数据。

本次机器条件另行实测：注册表 CPU 为 Intel Core i9-13900HX；获准只读运行 `systeminfo` 后报告 Windows 11 家庭版中文版、x64、Build 26200、物理内存总量 32,525 MB。查询时可用内存 17,161 MB，仅为当时环境快照；正式性能采样仍须重记负载、运行时与构建。初次沙箱内 systeminfo 返回 Access denied，不据此伪造机器字段。

| 范围 | 本次状态与证据 |
| --- | --- |
| 已有统一检查 | 续作基线 `check-all` 41/41 通过（`lightmark-check-all-M3pe6F`）。增加检查后的 2026-09-08 10:07 UTC 运行 48/50 通过（`lightmark-check-all-CA5ltC`）；两个失败是 WYS 回调参数别名变化导致架构断言未匹配。Luna 修正提取器后，主负责人独立重跑这两项、recovery-local-state 与类型检查均通过（`bbc104`）。尚未将此写作新一轮全量 50/50；bundle 也尚非最终发布构建。 |
| 公式 QA 探针 | `UBWOHN` 原生运行因探针缺少 `runtime` / `session` 声明失败，不计作产品失败。修复后，新增 gate 实际执行三个完整生成的 probe；主负责人独立运行通过。此 gate 使用 mock DOM/module，只证明探针可执行。 |
| Windows 公式闭环 | 主负责人独立运行 `node scripts/qa/isolated-native-evidence.mjs --launch --scenario math-receipt`，进程返回 0，三个阶段全部通过，详见下表。 |
| 细粒度源码映射 | 局部 ReplaceStep patch、持久 metadata、未知 step 的原子拒绝已通过主负责人独立逻辑检查。适配器仍未接入 WYS，列表/表格内部未编辑语法的产品保真问题仍未关闭。 |
| 大文件、磁盘事务 | Rust 文件事务已接入普通保存、大文件保存与草稿生产入口，独立草稿恢复无原目标路径；主负责人完整 Rust 检查 84/84 通过（隔离临时目录、Windows 文件替换权限）。真实共享冲突、外部写入、非覆盖创建、清理失败回执及写草稿/删除互斥有生产或 helper 级证据；Ambiguous 仍仅为分类夹具。前端 IPC、提交队列与关闭因果回执仍在审查，完整产品大文件编辑—保存—恢复未验收。 |
| 专用恢复文件 | v3 逻辑检查已通过；WYS 已有 `captureRecoveryBundle` / `restoreRecoveryBundle` 首片，尚待拥有独立实例的生产 WebView 测试。原始 bytes、PM 文档、局部缓冲分别保留；来源映射未证明时阻止覆盖。当前能力不含普通 PM/CM 历史，导出/导入 UI 尚未完成；不能将纯逻辑通过作为完整恢复验收。 |
| 标签切换归属 | 2026-09-08 10:28–10:30 UTC，主负责人在冻结修改后的隔离 IAB/Vite 1425 实际操作：WYS 输入 `audit A` → 新标签 → 返回，内容保留；源码追加 ` source` → 新标签 → 返回，内容精确为 `audit A source`。两个新标签均为空且已保存，原标签仍未保存。普通路径通过；异步晚到输入、原生文件和 Transition 竞态另验。 |
| 普通 Markdown 的特殊 NodeView | `rx12xG` 的真实文件打开路径暴露脚注 prepared/raw 坐标混用，修复后独立特殊块检查通过（`f9dc47`）。随后 TOC 的空行归属错误也已修复。2026-09-08 11:17 UTC，主负责人独立原生运行 `lm004-pending`（`9MWCVR` / `90de1b`）：四类 NodeView 的独立操作都得到精确预期 Markdown，未人工置 dirty 或替换 PM 文档；原夹具 324 B、SHA-256 `fc9def68841440b9bc22ac2546e09a355fec7cb953b503a2f9e30aefdf04fb06` 不变。然而 TOC 在快照后仍报告 pending=true，其他三项为 false，需补第二次快照/保存及累积操作；本项整体仍未关闭。每次 flush 记录一次 blur，不能声称过程中始终保留焦点。 |
| 跨模式历史、性能、最终安全与发布 | 文档级连续撤销未实现；没有发布构建性能基线或经批准的性能预算；完整桌面权限链、安装、导出、真实 IME、原生剪贴板和 Windows 缩放验收仍未完成。 |

### Windows 公式保存、退出草稿、重开恢复

2026-09-08 的 `f9dc47` 还记录了 Node 中源码范围提取诊断：100 个公式段落三次为 2.7/3.7/1.9 ms，1,000 个为 30.1/28.5/28.3 ms，5,000 个为 741.9/841.5/741.7 ms。此为脚本内 `performance.now()` 包围 `markdownTopLevelSourceBlocks` 的同步耗时，样本数各 3，不是 UI 输入延迟或发布性能基线。增长特征需要 WP08 单独定位，尚未据此制定预算或将优化混入脚注修复。

本节之前的续作命令级增量证据：主负责人还独立运行了 `cargo test --locked --offline --lib commands::large_draft::tests`（5/5）和 `commands::file::tests`（12/12）。覆盖独立草稿材料、原始会话关闭/源文件外部变化、恢复目标为空且必须另存等后端边界。测试返回日志分别为 `04a0b5` 与 `431bc4`；这是生产保存事务和 TS 草稿接线完成前的阶段检查，不是最终构建验收。后续完整 Rust/前端/native 检查必须重跑并绑定最终源码清单。

证据目录：`C:/Users/dell/AppData/Local/Temp/lightmark-native-qa-BsM8Kb`。隔离应用标识：`com.lightmark.qa.1788851002202bb4c55a1`。构建为 Tauri debug + Vite 开发服务；仓库状态、文件哈希、日志与运行时路径保存在 manifest。使用真实 WYS 会话、Math NodeView、Tauri 文件/窗口和草稿流程，通过 CDP 驱动 DOM 事件；不等同真实键盘或中文输入法。

| 阶段 | 实际结果 |
| --- | --- |
| math-save | 输入中的公式 `x` 改为 `x+1`，普通保存成功。磁盘为 `# Math receipt fixture\n\nA $x+1$ B\n`，34 bytes，SHA-256 `f1470aae722c053cd37cb445a3d6a92369d4d955b2e7e2fada0d20ab543bff72`；主负责人另用 `Get-FileHash` 核对。dirty 与 pending 均清除，普通 flush 回执包含一项授权文档变化，输入版本保持 1。 |
| math-window-draft | 未命名文档公式修改后调用原生窗口关闭，“不保存退出”保留 `Draft $draft+1$`。关闭对话框出现前捕获到 `close-finalize` 回执，session identity、完整 before/after token 和授权变化数量全部相符。 |
| math-recover | 同一隔离配置重新启动，点击实际恢复按钮后获得新的未命名可视化文档，内容仍为 `Draft $draft+1$`，dirty 为 true，WYS 会话存在。主负责人另读私有草稿 JSON 核对 content、path 为 null、editorMode 为 wysiwyg。 |

三个应用 PID 分别为 24428、26012、37420；对应 Vite/CDP 端口为 65258/65259、58347/58349、64710/64711。退出后主负责人用 netstat 核查，没有这些端口的 LISTENING 项，仅剩 TIME_WAIT。测试配置、草稿和证据按设计保留，未清理真实用户资料。

此结果关闭了这一个公式闭环的原生证据缺口；不能外推为公式完整矩阵、真实 IME、所有草稿竞态或发布安装包已验收。探针对 heading DOM 的记录继续保持 `presentationPathVerified: false`，没有据此宣称展示 transaction 路径已被证明。

### 恢复与历史接入的审查约束

2026-09-08 11:17 UTC 的原生 TOC 复验揭示了当前测试入口的限制：脚本返回 passed 只覆盖第一份快照的精确内容，没有断言后续保存是否可继续。主负责人审查 `hasPending → destroy → retainAndUnregisterRecoveryLocalBufferForOwner` 后发现，成功替换的 TOC 仍可能被保留为未解决缓冲；第二次快照是否受阻尚待确定性验证。不能将该脚本的 passed 扩大为完整 LM004 验收。独立检查 `recovery-local-state`（`04ba50`）、`document-runtime`（`33b566`）、类型检查（`096aff`）均通过，但未保护这一实际组合路径。

源码输入法防护已接入 CodeMirror 公开的 `compositionStarted/composing`，DOM composition 事件作为补充；独立检查 `1a3004` 通过。该检查使用普通状态对象、EventTarget 和接线断言，不是真实 CodeMirror EditContext 或 Windows 中文输入法测试。真实 IME 仍未验证。同次生产 appStore/draftStore 延迟竞态检查通过，包含大文件草稿清理等待期间到来的新输入保持 dirty；完整原生大文件闭环另验。

v3 纯模块没有把 checkpoint id 冒充完整撤销分支。当前安装的 `@codemirror/commands` 中，`HistEvent.toJSON` 只序列化 changes、mapped 与 selection，`fromJSON` 将 effects 设为空数组；本项目源码换行恢复依赖 `invertedEffects` 和自定义换行 effect。因此，后续 WP07 不能仅靠原生 CM history JSON 宣称混合换行的撤销状态已完整恢复。该结论来自安装版本代码审查，尚无跨模式运行验证。

生产恢复接入必须保持原会话，不能在读取局部值时触发 flush、blur 或 transaction；缺少局部内容时不能导出一个声称完整的文件。恢复目标为新未命名文档，来源路径只作溯源。原始 HTML 等字符串必须作为数据保存，展示时仍经过产品安全过滤。上述为正在执行的接入约束，不是已经通过的 UI 验收结果。

### 续作发现：LM014，导出目标在异步边界后仍取活动页

状态：有代码证据但未运行验证。暂定 P1，待 WP11 的独立缺陷工作包定界。

`src/utils/export.ts` 的 `runDocumentExport` 先对调用时的 activeTabId 执行 `flushDocumentSnapshot`，之后读取全局 currentContent/currentFilePath，并可能等待公式降级确认后再次读取这些全局值。验证步骤是：在文档 A 发起导出，快照或确认对话框等待期间切换到 B，检查最终文件的正文、文件名、相对资源路径和公式预检结果。预期导出始终绑定 A 的同一份已刷新快照；代码路径可能转而导出 B，或预检与最终正文不一致。根因判断中高可信，尚未复现实际输出，不能标记为已确认内容泄露或磁盘损坏。

后续 WP11-F01 先用生产导出入口的延迟夹具复现，再固定文档身份、快照、路径与导出设置；导出原生对照使用独立输出目录。该修复与保存事务、视觉调整分开验收。读取环境发现 PATH 中已有 Pandoc 和 Poppler；仅发现命令不等于实际导出质量已通过。

### 续作发现：LM015，格式化确认与实际应用没有同一文档版本校验

状态：有代码证据但未运行验证。暂定 P1，纳入 WP07 格式化历史接入前的正确性修复。

`appStore.ts::formatCurrentMarkdown` 固定 pane 后等待快照和预览确认，返回时按 pane 派发 `lightmark:apply-markdown-format`，没有核对原始 tab、当前 session、预览所对应的 revision 或正文。若在等待中改变该 pane 的文档或内容，旧格式化结果可能用于新状态。预期只有与预览相同的文档版本能接收已确认结果；否则保留新输入并重新预览。后续用延迟快照、确认期间新输入、切页三种夹具定界，记录真实 PM/CM 结果和一次撤销边界。尚未复现，不能把代码判断标成实际数据丢失。

### LM016：焦点在“取消”时 Enter 仍执行默认确认

状态：已实际复现，IAB 浏览器开发环境；P1，核心交互修复，不能混入样式提交。

2026-09-08，独立 Vite 端口 1423、1200×780、新未命名隔离文档。源码输入 `#    Audit\n\nabc   \n`，点击“格式化当前 Markdown”，初始焦点为“应用格式化”；按 Shift+Tab 后 AX 明确报告焦点为“取消”。再按 Enter，实际出现“格式化完成：调整 1 行”，正文末尾空格被移除。预期是取消并保留原始输入。未调用真实文件保存。

根因高可信：`AppDialog.vue` 外层 `@keydown.enter.prevent.stop` 总是调用 active.defaultId，抢占已聚焦按钮的原生 Enter。文件 SHA-256 为 `6be11066d80bff02e6486663e0ed66d0e05679d827dbaae069079ce070e97ca9`。后续需独立修复并验证 Enter/Space 激活当前按钮、Escape 取消、组合期不抢占，以及窗口关闭等共用对话框。后续开发 HMR 重置了隔离页面，因此没有把该页面之后的 Ctrl+Z 观察计作验收证据。

修复后，主负责人再次使用隔离 IAB/Vite 1423、1200×780、新未命名文档复验：同一夹具中，Shift+Tab 聚焦“取消”再 Enter，状态为“已取消格式化”，编辑区逐行 DOM 内容仍为 `["#    Audit", "", "abc   ", ""]`；再次打开，默认聚焦“应用格式化”再 Enter，状态为“格式化完成：调整 1 行”，逐行内容为 `["#    Audit", "", "abc", ""]`。Escape 也关闭对话框并恢复触发按钮焦点。当前 AppDialog SHA-256 为 `84143e6b8ec5d55579c15428754093a609dd66850631858fc2d57277ed1274e9`，`dialogKeyboard.ts` 为 `c78bca8f2ee6d66f29a850f6ee63240ba0315ba5bcd38df84c43b104444f8276`。

`check-app-dialog-keyboard.mjs` 由主负责人独立运行通过，含 Cancel Enter、Space、非按钮目标和 composing 对照；它使用 MiniNode 事件传播模型，不能证明原生激活或 IME。后续复位夹具出现编辑区状态不一致，且服务日志记录了热更新，因此没有继续给 Space 或源码选区行为记通过；需要固定构建重测。隔离页面与开发进程已关闭。LM016 的最小复现已转绿，窗口关闭共用对话框和发布构建仍待完整验收。

### 续作发现：LM017，异步图片保存和插入缺少同一文档约束

状态：有代码证据但未运行验证。暂定 P1，纳入真实图片任务的独立修复与验收，不宣称已发生实际文件误写。

`src/utils/imageAssets.ts::saveImagesAsMarkdown` 在图片压缩与 `file.arrayBuffer()` 等等待之后，由 `saveImageAsset` 读取全局 currentFilePath 和图片设置；多张图片还会逐张重复读取。WYS 调用方保存了旧 from/to，却在完成后取当前 `editor.value` 插入；源码调用方保留 EditorView，但使用完成时的 selection，拖放位置也没有变更映射。验证条件为在文档 A 粘贴较大图片，处理期间切到 B 或继续编辑 A。预期资源目录、Markdown 相对路径及插入位置一致绑定发起操作的文档；失效位置应保留已生成资源并提示重试，不能覆盖后来输入。当前代码可能使用另一文档目录、失效坐标或已销毁视图，根因判断中高可信。

后续先以本地图片、可控处理延迟和真实 PM/CM 事务建立失败用例；固定原始文档、资源路径及设置，使用版本化插入书签和存活会话验证。磁盘保存成功而插入失败须反馈可恢复资源路径，不能静默吞掉 Promise 拒绝或删除用户资源。测试必须核对实际落盘位置、相对链接、插入内容和新输入是否保留；原生剪贴板仍需独立验收。

### WP09 追加实测：对话框与主题作用域

同一 1200×780 深色浏览器页面，实际“应用格式化”按钮 computed style 为文字 `rgb(255,254,251)`、背景 `rgb(120,166,211)`、13px；按相对亮度计算，对比为 2.541:1。普通文字对比评估依据 [WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。此为实际组件颜色问题，不能用基础 token 的计算通过来替代。

聚焦“取消”时背景仍为 `rgb(255,254,251)`，文字 `rgb(74,68,59)`，outline 为 none，只有 alpha=0.38 的蓝色阴影。读取页面实际 CSSOM，SFC 中 `:global(.dark) .dialog-button-secondary` 等规则已输出成只有 `.dark` 的规则；预期的组件暗色后代选择器缺失。这也影响模式开关等同类选择器，需在 WP09 内按实际编译 CSS 校准。尚未复验 Windows WebView2 和系统缩放。

基础 token 的静态计算对照如下，使用源码颜色、sRGB alpha 合成与相对亮度；只用于设计核对，不等同全组件通过。按 [WCAG 2.2 SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) 评估必要的非文本状态提示；仅有半透明焦点阴影的组件需实际相邻背景核验。

| 颜色组合 | 浅色比值 | 深色比值 |
| --- | --- | --- |
| 正文 / surface | 14.679 | 15.798 |
| 次级文字 / surface-soft | 4.755 | 6.107 |
| accent / surface | 5.269 | 6.792 |
| error / surface | 6.574 | 8.967 |
| focus 阴影合成于 surface-soft / surface-soft | 1.590 | 2.044 |

其他静态缺口：Toolbar 的 `--lm-accent-strong` 与 `--lm-danger` 引用未发现定义；某些全局 `outline:none` 覆盖了组件层的焦点 outline。后续只修 token 引用、正确作用域和可辨识焦点，不改变批准范围内的布局、图标、正文尺寸或编辑宽度。

## WP01 / WP02 / WP05A / WP06 / WP09 状态（2026-09-07）

### 2026-09-08 设置弹窗焦点复验

主负责人在隔离 IAB/Vite 1425、900×600 视口复现：设置弹窗初始焦点在 panel 自身，首次 Shift+Tab 跳到背后的 CodeMirror；另一次 WYS 对照跳到 ProseMirror，DOM 检查均为 `dialogContainsFocus: false`。根因为 `useOverlayFocus` 将 panel 自身视为已在弹窗内，却没有为该初始非子控件焦点处理反向 Tab。

Luna 修复后，主负责人刷新稳定页面独立复验：首次 Shift+Tab 聚焦弹窗末项“自动保存间隔”，Tab 回到首项“基础”，Escape 返回偏好设置按钮。`check-app-dialog-keyboard.mjs` 通过（`d3ed91`），包括初始 panel、首末项、空弹层和顶层弹窗规则；MiniNode 检查仍不替代原生 IME。窗口内容宽高由 DOM 实测为 900×600，设备比例约 1。深色最小窗口复验遇到开发热更新导致控件失效，因此未记通过；最终 Windows 三档缩放仍待固定发布构建。浏览器页、视口覆盖和 root 的 Vite 服务均已关闭。

WP01、WP02、WP06 与 WP09 的批准实现已落入共享工作树；WP04 由另一代理更新，本节不覆盖其实现。WP05A 已完成源码模式的混合换行元数据与精确快照边界，范围限定为源码模式内编辑、撤销和重做，不宣称跨模式历史、精确跨模式选区或原生粘贴/IME 已解决。

主负责人本轮独立实测通过 `node scripts/check-math.mjs`、`node scripts/check-source-line-endings.mjs`、`node scripts/check-source-preservation.mjs` 与 `npx vue-tsc --noEmit`；浏览器实测 `abc` → `abcd` 与多公式内容正确。浅色和深色 computed token 已核对，并观察了 1200×780 浅色内容截图。上述结果是已覆盖场景的证据，不等于完整浏览器视觉验收、WCAG 全通过或原生输入闭环验收。

WP09 本轮只统一灰蓝 token 的控件、选区、gutter、表格背景/边框和设置侧栏选中态，保留布局、尺寸、字号、圆角与动画结构；表格深色覆盖规则及设置侧栏焦点轮廓已按 token 修正，待主负责人进行最终浏览器复核。未创建 git 提交，也未改动真实笔记。

WP05B/C 的特殊块坐标修复已落入共享工作树。`node scripts/check-source-special-blocks.mjs` 与 `node scripts/check-source-preservation.mjs` 当前通过；主负责人还在隔离浏览器复核了 frontmatter、块公式和 mermaid 后接段落改单字，源码逐行保持精确。缺失脚注生成节点的首次初始化、TrailingNode 补入、再次编辑和无换行 EOF 链已有显式 synthetic 标记适配；LF 文档两次重建已复核为 `abcde`，无 LF 文档首轮为 `abcd`，同会话双 snapshot 目前只有逻辑夹具证据，尚待统一原生场景复验。该范围仍不等于嵌套树的细粒度映射、跨模式历史或所有格式的完整源码保真。

## LM012：特殊块坐标错配（P0，2026-09-07）

LM012 的原始浏览器复现已由 provenance/zero-width synthetic 修复覆盖：`---\ntitle: Audit\n---\n\nabc\n` 末尾改单字后，frontmatter、空行和 `abcd\n` 保持；块公式和 mermaid 尾段同样通过。缺失脚注 `text[^missing]\n\nabc` 的 LF 文档已在浏览器复核首轮 `abcd` 及同会话再次编辑后的 `abcde`，无 EOF 换行文档首轮 `abcd` 也已复核；无 EOF 同会话双 snapshot 目前只有真实逻辑断言，原生复验仍待完成。当前桌面/原生证据不宣称完整通过。

此前红灯夹具记录的根因仍保留为审计背景：`markdownTopLevelSourceBlocks` 在 `markSpecialBlocksForEditor` 改变行数后套用原文 `lineStarts`，导致 frontmatter/块公式/mermaid 的 prepared 坐标错配。现行修复由同一生产 pipeline 记录 raw span 与显式 synthetic EOF 来源，不能用 raw parser 或最终字符串 diff 替代，也未扩大为嵌套树细粒度映射。

## 专用恢复文件 codec（2026-09-07）

新增 `src/editor/recoveryCodec.ts` 与 `scripts/check-recovery-codec.mjs`，当前只提供纯 codec，不接入 WYSIWYG、store、文件 IO 或恢复 UI。版本化 JSON（schema v2）保存原始 UTF-8 bytes 的 base64 与长度、ProseMirror JSON、Selection JSON、scroll、pending math 的 accepted/local 两份内容与版本，以及来源路径元数据；pending math 绑定明确区分 `linked` 与带原因的 `conflicted`/`orphaned` 未关联载荷，只有 `linked` 会校验当前 PM 数学节点和 accepted attrs，未关联项只保留旧位置提示，读入方不得自动套入当前节点。读入返回新文档，不覆盖原路径，不调用 Turndown 或执行 HTML/代码字符串。

codec 在真实 StarterKit + Table + MathNodes 子集 schema 上校验 fatal UTF-8（`ignoreBOM: true`）、空源、base64 canonical padding、大小/字段/深度限制；恢复文档后显式调用 `doc.check()`，再要求 canonical `toJSON()` 相等并检查文档内全部数学节点 attrs。文本反向选区、NodeSelection 边界、CellSelection 的真实 cell 边界与同表约束、linked pending 数学节点关联均有 typed failure；冲突节点已变更 tex、原节点已删除、孤儿旧位置提示三种独立载荷均要求完整 round-trip，伪 linked 仍拒绝。`node scripts/check-recovery-codec.mjs` 已通过，覆盖 BOM/混合换行/中文 emoji、损坏源、错版本、未知 attrs、非法文档结构、跨表 cell selection、非法数学/滚动/来源字段。

该 codec 尚未声明完整编辑态恢复：FrontMatter/HTML/脚注视图的未提交局部状态、WYS 生命周期元数据、编辑历史和恢复入口的安全渲染仍需后续集成设计；恢复 bundle 只能作为专用完整恢复文件，失败时应保留原会话并允许重试。

MathNodes 已增加纯只读 `capturePendingMathRecovery(editor)` 入口：每个 inline/block NodeView 注册稳定捕获 callback，保留 editing 但内容未变的局部状态；当前节点/accepted attrs 可验证时输出 `linked`，文档节点发生变化或 NodeView 冲突时输出 `conflicted`，getPos/文档视图失效或 NodeView 已销毁时输出带旧位置提示的 `orphaned`。捕获不 flush、dispatch、失焦、销毁 NodeView 或推进 pending registry 版本；WYS/source selection、FrontMatter/HTML/脚注等其他 local buffers 仍不在本入口。`node scripts/check-math-recovery-capture.mjs` 以真实 PM schema 和 InlineMath/BlockMath NodeView 覆盖局部值、冲突/删除、越界/抛错 getPos、销毁后 state getter 失败及重复捕获；同时验证文档、DOM 局部值、pending/edit 版本和 dispatch/focus 计数不变。

`sourceLeafProvenance` 的受限首片现在还覆盖真实 PM 空表格 cell 的零宽 text slot：slot 绑定解析得到的 raw 空区间、保留原 padding、记录 paragraph/cell PM child path，并拒绝跨 slot 或结构变化。空 cell 插入、删除文本后重建 baseline 再插入、多个空 cell 的第二格插入，以及 BOM/CRLF/emoji 夹具均由 `node scripts/check-source-leaf-provenance.mjs` 通过。无法从 Markdown 获得唯一 raw 区间的顶层 synthetic 空 paragraph 明确 typed fail；该 helper 仍未接入生产 WYS，不扩展 marks/entities/复杂语法。

修复设计必须把 JS 字符串和 ProseMirror 位置都作为 UTF-16 code-unit 坐标；中文、emoji 夹具需单独覆盖，磁盘 UTF-8 bytes 只用于最终保真比较。历史审计原文不改。

## WP03：检查入口与隔离证据准备

已实现 `scripts/check-all.mjs`。它只枚举 `scripts/` 的直属 `check-*.mjs`，显式排除自身，不递归 `scripts/qa/`。每项检查按排序后的文件名顺序独立启动，记录命令、工作目录、分类、开始时间、耗时、真实 `exitCode`、signal、stdout、stderr 和启动错误。单项失败不会中止后续检查；最终由所有结果计算总状态，任一失败都会使入口以非零状态退出。

统一入口把检查分为 `source`、`state-logic`、`artifact` 和显式 `security-gate`。性能检查归入源码门禁，并明确输出“仅静态性能架构契约，不测量 WebView/UI 时间、内存或帧率”；bundle 检查归入产物门禁。正式 `scripts/qa/check-html-security-regression.mjs` 现在由 `scripts/qa/check-catalog.mjs` 声明为显式 gate，并由 `scripts/check-all.mjs` 纳入清单和 manifest；旧的 `check-html-security.mjs` 仍是 investigation-only，不会被统一入口误当作安全通过。运行报告默认写入操作系统临时目录并保留，包含 `manifest.json`、逐项结果、`summary.json`、`git-status.txt`、`git.diff`、HEAD、packageManager 以及 Node、Git、pnpm、rustc 版本信息。workspace 清单同时记录 tracked 和 untracked 文件的 SHA-256（排除 `.git`、`node_modules`、`dist`、`target` 及临时 `.lightmark-*`），所以未纳入 `git diff HEAD` 的新检查脚本仍有证据；manifest 还列出实际执行脚本和导入 helper。工具不可执行时记录 `availability: "unknown"`，不会冒充已测到版本。可用 `node scripts/check-all.mjs --list` 只查看发现结果，或用 `--output <新的临时目录>` 指定证据目录；指定目录已存在时会拒绝覆盖。当前 `--list` 已确认正式 security gate 被发现；此前的 31/31 统一运行证据早于该 gate，不能当作本轮新增 gate 的全量重跑结果。

新增 `scripts/qa/isolated-native-evidence.mjs` 与 `qa:prepare-native` 入口默认只执行 `prepare`，不启动 Tauri、不启动 CDP、不触碰真实 notes；显式 `--launch` 才运行隔离 smoke。它在临时目录生成夹具、输出目录和日志目录，并从当前 `src-tauri/tauri.conf.json` 生成唯一 identifier 的 `tauri.qa.json`，完整保留窗口字段；若基线已经有 `dataDirectory` 覆盖，准备器会拒绝继续，避免错误宣称默认隔离。按当前 Cargo 锁定的 Tauri 2.11.2 实现，唯一 identifier 会隔离 `app_config_dir`、`app_data_dir` 和 Windows 默认 WebView `LocalData/identifier`；这些预期路径会写入 manifest，准备器不会提前创建或清理它们，也没有写入一个未被产品使用的临时 profile。失败产物和运行目录始终保留。

主负责人独立运行了两阶段隔离闭环，证据目录为 `C:\Users\dell\AppData\Local\Temp\lightmark-native-qa-zAkerP`，`save-close` 与 `reopen` 均通过；夹具磁盘内容在保存和重开后均为 158 bytes，实际 WebView2 为 `Edg/152.0.4191.66`，四个目标端口在退出后均无 `LISTENING`。另一次同版本自测目录为 `C:\Users\dell\AppData\Local\Temp\lightmark-native-qa-EykTKh`，结果相同。manifest 保留随机 identifier 对应的配置、AppData、LocalData 和 `EBWebView` profile；loopback 证据只记录本次 CDP 目标端口，CdpClient 失败连接、同步发送异常和关闭路径均有资源清理检查。该闭环通过的是隔离 debug WebView 中受控 API 的打开—编辑—保存—关闭—重开和字节比较，不等同发布安装包、真实键盘、IME、剪贴板或性能验收。

## 检查契约修正

`check-table-markdown.mjs` 已按当前契约断言插入行使用 `thead/th`，空行、分隔行、带空格输入、代码 span 中的管线符和 HTML 转义均有边界断言。

`check-performance.mjs` 与 `check-regression-closures.mjs` 对每个用于后续负断言的正则抽取先执行非空断言，避免目标函数或代码块消失后测试因空字符串而假通过。

主负责人在升级运行权限后独立运行 `node scripts/check-all.mjs`，证据目录为 `Temp/lightmark-check-all-Awq5ND`，31/31 项通过（包含读取既有 `dist` 的 bundle budget；这不等于重新构建后的发布验收），并完成直接 TypeScript 检查。子代理另行通过 Node 语法检查、表格检查、性能架构检查、回归闭包检查和 prepare-only 运行；未运行原生启动器或既有 CDP 脚本。普通保存、原生闭环和真实 UI 性能仍保持原审计状态，不能据此宣称已修复。

## WP04a：普通保存事务与隔离证据

普通文档保存现在通过每个标签页对象的串行队列执行。保存请求在入队前冻结标签页对象、ID、路径、会话、变更 epoch 和运行时 revision；每个异步边界都重新核对这些身份。写盘、取 stat、提交清洁状态和 SaveAs 重绑定均使用冻结正文与显式路径。SaveAs 在对话框返回后重新捕获最新正文，提交时只替换布局中的旧 tab ID，保留当前活动 pane 和另一 pane；写入期间切换活动页不会把重绑定写到新活动页。文档会话快照还会在 flush、snapshot 和提交边界检查注册表中的会话对象，阻止同 tab ID 的旧编辑器返回覆盖新会话。

`getDirtyTabs()` 现在把 `DocumentSessionAdapter.hasPendingEdits()` 纳入脏文档发现，普通保存的最终稳定检查也拒绝仍有 pending edits 的会话。普通保存不再调用全局 `clearActiveDraft()`，因此不会删除另一标签页草稿；每个未命名标签页的草稿 ID 绑定到其 tab 对象，并通过 Vue `toRaw` 统一 raw/proxy 身份。

新增 `scripts/check-save-transaction.mjs` 是状态逻辑检查，不是源码字符串门禁。它会转译并调用真实 `appStore` 保存导出，注入 Tauri `invoke` 的延迟写入和 stat，覆盖写盘期间新输入、另一标签页保持不变、稳定连续保存使用前一次 baseline、活动页切换期间 SaveAs、布局保留、真实会话替换拒绝旧快照，以及真实 `draftStore` 两个未命名标签页和切页后的延迟草稿写入。此前 `node scripts/check-all.mjs` 的证据目录 `C:\Users\dell\AppData\Local\Temp\lightmark-check-all-XRoKtb`、33/33 项通过，发生在 LM012 检查和 WP04B 检查加入之前；不能当作当前全量结果。WP04B 改动后的 `node scripts/check-save-transaction.mjs`、`vue-tsc --noEmit`、脚本语法检查和 `git diff --check` 已分别通过，但统一入口尚未在这轮重新运行。

本包保留两个边界。一次写盘在期间发生新输入时，旧版本可能已经写入磁盘；实现保留旧 baseline，后续重试在真实文件 metadata 改变时会保守进入外部冲突流程，检查没有把这个结果伪装成自动重试成功。普通保存仍保守保留草稿，大文件旧保存路径和独立的全局手动丢弃接口仍需后续按 captured draft identity 继续收紧；WP04B 的标签关闭清理见下节。大文件/Rust 保存事务也不在本包范围内。

## WP04B：普通/未命名标签关闭与草稿清理（2026-09-07）

`closeTabInternal()` 现在按 raw tab 对象捕获关闭目标、路径、会话、epoch、revision、pending 状态和可选的 pending buffer 版本。对话框等待期间切换活动页仍保存并关闭原目标；SaveAs 改变 tab ID 后按对象身份移除原标签，并保留当前活动 pane 与其他 pane。丢弃只授权对话框捕获的版本；期间发生新输入、pending buffer 版本变化、会话销毁或同 ID 会话替换时保留标签或草稿。

草稿 ID 按未命名 tab 对象绑定，写入和删除共用该 tab 的串行队列。删除前核对 captured draft identity；SaveAs 的旧草稿只有在对应保存 receipt 验证通过时才删除，删除失败保留恢复记录，另一 tab 的草稿不会被活动页全局 ID 串改。真实生产 `appStore`/`draftStore` 测试覆盖上述关闭、SaveAs、pending 提示、丢弃竞态、切页后的延迟写入、失败删除以及会话丢失/替换。

本轮验证普通、未命名标签的关闭链路，以及关闭大文件时只走 `save_large_file`/`close_large_file` 的路由边界；大文件 buffer 事务、窗口级关闭的全部保存语义以及统一入口全量重跑仍未在本轮宣称完成。`DocumentSessionAdapter` 已增加可选 `pendingEditVersion()` 契约，WYSIWYG 会话现读取 MathNodes 的单调 pending 版本，测试夹具同时覆盖对话框期间的局部变化；这仍不等于公式跨模式、浏览器 IME 或窗口级关闭的完整验收。

## LM013：公式编辑器 Home/End 边界键与选择扩展（2026-09-07）

审计浏览器场景先复现了 InlineMath 的边界键问题：源码 `A $x$ B` 进入公式后，Ctrl+End 再输入字符会把字符插到公式开头；源码 `A $xyz$ B` 进入公式后，Ctrl+Home 的默认行为会离开嵌套源码编辑器并回到 ProseMirror 容器。主负责人在隔离应用内浏览器中逐步观察到这些行为，内容本身未被额外改写。

生产修复在 `MathNodes.ts` 的公式源码 keydown 路径拦截 Ctrl/Meta+End 与 Ctrl/Meta+Home，并调用 `LatexSuggest.ts` 的可选扩展模式：不带 Shift 时折叠到末尾或开头，带 Shift 时保留当前 DOM selection anchor 并把 focus 扩展到目标边界；IME composition 与补全处理仍优先。`scripts/check-math.mjs` 通过生产 InlineMath NodeView 加模拟 DOM/Selection 夹具覆盖 Ctrl+End、Ctrl+Shift+End、Ctrl+Home、Ctrl+Shift+Home、组合期不抢键及追加字符路径。主负责人随后在隔离应用内浏览器复验：公式 `xyz` 将光标置于 `x` 后按 Ctrl+Shift+End 后输入 `a` 得到 `xa`，将光标置于 `z` 前按 Ctrl+Shift+Home 后输入 `a` 得到 `az`，先按 End 再按 Ctrl+Home 输入 `a` 得到 `axyz`；三条路径 Escape 后源码均精确。该浏览器证据覆盖键盘选择语义，不等同真实中文 IME 验收；Node 夹具仍明确是模拟对象测试。

同一公式 pending 注册表现已提供单调 `getPendingMathEditVersion(editor)`，在注册/注销、真实输入、composition、节点身份接受、冲突和销毁状态变化时推进；WYSIWYG 会话现已把该值暴露为 `DocumentSessionAdapter.pendingEditVersion()`。当前不把 MathNodes 单元测试通过解释为保存/关闭链路、跨模式历史或浏览器 IME 已完成。

## LM011：LargeMarkdownEditor 内容执行路径（2026-09-07）

主负责人在隔离原生 launcher 的 `html-security` 场景中完成了当前版本的真实 WebView2 复现。证据目录为 `C:\Users\dell\AppData\Local\Temp\lightmark-native-qa-7pZeSB`，使用唯一 identifier `com.lightmark.qa.1788778688163ae45a53a`；夹具为 5,242,881 bytes、106,997 行，仅包含首行伪造的 `data-type="inline-math"` 图片、无效本地 data URI 和设置测试 DOM sentinel 的 `onerror`。

应用通过真实 `appStore.openFile()` 进入 `documentMode: "large"`，LargeMarkdownEditor 的 `.large-doc-render` 中保留了 `onerror`，sentinel 与随机期望值完全匹配，`scriptExecuted: true`。夹具关闭后字节内容未改变，launcher 进程退出成功，目标端口 `52422/52423` 无遗留监听。该证据证明当前 renderer 信任边界可在原生 WebView2 执行用户伪造的事件属性，因此 LM011 当前为发布阻断；它没有测试文件越权、IPC 越权、远程资源或 CSP 单项结论。

当前正式门禁 `node scripts/qa/check-html-security-regression.mjs` 已从修复前红灯转为逻辑绿灯：三个伪造内部标记、恶意父节点包裹内部子节点、增强图片危险/合法 URL、公式、frontmatter、mermaid、TOC、脚注和 capability helper 契约均通过。生产路径新增每次 render 的随机 capability token；只有根 opening tag 持有当前 token 的应用构造片段可保留内部属性，renderer 返回前剥离 token；增强图片和 fenced code 仍走普通处理。原有 `check-html-security.mjs` 保留为 investigation-only，不能把它当作安全门禁。

主负责人随后独立运行修复后的隔离原生 `html-security` 场景，证据目录为 `C:\Users\dell\AppData\Local\Temp\lightmark-native-qa-wNgKQX`，WebView2 为 `Edg/152.0.4191.66`，唯一 identifier 为 `com.lightmark.qa.17887816281626dfc1c28`。该次运行加载 4 个渲染块；恶意输入仍保留但 `scriptExecuted: false`、`activeEventAttributes: 0`，安全对照 PNG 为 1×1 且 `normalContentPresent: true`。夹具为 5,242,881 bytes，关闭后 SHA-256 仍为 `c568ed38f4984dd269c7ee31bab483b4306d5cf8a161d9d80131eda0ec4e7abc`；进程 PID `21272` 与目标端口 `62005/62006` 已退出且无监听。该证据证明当前固定 WebView2 LargeMarkdownEditor 路径不再执行本夹具的伪造事件属性；preview/export 其他渲染上下文、CSP、IPC、文件权限和远程资源链路仍未由此完成验证。正式 preview/security 逻辑 gate 在该原生运行之后另行通过；统一 `check-all` 的包含关系已验证，包含新增 gate 的全量结果仍需单独重跑。

## WP04B2：窗口级关闭协调器（2026-09-07）

窗口关闭先捕获全部 raw tab 对象及其路径、模式、内容、dirty 状态、会话、epoch、revision、pending token 和大文件待写指纹；保存选择在对话框返回后重新捕获最新授权版本。不保存退出明确保留提示时版本的恢复草稿，先按 tab 串行队列写入，该路径不受普通 auto-save 开关影响，草稿写入失败或版本变化会阻止退出并保留窗口。单标签页 discard 继续按对应 tab 的 captured 草稿 receipt 尝试清理，竞态或删除失败时保留恢复记录；窗口级不保存退出不删除该版本草稿。

窗口保存使用 `saveAllDirtyTabsForClose()` 直接处理 captured tab，不通过 activate 切换后台编辑器；SaveAs 的 tab ID/path 重绑定只有对应 receipt 能使最终对象集合检查通过。每个保存和草稿准备步骤之后都会重新检查完整 tab 对象集合；新增/移除 tab、同 ID 会话替换、提示后的输入或 pending token 变化都会取消退出。`App.vue` 使用可测试的 `prepareWindowClose()` 与 close ticket；原生 `window.close()` 产生的后续 close request 只有在 ticket 仍有效时才允许 SDK 默认关闭，失效时会 preventDefault 并清除 ticket。

`scripts/check-save-transaction.mjs` 新增真实 appStore/draftStore 图测试：后台 tab 直接保存、SaveAs 对话框期间新输入取消退出、新 tab 阻止关闭、auto-save 关闭时保留提示版本草稿、旧草稿不被新输入覆盖，以及稳定 pending buffer 的授权 flush；同时调用真实 `prepareWindowClose()` 覆盖 discard/save ticket 分支和无效提示。当前生产 Math pending token 在某些合法 blur flush 路径也会推进；协调器对无法区分的 token 变化采取保守留窗策略，未宣称公式局部缓冲的窗口级关闭已完整闭环。新增的真实 InlineMath NodeView/ProseMirror apply+update/store receipt 检查覆盖普通保存、窗口保存、窗口 SaveAs 二次 flush 和保留草稿，以及 finalize 期间新输入、外部 PM transaction、snapshot 后 source microtask 竞态；这些仍是隔离 NodeView harness，不等同真实 WYS 注册组件或原生 WebView。`node scripts/check-save-transaction.mjs`、`node scripts/check-math.mjs` 和 `vue-tsc --noEmit` 当前通过；主负责人提供的统一入口最新 39/39 结果包含既有 dist bundle budget，不是新 release 构建验收，Rust command red 仍单列。原生 WYS pending 公式场景待隔离 launcher 新 scenario 验证。
## 2026-09-08 继续实施的独立验证记录

当前仍未完成全部恢复计划，不能发布。普通文件、大文件和草稿的 Windows 文件事务测试，本次主负责人在隔离临时目录权限下独立运行 `cargo test --locked --offline --lib --quiet`，84 通过、0 失败（0.59 秒；该时间仅为测试运行时间，不是产品性能基线）。同一测试在受限沙箱中为 76 通过、8 失败，失败包含 `ReplaceFileW` 的 `0x80070005` 拒绝访问；该权限对照不计作已修复产品缺陷。测试可执行文件 SHA256 为 `3E7BCDA9595654DCB4A53538EF1B8A5B528C8B2ED1DC459316F028648684DA17`。保留编译器的 5 项未使用字段/方法警告，未通过屏蔽警告制造通过。

恢复文件的 v3 编解码和 NodeView 注册首片已有补丁，实际 Windows WYS 恢复仍待验收。主负责人拒绝运行会默认连接任意 9333 活动页并清空文档的新探针，已要求接入拥有独立进程、profile、nonce 的现有隔离启动器。脚本存在或构建通过不代表恢复交互通过。

### WP09 控件样式增量验证

主负责人独立运行 `check-wp09-style-scope` 与 `check-app-dialog-keyboard`，通过。前者实际调用已安装 Vue `compileStyle`，追加 EditorShell 后主负责人再运行 8/8 通过；后者仍是 MiniNode 事件模型。两者不等于最终统一检查。

随后在独立 Vite 1423 / IAB 页面、1200×780 视口、新未命名源码文档 `#    Token audit\n\nabc   \n` 中打开真实格式化弹窗并观察浅深画面。以下是浏览器最终 computed style 与据此计算的对比，不是整套可访问性合格声明：

| 项目 | 实际值 / 结果 |
| --- | --- |
| 浅色主按钮 | 白字 / `rgb(63,111,159)`，13px，5.269:1 |
| 深色主按钮 | `rgb(17,19,24)` / `rgb(120,166,211)`，13px，7.250:1（此前已观察约 2.541:1） |
| 深色取消按钮 | `rgb(242,244,247)` / `rgb(39,42,49)`，13.038:1；没有浅色白底遗留 |
| 键盘焦点 | Shift+Tab 到取消按钮，实际 `2px solid` accent outline；深色最终 3px 半透明外圈。真实截图可见 |
| 取消操作 | 浅色空格、深色 Enter 均显示“已取消格式化”，源码各行仍为 `['#    Token audit','','abc   ','']`；LM-016 的原错误未再出现 |
| 设置弹窗与最小窗口 | 深色设置画面已观察；900×600 下检查中发生 HMR，页面重新加载且临时状态丢失，不能计为完整通过 |

此阶段无原生文件保存，浏览器仍显示缺少 Tauri invoke 的配置/草稿错误，未外推为桌面故障。IAB 页面已关闭、视口已 reset，拥有的 Vite 服务已停止。最终固定 Windows 构建还需覆盖三档缩放、完整键盘顺序、禁用/错误/选中态及核心编辑区样式。

### 原生恢复探针：失败发生在测试准备阶段

主负责人在隔离数据权限下执行 `node scripts/qa/isolated-native-evidence.mjs --launch --scenario recovery-bundle`，结果为退出码 1。证据目录 `C:/Users/dell/AppData/Local/Temp/lightmark-native-qa-jPSXBC`，identifier 为 `com.lightmark.qa.1788859050276159e6b28`。运行于 2026-09-08 09:17:30–09:18:21 UTC，使用 Tauri debug 与 Vite 开发构建；实际错误为 `timed out waiting for initial editor instance`。

此时尚未进入恢复内容、未失焦局部输入或 Footnotes 挂载断言，不能记为这些产品路径通过或失败。主负责人核对原夹具 SHA-256 仍为 `5549099A5CD8ED57B83C4EDB429976D9B74970F8772CBD8F2A7E98CE4F354182`；拥有的应用进程已关闭，53348/53349 无监听。失败日志和隔离配置保留。后续修正探针必须从真实已挂载 Tiptap 实例确认文档身份，区分 Transition 中的旧视图，不能通过强行重新加载正文掩盖产品生命周期错误。

### 本次增量检查与待验证边界

主负责人另行运行 `check-source-piece-adapter`、`check-recovery-codec-v3`、`check-large-editor-logic` 和正式 `qa/check-html-security-regression`，均返回 0。它们分别证明真实 PM 事务下的独立映射模块、恢复编解码、纯文本投影以及 renderer 输出过滤的既有断言；没有完成 WYS 映射接入、完整历史恢复、大文件组件保存或完整桌面权限验收。

代码审查新增的验证要求已派给对应 Luna：大文件跨行列号和 emoji 代理对边界；保存已写盘但后续 stat/配置失败时的回执归属；仅空白未命名文档的恢复草稿；大文件草稿两阶段清理失败；恢复提示期间新输入的版本校验。上述暂为代码证据，不虚报为实际复现。

WP08 当前只有夹具与报告模块，尚未采集可用于发布判定的真实性能样本。主负责人要求修正冷/热启动混组、重复样本凑数、测量口径混算、逐轮正确性覆盖和缺少构建证据仍判可比的问题；本阶段只报告中位数/P95/最大值，不用 10 次启动声称稳定 P99。统计逻辑的合成数据测试不属于性能基线。

### 恢复首片的生命周期失败证据

主负责人阅读了 Luna 后续实际运行 `lightmark-native-qa-kAgPae` 的 manifest。该次运行于 2026-09-08 09:46 UTC，identifier `com.lightmark.qa.1788860763352b8153f34`，实际到达 `recovery:before-restore`：目标是未命名文档、content 长度 0、PM 为一个空 paragraph、revision 为 0、无 pending、session 与 Tiptap 实例对应且过渡已结束；但目标 tab 的 dirty 为 true，恢复的空白目标检查因此拒绝导入。该失败来自真实 WebView 的恢复探针，仍需用普通文档的新建/切页任务分离测试构造影响。

相关代码有两处值得共同验证：WYS `onUpdate` 与 session 注册仍从动态 pane 取 tab，可能让旧组件回调改动新标签；`createUntitledTab` 则直接投影新标签，未等待原编辑器快照，且同 pane 的 `setActivePane` 会直接返回。新建前的输入是否被丢失尚未复现，不能把 dirty 异常扩大为已确认内容丢失。修复分别由 WYS 与 store 的唯一写入代理负责；验收须覆盖 A→新建→A、分屏、模式切换和另存。

专用恢复还存在明确容量限制：v3 首片的 local registry/buffer 上限为 512，超过时保留编辑窗口并报告捕获不完整。该行为比截断数据安全，但仍不满足所有合法文档都有完整恢复出口的目标。WP05 最终验收需将恶意导入的资源限制与可信运行时恢复捕获分开，覆盖公式密集文档；不能通过删掉缓冲或提高常数后未经测量宣称完整。

### 原生恢复推进与 LM004 局部快照缺口

主负责人核对 Luna 的 `C:/Users/dell/AppData/Local/Temp/lightmark-native-qa-8yhNoJ/manifest.json`。运行创建于 2026-09-08 10:02:35 UTC，identifier 为 `com.lightmark.qa.1788861755602424e58d9`，使用独立 Tauri debug/Vite 开发环境。恢复 probe 执行了 capture→restore→recapture、非空/dirty 空文档拒绝、原文 `abc` 与 PM `abcd` 映射拒绝、Footnotes 原生 DOM 安全哨兵及 513 个 NodeView 的容量分支。原夹具 SHA-256 经主负责人重新读取，仍为 `5549099A5CD8ED57B83C4EDB429976D9B74970F8772CBD8F2A7E98CE4F354182`。

整体 manifest 为 failed，原因是普通 `snapshotDocumentTab` 漏掉保持焦点的 FrontMatter/Footnotes 局部输入：`pendingBeforeSnapshot: false`，快照保留 accepted 内容，编辑框仍保留 draft；两例均未发生 blur。这是实际原生 NodeView 与生产 runtime 的证据，但本版用 `setContent` 构造 PM 节点并手工更新 dirty，尚不是从正常 Markdown 打开开始的完整用户路径。后续必须使用独立 phase、真实 Markdown 解析及自然 input 事件复验，不能靠手工 markDirty 关闭 LM004。owned-window-destroy 是测试清理，不算正常关闭验收。

主负责人再次独立运行 `check-save-transaction`、`check-performance-measurement` 和 `vue-tsc --noEmit`，均返回 0。性能模块产生的 1,820 个样本是合成数据逻辑检查（目录 `lightmark-perf-measurement-W9FJc1`），不是实际应用耗时。WP08 新 bridge 尚在审查，计时观察点、会话所有权和各正确性字段必须与实际证据一致。

### 统一入口与设置键盘检查

2026-09-08 10:07:16–10:07:43 UTC，主负责人独立运行 `node scripts/check-all.mjs`，结果 48/50，证据为 `C:/Users/dell/AppData/Local/Temp/lightmark-check-all-CA5ltC`。两项失败是 `check-performance.mjs` 与 `check-regression-closures.mjs` 的 callback 定位正则不支持 `editor: updatedEditor` 参数别名；失败发生在非空匹配保护，未把空匹配误当通过。已派 Luna 校准提取方式并保留原断言。本次包含既有 dist 的 bundle 检查，工作区仍在实施中，不是固定 release 产物验收。受限沙箱此前拒绝启动子进程的 EPERM 结果单列为环境失败。

主负责人在独立 IAB `127.0.0.1:1425`、900×600 CSS 视口（DOM 实测 DPR 约 1）观察设置弹窗完整显示，未见整体水平溢出。通过实际按键复现：打开偏好设置，初始焦点为 `tabindex=-1` 的 dialog panel；按 Shift+Tab，焦点离开仍打开的弹窗进入背后的 CM 编辑区。重新打开后，在 WYS 背景下得到同样结果；第二次 Shift+Tab 才回到末尾输入框。`useOverlayFocus` 对 panel 本身未覆盖反向 Tab 边界，代码与行为对应，按 LM016 的模态键盘专项追加修复。此证据仍是浏览器开发环境，不代表原生缩放或系统键盘验收。
