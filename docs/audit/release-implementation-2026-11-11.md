# LightMark 1.0 首批修复与验收 · 2026-11-11

**结论：四轮审查中可复现的五个正确性问题 C1–C5，在本次 Windows 候选源码上均已修复并回归。可以继续下一批开发，仍不建议作为 1.0 发布。** 本轮保护了原稿、导出目标与配置文件，也让工具链能在没有旧构建产物的目录中独立验证。文件授权、崩溃恢复、真实输入法、性能和安装升级仍有各自的发布门槛。

[修复前的四轮审查](release-review-2026-11-11.md) · [长期路线图](roadmap-1.0-2026-11-11.md) · [机器可读的完整回执](evidence/2026-11-11-implementation.json)

| 编号 | 用户此前会遇到什么 | 新行为与验收 |
| --- | --- | --- |
| C1 · P0 | 对 `L$x$R` 搜 `LR` 或只替换右侧 `R`，都可能把行内公式删掉；保存能把错误写入磁盘。 | 可视化查找会在公式、图片和硬换行处截断，粗体等仅改变样式的文字仍可连续搜索。原生面板对 `LR` 显示 `0/0`，点击全部替换无变化；只将 `R` 改为 `Z` 得到 `L$x$Z`。撤销、重做、真实保存、关闭标签重开后均只有一个公式节点，磁盘字节符合手写预期。 |
| C2 · P0 | CLI 对同一个文件的不同 Windows 路径写法会得出不同的“可覆盖”结论，后端也没有统一保护。 | 桌面和 CLI 共用文件身份比较。四种路径对照（普通、长路径、硬链接、默认 Markdown 输出）均拒绝把原件选作目标。渲染器写到目标同目录下的私有暂存区，再复核原稿和既有目标身份，并按“创建”或“覆盖已选文件”提交。正常新建、显式覆盖另一文件、拒绝未授权覆盖都通过；让真正的 Pandoc 失败，先前的 HTML 仍逐字节相同。 |
| C3 · P1 | 不区分大小写搜索 `AİBC!` 中的 `b`，会错改后一个字符 `C`。 | 在原串上匹配，直接使用 UTF-16 原文位置。原生面板“全部替换”得到 `AİQC!`；撤销和重做保留正确字符。覆盖组合字符、emoji、补充平面字母、中文邻接、区分大小写和字面量正则元字符。 |
| C4 · P1 | 先打开慢的 A，再打开 B；晚到的 A 文件树盖到 B 标题下。再次回到 A，仅比较路径也不足以区别两次会话。 | 每次选择工作区都改变代次；文件树、索引、标签和监听的异步结果只交给所属工作区。用可控延迟检查 A→B→A 的旧树、旧标签、旧错误和旧监听事件。原生窗口中三次打开分别得到索引代次 1、2、3；在最后的 A 从应用外创建 `watched.md`，无需手动刷新即可看到。 |
| C5 · P1 | 读取坏配置失败时，启动逻辑仍会开一张空白页，并请求用默认配置写盘。 | 只有原配置读完、会话初始化成功才开放持久化；失败时可编辑、保存文档，设置界面解释为何本次更改仅在内存中。配置写入顺序与用户操作一致；Rust 同目录暂存、同步、替换，保留 `config.previous.json`。损坏主文件、备份不能写、主文件缺失而备份仍在，均不会用默认值覆盖。原生坏配置测试中，写作、切换目录、保存及重开均成功，退出后那 35 字节原配置保持原样。 |

实现入口：[文档查找分段](../../src/editor/wysiwygFind.ts) 和[原文匹配](../../src/utils/findReplace.ts)；[输出文件身份及提交规则](../../src-tauri/src/export_destination.rs)；[工作区与设置状态](../../src/stores/appStore.ts)和[配置持久化](../../src-tauri/src/commands/config.rs)。这些改动保留了既有的文档会话和保存事务。

## 如何知道这批改动有效

| 验证 | 结果 | 能说明什么 |
| --- | --- | --- |
| 同一份原审查探针在修复前/后运行 | 修复前 7 项中 5 红，修复后 7/7 绿。新增状态测试另行覆盖延迟、乱序、写入失败和原有存档。 | 可直接比较原来失败的行为。不是用新实现自己生成预期答案。 |
| 本机与独立源码副本 | 两边均通过类型检查、生产构建、包体预算和 **95/95** 仓库检查。独立副本重新按锁文件安装依赖，两个 `dist` 目录逐文件摘要相同。 | 构建不靠本工作区原有的 `node_modules`、`dist`，默认 Windows TEMP 的旧夹具失败已修；路径断言仍拒绝边界外文件。 |
| Rust / CLI | 原生 Windows 上 **129 个库测试 + 1 个 CLI 测试通过**。独立副本从空的 Cargo target 构建得到同一结果。大文件物理矩阵 1 项按既有定义忽略。 | 覆盖真正的硬链接、临时文件、配置备份及目标替换；没有把沙箱拒绝文件操作当成产品缺陷，也没有放松硬链接测试来换绿灯。 |
| GUI 与发行模式 CLI 各走一遍 | Windows WebView2 测试窗口真实保存重开，桌面导出入口产生 HTML/PDF/PNG；新编译的发行模式 CLI 单独完成 **10 项**，包括实际生成 HTML、PDF、PNG、DOCX 和失败时保留旧文件。 | GUI 查找走已挂载的面板与按钮；导出走应用接口与真实渲染器。此轮没有人工点 Windows“另存为”对话框、没有模拟真人 IME 验收，也没有安装到日常配置。 |

另外复核了桌面导出的长文：Poppler 渲染的 **5 页 A4** 都已查看，文本抽取按顺序得到样本全部 **100 段**。首页能看到中文、行内公式、表格、本地示例图和代码，末页保留结束标记。PNG 也有末句；在这一张 **900 × 4921** 的长图里，最后一行之后约 **581 px** 没有明显内容。把它记作导出排版问题：需对比测量容器和实际浏览器的布局，测试不同字体和图片；不宜直接按固定像素裁图，尤其不能因此裁掉浅色图或用户留白。这份样本不能代表所有主题、字库或所有导出格式。

## 可重跑与交接

首批验收在本机完成。后续已将 Windows 工作流纳入主分支，PR 和推送到 `main` 都会触发检查。Node 24.18.0、pnpm 10.32.1 和 Rust 1.94.1 分别固定版本。前端先跑可视化查找回归，再构建生产包、运行全套检查。Rust 在独立作业中运行。原生窗口操作另行验收。[工作流](../../.github/workflows/windows-pr.yml) · [GitHub 主分支运行记录](https://github.com/Drtxdt/LightMark/actions/workflows/windows-pr.yml?query=branch%3Amain)

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm check:all
cargo test --manifest-path src-tauri/Cargo.toml --locked
node docs/audit/evidence/2026-11-11-writing-probe.mjs
node scripts/qa/isolated-native-evidence.mjs --launch --scenario find-integrity
node scripts/qa/isolated-native-evidence.mjs --launch --scenario workspace-profile
node scripts/qa/isolated-native-evidence.mjs --launch --scenario export-document
node scripts/qa/isolated-native-evidence.mjs --launch --scenario split-images
node scripts/qa/isolated-native-evidence.mjs --launch --scenario normal-document
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --features tauri/custom-protocol --bins
node scripts/qa/cli-export-integrity.mjs
```

这次实际的 Rust 构建和测试加了 `--offline`，依赖已在本机注册表缓存中。原生用例要求 Windows/WebView2；CLI 的四格式用例另需可用的 Edge/Chrome 和 Pandoc。测试只使用新建的配置和合成笔记。配置坏时，建议先退出应用、复制整个配置目录；若有可解析的 `config.previous.json`，保留损坏文件的副本后，可复制上一份到 `config.json` 再启动。它保存的是设置与会话，不是未保存的笔记正文。

首次审查时工作区已有尚未提交的改动。本机归档 `.cache/formal-acceptance-2026-11-11/lightmark-tested-source.zip` 含当时验证的 349 个源码和测试文件，SHA-256 为 `774b460286b0c02b01fba2a6dfeda29940e1c52a1e330e7d1fffe1cf75b71942`。原有代码已核对快照后提交至 `c79b5c4`，随后的修复可从主分支历史逐项检出。

## 主分支后续修复与验收

| 改动 | 可复核的结果 |
| --- | --- |
| `fe43655` 同名新建和粘贴（A2） | Windows 上 12 份同名粘贴均有不同的目标，读回每份内容与各自输入相符。对同一明确指定的笔记名并发发起 12 次创建，只有一次成功。自动命名可重试，已有文件的内容保留。 |
| `c17b740`、`fc0c752` 分屏资源及笔记移动（A1） | 左右两篇笔记都写 `![封面](cover.svg)`。恢复分屏时真实图片宽度分别为 13、29 像素。将左栏重新定位到第三个目录后宽度变为 37，右栏仍为 29，快照与原稿逐字节相同，两栏均保持已保存。图片后的新段落与图片之间有一个空行，撤销后恢复原字节。另有 Windows 测试覆盖内容不同但大小相同的移动候选。 |
| `8b321b1` 本地图片导出授权（A3 的导出入口） | 目录外的图片须单独选择或授权资源目录。共享目录授权仅对该笔记和本次启动有效，CLI 可重复传入 `--resource-root`。14 项发行模式 CLI 用例通过，覆盖拒绝授权时保留已有 HTML、授权后嵌入正确字节和拒绝伪装成图片的文件。独立打开笔记时核对了原生目录选择器标题与范围。成功授权的端到端验收使用 CLI。 |
| `30d968e`、`e8c690e` 托管回归 | 首次 GitHub Windows 作业发现键盘测试从系统临时目录解析不到 Vue。测试移入该次检出的模块目录后，前端与 Rust 作业均通过。[修复后的托管记录](https://github.com/Drtxdt/LightMark/actions/runs/42985623698) |

本批源码在 Windows 上通过生产构建、包体预算、95 项仓库检查和 136 个 Rust 测试（135 个库测试、1 个 CLI 测试）。另在隔离的 WebView2 窗口完成了常规写作的 75 个检查步骤，包含撤销、跨标签操作、节点编辑和连续保存。物理大文件矩阵由独立的性能验收运行，本批未计入。[分屏原生用例](../../scripts/qa/native-split-images.mjs) · [常规写作原生用例](../../scripts/qa/native-normal-document-probe.mjs) · [发行版 CLI 用例](../../scripts/qa/cli-export-integrity.mjs)

## 下一批工作

1. **桌面资源授权。** 收窄 WebView 的通用 asset scope 和生产 CSP，分别验收相对图片、公式、Mermaid、worker 与离线导出。Pandoc 自行读取的外部资源要单独核对。
2. **恢复与日常写作。** 用多份草稿、意外退出和外部文件更改验证恢复。在真实中文输入法中验收组字、候选选择、切换模式和保存。通过资源管理器打开笔记后，核对原稿与最后一次写入回执。
3. **性能与安装升级。** 在代表性 Windows 设备重测大文档输入延迟、模式切换和峰值内存。最终签名包须通过新装、升级、卸载和回退。独立开发与多人协作的排期以及各阶段放行标准见[长期路线图](roadmap-1.0-2026-11-11.md)。
