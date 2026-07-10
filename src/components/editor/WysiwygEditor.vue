<script setup lang="ts">
import { computed, ref, onBeforeUnmount, onMounted, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import { Extension, Mark, mergeAttributes, Node, wrappingInputRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { openUrl } from "@tauri-apps/plugin-opener";
import TurndownService from "turndown";
import { all, createLowlight } from "lowlight";
import { AllSelection, NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { DOMSerializer } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  appStore,
  consumePanePendingEditorPosition,
  getPaneContent,
  getPaneDocumentMode,
  getPaneEditorMode,
  getPanePendingModeCursor,
  getPaneTab,
  openWikiLink,
  setPaneContent,
  setPanePendingModeCursor,
  updatePanePosition,
} from "../../stores/appStore";
import { findOptions, findReplaceStore, setFindResult } from "../../stores/findReplaceStore";
import { findTextMatches, normalizeMatchIndex, replacementForMatch, type TextMatch } from "../../utils/findReplace";
import { renderMarkdownForEditor } from "../../utils/markdown";
import { buildEditorPositionSnapshot, scrollTopFromSnapshot } from "../../utils/editorPosition";
import { parseWikiLinkHref, wikiLinkMarkdown } from "../../utils/wikiLinks";
import { containsInlineHtml, decodeHtmlEntities, renderInlineMarkdownInHtml, sanitizeHtmlFragment, sanitizeInlineHtmlSource } from "../../utils/html";
import { markdownPipeRowToTableHtml } from "../../utils/tableMarkdown";
import {
  getImageFilesFromClipboard,
  getImageFilesFromDrop,
  imagePathsAsMarkdown,
  markdownImageSourceFromElement,
  resolveMarkdownImageSource,
  resolveRenderedImageSources,
  saveImagesAsMarkdown,
} from "../../utils/imageAssets";
import { MarkdownHeading } from "../../extensions/MarkdownHeading";
import { BlockMath, InlineMath } from "../../extensions/MathNodes";
import { InlineHtmlNode, RawHtmlNode } from "../../extensions/InlineHtmlNode";
import { MermaidNode } from "../../extensions/MermaidNode";
import type { EditorPaneId } from "../../types";
import UiIcon from "../ui/UiIcon.vue";

const props = withDefaults(defineProps<{ paneId?: EditorPaneId }>(), {
  paneId: "main",
});

const lowlight = createLowlight(all);

type ContextMenuMode = "default" | "code";
type ImageInsertDetail = { files?: File[]; paths?: string[]; position?: { x?: number; y?: number } };
type ToolbarEditorCommand =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "blockquote"
  | "orderedList"
  | "bulletList"
  | "taskList"
  | "heading"
  | "image"
  | "alert";
type ToolbarEditorCommandDetail = { command?: ToolbarEditorCommand; value?: string | number | null };
type EditorFindMatch = TextMatch & { docFrom: number; docTo: number };

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  mode: "default" as ContextMenuMode,
  inTable: false,
  flipX: false,
  flipY: false,
});
const editorShell = ref<HTMLElement | null>(null);
const codeLanguageInput = ref<HTMLInputElement | null>(null);
const codeLanguageControl = ref({
  visible: false,
  open: false,
  x: 0,
  y: 0,
  pos: -1,
  language: "",
  query: "",
  highlightedIndex: 0,
});
const tableControl = ref({
  visible: false,
  resizeOpen: false,
  moreOpen: false,
  x: 0,
  y: 0,
  tablePos: -1,
  activeColumn: -1,
  rows: 0,
  columns: 0,
  resizeText: "",
  resizeError: "",
});
const savedSelection = ref<{ from: number; to: number } | null>(null);
const linkUrl = ref("");
const canUseTableMenu = computed(() => contextMenu.value.inTable && contextMenu.value.mode !== "code");
const paneTab = computed(() => getPaneTab(props.paneId));
const paneContent = computed(() => getPaneContent(props.paneId));
const paneEditorMode = computed(() => getPaneEditorMode(props.paneId));
const paneDocumentMode = computed(() => getPaneDocumentMode(props.paneId));
const floatingCodeLanguageCandidates = computed(() => filterCodeLanguages(codeLanguageControl.value.query));
const typoraInlineMarkNames = ["bold", "italic", "code", "strike", "highlight", "superscript", "subscript", "link"];
const githubAlertKinds = [
  { kind: "note", label: "Note" },
  { kind: "tip", label: "Tip" },
  { kind: "important", label: "Important" },
  { kind: "warning", label: "Warning" },
  { kind: "caution", label: "Caution" },
] as const;
const githubAlertLabels: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};
const codeLanguageItems = [
  { name: "plaintext",   aliases: ["text", "txt", "plain"] },
  { name: "actionscript", aliases: [] },
  { name: "ada",         aliases: [] },
  { name: "apache",      aliases: ["apacheconf"] },
  { name: "applescript", aliases: [] },
  { name: "arduino",     aliases: [] },
  { name: "asciidoc",    aliases: ["adoc"] },
  { name: "autohotkey",  aliases: ["ahk"] },
  { name: "awk",         aliases: [] },
  { name: "basic",       aliases: ["vb"] },
  { name: "bash",        aliases: ["sh", "shell", "zsh"] },
  { name: "c",           aliases: [] },
  { name: "clojure",     aliases: ["clj"] },
  { name: "cmake",       aliases: [] },
  { name: "coffeescript", aliases: ["coffee"] },
  { name: "cpp",         aliases: ["c++", "cc", "cxx"] },
  { name: "crystal",     aliases: ["cr"] },
  { name: "csharp",      aliases: ["cs", "c#"] },
  { name: "css",         aliases: [] },
  { name: "d",           aliases: [] },
  { name: "dart",        aliases: [] },
  { name: "delphi",      aliases: ["pascal", "pas"] },
  { name: "diff",        aliases: ["patch"] },
  { name: "django",      aliases: [] },
  { name: "dockerfile",  aliases: ["docker"] },
  { name: "elixir",      aliases: ["ex", "exs"] },
  { name: "elm",         aliases: [] },
  { name: "erb",         aliases: [] },
  { name: "erlang",      aliases: ["erl"] },
  { name: "fortran",     aliases: ["f", "f90"] },
  { name: "fsharp",      aliases: ["fs"] },
  { name: "gherkin",     aliases: ["feature"] },
  { name: "glsl",        aliases: [] },
  { name: "go",          aliases: ["golang"] },
  { name: "gradle",      aliases: [] },
  { name: "graphql",     aliases: ["gql"] },
  { name: "groovy",      aliases: [] },
  { name: "haml",        aliases: [] },
  { name: "handlebars",  aliases: ["hbs"] },
  { name: "haskell",     aliases: ["hs"] },
  { name: "haxe",        aliases: ["hx"] },
  { name: "html",        aliases: ["htm"] },
  { name: "http",        aliases: [] },
  { name: "ini",         aliases: [] },
  { name: "java",        aliases: [] },
  { name: "javascript",  aliases: ["js", "node"] },
  { name: "json",        aliases: [] },
  { name: "julia",       aliases: ["jl"] },
  { name: "kotlin",      aliases: ["kt"] },
  { name: "latex",       aliases: ["tex"] },
  { name: "less",        aliases: [] },
  { name: "lisp",        aliases: ["elisp", "emacs"] },
  { name: "livescript",  aliases: ["ls"] },
  { name: "lua",         aliases: [] },
  { name: "makefile",    aliases: ["mk", "make"] },
  { name: "markdown",    aliases: ["md"] },
  { name: "mathematica", aliases: ["wl"] },
  { name: "matlab",      aliases: [] },
  { name: "nginx",       aliases: ["nginxconf"] },
  { name: "nim",         aliases: [] },
  { name: "nix",         aliases: [] },
  { name: "objectivec",  aliases: ["objc", "obj-c"] },
  { name: "ocaml",       aliases: ["ml"] },
  { name: "perl",        aliases: ["pl"] },
  { name: "pgsql",       aliases: ["postgresql", "postgres"] },
  { name: "php",         aliases: [] },
  { name: "powershell",  aliases: ["ps", "ps1"] },
  { name: "processing",  aliases: [] },
  { name: "prolog",      aliases: [] },
  { name: "properties",  aliases: ["prop"] },
  { name: "protobuf",    aliases: ["proto"] },
  { name: "puppet",      aliases: ["pp"] },
  { name: "python",      aliases: ["py"] },
  { name: "qml",         aliases: [] },
  { name: "r",           aliases: [] },
  { name: "reasonml",    aliases: ["re"] },
  { name: "ruby",        aliases: ["rb"] },
  { name: "rust",        aliases: ["rs"] },
  { name: "scala",       aliases: [] },
  { name: "scheme",      aliases: [] },
  { name: "scilab",      aliases: [] },
  { name: "scss",        aliases: [] },
  { name: "smalltalk",   aliases: [] },
  { name: "sql",         aliases: [] },
  { name: "stylus",      aliases: ["styl"] },
  { name: "svelte",      aliases: [] },
  { name: "swift",       aliases: [] },
  { name: "tcl",         aliases: [] },
  { name: "thrift",      aliases: [] },
  { name: "toml",        aliases: [] },
  { name: "twig",        aliases: [] },
  { name: "typescript",  aliases: ["ts"] },
  { name: "vala",        aliases: [] },
  { name: "vbnet",       aliases: ["vb.net"] },
  { name: "verilog",     aliases: ["v"] },
  { name: "vhdl",        aliases: [] },
  { name: "vim",         aliases: ["vimscript"] },
  { name: "vue",         aliases: [] },
  { name: "wasm",        aliases: ["wat"] },
  { name: "x86asm",      aliases: ["asm"] },
  { name: "xml",         aliases: [] },
  { name: "xquery",      aliases: ["xq"] },
  { name: "yaml",        aliases: ["yml"] },
  { name: "zig",         aliases: [] },
] as const;
const codeLanguageNames = codeLanguageItems.map((item) => item.name);
const codeLanguageAliases = new Map<string, string>();
codeLanguageItems.forEach((item) => {
  codeLanguageAliases.set(item.name, item.name);
  item.aliases.forEach((alias) => codeLanguageAliases.set(alias, item.name));
});
let pendingWysiwygRestoreTimer: number | null = null;

const TyporaHeading = Heading.extend({
  addInputRules() {
    return [];
  },
});

const TyporaBlockquote = Node.create({
  name: "blockquote",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      alert: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-alert") || null,
        renderHTML: (attributes) => {
          const alert = attributes.alert;
          if (!alert) return {};
          return {
            "data-alert": alert,
            class: `markdown-alert markdown-alert-${alert}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "blockquote" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(HTMLAttributes), 0];
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*>\s$/,
        type: this.type,
        joinPredicate: () => false,
      }),
    ];
  },
});

const GithubAlertInput = Extension.create({
  name: "githubAlertInput",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return convertBlockquoteMarkdown(newState, { force: true });
        },
      }),
    ];
  },
});

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) => {
          return attributes.markdownSrc ? { "data-markdown-src": attributes.markdownSrc } : {};
        },
      },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createTyporaImageView(node, editor, getPos);
  },
});

const HighlightMark = Mark.create({
  name: "highlight",
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
});

const SuperscriptMark = Mark.create({
  name: "superscript",
  parseHTML() {
    return [{ tag: "sup:not([data-footnote-ref])" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes), 0];
  },
});

const SubscriptMark = Mark.create({
  name: "subscript",
  parseHTML() {
    return [{ tag: "sub" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes), 0];
  },
});

const TaskStateMark = Mark.create({
  name: "taskState",
  addAttributes() {
    return {
      state: {
        default: "unchecked",
        parseHTML: (element) => element.getAttribute("data-task-item") || "unchecked",
        renderHTML: (attributes) => ({ "data-task-item": attributes.state }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-task-item]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const checked = HTMLAttributes["data-task-item"] === "checked";
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "task-state" }),
      ["input", { type: "checkbox", checked: checked ? "checked" : null, contenteditable: "false", "data-task-checkbox": "true" }],
      ["span", { class: "task-state-content" }, 0],
    ];
  },
});

const FrontMatterNode = Node.create({
  name: "frontMatter",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      yaml: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-yaml") || element.textContent || "",
        renderHTML: (attributes) => ({
          "data-type": "front-matter",
          "data-yaml": attributes.yaml,
        }),
      },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-type="front-matter"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), HTMLAttributes.yaml || ""];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.contentEditable = "false";
      let yaml = node.attrs.yaml || "";
      let editing = Boolean(node.attrs.editing);

      const updateYaml = () => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { yaml, editing: false }));
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node";
        const pre = document.createElement("pre");
        pre.className = yaml.trim() ? "" : "front-matter-placeholder";
        pre.textContent = yaml.trim() ? yaml : "请输入yaml";
        dom.append(pre);
      };

      const renderEditor = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node front-matter-node-editing";
        const textarea = document.createElement("textarea");
        textarea.className = "front-matter-editor";
        textarea.placeholder = "请输入yaml";
        textarea.value = yaml;
        textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          yaml = textarea.value;
          textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        });
        textarea.addEventListener("blur", () => {
          editing = false;
          updateYaml();
          renderDisplay();
        });
        dom.append(textarea);
        requestAnimationFrame(() => textarea.focus());
      };

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        renderEditor();
      });

      editing ? renderEditor() : renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          yaml = nextNode.attrs.yaml || "";
          editing = Boolean(nextNode.attrs.editing);
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const FrontMatterInput = Extension.create({
  name: "frontMatterInput",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            return convertLeadingFrontMatter(view, event);
          },
        },
      }),
    ];
  },
});

const FencedCodeBlockInput = Extension.create({
  name: "fencedCodeBlockInput",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            return convertFencedCodeBlock(view, event);
          },
        },
      }),
    ];
  },
});

const LightMarkCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    const parentAttributes = this.parent?.() ?? {};
    const languageAttribute = (parentAttributes as Record<string, any>).language ?? {};
    return {
      ...parentAttributes,
      language: {
        ...languageAttribute,
        parseHTML: (element: HTMLElement) => {
          const language = readCodeLanguageFromElement(element);
          return language ? normalizeCodeLanguage(language) || language : null;
        },
      },
    };
  },
});

function isLeadingFrontMatterFence(state: any) {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const firstNode = state.doc.firstChild;
  if (!firstNode || $from.depth !== 1 || $from.before(1) !== 0) return false;
  if ($from.parent !== firstNode || !firstNode.isTextblock) return false;
  if ($from.parentOffset !== firstNode.content.size) return false;
  return firstNode.textContent.trim() === "---";
}

function getFencedCodeLanguage(text: string) {
  const match = text.match(/^```([A-Za-z0-9_+-]*)\s*$/);
  return match ? match[1] : null;
}

function normalizeCodeLanguage(input: string | null | undefined) {
  const value = (input || "").trim().toLowerCase();
  if (!value) return "";
  return codeLanguageAliases.get(value) || "";
}

function displayCodeLanguage(input: string | null | undefined) {
  const value = (input || "").trim();
  return normalizeCodeLanguage(value) || value;
}

function readCodeLanguageFromElement(element: HTMLElement) {
  const code = element.matches("code") ? element : element.querySelector("code");
  const className = code instanceof HTMLElement ? code.className : element.className;
  return className.match(/(?:^|\s)language-([^\s]+)/)?.[1] || element.getAttribute("data-language") || "";
}

function filterCodeLanguages(query: string) {
  const value = query.trim().toLowerCase();
  if (!value) return codeLanguageNames.slice(0, 12);
  const normalized = normalizeCodeLanguage(value);
  const exact = normalized ? [normalized] : [];
  const matches = codeLanguageItems
    .filter((item) => item.name.includes(value) || item.aliases.some((alias) => alias.includes(value)))
    .map((item) => item.name);
  return Array.from(new Set([...exact, ...matches])).slice(0, 12);
}

function convertFencedCodeBlock(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter") return false;
  const { state } = view;
  const { selection, schema } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;

  const language = getFencedCodeLanguage($from.parent.textContent.trim());
  if (language === null) return false;

  const codeBlockType = schema.nodes.codeBlock;
  if (!codeBlockType) return false;

  const from = $from.before();
  const to = $from.after();
  const normalizedLanguage = displayCodeLanguage(language);
  const codeBlock = codeBlockType.create(normalizedLanguage ? { language: normalizedLanguage } : undefined);
  const tr = state.tr.replaceWith(from, to, codeBlock);
  tr.setSelection(TextSelection.create(tr.doc, from + 1));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

function convertLeadingFrontMatter(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter") return false;
  const { state } = view;
  if (!isLeadingFrontMatterFence(state)) return false;

  const { schema } = state;
  const firstNode = state.doc.firstChild;
  const frontMatterType = schema.nodes.frontMatter;
  const paragraphType = schema.nodes.paragraph;
  if (!firstNode || !frontMatterType || !paragraphType) return false;

  const frontMatter = frontMatterType.create({ yaml: "", editing: true });
  const paragraph = paragraphType.create();
  const tr = state.tr.replaceWith(0, firstNode.nodeSize, [frontMatter, paragraph]);
  tr.setSelection(NodeSelection.create(tr.doc, 0));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

const TableOfContentsNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'nav[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["nav", mergeAttributes(HTMLAttributes, { "data-type": "table-of-contents" }), "[TOC]"];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("nav");
      dom.className = "toc-node";
      dom.contentEditable = "false";
      let editing = Boolean(node.attrs.editing);

      const updateAttrs = (nextEditing: boolean) => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { editing: nextEditing }));
      };

      const render = () => {
        dom.className = editing ? "toc-node toc-node-editing" : "toc-node";
        const headings: Array<{ level: number; text: string }> = [];
        editor.state.doc.descendants((node: any) => {
          if (node.type.name === "heading" || node.type.name === "markdownHeading") {
            headings.push({ level: node.attrs.level || 1, text: node.textContent });
          }
          return true;
        });
        dom.innerHTML = "";
        const label = document.createElement("div");
        label.className = "toc-node-label";
        label.textContent = "[TOC]";
        dom.appendChild(label);
        if (editing) {
          const input = document.createElement("input");
          input.className = "toc-node-editor";
          input.value = "[TOC]";
          input.spellcheck = false;
          input.addEventListener("blur", () => {
            window.setTimeout(() => {
              if (document.activeElement === input) return;
              if (input.value.trim().toUpperCase() !== "[TOC]") {
                replaceTocWithText(editor, getPos, input.value);
                return;
              }
              editing = false;
              updateAttrs(false);
              render();
            }, 100);
          });
          dom.appendChild(input);
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
          return;
        }
        headings.forEach((heading) => {
          const item = document.createElement("div");
          item.className = `toc-node-item toc-node-item-${heading.level}`;
          item.textContent = heading.text;
          dom.appendChild(item);
        });
      };
      const refresh = () => {
        if (!editing) render();
      };
      editor.on?.("update", refresh);
      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs(true);
        render();
      });
      render();
      return {
        dom,
        update: (nextNode: any) => {
          editing = Boolean(nextNode.attrs.editing);
          render();
          return true;
        },
        selectNode() {
          editing = true;
          updateAttrs(true);
          render();
        },
        deselectNode() {
          if (!editing) return;
          editing = false;
          updateAttrs(false);
          render();
        },
        destroy() {
          editor.off?.("update", refresh);
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLInputElement,
      };
    };
  },
});

const HtmlBlockNode = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: {
        default: "",
        parseHTML: (element) => sanitizeHtmlFragment(decodeHtmlEntities(element.getAttribute("data-html") || "")),
        renderHTML: (attributes) => ({
          "data-type": "html-block",
          "data-html": sanitizeHtmlFragment(decodeHtmlEntities(attributes.html || "")),
        }),
      },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), HTMLAttributes.html || ""];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.contentEditable = "false";
      let html = sanitizeHtmlFragment(decodeHtmlEntities(node.attrs.html || ""));
      let editing = Boolean(node.attrs.editing);
      let committing = false;

      const updateAttrs = (next: { html?: string; editing?: boolean }) => {
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { html, editing, ...next }));
      };

      const commitEditor = (textarea?: HTMLTextAreaElement) => {
        if (!editing || committing) return;
        committing = true;
        if (textarea) html = textarea.value;
        editing = false;
        html = sanitizeHtmlFragment(html);
        updateAttrs({ html, editing: false });
        renderDisplay();
        window.setTimeout(() => {
          committing = false;
        }, 0);
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "html-block-node";
        const rendered = document.createElement("div");
        rendered.className = "html-block-rendered";
        rendered.innerHTML = renderInlineMarkdownInHtml(html);
        dom.appendChild(rendered);
      };

      const renderEditor = () => {
        dom.innerHTML = "";
        dom.className = "html-block-node html-block-node-editing";
        const label = document.createElement("div");
        label.className = "html-block-label";
        label.textContent = "HTML";
        const textarea = document.createElement("textarea");
        textarea.className = "html-block-editor";
        textarea.value = html;
        textarea.rows = Math.max(3, html.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          html = textarea.value;
          textarea.rows = Math.max(3, html.split(/\r?\n/).length);
        });
        textarea.addEventListener("keydown", (event) => {
          if (event.key !== "Escape" && !(event.key === "Enter" && (event.ctrlKey || event.metaKey))) return;
          event.preventDefault();
          commitEditor(textarea);
        });
        textarea.addEventListener("blur", () => commitEditor(textarea));
        dom.append(label, textarea);
        requestAnimationFrame(() => textarea.focus());
      };

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs({ editing: true });
        renderEditor();
      });

      editing ? renderEditor() : renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          html = sanitizeHtmlFragment(decodeHtmlEntities(nextNode.attrs.html || ""));
          editing = Boolean(nextNode.attrs.editing);
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        selectNode() {
          if (editing) return;
          editing = true;
          updateAttrs({ editing: true });
          renderEditor();
        },
        deselectNode() {
          commitEditor();
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const StrikeMark = Mark.create({
  name: "strike",
  parseHTML() {
    return [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["s", mergeAttributes(HTMLAttributes), 0];
  },
});

const FootnoteRefNode = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  priority: 10000,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-footnote-ref") || "",
        renderHTML: () => ({}),
      },
      index: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-footnote-index") || element.textContent?.replace(/\D/g, "") || "",
        renderHTML: () => ({}),
      },
      refId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-ref-id") || element.querySelector("a")?.getAttribute("id") || "",
        renderHTML: () => ({}),
      },
      preview: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-preview") || "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="footnote-ref"]' }, { tag: "sup[data-footnote-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id || HTMLAttributes.id || "";
    const index = node.attrs.index || HTMLAttributes.index || "";
    const refId = node.attrs.refId || HTMLAttributes.refId || `fnref-${id}-1`;
    const preview = node.attrs.preview || HTMLAttributes.preview || "";
    return [
      "span",
      {
        "data-type": "footnote-ref",
        "data-footnote-ref": id,
        "data-footnote-index": index,
        "data-ref-id": refId,
        "data-preview": preview,
      },
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("sup");
      const id = node.attrs.id || "";
      const index = node.attrs.index || id;
      const refId = node.attrs.refId || `fnref-${id}-1`;
      let editing = false;
      dom.dataset.footnoteRef = id;
      dom.dataset.footnoteIndex = String(index);
      dom.dataset.preview = node.attrs.preview || "";
      dom.contentEditable = "false";
      dom.className = "footnote-ref-node";

      const link = document.createElement("a");
      link.href = `#fn-${id}`;
      link.id = refId;
      link.dataset.footnoteLink = "ref";
      link.title = formatFootnotePreview(node.attrs.preview || id);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) {
          scrollInternalLink(`#fn-${id}`);
          return;
        }
        editing = !editing;
        render();
      });
      dom.addEventListener("dblclick", (event) => {
        event.preventDefault();
        scrollInternalLink(`#fn-${id}`);
      });

      const preview = document.createElement("span");
      preview.className = "footnote-ref-preview";
      preview.innerHTML = renderMarkdownForEditorWithAssets(node.attrs.preview || "");

      const render = () => {
        link.textContent = editing ? `[^${id}]` : `[${index}]`;
        dom.classList.toggle("footnote-ref-node-editing", editing);
      };
      dom.appendChild(link);
      if (node.attrs.preview) dom.appendChild(preview);
      render();
      return { dom, ignoreMutation: () => true };
    };
  },
});

const FootnotesNode = Node.create({
  name: "footnotes",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      markdown: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-markdown") || "",
        renderHTML: (attributes) => ({
          "data-type": "footnotes",
          "data-markdown": attributes.markdown,
        }),
      },
      html: {
        default: "",
        parseHTML: (element) => element.innerHTML || "",
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-type="footnotes"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("section");
      dom.className = "footnotes";
      dom.dataset.type = "footnotes";
      dom.dataset.markdown = node.attrs.markdown || "";
      dom.contentEditable = "false";
      let markdown = node.attrs.markdown || "";
      let fallbackHtml = node.attrs.html || "";
      let frame = 0;
      const render = () => renderFootnotesView(dom, markdown, fallbackHtml);
      const scheduleRender = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          render();
        });
      };
      const refreshAfterMount = () => {
        render();
        scheduleRender();
        window.setTimeout(scheduleRender, 80);
      };
      refreshAfterMount();
      dom.addEventListener("click", (event) => {
        const target = getEventElement(event);
        const link = target?.closest<HTMLAnchorElement>("a[href^='#'],button[data-footnote-target]");
        if (!link) return;
        event.preventDefault();
        const href = link instanceof HTMLButtonElement ? link.dataset.footnoteTarget || "" : link.getAttribute("href") || "";
        scrollInternalLink(href);
      });
      editor.on?.("update", scheduleRender);
      return {
        dom,
        update(nextNode: any) {
          markdown = nextNode.attrs.markdown || "";
          fallbackHtml = nextNode.attrs.html || "";
          dom.dataset.markdown = markdown;
          scheduleRender();
          return true;
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          editor.off?.("update", scheduleRender);
        },
        ignoreMutation: () => true,
      };
    };
  },
});

const TyporaSourceMarkers = Extension.create({
  name: "typoraSourceMarkers",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations = [
              ...createOutlineHeadingDecorations(state),
            ];

            if (state.selection.empty) {
              decorations.push(
                ...createMarkDecorations(state, "bold", "**", "**"),
                ...createMarkDecorations(state, "italic", "*", "*"),
                ...createMarkDecorations(state, "code", "`", "`"),
                ...createMarkDecorations(state, "strike", "~~", "~~"),
                ...createMarkDecorations(state, "highlight", "==", "=="),
                ...createMarkDecorations(state, "superscript", "^", "^"),
                ...createMarkDecorations(state, "subscript", "~", "~"),
                ...createLinkDecorations(state),
                ...createHeadingDecorations(state),
              );
            }

            return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return convertInlineMarkdownSyntax(newState);
        },
      }),
    ];
  },
});

const FindReplaceDecorations = Extension.create({
  name: "findReplaceDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("lightmarkFindReplace"),
        props: {
          decorations(state) {
            if (!findReplaceStore.open || !findReplaceStore.query) return null;
            const matches = collectWysiwygFindMatches(state);
            if (matches.error || matches.items.length === 0) return null;
            const current = normalizeMatchIndex(findReplaceStore.currentIndex, matches.items.length);
            const decorations = matches.items.map((match, index) =>
              Decoration.inline(match.docFrom, match.docTo, {
                class: index === current ? "lm-find-match lm-find-match-current" : "lm-find-match",
              }),
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

const TyporaInlineCode = Extension.create({
  name: "typoraInlineCode",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "`" || event.ctrlKey || event.metaKey || event.altKey) return false;
            if (!convertInlineCodeBeforeCursor(view)) return false;
            event.preventDefault();
            return true;
          },
          handleTextInput: (view, from, to, text) => {
            if (text !== "`") return false;
            return convertInlineCodeBeforeCursor(view);
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return convertInlineCodeSyntax(newState);
        },
      }),
    ];
  },
});

const TyporaHorizontalRule = Node.create({
  name: "horizontalRule",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "hr" }, { tag: 'div[data-type="horizontal-rule"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["hr", mergeAttributes(HTMLAttributes)];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "Enter") return false;

            const { state } = view;
            const { $from, empty } = state.selection;
            if (!empty || !$from.parent.isTextblock) return false;
            if (isLeadingFrontMatterFence(state)) return false;
            if (!/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test($from.parent.textContent)) return false;

            event.preventDefault();
            const from = $from.before();
            const to = $from.after();
            const rule = state.schema.nodes.horizontalRule.create();
            let tr = state.tr.replaceWith(from, to, rule);
            const after = from + rule.nodeSize;
            if (state.schema.nodes.paragraph) {
              tr = tr.insert(after, state.schema.nodes.paragraph.create());
              tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createHorizontalRuleView(Boolean(node.attrs.editing), editor, getPos);
  },
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.escape = (text) => text;

turndown.addRule("horizontalRule", {
  filter: "hr",
  replacement: () => "\n\n---\n\n",
});

turndown.addRule("highlight", {
  filter: "mark",
  replacement: (content) => `==${content}==`,
});

turndown.addRule("strike", {
  filter: ["s", "del"],
  replacement: (content) => `~~${content}~~`,
});

turndown.addRule("superscript", {
  filter: (node) => node.nodeName === "SUP" && !(node instanceof HTMLElement && node.hasAttribute("data-footnote-ref")),
  replacement: (content) => `^${content}^`,
});

turndown.addRule("footnoteRef", {
  filter: (node) =>
    node instanceof HTMLElement &&
    ((node.dataset.type === "footnote-ref" && node.hasAttribute("data-footnote-ref")) || node.hasAttribute("data-footnote-ref")),
  replacement: (_content, node) => {
    const id = node instanceof HTMLElement ? node.dataset.footnoteRef || "" : "";
    return id ? `[^${id}]` : "";
  },
});

turndown.addRule("footnotes", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "footnotes",
  replacement: (_content, node) => {
    const markdown = node instanceof HTMLElement ? node.dataset.markdown || "" : "";
    const source = normalizeFootnoteSource(markdown);
    return source ? `\n\n${source}\n\n` : "";
  },
});

turndown.addRule("subscript", {
  filter: "sub",
  replacement: (content) => `~${content}~`,
});

turndown.addRule("wikiLink", {
  filter: (node) => {
    if (!(node instanceof HTMLElement) || node.nodeName !== "A") return false;
    return Boolean(parseWikiLinkHref(node.getAttribute("href") || ""));
  },
  replacement: (_content, node) => {
    if (!(node instanceof HTMLElement)) return "";
    const target = parseWikiLinkHref(node.getAttribute("href") || "");
    return target ? wikiLinkMarkdown(target) : "";
  },
});

turndown.addRule("taskState", {
  filter: (node) => node instanceof HTMLElement && node.hasAttribute("data-task-item"),
  replacement: (content, node) => {
    const checked = node instanceof HTMLElement && node.dataset.taskItem === "checked";
    const text = content.replace(/^[☐☑]\s*/, "").trim();
    return `${checked ? "[x]" : "[ ]"}${text ? ` ${text}` : ""}`;
  },
});

function normalizeTableAlign(value: unknown): "left" | "center" | "right" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "left" || normalized === "center" || normalized === "right" ? normalized : null;
}

function parseTableCellAlign(element: HTMLElement) {
  return normalizeTableAlign(element.style.textAlign || element.getAttribute("align") || "");
}

function renderTableCellAlign(attributes: Record<string, unknown>) {
  const textAlign = normalizeTableAlign(attributes.textAlign);
  return textAlign ? { style: `text-align: ${textAlign};` } : {};
}

const LightMarkTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null,
        parseHTML: parseTableCellAlign,
        renderHTML: renderTableCellAlign,
      },
    };
  },
});

const LightMarkTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null,
        parseHTML: parseTableCellAlign,
        renderHTML: renderTableCellAlign,
      },
    };
  },
});

turndown.addRule("frontMatter", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "front-matter",
  replacement: (_content, node) => {
    const yaml = node instanceof HTMLElement ? node.dataset.yaml || node.textContent || "" : "";
    return `---\n${yaml.trim()}\n---\n\n`;
  },
});

turndown.addRule("tableOfContents", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "table-of-contents",
  replacement: () => "\n\n[TOC]\n\n",
});

turndown.addRule("githubAlert", {
  filter: (node) => node instanceof HTMLElement && node.nodeName === "BLOCKQUOTE" && Boolean(node.dataset.alert),
  replacement: (_content, node) => {
    if (!(node instanceof HTMLElement)) return "";
    const kind = (node.dataset.alert || "note").toLowerCase();
    const alert = kind.toUpperCase();
    const clone = node.cloneNode(true) as HTMLElement;
    removeGithubAlertTitle(clone, kind);
    const body = serializeGithubAlertBody(clone);
    const quoted = body
      ? body
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n")
      : "";
    return `\n\n> [!${alert}]${quoted ? `\n${quoted}` : ""}\n\n`;
  },
});

function removeGithubAlertTitle(clone: HTMLElement, kind: string) {
  const title = clone.querySelector(".markdown-alert-title");
  if (title) {
    title.remove();
    return;
  }

  const expected = (githubAlertLabels[kind] || kind).toLowerCase();
  const firstElement = Array.from(clone.children).find((child): child is HTMLElement => child instanceof HTMLElement);
  if (!firstElement) return;

  const tag = firstElement.tagName.toLowerCase();
  const text = (firstElement.textContent || "").trim().toLowerCase();
  if (clone.children.length > 1 && (tag === "p" || /^h[1-6]$/.test(tag)) && text === expected) firstElement.remove();
}

function serializeGithubAlertBody(node: HTMLElement) {
  const parts = Array.from(node.childNodes)
    .map((child) => {
      if (child instanceof HTMLElement) return turndown.turndown(child.outerHTML).trim();
      return (child.textContent || "").trim();
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

turndown.addRule("htmlBlock", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "html-block",
  replacement: (_content, node) => {
    const html = node instanceof HTMLElement ? decodeHtmlEntities(node.getAttribute("data-html") || node.textContent || "") : "";
    return `\n\n${sanitizeHtmlFragment(html).trim()}\n\n`;
  },
});

turndown.addRule("inlineHtml", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "inline-html",
  replacement: (_content, node) => {
    const html = node instanceof HTMLElement ? decodeHtmlEntities(node.getAttribute("data-html") || node.textContent || "") : "";
    return sanitizeInlineHtmlSource(html);
  },
});

turndown.addRule("rawHtml", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "raw-html",
  replacement: (_content, node) => {
    return node instanceof HTMLElement ? decodeHtmlEntities(node.getAttribute("data-html") || node.textContent || "") : "";
  },
});

turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
  replacement: (_content, node) => {
    const code = node.firstChild?.textContent || "";
    const className = node.firstChild instanceof HTMLElement ? node.firstChild.className : "";
    const sourceLanguage = className.match(/language-([^\s]+)/)?.[1] || "";
    const language = displayCodeLanguage(sourceLanguage);
    return `\n\n\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
  },
});

turndown.addRule("inlineMath", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "inline-math",
  replacement: (content, node) => {
    const tex = node instanceof HTMLElement ? node.dataset.tex || node.textContent || content || "" : content;
    return `$${tex}$`;
  },
});

turndown.addRule("mermaid", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "mermaid",
  replacement: (content, node) => {
    const code = node instanceof HTMLElement ? node.dataset.code || node.textContent || content || "" : content;
    return `\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\n`;
  },
});

turndown.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    if (!(node instanceof HTMLTableElement)) return "";
    const rows = Array.from(node.rows).map((row) =>
      Array.from(row.cells).map((cell) => normalizeTableCell(cell.textContent || "")),
    );
    if (rows.length === 0) return "";

    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill("")]);
    const header = normalized[0];
    const divider = tableColumnAlignments(node, columnCount).map(markdownTableDividerForAlign);
    const body = normalized.slice(1);
    const lines = [header, divider, ...body].map((row) => `| ${row.join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  },
});

turndown.addRule("blockMath", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "block-math",
  replacement: (content, node) => {
    const tex = node instanceof HTMLElement ? node.dataset.tex || node.textContent || content || "" : content;
    return `\n\n$$\n${tex}\n$$\n\n`;
  },
});

turndown.addRule("image", {
  filter: "img",
  replacement: (_content, node) => {
    if (!(node instanceof HTMLElement)) return "";
    const src = markdownImageSourceFromElement(node).trim();
    if (!src) return "";
    const alt = (node.getAttribute("alt") || "").replace(/]/g, "\\]");
    const title = node.getAttribute("title");
    const markdown = title ? `![${alt}](${src} "${title.replace(/"/g, '\\"')}")` : `![${alt}](${src})`;
    return markdown;
  },
});

function renderMarkdownForEditorWithAssets(markdown: string) {
  return resolveRenderedImageSources(renderMarkdownForEditor(markdown));
}

function createTyporaImageView(node: any, editor: any, getPos: (() => number | undefined) | boolean) {
  const dom = document.createElement("figure");
  const source = document.createElement("input");
  const error = document.createElement("div");
  const image = document.createElement("img");
  let currentNode = node;
  let sourceVisible = Boolean(node.attrs.editing);
  let errorMessage = "";

  dom.className = "typora-image-node";
  dom.contentEditable = "false";
  source.type = "text";
  source.className = "typora-image-source";
  source.spellcheck = false;
  error.className = "typora-image-error";
  image.draggable = false;
  dom.append(source, error, image);

  const markdown = () => imageMarkdownFromAttrs(currentNode.attrs);
  const render = () => {
    if (document.activeElement !== source) source.value = markdown();
    error.textContent = errorMessage;
    image.src = currentNode.attrs.src || "";
    image.alt = currentNode.attrs.alt || "";
    if (currentNode.attrs.title) image.title = currentNode.attrs.title;
    else image.removeAttribute("title");
    dom.classList.toggle("typora-image-node-editing", sourceVisible);
    dom.classList.toggle("typora-image-node-error", Boolean(errorMessage));
  };
  const showSource = (focus = false) => {
    sourceVisible = true;
    render();
    if (focus) {
      requestAnimationFrame(() => {
        source.focus();
        source.select();
      });
    }
  };
  const hideSource = (reset = false) => {
    sourceVisible = false;
    errorMessage = "";
    if (reset) source.value = markdown();
    render();
  };
  const commitSource = () => {
    if (!sourceVisible) return true;
    const parsed = parseSingleMarkdownImage(source.value.trim());
    if (!parsed) {
      errorMessage = "图片 Markdown 格式无效，应为 ![alt](path) 或 ![alt](path \"title\")";
      sourceVisible = true;
      render();
      requestAnimationFrame(() => source.focus());
      return false;
    }
    if (typeof getPos !== "function") return true;
    const pos = getPos();
    if (typeof pos !== "number") return true;
    const nextAttrs = {
      ...currentNode.attrs,
      src: parsed.src,
      markdownSrc: parsed.markdownSrc,
      alt: parsed.alt,
      title: parsed.title,
      editing: false,
    };
    errorMessage = "";
    sourceVisible = false;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs));
    render();
    return true;
  };
  const selectImage = () => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, pos)));
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.target instanceof globalThis.Node && dom.contains(event.target)) return;
    commitSource();
  };
  const onEditorBlur = () => {
    window.setTimeout(() => {
      if (document.activeElement instanceof globalThis.Node && dom.contains(document.activeElement)) return;
      commitSource();
    });
  };

  image.addEventListener("click", (event) => {
    event.preventDefault();
    showSource(true);
    selectImage();
  });
  source.addEventListener("click", (event) => {
    event.stopPropagation();
    showSource(false);
    selectImage();
  });
  source.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitSource();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideSource(true);
      editor.view.focus();
    }
  });
  source.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement instanceof globalThis.Node && dom.contains(document.activeElement)) return;
      commitSource();
    });
  });
  editor.on?.("blur", onEditorBlur);
  document.addEventListener("mousedown", onMouseDown);
  render();
  if (sourceVisible) showSource(true);

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type !== currentNode.type) return false;
      currentNode = nextNode;
      if (nextNode.attrs.editing) sourceVisible = true;
      render();
      return true;
    },
    destroy() {
      editor.off?.("blur", onEditorBlur);
      document.removeEventListener("mousedown", onMouseDown);
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof globalThis.Node && source.contains(event.target),
  };
}

function imageMarkdownFromAttrs(attrs: Record<string, string | null | undefined>) {
  const src = attrs.markdownSrc || attrs.src || "";
  const alt = (attrs.alt || "").replace(/]/g, "\\]");
  const title = attrs.title ? ` "${attrs.title.replace(/"/g, '\\"')}"` : "";
  return `![${alt}](${src}${title})`;
}

function createCodeBlockLanguageView({ node, editor, getPos }: any) {
  let currentNode = node;
  let open = false;
  let query = "";
  let highlightedIndex = 0;

  const dom = document.createElement("div");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const toolbar = document.createElement("div");
  const button = document.createElement("button");
  const menu = document.createElement("div");
  const input = document.createElement("input");
  const list = document.createElement("div");

  dom.className = "lightmark-code-block-shell";
  pre.className = "lightmark-code-block";
  toolbar.className = "code-language-toolbar";
  button.type = "button";
  button.className = "code-language-button";
  button.title = "选择代码语言";
  menu.className = "code-language-menu";
  input.className = "code-language-input";
  input.placeholder = "搜索语言";
  list.className = "code-language-list";

  menu.append(input, list);
  toolbar.append(button, menu);
  pre.append(code);
  dom.append(toolbar, pre);

  const codeLanguage = () => displayCodeLanguage(currentNode.attrs.language || "");

  const setLanguage = (value: string) => {
    const typed = value.trim().toLowerCase();
    const language = normalizeCodeLanguage(typed) || typed;
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const attrs = { ...currentNode.attrs, language: language || null };
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, attrs));
    open = false;
    query = "";
    highlightedIndex = 0;
    render();
    editor.commands.focus();
  };

  const chooseHighlighted = () => {
    if (!query.trim()) {
      setLanguage("");
      return;
    }
    const candidates = filterCodeLanguages(query);
    setLanguage(candidates[highlightedIndex] || query);
  };

  const isSelectionInsideCodeBlock = () => {
    if (typeof getPos !== "function") return false;
    const pos = getPos();
    if (typeof pos !== "number") return false;
    const { selection } = editor.view.state;
    const from = pos;
    const to = pos + currentNode.nodeSize;
    return selection.from >= from && selection.to <= to;
  };

  const renderCandidates = () => {
    const candidates = filterCodeLanguages(query);
    highlightedIndex = Math.min(highlightedIndex, Math.max(candidates.length - 1, 0));
    list.innerHTML = "";
    candidates.forEach((language, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = index === highlightedIndex ? "code-language-option active" : "code-language-option";
      option.textContent = language;
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        setLanguage(language);
      });
      list.append(option);
    });
    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "code-language-empty";
      empty.textContent = query.trim() ? `使用 "${query.trim().toLowerCase()}"` : "输入语言";
      list.append(empty);
    }
  };

  const render = () => {
    const language = codeLanguage();
    const active = open || isSelectionInsideCodeBlock();
    dom.className = `lightmark-code-block-shell${active ? " is-code-language-active" : ""}${open ? " is-code-language-open" : ""}`;
    code.className = language ? `language-${language}` : "";
    button.textContent = language || "代码语言";
    button.classList.toggle("placeholder", !language);
    menu.hidden = !open;
    if (open) {
      input.value = query;
      renderCandidates();
    }
  };

  const openMenu = () => {
    open = true;
    query = codeLanguage();
    highlightedIndex = 0;
    render();
    window.setTimeout(() => {
      input.focus();
      input.select();
    });
  };

  const closeMenu = () => {
    open = false;
    query = "";
    highlightedIndex = 0;
    render();
    editor.commands.focus();
  };

  const updateActive = () => {
    if (open) return;
    dom.classList.toggle("is-code-language-active", isSelectionInsideCodeBlock());
  };
  const onDocumentMouseDown = (event: MouseEvent) => {
    if (!open) return;
    if (event.target instanceof globalThis.Node && toolbar.contains(event.target)) return;
    open = false;
    query = "";
    highlightedIndex = 0;
    render();
  };

  const stopToolbarEvent = (event: Event) => {
    event.stopPropagation();
  };

  toolbar.addEventListener("pointerdown", stopToolbarEvent);
  toolbar.addEventListener("mousedown", stopToolbarEvent);
  toolbar.addEventListener("click", stopToolbarEvent);
  toolbar.addEventListener("keydown", stopToolbarEvent);
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  });
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  });
  input.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("input", () => {
    query = input.value;
    highlightedIndex = 0;
    renderCandidates();
  });
  input.addEventListener("keydown", (event) => {
    const candidates = filterCodeLanguages(query);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, Math.max(candidates.length - 1, 0));
      renderCandidates();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
      renderCandidates();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      chooseHighlighted();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const candidates = filterCodeLanguages(query);
      setLanguage(candidates[highlightedIndex] || query);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  });
  dom.addEventListener("mouseup", updateActive);
  dom.addEventListener("keyup", updateActive);
  document.addEventListener("selectionchange", updateActive);
  document.addEventListener("mousedown", onDocumentMouseDown);
  editor.on?.("selectionUpdate", updateActive);
  editor.on?.("focus", updateActive);
  editor.on?.("blur", updateActive);
  render();
  window.setTimeout(updateActive);

  return {
    dom,
    contentDOM: code,
    update(nextNode: any) {
      if (nextNode.type !== currentNode.type) return false;
      currentNode = nextNode;
      render();
      updateActive();
      return true;
    },
    destroy() {
      document.removeEventListener("selectionchange", updateActive);
      document.removeEventListener("mousedown", onDocumentMouseDown);
      toolbar.removeEventListener("pointerdown", stopToolbarEvent);
      toolbar.removeEventListener("mousedown", stopToolbarEvent);
      toolbar.removeEventListener("click", stopToolbarEvent);
      toolbar.removeEventListener("keydown", stopToolbarEvent);
      editor.off?.("selectionUpdate", updateActive);
      editor.off?.("focus", updateActive);
      editor.off?.("blur", updateActive);
    },
    stopEvent(event: Event) {
      return event.target instanceof globalThis.Node && toolbar.contains(event.target);
    },
    ignoreMutation(mutation: any) {
      return mutation.target instanceof globalThis.Node && toolbar.contains(mutation.target);
    },
  };
}

const editor = useEditor({
  enableInputRules: ["blockquote", "bulletList", "orderedList"],
  extensions: [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      link: false,
    }),
    LightMarkCodeBlock.configure({
      lowlight,
      defaultLanguage: "plaintext",
    }),
    TyporaHeading.configure({
      levels: [1, 2, 3, 4, 5, 6],
    }),
    TyporaBlockquote,
    GithubAlertInput,
    Link.configure({ openOnClick: false, protocols: ["lightmark"] }),
    MarkdownImage,
    Table.configure({ resizable: true }),
    TableRow,
    LightMarkTableHeader,
    LightMarkTableCell,
    MarkdownHeading,
    InlineMath,
    InlineHtmlNode,
    RawHtmlNode,
    BlockMath,
    MermaidNode,
    FootnoteRefNode,
    HighlightMark,
    StrikeMark,
    SuperscriptMark,
    SubscriptMark,
    TaskStateMark,
    FrontMatterNode,
    TableOfContentsNode,
    HtmlBlockNode,
    FootnotesNode,
    TyporaInlineCode,
    TyporaHorizontalRule,
    FrontMatterInput,
    FencedCodeBlockInput,
    FindReplaceDecorations,
    TyporaSourceMarkers,
  ],
  content: renderMarkdownForEditorWithAssets(paneContent.value),
  editorProps: {
    attributes: {
      class: "prose prose-stone dark:prose-invert mx-auto min-h-full max-w-[var(--lm-editor-width)] px-8 pb-12 pt-6 focus:outline-none",
    },
    handleKeyDown(view, event) {
      if (convertLeadingFrontMatter(view, event)) return true;
      if (convertFencedCodeBlock(view, event)) return true;
      if (event.key === "Backspace" && exitEmptyStoredFormattingOnBackspace(view)) {
        event.preventDefault();
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
        return true;
      }
      if (event.key === "ArrowRight" && moveOutOfMarkAtRightBoundary(view, typoraInlineMarkNames)) {
        event.preventDefault();
        return true;
      }
      if (event.key === "Enter") {
        if ((event.ctrlKey || event.metaKey) && insertTableRowAfterAndFocusFirstCell(view)) {
          event.preventDefault();
          return true;
        }

        if (continueTaskItem(view)) {
          event.preventDefault();
          return true;
        }

        if (convertMarkdownPipeTable(view)) {
          event.preventDefault();
          return true;
        }

        const blockquoteTr = convertBlockquoteMarkdown(view.state, {
          force: true,
          onlySelectionBlock: true,
          insertParagraph: true,
        });
        if (blockquoteTr) {
          event.preventDefault();
          view.dispatch(blockquoteTr.scrollIntoView());
          return true;
        }

        const horizontalRuleTr = convertHorizontalRuleMarkdown(view.state, {
          force: true,
          onlySelectionBlock: true,
          insertParagraph: true,
        });
        if (horizontalRuleTr) {
          event.preventDefault();
          view.dispatch(horizontalRuleTr.scrollIntoView());
          return true;
        }

        const headingTr = convertMarkdownHeading(view.state, {
          force: true,
          onlySelectionBlock: true,
          insertParagraph: true,
        });
        if (headingTr) {
          event.preventDefault();
          view.dispatch(headingTr.scrollIntoView());
          return true;
        }
        window.setTimeout(() => clearStoredMarks(view, ["strike"]), 0);
      }
      return false;
    },
    handleDOMEvents: {
      mousedown(view, event) {
        return convertPendingMarkdownBeforeMouseSelection(view, event as MouseEvent);
      },
      contextmenu(view, event) {
        const mouseEvent = event as MouseEvent;
        const target = getEventElement(mouseEvent);
        if (!target || !view.dom.contains(target)) return false;

        mouseEvent.preventDefault();
        const position = view.posAtCoords({ left: mouseEvent.clientX, top: mouseEvent.clientY });
        if (position && !isPositionInsideSelection(view.state.selection, position.pos)) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))));
        }
          savedSelection.value = {
            from: view.state.selection.from,
            to: view.state.selection.to,
          };
        const mode: ContextMenuMode =
          target.closest("pre, code") || view.state.selection.$from.parent.type.name === "codeBlock" ? "code" : "default";
        const menuPosition = getContextMenuPosition(mouseEvent.clientX, mouseEvent.clientY);

        contextMenu.value = {
          visible: true,
          x: menuPosition.x,
          y: menuPosition.y,
          mode,
          inTable: Boolean(target.closest("table")),
          flipX: menuPosition.flipX,
          flipY: menuPosition.flipY,
        };
        return true;
      },
      click(view, event) {
        hideContextMenu();
        const mouseEvent = event as MouseEvent;
        const target = getEventElement(mouseEvent);
        const link = target?.closest<HTMLAnchorElement>("a[href]");
        if (link) {
          mouseEvent.preventDefault();
          const href = link.getAttribute("href") || "";
          const wikiTarget = parseWikiLinkHref(href);
          if (wikiTarget) {
            void openWikiLink(wikiTarget);
            return true;
          }
          if (href.startsWith("#")) {
            scrollInternalLink(href);
            return true;
          }
          if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
            mouseEvent.stopPropagation();
            void openExternalLink(link.href);
            return true;
          }
          return false;
        }
        return false;
      },
      dragover(_view, event) {
        const dragEvent = event as DragEvent;
        if (getImageFilesFromDrop(dragEvent.dataTransfer).length === 0) return false;
        dragEvent.preventDefault();
        return true;
      },
      drop(view, event) {
        const dragEvent = event as DragEvent;
        const files = getImageFilesFromDrop(dragEvent.dataTransfer);
        if (files.length === 0) return false;
        dragEvent.preventDefault();
        const position = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY });
        const insertAt = position?.pos ?? view.state.doc.content.size;
        void insertImageFilesIntoWysiwyg(files, insertAt, insertAt);
        return true;
      },
      blur(view) {
        window.setTimeout(() => {
          if (view.hasFocus()) return;
          if (convertPendingInlineMarkdown(view)) return;

          const blockTr =
            convertBlockquoteMarkdown(view.state, { force: true }) ||
            convertHorizontalRuleMarkdown(view.state, { force: true }) ||
            convertMarkdownHeading(view.state, { force: true });
          if (blockTr) view.dispatch(blockTr);
        }, 0);
        return false;
      },
    },
    handleClick(view, _pos, event) {
      const target = getEventElement(event);
      const table = target?.closest<HTMLTableElement>("table");
      if (table && view.dom.contains(table)) {
        const cell = target?.closest<HTMLTableCellElement>("td,th") || null;
        window.setTimeout(() => updateTableControl(view, table, cell), 0);
      }

      const heading = target?.closest<HTMLElement>("h1,h2,h3,h4,h5,h6");
      if (heading && view.dom.contains(heading)) {
        event.preventDefault();
        editHeadingAsMarkdown(view, heading);
        return true;
      }

      const checkbox = target?.closest<HTMLInputElement>("input[data-task-checkbox]");
      const task = checkbox?.closest<HTMLElement>("[data-task-item]");
      if (checkbox && task) {
        event.preventDefault();
        toggleTaskItem(view, task);
        return true;
      }

      return false;
    },
    handlePaste(view, event) {
      const imageFiles = getImageFilesFromClipboard(event.clipboardData);
      if (imageFiles.length > 0) {
        event.preventDefault();
        const { from, to } = view.state.selection;
        void insertImageFilesIntoWysiwyg(imageFiles, from, to);
        return true;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !looksLikeMarkdown(text)) return false;
      event.preventDefault();
      const { from, to } = view.state.selection;
      editor.value?.commands.insertContentAt({ from, to }, renderMarkdownForEditorWithAssets(text));
      return true;
    },
  },
  onUpdate({ editor }) {
    setPaneContent(props.paneId, editorHtmlToMarkdown(editor.getHTML()), true);
    updateCodeLanguageControl(editor.view);
    updateTableControl(editor.view);
    captureWysiwygPosition(editor.view);
    if (findReplaceStore.open && findReplaceStore.query) window.setTimeout(refreshWysiwygFind, 0);
  },
  onSelectionUpdate({ editor }) {
    updateCodeLanguageControl(editor.view);
    updateTableControl(editor.view);
    captureWysiwygPosition(editor.view);
  },
  onFocus({ editor }) {
    updateCodeLanguageControl(editor.view);
    updateTableControl(editor.view);
  },
  onBlur() {
    window.setTimeout(() => {
      if (codeLanguageControl.value.open) return;
      codeLanguageControl.value.visible = false;
      if (!tableControl.value.resizeOpen && !tableControl.value.moreOpen) tableControl.value.visible = false;
    }, 120);
  },
});

function getSelectedCodeBlock(view: any) {
  const { selection } = view.state;
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "codeBlock") {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

function updateCodeLanguageControl(view = editor.value?.view) {
  if (!view || paneEditorMode.value !== "wysiwyg") {
    codeLanguageControl.value.visible = false;
    return;
  }
  const active = getSelectedCodeBlock(view);
  if (!active) {
    if (!codeLanguageControl.value.open) codeLanguageControl.value.visible = false;
    return;
  }
  const dom = view.nodeDOM(active.pos);
  const element =
    dom instanceof HTMLElement
      ? dom
      : dom instanceof Text
        ? dom.parentElement
        : null;
  if (!element) {
    codeLanguageControl.value.visible = false;
    return;
  }
  const rect = element.getBoundingClientRect();
  const controlWidth = 96;
  codeLanguageControl.value = {
    ...codeLanguageControl.value,
    visible: true,
    x: Math.max(12, Math.min(rect.right - controlWidth, window.innerWidth - controlWidth - 12)),
    y: Math.max(8, rect.top - 28),
    pos: active.pos,
    language: displayCodeLanguage(active.node.attrs.language || ""),
  };
}

function openFloatingCodeLanguageMenu({ select = false } = {}) {
  updateCodeLanguageControl();
  codeLanguageControl.value.open = true;
  codeLanguageControl.value.query = codeLanguageControl.value.language;
  codeLanguageControl.value.highlightedIndex = 0;
  window.setTimeout(() => {
    codeLanguageInput.value?.focus();
    if (select) codeLanguageInput.value?.select();
  });
}

function closeFloatingCodeLanguageMenu({ focusEditor = true } = {}) {
  codeLanguageControl.value.open = false;
  codeLanguageControl.value.query = "";
  codeLanguageControl.value.highlightedIndex = 0;
  if (focusEditor) editor.value?.commands.focus();
  updateCodeLanguageControl();
}

function applyFloatingCodeLanguage(value: string) {
  const activeEditor = editor.value as any;
  const view = activeEditor?.view;
  if (!view) return;
  const pos = codeLanguageControl.value.pos;
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "codeBlock") return;
  const typed = value.trim().toLowerCase();
  const language = normalizeCodeLanguage(typed) || typed;
  const attrs = { ...node.attrs, language: language || null };
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, attrs).scrollIntoView());
  codeLanguageControl.value.language = language;
  closeFloatingCodeLanguageMenu();
}

function chooseFloatingCodeLanguage() {
  const query = codeLanguageControl.value.query;
  if (!query.trim()) {
    applyFloatingCodeLanguage("");
    return;
  }
  const candidates = floatingCodeLanguageCandidates.value;
  applyFloatingCodeLanguage(candidates[codeLanguageControl.value.highlightedIndex] || query);
}

function handleFloatingCodeLanguageInput(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  codeLanguageControl.value.open = true;
  codeLanguageControl.value.query = target.value;
  codeLanguageControl.value.highlightedIndex = 0;
}

function commitFloatingCodeLanguageInput() {
  const query = codeLanguageControl.value.open ? codeLanguageControl.value.query : codeLanguageControl.value.language;
  applyFloatingCodeLanguage(query);
}

function handleFloatingCodeLanguageBlur() {
  window.setTimeout(() => {
    if (!codeLanguageControl.value.open) return;
    commitFloatingCodeLanguageInput();
  }, 120);
}

function handleFloatingCodeLanguageKeydown(event: KeyboardEvent) {
  const candidates = floatingCodeLanguageCandidates.value;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    codeLanguageControl.value.highlightedIndex = Math.min(
      codeLanguageControl.value.highlightedIndex + 1,
      Math.max(candidates.length - 1, 0),
    );
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    codeLanguageControl.value.highlightedIndex = Math.max(codeLanguageControl.value.highlightedIndex - 1, 0);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    chooseFloatingCodeLanguage();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    applyFloatingCodeLanguage(candidates[codeLanguageControl.value.highlightedIndex] || codeLanguageControl.value.query);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeFloatingCodeLanguageMenu();
  }
}

function handleEditorShellScroll() {
  if (codeLanguageControl.value.visible) updateCodeLanguageControl();
  if (tableControl.value.visible) updateTableControl();
  captureWysiwygPosition();
}

function getSelectedTableInfo(view = editor.value?.view, explicitTable?: HTMLTableElement | null, explicitCell?: HTMLTableCellElement | null) {
  if (!view || paneEditorMode.value !== "wysiwyg") return null;
  const table = explicitTable || getCurrentTableElement();
  if (!table) return null;
  const resolved = resolveTableNodeFromDom(view, table, explicitCell);
  if (!resolved) return null;
  const { pos, node } = resolved;
  const rows = table.rows.length;
  const columns = rows ? Math.max(...Array.from(table.rows).map((row) => row.cells.length)) : 0;
  return { table, pos, node, rows, columns };
}

function updateTableControl(view = editor.value?.view, explicitTable?: HTMLTableElement | null, explicitCell?: HTMLTableCellElement | null) {
  const active = getSelectedTableInfo(view, explicitTable, explicitCell);
  if (!active) {
    if (!tableControl.value.resizeOpen && !tableControl.value.moreOpen) tableControl.value.visible = false;
    return;
  }
  const rect = active.table.getBoundingClientRect();
  const shellTop = editorShell.value?.getBoundingClientRect().top ?? 0;
  const width = 160;
  const nextRows = active.rows;
  const nextColumns = active.columns;
  const activeColumn = explicitCell?.cellIndex ?? getCurrentTableCell()?.cellIndex ?? tableControl.value.activeColumn;
  tableControl.value = {
    ...tableControl.value,
    visible: true,
    x: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
    y: Math.max(shellTop + 8, rect.top - 36),
    tablePos: active.pos,
    activeColumn,
    rows: nextRows,
    columns: nextColumns,
    resizeText: tableControl.value.resizeOpen ? tableControl.value.resizeText : `${nextRows} x ${nextColumns}`,
  };
}

function resolveTableNodeFromDom(view: any, table: HTMLTableElement, cell?: HTMLTableCellElement | null) {
  const candidates: number[] = [];
  const pushDomPos = (element: HTMLElement | null) => {
    if (!element) return;
    try {
      candidates.push(view.posAtDOM(element, 0));
    } catch {
      // Ignore DOM positions ProseMirror cannot map directly.
    }
  };

  pushDomPos(cell || null);
  pushDomPos(table);
  pushDomPos(table.parentElement);
  if (tableControl.value.tablePos >= 0) candidates.push(tableControl.value.tablePos);

  for (const pos of candidates) {
    const resolved = resolveTableNodeAtDocPos(view.state.doc, pos);
    if (resolved) return resolved;
  }

  return null;
}

function resolveTableNodeAtDocPos(doc: any, pos: number) {
  const max = doc.content.size;
  const candidates = Array.from(new Set([pos, pos - 1, pos + 1]))
    .filter((candidate) => Number.isInteger(candidate) && candidate >= 0 && candidate <= max);

  for (const candidate of candidates) {
    const direct = doc.nodeAt(candidate);
    if (direct?.type?.name === "table") return { pos: candidate, node: direct };

    try {
      const $pos = doc.resolve(candidate);
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        if (node?.type?.name === "table") {
          return { pos: $pos.before(depth), node };
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function openTableResizePanel() {
  updateTableControl();
  tableControl.value.resizeOpen = !tableControl.value.resizeOpen;
  tableControl.value.moreOpen = false;
  tableControl.value.resizeText = `${tableControl.value.rows} x ${tableControl.value.columns}`;
  tableControl.value.resizeError = "";
}

function toggleTableMoreMenu() {
  updateTableControl();
  tableControl.value.moreOpen = !tableControl.value.moreOpen;
  tableControl.value.resizeOpen = false;
}

function closeTablePopovers() {
  tableControl.value.resizeOpen = false;
  tableControl.value.moreOpen = false;
  tableControl.value.resizeError = "";
}

function parseTableSizeInput(value: string) {
  const match = value.trim().match(/^(\d{1,2})\s*(?:x|\*|×)\s*(\d{1,2})$/i);
  if (!match) return null;
  const rows = Number(match[1]);
  const columns = Number(match[2]);
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) return null;
  return { rows, columns };
}

function setTableResizeDelta(kind: "rows" | "columns", delta: 1 | -1) {
  const size = parseTableSizeInput(tableControl.value.resizeText) || {
    rows: tableControl.value.rows || 1,
    columns: tableControl.value.columns || 1,
  };
  const next = {
    rows: kind === "rows" ? Math.max(1, size.rows + delta) : size.rows,
    columns: kind === "columns" ? Math.max(1, size.columns + delta) : size.columns,
  };
  tableControl.value.resizeText = `${next.rows} x ${next.columns}`;
  tableControl.value.rows = next.rows;
  tableControl.value.columns = next.columns;
  tableControl.value.resizeError = "";
}

function handleTableResizeTextInput(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  tableControl.value.resizeText = target.value;
  const size = parseTableSizeInput(target.value);
  if (size) {
    tableControl.value.rows = size.rows;
    tableControl.value.columns = size.columns;
  }
  tableControl.value.resizeError = "";
}

function applyTableResizeFromInput() {
  const size = parseTableSizeInput(tableControl.value.resizeText);
  if (!size) {
    tableControl.value.resizeError = "请输入类似 4 x 6 的行列数。";
    return;
  }
  applyTableSize(size.rows, size.columns);
}

function applyTableSize(targetRows: number, targetColumns: number) {
  const info = getSelectedTableInfo();
  if (!info) return;
  if (tableResizeWouldDropContent(info.table, targetRows, targetColumns)) {
    tableControl.value.resizeError = "缩小会删除非空单元格，已阻止。";
    return;
  }
  const nextTable = resizedTableElement(info.table, targetRows, targetColumns);
  replaceCurrentTableFromDom(nextTable);
  tableControl.value.resizeOpen = false;
  tableControl.value.resizeError = "";
  window.setTimeout(() => updateTableControl(), 0);
}

function resizedTableElement(source: HTMLTableElement, targetRows: number, targetColumns: number) {
  const table = source.cloneNode(true) as HTMLTableElement;
  while (table.rows.length > targetRows) table.deleteRow(table.rows.length - 1);
  while (table.rows.length < targetRows) {
    const row = table.insertRow();
    const useHeader = table.rows.length === 1 && source.rows[0]?.cells[0]?.tagName.toLowerCase() === "th";
    for (let column = 0; column < targetColumns; column += 1) {
      const cell = document.createElement(useHeader ? "th" : "td");
      cell.innerHTML = "";
      row.appendChild(cell);
    }
  }
  Array.from(table.rows).forEach((row) => {
    while (row.cells.length > targetColumns) row.deleteCell(row.cells.length - 1);
    while (row.cells.length < targetColumns) {
      const template = row.cells[row.cells.length - 1] || source.rows[0]?.cells[row.cells.length] || source.rows[0]?.cells[0];
      const cell = document.createElement(row.rowIndex === 0 && template?.tagName.toLowerCase() === "th" ? "th" : "td");
      const align = template ? parseTableCellAlign(template as HTMLElement) : null;
      if (align) {
        cell.style.textAlign = align;
        cell.setAttribute("align", align);
      }
      cell.innerHTML = "";
      row.appendChild(cell);
    }
  });
  return table;
}

function tableResizeWouldDropContent(table: HTMLTableElement, targetRows: number, targetColumns: number) {
  const rows = Array.from(table.rows);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (rowIndex >= targetRows && rowHasContent(row)) return true;
    for (let columnIndex = targetColumns; columnIndex < row.cells.length; columnIndex += 1) {
      if (cellHasContent(row.cells[columnIndex])) return true;
    }
  }
  return false;
}

function rowHasContent(row: HTMLTableRowElement) {
  return Array.from(row.cells).some(cellHasContent);
}

function cellHasContent(cell: HTMLTableCellElement) {
  return Boolean(cell.textContent?.trim() || cell.querySelector("img,video,iframe,math,.math-node,.typora-image-node"));
}

function applyTableAlignment(align: "left" | "center" | "right") {
  const info = getSelectedTableInfo();
  if (!info) return;
  const allColumns = isWholeTableSelected(info);
  const activeCell = getCurrentTableCell();
  const targetColumn = activeCell?.cellIndex ?? tableControl.value.activeColumn;
  if (!allColumns && targetColumn < 0) return;

  const activeEditor = editor.value;
  if (!activeEditor) return;
  let tr = activeEditor.state.tr;
  tableCellPositions(info.pos, info.node).forEach(({ pos, columnIndex, node }) => {
    if (!allColumns && columnIndex !== targetColumn) return;
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: align }, node.marks);
  });
  if (tr.docChanged) activeEditor.view.dispatch(tr.scrollIntoView());
  window.setTimeout(() => updateTableControl(), 0);
}

function tableCellPositions(tablePos: number, tableNode: any) {
  const cells: Array<{ pos: number; rowIndex: number; columnIndex: number; node: any }> = [];
  let rowPos = tablePos + 1;
  for (let rowIndex = 0; rowIndex < tableNode.childCount; rowIndex += 1) {
    const row = tableNode.child(rowIndex);
    let cellPos = rowPos + 1;
    for (let columnIndex = 0; columnIndex < row.childCount; columnIndex += 1) {
      const cell = row.child(columnIndex);
      if (cell?.type?.name === "tableCell" || cell?.type?.name === "tableHeader") {
        cells.push({ pos: cellPos, rowIndex, columnIndex, node: cell });
      }
      cellPos += cell.nodeSize;
    }
    rowPos += row.nodeSize;
  }
  return cells;
}

function isWholeTableSelected(info: { pos: number; node: any }) {
  const activeEditor = editor.value;
  if (!activeEditor) return false;
  const selection = activeEditor.state.selection;
  if (selection instanceof AllSelection) return true;
  if (selection instanceof NodeSelection && selection.from === info.pos && selection.node.type.name === "table") return true;
  return !selection.empty && selection.from <= info.pos && selection.to >= info.pos + info.node.nodeSize;
}

async function insertImageFilesIntoWysiwyg(files: File[], from: number, to: number) {
  const markdown = await saveImagesAsMarkdown(files);
  if (!markdown) return;
  insertImageMarkdownIntoWysiwyg(markdown, from, to);
}

async function insertImagePathsIntoWysiwyg(paths: string[], from: number, to: number) {
  const markdown = await imagePathsAsMarkdown(paths);
  if (!markdown) return;
  insertImageMarkdownIntoWysiwyg(markdown, from, to);
}

function insertImageMarkdownIntoWysiwyg(markdown: string, from: number, to: number) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const images = parseMarkdownImageSnippets(markdown);
  if (images.length === 0) return;
  const content = images.map((image) => ({ type: "image", attrs: { ...image, editing: true } }));
  activeEditor.commands.insertContentAt({ from, to }, content);
}

function parseMarkdownImageSnippets(markdown: string) {
  const images: Array<{ src: string; markdownSrc: string; alt: string; title: string | null }> = [];
  const pattern = /!\[([^\]\n]*)\]\((\S+?)(?:\s+"([^"\n]*)")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const image = parseSingleMarkdownImage(match[0]);
    if (image) images.push(image);
  }
  return images;
}

function parseSingleMarkdownImage(markdown: string) {
  const match = markdown.match(/^!\[([^\]\n]*)\]\((\S+?)(?:\s+"([^"\n]*)")?\)$/);
  if (!match) return null;
  const markdownSrc = match[2]?.trim();
  if (!markdownSrc) return null;
  return {
    src: resolveMarkdownImageSource(markdownSrc),
    markdownSrc,
    alt: match[1].replace(/\\]/g, "]"),
    title: match[3] || null,
  };
}

watch(
  () => paneTab.value?.id || "",
  () => {
    editor.value?.commands.setContent(renderMarkdownForEditorWithAssets(paneContent.value), { emitUpdate: false });
    schedulePendingWysiwygPositionRestore();
  },
);

watch(
  () => paneEditorMode.value,
  () => {
    if (paneEditorMode.value === "wysiwyg") {
      editor.value?.commands.setContent(renderMarkdownForEditorWithAssets(paneContent.value), { emitUpdate: false });
      schedulePendingWysiwygCursorRestore();
      schedulePendingWysiwygPositionRestore();
    }
  },
);

watch(
  () => editor.value,
  () => {
    schedulePendingWysiwygCursorRestore();
    schedulePendingWysiwygPositionRestore();
  },
);

onMounted(() => {
  schedulePendingWysiwygCursorRestore();
  schedulePendingWysiwygPositionRestore();
  document.addEventListener("pointerdown", handleDocumentTablePointerDown, true);
  window.addEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.addEventListener("lightmark:restore-position", handleRestorePosition as EventListener);
  window.addEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.addEventListener("lightmark:editor-command", handleToolbarEditorCommand as EventListener);
  window.addEventListener("lightmark:find-command", handleFindCommand as EventListener);
  window.addEventListener("lightmark:jump-heading", handleJumpHeading as EventListener);
  window.addEventListener("resize", handleEditorShellScroll);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentTablePointerDown, true);
  window.removeEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.removeEventListener("lightmark:restore-position", handleRestorePosition as EventListener);
  window.removeEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.removeEventListener("lightmark:editor-command", handleToolbarEditorCommand as EventListener);
  window.removeEventListener("lightmark:find-command", handleFindCommand as EventListener);
  window.removeEventListener("lightmark:jump-heading", handleJumpHeading as EventListener);
  window.removeEventListener("resize", handleEditorShellScroll);
  if (pendingWysiwygRestoreTimer !== null) window.clearTimeout(pendingWysiwygRestoreTimer);
  editor.value?.destroy();
});

function handleModeCursorCapture(event: CustomEvent<{ from?: string; to?: string; paneId?: EditorPaneId }>) {
  const activeEditor = editor.value;
  if (event.detail?.paneId !== props.paneId || paneEditorMode.value !== "wysiwyg" || event.detail?.to !== "source" || !activeEditor) return;
  const markdown = editorHtmlToMarkdown(activeEditor.getHTML());
  setPaneContent(props.paneId, markdown, true);
  const { anchor, head } = activeEditor.view.state.selection;
  setPanePendingModeCursor(props.paneId, {
    targetMode: "source",
    markdownAnchor: docPosToMarkdownOffset(activeEditor.view.state, anchor, markdown),
    markdownHead: docPosToMarkdownOffset(activeEditor.view.state, head, markdown),
    reason: "mode-switch",
  });
}

function captureWysiwygPosition(view = editor.value?.view) {
  if (!view || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const shell = editorShell.value;
  const markdown = paneContent.value || editorHtmlToMarkdown(editor.value?.getHTML() || "");
  const { anchor, head } = view.state.selection;
  updatePanePosition(
    props.paneId,
    buildEditorPositionSnapshot({
      editorMode: "wysiwyg",
      markdown,
      markdownAnchor: docPosToMarkdownOffset(view.state, anchor, markdown),
      markdownHead: docPosToMarkdownOffset(view.state, head, markdown),
      scrollTop: shell?.scrollTop ?? 0,
      scrollHeight: shell?.scrollHeight ?? 0,
      clientHeight: shell?.clientHeight ?? 0,
    }),
  );
}

function schedulePendingWysiwygPositionRestore() {
  const position = consumePanePendingEditorPosition(props.paneId, "wysiwyg");
  if (!position) return;
  window.setTimeout(() => restoreWysiwygPosition(position), 0);
}

function handleRestorePosition(event: CustomEvent) {
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  if (paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  restoreWysiwygPosition(event.detail);
}

function restoreWysiwygPosition(position: any) {
  const activeEditor = editor.value;
  const shell = editorShell.value;
  if (!activeEditor || !position || position.editorMode !== "wysiwyg") return;
  window.requestAnimationFrame(() => {
    const view = editor.value?.view;
    if (!view) return;
    const docPos = markdownOffsetToDocPos(view.state, position.markdownAnchor, paneContent.value);
    const headPos = markdownOffsetToDocPos(view.state, position.markdownHead, paneContent.value);
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, clampDocPos(docPos, view.state.doc.content.size), clampDocPos(headPos, view.state.doc.content.size))));
    } catch {
      scrollWysiwygPositionIntoView(view, docPos);
    }
    if (shell) shell.scrollTop = scrollTopFromSnapshot(position, shell.scrollHeight, shell.clientHeight);
    view.focus();
  });
}

function restorePendingWysiwygCursor() {
  const pending = getPanePendingModeCursor(props.paneId);
  if (!pending || pending.targetMode !== "wysiwyg") return false;
  const view = editor.value?.view;
  if (!view) return false;
  window.requestAnimationFrame(() => {
    const activeView = editor.value?.view;
    if (!activeView || getPanePendingModeCursor(props.paneId) !== pending) return;
    const target = findWysiwygScrollTarget(activeView, pending, paneContent.value);
    if (target) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
    } else {
      const scrollPos = markdownOffsetToDocPos(activeView.state, pending.markdownAnchor, paneContent.value);
      scrollWysiwygPositionIntoView(activeView, scrollPos);
    }
    if (getPanePendingModeCursor(props.paneId) === pending) setPanePendingModeCursor(props.paneId, null);
  });
  return true;
}

function schedulePendingWysiwygCursorRestore(attempt = 0) {
  const pending = getPanePendingModeCursor(props.paneId);
  if (!pending || pending.targetMode !== "wysiwyg") return;
  if (pendingWysiwygRestoreTimer !== null) window.clearTimeout(pendingWysiwygRestoreTimer);
  pendingWysiwygRestoreTimer = window.setTimeout(() => {
    pendingWysiwygRestoreTimer = null;
    if (restorePendingWysiwygCursor()) return;
    if (attempt < 8) schedulePendingWysiwygCursorRestore(attempt + 1);
  }, attempt === 0 ? 0 : 24);
}

function scrollWysiwygPositionIntoView(view: any, pos: number) {
  window.requestAnimationFrame(() => {
    try {
      const dom = view.domAtPos(clampDocPos(pos, view.state.doc.content.size)).node;
      const element = dom instanceof Element ? dom : dom.parentElement;
      element?.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      view.dom.querySelector(".ProseMirror-selectednode")?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  });
}

function findWysiwygScrollTarget(view: any, pending: any, markdown: string) {
  const blocks = collectWysiwygScrollBlocks(view.dom);
  if (blocks.length === 0) return null;
  const lineText = findNearbySourceLineText(markdown, pending.markdownLine, pending.markdownLineText);
  const needle = normalizeSourceLineForSearch(lineText);
  const expectedRatio = sourceLineRatio(markdown, pending.markdownLine);

  if (needle.length >= 2) {
    const matches = blocks.filter((block) => normalizeDomTextForSearch(block.textContent || "").includes(needle));
    if (matches.length > 0) return chooseNearestBlockByRatio(blocks, matches, expectedRatio);
  }

  if (typeof pending.markdownLine === "number") {
    return blocks[Math.max(0, Math.min(blocks.length - 1, Math.round(expectedRatio * (blocks.length - 1))))] ?? null;
  }
  return null;
}

function collectWysiwygScrollBlocks(root: HTMLElement) {
  const selector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "pre",
    "table",
    "figure",
    "section[data-type]",
    "[data-type='inline-html']",
    "[data-type='raw-html']",
    ".typora-image-node",
    ".html-block-node",
    ".markdown-alert",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => root.contains(element));
}

function chooseNearestBlockByRatio(allBlocks: HTMLElement[], matches: HTMLElement[], expectedRatio: number) {
  if (matches.length === 1) return matches[0];
  const denominator = Math.max(allBlocks.length - 1, 1);
  return matches
    .map((block) => ({ block, distance: Math.abs(allBlocks.indexOf(block) / denominator - expectedRatio) }))
    .sort((left, right) => left.distance - right.distance)[0]?.block ?? matches[0];
}

function findNearbySourceLineText(markdown: string, lineNumber?: number, lineText?: string) {
  if (lineText && normalizeSourceLineForSearch(lineText).length >= 2) return lineText;
  if (!lineNumber) return lineText || "";
  const lines = markdown.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  for (let radius = 0; radius <= 4; radius += 1) {
    const candidates = radius === 0 ? [index] : [index - radius, index + radius];
    for (const candidate of candidates) {
      const text = lines[candidate] || "";
      if (normalizeSourceLineForSearch(text).length >= 2) return text;
    }
  }
  return lineText || "";
}

function sourceLineRatio(markdown: string, lineNumber?: number) {
  if (!lineNumber) return 0;
  const total = Math.max(markdown.split(/\r?\n/).length, 1);
  return Math.max(0, Math.min(1, (lineNumber - 1) / Math.max(total - 1, 1)));
}

function normalizeSourceLineForSearch(value: string) {
  return normalizeDomTextForSearch(
    value
      .replace(/^ {0,3}> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i, "")
      .replace(/^ {0,3}>\s?/g, "")
      .replace(/^ {0,3}#{1,6}\s+/g, "")
      .replace(/^(\s*)([-*+]|\d+\.)\s+\[[ xX]\]\s+/g, "")
      .replace(/^(\s*)([-*+]|\d+\.)\s+/g, "")
      .replace(/^ {0,3}(```|~~~).*$/g, "")
      .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, "$1")
      .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
      .replace(/\[\^([^\]\n]+)\]/g, "$1")
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/==([^=\n]+)==/g, "$1")
      .replace(/\$([^$\n]+)\$/g, "$1")
      .replace(/<[^>\n]+>/g, "")
      .replace(/^\|?|\|?$/g, ""),
  );
}

function normalizeDomTextForSearch(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function handleFindCommand(event: CustomEvent<string>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const command = event.detail || "refresh";
  if (command === "next" || command === "previous") {
    navigateWysiwygFind(command === "next" ? 1 : -1);
    return;
  }
  if (command === "replaceCurrent") {
    replaceCurrentWysiwygFind();
    return;
  }
  if (command === "replaceAll") {
    replaceAllWysiwygFind();
    return;
  }
  refreshWysiwygFind();
}

function refreshWysiwygFind() {
  const view = editor.value?.view;
  if (!view) return;
  const matches = collectWysiwygFindMatches(view.state);
  const current = findReplaceStore.currentIndex < 0 ? 0 : normalizeMatchIndex(findReplaceStore.currentIndex, matches.items.length);
  setFindResult(matches.items.length, current, matches.error);
  view.dispatch(view.state.tr.setMeta("lightmarkFindRefresh", Date.now()));
}

function navigateWysiwygFind(delta: 1 | -1) {
  const view = editor.value?.view;
  if (!view) return;
  const matches = collectWysiwygFindMatches(view.state);
  if (matches.error || matches.items.length === 0) {
    setFindResult(0, -1, matches.error);
    view.dispatch(view.state.tr.setMeta("lightmarkFindRefresh", Date.now()));
    return;
  }

  const current = normalizeMatchIndex(findReplaceStore.currentIndex + delta, matches.items.length);
  const match = matches.items[current];
  setFindResult(matches.items.length, current, "");
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.docFrom, match.docTo)).scrollIntoView());
}

function replaceCurrentWysiwygFind() {
  const view = editor.value?.view;
  if (!view) return;
  const matches = collectWysiwygFindMatches(view.state);
  const current = normalizeMatchIndex(findReplaceStore.currentIndex, matches.items.length);
  const match = matches.items[current];
  if (!match || matches.error) {
    setFindResult(matches.items.length, current, matches.error);
    return;
  }
  const replacement = replacementForMatch(match, findReplaceStore.replaceText, findReplaceStore.regex);
  view.dispatch(view.state.tr.insertText(replacement, match.docFrom, match.docTo).scrollIntoView());
  window.setTimeout(refreshWysiwygFind, 0);
}

function replaceAllWysiwygFind() {
  const view = editor.value?.view;
  if (!view) return;
  const matches = collectWysiwygFindMatches(view.state);
  if (matches.error || matches.items.length === 0) {
    setFindResult(0, -1, matches.error);
    return;
  }
  let tr = view.state.tr;
  for (const match of [...matches.items].reverse()) {
    tr = tr.insertText(replacementForMatch(match, findReplaceStore.replaceText, findReplaceStore.regex), match.docFrom, match.docTo);
  }
  view.dispatch(tr.scrollIntoView());
  appStore.statusMessage = `已替换 ${matches.items.length} 处`;
  window.setTimeout(refreshWysiwygFind, 0);
}

function collectWysiwygFindMatches(state: any): { items: EditorFindMatch[]; error: string } {
  if (!findReplaceStore.open || !findReplaceStore.query) return { items: [], error: "" };
  const items: EditorFindMatch[] = [];
  let error = "";

  state.doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true;
    const block = flattenTextblock(node, pos);
    if (!block.text) return false;
    const result = findTextMatches(block.text, findReplaceStore.query, findOptions());
    if (result.error) {
      error = result.error;
      return false;
    }
    result.matches.forEach((match) => {
      const docFrom = textOffsetToDocPos(block.segments, match.from);
      const docTo = textOffsetToDocPos(block.segments, match.to);
      if (docFrom !== null && docTo !== null && docFrom < docTo) {
        items.push({ ...match, docFrom, docTo });
      }
    });
    return false;
  });

  return { items, error };
}

function flattenTextblock(node: any, pos: number) {
  const segments: Array<{ from: number; text: string; start: number; end: number }> = [];
  let text = "";
  node.descendants((child: any, childPos: number) => {
    if (!child.isText || !child.text) return true;
    const start = text.length;
    text += child.text;
    segments.push({
      from: pos + 1 + childPos,
      text: child.text,
      start,
      end: text.length,
    });
    return false;
  });
  return { text, segments };
}

function textOffsetToDocPos(segments: Array<{ from: number; text: string; start: number; end: number }>, offset: number) {
  for (const segment of segments) {
    if (offset >= segment.start && offset <= segment.end) {
      return segment.from + offset - segment.start;
    }
  }
  const last = segments[segments.length - 1];
  return last && offset === last.end ? last.from + last.text.length : null;
}

function handleToolbarEditorCommand(event: CustomEvent<ToolbarEditorCommandDetail>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const command = event.detail?.command;
  switch (command) {
    case "bold":
    case "italic":
    case "code":
    case "blockquote":
    case "orderedList":
    case "bulletList":
      runFormatCommand(command);
      break;
    case "link":
      toggleLink();
      break;
    case "taskList":
      insertTaskItem();
      break;
    case "heading":
      setHeadingLevel(typeof event.detail?.value === "number" ? event.detail.value : 2);
      break;
    case "image":
      insertImageByUrl();
      break;
    case "alert":
      insertGithubAlert(typeof event.detail?.value === "string" ? event.detail.value : "note");
      break;
    default:
      break;
  }
}

function handleGlobalImageInsert(event: CustomEvent<ImageInsertDetail>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const files = event.detail?.files || [];
  const paths = event.detail?.paths || [];
  if (files.length === 0 && paths.length === 0) return;
  const view = editor.value?.view;
  if (!view) return;
  const insertAt = imageInsertPositionFromEventDetail(event.detail, view.state.doc.content.size);
  if (paths.length > 0) {
    void insertImagePathsIntoWysiwyg(paths, insertAt, insertAt);
    return;
  }
  void insertImageFilesIntoWysiwyg(files, insertAt, insertAt);
}

function imageInsertPositionFromEventDetail(detail: ImageInsertDetail | undefined, fallback: number) {
  const view = editor.value?.view;
  if (!view || typeof detail?.position?.x !== "number" || typeof detail.position.y !== "number") return fallback;
  return view.posAtCoords({ left: detail.position.x, top: detail.position.y })?.pos ?? fallback;
}

function getContextMenuPosition(clientX: number, clientY: number) {
  const margin = 8;
  const menuWidth = 280;
  const menuHeight = 390;
  const maxX = Math.max(margin, window.innerWidth - menuWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - menuHeight - margin);
  return {
    x: Math.min(Math.max(clientX, margin), maxX),
    y: Math.min(Math.max(clientY, margin), maxY),
    flipX: clientX > window.innerWidth - 320,
    flipY: clientY > window.innerHeight - 300,
  };
}

function hideContextMenu() {
  contextMenu.value.visible = false;
}

function handleEditorShellClick(event?: MouseEvent) {
  hideContextMenu();
  if (codeLanguageControl.value.open) closeFloatingCodeLanguageMenu({ focusEditor: false });
  const target = event?.target instanceof HTMLElement ? event.target : null;
  const table = target?.closest("table") as HTMLTableElement | null;
  if (table) {
    closeTablePopovers();
    const cell = target?.closest("td,th") as HTMLTableCellElement | null;
    updateTableControl(editor.value?.view, table, cell);
    return;
  }
  if (target && !target.closest("table,.table-floating-toolbar")) {
    tableControl.value.visible = false;
    closeTablePopovers();
  }
}

function handleDocumentTablePointerDown(event: PointerEvent) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target || target.closest(".table-floating-toolbar")) return;
  const view = editor.value?.view;
  const table = target.closest("table") as HTMLTableElement | null;
  if (!view || !table || !view.dom.contains(table)) return;
  closeTablePopovers();
  const cell = target.closest("td,th") as HTMLTableCellElement | null;
  updateTableControl(view, table, cell);
  window.requestAnimationFrame(() => updateTableControl(view, table, cell));
}

function isPositionInsideSelection(selection: any, pos: number) {
  return !selection.empty && pos >= selection.from && pos <= selection.to;
}

function restoreEditorSelection() {
  const activeEditor = editor.value;
  if (!activeEditor || !savedSelection.value) {
    activeEditor?.view.focus();
    return;
  }

  const { state, view } = activeEditor;
  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(savedSelection.value.from, docSize));
  const to = Math.max(from, Math.min(savedSelection.value.to, docSize));

  try {
    const selection = TextSelection.between(
      state.doc.resolve(from),
      state.doc.resolve(to),
      -1,
    );
    view.dispatch(state.tr.setSelection(selection));
  } catch {
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(from))));
  }

  activeEditor.view.focus();
}

function runMenuCommand(command: () => void | Promise<void>, keepOpen = false) {
  restoreEditorSelection();
  void Promise.resolve(command()).finally(() => {
    if (!keepOpen) hideContextMenu();
  });
}

function runTableFloatingCommand(command: () => void | Promise<void>, closePopovers = true) {
  editor.value?.commands.focus();
  void Promise.resolve(command()).finally(() => {
    if (closePopovers) closeTablePopovers();
  });
}

async function writeClipboard(text: string, html?: string) {
  if (html && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Plain text fallback below.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

async function readClipboardText() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

function getSelectedHtml() {
  const activeEditor = editor.value;
  if (!activeEditor) return "";
  const { state } = activeEditor.view;
  const fragment = state.selection.content().content;
  if (!fragment.size) return "";
  const div = document.createElement("div");
  const serializer = DOMSerializer.fromSchema(state.schema);
  div.appendChild(serializer.serializeFragment(fragment));
  return div.innerHTML;
}

function getSelectedMarkdown() {
  const html = getSelectedHtml();
  if (!html) return "";
  return editorHtmlToMarkdown(html).trim();
}

function getSelectedPlainText() {
  const activeEditor = editor.value;
  if (!activeEditor) return "";
  const { from, to } = activeEditor.state.selection;
  return activeEditor.state.doc.textBetween(from, to, "\n", "\n");
}

async function cutSelection() {
  await copySelectionAsMarkdown();
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  if (state.selection.empty) return;
  activeEditor.view.dispatch(state.tr.deleteSelection().scrollIntoView());
}

async function copySelectionAsMarkdown() {
  const markdown = getSelectedMarkdown() || getSelectedPlainText();
  await writeClipboard(markdown);
}

async function copySelectionClean() {
  await copySelectionAsMarkdown();
}

async function copySelectionAsHtml() {
  const html = getSelectedHtml();
  const markdown = getSelectedMarkdown() || getSelectedPlainText();
  await writeClipboard(markdown, html);
}

async function pasteFromClipboard(clean: boolean) {
  const text = await readClipboardText();
  if (!text) return;
  if (clean) {
    (editor.value as any)?.commands.insertContent(renderMarkdownForEditorWithAssets(text));
    return;
  }
  (editor.value as any)?.commands.insertContent(text);
}

function insertMarkdownText(text: string, selectFromOffset?: number, selectToOffset?: number) {
  const activeEditor = editor.value;
  if (!activeEditor) return;

  const view = activeEditor.view;
  const { state } = view;
  const from = state.selection.from;
  const to = state.selection.to;
  let tr = state.tr.insertText(text, from, to);

  if (typeof selectFromOffset === "number" && typeof selectToOffset === "number") {
    const selectFrom = from + selectFromOffset;
    const selectTo = from + selectToOffset;
    tr = tr.setSelection(TextSelection.create(tr.doc, selectFrom, selectTo));
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function runFormatCommand(commandName: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const chain = activeEditor.chain().focus();
  switch (commandName) {
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "code":
      chain.toggleCode().run();
      break;
    case "blockquote":
      chain.toggleBlockquote().run();
      break;
    case "orderedList":
      chain.toggleOrderedList().run();
      break;
    case "bulletList":
      chain.toggleBulletList().run();
      break;
    default:
      break;
  }
}

function toggleLink() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const selectedText = getSelectedPlainText().trim();
  const label = selectedText || "链接文本";
  const snippet = `[${label}](https://example.com)`;
  const labelStart = 1;
  const labelEnd = labelStart + label.length;
  insertMarkdownText(snippet, selectedText ? snippet.length - "https://example.com)".length : labelStart, selectedText ? snippet.length - 1 : labelEnd);
}

function insertTaskItem() {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  activeEditor.commands.insertContent(renderMarkdownForEditorWithAssets("- [ ] "));
}

function insertGithubAlert(kind: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const selectedText = getSelectedPlainText().trim();
  const body = selectedText || "警示内容";
  const quotedBody = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const markdown = `> [!${kind.toUpperCase()}]\n${quotedBody}`;
  activeEditor.commands.insertContent(renderMarkdownForEditorWithAssets(markdown));
}

function setHeadingLevel(level: number | null) {
  const chain = (editor.value as any)?.chain().focus();
  if (!chain) return;
  if (level === null) {
    chain.setParagraph().run();
    return;
  }
  chain.toggleHeading({ level }).run();
}

function insertImageByUrl() {
  insertMarkdownText("![图片描述](image-url)", 2, 6);
}

function insertParagraphAround(position: "before" | "after") {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return;
  const { $from } = state.selection;
  const insertAt = position === "before" ? $from.before() : $from.after();
  const tr = state.tr.insert(insertAt, paragraph.create());
  activeEditor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, insertAt + 1)).scrollIntoView());
  activeEditor.view.focus();
}

function runTableCommand(commandName: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const chain = activeEditor.chain().focus();
  switch (commandName) {
    case "addRowBefore":
      chain.addRowBefore().run();
      break;
    case "addRowAfter":
      chain.addRowAfter().run();
      break;
    case "addColumnBefore":
      chain.addColumnBefore().run();
      break;
    case "addColumnAfter":
      chain.addColumnAfter().run();
      break;
    case "deleteRow":
      chain.deleteRow().run();
      break;
    case "deleteColumn":
      chain.deleteColumn().run();
      break;
    case "deleteTable":
      chain.deleteTable().run();
      break;
    default:
      break;
  }
}

function insertTableRowAfterAndFocusFirstCell(view: any) {
  const activeEditor = editor.value as any;
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!activeEditor || !table || !activeCell || !view.dom.contains(table)) return false;
  const tableInfo = getSelectedTableInfo(view, table, activeCell);
  if (!tableInfo) return false;

  const row = activeCell.parentElement as HTMLTableRowElement | null;
  const rowIndex = row ? Array.from(table.rows).indexOf(row) : -1;
  if (rowIndex < 0) return false;

  const inserted = activeEditor.chain().focus().addRowAfter().run();
  if (!inserted) return false;

  window.setTimeout(() => {
    focusTableCellAt(tableInfo.pos, rowIndex + 1, 0);
  }, 0);

  return true;
}

function focusTableCellAt(tablePos: number, rowIndex: number, columnIndex: number) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return false;
  const { doc } = activeEditor.state;
  const cellStart = tableCellTextStart(doc, tablePos, rowIndex, columnIndex);
  if (typeof cellStart !== "number") return false;

  try {
    activeEditor.view.dispatch(
      activeEditor.state.tr
        .setSelection(TextSelection.near(activeEditor.state.doc.resolve(cellStart), 1))
        .scrollIntoView(),
    );
    activeEditor.view.focus();
    const tableDom = activeEditor.view.nodeDOM(tablePos);
    const table = tableDom instanceof HTMLTableElement
      ? tableDom
      : tableDom instanceof HTMLElement
        ? tableDom.querySelector("table")
        : null;
    const cell = table?.rows[rowIndex]?.cells[columnIndex] as HTMLTableCellElement | undefined;
    if (table instanceof HTMLTableElement && cell) updateTableControl(activeEditor.view, table, cell);
    return true;
  } catch {
    updateTableControl(activeEditor.view);
    return false;
  }
}

function tableCellTextStart(doc: any, tablePos: number, rowIndex: number, columnIndex: number) {
  const table = doc.nodeAt(tablePos);
  if (!table || table.type?.name !== "table") return null;

  let rowPos = tablePos + 1;
  for (let rowOffset = 0; rowOffset < table.childCount; rowOffset += 1) {
    const row = table.child(rowOffset);
    if (rowOffset !== rowIndex) {
      rowPos += row.nodeSize;
      continue;
    }

    let cellPos = rowPos + 1;
    for (let cellOffset = 0; cellOffset < row.childCount; cellOffset += 1) {
      const cell = row.child(cellOffset);
      if (cellOffset === columnIndex) {
        const firstChild = cell.firstChild;
        if (firstChild?.isTextblock) return cellPos + 2;
        return cellPos + 1;
      }
      cellPos += cell.nodeSize;
    }
  }

  return null;
}

function copyCurrentTable() {
  const table = getCurrentTableElement();
  if (!table) return;
  void writeClipboard(turndown.turndown(table.outerHTML).trim(), table.outerHTML);
}

function copyFormattedTableSource() {
  const table = getCurrentTableElement();
  if (!table) return;
  void writeClipboard(formatMarkdownTable(table));
}

function getCurrentTableElement() {
  const activeEditor = editor.value;
  if (!activeEditor) return null;
  try {
    const dom = activeEditor.view.domAtPos(activeEditor.state.selection.from).node;
    const element = dom instanceof HTMLElement ? dom : dom.parentElement;
    const selectedTable = element?.closest("table");
    if (selectedTable) return selectedTable;
  } catch {
    // Fall through to the floating-toolbar target.
  }
  if (tableControl.value.visible && tableControl.value.tablePos >= 0) {
    const dom = activeEditor.view.nodeDOM(tableControl.value.tablePos);
    if (dom instanceof HTMLTableElement) return dom;
    if (dom instanceof HTMLElement) {
      if (dom.matches("table")) return dom as HTMLTableElement;
      const table = dom.querySelector("table");
      if (table instanceof HTMLTableElement) return table;
    }
  }
  return null;
}

function formatMarkdownTable(table: HTMLTableElement) {
  const rows = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => normalizeTableCell(cell.textContent || "")),
  );
  if (!rows.length) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill("")]);
  const widths = Array.from({ length: columnCount }, (_item, index) =>
    Math.max(3, ...normalized.map((row) => row[index].length)),
  );
  const renderRow = (row: string[]) => `| ${row.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | ")} |`;
  const alignments = tableColumnAlignments(table, columnCount);
  const divider = widths.map((width, index) => markdownTableDividerForAlign(alignments[index], width));
  return [renderRow(normalized[0]), renderRow(divider), ...normalized.slice(1).map(renderRow)].join("\n");
}

function tableColumnAlignments(table: HTMLTableElement, columnCount: number) {
  return Array.from({ length: columnCount }, (_item, columnIndex) => {
    for (const row of Array.from(table.rows)) {
      const cell = row.cells[columnIndex];
      const align = cell ? parseTableCellAlign(cell) : null;
      if (align) return align;
    }
    return null;
  });
}

function markdownTableDividerForAlign(align: "left" | "center" | "right" | null, width = 3) {
  const dashes = "-".repeat(Math.max(3, width));
  if (align === "left") return `:${dashes}`;
  if (align === "center") return `:${dashes}:`;
  if (align === "right") return `${dashes}:`;
  return dashes;
}

function moveCurrentTableRow(direction: -1 | 1) {
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!table || !activeCell) return;
  const rowIndex = activeCell.parentElement ? Array.from(table.rows).indexOf(activeCell.parentElement as HTMLTableRowElement) : -1;
  const targetIndex = rowIndex + direction;
  if (rowIndex < 0 || targetIndex < 0 || targetIndex >= table.rows.length) return;
  swapTableRowContent(table.rows[rowIndex], table.rows[targetIndex]);
  replaceCurrentTableFromDom(table);
}

function moveCurrentTableColumn(direction: -1 | 1) {
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!table || !activeCell) return;
  const columnIndex = activeCell.cellIndex;
  const targetIndex = columnIndex + direction;
  if (targetIndex < 0) return;
  Array.from(table.rows).forEach((row) => {
    if (targetIndex >= row.cells.length) return;
    const left = row.cells[columnIndex];
    const right = row.cells[targetIndex];
    if (!left || !right) return;
    const temp = left.innerHTML;
    left.innerHTML = right.innerHTML;
    right.innerHTML = temp;
  });
  replaceCurrentTableFromDom(table);
}

function swapTableRowContent(a: HTMLTableRowElement, b: HTMLTableRowElement) {
  const valuesA = Array.from(a.cells).map((cell) => cell.innerHTML);
  const valuesB = Array.from(b.cells).map((cell) => cell.innerHTML);
  Array.from(a.cells).forEach((cell, index) => {
    cell.innerHTML = valuesB[index] || "";
  });
  Array.from(b.cells).forEach((cell, index) => {
    cell.innerHTML = valuesA[index] || "";
  });
}

function getCurrentTableCell() {
  const activeEditor = editor.value;
  if (!activeEditor) return null;
  try {
    const dom = activeEditor.view.domAtPos(activeEditor.state.selection.from).node;
    const element = dom instanceof HTMLElement ? dom : dom.parentElement;
    const cell = element?.closest("td,th") as HTMLTableCellElement | null;
    if (cell) return cell;
  } catch {
    // Fall through to no current cell.
  }
  return null;
}

function replaceCurrentTableFromDom(table: HTMLTableElement) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const resolved = table.isConnected
    ? resolveTableNodeFromDom(activeEditor.view, table, getCurrentTableCell())
    : null;
  const fallback = resolved ? null : getSelectedTableInfo(activeEditor.view);
  const pos = resolved?.pos ?? fallback?.pos;
  const node = resolved?.node ?? fallback?.node;
  if (typeof pos !== "number" || !node) return;
  (activeEditor as any).commands.insertContentAt({ from: pos, to: pos + node.nodeSize }, table.outerHTML);
}

function indentCode(scope: "selection" | "block", delta: 1 | -1) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const { from, to, $from } = state.selection;
  const blockFrom = scope === "block" ? $from.before() + 1 : from;
  const blockTo = scope === "block" ? $from.after() - 1 : to;
  const text = state.doc.textBetween(blockFrom, blockTo, "\n", "\n");
  const next = text
    .split("\n")
    .map((line) => (delta > 0 ? `  ${line}` : line.replace(/^ {1,2}/, "")))
    .join("\n");
  activeEditor.view.dispatch(state.tr.insertText(next, blockFrom, blockTo).scrollIntoView());
}

function deleteCodeBlock() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const { $from } = state.selection;
  if ($from.parent.type.name !== "codeBlock") return;
  activeEditor.view.dispatch(state.tr.delete($from.before(), $from.after()).scrollIntoView());
}

function looksLikeMarkdown(text: string) {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\||!\[[^\]]*\]\(|\[[^\]]+\]\(|\[\^[^\]]+\]:|\$\$)/.test(text) || /\[\^[^\]]+\]|`[^`\n]+`|\*\*[^*]+\*\*|\$[^$\n]+\$/.test(text) || containsInlineHtml(text);
}

function normalizeTableCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function normalizeFootnoteSource(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function editorHtmlToMarkdown(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const footnoteSources: string[] = [];

  document.querySelectorAll<HTMLElement>('span[data-type="footnote-ref"], sup[data-footnote-ref]').forEach((node) => {
    const id = node.dataset.footnoteRef || "";
    node.replaceWith(document.createTextNode(id ? `[^${id}]` : ""));
  });

  document.querySelectorAll<HTMLElement>('section[data-type="footnotes"]').forEach((node) => {
    const token = `@@LIGHTMARK_TURNDOWN_FOOTNOTE_${footnoteSources.length}@@`;
    footnoteSources.push(normalizeFootnoteSource(node.dataset.markdown || ""));
    node.replaceWith(document.createTextNode(token));
  });

  let markdown = turndown.turndown(document.body.innerHTML);
  footnoteSources.forEach((source, index) => {
    const token = `@@LIGHTMARK_TURNDOWN_FOOTNOTE_${index}@@`;
    markdown = markdown.split(token).join(source ? `\n\n${source}\n\n` : "");
  });
  return normalizeLeadingImageWhitespace(markdown);
}

function docPosToMarkdownOffset(state: any, pos: number, markdown: string) {
  const docSize = state.doc.content.size;
  const target = clampDocPos(pos, docSize);
  if (target <= 0) return 0;
  const prefix = trimSyntheticMarkdownClosers(serializeDocRangeToMarkdown(state, 0, target), state, target);
  return clampMarkdownOffset(prefix.length, markdown);
}

function trimSyntheticMarkdownClosers(prefix: string, state: any, pos: number) {
  const marks = activeMarksAtDocPos(state, pos);
  let next = prefix;
  if (marks.has("link")) next = next.replace(/\]\([^)\n]*\)$/, "");
  if (marks.has("bold")) next = trimSuffix(next, "**");
  if (marks.has("strike")) next = trimSuffix(next, "~~");
  if (marks.has("highlight")) next = trimSuffix(next, "==");
  if (marks.has("code")) next = trimSuffix(next, "`");
  if (marks.has("italic")) next = trimSuffix(next, "*");
  if (marks.has("superscript")) next = trimSuffix(next, "^");
  if (marks.has("subscript")) next = trimSuffix(next, "~");
  return next;
}

function activeMarksAtDocPos(state: any, pos: number) {
  const docSize = state.doc.content.size;
  const safePos = clampDocPos(pos, docSize);
  const resolved = state.doc.resolve(safePos);
  const marks = new Set<string>((resolved.marks?.() || []).map((mark: any) => mark.type.name));
  const before = safePos > 0 ? state.doc.resolve(safePos - 1).marks?.() || [] : [];
  before.forEach((mark: any) => marks.add(mark.type.name));
  return marks;
}

function trimSuffix(value: string, suffix: string) {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function serializeDocRangeToMarkdown(state: any, from: number, to: number) {
  if (to <= from) return "";
  const slice = state.doc.slice(from, to);
  const serializer = DOMSerializer.fromSchema(state.schema);
  const div = document.createElement("div");
  div.appendChild(serializer.serializeFragment(slice.content));
  return editorHtmlToMarkdown(div.innerHTML);
}

function markdownOffsetToDocPos(state: any, offset: number, markdown: string) {
  const targetPlainOffset = plainMarkdownLength(markdown.slice(0, clampMarkdownOffset(offset, markdown)));
  return textOffsetToDocumentPos(state, targetPlainOffset);
}

function textOffsetToDocumentPos(state: any, targetOffset: number) {
  let remaining = Math.max(0, targetOffset);
  let fallbackPos = 1;
  let found: number | null = null;

  state.doc.descendants((node: any, pos: number) => {
    if (found !== null) return false;
    if (node.isText && typeof node.text === "string") {
      fallbackPos = pos + node.nodeSize;
      if (remaining <= node.text.length) {
        found = pos + remaining;
        return false;
      }
      remaining -= node.text.length;
      return false;
    }
    if (node.isBlock && pos > 0) {
      fallbackPos = pos + 1;
      if (remaining === 0 && node.isTextblock) {
        found = pos + 1;
        return false;
      }
      if (pos > 0 && remaining > 0) remaining -= 1;
    }
    return true;
  });

  return found ?? fallbackPos;
}

function plainMarkdownLength(markdown: string) {
  return markdownToPlainText(markdown).length;
}

function markdownToPlainText(markdown: string) {
  return markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?=\n|$)/, "")
    .replace(/```[\w#+.-]*\n([\s\S]*?)\n```/g, "$1")
    .replace(/\$\$\s*\n?([\s\S]*?)\n?\s*\$\$/g, "$1")
    .replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/gim, "")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)([-*+]|\d+\.)\s+\[[ xX]\]\s+/gm, "")
    .replace(/^(\s*)([-*+]|\d+\.)\s+/gm, "")
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
    .replace(/\[\^([^\]\n]+)\]/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/\n{2,}/g, "\n");
}

function clampMarkdownOffset(value: number, markdown: string) {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, markdown.length));
}

function clampDocPos(value: number, docSize: number) {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, docSize));
}

function normalizeLeadingImageWhitespace(markdown: string) {
  return markdown
    .replace(/^\n+(?=!\[[^\]\n]*\]\([^)\n]+\))/g, "")
    .replace(/\n{3,}(?=!\[[^\]\n]*\]\([^)\n]+\))/g, "\n\n")
    .replace(/(!\[[^\]\n]*\]\([^)\n]+\))\n{3,}/g, "$1\n\n");
}

function renderFootnotesView(dom: HTMLElement, markdown: string, fallbackHtml: string) {
  dom.innerHTML = "";
  const source = markdown.trim();
  if (!source) {
    dom.innerHTML = fallbackHtml;
    return;
  }

  const list = document.createElement("ol");
  list.className = "footnotes-list";
  parseFootnoteSource(source).forEach((definition) => {
    const block = document.createElement("li");
    block.id = `fn-${definition.id}`;
    block.className = "footnote-item";
    const index = definition.order || definition.id;

    const marker = document.createElement("span");
    marker.className = "footnote-id";
    marker.textContent = `[${index}]`;

    const content = document.createElement("div");
    content.className = "footnote-content";
    content.innerHTML = renderMarkdownForEditorWithAssets(definition.content || " ");
    content.title = definition.refs.length > 0 ? "点击返回正文引用" : "";
    content.addEventListener("click", () => {
      const firstRef = definition.refs[0];
      if (firstRef) scrollInternalLink(`#${firstRef}`);
    });

    block.append(marker, content);
    const backrefs = document.createElement("div");
    backrefs.className = "footnote-backrefs";
    definition.refs.forEach((refId, index) => {
      const backref = document.createElement("button");
      backref.type = "button";
      backref.className = "footnote-backref";
      backref.dataset.footnoteTarget = `#${refId}`;
      backref.textContent = `返回${index + 1}`;
      backref.addEventListener("click", () => scrollInternalLink(`#${refId}`));
      backrefs.appendChild(backref);
    });
    block.appendChild(backrefs);
    list.appendChild(block);
  });
  dom.appendChild(list);
}

function parseFootnoteSource(markdown: string) {
  const definitions = markdown.split(/\n{2,}(?= {0,3}\[\^[^\]]+\]:)/).map((item) => item.trim()).filter(Boolean);
  const refMeta = collectFootnoteRefMeta();
  return definitions.map((raw, orderIndex) => {
    const id = raw.match(/^ {0,3}\[\^([^\]]+)\]:/)?.[1] || "";
    const content = raw
      .replace(/^ {0,3}\[\^[^\]]+\]:\s*/, "")
      .replace(/^\n+/, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^( {4}|\t)/, ""))
      .join("\n")
      .trim();
    const meta = refMeta.get(id);
    return { id, raw, content, refs: meta?.refs || [], order: meta?.order || orderIndex + 1 };
  }).sort((left, right) => left.order - right.order);
}

function collectFootnoteRefMeta() {
  const meta = new Map<string, { order: number; refs: string[] }>();
  document.querySelectorAll<HTMLElement>('span[data-type="footnote-ref"][data-footnote-ref][data-ref-id]').forEach((item) => {
    const id = item.dataset.footnoteRef || "";
    if (!id) return;
    const order = Number(item.dataset.footnoteIndex || meta.size + 1);
    const entry = meta.get(id) || { order, refs: [] };
    entry.order = Math.min(entry.order, order);
    if (item.dataset.refId) entry.refs.push(item.dataset.refId);
    meta.set(id, entry);
  });
  document.querySelectorAll<HTMLElement>('sup[data-footnote-ref][data-footnote-index]').forEach((item) => {
    const id = item.dataset.footnoteRef || "";
    if (!id) return;
    const order = Number(item.dataset.footnoteIndex || meta.size + 1);
    const entry = meta.get(id) || { order, refs: [] };
    entry.order = Math.min(entry.order, order);
    item.querySelectorAll<HTMLElement>("a[id]").forEach((link) => {
      if (link.id) entry.refs.push(link.id);
    });
    meta.set(id, entry);
  });
  return meta;
}

function formatFootnotePreview(value: string) {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function convertInlineCodeBeforeCursor(view: any) {
  const { state } = view;
  const { $from, empty } = state.selection;
  const codeMark = state.schema.marks.code;
  if (!empty || !codeMark || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;

  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const openerOffset = findInlineCodeOpener(before);
  if (openerOffset < 0) return false;

  const code = before.slice(openerOffset + 1);
  if (!code || /`/.test(code)) return false;

  const cursorPos = state.selection.from;
  const openerPos = cursorPos - (before.length - openerOffset);
  const tr = state.tr.insertText(code, openerPos, cursorPos);
  tr.addMark(openerPos, openerPos + code.length, codeMark.create());
  tr.removeStoredMark(codeMark);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function findInlineCodeOpener(text: string) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "`") continue;
    if (index > 0 && text[index - 1] === "\\") continue;
    return index;
  }
  return -1;
}

function createMarkDecorations(state: any, markName: string, open: string, close: string) {
  const range = getActiveMarkRange(state, markName);
  if (!range) return createStoredMarkDecorations(state, markName, open, close);
  return [
    Decoration.widget(range.from, () => createSourceMarker(open), createMarkerSpec(-1, `${markName}-open-${range.from}`)),
    Decoration.widget(range.to, () => createSourceMarker(close), createMarkerSpec(1, `${markName}-close-${range.to}`)),
  ];
}

function createStoredMarkDecorations(state: any, markName: string, open: string, close: string) {
  if (!state.selection.empty) return [];
  const markType = state.schema.marks[markName];
  if (!markType || !(state.storedMarks || []).some((mark: any) => mark.type === markType)) return [];

  const pos = state.selection.from;
  return [
    Decoration.widget(pos, () => createSourceMarker(open), createMarkerSpec(-1, `${markName}-stored-open-${pos}`)),
    Decoration.widget(pos, () => createSourceMarker(close), createMarkerSpec(1, `${markName}-stored-close-${pos}`)),
  ];
}

function createLinkDecorations(state: any) {
  const range = getActiveMarkRange(state, "link");
  if (!range) return [];
  const href = range.mark.attrs.href || "";
  return [
    Decoration.widget(range.from, () => createSourceMarker("["), createMarkerSpec(-1, `link-open-${range.from}`)),
    Decoration.widget(range.to, () => createSourceMarker(`](${href})`), createMarkerSpec(1, `link-close-${range.to}`)),
  ];
}

function createHeadingDecorations(state: any) {
  if (!state.selection.empty) return [];
  const { $from } = state.selection;
  if ($from.parent.type.name !== "heading") return [];

  const level = $from.parent.attrs.level || 1;
  return [
    Decoration.widget($from.start(), () => createSourceMarker(`${"#".repeat(level)} `), {
      side: -1,
      key: `heading-marker-${$from.before()}`,
      ignoreSelection: true,
    }),
  ];
}

function createOutlineHeadingDecorations(state: any) {
  const decorations: any[] = [];
  let index = 0;
  state.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "heading") return true;
    const text = sanitizeOutlineText(node.textContent);
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        "data-outline-id": `heading-${index}-${slugify(text)}`,
      }),
    );
    index += 1;
    return true;
  });
  return decorations;
}

function sanitizeOutlineText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").trim();
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
}

function getEventElement(event: Event) {
  const target = event.target;
  if (target instanceof HTMLElement) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
}

function convertPendingMarkdownBeforeMouseSelection(view: any, event: MouseEvent) {
  if (event.button !== 0 || !view.state.selection.empty) return false;

  const clickPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!clickPos || !isClickOutsideSelectionBlock(view.state, clickPos.pos)) return false;

  let tr =
    convertBlockquoteMarkdown(view.state, { force: true, onlySelectionBlock: true }) ||
    convertHorizontalRuleMarkdown(view.state, { force: true, onlySelectionBlock: true }) ||
    convertMarkdownHeading(view.state, { force: true, onlySelectionBlock: true }) ||
    convertInlineCodeSyntax(view.state, { onlySelectionBlock: true }) ||
    convertInlineMarkdownSyntax(view.state, { onlySelectionBlock: true });
  if (!tr) return false;

  const mappedPos = Math.max(0, Math.min(tr.mapping.map(clickPos.pos, clickPos.pos >= view.state.selection.from ? 1 : -1), tr.doc.content.size));
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mappedPos), clickPos.pos >= view.state.selection.from ? 1 : -1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  event.preventDefault();
  return true;
}

function isClickOutsideSelectionBlock(state: any, pos: number) {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return false;
  const blockFrom = $from.before();
  const blockTo = $from.after();
  return pos <= blockFrom || pos >= blockTo;
}

function scrollInternalLink(href: string) {
  if (!href.startsWith("#")) return;
  const id = decodeURIComponent(href.slice(1));
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function handleJumpHeading(event: CustomEvent<{ id?: string; text?: string }>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const id = event.detail?.id;
  const target = id ? document.querySelector<HTMLElement>(`.ProseMirror [data-outline-id="${cssEscape(id)}"]`) : null;
  const fallback = event.detail?.text ? findHeadingByText(event.detail.text) : null;
  (target || fallback)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function findHeadingByText(text: string) {
  const expected = normalizeHeadingText(text);
  return (
    Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6")).find((heading) => {
      return normalizeHeadingText(heading.textContent || "") === expected;
    }) || null
  );
}

function normalizeHeadingText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function openExternalLink(href: string) {
  try {
    await openUrl(href);
  } catch (error) {
    console.error("打开链接失败", error);
  }
}

function getActiveMarkRange(state: any, markName: string) {
  const markType = state.schema.marks[markName];
  if (!markType || !state.selection.empty) return null;

  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;

  const storedMark = (state.storedMarks || []).find((mark: any) => mark.type === markType);
  const activeMark = storedMark || $from.marks().find((mark: any) => mark.type === markType);
  if (!activeMark) return null;

  const parentStart = $from.start();
  const cursorOffset = $from.parentOffset;
  const children: Array<{ node: any; offset: number }> = [];
  $from.parent.forEach((node: any, offset: number) => children.push({ node, offset }));

  const hasActiveMark = (node: any) => Boolean(activeMark.isInSet(node.marks));
  let activeIndex = children.findIndex(({ node, offset }) => {
    return hasActiveMark(node) && cursorOffset >= offset && cursorOffset <= offset + node.nodeSize;
  });

  if (activeIndex < 0) {
    activeIndex = children.findIndex(({ node, offset }) => {
      return hasActiveMark(node) && (cursorOffset === offset || cursorOffset === offset + node.nodeSize);
    });
  }

  if (activeIndex < 0) return null;

  let startIndex = activeIndex;
  let endIndex = activeIndex;
  while (startIndex > 0 && hasActiveMark(children[startIndex - 1].node)) startIndex -= 1;
  while (endIndex < children.length - 1 && hasActiveMark(children[endIndex + 1].node)) endIndex += 1;

  const from = parentStart + children[startIndex].offset;
  const endChild = children[endIndex];
  const to = parentStart + endChild.offset + endChild.node.nodeSize;
  const atRightBoundary = cursorOffset === endChild.offset + endChild.node.nodeSize;
  if (!storedMark && atRightBoundary) return null;
  return { from, to, mark: activeMark };
}

function moveOutOfMarkAtRightBoundary(view: any, markNames: string[]) {
  const { state } = view;
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return false;

  for (const markName of markNames) {
    const markType = state.schema.marks[markName];
    if (!markType) continue;

    const cursorOffset = $from.parentOffset;
    let boundary = false;
    $from.parent.forEach((node: any, offset: number) => {
      if (boundary || cursorOffset !== offset + node.nodeSize) return;
      boundary = node.marks.some((mark: any) => mark.type === markType);
    });
    if (!boundary) continue;

    let tr = state.tr.setSelection(TextSelection.create(state.doc, state.selection.from));
    tr = tr.removeStoredMark(markType).setStoredMarks([]);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

function exitEmptyStoredFormattingOnBackspace(view: any) {
  const { state } = view;
  if (!state.selection.empty) return false;
  const activeStoredMarks = (state.storedMarks || []).filter((mark: any) => typoraInlineMarkNames.includes(mark.type.name));
  if (!activeStoredMarks.length) return false;

  const hasRenderedContent = activeStoredMarks.some((mark: any) => getActiveMarkRange(state, mark.type.name));
  if (hasRenderedContent) return false;

  let tr = state.tr.setStoredMarks([]);
  activeStoredMarks.forEach((mark: any) => {
    tr = tr.removeStoredMark(mark.type);
  });
  view.dispatch(tr.scrollIntoView());
  return true;
}

function clearStoredMarks(view: any, markNames: string[]) {
  const { state } = view;
  let tr = state.tr;
  let changed = false;
  markNames.forEach((markName) => {
    const markType = state.schema.marks[markName];
    if (!markType) return;
    tr = tr.removeStoredMark(markType);
    changed = true;
  });
  if (changed) view.dispatch(tr);
}

function createMarkerSpec(side: -1 | 1, key: string) {
  return { side, key, ignoreSelection: true };
}

function createSourceMarker(text: string) {
  const marker = document.createElement("span");
  marker.className = "md-live-marker";
  marker.textContent = text;
  marker.contentEditable = "false";
  marker.draggable = false;
  return marker;
}

function convertInlineMarkdownSyntax(state: any, options: { onlySelectionBlock?: boolean } = {}) {
  const { onlySelectionBlock = false } = options;
  const linkMark = state.schema.marks.link;
  const converters = [
    {
      mark: state.schema.marks.bold,
      pattern: /(?<!\*)\*\*([^*\n]+)\*\*/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.italic,
      pattern: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.strike,
      pattern: /(?<!~)~~([^~\n]+)~~/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.highlight,
      pattern: /(?<!=)==([^=\n]+)==/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.superscript,
      pattern: /(?<!\^)\^([^^\n]+)\^/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: state.schema.marks.subscript,
      pattern: /(?<!~)~([^~\n]+)~(?!~)/g,
      labelIndex: 1,
      attrs: () => ({}),
    },
    {
      mark: linkMark,
      pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
      labelIndex: 1,
      attrs: (match: RegExpExecArray) => ({ href: match[2] }),
    },
  ];

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;

    const text = node.textContent;
    for (const converter of converters) {
      if (!converter.mark) continue;
      converter.pattern.lastIndex = 0;
      const match = converter.pattern.exec(text);
      if (!match) continue;

      const full = match[0];
      const label = match[converter.labelIndex];
      const from = pos + 1 + match.index;
      const to = pos + 1 + match.index + full.length;

      tr = tr.insertText(label, from, to);
      tr = tr.addMark(from, from + label.length, converter.mark.create(converter.attrs(match)));
      tr = finishInlineMarkdownConversion(tr, state, from, to, from + label.length, converter.mark);
      converted = true;
      return false;
    }
    return true;
  });

  return converted ? tr : null;
}

function convertPendingInlineMarkdown(view: any) {
  let converted = false;
  for (let index = 0; index < 12; index += 1) {
    const tr = convertInlineCodeSyntax(view.state) || convertInlineMarkdownSyntax(view.state);
    if (!tr) break;
    view.dispatch(tr);
    converted = true;
  }
  return converted;
}

function convertInlineCodeSyntax(state: any, options: { onlySelectionBlock?: boolean } = {}) {
  const { onlySelectionBlock = false } = options;
  const codeMark = state.schema.marks.code;
  if (!codeMark) return null;

  let tr = state.tr;
  let converted = false;
  const inlineCodePattern = /`([^`\n]+)`/g;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock) return true;
    if (node.type.name === "codeBlock") return false;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;

    const text = node.textContent;
    inlineCodePattern.lastIndex = 0;
    const match = inlineCodePattern.exec(text);
    if (!match) return true;

    const full = match[0];
    const code = match[1];
    const from = pos + 1 + match.index;
    const to = pos + 1 + match.index + full.length;
    tr = tr.insertText(code, from, to);
    tr = tr.addMark(from, from + code.length, codeMark.create());
    tr = finishInlineMarkdownConversion(tr, state, from, to, from + code.length, codeMark);
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function finishInlineMarkdownConversion(tr: any, state: any, from: number, to: number, selectionPos: number, markType: any) {
  if (!state.selection.empty || state.selection.from < from || state.selection.from > to) return tr;

  tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos));
  if (markType) tr = tr.removeStoredMark(markType);
  return tr.setStoredMarks([]);
}

function convertMarkdownPipeTable(view: any) {
  const activeEditor = editor.value;
  if (!activeEditor) return false;
  const { state } = view;
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  const node = $from.parent;
  if (!node?.isTextblock || node.type.name === "codeBlock") return false;

  const html = markdownPipeRowToTableHtml(node.textContent);
  if (!html) return false;

  const from = $from.before();
  const to = $from.after();
  (activeEditor as any).commands.insertContentAt({ from, to }, html);
  window.setTimeout(() => {
    if (!focusTableCellAt(from, 1, 0)) updateTableControl(view);
  }, 0);
  return true;
}

function convertBlockquoteMarkdown(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false } = options;
  const blockquote = state.schema.nodes.blockquote;
  const paragraph = state.schema.nodes.paragraph;
  if (!blockquote || !paragraph) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const parentPos = state.doc.resolve(pos);
    const blockquoteRange = findParentBlockquote(parentPos);
    const insideBlockquote = Boolean(blockquoteRange);
    const text = node.textContent.trim();
    const canConvertInnerAlert = insideBlockquote && blockquoteRange && !blockquoteRange.node.attrs.alert;
    const alertMatch = canConvertInnerAlert
      ? text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i)
      : text.match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i);
    const quoteMatch = text.match(/^>\s+(.+)$/);

    if (alertMatch) {
      const kind = alertMatch[1].toLowerCase();
      const body = (alertMatch[2] || "").trim();
      const bodyParagraph = body ? paragraph.create(null, state.schema.text(body)) : paragraph.create();
      const content = [bodyParagraph];

      if (blockquoteRange) {
        const alertNode = blockquote.create({ ...blockquoteRange.node.attrs, alert: kind }, content);
        tr = tr.replaceWith(
          blockquoteRange.pos,
          blockquoteRange.pos + blockquoteRange.node.nodeSize,
          alertNode,
        );
        const selectionPos = blockquoteRange.pos + 2 + body.length;
        tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos));
      } else {
        const alertNode = blockquote.create({ alert: kind }, content);
        tr = tr.replaceWith(pos, pos + node.nodeSize, alertNode);
        const selectionPos = pos + 2 + body.length;
        tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos));
      }
      converted = true;
      return false;
    }

    if (!insideBlockquote && quoteMatch) {
      const quote = blockquote.create(null, paragraph.create(null, state.schema.text(quoteMatch[1])));
      tr = tr.replaceWith(pos, pos + node.nodeSize, quote);
      if (insertParagraph) {
        const after = pos + quote.nodeSize;
        tr = tr.insert(after, paragraph.create());
        tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
      }
      converted = true;
      return false;
    }

    return true;
  });

  return converted ? tr : null;
}

function findParentBlockquote($pos: any) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node?.type?.name === "blockquote") {
      return { node, pos: $pos.before(depth) };
    }
  }
  return null;
}

function convertMarkdownHeading(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false } = options;
  const heading = state.schema.nodes.heading;
  if (!heading) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;

    const match = node.textContent.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const level = match[1].length;
    const text = match[2];
    const headingNode = heading.create({ level }, state.schema.text(text), node.marks);
    tr = tr.replaceWith(pos, pos + node.nodeSize, headingNode);
    if (insertParagraph) {
      const paragraph = state.schema.nodes.paragraph;
      const after = pos + headingNode.nodeSize;
      if (paragraph) {
        tr = tr.insert(after, paragraph.create());
        tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
      }
    }
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function editHeadingAsMarkdown(view: any, element: HTMLElement) {
  const pos = view.posAtDOM(element, 0);
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "heading") return;

  let tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + node.nodeSize - 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function convertHorizontalRuleMarkdown(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false } = options;
  const horizontalRule = state.schema.nodes.horizontalRule;
  if (!horizontalRule) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;
    if (!/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(node.textContent)) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const rule = horizontalRule.create();
    tr = tr.replaceWith(pos, pos + node.nodeSize, rule);
    if (insertParagraph && state.schema.nodes.paragraph) {
      const after = pos + rule.nodeSize;
      tr = tr.insert(after, state.schema.nodes.paragraph.create());
      tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
    }
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function getTaskMarkAtSelection(state: any) {
  const taskMark = state.schema.marks.taskState;
  if (!taskMark || !state.selection.empty) return null;
  const { $from } = state.selection;
  return (state.storedMarks || $from.marks()).find((mark: any) => mark.type === taskMark) || null;
}

function continueTaskItem(view: any) {
  const taskMark = getTaskMarkAtSelection(view.state);
  if (!taskMark) return false;

  const listItem = view.state.schema.nodes.listItem;
  if (!listItem) return false;

  const splitCommand = (editor.value as any)?.commands?.splitListItem;
  if (typeof splitCommand === "function" && splitCommand("listItem")) {
    const { state } = view;
    const mark = state.schema.marks.taskState.create({ state: "unchecked" });
    const insertAt = state.selection.from;
    let tr = state.tr
      .insertText(" ", insertAt, insertAt)
      .addMark(insertAt, insertAt + 1, mark);
    tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

function replaceTocWithText(editor: any, getPos: (() => number | undefined) | boolean, value: string) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;
  const { state } = editor.view;
  const node = state.doc.nodeAt(pos);
  const paragraph = state.schema.nodes.paragraph;
  if (!node || !paragraph) return;

  const text = value.trim();
  const replacement = text ? paragraph.create(null, state.schema.text(text)) : paragraph.create();
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, replacement);
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

function toggleTaskItem(view: any, element: HTMLElement) {
  const state = view.state;
  const taskMark = state.schema.marks.taskState;
  if (!taskMark) return;

  const pos = view.posAtDOM(element.firstChild || element, 0);
  const from = Math.max(0, pos - 2);
  const to = Math.min(state.doc.content.size, pos + element.textContent.length + 2);
  let tr = state.tr;
  let handled = false;

  state.doc.nodesBetween(from, to, (node: any, nodePos: number) => {
    if (handled || !node.isText) return true;
    const mark = node.marks.find((candidate: any) => candidate.type === taskMark);
    if (!mark) return true;

    const checked = mark.attrs.state === "checked";
    const nextState = checked ? "unchecked" : "checked";
    const textFrom = nodePos;
    const textTo = nodePos + node.nodeSize;
    const nextText = node.text.replace(/^\s+/, "");
    tr = tr.insertText(nextText, textFrom, textTo);
    tr = tr.addMark(textFrom, textFrom + nextText.length, taskMark.create({ state: nextState }));
    handled = true;
    return false;
  });

  if (handled) view.dispatch(tr.scrollIntoView());
}

function createHorizontalRuleView(editing: boolean, editor: any, getPos: (() => number | undefined) | boolean) {
  const dom = document.createElement("div");
  dom.className = "typora-hr-node";
  dom.contentEditable = "false";

  const updateAttrs = (nextEditing: boolean) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { editing: nextEditing }));
  };

  const render = () => {
    dom.innerHTML = "";
    dom.className = editing ? "typora-hr-node typora-hr-node-editing" : "typora-hr-node";
    if (editing) {
      const marker = document.createElement("span");
      marker.className = "typora-hr-source";
      marker.textContent = "---";
      const line = document.createElement("span");
      line.className = "typora-hr-line";
      dom.append(marker, line);
    } else {
      dom.appendChild(document.createElement("hr"));
    }
  };

  dom.addEventListener("mousedown", (event) => {
    if (editing) return;
    event.preventDefault();
    editing = true;
    selectHorizontalRule(editor, getPos, true);
    render();
  });

  render();

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "horizontalRule") return false;
      editing = Boolean(nextNode.attrs.editing);
      render();
      return true;
    },
    selectNode() {
      editing = true;
      updateAttrs(true);
      render();
    },
    deselectNode() {
      if (!editing) return;
      editing = false;
      updateAttrs(false);
      render();
    },
    ignoreMutation: () => true,
  };
}

function selectHorizontalRule(editor: any, getPos: (() => number | undefined) | boolean, editing: boolean) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;
  const { state } = editor.view;
  const tr = state.tr
    .setSelection(NodeSelection.create(state.doc, pos))
    .setNodeMarkup(pos, undefined, { editing });
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
</script>

<template>
  <div
    ref="editorShell"
    class="lm-editor-scroll relative h-full overflow-auto"
    @click="handleEditorShellClick"
    @scroll="handleEditorShellScroll"
  >
    <EditorContent :editor="editor" />
    <div
      v-if="codeLanguageControl.visible"
      class="code-language-floating"
      :class="{ 'is-code-language-open': codeLanguageControl.open }"
      :style="{ left: `${codeLanguageControl.x}px`, top: `${codeLanguageControl.y}px` }"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @keydown.stop
    >
      <input
        ref="codeLanguageInput"
        class="code-language-field"
        :class="{ placeholder: !codeLanguageControl.language && !codeLanguageControl.open }"
        :value="codeLanguageControl.open ? codeLanguageControl.query : codeLanguageControl.language"
        placeholder="代码语言"
        title="代码语言"
        spellcheck="false"
        @focus="() => openFloatingCodeLanguageMenu()"
        @input="handleFloatingCodeLanguageInput"
        @keydown="handleFloatingCodeLanguageKeydown"
        @blur="handleFloatingCodeLanguageBlur"
      />
      <div v-if="codeLanguageControl.open" class="code-language-menu">
        <div class="code-language-list">
          <button
            v-for="(language, index) in floatingCodeLanguageCandidates"
            :key="language"
            type="button"
            class="code-language-option"
            :class="{ active: index === codeLanguageControl.highlightedIndex }"
            @mousedown.prevent.stop="applyFloatingCodeLanguage(language)"
          >
            {{ language }}
          </button>
          <div v-if="floatingCodeLanguageCandidates.length === 0" class="code-language-empty">
            {{ codeLanguageControl.query.trim() ? `使用 "${codeLanguageControl.query.trim().toLowerCase()}"` : "输入语言" }}
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="tableControl.visible"
      class="table-floating-toolbar"
      :style="{ left: `${tableControl.x}px`, top: `${tableControl.y}px` }"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @keydown.stop
      @contextmenu.prevent
    >
      <div class="table-floating-group">
        <button type="button" class="table-floating-button" title="调整表格" aria-label="调整表格" @click="openTableResizePanel">
          <span class="table-ico table-ico-grid" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button" title="左对齐" aria-label="左对齐" @click="runTableFloatingCommand(() => applyTableAlignment('left'))">
          <span class="table-ico table-ico-align-left" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button" title="居中" aria-label="居中" @click="runTableFloatingCommand(() => applyTableAlignment('center'))">
          <span class="table-ico table-ico-align-center" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button" title="右对齐" aria-label="右对齐" @click="runTableFloatingCommand(() => applyTableAlignment('right'))">
          <span class="table-ico table-ico-align-right" aria-hidden="true"></span>
        </button>
      </div>
      <div class="table-floating-group">
        <button type="button" class="table-floating-button" title="更多表格选项" aria-label="更多表格选项" @click="toggleTableMoreMenu">
          <span class="table-ico table-ico-more" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button table-floating-danger" title="删除表格" aria-label="删除表格" @click="runTableFloatingCommand(() => runTableCommand('deleteTable'))">
          <span class="table-ico table-ico-trash" aria-hidden="true"></span>
        </button>
      </div>

      <div v-if="tableControl.resizeOpen" class="table-resize-popover">
        <div class="table-resize-title">表格尺寸</div>
        <div class="table-resize-controls">
          <button type="button" aria-label="减少行" @click="setTableResizeDelta('rows', -1)"><UiIcon name="minus" :size="14" /></button>
          <span>{{ tableControl.rows }} 行</span>
          <button type="button" aria-label="增加行" @click="setTableResizeDelta('rows', 1)"><UiIcon name="plus" :size="14" /></button>
          <button type="button" aria-label="减少列" @click="setTableResizeDelta('columns', -1)"><UiIcon name="minus" :size="14" /></button>
          <span>{{ tableControl.columns }} 列</span>
          <button type="button" aria-label="增加列" @click="setTableResizeDelta('columns', 1)"><UiIcon name="plus" :size="14" /></button>
        </div>
        <form class="table-resize-form" @submit.prevent="applyTableResizeFromInput">
          <input
            :value="tableControl.resizeText"
            spellcheck="false"
            placeholder="4 x 6"
            @input="handleTableResizeTextInput"
          />
          <button type="submit">应用</button>
        </form>
        <div v-if="tableControl.resizeError" class="table-resize-error">{{ tableControl.resizeError }}</div>
      </div>

      <div v-if="tableControl.moreOpen" class="table-more-popover">
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addRowBefore'), false)">上方插入行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addRowAfter'), false)">下方插入行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addColumnBefore'), false)">左侧插入列</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addColumnAfter'), false)">右侧插入列</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableRow(-1), false)">上移该行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableRow(1), false)">下移该行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableColumn(-1), false)">左移该列</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableColumn(1), false)">右移该列</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('deleteRow'), false)">删除行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('deleteColumn'), false)">删除列</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(copyCurrentTable, false)">复制表格</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(copyFormattedTableSource, false)">格式化表格源码</button>
        <button class="lm-menu-item lm-menu-danger" @click="runTableFloatingCommand(() => runTableCommand('deleteTable'))">删除表格</button>
      </div>
    </div>
    <div
      v-if="contextMenu.visible"
      class="lm-context-menu"
      :class="{ 'lm-context-menu-left': contextMenu.flipX, 'lm-context-menu-up': contextMenu.flipY }"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @mousedown.prevent
      @contextmenu.prevent
    >
      <template v-if="contextMenu.mode === 'code'">
        <button class="lm-menu-item" @click="runMenuCommand(cutSelection)">剪切</button>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">复制</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsMarkdown)">以 Markdown 复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionClean)">简化格式并复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsHtml)">以 HTML 复制</button>
          </div>
        </div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">粘贴</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(false))">普通粘贴</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(true))">清洗格式并粘贴</button>
          </div>
        </div>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('selection', 1))">为选中内容增加缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('selection', -1))">为选中内容减少缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('block', 1))">为整个代码块增加缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('block', -1))">为整个代码块减少缩进</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item lm-menu-danger" @click="runMenuCommand(deleteCodeBlock)">删除代码块</button>
      </template>

      <template v-else>
        <button class="lm-menu-item" @click="runMenuCommand(cutSelection)">剪切</button>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">复制</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsMarkdown)">以 Markdown 复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionClean)">简化格式并复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsHtml)">以 HTML 复制</button>
          </div>
        </div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">粘贴</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(false))">普通粘贴</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(true))">清洗格式并粘贴</button>
          </div>
        </div>

        <div class="lm-menu-separator"></div>
        <div class="lm-format-grid" aria-label="格式">
          <button title="加粗" aria-label="加粗" @click="runMenuCommand(() => runFormatCommand('bold'))"><UiIcon name="bold" :size="16" /></button>
          <button title="斜体" aria-label="斜体" @click="runMenuCommand(() => runFormatCommand('italic'))"><UiIcon name="italic" :size="16" /></button>
          <button title="行内代码" aria-label="行内代码" @click="runMenuCommand(() => runFormatCommand('code'))"><UiIcon name="code" :size="16" /></button>
          <button title="链接" aria-label="链接" @click="runMenuCommand(toggleLink)"><UiIcon name="link" :size="16" /></button>
          <button title="引用" aria-label="引用" @click="runMenuCommand(() => runFormatCommand('blockquote'))"><UiIcon name="quote" :size="16" /></button>
          <button title="有序列表" aria-label="有序列表" @click="runMenuCommand(() => runFormatCommand('orderedList'))"><UiIcon name="list-ordered" :size="16" /></button>
          <button title="无序列表" aria-label="无序列表" @click="runMenuCommand(() => runFormatCommand('bulletList'))"><UiIcon name="list" :size="16" /></button>
          <button title="任务清单" aria-label="任务清单" @click="runMenuCommand(insertTaskItem)"><UiIcon name="list-checks" :size="16" /></button>
        </div>

        <div class="lm-menu-separator"></div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">GitHub 警示框</button>
          <div class="lm-menu-pop">
            <button
              v-for="alert in githubAlertKinds"
              :key="alert.kind"
              class="lm-menu-item"
              @click="runMenuCommand(() => insertGithubAlert(alert.kind))"
            >
              {{ alert.label }}
            </button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item" :class="{ 'lm-menu-disabled': !canUseTableMenu }">表格</button>
          <div class="lm-menu-pop lm-menu-pop-wide" v-if="canUseTableMenu">
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addRowBefore'))">上方插入行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addRowAfter'))">下方插入行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addColumnBefore'))">左侧插入列</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addColumnAfter'))">右侧插入列</button>
            <div class="lm-menu-separator"></div>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableRow(-1))">上移该行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableRow(1))">下移该行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableColumn(-1))">左移该列</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableColumn(1))">右移该列</button>
            <div class="lm-menu-separator"></div>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('deleteRow'))">删除行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('deleteColumn'))">删除列</button>
            <button class="lm-menu-item" @click="runMenuCommand(copyCurrentTable)">复制表格</button>
            <button class="lm-menu-item" @click="runMenuCommand(copyFormattedTableSource)">格式化表格源码</button>
            <button class="lm-menu-item lm-menu-danger" @click="runMenuCommand(() => runTableCommand('deleteTable'))">删除表格</button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item">插入</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(insertImageByUrl)">图片</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => insertParagraphAround('before'))">上方段落</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => insertParagraphAround('after'))">下方段落</button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item">标题</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(1))">一级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(2))">二级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(3))">三级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(4))">四级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(5))">五级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(6))">六级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(null))">正文</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
