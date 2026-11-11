import TurndownService from 'turndown';
import { DOMSerializer, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { markdownTopLevelSourceBlocks } from '../utils/markdown';
import { combinePreservedSourceBlocks, inspectSourceEnvelope, sourceBlocksForNodes } from './sourcePreservation';
import { parseWikiLinkHref, wikiLinkMarkdown } from '../utils/wikiLinks';
import { decodeHtmlEntities, sanitizeInlineHtmlSource } from '../utils/html';
import { escapeMarkdownTableCell } from '../utils/tableMarkdown';
import { plainTextToLiteralMarkdown } from '../utils/smartPaste';
import { clampImageWidth, imageMarkdownOrFigure, parseEnhancedFigureElement, type ImageAlignment } from '../utils/enhancedImages';
import { mathTokenFromParts, serializeMathToken, type MathDelimiter } from '../utils/mathMarkdown';
import { tableColumnAlignments, markdownTableDividerForAlign } from './wysiwygTables';
const markdownImageSourceFromElement = (node: HTMLElement) => node.getAttribute('data-markdown-src') || node.getAttribute('src') || '';
let fineSourcePreserver: typeof import('./fineSourcePreservation')['preserveChangedBlock'] | undefined;
export async function prepareFineSourcePreservation() {
  fineSourcePreserver ??= (await import('./fineSourcePreservation')).preserveChangedBlock;
}
export function preserveFineSourceBlock(source: string, before: object, after: object) {
  return fineSourcePreserver?.(source, before as ProseMirrorNode, after as ProseMirrorNode) ?? null;
}

export function captureWysiwygSourceBaseline(markdown: string, doc: ProseMirrorNode) {
  const nodes: ProseMirrorNode[] = [];
  doc.forEach(node => nodes.push(node));
  const source = markdownTopLevelSourceBlocks(markdown);
  const alignment = sourceBlocksForNodes(source.blocks, nodes, source.prefix);
  const preservedMarkdownByNode = new WeakMap<object, string>();
  if (alignment) nodes.forEach((node, index) => {
    const block = alignment.blocks[index];
    if (!block.generated) preservedMarkdownByNode.set(node, block.source.replace(/^[\r\n]+|[\r\n]+$/g, ''));
  });
  return { doc, markdown, nodes, blocks: alignment?.blocks ?? source.blocks, preservedMarkdownByNode, aligned: Boolean(alignment), syntheticTailOmitted: alignment?.syntheticTailOmitted ?? false, prefix: alignment?.prefix ?? source.prefix, lineEnding: inspectSourceEnvelope(markdown).lineEnding };
}

export type WysiwygSourceBaseline = ReturnType<typeof captureWysiwygSourceBaseline>;

export function serializePreservedDocument(doc: ProseMirrorNode, baseline: WysiwygSourceBaseline) {
  if (doc === baseline.doc) return baseline.markdown;
  if (!baseline.aligned) throw new Error('源码范围与文档模型无法对应，已保留当前编辑和历史。');
  const nodes: ProseMirrorNode[] = [];
  const serialized: string[] = [];
  doc.forEach(node => {
    nodes.push(node);
    const preserved = baseline.preservedMarkdownByNode.get(node);
    if (preserved != null) { serialized.push(preserved); return; }
    const container = document.createElement('div');
    container.appendChild(DOMSerializer.fromSchema(doc.type.schema).serializeNode(node));
    serialized.push(editorHtmlToMarkdown(container.innerHTML).replace(/^\n+|\n+$/g, ''));
  });
  return combinePreservedSourceBlocks(baseline.nodes, baseline.blocks, nodes, serialized, baseline.prefix, baseline.lineEnding, baseline.syntheticTailOmitted, preserveFineSourceBlock);
}

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

function normalizeCodeLanguage(input: string | null | undefined) {
  const value = (input || "").trim().toLowerCase();
  if (!value) return "";
  return codeLanguageAliases.get(value) || "";
}

function displayCodeLanguage(input: string | null | undefined) {
  const value = (input || "").trim();
  return normalizeCodeLanguage(value) || value;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.escape = (text) => text;

turndown.addRule("plainPaste", {
  filter: (node) => node instanceof HTMLElement && node.dataset.plainPaste === "true",
  replacement: (_content, node) => plainTextToLiteralMarkdown(node.textContent || "").replace(/\t/g, "@@LIGHTMARK_PLAIN_TAB@@"),
});

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
    // Keep the source value in the Markdown data path.  Display rendering
    // applies the sanitizer separately; sanitizing here would silently drop
    // recoverable tags from a user edit.
    return `\n\n${html.trim()}\n\n`;
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
    if (!(node instanceof HTMLElement)) return `$${tex}$`;
    const delimiter = (node.dataset.mathDelimiter || "inline-dollar") as MathDelimiter;
    const raw = node.dataset.mathRaw || "";
    const originalTex = node.dataset.originalTex ?? tex;
    const token = mathTokenFromParts({
      tex: originalTex,
      delimiter,
      raw,
      displayMode: node.dataset.displayMode === "true",
    });
    return serializeMathToken(token, tex, Boolean(raw) && tex === originalTex);
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
      Array.from(row.cells).map(serializeTableCell),
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
    if (!(node instanceof HTMLElement)) return `\n\n$$\n${tex}\n$$\n\n`;
    const delimiter = (node.dataset.mathDelimiter || "display-dollar") as MathDelimiter;
    const raw = node.dataset.mathRaw || "";
    const originalTex = node.dataset.originalTex ?? tex;
    const token = mathTokenFromParts({ tex: originalTex, delimiter, raw, displayMode: true });
    return `\n\n${serializeMathToken(token, tex, Boolean(raw) && tex === originalTex)}\n\n`;
  },
});

turndown.addRule("inlineCodeExact", {
  filter: (node) => node instanceof HTMLElement && node.nodeName === "CODE" && node.parentElement?.nodeName !== "PRE",
  replacement: (content, node) => {
    if (!(node instanceof HTMLElement)) return `\`${content}\``;
    const raw = node.dataset.codeRaw || "";
    const originalText = node.dataset.codeOriginal ?? content;
    if (raw && content === originalText) return raw;
    const longestRun = Math.max(0, ...(content.match(/`+/g) || []).map((run) => run.length));
    const preferred = Number.parseInt(node.dataset.codeDelimiterLength || "1", 10) || 1;
    const delimiter = "`".repeat(Math.max(preferred, longestRun + 1));
    const padded = /^`|`$|^ .* $/.test(content) ? ` ${content} ` : content;
    return `${delimiter}${padded}${delimiter}`;
  },
});

turndown.addRule("escapedDollar", {
  filter: (node) => node instanceof HTMLElement && node.dataset.type === "escaped-dollar",
  replacement: (_content, node) => {
    return node instanceof HTMLElement ? node.dataset.raw || "\\$" : "\\$";
  },
});

turndown.addRule("image", {
  filter: "img",
  replacement: (_content, node) => {
    if (!(node instanceof HTMLElement)) return "";
    const src = markdownImageSourceFromElement(node).trim();
    if (!src) return "";
    if (node.hasAttribute("data-lightmark-width") || node.getAttribute("data-lightmark-align") !== "left" || node.hasAttribute("data-lightmark-caption")) {
      return imageMarkdownOrFigure({
        src,
        alt: node.getAttribute("alt") || "",
        title: node.getAttribute("title"),
        widthPx: clampImageWidth(node.getAttribute("data-lightmark-width")),
        alignment: (node.getAttribute("data-lightmark-align") || "left") as ImageAlignment,
        caption: node.getAttribute("data-lightmark-caption") || "",
      });
    }
    const alt = (node.getAttribute("alt") || "").replace(/]/g, "\\]");
    const title = node.getAttribute("title");
    const markdown = title ? `![${alt}](${src} "${title.replace(/"/g, '\\"')}")` : `![${alt}](${src})`;
    return markdown;
  },
});

turndown.addRule("lightmarkImageFigure", {
  filter: (node) => node instanceof HTMLElement && node.tagName === "FIGURE" && node.hasAttribute("data-lightmark-image"),
  replacement: (_content, node) => {
    if (!(node instanceof HTMLElement)) return "";
    const parsed = parseEnhancedFigureElement(node);
    return parsed ? `\n\n${imageMarkdownOrFigure(parsed)}\n\n` : "";
  },
});

function serializeTableCell(cell: HTMLTableCellElement) {
  const markdown = turndown.turndown(cell.innerHTML).replace(/\r?\n+/g, " ").trim();
  return escapeMarkdownTableCell(markdown);
}

function normalizeFootnoteSource(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function preserveMarkdownTerminalNewlines(markdown: string, previousMarkdown: string) {
  const terminalNewlines = previousMarkdown.match(/[\r\n]+$/)?.[0] ?? "";
  return `${markdown.replace(/[\r\n]+$/g, "")}${terminalNewlines}`;
}

function editorHtmlToMarkdown(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const footnoteSources: string[] = [];
  const frontMatterSources: string[] = [];
  const htmlBlockSources: string[] = [];

  document.querySelectorAll<HTMLElement>('[data-type="html-block"]').forEach((node) => {
    const token = `@@LIGHTMARK_TURNDOWN_HTML_BLOCK_${htmlBlockSources.length}@@`;
    htmlBlockSources.push(decodeHtmlEntities(node.getAttribute("data-html") || ""));
    node.replaceWith(document.createTextNode(token));
  });

  document.querySelectorAll<HTMLElement>('section[data-type="front-matter"]').forEach((node) => {
    const token = `@@LIGHTMARK_TURNDOWN_FRONT_MATTER_${frontMatterSources.length}@@`;
    frontMatterSources.push((node.dataset.yaml || node.textContent || "").replace(/\r\n?/g, "\n"));
    node.replaceWith(document.createTextNode(token));
  });

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
  markdown = markdown.replace(/@@LIGHTMARK_PLAIN_TAB@@/g, "\t");
  footnoteSources.forEach((source, index) => {
    const token = `@@LIGHTMARK_TURNDOWN_FOOTNOTE_${index}@@`;
    markdown = markdown.split(token).join(source ? `\n\n${source}\n\n` : "");
  });
  frontMatterSources.forEach((source, index) => {
    const token = `@@LIGHTMARK_TURNDOWN_FRONT_MATTER_${index}@@`;
    markdown = markdown.split(token).join(`---\n${source.replace(/^\n+|\n+$/g, "")}\n---\n\n`);
  });
  htmlBlockSources.forEach((source, index) => {
    const token = `@@LIGHTMARK_TURNDOWN_HTML_BLOCK_${index}@@`;
    markdown = markdown.split(token).join(source.replace(/^\n+|\n+$/g, ""));
  });
  markdown = markdown.replace(/^(\s*(?:[-*+]|\d+[.)]))[ \t]*\u00a0(?=\[[ xX]\])/gm, "$1 ");
  return normalizeLeadingImageWhitespace(markdown);
}

function normalizeLeadingImageWhitespace(markdown: string) {
  return markdown
    .replace(/^\n+(?=!\[[^\]\n]*\]\([^)\n]+\))/g, "")
    .replace(/\n{3,}(?=!\[[^\]\n]*\]\([^)\n]+\))/g, "\n\n")
    .replace(/(!\[[^\]\n]*\]\([^)\n]+\))\n{3,}/g, "$1\n\n");
}
export { removeGithubAlertTitle, serializeGithubAlertBody, serializeTableCell, normalizeFootnoteSource, preserveMarkdownTerminalNewlines, editorHtmlToMarkdown, normalizeLeadingImageWhitespace, normalizeCodeLanguage, displayCodeLanguage, codeLanguageItems, codeLanguageNames };
