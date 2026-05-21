# LightMark

LightMark is a lightweight Markdown desktop editor MVP built with Tauri 2, Rust, Vue 3, TypeScript, Vite, and Tailwind CSS. It targets a Typora/Obsidian-like writing workflow while keeping the first version small, stable, and easy to extend.

## Features

- Three-pane desktop layout: workspace file tree, editor, and document outline.
- Open local folders as workspaces and scan nested `.md` / `.markdown` files.
- Open, edit, create, and save Markdown files directly on disk.
- Editor modes:
  - WYSIWYG mode powered by Tiptap.
  - Source mode powered by CodeMirror 6.
  - Preview mode powered by `markdown-it`.
- Markdown preview with code highlighting, Mermaid code block rendering, and KaTeX formula support.
- Export current document to a complete HTML file.
- Recent files, theme, and last workspace saved in the Tauri app config directory.
- Command palette with `Ctrl+Shift+P`.
- Save shortcut with `Ctrl+S`.
- Light, dark, and system theme modes.
- Minimal frontend plugin interface with a built-in word count plugin.

## Tech Stack

- Desktop: Tauri 2
- Backend: Rust
- Frontend: Vue 3 + TypeScript + Vite
- Package manager: pnpm
- Styling: Tailwind CSS
- Rich text editor: Tiptap
- Source editor: CodeMirror 6
- Markdown rendering: `markdown-it`
- Syntax highlighting: `highlight.js`
- Diagrams: Mermaid
- Math: KaTeX via `markdown-it-katex`

`markdown-it` was chosen for the MVP because it is fast to integrate, has a simple plugin model, and works well with direct HTML export. A future release can add a remark/unified pipeline if deeper AST transformations become necessary.

## Install

```bash
pnpm install
```

Tauri also requires the Rust toolchain and the platform-specific WebView dependencies documented by Tauri.

## Development

```bash
pnpm tauri dev
```

Frontend-only development:

```bash
pnpm dev
```

## Build

```bash
pnpm tauri build
```

Frontend type-check and bundle:

```bash
pnpm build
```

## Current MVP Limits

- WYSIWYG Markdown round-tripping uses HTML-to-Markdown conversion, so some complex Markdown formatting may normalize when edited in rich text mode.
- The plugin system runs only in frontend memory.
- PDF, DOCX, and PPTX export are reserved as TODOs.
- File conflict detection and external file change watching are not implemented yet.
- LaTeX is supported in preview/export through KaTeX, but no dedicated equation editing UI is included.

## Roadmap

- Improve Markdown round-trip fidelity.
- Add file watcher and conflict resolution.
- Add tabbed documents.
- Expand plugin APIs and support sandboxed JS/WASM plugins.
- Add PDF, DOCX, and PPTX export.
- Add settings UI and keyboard shortcut customization.
- Add optional AI extension points without adding cloud dependencies to the core app.
