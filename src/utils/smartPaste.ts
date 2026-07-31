import TurndownService from "turndown";

export type PasteConversionKind = "image-files" | "html" | "table" | "markdown" | "plain";

export interface ClipboardPayload {
  plainText: string;
  html: string;
  files: File[];
}

export interface PasteConversionResult {
  kind: PasteConversionKind;
  markdown: string;
  files: File[];
  warnings: string[];
}

export interface PrepareSmartPasteOptions {
  plainText?: boolean;
}

export function clipboardPayloadFromDataTransfer(data: DataTransfer | null): ClipboardPayload {
  return {
    plainText: data?.getData("text/plain") ?? "",
    html: data?.getData("text/html") ?? "",
    files: data ? Array.from(data.files) : [],
  };
}

export async function readClipboardPayload(): Promise<ClipboardPayload> {
  const payload: ClipboardPayload = { plainText: "", html: "", files: [] };
  if (typeof navigator === "undefined" || !navigator.clipboard) return payload;

  if (typeof navigator.clipboard.read === "function") {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type === "text/plain") payload.plainText = await blob.text();
          else if (type === "text/html") payload.html = await blob.text();
          else if (type.startsWith("image/")) {
            payload.files.push(new File([blob], `clipboard-${Date.now()}.${imageExtension(type)}`, { type }));
          }
        }
      }
      return payload;
    } catch {
      // The WebView may expose readText but reject the richer clipboard API.
    }
  }

  try {
    payload.plainText = await navigator.clipboard.readText();
  } catch {
    // Keep an empty payload when clipboard permission is unavailable.
  }
  return payload;
}

export function prepareSmartPaste(
  payload: ClipboardPayload,
  options: PrepareSmartPasteOptions = {},
): PasteConversionResult {
  const imageFiles = payload.files.filter((file) => file.type.startsWith("image/"));
  if (!options.plainText && imageFiles.length > 0) {
    return { kind: "image-files", markdown: "", files: imageFiles, warnings: [] };
  }

  if (options.plainText) {
    return { kind: "plain", markdown: payload.plainText, files: [], warnings: [] };
  }

  if (payload.html.trim()) {
    const converted = richHtmlToMarkdown(payload.html);
    if (converted.markdown) {
      return { kind: "html", markdown: converted.markdown, files: [], warnings: converted.warnings };
    }
  }

  const table = delimitedTextToMarkdownTable(payload.plainText);
  if (table) return { kind: "table", markdown: table, files: [], warnings: [] };

  return {
    kind: looksLikeMarkdown(payload.plainText) ? "markdown" : "plain",
    markdown: payload.plainText,
    files: [],
    warnings: [],
  };
}

export function looksLikeMarkdown(text: string) {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\||!\[[^\]]*\]\(|\[[^\]]+\]\(|\[\^[^\]]+\]:|\$\$)/.test(text)
    || /\[\^[^\]]+\]|`[^`\n]+`|\*\*[^*]+\*\*|\$[^$\n]+\$/.test(text)
    || /<\/?[a-z][^>]*>/i.test(text);
}

export function plainTextToLiteralMarkdown(text: string) {
  return text.replace(/[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/g, "\\$&");
}

export function delimitedTextToMarkdownTable(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return null;
  if (normalized.includes("\t")) {
    const table = tryDelimitedText(normalized, "\t");
    if (table) return table;
  }
  return normalized.includes(",") ? tryDelimitedText(normalized, ",") : null;
}

function tryDelimitedText(text: string, delimiter: "," | "\t") {
  if (!hasBalancedDelimitedQuotes(text, delimiter)) return null;
  const rows = parseDelimitedRows(text, delimiter);
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === "")) rows.pop();
  if (rows.length < 2 || rows[0].length < 2) return null;
  const width = rows[0].length;
  if (rows.some((row) => row.length !== width)) return null;

  const rendered = rows.map((row) => `| ${row.map(escapeDelimitedTableCell).join(" | ")} |`);
  rendered.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  return rendered.join("\n");
}

function hasBalancedDelimitedQuotes(text: string, delimiter: "," | "\t") {
  let quoted = false;
  let cellStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === delimiter || (!quoted && character === "\n")) {
      cellStart = true;
      continue;
    }
    if (character !== '"') {
      if (!quoted) cellStart = false;
      continue;
    }
    if (quoted && text[index + 1] === '"') {
      index += 1;
      continue;
    }
    if (quoted || cellStart) quoted = !quoted;
    cellStart = false;
  }
  return !quoted;
}

export function parseDelimitedRows(text: string, delimiter: "," | "\t") {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (quoted || cell.length === 0) {
        quoted = !quoted;
      } else {
        cell += character;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!quoted && character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += character;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

export function richHtmlToMarkdown(html: string): { markdown: string; warnings: string[] } {
  if (typeof DOMParser === "undefined") return { markdown: "", warnings: [] };
  const document = new DOMParser().parseFromString(html, "text/html");
  const warnings: string[] = [];

  document.querySelectorAll("script,style,noscript,template,iframe,object,embed,form,button,select,textarea,meta,link").forEach((node) => node.remove());
  normalizeTaskCheckboxes(document);
  normalizeOfficeLists(document);
  normalizeStyledElements(document);
  normalizeLinksAndImages(document, warnings);
  stripClipboardAttributes(document);

  const turndown = createExternalTurndown();
  const markdown = normalizeConvertedMarkdown(turndown.turndown(document.body.innerHTML));
  return { markdown, warnings };
}

function createExternalTurndown() {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
  });

  service.addRule("lightmark-external-strike", {
    filter(node) {
      return ["DEL", "S", "STRIKE"].includes(node.nodeName);
    },
    replacement(content) {
      return content.trim() ? `~~${content.trim()}~~` : "";
    },
  });
  service.addRule("lightmark-external-line-break", {
    filter: "br",
    replacement() {
      return "  \n";
    },
  });
  service.addRule("lightmark-external-image", {
    filter: "img",
    replacement(_content, node) {
      const image = node as HTMLImageElement;
      const source = image.getAttribute("src") || "";
      if (!/^https?:\/\//i.test(source)) return image.getAttribute("alt") || "";
      const alt = (image.getAttribute("alt") || "").replace(/[\[\]]/g, "\\$&");
      const title = image.getAttribute("title");
      return `![${alt}](${markdownLinkDestination(source)}${title ? ` \"${title.replace(/\"/g, "\\\"")}\"` : ""})`;
    },
  });
  service.addRule("lightmark-external-table", {
    filter: "table",
    replacement(_content, node) {
      return `\n\n${htmlTableToMarkdown(node as HTMLTableElement, service)}\n\n`;
    },
  });
  return service;
}

function htmlTableToMarkdown(table: HTMLTableElement, service: TurndownService) {
  const grid: string[][] = [];
  Array.from(table.rows).forEach((row, rowIndex) => {
    grid[rowIndex] ??= [];
    let column = 0;
    Array.from(row.cells).forEach((cell) => {
      while (grid[rowIndex][column] !== undefined) column += 1;
      const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
      const colSpan = Math.max(1, Number(cell.colSpan) || 1);
      const markdown = service.turndown(cell.innerHTML).replace(/\r?\n+/g, "<br>").trim();
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        grid[rowIndex + rowOffset] ??= [];
        for (let columnOffset = 0; columnOffset < colSpan; columnOffset += 1) {
          grid[rowIndex + rowOffset][column + columnOffset] = rowOffset === 0 && columnOffset === 0 ? markdown : "";
        }
      }
      column += colSpan;
    });
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  if (grid.length === 0 || width === 0) return "";
  if (width === 1) return grid.map((row) => row[0] || "").filter(Boolean).join("\n\n");
  const rows = grid.map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
  const rendered = rows.map((row) => `| ${row.map(escapeDelimitedTableCell).join(" | ")} |`);
  rendered.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  return rendered.join("\n");
}

function normalizeTaskCheckboxes(document: Document) {
  document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.replaceWith(document.createTextNode(input.checked ? "[x] " : "[ ] "));
  });
}

function normalizeOfficeLists(document: Document) {
  const paragraphs = Array.from(document.querySelectorAll<HTMLElement>("p.MsoListParagraph, p[class*='MsoList'], p[style*='mso-list']"));
  const handled = new Set<Element>();
  for (const paragraph of paragraphs) {
    if (handled.has(paragraph) || !paragraph.parentElement) continue;
    const ordered = /^\s*\d+[.)]\s+/.test(paragraph.textContent || "");
    const list = document.createElement(ordered ? "ol" : "ul");
    paragraph.parentElement.insertBefore(list, paragraph);
    let current: Element | null = paragraph;
    while (current && paragraphs.includes(current as HTMLElement) && !handled.has(current)) {
      const currentOrdered = /^\s*\d+[.)]\s+/.test(current.textContent || "");
      if (currentOrdered !== ordered) break;
      const next: Element | null = current.nextElementSibling;
      const item = document.createElement("li");
      while (current.firstChild) item.appendChild(current.firstChild);
      stripLeadingListMarker(item);
      list.appendChild(item);
      handled.add(current);
      current.remove();
      current = next;
    }
  }
}

function stripLeadingListMarker(node: Node): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const original = child.textContent || "";
      const next = original.replace(/^\s*(?:[•·▪◦●○*-]|\d+[.)])\s+/, "");
      child.textContent = next;
      if (next !== original) return true;
    } else if (stripLeadingListMarker(child)) return true;
  }
  return false;
}

function normalizeStyledElements(document: Document) {
  document.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const style = element.getAttribute("style") || "";
    const wrappers: string[] = [];
    if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) wrappers.push("strong");
    if (/font-style\s*:\s*italic/i.test(style)) wrappers.push("em");
    if (/text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style)) wrappers.push("del");
    if (wrappers.length === 0) return;
    const outer = document.createElement(wrappers[0]);
    let inner = outer;
    for (const tag of wrappers.slice(1)) {
      const wrapper = document.createElement(tag);
      inner.appendChild(wrapper);
      inner = wrapper;
    }
    while (element.firstChild) inner.appendChild(element.firstChild);
    element.appendChild(outer);
  });
}

function normalizeLinksAndImages(document: Document, warnings: string[]) {
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (!isSafeLink(href)) link.removeAttribute("href");
  });
  let omittedImages = 0;
  document.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const source = image.getAttribute("src") || "";
    if (/^https?:\/\//i.test(source)) return;
    const alt = image.getAttribute("alt") || "";
    image.replaceWith(document.createTextNode(alt));
    omittedImages += 1;
  });
  if (omittedImages > 0) warnings.push(`已忽略 ${omittedImages} 张无法安全保存的内嵌图片，仅保留替代文本。`);
}

function stripClipboardAttributes(document: Document) {
  document.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === "href" || name === "src" || name === "alt" || name === "title" || name === "rowspan" || name === "colspan") continue;
      element.removeAttribute(attribute.name);
    }
  });
}

function isSafeLink(href: string) {
  return /^(?:https?:|mailto:|tel:)/i.test(href) || /^(?:#|\/|\.\.?\/)/.test(href);
}

function normalizeConvertedMarkdown(markdown: string) {
  return markdown
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeDelimitedTableCell(value: string) {
  return value
    .replace(/\r\n?|\n/g, "<br>")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

function markdownLinkDestination(value: string) {
  return /[\s()]/.test(value) ? `<${value.replace(/>/g, "%3E")}>` : value;
}

function imageExtension(type: string) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/svg+xml") return "svg";
  return type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
}
