import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code, language) {
    const lang = language && hljs.getLanguage(language) ? language : "plaintext";
    const value = hljs.highlight(code, { language: lang }).value;
    return `<pre><code class="hljs language-${lang}">${value}</code></pre>`;
  },
});

md.use(markdownItKatex);

const editorMd = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});

const defaultFence = md.renderer.rules.fence;

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/)[0];
  if (language === "mermaid") {
    const content = md.utils.escapeHtml(token.content);
    return `<pre class="mermaid">${content}</pre>`;
  }
  return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

export function renderMarkdown(markdown: string) {
  return md.render(markdown);
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

  let next = markdown.replace(/(^|\n)```mermaid\s*\n([\s\S]*?)\n```\s*(?=\n|$)/g, (_match, prefix, code) => {
    return `${prefix}\n${stash(`<div data-type="mermaid" data-code="${escapeHtml(code.trim())}"></div>`)}\n`;
  });

  next = next.replace(/(^|\n)\s*\$\$\s*\n([\s\S]*?)\n\s*\$\$\s*(?=\n|$)/g, (_match, prefix, tex) => {
    return `${prefix}\n${stash(`<div data-type="block-math" data-tex="${escapeHtml(tex.trim())}"></div>`)}\n`;
  });

  next = next.replace(/```[\s\S]*?```|`[^`\n]*`/g, (code) => stash(code));

  next = next.replace(/(^|[^$\\])\$([^$\n]+?)\$/g, (_match, prefix, tex) => {
    return `${prefix}<span data-type="inline-math" data-tex="${escapeHtml(tex.trim())}"></span>`;
  });

  placeholders.forEach((html, index) => {
    next = next.replace(`@@LIGHTMARK_PLACEHOLDER_${index}@@`, html);
  });

  return next;
}
