import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import hljs from "highlight.js";
import {
  escapeAttribute,
  escapeHtml,
  decodeHtmlEntities,
  findInlineHtmlMatch,
  findRawHtmlMatch,
  isInlineHtmlTag,
  isRawHtmlToken,
  rawHtmlKind,
  renderInlineMarkdownInHtml,
  renderRawHtmlSource,
  sanitizeHtmlFragment,
  sanitizeInlineHtmlSource,
} from "./html";
import { exportThemeCssVariables, getExportThemePalette } from "./exportTheme";
import { renderWikiLinksInEscapedText } from "./wikiLinks";
import { renderMarkdownTables } from "./tableMarkdown";
import {
  evaluateMathTokens,
  evaluateMarkdownMath,
  parseInlineMathText,
  parseMarkdownMath,
} from "./mathMarkdown";
import type { MathNumberingMode } from "./mathMarkdown";
import { protectEnhancedImagesForEditor, protectEnhancedImagesForPreview, unwrapEnhancedImageParagraphs } from "./enhancedImages";

const LEADING_FRONT_MATTER_PATTERN = /^(?:\uFEFF)?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[^\S\r\n]*(?=\r?\n|$)/;

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(code, language) {
    const lang = language && hljs.getLanguage(language) ? language : "plaintext";
    const value = hljs.highlight(code, { language: lang }).value;
    return `<pre><code class="hljs language-${lang}">${value}</code></pre>`;
  },
});

installLightMarkMarkdown(md);

const editorMd = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});
installLightMarkMarkdown(editorMd, { preserveLightMarkInternal: true });

export function renderMarkdown(
  markdown: string,
  options: { mathNumbering?: MathNumberingMode } = {},
) {
  const placeholders: string[] = [];
  const stash = (html: string) => {
    const token = `@@LIGHTMARK_PLACEHOLDER_${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };
  const enhanced = enhanceMarkdownForRender(markdown, stash, options.mathNumbering);
  const withTables = renderMarkdownTables(enhanced, (source) => md.renderInline(source));
  return unwrapEnhancedImageParagraphs(restorePlaceholders(md.render(withTables), placeholders));
}

export function renderMarkdownForEditor(markdown: string) {
  const prepared = markSpecialBlocksForEditor(markdown);
  return editorMd.render(renderMarkdownTables(prepared, (source) => editorMd.renderInline(source)));
}

export function buildExportHtml(
  title: string,
  body: string,
  options: { includeStyles?: boolean; theme?: "light" | "dark"; currentPath?: string; extraStyles?: string } = {},
) {
  const includeStyles = options.includeStyles ?? true;
  const isDark = options.theme === "dark";
  const theme = isDark ? "dark" : "light";
  const palette = getExportThemePalette(theme);
  const baseHref = fileBaseHref(options.currentPath);
  const styles = includeStyles
    ? `
  <style>
    :root {
      --lm-editor-width: 860px;
      --lm-editor-font-family: "Open Sans", "Clear Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      --lm-editor-font-size: 16px;
      --lm-editor-line-height: 1.6;
      --lm-editor-paragraph-spacing: 0.8em;
      --lm-editor-code-font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
      ${exportThemeCssVariables(theme)}
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--lm-bg); color: var(--lm-text); }
    html { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    body { font-family: var(--lm-editor-font-family); text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
    main.markdown-preview { max-width: var(--lm-editor-width); margin: 0 auto; padding: 56px 32px; font-size: var(--lm-editor-font-size); line-height: var(--lm-editor-line-height); }
    p, blockquote, ul, ol, dl, table { margin: var(--lm-editor-paragraph-spacing) 0; }
    ul, ol { padding-left: 30px; }
    li > p { margin: 0; }
    h1, h2, h3, h4, h5, h6 { color: var(--lm-heading); font-weight: 700; line-height: 1.25; }
    h1 { margin: 1.45em 0 0.8em; padding-bottom: 0.28em; border-bottom: 1px solid var(--lm-border); font-size: 2em; }
    h2 { margin: 1.35em 0 0.72em; padding-bottom: 0.2em; border-bottom: 1px solid var(--lm-border-subtle); font-size: 1.55em; }
    h3 { margin: 1.2em 0 0.64em; font-size: 1.25em; }
    h4 { margin: 1.1em 0 0.56em; font-size: 1.1em; }
    h5, h6 { margin: 1em 0 0.5em; font-size: 1em; }
    hr { height: 1px; margin: 28px 0; border: 0; background: linear-gradient(90deg, transparent, var(--lm-border), transparent); }
    a { color: var(--lm-link); text-decoration-color: var(--lm-link-decoration); text-underline-offset: 3px; }
    blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid var(--lm-border); color: var(--lm-muted); }
    code { font-family: var(--lm-editor-code-font-family); }
    code:not(pre code) { border-radius: 5px; background: var(--lm-code-bg); color: var(--lm-code-text); padding: 0.12em 0.34em; font-size: 0.92em; }
    pre { overflow-x: hidden; margin: 1em 0; padding: 16px; border: 1px solid var(--lm-code-border); border-radius: 8px; background: var(--lm-surface-muted); color: var(--lm-code-text); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; break-inside: auto; page-break-inside: auto; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    pre code { display: block; padding: 0; background: transparent; color: inherit; font-size: 0.9em; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .hljs { background: transparent; color: var(--lm-code-text); }
    .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-tag, .hljs-doctag { color: ${isDark ? "#79b8ff" : "#005cc5"}; }
    .hljs-name, .hljs-title, .hljs-section, .hljs-function .hljs-title { color: ${isDark ? "#b392f0" : "#6f42c1"}; }
    .hljs-string, .hljs-literal, .hljs-template-variable, .hljs-regexp { color: ${isDark ? "#9ecbff" : "#032f62"}; }
    .hljs-attribute, .hljs-variable, .hljs-property, .hljs-params { color: ${isDark ? "#ffab70" : "#e36209"}; }
    .hljs-comment, .hljs-quote { color: ${isDark ? "#959da5" : "#6a737d"}; }
    .hljs-meta, .hljs-subst { color: ${isDark ? "#f97583" : "#735c0f"}; }
    .hljs-number, .hljs-symbol, .hljs-bullet, .hljs-link { color: ${isDark ? "#79b8ff" : "#005cc5"}; }
    .hljs-type, .hljs-class .hljs-title { color: ${isDark ? "#85e89d" : "#22863a"}; }
    img { max-width: 100%; height: auto; vertical-align: middle; }
    figure[data-lightmark-image] { max-width: 100%; }
    figure[data-lightmark-image] img { display: block; max-width: 100%; height: auto; }
    figure[data-lightmark-image] figcaption { margin-top: 0.42rem; color: var(--lm-muted); font-size: 0.88rem; text-align: center; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: auto; overflow-wrap: anywhere; font-size: 0.95em; break-inside: auto; page-break-inside: auto; }
    th, td { max-width: min(52rem, 100%); border: 1px solid var(--lm-border); padding: 8px 10px; overflow-wrap: anywhere; word-break: break-word; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th { background: var(--lm-table-header-bg); font-weight: 650; }
    tr:nth-child(2n) { background: var(--lm-table-stripe-bg); }
    mark { border-radius: 3px; background: var(--lm-mark-bg); color: inherit; padding: 0.05em 0.16em; }
    .front-matter-node { margin: 1em 0; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--lm-border) 62%, transparent); background: color-mix(in srgb, var(--lm-front-matter-bg) 46%, transparent); color: var(--lm-muted); box-shadow: none; }
    .front-matter-node pre { margin: 0; border: 0; background: transparent; color: inherit; }
    .front-matter-fence { padding: 5px 12px; font-family: var(--lm-editor-code-font-family); font-size: 11px; color: color-mix(in srgb, var(--lm-muted) 72%, transparent); }
    .markdown-alert { margin: 16px 0; padding: 8px 16px; border-left: 4px solid #8c959f; border-radius: 0 6px 6px 0; background: var(--lm-alert-bg); page-break-inside: avoid; }
    .markdown-alert::before { display: block; margin: 0 0 8px; font-weight: 700; line-height: 1.4; }
    .markdown-alert-title { display: none; }
    .markdown-alert-note { border-left-color: #0969da; background: var(--lm-alert-note-bg); }
    .markdown-alert-note::before { content: "Note"; color: #0969da; }
    .markdown-alert-tip { border-left-color: #1a7f37; background: var(--lm-alert-tip-bg); }
    .markdown-alert-tip::before { content: "Tip"; color: #1a7f37; }
    .markdown-alert-important { border-left-color: #8250df; background: var(--lm-alert-important-bg); }
    .markdown-alert-important::before { content: "Important"; color: #8250df; }
    .markdown-alert-warning { border-left-color: #bf8700; background: var(--lm-alert-warning-bg); }
    .markdown-alert-warning::before { content: "Warning"; color: #9a6700; }
    .markdown-alert-caution { border-left-color: #cf222e; background: var(--lm-alert-caution-bg); }
    .markdown-alert-caution::before { content: "Caution"; color: #cf222e; }
    .mermaid-export { display: flex; justify-content: center; margin: 1.2em 0; page-break-inside: avoid; }
    .mermaid-export svg { max-width: 100%; height: auto; }
    .mermaid-export-error { margin: 1em 0; white-space: pre-wrap; }
    @page { size: A4; margin: 20mm; background: ${palette.bg}; }
    @media print {
      html, body { background: var(--lm-bg); color: var(--lm-text); }
      main.markdown-preview { max-width: none; padding: 0; }
      pre { overflow: visible; white-space: pre-wrap; }
      pre code { white-space: pre-wrap; overflow-wrap: anywhere; }
      table, pre { break-inside: auto; page-break-inside: auto; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; page-break-inside: avoid; }
      h1, h2, h3, h4, h5, h6, blockquote, .markdown-alert, .mermaid-export, .katex-display, .katex-display-export { break-inside: avoid; }
      a { color: inherit; }
      img { max-height: 220mm; object-fit: contain; break-inside: avoid; page-break-inside: avoid; }
      figure { break-inside: avoid; page-break-inside: avoid; }
    }
    ${options.extraStyles ?? ""}
  </style>`
    : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${baseHref ? `<base href="${escapeAttribute(baseHref)}" />` : ""}
  <title>${escapeHtml(title)}</title>
  ${styles}
</head>
<body><main class="markdown-preview">${body}</main></body>
</html>`;
}

function fileBaseHref(currentPath: string | undefined) {
  if (!currentPath) return "";
  const normalized = currentPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return "";
  const folder = normalized.slice(0, slash + 1);
  const encoded = folder
    .split("/")
    .map((part, index) => {
      if (index === 0 && /^[A-Za-z]:$/.test(part)) return part;
      return encodeURIComponent(part);
    })
    .join("/");
  return `file:///${encoded.replace(/^\/+/, "")}`;
}

function markSpecialBlocksForEditor(markdown: string) {
  const placeholders: string[] = [];
  const stash = (html: string) => {
    const token = `@@LIGHTMARK_PLACEHOLDER_${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  let next = protectEnhancedImagesForEditor(markdown, stash);
  next = next.replace(LEADING_FRONT_MATTER_PATTERN, (_match, yaml) => {
    return `${stash(`<section data-type="front-matter" data-yaml="${escapeAttribute(yaml.trim())}"></section>`)}\n`;
  });

  next = next.replace(/(^|\n)\[TOC\]\s*(?=\n|$)/gi, (_match, prefix) => {
    return `${prefix}\n${stash(buildTocHtml(markdown).replace("class=\"toc-node\" ", ""))}\n`;
  });

  next = next.replace(/(^|\n)```mermaid\s*\n([\s\S]*?)\n```\s*(?=\n|$)/g, (_match, prefix, code) => {
    return `${prefix}\n${stash(`<div data-type="mermaid" data-code="${escapeHtml(code.trim())}"></div>`)}\n`;
  });

  next = convertFootnotes(next, stash, true);
  next = next.replace(/```[\s\S]*?```/g, (code) => stash(code));
  next = replaceInlineCodeSpans(next, (source, code) => {
    const delimiterLength = source.match(/^`+/)?.[0].length ?? 1;
    return stash(
      `<code data-code-raw="${escapeAttribute(source)}" data-code-original="${escapeAttribute(code)}" data-code-delimiter-length="${delimiterLength}">${escapeHtml(code)}</code>`,
    );
  });
  next = protectHtmlBlocks(next, stash);
  next = protectInlineHtml(next, stash);
  next = protectRawHtml(next, stash);
  next = protectMathForEditor(next, stash);
  next = protectEscapedDollarsForEditor(next, stash);

  next = next.replace(/==([^=\n]+)==/g, (_match, text) => {
    return `<mark>${renderInlineMarkdownInsideMark(text)}</mark>`;
  });

  next = next.replace(/(^|[^^\s])\^([^^\n]+)\^/g, (_match, prefix, text) => {
    return `${prefix}<sup>${escapeHtml(text)}</sup>`;
  });

  next = next.replace(/(^|[^~\s])~([^~\n]+)~/g, (_match, prefix, text) => {
    return `${prefix}<sub>${escapeHtml(text)}</sub>`;
  });

  next = convertTaskItems(next);
  next = convertDefinitionLists(next);

  next = restorePlaceholders(next, placeholders);

  return next;
}

function protectEscapedDollarsForEditor(value: string, stash: (html: string) => string) {
  return value.replace(/\\+\$/g, (raw) => {
    const slashCount = raw.length - 1;
    if (slashCount % 2 === 0) return raw;
    const display = `${"\\".repeat(Math.floor(slashCount / 2))}$`;
    return stash(
      `<span data-type="escaped-dollar" data-raw="${escapeAttribute(raw)}" data-display="${escapeAttribute(display)}">${escapeHtml(display)}</span>`,
    );
  });
}

function restorePlaceholders(value: string, placeholders: string[]) {
  let next = value;
  let changed = true;
  while (changed) {
    changed = false;
    placeholders.forEach((html, index) => {
      const token = `@@LIGHTMARK_PLACEHOLDER_${index}@@`;
      if (!next.includes(token)) return;
      next = next.split(token).join(html);
      changed = true;
    });
  }
  return next;
}

function enhanceMarkdownForRender(
  markdown: string,
  stash?: (html: string) => string,
  mathNumbering: MathNumberingMode = "none",
) {
  let next = stash ? protectEnhancedImagesForPreview(markdown, stash) : markdown;
  next = next.replace(LEADING_FRONT_MATTER_PATTERN, (_match, yaml) => {
    return `<section class="front-matter-node" data-type="front-matter" data-yaml="${escapeAttribute(yaml.trim())}"><div class="front-matter-fence">---</div><pre>${escapeHtml(yaml.trim())}</pre><div class="front-matter-fence">---</div></section>\n\n`;
  });
  next = next.replace(/(^|\n)\[TOC\]\s*(?=\n|$)/gi, (_match, prefix) => `${prefix}${buildTocHtml(markdown)}\n`);
  next = convertFootnotes(next);
  next = renderLatexMathForMarkdown(next, stash, mathNumbering);
  next = renderRawHtmlForPreview(next, stash);
  next = convertTaskItems(next);
  next = convertDefinitionLists(next);
  return next;
}

function installLightMarkMarkdown(instance: MarkdownIt, options: { preserveLightMarkInternal?: boolean } = {}) {
  instance.linkify.set({ fuzzyLink: true });
  instance.core.ruler.after("block", "lightmark_github_alerts", (state) => transformGithubAlerts(state.tokens, state.Token, state.md, state.env));

  instance.renderer.rules.text = (tokens, idx) => {
    const escaped = instance.utils.escapeHtml(tokens[idx].content);
    return isTextInsideInlineCodeHtml(tokens, idx) ? escaped : renderInlineEnhancements(escaped);
  };
  instance.renderer.rules.html_inline = (tokens, idx) => {
    const content = tokens[idx].content;
    if (options.preserveLightMarkInternal && isLightMarkInternalPlaceholder(content)) return content;
    if (isRawHtmlToken(content)) return renderRawHtmlSource(content);
    return renderInlineMarkdownInHtml(content, { inlineOnly: true });
  };
  instance.renderer.rules.html_block = (tokens, idx) => {
    const content = tokens[idx].content;
    if (options.preserveLightMarkInternal && isLightMarkInternalPlaceholder(content)) return content;
    if (isRawHtmlToken(content)) return renderRawHtmlSource(content);
    return renderInlineMarkdownInHtml(content);
  };

  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const language = token.info.trim().split(/\s+/)[0];
    if (language === "mermaid") {
      const content = instance.utils.escapeHtml(token.content);
      return `<pre class="mermaid">${content}</pre>`;
    }
    const content = trimFenceStructuralTrailingNewline(token.content);
    if (options.highlight) {
      const highlighted = options.highlight(content, language, token.attrs ? self.renderAttrs(token) : "");
      if (highlighted) return highlighted;
    }
    const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
    return `<pre><code${className}>${instance.utils.escapeHtml(content)}</code></pre>\n`;
  };
}

function isTextInsideInlineCodeHtml(tokens: Token[], index: number) {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (tokens[cursor].type !== "html_inline") continue;
    const source = tokens[cursor].content;
    depth += (source.match(/<code(?:\s[^>]*)?>/gi) || []).length;
    depth -= (source.match(/<\/code\s*>/gi) || []).length;
  }
  return depth > 0;
}

function trimFenceStructuralTrailingNewline(content: string) {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function renderInlineEnhancements(html: string) {
  const mathHtml: string[] = [];
  let protectedHtml = html;
  const tokens = parseInlineMathText(html)
    .map((token) => ({ ...token, tex: decodeHtmlEntities(token.tex) }));
  const evaluated = evaluateMathTokens(tokens);
  for (const entry of [...evaluated.entries].reverse()) {
    const { token, result: rendered } = entry;
    const replacement = rendered.ok
      ? rendered.html
      : `<span class="math-render-error" title="${escapeAttribute(rendered.error.message)}">${token.raw}</span>`;
    const placeholder = `@@LIGHTMARK_INLINE_MATH_${mathHtml.length}@@`;
    mathHtml.push(replacement);
    protectedHtml = `${protectedHtml.slice(0, token.from)}${placeholder}${protectedHtml.slice(token.to)}`;
  }
  let enhanced = renderWikiLinksInEscapedText(protectedHtml)
    .replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
    .replace(/(^|[^^\s])\^([^^\n]+)\^/g, "$1<sup>$2</sup>")
    .replace(/(^|[^~\s])~([^~\n]+)~/g, "$1<sub>$2</sub>")
    .replace(/:([a-z0-9_+-]+):/gi, (_match, name) => emojiMap[name] || `:${name}:`);
  mathHtml.forEach((value, index) => {
    enhanced = enhanced.split(`@@LIGHTMARK_INLINE_MATH_${index}@@`).join(value);
  });
  return enhanced;
}

function convertTaskItems(markdown: string) {
  return markdown.replace(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\](?:\s+(.*))?$/gm, (_match, indent, marker, checked, text = "") => {
    const isChecked = checked.toLowerCase() === "x";
    return `${indent}${marker} <span data-task-item="${isChecked ? "checked" : "unchecked"}">${text || "&nbsp;"}</span>`;
  });
}

function transformGithubAlerts(tokens: Token[], _TokenCtor: typeof Token, parser: MarkdownIt, env: unknown) {
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index].type !== "blockquote_open") continue;

    const paragraphOpen = tokens[index + 1];
    const inline = tokens[index + 2];
    const paragraphClose = tokens[index + 3];
    if (paragraphOpen?.type !== "paragraph_open" || inline?.type !== "inline" || paragraphClose?.type !== "paragraph_close") continue;

    const match = inline.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n([\s\S]*))?$/i);
    if (!match) continue;

    const kind = match[1].toLowerCase();
    const rest = (match[2] || "").trimStart();

    tokens[index].attrJoin("class", `markdown-alert markdown-alert-${kind}`);
    tokens[index].attrSet("data-alert", kind);
    const children: Token[] = [];
    parser.inline.parse(rest, parser, env, children);
    inline.content = "";
    inline.children = children;
  }
}

function isLightMarkInternalPlaceholder(html: string) {
  return /\sdata-type="(?:front-matter|mermaid|block-math|inline-math|inline-html|raw-html|html-block|footnote-ref|footnotes|table-of-contents|horizontal-rule)"/.test(html);
}

function convertDefinitionLists(markdown: string) {
  return markdown.replace(/(^|\n)([^\n:][^\n]+)\n:\s+([^\n]+)(?=\n|$)/g, (_match, prefix, term, definition) => {
    return `${prefix}<dl><dt>${escapeHtml(term.trim())}</dt><dd>${escapeHtml(definition.trim())}</dd></dl>`;
  });
}

function convertFootnotes(markdown: string, stash?: (html: string) => string, forEditor = false) {
  const definitions = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  const definitionOrder = new Map<string, number>();
  const definitionBlocks: Array<{ token: string; entries: Array<[string, string]> }> = [];
  const bodyLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const definition = parseFootnoteDefinitionAt(lines, index);
    if (!definition) {
      bodyLines.push(lines[index]);
      continue;
    }

    if (!definitionOrder.has(definition.id)) definitionOrder.set(definition.id, definitionOrder.size + 1);
    definitions.set(definition.id, definition.text);
    const token = `@@LIGHTMARK_FOOTNOTE_SECTION_${definitionBlocks.length}@@`;
    definitionBlocks.push({ token, entries: [[definition.id, definition.text]] });
    bodyLines.push(token);
    index = definition.nextIndex;
  }

  const referenceOrder = new Map<string, number>();
  const referenceCounts = new Map<string, number>();
  let next = protectCodeForFootnoteRefs(bodyLines.join("\n"));

  next = next.replace(/\[\^([^\]]+)\]/g, (_match, id) => {
    const safeId = escapeHtml(id);
    if (!referenceOrder.has(id)) referenceOrder.set(id, referenceOrder.size + 1);
    const order = referenceOrder.get(id) || 1;
    const count = (referenceCounts.get(id) || 0) + 1;
    referenceCounts.set(id, count);
    const preview = definitions.get(id) || "";
    if (forEditor) {
      return `<span data-type="footnote-ref" data-footnote-ref="${safeId}" data-footnote-index="${order}" data-ref-id="fnref-${safeId}-${count}" data-preview="${escapeAttribute(preview)}"></span>`;
    }
    return `<sup data-footnote-ref="${safeId}" data-footnote-index="${order}" data-preview="${escapeAttribute(preview)}"><a href="#fn-${safeId}" id="fnref-${safeId}-${count}" data-footnote-link="ref">[${order}]</a></sup>`;
  });
  next = restoreCodeForFootnoteRefs(next);

  if (definitions.size === 0 && referenceOrder.size === 0) return next;

  const missingDefinitions: Array<[string, string]> = [];
  referenceOrder.forEach((_order, id) => {
    if (definitions.has(id)) return;
    definitions.set(id, "");
    missingDefinitions.push([id, ""]);
  });

  definitionBlocks.forEach((block) => {
    const section = renderFootnoteSection(block.entries, referenceOrder, referenceCounts, definitionOrder, stash);
    next = next.split(block.token).join(section);
  });

  if (missingDefinitions.length > 0) {
    const missingSection = renderFootnoteSection(missingDefinitions, referenceOrder, referenceCounts, definitionOrder, stash);
    next = `${next.trimEnd()}\n\n${missingSection}\n\n`;
  }

  return next;
}

function parseFootnoteDefinitionAt(lines: string[], index: number) {
  const definition = lines[index].match(/^ {0,3}\[\^([^\]]+)\]:\s*(.*)$/);
  if (!definition) return null;

  const id = definition[1];
  const chunks = definition[2] ? [definition[2]] : [];
  while (index + 1 < lines.length && (lines[index + 1].trim() === "" || /^( {4,}|\t)/.test(lines[index + 1]))) {
    index += 1;
    if (lines[index].trim() === "") {
      chunks.push("");
    } else {
      chunks.push(lines[index].replace(/^( {4}|\t)/, ""));
    }
  }
  return { id, text: chunks.join("\n").trim(), nextIndex: index };
}

function renderFootnoteSection(
  entries: Array<[string, string]>,
  referenceOrder: Map<string, number>,
  referenceCounts: Map<string, number>,
  definitionOrder: Map<string, number>,
  stash?: (html: string) => string,
) {
  const items = entries
    .map(([id, text]) => {
      const safeId = escapeHtml(id);
      const order = referenceOrder.get(id) || definitionOrder.get(id) || 1;
      const count = referenceCounts.get(id) || 0;
      const backrefs = Array.from({ length: count }, (_item, index) => {
        return `<a href="#fnref-${safeId}-${index + 1}" class="footnote-backref" data-footnote-link="backref">返回${index + 1}</a>`;
      }).join(" ");
      return `<li id="fn-${safeId}" class="footnote-item"><span class="footnote-id">[${order}]</span><div class="footnote-content">${renderFootnoteContent(text)}</div><div class="footnote-backrefs">${backrefs}</div></li>`;
    })
    .join("");
  const source = entries.map(([id, text]) => formatFootnoteSource(id, text)).join("\n\n");
  const section = `<section class="footnotes" data-type="footnotes" data-markdown="${escapeAttribute(source)}"><ol class="footnotes-list">${items}</ol></section>`;
  return stash ? stash(section) : section;
}

function formatFootnoteSource(id: string, text: string) {
  const body = text.trim();
  if (!body) return `[^${id}]:`;
  if (!body.includes("\n")) return `[^${id}]: ${body}`;
  const indented = body
    .split("\n")
    .map((line) => (line ? `    ${line}` : ""))
    .join("\n");
  return `[^${id}]:\n\n${indented}`;
}

function protectCodeForFootnoteRefs(markdown: string) {
  const codePlaceholders: string[] = [];
  const stashCode = (code: string) => {
    const token = `@@LIGHTMARK_FOOTNOTE_CODE_${codePlaceholders.length}@@`;
    codePlaceholders.push(code);
    return token;
  };
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, (code) => stashCode(code));
  const protectedMarkdown = replaceInlineCodeSpans(withoutFences, (source) => stashCode(source));
  return `${protectedMarkdown}\n@@LIGHTMARK_FOOTNOTE_CODE_MAP_${codePlaceholders.map((item) => encodeURIComponent(item)).join("|")}@@`;
}

function replaceInlineCodeSpans(markdown: string, replacement: (source: string, code: string) => string) {
  const lines = markdown.split("\n");
  return lines.map((line) => {
    let output = "";
    let cursor = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] !== "`") {
        index += 1;
        continue;
      }
      let length = 1;
      while (line[index + length] === "`") length += 1;
      const delimiter = "`".repeat(length);
      const close = line.indexOf(delimiter, index + length);
      if (close < 0) {
        index += length;
        continue;
      }
      output += line.slice(cursor, index);
      const source = line.slice(index, close + length);
      output += replacement(source, line.slice(index + length, close));
      cursor = close + length;
      index = cursor;
    }
    return `${output}${line.slice(cursor)}`;
  }).join("\n");
}

function restoreCodeForFootnoteRefs(markdown: string) {
  const map = markdown.match(/\n@@LIGHTMARK_FOOTNOTE_CODE_MAP_([^@]*)@@$/);
  if (!map) return markdown;
  const codePlaceholders = map[1] ? map[1].split("|").map((item) => decodeURIComponent(item)) : [];
  let next = markdown.slice(0, map.index);
  codePlaceholders.forEach((code, index) => {
    next = next.split(`@@LIGHTMARK_FOOTNOTE_CODE_${index}@@`).join(code);
  });
  return next;
}

function renderFootnoteContent(markdown: string) {
  const source = markdown.trim();
  return source ? md.render(source) : "";
}

function buildTocHtml(markdown: string) {
  const items = markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^(#{1,6})\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const level = match[1].length;
      const text = escapeHtml(match[2].replace(/[#*_`[\]()]/g, "").trim());
      return `<div class="toc-node-item toc-node-item-${level}">${text}</div>`;
    })
    .join("");
  return `<nav class="toc-node" data-type="table-of-contents"><div class="toc-node-label">[TOC]</div>${items}</nav>`;
}

function protectMathForEditor(markdown: string, stash: (html: string) => string) {
  const { tokens } = parseMarkdownMath(markdown);
  let next = markdown;
  for (const token of [...tokens].reverse()) {
    const tag = token.kind === "display" && token.delimiter !== "inline-double-dollar" ? "div" : "span";
    const type = tag === "div" ? "block-math" : "inline-math";
    const html = `<${tag} data-type="${type}" data-tex="${escapeAttribute(token.tex)}" data-original-tex="${escapeAttribute(token.tex)}" data-math-raw="${escapeAttribute(token.raw)}" data-math-delimiter="${token.delimiter}" data-display-mode="${String(token.displayMode)}"></${tag}>`;
    next = `${next.slice(0, token.from)}${stash(html)}${next.slice(token.to)}`;
  }
  return next;
}

function renderLatexMathForMarkdown(
  markdown: string,
  stashRenderedHtml?: (html: string) => string,
  mathNumbering: MathNumberingMode = "none",
) {
  const evaluated = evaluateMarkdownMath(markdown, { numberingMode: mathNumbering });
  let next = markdown;
  for (const entry of [...evaluated.entries].reverse()) {
    const { token, result: rendered } = entry;
    const isBlock = token.kind === "display" && token.delimiter !== "inline-double-dollar";
    const renderedHtml = rendered.ok && entry.equationTarget
      ? rendered.html.replace(
          /class="katex-display"/,
          `id="${entry.equationTarget.id}" class="katex-display math-equation-target"`,
        )
      : rendered.ok ? rendered.html : "";
    const html = rendered.ok
      ? (entry.definitionOnly ? "" : renderedHtml)
      : `<${isBlock ? "div" : "span"} class="math-render-error" title="${escapeAttribute(rendered.error.message)}">${escapeHtml(token.raw)}</${isBlock ? "div" : "span"}>`;
    const replacement = stashRenderedHtml ? stashRenderedHtml(html) : html;
    next = `${next.slice(0, token.from)}${replacement}${next.slice(token.to)}`;
  }
  return next;
}

function protectHtmlBlocks(markdown: string, stash: (html: string) => string) {
  const lines = markdown.split("\n");
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const block = collectHtmlBlock(lines, index);
    if (!block) {
      result.push(lines[index]);
      continue;
    }

    result.push(stash(`<div data-type="html-block" data-html="${escapeAttribute(block.html.trim())}"></div>`));
    index = block.endIndex;
  }

  return result.join("\n");
}

function protectInlineHtml(markdown: string, stash: (html: string) => string) {
  let next = markdown;
  let match = findInlineHtmlMatch(next);
  while (match) {
    const html = sanitizeInlineHtmlSource(match.html);
    const placeholder = stash(`<span data-type="inline-html" data-html="${escapeAttribute(html)}"></span>`);
    next = `${next.slice(0, match.from)}${placeholder}${next.slice(match.to)}`;
    match = findInlineHtmlMatch(next);
  }
  return next;
}

function renderInlineMarkdownInsideMark(value: string) {
  return escapeHtml(value).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
}

function protectRawHtml(markdown: string, stash: (html: string) => string) {
  let next = markdown;
  let match = findRawHtmlMatch(next);
  while (match) {
    const kind = rawHtmlKind(match.html);
    const placeholder = stash(`<span data-type="raw-html" data-kind="${kind}" data-html="${escapeAttribute(match.html)}"></span>`);
    next = `${next.slice(0, match.from)}${placeholder}${next.slice(match.to)}`;
    match = findRawHtmlMatch(next);
  }
  return next;
}

function renderRawHtmlForPreview(markdown: string, stash?: (html: string) => string) {
  let next = markdown;
  let match = findRawHtmlMatch(next);
  while (match) {
    const raw = renderRawHtmlSource(match.html);
    next = `${next.slice(0, match.from)}${stash ? stash(raw) : raw}${next.slice(match.to)}`;
    match = findRawHtmlMatch(next);
  }
  return next;
}

function collectHtmlBlock(lines: string[], startIndex: number) {
  const first = lines[startIndex];
  const open = first.match(/^ {0,3}<([a-zA-Z][\w-]*)(?:\s[^>]*)?>\s*$/) || first.match(/^ {0,3}<([a-zA-Z][\w-]*)(?:\s[^>]*)?>/);
  if (!open) return null;

  const tag = open[1].toLowerCase();
  if (isRawHtmlBlockTag(tag)) return null;
  if (isInlineHtmlTag(tag)) return null;
  if (isHtmlVoidBlock(tag) || /\/>\s*$/.test(first)) return { html: first, endIndex: startIndex };

  const stack: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const tagPattern = /<\/?\s*([a-zA-Z][\w-]*)(?:\s[^>]*)?\s*\/?>/g;
    let match = tagPattern.exec(line);
    while (match) {
      const raw = match[0];
      const name = match[1].toLowerCase();
      if (!isInlineHtmlTag(name) && !isHtmlVoidBlock(name)) {
        if (/^<\s*\//.test(raw)) {
          const pos = stack.lastIndexOf(name);
          if (pos >= 0) stack.splice(pos, 1);
        } else if (!/\/\s*>$/.test(raw)) {
          stack.push(name);
        }
      }
      match = tagPattern.exec(line);
    }

    if (stack.length === 0) {
      return { html: lines.slice(startIndex, index + 1).join("\n"), endIndex: index };
    }
  }

  return null;
}

function isHtmlVoidBlock(tag: string) {
  return tag === "hr";
}

function isRawHtmlBlockTag(tag: string) {
  return /^(script|object|embed|input|button|select|option|label)$/i.test(tag);
}

const emojiMap: Record<string, string> = {
  smile: "😄",
  grin: "😁",
  joy: "😂",
  wink: "😉",
  heart: "❤️",
  thumbsup: "👍",
  thumbs_up: "👍",
  fire: "🔥",
  rocket: "🚀",
  warning: "⚠️",
  check: "✅",
  x: "❌",
  star: "⭐",
  bulb: "💡",
  memo: "📝",
};
