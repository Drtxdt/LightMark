const capabilityAttribute = "data-lightmark-internal";

export interface InternalRenderContext {
  readonly token: string;
}

export function createInternalRenderContext(): InternalRenderContext {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid !== "function") {
    throw new Error("Secure randomness is required for an internal render context");
  }
  return Object.freeze({ token: `lm-${randomUuid.call(globalThis.crypto)}` });
}

export function markInternalHtml(html: string, context: InternalRenderContext) {
  assertContext(context);
  const opening = getRootOpeningTag(html);
  if (!opening) throw new Error("Internal HTML capability can only mark an element fragment");
  return `${opening.prefix}${opening.attributes} ${capabilityAttribute}="${escapeAttribute(context.token)}"${opening.suffix}${html.slice(opening.end)}`;
}

export function hasInternalHtmlCapability(html: string, context: InternalRenderContext) {
  assertContext(context);
  const opening = getRootOpeningTag(html);
  if (!opening) return false;
  const token = getAttributeValue(opening.attributes, capabilityAttribute);
  return token === context.token;
}

export function stripInternalHtmlCapability(html: string, context: InternalRenderContext) {
  assertContext(context);
  const opening = getRootOpeningTag(html);
  if (!opening) return html;
  const token = getAttributeValue(opening.attributes, capabilityAttribute);
  if (token !== context.token) return html;
  const attributes = opening.attributes.replace(
    new RegExp(`\\s${capabilityAttribute}\\s*=\\s*(["'])${escapeRegExp(context.token)}\\1`, "i"),
    "",
  );
  return `${opening.prefix}${attributes}${opening.suffix}${html.slice(opening.end)}`;
}

export function stripInternalHtmlCapabilities(html: string, context: InternalRenderContext) {
  assertContext(context);
  const escapedToken = escapeRegExp(context.token);
  const capability = new RegExp(
    `\\s${capabilityAttribute}\\s*=\\s*(["'])${escapedToken}\\1`,
    "gi",
  );
  return String(html).replace(/<\s*[a-zA-Z][^<>]*>/g, (tag) => tag.replace(capability, ""));
}

function getRootOpeningTag(html: string) {
  const match = String(html).match(/^(\s*<([a-zA-Z][\w:-]*)([\s\S]*?)(\/?>))/u);
  if (!match || /<|>/.test(match[3])) return null;
  const tagStart = match[1].indexOf(match[2]);
  return {
    prefix: match[1].slice(0, tagStart + match[2].length),
    attributes: match[3],
    suffix: match[4],
    end: match[0].length,
  };
}

function getAttributeValue(attributes: string, name: string) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return attributes.match(pattern)?.[2] ?? null;
}

function assertContext(context: InternalRenderContext) {
  if (!context || typeof context.token !== "string" || !/^lm-[0-9a-f-]{32,}$/i.test(context.token)) {
    throw new TypeError("An opaque internal render context is required");
  }
}

function escapeAttribute(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
