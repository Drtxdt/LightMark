import { renderMarkdown } from "./markdown";

export interface ClipboardCopyPayload {
  markdown: string;
  html: string;
  plainText: string;
}

export function buildClipboardCopyPayload(input: {
  markdown: string;
  plainText: string;
  mathPrelude?: string;
}): ClipboardCopyPayload {
  const markdown = normalizeSelectionMarkdown(input.markdown);
  const rendered = renderMarkdown([input.mathPrelude?.trim(), markdown].filter(Boolean).join("\n\n"));
  return {
    markdown,
    plainText: input.plainText,
    html: cleanClipboardHtml(rendered),
  };
}

export function cleanClipboardHtml(html: string) {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;

  root.querySelectorAll("script,style,link,meta,form,iframe,object,embed").forEach((node) => node.remove());
  root.querySelectorAll<HTMLElement>("blockquote.markdown-alert,[data-alert]").forEach((alert) => {
    const kind = alert.dataset.alert || alert.className.match(/markdown-alert-([a-z]+)/)?.[1] || "note";
    if (!alert.querySelector(":scope > strong[data-clipboard-alert-title]")) {
      const title = document.createElement("strong");
      title.dataset.clipboardAlertTitle = "true";
      title.textContent = alertLabel(kind);
      alert.prepend(title);
    }
  });
  root.querySelectorAll<HTMLElement>("[data-task-item]").forEach((task) => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = true;
    checkbox.checked = task.dataset.taskItem === "checked";
    task.prepend(checkbox, " ");
  });
  root.querySelectorAll<HTMLElement>("figure[data-lightmark-image]").forEach((figure) => {
    const alignment = figure.dataset.align || alignmentFromStyle(figure.style);
    const width = figure.dataset.width || figure.querySelector("img")?.getAttribute("width") || "";
    const styles = [width && /^\d{1,4}$/.test(width) ? `max-width: 100%; width: ${width}px` : "max-width: 100%"];
    if (alignment === "center") styles.push("margin-left: auto", "margin-right: auto");
    if (alignment === "right") styles.push("margin-left: auto", "margin-right: 0");
    figure.setAttribute("style", `${styles.join("; ")};`);
  });

  root.querySelectorAll<HTMLElement>("*").forEach(cleanElement);
  root.querySelectorAll("strong[data-clipboard-alert-title]").forEach((title) => title.removeAttribute("data-clipboard-alert-title"));
  return template.innerHTML.trim();
}

export function writeClipboardPayloadToEvent(event: ClipboardEvent, payload: ClipboardCopyPayload) {
  if (!event.clipboardData) return false;
  event.clipboardData.setData("text/plain", payload.markdown || payload.plainText);
  event.clipboardData.setData("text/html", payload.html);
  event.preventDefault();
  return true;
}

function cleanElement(element: HTMLElement) {
  const tag = element.tagName.toLowerCase();
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name.startsWith("data-") || name === "contenteditable" || name === "draggable") {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "class") {
      const classes = attribute.value
        .split(/\s+/)
        .filter((value) => /^katex(?:-|$)/.test(value) || /^language-[\w-]+$/.test(value));
      if (classes.length) element.className = classes.join(" ");
      else element.removeAttribute("class");
      continue;
    }
    if (name === "style") {
      const style = cleanClipboardStyle(attribute.value, tag);
      if (style) element.setAttribute("style", style);
      else element.removeAttribute("style");
      continue;
    }
    if ((name === "href" || name === "src") && !isSafeClipboardUrl(attribute.value, tag === "img")) {
      element.removeAttribute(attribute.name);
    }
  }
}

function cleanClipboardStyle(style: string, tag: string) {
  const allowed = tag === "figure" || tag === "img"
    ? new Set(["width", "height", "max-width", "max-height", "margin-left", "margin-right", "text-align", "display"])
    : new Set(["text-align"]);
  return style
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 0) return "";
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();
      if (!allowed.has(property) || /url\s*\(|expression\s*\(|[<>]/i.test(value)) return "";
      return `${property}: ${value}`;
    })
    .filter(Boolean)
    .join("; ");
}

function isSafeClipboardUrl(value: string, allowImage: boolean) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) return false;
  if (normalized.startsWith("#") || normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("/")) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return true;
  if (/^(?:https?|mailto):/.test(normalized)) return true;
  return allowImage && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/.test(normalized);
}

function normalizeSelectionMarkdown(markdown: string) {
  return markdown.replace(/^\n{1,2}|\n{1,2}$/g, "");
}

function alertLabel(value: string) {
  const labels: Record<string, string> = {
    note: "Note",
    tip: "Tip",
    important: "Important",
    warning: "Warning",
    caution: "Caution",
  };
  return labels[value.toLowerCase()] || value;
}

function alignmentFromStyle(style: CSSStyleDeclaration) {
  if (style.marginLeft === "auto" && style.marginRight === "auto") return "center";
  if (style.marginLeft === "auto") return "right";
  return "left";
}
