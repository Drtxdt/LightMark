import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import hljs from "highlight.js";
import {
  escapeAttribute,
  escapeHtml,
  findInlineHtmlMatch,
  isInlineHtmlTag,
  renderInlineMarkdownInHtml,
  sanitizeHtmlFragment,
  sanitizeInlineHtmlSource,
} from "./html";

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

md.use(markdownItKatex);
installLightMarkMarkdown(md);

const editorMd = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});
installLightMarkMarkdown(editorMd, { preserveLightMarkInternal: true });

export function renderMarkdown(markdown: string) {
  return md.render(enhanceMarkdownForRender(markdown));
}

export function renderMarkdownForEditor(markdown: string) {
  return editorMd.render(markSpecialBlocksForEditor(markdown));
}

export function buildExportHtml(title: string, body: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; background: #fbfaf7; color: #1f1e1b; font: 16px/1.78 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 860px; margin: 0 auto; padding: 56px 24px; min-height: 100vh; }
    pre { overflow: auto; padding: 16px; border-radius: 8px; background: #1b1a18; color: #e8e5df; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #d5d0c6; color: #756f66; }
    img { max-width: 100%; }
    a { color: inherit; text-decoration-color: #b9b3a8; text-underline-offset: 3px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function markSpecialBlocksForEditor(markdown: string) {
  const placeholders: string[] = [];
  const stash = (html: string) => {
    const token = `@@LIGHTMARK_PLACEHOLDER_${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  let next = normalizeLatexMathDelimiters(markdown).replace(/^---\s*\n([\s\S]*?)\n---\s*(?=\n|$)/, (_match, yaml) => {
    return `${stash(`<section data-type="front-matter" data-yaml="${escapeAttribute(yaml.trim())}"></section>`)}\n`;
  });

  next = next.replace(/(^|\n)\[TOC\]\s*(?=\n|$)/gi, (_match, prefix) => {
    return `${prefix}\n${stash(buildTocHtml(markdown).replace("class=\"toc-node\" ", ""))}\n`;
  });

  next = next.replace(/(^|\n)```mermaid\s*\n([\s\S]*?)\n```\s*(?=\n|$)/g, (_match, prefix, code) => {
    return `${prefix}\n${stash(`<div data-type="mermaid" data-code="${escapeHtml(code.trim())}"></div>`)}\n`;
  });

  next = next.replace(/(^|\n)\s*\$\$\s*\n([\s\S]*?)\n\s*\$\$\s*(?=\n|$)/g, (_match, prefix, tex) => {
    return `${prefix}\n${stash(`<div data-type="block-math" data-tex="${escapeHtml(tex.trim())}"></div>`)}\n`;
  });

  next = convertFootnotes(next, stash, true);
  next = next.replace(/```[\s\S]*?```/g, (code) => stash(code));
  next = next.replace(/`([^`\n]*)`/g, (_match, code) => {
    return stash(`<code>${escapeHtml(code)}</code>`);
  });
  next = protectInlineMath(next, stash);
  next = protectHtmlBlocks(next, stash);
  next = protectInlineHtml(next, stash);

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

function enhanceMarkdownForRender(markdown: string) {
  let next = normalizeLatexMathDelimiters(markdown).replace(/^---\s*\n([\s\S]*?)\n---\s*(?=\n|$)/, (_match, yaml) => {
    return `<section class="front-matter-node" data-type="front-matter" data-yaml="${escapeAttribute(yaml.trim())}"><div class="front-matter-fence">---</div><pre>${escapeHtml(yaml.trim())}</pre><div class="front-matter-fence">---</div></section>\n\n`;
  });
  next = next.replace(/(^|\n)\[TOC\]\s*(?=\n|$)/gi, (_match, prefix) => `${prefix}${buildTocHtml(markdown)}\n`);
  next = convertFootnotes(next);
  next = convertTaskItems(next);
  next = convertDefinitionLists(next);
  return next;
}

function installLightMarkMarkdown(instance: MarkdownIt, options: { preserveLightMarkInternal?: boolean } = {}) {
  instance.linkify.set({ fuzzyLink: true });

  instance.renderer.rules.text = (tokens, idx) => renderInlineEnhancements(instance.utils.escapeHtml(tokens[idx].content));
  instance.renderer.rules.html_inline = (tokens, idx) => {
    const content = tokens[idx].content;
    if (options.preserveLightMarkInternal && isLightMarkInternalPlaceholder(content)) return content;
    return renderInlineMarkdownInHtml(content, { inlineOnly: true });
  };
  instance.renderer.rules.html_block = (tokens, idx) => {
    const content = tokens[idx].content;
    if (options.preserveLightMarkInternal && isLightMarkInternalPlaceholder(content)) return content;
    return renderInlineMarkdownInHtml(content);
  };

  const defaultFenceRenderer = instance.renderer.rules.fence;
  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const language = token.info.trim().split(/\s+/)[0];
    if (language === "mermaid") {
      const content = instance.utils.escapeHtml(token.content);
      return `<pre class="mermaid">${content}</pre>`;
    }
    return defaultFenceRenderer ? defaultFenceRenderer(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

function renderInlineEnhancements(html: string) {
  return html
    .replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
    .replace(/(^|[^^\s])\^([^^\n]+)\^/g, "$1<sup>$2</sup>")
    .replace(/(^|[^~\s])~([^~\n]+)~/g, "$1<sub>$2</sub>")
    .replace(/:([a-z0-9_+-]+):/gi, (_match, name) => emojiMap[name] || `:${name}:`);
}

function convertTaskItems(markdown: string) {
  return markdown.replace(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\](?:\s+(.*))?$/gm, (_match, indent, marker, checked, text = "") => {
    const isChecked = checked.toLowerCase() === "x";
    return `${indent}${marker} <span data-task-item="${isChecked ? "checked" : "unchecked"}">${text || "&nbsp;"}</span>`;
  });
}

function isLightMarkInternalPlaceholder(html: string) {
  return /\sdata-type="(?:front-matter|mermaid|block-math|inline-math|inline-html|html-block|footnote-ref|footnotes|table-of-contents|horizontal-rule)"/.test(html);
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
  const protectedMarkdown = markdown
    .replace(/```[\s\S]*?```/g, (code) => stashCode(code))
    .replace(/`[^`\n]*`/g, (code) => stashCode(code));
  return `${protectedMarkdown}\n@@LIGHTMARK_FOOTNOTE_CODE_MAP_${codePlaceholders.map((item) => encodeURIComponent(item)).join("|")}@@`;
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

function protectInlineMath(markdown: string, stash: (html: string) => string) {
  return markdown
    .replace(/(^|[^$\\])\$\$([^$\n]+?)\$\$(?!\$)/g, (_match, prefix, tex) => {
      return `${prefix}${stash(`<span data-type="inline-math" data-tex="${escapeHtml(tex.trim())}"></span>`)}`;
    })
    .replace(/(^|[^$\\])\$([^$\n]+?)\$(?!\$)/g, (_match, prefix, tex) => {
      return `${prefix}${stash(`<span data-type="inline-math" data-tex="${escapeHtml(tex.trim())}"></span>`)}`;
    });
}

function normalizeLatexMathDelimiters(markdown: string) {
  const placeholders: string[] = [];
  const stash = (value: string) => {
    const token = `@@LIGHTMARK_MATH_SOURCE_${placeholders.length}@@`;
    placeholders.push(value);
    return token;
  };

  let next = markdown
    .replace(/```[\s\S]*?```/g, (code) => stash(code))
    .replace(/`[^`\n]*`/g, (code) => stash(code));

  next = next.replace(/(^|\n)\s*\\\[\s*([^\n]+?)\s*\\\]\s*(?=\n|$)/g, (_match, prefix, tex) => {
    return `${prefix}$$\n${tex.trim()}\n$$`;
  });
  next = next.replace(/(^|\n)\s*\\\[\s*\n([\s\S]*?)\n\s*\\\]\s*(?=\n|$)/g, (_match, prefix, tex) => {
    return `${prefix}$$\n${tex.trim()}\n$$`;
  });
  next = next.replace(
    /(^|\n)\s*\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?|split)\}\s*\n?([\s\S]*?)\n?\s*\\end\{\2\}\s*(?=\n|$)/g,
    (_match, prefix, environment, tex) => {
      return `${prefix}$$\n\\begin{${environment}}\n${tex.trim()}\n\\end{${environment}}\n$$`;
    },
  );
  next = next.replace(/(^|[^$\\])\$\$([^$\n]+?)\$\$(?!\$)/g, (_match, prefix, tex) => {
    if (!tex.trim()) return _match;
    return `${prefix}$${tex.trim()}$`;
  });

  placeholders.forEach((value, index) => {
    next = next.split(`@@LIGHTMARK_MATH_SOURCE_${index}@@`).join(value);
  });
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

function collectHtmlBlock(lines: string[], startIndex: number) {
  const first = lines[startIndex];
  const open = first.match(/^ {0,3}<([a-zA-Z][\w-]*)(?:\s[^>]*)?>\s*$/) || first.match(/^ {0,3}<([a-zA-Z][\w-]*)(?:\s[^>]*)?>/);
  if (!open) return null;

  const tag = open[1].toLowerCase();
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
  return tag === "hr" || tag === "input" || tag === "embed";
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
