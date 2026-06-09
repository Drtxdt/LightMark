const inlineHtmlTags = new Set([
  "span",
  "a",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "code",
  "kbd",
  "sub",
  "sup",
  "small",
  "abbr",
  "cite",
  "q",
  "time",
  "font",
  "br",
  "img",
]);

const formHtmlTags = new Set(["input", "button", "select", "option", "label"]);

const blockHtmlTags = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "hr",
]);

const voidTags = new Set(["br", "img", "hr", "input"]);
const globalAttributes = new Set(["class", "id", "title", "style"]);
const tagAttributes: Record<string, Set<string>> = {
  a: new Set(["href"]),
  abbr: new Set(["title"]),
  button: new Set(["type", "disabled"]),
  img: new Set(["src", "alt", "width", "height", "title", "class", "style"]),
  input: new Set(["type", "value", "checked", "disabled", "alt", "src", "width", "height"]),
  label: new Set(["for"]),
  option: new Set(["selected", "value"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};
const safeStyleProperties = new Set([
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "text-decoration",
  "font-size",
  "font-family",
]);

export function escapeHtml(value: string) {
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

export function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, "&#10;");
}

export function sanitizeInlineHtmlSource(html: string) {
  return sanitizeHtmlFragment(html, { inlineOnly: true });
}

export function sanitizeHtmlFragment(html: string, options: { inlineOnly?: boolean } = {}) {
  const allowedTags = options.inlineOnly ? inlineHtmlTags : new Set([...inlineHtmlTags, ...blockHtmlTags, ...formHtmlTags]);
  let output = "";
  let cursor = 0;
  const tagPattern = /<!--[\s\S]*?-->|<\/?\s*[a-zA-Z][\w:-]*(?:\s+[^<>]*?)?\s*\/?>/g;
  let match = tagPattern.exec(html);

  while (match) {
    output += escapeHtml(html.slice(cursor, match.index));
    output += sanitizeTag(match[0], allowedTags);
    cursor = match.index + match[0].length;
    match = tagPattern.exec(html);
  }

  output += escapeHtml(html.slice(cursor));
  return output;
}

export function renderInlineMarkdownInHtml(html: string, options: { inlineOnly?: boolean } = {}) {
  const sanitized = sanitizeHtmlFragment(html, options);
  let output = "";
  let cursor = 0;
  const tagPattern = /<\/?\s*([a-zA-Z][\w:-]*)(?:\s+[^<>]*?)?\s*\/?>/g;
  const rawTextStack: string[] = [];
  let match = tagPattern.exec(sanitized);

  while (match) {
    output += rawTextStack.length > 0 ? sanitized.slice(cursor, match.index) : renderInlineMarkdownText(sanitized.slice(cursor, match.index));
    output += match[0];

    const tag = match[1].toLowerCase();
    const closing = /^<\s*\//.test(match[0]);
    if (!closing && (tag === "code" || tag === "kbd" || tag === "pre")) rawTextStack.push(tag);
    if (closing && rawTextStack[rawTextStack.length - 1] === tag) rawTextStack.pop();

    cursor = match.index + match[0].length;
    match = tagPattern.exec(sanitized);
  }

  output += rawTextStack.length > 0 ? sanitized.slice(cursor) : renderInlineMarkdownText(sanitized.slice(cursor));
  return output;
}

export type InlineHtmlMatch = {
  from: number;
  to: number;
  html: string;
};

export function findInlineHtmlMatch(text: string): InlineHtmlMatch | null {
  const tagPattern = /<\s*([a-zA-Z][\w:-]*)(?:\s+[^<>]*?)?\s*\/?>/g;
  let match = tagPattern.exec(text);
  while (match) {
    const tag = match[1].toLowerCase();
    if (!inlineHtmlTags.has(tag)) {
      match = tagPattern.exec(text);
      continue;
    }

    const raw = match[0];
    if (voidTags.has(tag) || /\/\s*>$/.test(raw)) {
      if (isLightMarkInternalHtml(raw)) {
        match = tagPattern.exec(text);
        continue;
      }
      return { from: match.index, to: match.index + raw.length, html: raw };
    }

    const closePattern = new RegExp(`<\\/\\s*${escapeRegExp(tag)}\\s*>`, "i");
    const rest = text.slice(match.index + raw.length);
    const close = closePattern.exec(rest);
    if (close) {
      const to = match.index + raw.length + close.index + close[0].length;
      const html = text.slice(match.index, to);
      if (isLightMarkInternalHtml(html)) {
        tagPattern.lastIndex = to;
        match = tagPattern.exec(text);
        continue;
      }
      return { from: match.index, to, html };
    }

    match = tagPattern.exec(text);
  }

  return null;
}

function isLightMarkInternalHtml(html: string) {
  return /\sdata-(?:type|task-item|footnote|markdown|tex|code|yaml|html|ref-id)\s*=/i.test(html);
}

export function containsInlineHtml(text: string) {
  return Boolean(findInlineHtmlMatch(text));
}

export function isInlineHtmlTag(tag: string) {
  return inlineHtmlTags.has(tag.toLowerCase());
}

function sanitizeTag(rawTag: string, allowedTags: Set<string>) {
  if (rawTag.startsWith("<!--")) return "";

  const tagMatch = rawTag.match(/^<\s*(\/?)\s*([a-zA-Z][\w:-]*)([\s\S]*?)\s*(\/?)>$/);
  if (!tagMatch) return escapeHtml(rawTag);

  const closing = Boolean(tagMatch[1]);
  const tag = tagMatch[2].toLowerCase();
  if (!allowedTags.has(tag)) return escapeHtml(rawTag);

  if (closing) {
    if (voidTags.has(tag)) return "";
    return `</${tag}>`;
  }

  const attrs = sanitizeAttributes(tag, tagMatch[3]);
  const suffix = voidTags.has(tag) || Boolean(tagMatch[4]) ? " />" : ">";
  return `<${tag}${attrs}${suffix}`;
}

function sanitizeAttributes(tag: string, rawAttributes: string) {
  const attributes: string[] = [];
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match = attrPattern.exec(rawAttributes);

  while (match) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!isAllowedAttribute(tag, name)) {
      match = attrPattern.exec(rawAttributes);
      continue;
    }

    const sanitized = sanitizeAttributeValue(tag, name, value);
    if (sanitized === null) {
      match = attrPattern.exec(rawAttributes);
      continue;
    }

    attributes.push(`${name}="${escapeAttribute(sanitized)}"`);
    match = attrPattern.exec(rawAttributes);
  }

  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function isAllowedAttribute(tag: string, name: string) {
  if (name.startsWith("on")) return false;
  if (name.startsWith("data-")) return true;
  return globalAttributes.has(name) || tagAttributes[tag]?.has(name) || name === "alt" || name === "width" || name === "height";
}

function sanitizeAttributeValue(tag: string, name: string, value: string) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name === "href") return isSafeUrl(normalized, false) ? normalized : null;
  if (name === "src") return isSafeUrl(normalized, tag === "img") ? normalized : null;
  if (name === "style") return sanitizeStyle(normalized);
  if (name === "type") return /^(button|checkbox|radio|text|search|email|url|number|password|submit|reset)$/i.test(normalized) ? normalized : null;
  if (name === "width" || name === "height" || name === "colspan" || name === "rowspan") {
    return /^\d{1,4}%?$/.test(normalized) ? normalized : null;
  }
  if (name === "checked" || name === "disabled" || name === "selected") return normalized || name;
  return normalized;
}

function isSafeUrl(value: string, allowDataImage: boolean) {
  const lower = value.toLowerCase().replace(/\s+/g, "");
  if (!lower) return false;
  if (lower.startsWith("#")) return true;
  if (lower.startsWith("/") || lower.startsWith("./") || lower.startsWith("../")) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(lower)) return true;
  if (lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("mailto:")) return true;
  return allowDataImage && /^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(value);
}

function sanitizeStyle(value: string) {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const [property, ...valueParts] = declaration.split(":");
      const name = property?.trim().toLowerCase();
      const propertyValue = valueParts.join(":").trim();
      if (!name || !propertyValue || !safeStyleProperties.has(name)) return "";
      if (/[<>]/.test(propertyValue) || /(?:url\s*\(|expression\s*\(|@import|behavior\s*:)/i.test(propertyValue)) return "";
      return `${name}: ${propertyValue}`;
    })
    .filter(Boolean)
    .join("; ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderInlineMarkdownText(value: string) {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
}
