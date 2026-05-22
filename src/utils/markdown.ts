import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import hljs from "highlight.js";

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
installLightMarkMarkdown(editorMd);

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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function markSpecialBlocksForEditor(markdown: string) {
  const placeholders: string[] = [];
  const stash = (html: string) => {
    const token = `@@LIGHTMARK_PLACEHOLDER_${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  let next = markdown.replace(/^---\s*\n([\s\S]*?)\n---\s*(?=\n|$)/, (_match, yaml) => {
    return `${stash(`<section data-type="front-matter" data-yaml="${escapeHtml(yaml.trim())}"></section>`)}\n`;
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

  next = next.replace(/```[\s\S]*?```/g, (code) => stash(code));
  next = next.replace(/`([^`\n]*)`/g, (_match, code) => {
    return stash(`<code>${escapeHtml(code)}</code>`);
  });

  next = protectInlineMath(next, stash);
  next = protectHtmlBlocks(next, stash);
  next = next.replace(/==([^=\n]+)==/g, (_match, text) => {
    return `<mark>${renderInlineMarkdownInsideMark(text)}</mark>`;
  });

  next = next.replace(/(^|[A-Za-z0-9)\]])\^([A-Za-z0-9+\-=().]+)\^/g, (_match, prefix, text) => {
    return `${prefix}<sup>${escapeHtml(text)}</sup>`;
  });

  next = next.replace(/(^|[A-Za-z0-9)\]])~([A-Za-z0-9+\-=().]+)~/g, (_match, prefix, text) => {
    return `${prefix}<sub>${escapeHtml(text)}</sub>`;
  });

  next = convertFootnotes(next);
  next = convertTaskItems(next);
  next = convertDefinitionLists(next);

  placeholders.forEach((html, index) => {
    next = next.replace(`@@LIGHTMARK_PLACEHOLDER_${index}@@`, html);
  });

  return next;
}

function enhanceMarkdownForRender(markdown: string) {
  let next = markdown.replace(/^---\s*\n([\s\S]*?)\n---\s*(?=\n|$)/, (_match, yaml) => {
    return `<section class="front-matter-node"><div class="front-matter-fence">---</div><pre>${escapeHtml(yaml.trim())}</pre><div class="front-matter-fence">---</div></section>\n\n`;
  });
  next = next.replace(/(^|\n)\[TOC\]\s*(?=\n|$)/gi, (_match, prefix) => `${prefix}${buildTocHtml(markdown)}\n`);
  next = convertFootnotes(next);
  next = convertTaskItems(next);
  next = convertDefinitionLists(next);
  return next;
}

function installLightMarkMarkdown(instance: MarkdownIt) {
  instance.linkify.set({ fuzzyLink: true });

  instance.renderer.rules.text = (tokens, idx) => renderInlineEnhancements(instance.utils.escapeHtml(tokens[idx].content));

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
    .replace(/(^|[A-Za-z0-9)\]])\^([A-Za-z0-9+\-=().]+)\^/g, "$1<sup>$2</sup>")
    .replace(/(^|[A-Za-z0-9)\]])~([A-Za-z0-9+\-=().]+)~/g, "$1<sub>$2</sub>")
    .replace(/:([a-z0-9_+-]+):/gi, (_match, name) => emojiMap[name] || `:${name}:`);
}

function convertTaskItems(markdown: string) {
  return markdown.replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/gm, (_match, indent, checked, text) => {
    const isChecked = checked.toLowerCase() === "x";
    return `${indent}- <span data-task-item="${isChecked ? "checked" : "unchecked"}">${isChecked ? "☑" : "☐"} ${text}</span>`;
  });
}

function convertDefinitionLists(markdown: string) {
  return markdown.replace(/(^|\n)([^\n:][^\n]+)\n:\s+([^\n]+)(?=\n|$)/g, (_match, prefix, term, definition) => {
    return `${prefix}<dl><dt>${escapeHtml(term.trim())}</dt><dd>${escapeHtml(definition.trim())}</dd></dl>`;
  });
}

function convertFootnotes(markdown: string) {
  const definitions = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  const bodyLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const definition = lines[index].match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (!definition) {
      bodyLines.push(lines[index]);
      continue;
    }

    const id = definition[1];
    const chunks = [definition[2]];
    while (index + 1 < lines.length && /^( {2,}|\t)/.test(lines[index + 1])) {
      index += 1;
      chunks.push(lines[index].trim());
    }
    definitions.set(id, chunks.join("\n"));
  }

  let next = bodyLines.join("\n");

  next = next.replace(/\[\^([^\]]+)\]/g, (_match, id) => {
    const safeId = escapeHtml(id);
    return `<sup data-footnote-ref="${safeId}"><a href="#fn-${safeId}" id="fnref-${safeId}">[${safeId}]</a></sup>`;
  });

  if (definitions.size === 0) return next;

  const items = Array.from(definitions.entries())
    .map(([id, text]) => {
      const safeId = escapeHtml(id);
      return `<li id="fn-${safeId}"><span class="footnote-id">[${safeId}]</span> ${escapeHtml(text).replace(/\n/g, "<br>")} <a href="#fnref-${safeId}" class="footnote-backref">↩</a></li>`;
    })
    .join("");
  return `${next}\n\n<section class="footnotes"><ol>${items}</ol></section>`;
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
  return markdown.replace(/(^|[^$\\])\$([^$\n]+?)\$/g, (_match, prefix, tex) => {
    return `${prefix}${stash(`<span data-type="inline-math" data-tex="${escapeHtml(tex.trim())}"></span>`)}`;
  });
}

function protectHtmlBlocks(markdown: string, stash: (html: string) => string) {
  return markdown.replace(/(^|\n)<([a-z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\2>\s*(?=\n|$)/gi, (_match) => {
    return stash(`<div data-type="html-block" data-html="${escapeHtml(_match.trim())}"></div>`);
  });
}

function renderInlineMarkdownInsideMark(value: string) {
  return escapeHtml(value).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
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
