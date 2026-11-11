# LightMark 正式版四轮审查 · 2026-11-11

**发布决定：No-Go。** LightMark 已经值得继续做成桌面产品。当前不能把它交给用户作为唯一的笔记编辑器：一次成功的可视化替换就能把未搜索的公式从磁盘上删掉，而应用随后显示“已保存”。扩大语法覆盖或重写编辑器都排在这件事之后。

交付物：[1.0 路线图与发布门槛](roadmap-1.0-2026-11-11.md) · [本轮结果与样本哈希](evidence/2026-11-11-baseline.json) · [可重跑的模型、工作区及配置探针](evidence/2026-11-11-writing-probe.mjs)。

以上决定和下文描述的是修复前的基线。C1–C5 的后续改动、已验证的平台和仍未通过的发布门槛见[首批修复与验收](release-implementation-2026-11-11.md)。

## 审查对象与判据

审的是本机 **Windows 工作树**。起点 `12fe8c9c3ff2aea5f4925ced26532be30b697a66`，开始时有 81 个已修改文件和 134 个未跟踪文件；仅检出这个提交不能复原本次被审软件。按结果 JSON 中的筛选规则比对 166 个产品源码、配置和依赖清单，其路径及 SHA-256 与 10 月 30 日候选包清单一致。这给历史测量提供了参照，不能当作今天重测了性能或重新验收了安装器。

| 公开实践 | 在这次审查中的用法 |
| --- | --- |
| [Google：The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html) | 以每次改动是否提升整体健康度作决定。承认已有的保存事务和编辑器分层；格式、文件长度不单独阻断发布。 |
| [Microsoft ISE：Reviewer Guidance](https://microsoft.github.io/code-with-engineering-playbook/code-reviews/process-guidance/reviewer-guidance/)；[Continuous Integration](https://microsoft.github.io/code-with-engineering-playbook/CI-CD/continuous-integration/) | 第一遍看设计与用户契约；第二遍跟调用链、输入、失败路径与测试。把决定合并的检查写回 PR 流程。 |
| [Meta：缩短代码评审时间](https://engineering.fb.com/2022/11/16/culture/meta-code-review-time-improving/)；[Predictive test selection](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/) | 给变更一个明确的主审，让作者先收到最相关的失败，再跑较慢的整套检查。此项目用简单的按路径分组就足够。 |

下文分 **架构 → 正确性 → 质量 → 产品** 四轮。P0 表示可静默伤及原稿，阻断对外发布；P1 表示正式版承诺、核心工作流或必要防线尚未成立，须修复、拿到验收证据或明确收缩承诺；P2 可进入有负责人的后续清单。证据分“本轮原生实测、生产模块实测、源码风险、历史测量、未验证”。优先级衡量后果，不代替证据强度。

## 第一轮：架构——让正文、编辑器和磁盘各有一个负责人

普通文档在 Tiptap/ProseMirror 和 CodeMirror 之间切换。原始 Markdown 片段与位置映射负责保留用户没改的语法；快照协调器先结算局部输入，再由按文档排队的保存事务交给 Rust，Rust 对磁盘版本和替换结果给回执。大文件另有 Rust 文本会话、修订号和分块确认。**保留这两条路径**：它们解决的是不同规模的问题。[快照协调器](../../src/editor/documentSnapshotCoordinator.ts) · [保存队列](../../src/stores/saveTransaction.ts) · [磁盘替换事务](../../src-tauri/src/commands/file_replace_transaction.rs) · [大文件操作队列](../../src/editor/largeOperationQueue.ts)

| 编号 | 设计判断与证据 | 可分开交付的改进 |
| --- | --- | --- |
| A1 · P1 | “当前活动页”与“动作所属文档”并存。`appStore.ts` 有 5,141 行，`WysiwygEditor.vue` 有 8,114 行；真正的问题是异步结果发给谁、路径取自谁。例：WYS 已按 pane 取正文，但 `renderMarkdownForEditorWithAssets` 解析图片时仍默认取全局活动路径。分屏左右目录各有同名图，是必须验证的场景；本轮未宣称已观察到串图。[渲染调用](../../src/components/editor/WysiwygEditor.vue#L2692) · [路径来源](../../src/utils/imageAssets.ts#L92) | 延续已有 tab/session/revision 身份，给渲染增加显式文档路径，给工作区增加代次。先修有失败样本的接口，每次迁移一个入口。 |
| A2 · P1 | 正文的写盘语义强于外围数据。普通保存有预期指纹和替换回执；附件先选空闲名再 `fs::write`，新建 Markdown 先 `exists` 再写空串，配置直接写最终文件。另一进程在检查与落盘之间创建同名文件时，存在覆盖风险；并发覆盖本轮未实测。[附件](../../src-tauri/src/commands/file.rs#L1896) · [新建](../../src-tauri/src/commands/file.rs#L2197) · [配置](../../src-tauri/src/commands/config.rs#L23) | 把“只创建”“可替换既有输出”“不得写回输入源”做成三类后端接口。新建用原子排他创建，碰撞重试；配置同目录暂存、替换、保留上一份。不要一律复用最昂贵的正文事务。 |
| A3 · P1 | 本地 Markdown、WebView 和本地文件之间的授权范围过宽。当前发行配置 `csp: null`、asset scope 为 `["**"]`；自定义导出资源读取接收路径，函数内只判定是否为文件，未见对这次文档已授权资源的校验。已有 HTML 过滤和部分原生回归有价值；它们不证明整个桌面权限边界。[配置](../../src-tauri/tauri.conf.json#L23) · [资源读取](../../src-tauri/src/commands/export.rs#L16) · [既有 WP10 设计](wp10-desktop-content-boundary-design.md) | 为当前文档及用户明确选择的资源建立授权；发行 CSP 按实际脚本、字体、worker、图片需求收敛。用正常的本地图片、公式、Mermaid 与应拒绝的资源做矩阵。本结论来自防御性代码审查，未断言已发生越权。参照 [Tauri CSP](https://v2.tauri.app/security/csp/) 与 [Capabilities](https://v2.tauri.app/security/capabilities/)。 |

建议的边界是：**编辑器适配器**拥有光标、组合输入和局部缓冲；**文档会话**拥有正文版本、历史、目标路径及快照；**Rust 文件服务**拥有磁盘身份、授权和提交结果；**Vue 视图**订阅状态、提交带目标的用户意图。现有代码已部分做到。没有证据支持撤掉 Vue、Tauri 或 Tiptap 后从零再写。

## 第二轮：正确性——五个有可检验后果的问题

**C1 · P0 · 可视化替换吞掉行内公式，已在 Windows 原生窗口保存到磁盘。** 在独立测试配置打开包含 `L$x$R` 的原生 Markdown 文件；可访问性树分别显示 `L`、数学节点、`R`。用查找面板搜 `LR`，实际为 `1/1`，预期零个连续正文匹配。将它替换成 `X` 后按 Ctrl+S，应用显示“已保存”。磁盘上该段变为 `X`，样本从 31 字节变成 27 字节，前后 SHA-256 见[结果记录](evidence/2026-11-11-baseline.json)。独立 ProseMirror 测试还发现，**只搜公式右侧的 R**，换成 X，也会连公式一起删掉。它们是同一位置映射缺陷的两种表现。

根因：展平文本时略过非文本节点，两侧文字在搜索串里变成相邻；共享端点又总映到前一段末尾。替换直接使用这组位置构造事务。修复应保留不可跨越的节点边界，按起、终点方向映射，允许跨纯样式 mark，不允许吞掉 atom 或硬换行。验收要看节点、实际文件、一次撤销/重做和另一处合法匹配，不能只数结果。[展平与端点映射](../../src/editor/wysiwygFind.ts#L159) · [实际替换](../../src/components/editor/WysiwygEditor.vue#L5705)

**C2 · P0 · Windows CLI 的“不能覆盖源文件”判定依赖路径拼法。** 用候选 CLI、同一个临时源文件和故意不存在的测试配置做无写入对照。指定同一文件的普通 Windows 绝对路径时，带覆盖选项的导出继续到配置校验；指定同一文件的规范路径时，立即因“不能覆盖源 Markdown”被拒绝。两次都退出 2，错误阶段不同，输入哈希未变。输入先 canonicalize，输出只转绝对路径，两者直接比较；下游显式输出允许覆盖时也不再检查源文件身份。因此**已证实的是保护失效**，本轮没有执行破坏性导出。GUI 选择输出也应在同一后端边界检查，不能从 CLI 对照推断 GUI 已发生覆盖。[CLI 顺序](../../src-tauri/src/bin/lightmark-cli.rs#L175) · [路径比较](../../src-tauri/src/bin/lightmark-cli.rs#L389) · [最终写入](../../src-tauri/src/commands/export.rs#L275) · [后端路径选择](../../src-tauri/src/commands/export.rs#L544)

修复：既有文件按文件身份比较，缺失目标验证父目录及名称，提交前再次检查；`--force` 只允许替换其他输出文件。对正常不同输出、相对/绝对/大小写拼法、同一文件的不同名称都要做正反对照，输入字节始终不变。

**C3 · P1 · 不区分大小写时可能替换另一个字符。** 普通 WYS 生产查找插件加真实 ProseMirror 事务，`AİBC!` 搜 `B` 换 `X`，预期 `AİXC!`，实得 `AİBX!`，替换了 C。当前环境中 `İ` 小写化后占两个 UTF-16 单元，算法直接拿转换后索引去切原文。应从能返回原串匹配范围的搜索器取位置，或显式维护折叠文本到原文的映射；加入组合字符、emoji 以及单次/全部替换的独立预期。源码模式用的是另一查找路径，本轮不把这个结果外推给它。[字面量查找](../../src/utils/findReplace.ts#L59) · [独立预期与生产插件样本](evidence/2026-11-11-writing-probe.mjs)

**C4 · P1 · 工作区 B 可以展示 A 的文件树。** 对生产 `openWorkspace` 控制 IPC 返回顺序：A 的读目录暂缓，打开 B，确认 B 显示 `b.md`，再返回 A 的结果。最终工作区仍是 B，第一项却成了 `a.md`。不涉及用户磁盘，也没断言已写错文件；侧栏入口指向错误目录已在 store 复现。`refreshFileTree` 等待返回后直接赋值；同文件的 watcher 刷新反而有身份核验。统一入口，捕获根目录及递增代次；过期的成功、错误、索引和监听回执都应丢弃。补 A→B→A、慢失败及旧标签仍可写作的对照。[无保护的赋值](../../src/stores/appStore.ts#L981) · [已有保护可复用](../../src/stores/appStore.ts#L1085)

**C5 · P1 · 读取既有配置失败会主动写回默认配置。** 在真实 store、内存 IPC 中让 `read_app_config` 失败，观察到一次 `write_app_config`，预期为零。`loadConfig().finally(ensureDefaultTab)` 新建默认标签；`createUntitledTab` 会持久化，Rust 直接写 `config.json`。若上次的文件暂时读不到或截断，原始设置、最近文件和会话有被覆盖的风险；这不是正文已丢失的证据。区分“首次无文件”和“既有文件读坏”，后者只在内存中启动、保留坏文件和上次好副本。测试读错后编辑一份新笔记也不应悄悄覆盖原配置。[启动](../../src/stores/appStore.ts#L930) · [隐式写回](../../src/stores/appStore.ts#L3113) · [Rust 配置 I/O](../../src-tauri/src/commands/config.rs#L11)

待验证的相邻路径：窗口关闭保护在等待工作区监听与启动草稿处理之后才注册；恢复提示或 I/O 很慢时，应验证启动阶段的输入、关闭和取消。[启动顺序](../../src/App.vue#L96) · [关闭监听](../../src/App.vue#L161)。它是风险，不与上面五项混记成已复现的数据损失。

## 第三轮：质量——这套绿灯能回答什么

| 本轮运行 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `pnpm build` | 类型检查、Vite 生产构建、体积检查通过；Shell / +Source / +WYS 静态 JS gzip 为 **206.0 / 322.6 / 604.2 KiB** | 当前依赖下能构建前端，且在 210/330/650 KiB 预算内。不是安装、输入延迟或内存指标。 |
| `node scripts/check-all.mjs` | 默认托管 TEMP **93/94**；换到工作区内普通 TEMP/TMP，失败项单跑通过，随后完整 **94/94** | 默认失败在 `check-wp10-content-boundary.mjs:44` 的夹具路径前缀比较；同一代码只更换临时目录即改变结果。此检查明确未调用原生资源读取，不能解释为产品权限通过或失败。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline` | Rust 库 **123 通过，0 失败，1 ignored**；CLI bin 自身 **0** 个单测 | 有真实事务/大文件等后端覆盖。被忽略的是另行运行的物理尺寸矩阵，本轮未跑；CLI 的旧集成证据仍然有效，不等于没有 CLI 测试。 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 退出 1，18 个 Rust 文件有格式差异 | 只反映可读性/机器检查债。用独立格式 PR 或增量棘轮处理，不淹没数据缺陷的修复 diff。 |
| 本轮附加探针及原生任务 | 7 个逻辑观察中 2 个对照正确、5 个与预期不符；C1 另有真实 WebView2 → Rust → 磁盘证据 | 附加探针没有算入 94。原生为当前开发构建、独立配置；启动器早期两次环境失败不计产品失败。最终窗口在记录 C1 后正常退出；未作安装、物理键盘 IME 或完整桌面验收。 |

在仓库根目录用 Node 24 运行 `node docs/audit/evidence/2026-11-11-writing-probe.mjs` 可重放新增的 7 项逻辑观察。当前预期退出 1，输出逐项列出期望与实际；修复后应退出 0。脚本的文件 I/O 限于编译缓存，配置和工作区 IPC 为内存替身。原生保存则是另一次独立验证。

**Q1 · P1：已有回归脚本，仓库里看不到强制执行它们的 PR 流水线。** 未发现版本化的 GitHub Actions、GitLab CI、Azure Pipelines 等常见入口；未核验托管平台外部任务或分支保护。另有 118 个未跟踪文件就在 `src/`、`src-tauri/`、`scripts/` 中。第一步是保存一个可复现的候选源清单、以干净检出重建，再接 required checks；不要把当前改动一次性压成无法评审的大 PR。[检查入口](../../scripts/check-all.mjs) · [分类](../../scripts/qa/check-catalog.mjs)

**Q2 · P1：部分测试能验证实现自洽，却发现不了用户内容损坏。** 既有 WYS 查找用 300 次确定性事务比对增量结果，这对索引更新有价值；但 schema 只容许纯文本，期望结果又调用生产 `findTextMatches`。C1 不可能出现在该语料中，C3 的错误可同时发生在两边。保留该测试，再加用手写原文/节点/预期磁盘字节作判据的测试。类似地，目录把未特别列出的脚本默认归为 `state-logic`；有些主要检查源码或接线，数量不能代替用户任务覆盖。[测试 schema 和判据](../../scripts/check-wysiwyg-find.mjs#L32)

**Q3 · P1：已有可信测量，尚无可信的“轻量且流畅”承诺。** 10 月 30 日 release QA 的 3,920 个样本和 39 项正确性检查均通过。普通源码输入 P95 3.8 ms、表格密集 WYS 输入 16.0 ms；另一方面，50,000 段 WYS 在头部 Enter/Backspace 的事件到 rAF P95 是 **974.1/825.3 ms**，公式密集提交是 **540.4 ms**。观察到的进程树 private bytes 达 **4,531,249,152 B**。这些是特定夹具、采样边界与硬件的数据；既不能描述普通笔记都慢，也不是物理呈现时间。先按“字节数 × 段落/公式密度”划出承诺区间，再选择优化或有说明的源码回退。[原始口径及分组表](performance-2026-10-30-release.md)

## 第四轮：产品——按写作者的任务验收

Typora 的官方 [Quick Start](https://support.typora.io/Quick-Start/) 把实时可视化编辑放在核心，[Markdown Reference](https://support.typora.io/Markdown-Reference/) 说明语法边界，[Shortcut Keys](https://support.typora.io/Shortcut-Keys/) 和 [Auto Save](https://support.typora.io/Auto-Save/) 则给出打开文件及保存行为的用户预期。以这些为参照，LightMark 最有竞争力的 1.0 是**可靠的本地中文 Markdown 编辑器，保留普通文本的可迁移性**。不必在 1.0 复刻竞品全部功能。

| 用户想完成的事 | 现在的体验/证据 | 正式版验收 |
| --- | --- | --- |
| 从资源管理器或键盘直接开始写 | 本轮用命令面板和系统文件对话框成功打开样本。已有工具栏和 Ctrl+P；未见裸 Ctrl+O 打开文件、安装器声明 Markdown 文件关联或 GUI 消费普通文件路径的入口。输入“打开文件”在命令面板第一项仍是“快速打开文件”。[快捷键](../../src/App.vue#L120) · [命令](../../src/components/command/CommandPalette.vue) · [打包配置](../../src-tauri/tauri.conf.json#L30) | P1：Ctrl+O、精确命令优先；“打开方式”在冷启动和已有实例各验一次，不争抢系统默认。Ctrl+N 创建不需要先选工作区的空白稿。 |
| 混写中文、公式、代码和表格，再回源码 | 已有可编辑公式、源码映射、连续历史和七类 NodeView 历史原生证据；C1 表明“看起来可编辑”仍不等于原稿安全。真实中文 IME、原生文本/HTML/图片剪贴板及安装版组合路径未在本轮验证。[上次原生交接](handoff-2026-10-30.md) | P0/P1：按字节验证未编辑部分；候选期间保存、离焦、切页、切模式、撤销后都保持预期正文。至少一台真实 Windows 中文输入法机器。 |
| 新笔记崩溃后找回多篇草稿 | 设置清楚写明自动保存到私有草稿；默认关闭，默认间隔 5 分钟。正常受保护关闭会尝试留草稿，突然终止没有同样保证。启动时只挑一个未命名或大文件草稿提示。[设置](../../src/components/settings/SettingsDialog.vue#L297) · [默认值](../../src/stores/appStore.ts#L4218) · [挑选草稿](../../src/stores/draftStore.ts#L159) | P1：区分“已写原文件”“恢复草稿已写”“保存失败”；恢复入口列全、能预览并恢复成新文件，不自动覆盖原文。给突然断进程规定可测的恢复点目标。 |
| 带走格式一致的文章 | 历史正式 CLI 8 项及 HTML/PDF/PNG 实际输出有证据；GUI 输出、无 Pandoc 的退路、同源保护 C2 和最终安装版是另一层。[正式 CLI 复核](release-non-ui-2026-10-30.md) | P1：核心承诺列 HTML/PDF；PNG 和 Pandoc 目标按实测分级。检查文字能读取、图片不丢、公式/中文分页、末页未裁切，失败时原稿与既有输出保持完整。 |
| 在自己的 Windows 机器安装、升级、卸载 | 已有 NSIS 产物；本轮对 10 月 30 日该安装器验证哈希，Authenticode 为 `NotSigned`。历史 manifest 的 `nativeAcceptance` 是 `not-run`。开发窗口真实保存不能给安装器背书。[发布验收矩阵](windows-release-acceptance.md) | P1：选定并公布 Windows 支持范围及签名发行渠道；新装和旧版覆盖升级、留存配置/草稿、卸载后笔记完整，均用拟发布的同一个包验证。 |

小成本可用性改进：中文主界面的入口 HTML 仍是 [`lang="en"`](../../index.html#L2)；应按实际界面语言标注，再用讲述人、键盘、900×600、缩放 100%–200%、明暗主题验证真实任务。前端只见错误文字或图标不等于用户知道如何救回内容。

**处置顺序：** 先让 C1、C2 的保护通过并进入 PR；随后关闭 C3–C5、A3 和启动恢复风险，完成中文原生写作闭环。若密集 WYS 达不到预算，可以带明确、经验证的源码降级发布；若还能无提示损坏原稿，不能用“已知限制”放行。具体依赖、负责人角色、阶段退出条件与延期安排见[路线图](roadmap-1.0-2026-11-11.md)。
