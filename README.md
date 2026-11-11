# LightMark

LightMark 是一款轻量级 Markdown 桌面编辑器，基于 Tauri 2 + Rust + Vue 3 + TypeScript + Vite + Tailwind CSS 构建，目标是在保持第一版小巧、稳定、易扩展的前提下，提供接近 Typora/Obsidian 的写作体验。

当前正在执行恢复计划，尚未通过 Windows 发布验收。以下功能列表描述已有实现，具体通过范围、已知问题与未验证项目以 [当前实施状态](docs/audit/implementation-status.md) 为准。

## 功能特性

- 三栏桌面布局：工作区文件树、编辑器、文档大纲。
- 打开本地文件夹作为工作区，递归扫描 `.md` / `.markdown` 文件。
- 直接在磁盘上打开、编辑、创建、保存 Markdown 文件。
- 编辑器模式：
  - **所见即所得模式**（WYSIWYG）：基于 Tiptap，实时渲染 Markdown 语法标记。
  - **源码模式**（Source）：基于 CodeMirror 6，支持语法高亮和行号。
  - **大文件模式**：文件大小达到 5 MiB（5,242,880 字节）时自动进入分块加载与块级文本编辑。
- Markdown 语法支持：
  - 完整基础语法：标题 H1-H6、粗体、斜体、行内代码、删除线、链接、图片、引用块、有序/无序列表、表格、分割线。
  - 扩展语法：高亮 `==text==`、上标 `^text^`、下标 `~text~`、任务列表 `- [ ]`、脚注 `[^id]`、定义列表、Emoji 短代码 `:smile:`、自动链接 、目录 `[TOC]`。
  - GitHub 风格警示框：`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`。
  - YAML Front Matter 编辑支持。
  - 内联 HTML 和块级 HTML（经过安全过滤）。
- 数学公式：行内/块级 KaTeX 实时预览与编辑，`\` 触发 LaTeX 命令自动补全（13 个分类、约 500 条符号/模板）。
- Mermaid 图表：代码块内实时 SVG 预览与编辑。
- 代码块语法高亮：基于 `highlight.js` / `lowlight`。
- 图片处理：支持剪贴板粘贴、拖拽插入，自动保存到文档同级的 `assets/` 目录。
- 导出：支持自包含 HTML、原生 PDF、PNG，以及安装 Pandoc 后的 DOCX、LaTeX、EPUB 等格式；导出前会显示公式兼容、降级或阻止状态。
- 右键上下文菜单：支持格式设置、表格操作、GitHub 警示框插入、剪贴板操作、复制为 HTML。
- 命令面板：`Ctrl+Shift+P` 打开，模糊搜索命令。
- 主题：亮色 / 暗色 / 跟随系统三种模式；组件配色与键盘焦点的一致性正在验收。
- 前端插件接口：内置字数统计插件（状态栏 + 详情面板）。
- 最近文件、主题、上次工作区持久化保存在 Tauri 应用配置目录。
- 多标签页、左右分屏、会话恢复、外部文件监听与保存冲突保护。
- Wiki Links、反向链接、未链接提及、标签与工作区全文索引。
- 保存快捷键 `Ctrl+S`。
- 侧边栏可拖拽调整宽度。
- 脏状态追踪、保存和关闭时的未保存内容处理。

## 技术栈

- 桌面框架：Tauri 2
- 后端：Rust
- 前端：Vue 3 + TypeScript + Vite
- 包管理器：pnpm
- 样式：Tailwind CSS
- 富文本编辑器：Tiptap 3
- 源码编辑器：CodeMirror 6
- Markdown 渲染：`markdown-it`
- 语法高亮：`highlight.js` + `lowlight`
- 图表：Mermaid
- 数学：KaTeX
- HTML 转 Markdown：Turndown

可视化编辑使用 Tiptap，同时保留原始 Markdown 顶层语法范围；生成快照时仅序列化变更的结构区间，未编辑块继续使用原文。

## 安装

```bash
pnpm install
```

Tauri 还需要 Rust 工具链和 Tauri 文档中列出的各平台 WebView 依赖。

## 开发

```bash
pnpm tauri dev
```

仅前端开发：

```bash
pnpm dev
```

## 构建

```bash
pnpm tauri build
```

前端类型检查与打包：

```bash
pnpm build
```

## 当前 MVP 限制

- 可视化模式对未编辑顶层块保留原文；块内精确保真及映射失败后的专用恢复文件正在接入。保存或模式切换遇到映射失败时，应保留当前编辑窗口；目前不能保证切换源码或普通另存能绕过同一映射失败。
- 当前公开编辑模式为所见即所得与源码；独立预览组件尚未接入应用模式入口。
- 插件系统目前仅运行在前端内存中，未做沙箱隔离。
- Pandoc 目标需要系统已安装 Pandoc；不同目标对公式、Mermaid 和本地资源的支持程度不同。
- 达到 5 MiB 的文档进入分块大文件模式，不提供完整可视化编辑。
- 移动/重命名时的跨文档链接批量重写仍在完善中。

## 验收与已知限制

当前发布验收状态、复现步骤和自动化证据见 [恢复计划实施状态](docs/audit/implementation-status.md)；[审计报告](docs/audit/lightmark-audit.md) 与 [恢复计划](docs/audit/lightmark-recovery-plan.md) 保留原始审计结论和目标。此前的 [验收矩阵](docs/acceptance-matrix.md) 与 [2026-09-06 变更摘要](docs/release-notes-2026-09-06.md) 属于历史记录，不能替代当前构建验收。
