import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

export const RECOVERY_FORMAT = "lightmark-recovery" as const;
export const RECOVERY_SCHEMA_VERSION = 2 as const;

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 96 * 1024 * 1024;
const MAX_DOCUMENT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_VALUES = 200_000;
const MAX_STRING_LENGTH = 8 * 1024 * 1024;
const MAX_PENDING_MATH_ENTRIES = 512;
const MAX_MATH_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_SCROLL_TOP = Number.MAX_SAFE_INTEGER;

const mathDelimiters = new Set([
  "inline-dollar",
  "inline-double-dollar",
  "inline-paren",
  "display-dollar",
  "display-bracket",
  "environment",
]);
const pendingStates = new Set(["editing", "composing", "blurPending", "conflict"]);
const selectionTypes = new Set(["text", "node", "all", "cell"]);
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RecoveryMathContent = {
  tex: string;
  delimiter: string;
  raw: string;
  originalTex: string;
  displayMode: boolean;
};

export type RecoveryPendingMathEntry = {
  id: string;
  binding: RecoveryMathBinding;
  accepted: RecoveryMathContent;
  local: RecoveryMathContent;
  state: "editing" | "composing" | "blurPending" | "conflict";
};

export type RecoveryMathBinding =
  | {
    status: "linked";
    position: number;
    kind: "inline" | "block";
  }
  | {
    status: "conflicted" | "orphaned";
    position: number | null;
    kind: "inline" | "block";
    reason: string;
  };

export type RecoveryPendingMath = {
  version: number;
  entries: RecoveryPendingMathEntry[];
};

export type RecoveryScroll = {
  scrollTop: number;
  scrollRatio: number;
};

export type RecoveryOrigin = {
  path: string | null;
  kind: "normal" | "large" | "untitled";
};

export type RecoverySelectionJson = {
  type: "text" | "node" | "all" | "cell";
  anchor?: number;
  head?: number;
};

export type RecoveryBundle = {
  format: typeof RECOVERY_FORMAT;
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  source: {
    encoding: "utf-8";
    bytesBase64: string;
    byteLength: number;
  };
  document: {
    format: "prosemirror-json";
    json: JsonValue;
  };
  selection: {
    format: "prosemirror-selection";
    json: RecoverySelectionJson;
  };
  scroll: RecoveryScroll;
  pendingMath: RecoveryPendingMath;
  origin: RecoveryOrigin;
};

export type RecoveryCapture = {
  sourceBytes: Uint8Array;
  doc: ProseMirrorNode;
  selection: Selection;
  scroll: RecoveryScroll;
  pendingMath: RecoveryPendingMath;
  origin: RecoveryOrigin;
};

export type DecodedRecovery = {
  sourceBytes: Uint8Array;
  sourceText: string;
  doc: ProseMirrorNode;
  selection: Selection;
  scroll: RecoveryScroll;
  pendingMath: RecoveryPendingMath;
  origin: RecoveryOrigin;
};

export type RecoveryValidationCode =
  | "invalid-json"
  | "invalid-format"
  | "unsupported-version"
  | "size-limit"
  | "invalid-source"
  | "invalid-document"
  | "invalid-selection"
  | "invalid-scroll"
  | "invalid-pending-math"
  | "invalid-origin";

export class RecoveryValidationError extends Error {
  readonly code: RecoveryValidationCode;
  readonly path: string;

  constructor(code: RecoveryValidationCode, message: string, path = "$") {
    super(message);
    this.name = "RecoveryValidationError";
    this.code = code;
    this.path = path;
  }
}

export function encodeRecoveryBundle(input: RecoveryCapture): string {
  const sourceBytes = copySourceBytes(input.sourceBytes);
  const sourceText = decodeUtf8(sourceBytes, "$.sourceBytes");
  void sourceText;
  assertDocumentState(input.doc, "$.document.json");
  const documentJson = input.doc.toJSON() as unknown;
  validateJsonValue(documentJson, "$.document.json");
  assertDocumentJsonSize(documentJson);
  const selectionJson = input.selection.toJSON() as unknown;
  const selection = validateSelection(input.doc, selectionJson, "$.selection");
  const pendingMath = validatePendingMath(input.pendingMath, input.doc, "$.pendingMath");
  const scroll = validateScroll(input.scroll, "$.scroll");
  const origin = validateOrigin(input.origin, "$.origin");
  const bundle: RecoveryBundle = {
    format: RECOVERY_FORMAT,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    source: {
      encoding: "utf-8",
      bytesBase64: encodeBase64(sourceBytes),
      byteLength: sourceBytes.byteLength,
    },
    document: {
      format: "prosemirror-json",
      json: documentJson as JsonValue,
    },
    selection: {
      format: "prosemirror-selection",
      json: selection.json,
    },
    scroll,
    pendingMath,
    origin,
  };
  const serialized = JSON.stringify(bundle);
  assertByteLimit(serialized, MAX_BUNDLE_BYTES, "$");
  return serialized;
}

export function decodeRecoveryBundle(input: string | unknown, schema: Schema): DecodedRecovery {
  const bundle = parseBundle(input);
  assertExactKeys(bundle, ["format", "schemaVersion", "source", "document", "selection", "scroll", "pendingMath", "origin"], "$");
  if (bundle.format !== RECOVERY_FORMAT) {
    throw new RecoveryValidationError("invalid-format", "Recovery file format is not supported.", "$.format");
  }
  if (bundle.schemaVersion !== RECOVERY_SCHEMA_VERSION) {
    throw new RecoveryValidationError("unsupported-version", "Recovery file schema version is not supported.", "$.schemaVersion");
  }

  const source = decodeSource(bundle.source);
  const documentRecord = expectRecord(bundle.document, "$.document", "invalid-document");
  assertExactKeys(documentRecord, ["format", "json"], "$.document");
  if (documentRecord.format !== "prosemirror-json") {
    throw new RecoveryValidationError("invalid-document", "Document JSON format is not supported.", "$.document.format");
  }
  validateJsonValue(documentRecord.json, "$.document.json");
  assertDocumentJsonSize(documentRecord.json);
  const doc = restoreDocument(schema, documentRecord.json);

  const selectionRecord = expectRecord(bundle.selection, "$.selection", "invalid-selection");
  assertExactKeys(selectionRecord, ["format", "json"], "$.selection");
  if (selectionRecord.format !== "prosemirror-selection") {
    throw new RecoveryValidationError("invalid-selection", "Selection JSON format is not supported.", "$.selection.format");
  }
  const selection = validateSelection(doc, selectionRecord.json, "$.selection").selection;
  const scroll = validateScroll(bundle.scroll, "$.scroll");
  const pendingMath = validatePendingMath(bundle.pendingMath, doc, "$.pendingMath");
  const origin = validateOrigin(bundle.origin, "$.origin");
  return {
    sourceBytes: source.bytes,
    sourceText: source.text,
    doc,
    selection,
    scroll,
    pendingMath,
    origin,
  };
}

function parseBundle(input: string | unknown): Record<string, unknown> {
  let value: unknown = input;
  if (typeof input === "string") {
    assertByteLimit(input, MAX_BUNDLE_BYTES, "$" );
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new RecoveryValidationError("invalid-json", "Recovery file is not valid JSON.");
    }
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(input);
    } catch {
      throw new RecoveryValidationError("invalid-json", "Recovery value could not be serialized.");
    }
    if (typeof serialized !== "string") {
      throw new RecoveryValidationError("invalid-json", "Recovery value must be a JSON object.");
    }
    assertByteLimit(serialized, MAX_BUNDLE_BYTES, "$" );
  }
  return expectRecord(value, "$", "invalid-json");
}

function decodeSource(value: unknown) {
  const source = expectRecord(value, "$.source", "invalid-source");
  assertExactKeys(source, ["encoding", "bytesBase64", "byteLength"], "$.source");
  if (source.encoding !== "utf-8") {
    throw new RecoveryValidationError("invalid-source", "Only UTF-8 recovery sources are supported.", "$.source.encoding");
  }
  if (typeof source.byteLength !== "number" || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
    throw new RecoveryValidationError("invalid-source", "Source byteLength must be a non-negative safe integer.", "$.source.byteLength");
  }
  if (source.byteLength > MAX_SOURCE_BYTES) {
    throw new RecoveryValidationError("size-limit", "Source exceeds the recovery size limit.", "$.source.byteLength");
  }
  if (typeof source.bytesBase64 !== "string") {
    throw new RecoveryValidationError("invalid-source", "Source bytesBase64 must be a string.", "$.source.bytesBase64");
  }
  const bytes = decodeBase64(source.bytesBase64, "$.source.bytesBase64");
  if (bytes.byteLength !== source.byteLength) {
    throw new RecoveryValidationError("invalid-source", "Source base64 length does not match byteLength.", "$.source.byteLength");
  }
  return { bytes, text: decodeUtf8(bytes, "$.source.bytesBase64") };
}

function restoreDocument(schema: Schema, value: unknown) {
  const record = expectRecord(value, "$.document.json", "invalid-document");
  if (record.type !== "doc") {
    throw new RecoveryValidationError("invalid-document", "Recovery document root must be a ProseMirror doc.", "$.document.json.type");
  }
  let doc: ProseMirrorNode;
  try {
    doc = ProseMirrorNode.fromJSON(schema, record);
    doc.check();
  } catch (error) {
    throw new RecoveryValidationError("invalid-document", `ProseMirror document validation failed: ${errorMessage(error)}`, "$.document.json");
  }
  if (doc.type.name !== "doc" || !jsonEqual(doc.toJSON(), record)) {
    throw new RecoveryValidationError(
      "invalid-document",
      "Decoded document JSON was normalized or contained fields the schema did not preserve.",
      "$.document.json",
    );
  }
  assertDocumentState(doc, "$.document.json");
  return doc;
}

function assertDocumentState(doc: ProseMirrorNode, path: string) {
  try {
    doc.check();
  } catch (error) {
    throw new RecoveryValidationError("invalid-document", `ProseMirror document check failed: ${errorMessage(error)}`, path);
  }
  doc.descendants((node, position) => {
    if (node.type.name !== "inlineMath" && node.type.name !== "blockMath") return true;
    validateMathNodeAttrs(node, `${path}.${node.type.name}@${position}`);
    return true;
  });
}

function validateMathNodeAttrs(node: ProseMirrorNode, path: string) {
  const attrs = expectRecord(node.attrs, path, "invalid-document");
  assertExactKeys(attrs, ["tex", "delimiter", "raw", "originalTex", "displayMode", "editing"], path);
  for (const key of ["tex", "raw", "originalTex"] as const) {
    if (typeof attrs[key] !== "string" || attrs[key].length > MAX_MATH_TEXT_LENGTH) {
      throw new RecoveryValidationError("invalid-document", `Math ${key} attribute is invalid or too large.`, `${path}.${key}`);
    }
  }
  if (typeof attrs.delimiter !== "string" || !mathDelimiters.has(attrs.delimiter)) {
    throw new RecoveryValidationError("invalid-document", "Math delimiter attribute is unsupported.", `${path}.delimiter`);
  }
  if (typeof attrs.displayMode !== "boolean" || typeof attrs.editing !== "boolean") {
    throw new RecoveryValidationError("invalid-document", "Math boolean attributes are invalid.", path);
  }
}

function validateSelection(doc: ProseMirrorNode, value: unknown, path: string) {
  const record = expectRecord(value, `${path}.json`, "invalid-selection");
  if (typeof record.type !== "string" || !selectionTypes.has(record.type)) {
    throw new RecoveryValidationError("invalid-selection", "Selection type is unsupported.", `${path}.json.type`);
  }
  const type = record.type;
  const allowed = type === "all" ? ["type"] : type === "node" ? ["type", "anchor"] : ["type", "anchor", "head"];
  assertExactKeys(record, allowed, `${path}.json`);
  if (type !== "all") {
    assertPosition(record.anchor, doc, `${path}.json.anchor`);
  }
  if (type === "text" || type === "cell") {
    assertPosition(record.head, doc, `${path}.json.head`);
  }
  if (type === "text") {
    assertTextEndpoint(doc, record.anchor as number, `${path}.json.anchor`);
    assertTextEndpoint(doc, record.head as number, `${path}.json.head`);
  } else if (type === "node") {
    assertNodeEndpoint(doc, record.anchor as number, `${path}.json.anchor`);
  } else if (type === "cell") {
    assertCellEndpoint(doc, record.anchor as number, `${path}.json.anchor`);
    assertCellEndpoint(doc, record.head as number, `${path}.json.head`);
    const anchorCell = doc.resolve(record.anchor as number);
    const headCell = doc.resolve(record.head as number);
    const anchorTable = findTableAncestor(anchorCell);
    const headTable = findTableAncestor(headCell);
    if (!anchorTable || !headTable || anchorTable.pos !== headTable.pos) {
      throw new RecoveryValidationError("invalid-selection", "Cell selection endpoints must belong to one table.", `${path}.json`);
    }
  }
  let selection: Selection;
  try {
    selection = Selection.fromJSON(doc, record);
  } catch (error) {
    throw new RecoveryValidationError("invalid-selection", `Selection validation failed: ${errorMessage(error)}`, `${path}.json`);
  }
  if (!jsonEqual(selection.toJSON(), record)) {
    throw new RecoveryValidationError("invalid-selection", "Selection type or direction was normalized unexpectedly.", `${path}.json`);
  }
  if (selection.toJSON().type !== type) {
    throw new RecoveryValidationError("invalid-selection", "Selection type did not survive schema validation.", `${path}.json.type`);
  }
  if (type === "text" && (selection.$anchor.pos !== record.anchor || selection.$head.pos !== record.head)) {
    throw new RecoveryValidationError("invalid-selection", "Text selection endpoints were normalized unexpectedly.", `${path}.json`);
  }
  if (type === "node" && (!(selection instanceof NodeSelection)
    || selection.$from.pos !== record.anchor
    || selection.$from.nodeAfter !== selection.node)) {
    throw new RecoveryValidationError("invalid-selection", "Node selection anchor is not a selectable node boundary.", `${path}.json.anchor`);
  }
  if (type === "cell" && (!(selection instanceof CellSelection)
    || selection.$anchorCell.pos !== record.anchor
    || selection.$headCell.pos !== record.head)) {
    throw new RecoveryValidationError("invalid-selection", "Cell selection endpoints were not preserved as table cell boundaries.", `${path}.json`);
  }
  return { selection, json: record as RecoverySelectionJson };
}

function assertTextEndpoint(doc: ProseMirrorNode, position: number, path: string) {
  const resolved = doc.resolve(position);
  if (!resolved.parent.inlineContent) {
    throw new RecoveryValidationError("invalid-selection", "Text selection endpoint must be inside inline content.", path);
  }
}

function assertNodeEndpoint(doc: ProseMirrorNode, position: number, path: string) {
  const resolved = doc.resolve(position);
  if (!resolved.nodeAfter || resolved.nodeAfter.isText || resolved.nodeAfter.type.spec.selectable === false) {
    throw new RecoveryValidationError("invalid-selection", "Node selection anchor must point to a selectable node boundary.", path);
  }
}

function assertCellEndpoint(doc: ProseMirrorNode, position: number, path: string) {
  const resolved = doc.resolve(position);
  if (resolved.parent.type.spec.tableRole !== "row"
    || !resolved.nodeAfter
    || (resolved.nodeAfter.type.spec.tableRole !== "cell" && resolved.nodeAfter.type.spec.tableRole !== "header_cell")) {
    throw new RecoveryValidationError("invalid-selection", "Cell selection endpoint must point to a table cell boundary.", path);
  }
}

function findTableAncestor(resolved: ReturnType<ProseMirrorNode["resolve"]>) {
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (resolved.node(depth).type.spec.tableRole === "table") return { node: resolved.node(depth), pos: resolved.before(depth) };
  }
  return null;
}

function validatePendingMath(value: unknown, doc: ProseMirrorNode, path: string): RecoveryPendingMath {
  const record = expectRecord(value, path, "invalid-pending-math");
  assertExactKeys(record, ["version", "entries"], path);
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 0) {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math version must be a non-negative safe integer.", `${path}.version`);
  }
  if (!Array.isArray(record.entries) || record.entries.length > MAX_PENDING_MATH_ENTRIES) {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math entries exceed the supported shape or size.", `${path}.entries`);
  }
  const ids = new Set<string>();
  const linkedPositions = new Set<number>();
  const entries = record.entries.map((entry, index) => validatePendingMathEntry(entry, doc, `${path}.entries[${index}]`, ids, linkedPositions));
  return { version: record.version, entries };
}

function validatePendingMathEntry(
  value: unknown,
  doc: ProseMirrorNode,
  path: string,
  ids: Set<string>,
  linkedPositions: Set<number>,
): RecoveryPendingMathEntry {
  const record = expectRecord(value, path, "invalid-pending-math");
  assertExactKeys(record, ["id", "binding", "accepted", "local", "state"], path);
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256 || record.id.includes("\u0000") || ids.has(record.id)) {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math id is invalid or duplicated.", `${path}.id`);
  }
  ids.add(record.id);
  if (typeof record.state !== "string" || !pendingStates.has(record.state)) {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math state is unsupported.", `${path}.state`);
  }
  const binding = validateMathBinding(record.binding, doc, `${path}.binding`, linkedPositions);
  const accepted = validateMathContent(record.accepted, `${path}.accepted`);
  const local = validateMathContent(record.local, `${path}.local`);
  if (binding.status === "linked") {
    const node = doc.nodeAt(binding.position);
    const expectedType = binding.kind === "inline" ? "inlineMath" : "blockMath";
    if (!node || node.type.name !== expectedType || !mathContentMatchesNode(accepted, node.attrs)) {
      throw new RecoveryValidationError("invalid-pending-math", "Linked math binding does not match its current accepted document node.", `${path}.binding.position`);
    }
  } else if (binding.status === "conflicted" && record.state !== "conflict") {
    throw new RecoveryValidationError("invalid-pending-math", "Conflicted math binding must retain conflict state.", `${path}.state`);
  }
  return {
    id: record.id,
    binding,
    accepted,
    local,
    state: record.state as RecoveryPendingMathEntry["state"],
  };
}

function validateMathBinding(
  value: unknown,
  doc: ProseMirrorNode,
  path: string,
  linkedPositions: Set<number>,
): RecoveryMathBinding {
  const record = expectRecord(value, path, "invalid-pending-math");
  if (record.status === "linked") {
    assertExactKeys(record, ["status", "position", "kind"], path);
    if (!Number.isSafeInteger(record.position) || (record.position as number) < 0 || (record.position as number) > doc.content.size || linkedPositions.has(record.position as number)) {
      throw new RecoveryValidationError("invalid-pending-math", "Linked math position is invalid or duplicated.", `${path}.position`);
    }
    if (record.kind !== "inline" && record.kind !== "block") {
      throw new RecoveryValidationError("invalid-pending-math", "Linked math kind is unsupported.", `${path}.kind`);
    }
    linkedPositions.add(record.position as number);
    return {
      status: "linked",
      position: record.position as number,
      kind: record.kind,
    };
  }
  if (record.status !== "conflicted" && record.status !== "orphaned") {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math binding status is unsupported.", `${path}.status`);
  }
  assertExactKeys(record, ["status", "position", "kind", "reason"], path);
  if (record.position !== null && (!Number.isSafeInteger(record.position) || (record.position as number) < 0)) {
    throw new RecoveryValidationError("invalid-pending-math", "Unlinked math position hint must be null or a non-negative safe integer.", `${path}.position`);
  }
  if (record.kind !== "inline" && record.kind !== "block") {
    throw new RecoveryValidationError("invalid-pending-math", "Unlinked math kind is unsupported.", `${path}.kind`);
  }
  if (typeof record.reason !== "string" || record.reason.length === 0 || record.reason.length > 4096 || record.reason.includes("\u0000")) {
    throw new RecoveryValidationError("invalid-pending-math", "Unlinked math conflict reason is invalid.", `${path}.reason`);
  }
  return {
    status: record.status,
    position: record.position as number | null,
    kind: record.kind,
    reason: record.reason,
  };
}

function validateMathContent(value: unknown, path: string): RecoveryMathContent {
  const record = expectRecord(value, path, "invalid-pending-math");
  assertExactKeys(record, ["tex", "delimiter", "raw", "originalTex", "displayMode"], path);
  for (const key of ["tex", "raw", "originalTex"] as const) {
    if (typeof record[key] !== "string" || record[key].length > MAX_MATH_TEXT_LENGTH) {
      throw new RecoveryValidationError("invalid-pending-math", "Pending math text is invalid or too large.", `${path}.${key}`);
    }
  }
  if (typeof record.delimiter !== "string" || !mathDelimiters.has(record.delimiter)) {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math delimiter is unsupported.", `${path}.delimiter`);
  }
  if (typeof record.displayMode !== "boolean") {
    throw new RecoveryValidationError("invalid-pending-math", "Pending math displayMode must be boolean.", `${path}.displayMode`);
  }
  return {
    tex: record.tex,
    delimiter: record.delimiter,
    raw: record.raw,
    originalTex: record.originalTex,
    displayMode: record.displayMode,
  };
}

function mathContentMatchesNode(content: RecoveryMathContent, attrs: Record<string, unknown>) {
  return content.tex === attrs.tex
    && content.delimiter === attrs.delimiter
    && content.raw === attrs.raw
    && content.originalTex === attrs.originalTex
    && content.displayMode === attrs.displayMode;
}

function validateScroll(value: unknown, path: string): RecoveryScroll {
  const record = expectRecord(value, path, "invalid-scroll");
  assertExactKeys(record, ["scrollTop", "scrollRatio"], path);
  if (typeof record.scrollTop !== "number" || !Number.isFinite(record.scrollTop) || record.scrollTop < 0 || record.scrollTop > MAX_SCROLL_TOP) {
    throw new RecoveryValidationError("invalid-scroll", "scrollTop must be a finite non-negative number.", `${path}.scrollTop`);
  }
  if (typeof record.scrollRatio !== "number" || !Number.isFinite(record.scrollRatio) || record.scrollRatio < 0 || record.scrollRatio > 1) {
    throw new RecoveryValidationError("invalid-scroll", "scrollRatio must be finite and between zero and one.", `${path}.scrollRatio`);
  }
  return { scrollTop: record.scrollTop, scrollRatio: record.scrollRatio };
}

function validateOrigin(value: unknown, path: string): RecoveryOrigin {
  const record = expectRecord(value, path, "invalid-origin");
  assertExactKeys(record, ["path", "kind"], path);
  if (record.path !== null && (typeof record.path !== "string" || record.path.length > MAX_PATH_LENGTH || record.path.includes("\u0000"))) {
    throw new RecoveryValidationError("invalid-origin", "Recovery origin path is invalid.", `${path}.path`);
  }
  if (record.kind !== "normal" && record.kind !== "large" && record.kind !== "untitled") {
    throw new RecoveryValidationError("invalid-origin", "Recovery origin kind is unsupported.", `${path}.kind`);
  }
  return { path: record.path, kind: record.kind };
}

function copySourceBytes(value: unknown) {
  if (!(value instanceof Uint8Array)) {
    throw new RecoveryValidationError("invalid-source", "sourceBytes must be a Uint8Array.", "$.sourceBytes");
  }
  if (value.byteLength > MAX_SOURCE_BYTES) {
    throw new RecoveryValidationError("size-limit", "Source exceeds the recovery size limit.", "$.sourceBytes");
  }
  return new Uint8Array(value);
}

function decodeUtf8(bytes: Uint8Array, path: string) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new RecoveryValidationError("invalid-source", `Source is not valid UTF-8: ${errorMessage(error)}`, path);
  }
  const encoded = new TextEncoder().encode(text);
  if (!bytesEqual(bytes, encoded)) {
    throw new RecoveryValidationError("invalid-source", "Source UTF-8 bytes are not canonical and cannot be restored exactly.", path);
  }
  return text;
}

function encodeBase64(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    chunk += alphabet[(combined >>> 18) & 63]
      + alphabet[(combined >>> 12) & 63]
      + (second === undefined ? "=" : alphabet[(combined >>> 6) & 63])
      + (third === undefined ? "=" : alphabet[combined & 63]);
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join("");
}

function decodeBase64(value: string, path: string) {
  if (value.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new RecoveryValidationError("invalid-source", "Source bytesBase64 is not canonical base64.", path);
  }
  const outputLength = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (outputLength > MAX_SOURCE_BYTES) {
    throw new RecoveryValidationError("size-limit", "Source exceeds the recovery size limit.", path);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int16Array(256);
  lookup.fill(-1);
  for (let index = 0; index < alphabet.length; index += 1) lookup[alphabet.charCodeAt(index)] = index;
  const bytes = new Uint8Array(outputLength);
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = lookup[value.charCodeAt(index)];
    const b = lookup[value.charCodeAt(index + 1)];
    const c = value[index + 2] === "=" ? 0 : lookup[value.charCodeAt(index + 2)];
    const d = value[index + 3] === "=" ? 0 : lookup[value.charCodeAt(index + 3)];
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < bytes.length) bytes[output++] = (combined >>> 16) & 255;
    if (output < bytes.length) bytes[output++] = (combined >>> 8) & 255;
    if (output < bytes.length) bytes[output++] = combined & 255;
  }
  if (encodeBase64(bytes) !== value) {
    throw new RecoveryValidationError("invalid-source", "Source bytesBase64 contains non-zero padding bits and is not canonical.", path);
  }
  return bytes;
}

function validateJsonValue(value: unknown, path: string, state = { depth: 0, values: 0 }, depth = 0): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH || state.values >= MAX_JSON_VALUES) {
    throw new RecoveryValidationError("size-limit", "JSON document exceeds the recovery validation limits.", path);
  }
  state.values += 1;
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new RecoveryValidationError("size-limit", "JSON string exceeds the recovery validation limit.", path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RecoveryValidationError("invalid-json", "JSON numbers must be finite.", path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_VALUES) throw new RecoveryValidationError("size-limit", "JSON array exceeds the recovery validation limit.", path);
    for (let index = 0; index < value.length; index += 1) validateJsonValue(value[index], `${path}[${index}]`, state, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_JSON_VALUES) throw new RecoveryValidationError("size-limit", "JSON object exceeds the recovery validation limit.", path);
    for (const key of keys) {
      if (forbiddenKeys.has(key)) throw new RecoveryValidationError("invalid-json", "JSON contains a forbidden object key.", `${path}.${key}`);
      validateJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, state, depth + 1);
    }
    return;
  }
  throw new RecoveryValidationError("invalid-json", "JSON contains an unsupported value.", path);
}

function assertDocumentJsonSize(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RecoveryValidationError("invalid-document", "Document JSON could not be serialized.", "$.document.json");
  }
  assertByteLimit(serialized, MAX_DOCUMENT_JSON_BYTES, "$.document.json");
}

function assertByteLimit(value: string, limit: number, path: string) {
  if (new TextEncoder().encode(value).byteLength > limit) {
    throw new RecoveryValidationError("size-limit", "Recovery field exceeds its size limit.", path);
  }
}

function assertPosition(value: unknown, doc: ProseMirrorNode, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > doc.content.size) {
    throw new RecoveryValidationError("invalid-selection", "Selection position is outside the document.", path);
  }
}

function expectRecord(value: unknown, path: string, code: RecoveryValidationCode): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecoveryValidationError(code, "Expected a JSON object.", path);
  }
  return value as Record<string, any>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RecoveryValidationError("invalid-json", `Unexpected field ${key}.`, `${path}.${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new RecoveryValidationError("invalid-json", `Missing field ${key}.`, `${path}.${key}`);
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
