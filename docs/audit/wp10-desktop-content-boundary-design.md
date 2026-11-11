# WP10 桌面内容边界：验证与收敛设计

2026-09-08，主负责人设计。此文不是安全验收结果；尚未完成下面的生产 WebView 路径验证。已有 forged-math HTML 修复不能证明所有内容入口安全。

## 当前证据与边界

`src-tauri/tauri.conf.json` 仍配置 `csp: null` 与全局 asset scope；`html.ts` 已有标签、属性、协议和样式过滤。iframe 可以进入内容渲染，未提供 sandbox 时不会自动补充，提供时允许脚本与 same-origin 等组合。`imageAssets.ts` 支持远程、data/blob、asset/file 和本地相对引用。上述是代码证据，不等于已复现越权。

Tauri 的 CSP 需要显式配置，构建时为应用代码补充 nonce/hash；应按应用实际依赖收敛，不能复制示例后仅以构建通过验收。[Tauri CSP](https://v2.tauri.app/security/csp/)

Tauri 的 asset scope 控制文件向 WebView 的暴露范围；能力配置还需要与自定义命令实现一起检查，不能把当前 capability 文件视为全部文件权限的证明。[Asset protocol scope](https://v2.tauri.app/security/asset-protocol/)、[Capabilities](https://v2.tauri.app/security/capabilities/)

安装的 `tauri-2.11.2/src/manager/webview.rs` 将 Tauri 核心初始化脚本标记为 `for_main_frame_only: true`；因此不能仅看到 iframe 可以运行网页脚本，就推断它已经获得 Tauri IPC。安装的 `wry-0.55.1` 将实际消息来源 URL 传入 IPC handler。后续必须区分 iframe 自身、父页面、顶层导航和应用命令的来源判定，并以本地无害哨兵验证实际链路。这是现有防护的代码证据，仍不是权限链运行验收。

主负责人进一步核查安装的 `tauri-2.11.2/src/webview/mod.rs`：`on_message` 校验 invoke key；非本地来源即使调用应用自定义命令，也必须有匹配的 ACL。不能因为应用未配置自定义命令权限清单，就宣称任意远程页面可直接调用文件命令。内置 asset 协议在 pending WebView 上单独注册，不能直接等同应用注册的自定义协议白名单；其导航来源与实际命令拒绝行为仍由原生探针确认。

## 先建立实际攻击路径与合法内容对照

所有资源放在本次拥有的隔离目录。创建一个允许引用的资源根和一个禁止访问的邻接测试目录，均为测试数据。远程行为使用独立 loopback fixture 服务模拟，不访问外部站点或真实私人文件。启动器固定进程、profile、nonce、页面身份；默认不得连接任意已有 CDP 页面。

| 路径 | 测试材料与判定 |
| --- | --- |
| Markdown → WYS / 大文件渲染 | onerror、SVG、恶意标签和属性混淆、HTML entities、内部节点标记；观察 DOM、脚本哨兵、实际请求 |
| HTML 粘贴 → PM DOMParser → NodeView | 重点是 Footnotes 与其他可携带 raw HTML 的节点；直接测试生产 parser 与挂载，不只测试 sanitizer 字符串 |
| 专用恢复文件 → schema → NodeView | 合法内容保留、事件不执行、坏结构拒绝且当前会话不变；原始恶意字节作为数据保存不能被误当作可执行 DOM |
| iframe | 未给 sandbox、显式脚本与 same-origin、重定向、frame 内导航、父页面访问和 IPC 尝试；记录 WebView 实际来源，不能用浏览器 SOP 推断原生权限 |
| 图片 / 视频 / 链接 | 合法同目录、父目录相对图片、绝对本地引用、远程/data/blob、编码路径、路径穿越、符号链接或 Windows junction；权限拒绝要可见且保留原文 |
| 主窗口 / iframe / 新窗口导航 | 检查是否离开应用来源、是否携带应用 IPC、外部链接是否按已支持交互打开；不得在测试中连接非测试域名 |
| 导出 | HTML、PDF、PNG 的真实渲染及本地资源装载；导出准备流程通过不等于输出隔离通过 |

每个探针先有会触发的独立阳性对照，再通过产品入口观察。哨兵不得访问真实笔记或执行危险系统操作。CSP 违例、拒绝读取、脚本未执行、资源未加载分别记录，不把任何一个当作全部链路证明。

## 改动顺序与兼容性裁定

1. 修复实际可复现的渲染入口缺口，原始 Markdown 仍按保真契约保存。恢复导入不扩大可渲染标签或 IPC 权限。
2. 按发布构建实际的脚本、worker、KaTeX 字体、Mermaid、图片及媒体资源需求设计 CSP。开发 HMR 与发布策略分别验证，保留 nonce/hash 注入；不得以放开任意脚本来源或 unsafe-eval 消除报错。
3. 验证命令来源与文件授权。资源解析应携带文档身份，范围不因当前 pane 切换而漂移。路径校验需针对解析后的实际目标及 junction，而非仅检查字符串前缀。
4. 基于兼容对照提出 asset scope 的最小可行收敛方式。现有父目录/绝对图片、远程 iframe 若受限制，先列具体受影响任务、限制与可用恢复入口，请主负责人裁定是否需要用户产品选择；不得直接删掉功能。
5. 渲染过滤、CSP/能力配置、文件授权各独立交付与回退。已证明的漏洞不能为了兼容性回退到已知不安全状态。

本轮没有用户批准取消远程 iframe 或本地绝对引用；也没有批准用全局信任目录绕过所有检查。功能保留与权限收敛的取舍需由实际测试确定。

## 验收与性能

固定 Windows 发布构建复核上述矩阵，并绑定提交、未提交 diff/源文件哈希、构建哈希、WebView2 版本及隔离 fixture 哈希。默认运行不得开启探针或 CDP。公式、图片、导出、查找、模式切换的合法任务同时复验。

安全处理放在解析、渲染、资源与 IPC 边界，不引入每键全篇扫描。测量大量图片及 HTML 文档的解析、输入、滚动和内存；当前没有经测量批准的额外耗时预算。

本包范围 M～L，存在平台来源、iframe 兼容和路径授权的不确定性。未实际执行的项标为未验证；如发现可越权执行或资源访问，阻止发布。
