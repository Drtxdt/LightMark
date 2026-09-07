# LightMark 实施状态

更新时间：2026-09-07。

本文记录批准计划的实施状态。`lightmark-audit.md` 与 `lightmark-recovery-plan.md` 是审计原文归档，保留原审计时间、证据状态和未修复结论；本文不回写或改写两份归档。

## WP01 / WP02 / WP05A / WP06 / WP09 状态（2026-09-07）

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
