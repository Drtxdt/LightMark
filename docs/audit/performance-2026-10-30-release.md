# 2026-10-30 Windows release 性能证据与未收敛项

本轮完整采样、正确性和证据门槛通过；**流畅度及整轮发布验收尚未完成**。报告仍标记 baseline review pending。WYS 50,000 段落头部 Enter 的 P95 接近一秒，最后进程树 private bytes 超过 4.5GB，不能把报告门槛通过解释为这些性能问题已解决。真实显示呈现未测，未使用 Computer Use，真实 IME 按用户要求跳过。

## 固定输入与原始证据

- 最终 run：`.cache/performance-release-smoke/lightmark-performance-release-oFOTmm`；构建标识 `release-12fe8c9c3ff2-b9bfe3602a9c7522`，QA bridge 独立编译开启，普通 frontend 已检查不含 QA bridge。
- 338 个源码、脚本及已有文档的采样前后内容列表完全一致：`.cache/performance-20261030-c/source-before.json` 与 `source-after-full.json`（stable=true）。排序列表的规范 JSON SHA-256：`df7f4f943833937edeb1ff1892eb1dd7e98c526cf6ffd8865fe84df1be4d3df4`。本文是采样后新增审计，不属于该冻结列表。
- QA executable SHA-256：`b9bfe3602a9c7522c31f450cd43e1a4aa3a6d082c1f916548bc01c3eca1ecb45`；QA frontend：`fbb5a171d1347c98643599bea435c1a3feec226b4d909f168724abb9e021fa3c`。
- 原始 report：`.cache/performance-release-smoke/lightmark-performance-release-oFOTmm/output/performance-report.json`，SHA-256 `fbaef5d05b9b66ffc4df6c17e55c5fb74ce787e06cf9678d53d3deac6f73e102`。
- 逐操作 NDJSON：`.cache/performance-release-smoke/lightmark-performance-release-oFOTmm/output/raw-samples.ndjson`，SHA-256 `ce163e30521d5f36476ffad7fab3f4a13800904d6c08ab2d8805f14b06166926`，与 report 声明相同。事件、正确性详情与清理回执位于同目录 `performance-events.json`。
- 按负载分开的模型、DOM、rAF、命令、long task 和内存汇总：`.cache/performance-20261030-c/final-summary.json`。生成脚本 `summarize-final.mjs` 只读取原始证据，未替换原报告。
- 20 次启动（新 profile / 同 profile 重启各 10），13 个交互组，每组 3×100：共 **3920 个正式样本全部 OK、39/39 正确性通过**，无 missing/duplicate/failed。额外 600 次滚动预热未计入样本。
- 应用正常 exit 0，拥有的 CDP 端口已关闭。报告 `diagnosticOnly=false`，三项门槛全通过，`validForPerformanceComparison=true`；P99 不报告。

机器：Windows 11 Home China，13th Gen Intel(R) Core(TM) i9-13900HX，32 逻辑核，物理内存 34029125632B，WebView2 Edg/156.0.4314.50，Node v24.18.0，Rust rustc 1.94.1 (e408947bf 2026-03-25)，视口 1200×780，devicePixelRatio=1.5。新 profile 冷启动不代表清空 Windows 文件缓存。

## 分阶段实测

以下每个交互组均有 300 个正式样本，数值为 **P50 / P95 / 最大值，单位 ms**。模型发布是 documentRuntime revision 回调；DOM 是 MutationObserver 回调；rAF 是机会边界。它们均不是物理屏幕呈现。滚动的起点是 scroll 事件，不是导航请求，0.0ms 不代表加载或呈现即时；滚动不产生模型内容事务，其模型/DOM值保持未观测。

| 负载 | 事件→模型发布 | 事件→DOM observer | 事件→rAF 机会 | Long task 条目数 / 最大ms |
|---|---:|---:|---:|---:|
| 普通 Source 输入 | 1.4 / 1.8 / 11.7 | 1.6 / 2.1 / 12.0 | 2.8 / 3.8 / 13.6 | 0 / 未观测 |
| 6MiB Source 滚动 | 未观测 / 未观测 / 未观测 | 未观测 / 未观测 / 未观测 | 0.0 / 0.1 / 0.1 | 0 / 未观测 |
| 公式密集 WYS 输入 | 8.7 / 11.1 / 19.7 | 8.8 / 11.1 / 20.0 | 9.7 / 12.1 / 21.4 | 0 / 未观测 |
| 公式密集 WYS Ctrl+Enter 提交 | 369.5 / 420.6 / 479.2 | 467.8 / 538.7 / 608.0 | 469.4 / 540.4 / 609.5 | 300 / 609.0 |
| 表格密集 WYS 输入 | 11.5 / 14.6 / 16.6 | 11.7 / 14.8 / 16.9 | 12.8 / 16.0 / 18.6 | 0 / 未观测 |
| 图片密集 WYS 滚动 | 未观测 / 未观测 / 未观测 | 未观测 / 未观测 / 未观测 | 0.0 / 0.1 / 0.2 | 0 / 未观测 |
| 长行 Source 输入 | 7.0 / 11.6 / 20.5 | 7.3 / 11.8 / 20.7 | 8.6 / 13.1 / 24.3 | 0 / 未观测 |
| Source 50k 头部 Enter | 4.5 / 6.3 / 90.3 | 4.6 / 6.5 / 90.4 | 5.9 / 7.9 / 93.7 | 4 / 86.0 |
| Source 50k 头部 Backspace | 73.5 / 90.6 / 118.0 | 73.8 / 90.7 / 118.1 | 83.5 / 100.4 / 119.3 | 300 / 118.0 |
| Source 50k 多范围编辑 | 85.9 / 101.8 / 110.9 | 87.0 / 103.1 / 111.9 | 96.4 / 113.1 / 133.7 | 300 / 132.0 |
| WYS 50k 头部 Enter | 829.8 / 973.4 / 1164.9 | 830.0 / 973.5 / 1165.4 | 830.7 / 974.1 / 1166.4 | 599 / 1166.0 |
| WYS 50k 头部 Backspace | 218.6 / 824.3 / 1018.9 | 218.7 / 824.4 / 1019.1 | 235.3 / 825.3 / 1020.4 | 410 / 1020.0 |
| WYS 50k 多范围编辑 | 166.2 / 215.6 / 2014.5 | 167.0 / 216.7 / 2016.3 | 184.3 / 240.3 / 2017.9 | 600 / 2019.0 |

Long task 观察对 3900 个交互样本均可用；邻接或重叠区间可能记录同一条 long task，条目数不能解释为去重的 OS 停顿数。失败样本本轮为零；此前失败 run 继续保留。每组仅首样本/每轮做一次 compositor PNG readback，读回与时钟 RPC 的上界独立记录，不能替代呈现观测，也不能以这三个读回样本声称稳定 P95。

同步多范围命令单独列出，不能与输入/绘制延迟混称。WYS 单键的 applyTransaction 模型计算也独立保留；例如 50k Enter 模型计算 P95 约 0.2ms，而模型发布/输入反馈 P95 仍约 974ms。

| 同步命令 | 命令总耗时 P50/P95/max | 模型计算 P50/P95/max | 其余同步 dispatch P50/P95/max |
|---|---:|---:|---:|
| Source 50k 多范围编辑 | 86.9 / 103.0 / 111.9 | 63.6 / 74.7 / 82.0 | 23.0 / 28.2 / 36.8 |
| WYS 50k 多范围编辑 | 167.0 / 216.7 / 2016.3 | 111.0 / 137.4 / 390.3 | 55.5 / 75.0 / 1894.8 |

| 进程请求→编辑器就绪 | 样本 | P50 / P95 / max ms |
|---|---:|---:|
| cold-new-profile | 10 | 2099.5 / 2257.0 / 2257.0 |
| warm-restart | 10 | 2103.6 / 2209.7 / 2209.7 |

## 公式提交修复与实际内存

新加入真实 mounted block NodeView 的提交组：在非计时准备阶段通过 NodeView mousedown 打开其 textarea、触发真实 input 写入新 TeX；计时由 CDP Ctrl+Enter 进入生产 keydown/commit 路径。逐样本核对模型 TeX 完全相等、编辑框关闭、KaTeX 存在；每轮另做正式 snapshot、undo/redo、reset、语法/选区/原磁盘哈希比对。没有使用直接 setNodeMarkup 模拟公式提交。

它先暴露了两个真实生产缺陷：

1. 等价 PM root 重建后，ProseMirror 可复用 NodeView 且不调用 update；旧严格对象身份使正常提交误报 MathEditConflictError。现在仍检查 getPos、类型、视图状态与既有冲突，仅允许完整 Node.eq 基线相等。真实 inline/block 红绿回归另覆盖不同 raw attrs、marks 和类型必须拒绝且不 dispatch。
2. 旧 WeakMap<doc, full evaluation> 会被历史持有的不可变 doc 保留。实际夹具 2460 个公式，一次完整评估约 7.3M 字符 HTML；OMjf7B 公式第 100/200 次后 JS heap 为 2,261,399,541 / 3,302,122,872B，在第 262 次 renderer 消失并超时。失败、进程内存和 raw 数据保留。

修复为 editor-keyed 单个 latest doc/numbering 缓存；旧历史 root 按需重新评估，不保留每版完整渲染索引。settings/tools 在全局通知前只清一次，再由同一 editor 的各 NodeView 复用。缓存 weak-key 不阻止已释放 editor 回收，取消订阅的 NodeView 不再保留刷新回调。目标回归执行真实数学评估，保留 300 个 root 但只有一个 editor 缓存槽；撤销/重做宏与编号结果保持完全一致，settings/tools/第二 editor 独立性也有覆盖。

诊断压力 run `qmTjWE`：300/300 公式提交和 3/3 历史正确性通过，第 100/200/300 次后 heap 为 **132,631,244 / 251,754,714 / 212,166,326B**，无强制 GC、无扩堆；应用 exit 0。`--formula-stress` 明确 diagnosticOnly，跳过启动和其余组；即使其他门槛全通过也强制比较资格为 false，已有单测覆盖。它不能替代本次正式 3920 样本。

正式 run 相同三个位置的 heap 为 **181,988,635 / 199,222,318 / 101,303,089B**，公式 OOM 已消除。完整矩阵边界观察到的最大 JS heap 为 1976134135B；进程树边界最大 working set 为 **4658081792B**、private bytes 为 **4531249152B**。这些是采样边界观察值，并非持续跟踪的绝对峰值；working set 可重复计入共享页，不能等同 JS heap。50k WYS 高内存及明显长任务仍待收敛，不能由公式内存修复推断整个编辑器已低内存。

## 包预算与剩余验收

固定普通 frontend 的静态 JS 依赖闭包 gzip（每文件独立 gzip，动态 imports/CSS 不含）：Shell **206.010KiB / 210**，Shell+Source **322.592KiB / 330**，Shell+WYS **604.166KiB / 650**，全部通过。详细文件 SHA-256 在 `.cache/performance-20261030-c/bundle-budget.json`。

仍需处理/验收：WYS 50k 大 DOM 输入及视图更新、公式密集提交约半秒的长任务、最后 WYS 进程树高内存、正式性能基线审查、无额外探针对照与长期循环释放；物理显示呈现、用户暂缓的 Windows GUI/缩放/焦点完整矩阵以及完整正式安装生命周期另按总交接记录跟踪。此处的大文件滚动夹具是 6MiB，不能替代 500MiB 前端 GUI 验收；此前实际 50/100/500MiB 后端验证也不据此升级为前端界面验收。全部约定验收完成前，整轮计划保持未完成。

失败来源继续保留：`0G6Ccq`（旧 50k 多范围源码映射失败）、`tCKaQL`/`j9u77H`（真实公式提交误冲突）、`OMjf7B`（公式评估缓存 OOM），均在 `.cache/performance-release-smoke`。修复后短 smoke `YWe5Bl` 13/13 正确性通过但统计资格不足；诊断 `qmTjWE` 明确 ineligible；仅最终 `oFOTmm` 达到本次完整采样资格。
