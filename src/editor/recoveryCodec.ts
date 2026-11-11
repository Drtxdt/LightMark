import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type {
  RecoveryCompositionV3,
  RecoveryExposedMarkdownRange,
  RecoveryExposedMarkdownV3,
  RecoveryHistoryV3,
  RecoveryLocalBufferV3,
  RecoveryLocalStateV3,
  RecoveryLocalTextUi,
  WysiwygFormatHistoryEntry,
} from "./recoveryLocalState";

export type {
  RecoveryCompositionV3,
  RecoveryExposedMarkdownRange,
  RecoveryExposedMarkdownV3,
  RecoveryHistoryAvailability,
  RecoveryHistoryV3,
  RecoveryLocalBufferCapture,
  RecoveryLocalBufferCaptureFailure,
  RecoveryLocalBufferCaptureResult,
  RecoveryLocalBufferCaptureSnapshot,
  RecoveryLocalBufferKind,
  RecoveryLocalBufferRegistration,
  RecoveryLocalBufferRegistry,
  RecoveryLocalBufferRestore,
  RecoveryLocalBufferRestoreIssue,
  RecoveryLocalBufferRestoreSnapshot,
  RecoveryLocalBufferStatus,
  RecoveryLocalBufferV3,
  RecoveryLocalStateV3,
  RecoveryLocalTextUi,
  WysiwygFormatHistoryEntry,
} from "./recoveryLocalState";

export const RECOVERY_FORMAT = "lightmark-recovery" as const;
export const RECOVERY_SCHEMA_VERSION = 2 as const;
export const RECOVERY_V3_SCHEMA_VERSION = 3 as const;
export const RECOVERY_CURRENT_SCHEMA_VERSION = RECOVERY_V3_SCHEMA_VERSION;

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
const MAX_LOCAL_BUFFERS = 512;
const MAX_LOCAL_HISTORY_ENTRIES = 20;
const MAX_LOCAL_STATE_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_BUFFER_ID_LENGTH = 256;
const MAX_LOCAL_ERROR_CODE_LENGTH = 256;
const MAX_LOCAL_ERROR_MESSAGE_LENGTH = 4096;
const MAX_LOCAL_PREVIEW_STATUS_LENGTH = 256;

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
const localBufferKinds = new Set(["frontmatter", "htmlBlock", "footnote", "toc", "mermaid", "math"]);
const localBufferStatuses = new Set(["accepted", "editing", "conflicted", "orphaned"]);
const textUiDirections = new Set(["forward", "backward", "none"]);

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

/**
 * Preserve pending math entries that outlive a NodeView remount.  Stable ids
 * are authoritative: if a newly mounted entry uses the same id with a
 * different payload, capture fails instead of selecting one value silently.
 */
export function mergeRecoveryPendingMath(
  current: RecoveryPendingMath,
  retained: RecoveryPendingMath,
): RecoveryPendingMath {
  const entries = [...current.entries];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of retained.entries) {
    const existing = byId.get(entry.id);
    if (!existing) {
      // A PM restore remounts NodeViews and may allocate a new runtime id for
      // the same linked formula.  Treat an exact accepted/local payload at
      // the same kind+position as that remount, while keeping the live entry
      // (its UI state is the current truth).  A changed payload at the same
      // binding is a real conflict and must stop capture rather than choose
      // one side silently.
      const positional = entry.binding.status === "linked"
        ? entries.find((candidate) => candidate.binding.status === "linked"
          && candidate.binding.kind === entry.binding.kind
          && candidate.binding.position === entry.binding.position)
        : undefined;
      if (positional) {
        if (sameRecoveryPendingMathPayload(positional, entry)) continue;
        throw new Error(
          `Recovery pending math payload conflicts for linked binding ${entry.binding.kind}@${entry.binding.position}.`,
        );
      }
      entries.push(entry);
      byId.set(entry.id, entry);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`Recovery pending math payload conflicts for stable id ${entry.id}.`);
    }
  }
  return { version: Math.max(current.version, retained.version), entries };
}

function sameRecoveryPendingMathPayload(
  left: RecoveryPendingMathEntry,
  right: RecoveryPendingMathEntry,
) {
  return left.binding.status === "linked"
    && right.binding.status === "linked"
    && left.binding.kind === right.binding.kind
    && left.binding.position === right.binding.position
    && JSON.stringify({ accepted: left.accepted, local: left.local })
      === JSON.stringify({ accepted: right.accepted, local: right.local });
}

export function subtractCapturedPendingMath(
  retained: RecoveryPendingMath,
  captured: RecoveryPendingMath,
): RecoveryPendingMath {
  const capturedIds = new Set(captured.entries.map((entry) => entry.id));
  const entries = retained.entries.filter((entry) => !capturedIds.has(entry.id));
  return entries.length ? { version: retained.version, entries } : { version: 0, entries: [] };
}

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

export type RecoveryBundleV3 = Omit<RecoveryBundle, "schemaVersion"> & {
  schemaVersion: typeof RECOVERY_V3_SCHEMA_VERSION;
  localState: RecoveryLocalStateV3;
};

export type RecoveryCapture = {
  sourceBytes: Uint8Array;
  doc: ProseMirrorNode;
  selection: Selection;
  scroll: RecoveryScroll;
  pendingMath: RecoveryPendingMath;
  origin: RecoveryOrigin;
};

export type RecoveryCaptureV3 = RecoveryCapture & {
  localState: RecoveryLocalStateV3;
};

export type DecodedRecovery = {
  sourceBytes: Uint8Array;
  sourceText: string;
  doc: ProseMirrorNode;
  selection: Selection;
  scroll: RecoveryScroll;
  pendingMath: RecoveryPendingMath;
  origin: RecoveryOrigin;
  localState?: RecoveryLocalStateV3;
};

export type DecodedRecoveryV3 = Omit<DecodedRecovery, "localState"> & {
  localState: RecoveryLocalStateV3;
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
  | "invalid-origin"
  | "invalid-local-state";

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

/**
 * A recovery source and its PM document are separate evidence streams.  A
 * recovered document may contain edits that were not mapped back to source
 * bytes, so an adapter must establish that mapping before allowing a source
 * overwrite.  This guard is intentionally small and side-effect free so the
 * product adapter and its tests can share the same boundary.
 */
export function assertRecoverySourceMappingProven(input: {
  sourceText: string;
  modelText: string;
  mappingProven: boolean;
}) {
  if (input.mappingProven) return;
  throw new Error(
    `Recovery source mapping is unresolved; source (${input.sourceText.length} UTF-16 units) and PM model (${input.modelText.length} UTF-16 units) cannot overwrite source bytes.`,
  );
}

export function encodeRecoveryBundle(input: RecoveryCapture | RecoveryCaptureV3): string {
  return encodeBundle(input, Object.prototype.hasOwnProperty.call(input, "localState"));
}

export function encodeRecoveryBundleV3(input: RecoveryCaptureV3): string {
  return encodeBundle(input, true);
}

function encodeBundle(input: RecoveryCapture | RecoveryCaptureV3, v3: boolean): string {
  const sourceBytes = copySourceBytes(input.sourceBytes);
  const sourceText = decodeUtf8(sourceBytes, "$.sourceBytes");
  assertDocumentState(input.doc, "$.document.json");
  const documentJson = input.doc.toJSON() as unknown;
  validateJsonValue(documentJson, "$.document.json");
  assertDocumentJsonSize(documentJson);
  const selectionJson = input.selection.toJSON() as unknown;
  const selection = validateSelection(input.doc, selectionJson, "$.selection");
  const pendingMath = validatePendingMath(input.pendingMath, input.doc, "$.pendingMath");
  const scroll = validateScroll(input.scroll, "$.scroll");
  const origin = validateOrigin(input.origin, "$.origin");
  const bundle = {
    format: RECOVERY_FORMAT,
    schemaVersion: v3 ? RECOVERY_V3_SCHEMA_VERSION : RECOVERY_SCHEMA_VERSION,
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
  } as RecoveryBundle | RecoveryBundleV3;
  if (v3) {
    const localState = validateRecoveryLocalStateV3(
      (input as RecoveryCaptureV3).localState,
      sourceText.length,
      input.doc,
    );
    validateLocalStateMathCrossCheck(localState, pendingMath, input.doc, "$.localState");
    (bundle as RecoveryBundleV3).localState = localState;
    assertByteLimit(JSON.stringify(localState), MAX_LOCAL_STATE_BYTES, "$.localState");
  }
  const serialized = JSON.stringify(bundle);
  assertByteLimit(serialized, MAX_BUNDLE_BYTES, "$");
  return serialized;
}

export function decodeRecoveryBundle(input: string | unknown, schema: Schema): DecodedRecovery {
  const bundle = parseBundle(input);
  if (bundle.format !== RECOVERY_FORMAT) {
    throw new RecoveryValidationError("invalid-format", "Recovery file format is not supported.", "$.format");
  }
  if (bundle.schemaVersion === RECOVERY_SCHEMA_VERSION) {
    assertExactKeys(bundle, recoveryBundleKeys, "$");
    return decodeRecoveryBase(bundle, schema);
  }
  if (bundle.schemaVersion === RECOVERY_V3_SCHEMA_VERSION) {
    assertExactKeys(bundle, recoveryBundleV3Keys, "$");
    const decoded = decodeRecoveryBase(bundle, schema);
    const localState = validateRecoveryLocalStateV3(bundle.localState, decoded.sourceText.length, decoded.doc);
    validateLocalStateMathCrossCheck(localState, decoded.pendingMath, decoded.doc, "$.localState");
    return {
      ...decoded,
      localState,
    };
  }
  throw new RecoveryValidationError("unsupported-version", "Recovery file schema version is not supported.", "$.schemaVersion");
}

export function decodeRecoveryBundleV3(input: string | unknown, schema: Schema): DecodedRecoveryV3 {
  const decoded = decodeRecoveryBundle(input, schema);
  if (!decoded.localState) {
    throw new RecoveryValidationError("unsupported-version", "Recovery file schema version is not supported.", "$.schemaVersion");
  }
  return decoded as DecodedRecoveryV3;
}

const recoveryBundleKeys = ["format", "schemaVersion", "source", "document", "selection", "scroll", "pendingMath", "origin"] as const;
const recoveryBundleV3Keys = [...recoveryBundleKeys, "localState"] as const;

function decodeRecoveryBase(bundle: Record<string, unknown>, schema: Schema): DecodedRecovery {
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

/**
 * Validate and copy the v3 local state.  This function is intentionally
 * independent of an EditorView or a renderer: strings that happen to contain
 * HTML, Mermaid source, or script-looking text remain opaque JSON data.
 */
export function validateRecoveryLocalStateV3(
  value: unknown,
  sourceUtf16Length?: number,
  doc?: ProseMirrorNode,
): RecoveryLocalStateV3 {
  const path = "$.localState";
  const record = expectRecord(value, path, "invalid-local-state");
  validateLocalJsonValue(record, path);
  assertExactKeys(record, ["schema", "revision", "buffers", "exposedMarkdown", "composition", "history"], path, "invalid-local-state");
  if (record.schema !== "lightmark.local-state") {
    throw new RecoveryValidationError("invalid-local-state", "Local state schema is unsupported.", `${path}.schema`);
  }
  assertNonNegativeSafeInteger(record.revision, `${path}.revision`, "Local state revision must be a non-negative safe integer.");
  if (!Array.isArray(record.buffers) || record.buffers.length > MAX_LOCAL_BUFFERS) {
    throw new RecoveryValidationError("invalid-local-state", "Local state buffer count exceeds the supported limit.", `${path}.buffers`);
  }
  const ids = new Set<string>();
  const buffers = record.buffers.map((entry, index) => validateLocalBuffer(
    entry,
    `${path}.buffers[${index}]`,
    record.revision as number,
    sourceUtf16Length,
    ids,
    doc,
  ));
  const exposedMarkdown = record.exposedMarkdown === null
    ? null
    : validateExposedMarkdownV3(record.exposedMarkdown, `${path}.exposedMarkdown`, record.revision as number, doc);
  const composition = record.composition === null
    ? null
    : validateCompositionV3(record.composition, `${path}.composition`, record.revision as number);
  const history = validateHistoryV3(record.history, `${path}.history`);
  return {
    schema: "lightmark.local-state",
    revision: record.revision,
    buffers,
    exposedMarkdown,
    composition,
    history,
  };
}

function validateLocalBuffer(
  value: unknown,
  path: string,
  localRevision: number,
  sourceUtf16Length: number | undefined,
  ids: Set<string>,
  doc: ProseMirrorNode | undefined,
): RecoveryLocalBufferV3 {
  const record = expectRecord(value, path, "invalid-local-state");
  assertAllowedKeys(record, ["id", "kind", "status", "sourceRevision", "pmPath", "positionHint", "rawSpan", "payload", "ui", "error"], path, "invalid-local-state");
  requireKeys(record, ["id", "kind", "status", "sourceRevision", "payload"], path, "invalid-local-state");
  assertIdentifier(record.id, `${path}.id`, "Local buffer id is invalid.");
  if (ids.has(record.id)) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer ids must be unique.", `${path}.id`);
  }
  ids.add(record.id);
  if (typeof record.kind !== "string" || !localBufferKinds.has(record.kind)) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer kind is unsupported.", `${path}.kind`);
  }
  if (typeof record.status !== "string" || !localBufferStatuses.has(record.status)) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer status is unsupported.", `${path}.status`);
  }
  assertNonNegativeSafeInteger(record.sourceRevision, `${path}.sourceRevision`, "Local buffer sourceRevision must be a non-negative safe integer.");
  if ((record.sourceRevision as number) > localRevision) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer sourceRevision cannot be newer than local state revision.", `${path}.sourceRevision`);
  }

  const pmPath = record.pmPath === undefined ? undefined : validatePmPath(record.pmPath, `${path}.pmPath`);
  const positionHint = record.positionHint === undefined
    ? undefined
    : validatePositionHint(record.positionHint, `${path}.positionHint`);
  const rawSpan = record.rawSpan === undefined
    ? undefined
    : validateRawSpan(record.rawSpan, `${path}.rawSpan`, sourceUtf16Length);
  const payload = validateLocalPayload(record.kind, record.payload, `${path}.payload`, record.status);
  const payloadTextLength = localPayloadTextLength(record.kind, payload);
  const ui = record.ui === undefined ? undefined : validateTextUi(record.ui, `${path}.ui`, payloadTextLength);
  const error = record.error === undefined ? undefined : validateLocalError(record.error, `${path}.error`);
  if ((record.status === "conflicted" || record.status === "orphaned") && !error) {
    throw new RecoveryValidationError("invalid-local-state", "Conflicted or orphaned local buffers must retain a typed error.", `${path}.error`);
  }
  if (doc && (record.status === "accepted" || record.status === "editing")) {
    validateLocalBufferBinding(
      record.kind,
      payload,
      pmPath,
      positionHint,
      doc,
      path,
    );
  }
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    sourceRevision: record.sourceRevision,
    ...(pmPath ? { pmPath } : {}),
    ...(positionHint !== undefined ? { positionHint } : {}),
    ...(rawSpan ? { rawSpan } : {}),
    payload,
    ...(ui ? { ui } : {}),
    ...(error ? { error } : {}),
  } as RecoveryLocalBufferV3;
}

function validateLocalBufferBinding(
  kind: string,
  payload: any,
  pmPath: number[] | undefined,
  positionHint: number | null | undefined,
  doc: ProseMirrorNode,
  path: string,
) {
  if (pmPath === undefined && (positionHint === undefined || positionHint === null)) return;
  const expectedTypes = expectedLocalNodeTypes(kind, payload);
  const fromPath = pmPath === undefined ? undefined : resolvePmPath(doc, pmPath);
  if (pmPath !== undefined && !fromPath) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer PM path does not resolve in the recovered document.", `${path}.pmPath`);
  }
  const fromPosition = positionHint === undefined || positionHint === null
    ? undefined
    : doc.nodeAt(positionHint);
  if (positionHint !== undefined && positionHint !== null && !fromPosition) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer positionHint does not point to a document node.", `${path}.positionHint`);
  }
  if (fromPath && fromPosition && fromPath.pos !== positionHint) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer PM path and positionHint do not identify the same node.", path);
  }
  const node = fromPath?.node || fromPosition;
  if (!node || !expectedTypes.includes(node.type.name)) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer binding points to an unexpected ProseMirror node type.", path);
  }
  assertLocalAcceptedAttrs(kind, payload, node, path);
}

function expectedLocalNodeTypes(kind: string, payload: any): string[] {
  if (kind === "frontmatter") return ["frontMatter"];
  if (kind === "htmlBlock") return ["htmlBlock"];
  if (kind === "footnote") return ["footnotes"];
  if (kind === "toc") return ["tableOfContents"];
  if (kind === "mermaid") return ["mermaidDiagram"];
  if (kind === "math") return payload?.local?.displayMode ? ["blockMath"] : ["inlineMath"];
  return [];
}

function resolvePmPath(doc: ProseMirrorNode, path: readonly number[]) {
  let node = doc;
  let nodePos = -1;
  for (const index of path) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= node.childCount) return null;
    let offset = 0;
    for (let childIndex = 0; childIndex < index; childIndex += 1) offset += node.child(childIndex).nodeSize;
    nodePos = nodePos < 0 ? offset : nodePos + 1 + offset;
    node = node.child(index);
  }
  return { node, pos: nodePos };
}

function assertLocalAcceptedAttrs(kind: string, payload: any, node: ProseMirrorNode, path: string) {
  const attrs = node.attrs as Record<string, unknown>;
  const accepted = payload?.accepted;
  const same = kind === "frontmatter"
    ? accepted?.yaml === attrs.yaml && accepted?.editing === attrs.editing
    : kind === "htmlBlock"
      ? accepted?.html === attrs.html && accepted?.editing === attrs.editing
      : kind === "footnote"
        ? accepted?.markdown === attrs.markdown && accepted?.html === attrs.html && accepted?.editing === attrs.editing
        : kind === "mermaid"
          ? accepted?.code === attrs.code && accepted?.editing === attrs.editing
          : kind === "math"
            ? mathContentMatchesNode(accepted, attrs)
            : kind === "toc"
              ? (payload.editing === undefined || payload.editing === attrs.editing)
              : true;
  if (!same) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer accepted payload does not match the bound document node.", `${path}.payload.accepted`);
  }
}

function validateExposedMarkdownBinding(
  range: RecoveryExposedMarkdownRange,
  selection: { anchor: number; head: number },
  doc: ProseMirrorNode,
  path: string,
) {
  const max = doc.content.size;
  for (const [name, value] of [["from", range.from], ["to", range.to], ["blockFrom", range.blockFrom], ["selection.anchor", selection.anchor], ["selection.head", selection.head]] as const) {
    if (value > max) {
      throw new RecoveryValidationError("invalid-local-state", "Exposed Markdown position is outside the recovered document.", `${path}.${name}`);
    }
  }
  if (range.kind === "heading") {
    const node = doc.nodeAt(range.blockFrom);
    if (!node || (node.type.name !== "heading" && node.type.name !== "markdownHeading")) {
      throw new RecoveryValidationError("invalid-local-state", "Heading exposed Markdown range is not bound to a heading node.", `${path}.range.blockFrom`);
    }
    if (range.headingLevel !== undefined && node.attrs.level !== undefined && node.attrs.level !== range.headingLevel) {
      throw new RecoveryValidationError("invalid-local-state", "Heading exposed Markdown level does not match the document node.", `${path}.range.headingLevel`);
    }
    const blockEnd = range.blockFrom + node.nodeSize - 1;
    if (range.from < range.blockFrom + 1 || range.to > blockEnd) {
      throw new RecoveryValidationError("invalid-local-state", "Heading exposed Markdown range exceeds its bound heading.", `${path}.range`);
    }
  } else {
    const node = doc.nodeAt(range.blockFrom);
    if (!node?.isTextblock) {
      throw new RecoveryValidationError("invalid-local-state", "Inline exposed Markdown range is not bound to a textblock.", `${path}.range.blockFrom`);
    }
    const blockEnd = range.blockFrom + node.nodeSize - 1;
    if (range.from < range.blockFrom + 1 || range.to > blockEnd) {
      throw new RecoveryValidationError("invalid-local-state", "Inline exposed Markdown range exceeds its bound textblock.", `${path}.range`);
    }
  }
}

function validateLocalStateMathCrossCheck(
  localState: RecoveryLocalStateV3,
  pendingMath: RecoveryPendingMath,
  doc: ProseMirrorNode,
  path: string,
) {
  const pendingById = new Map(pendingMath.entries.map((entry) => [entry.id, entry]));
  for (const [index, buffer] of localState.buffers.entries()) {
    if (buffer.kind !== "math" || !buffer.payload || typeof buffer.payload !== "object") continue;
    const pending = pendingById.get(buffer.id);
    if (!pending) continue;
    const payload = buffer.payload as any;
    if (!jsonEqual(payload.accepted, pending.accepted) || !jsonEqual(payload.local, pending.local)) {
      throw new RecoveryValidationError("invalid-local-state", "Math local buffer and pendingMath payload disagree for the same stable id.", `${path}.buffers[${index}].payload`);
    }
    if (pending.binding.status === "linked" && buffer.status !== "conflicted" && buffer.status !== "orphaned"
      && buffer.positionHint !== undefined && buffer.positionHint !== null
      && buffer.positionHint !== pending.binding.position) {
      throw new RecoveryValidationError("invalid-local-state", "Math local buffer position does not match its pendingMath binding.", `${path}.buffers[${index}].positionHint`);
    }
  }
}

function validateLocalPayload(
  kind: string,
  value: unknown,
  path: string,
  status: string,
): unknown {
  if (value === null && (status === "conflicted" || status === "orphaned")) return null;
  if (kind === "frontmatter") return validateFrontmatterPayload(value, path);
  if (kind === "htmlBlock") return validateHtmlBlockPayload(value, path);
  if (kind === "footnote") return validateFootnotePayload(value, path);
  if (kind === "toc") return validateTocPayload(value, path);
  if (kind === "mermaid") return validateMermaidPayload(value, path);
  if (kind === "math") return validateMathLocalPayload(value, path);
  throw new RecoveryValidationError("invalid-local-state", "Local buffer kind is unsupported.", path);
}

function validateFrontmatterPayload(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["accepted", "draft", "valueRevision"]);
  requireKeys(record, ["accepted", "draft"], path, "invalid-local-state");
  const accepted = validateAcceptedTextState(record.accepted, `${path}.accepted`, "yaml", ["yaml", "editing"]);
  const draft = validateTextDraft(record.draft, `${path}.draft`, "yaml", ["yaml", "editing"]);
  const valueRevision = validateOptionalRevision(record.valueRevision, `${path}.valueRevision`);
  return {
    accepted,
    draft,
    ...(valueRevision === undefined ? {} : { valueRevision }),
  };
}

function validateHtmlBlockPayload(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["accepted", "draft", "committing", "valueRevision"]);
  requireKeys(record, ["accepted", "draft"], path, "invalid-local-state");
  const accepted = validateAcceptedTextState(
    record.accepted,
    `${path}.accepted`,
    "html",
    ["html", "editing", "decoded", "sanitized"],
  );
  const draft = validateTextDraft(
    record.draft,
    `${path}.draft`,
    "html",
    ["html", "value", "decoded", "sanitized", "editing"],
  );
  const committing = validateOptionalBoolean(record.committing, `${path}.committing`);
  const valueRevision = validateOptionalRevision(record.valueRevision, `${path}.valueRevision`);
  return {
    accepted,
    draft,
    ...(committing === undefined ? {} : { committing }),
    ...(valueRevision === undefined ? {} : { valueRevision }),
  };
}

function validateFootnotePayload(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["accepted", "draft", "fallbackHtml", "normalized", "committing", "frame", "valueRevision"]);
  requireKeys(record, ["accepted", "draft", "fallbackHtml"], path, "invalid-local-state");
  const accepted = validateAcceptedFootnoteState(record.accepted, `${path}.accepted`);
  const draft = validateTextDraft(record.draft, `${path}.draft`, "markdown", ["markdown", "normalized", "editing"]);
  const fallbackHtml = validateText(record.fallbackHtml, `${path}.fallbackHtml`);
  const normalized = validateOptionalBoolean(record.normalized, `${path}.normalized`);
  const committing = validateOptionalBoolean(record.committing, `${path}.committing`);
  const frame = validateOptionalFrame(record.frame, `${path}.frame`);
  const valueRevision = validateOptionalRevision(record.valueRevision, `${path}.valueRevision`);
  return {
    accepted,
    draft,
    fallbackHtml,
    ...(normalized === undefined ? {} : { normalized }),
    ...(committing === undefined ? {} : { committing }),
    ...(frame === undefined ? {} : { frame }),
    ...(valueRevision === undefined ? {} : { valueRevision }),
  };
}

function validateTocPayload(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["candidate", "accepted", "editing", "valueRevision"]);
  requireKeys(record, ["candidate"], path, "invalid-local-state");
  const candidate = validateText(record.candidate, `${path}.candidate`);
  const accepted = record.accepted === undefined ? undefined : validateText(record.accepted, `${path}.accepted`);
  const editing = validateOptionalBoolean(record.editing, `${path}.editing`);
  const valueRevision = validateOptionalRevision(record.valueRevision, `${path}.valueRevision`);
  return {
    candidate,
    ...(accepted === undefined ? {} : { accepted }),
    ...(editing === undefined ? {} : { editing }),
    ...(valueRevision === undefined ? {} : { valueRevision }),
  };
}

function validateMermaidPayload(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["accepted", "draft", "preview", "valueRevision"]);
  requireKeys(record, ["accepted", "draft"], path, "invalid-local-state");
  const accepted = validateAcceptedTextState(record.accepted, `${path}.accepted`, "code", ["code", "editing"]);
  const draft = validateTextDraft(record.draft, `${path}.draft`, "code", ["code", "editing"]);
  const preview = record.preview === undefined ? undefined : validateMermaidPreview(record.preview, `${path}.preview`);
  const valueRevision = validateOptionalRevision(record.valueRevision, `${path}.valueRevision`);
  return {
    accepted,
    draft,
    ...(preview === undefined ? {} : { preview }),
    ...(valueRevision === undefined ? {} : { valueRevision }),
  };
}

function validateMathLocalPayload(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["accepted", "local", "valueRevision", "ui"]);
  requireKeys(record, ["accepted", "local", "valueRevision"], path, "invalid-local-state");
  const accepted = validateLocalMathContent(record.accepted, `${path}.accepted`);
  const local = validateLocalMathContent(record.local, `${path}.local`);
  const valueRevision = validateNonNegativeSafeInteger(record.valueRevision, `${path}.valueRevision`, "Math local valueRevision must be a non-negative safe integer.");
  const ui = record.ui === undefined || record.ui === null
    ? record.ui
    : validateTextUi(record.ui, `${path}.ui`, local.raw.length);
  return {
    accepted,
    local,
    valueRevision,
    ...(ui === undefined ? {} : { ui }),
  };
}

function validateAcceptedTextState(value: unknown, path: string, textKey: string, keys: readonly string[]) {
  const record = localPayloadRecord(value, path, keys);
  requireKeys(record, [textKey, "editing"], path, "invalid-local-state");
  const text = validateText(record[textKey], `${path}.${textKey}`);
  const editing = validateBoolean(record.editing, `${path}.editing`);
  const result: Record<string, unknown> = { [textKey]: text, editing };
  for (const key of keys) {
    if (key === textKey || key === "editing" || record[key] === undefined) continue;
    if (key === "decoded" || key === "sanitized") result[key] = validateBoolean(record[key], `${path}.${key}`);
  }
  return result;
}

function validateAcceptedFootnoteState(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["markdown", "html", "editing"]);
  requireKeys(record, ["markdown", "html", "editing"], path, "invalid-local-state");
  return {
    markdown: validateText(record.markdown, `${path}.markdown`),
    html: validateText(record.html, `${path}.html`),
    editing: validateBoolean(record.editing, `${path}.editing`),
  };
}

function validateTextDraft(value: unknown, path: string, textKey: string, keys: readonly string[]) {
  if (typeof value === "string") return validateText(value, path);
  const record = localPayloadRecord(value, path, keys);
  const aliases = textKey === "html" && keys.includes("value") ? ["html", "value"] : [textKey];
  const present = aliases.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (present.length === 0) {
    throw new RecoveryValidationError("invalid-local-state", `Local draft must contain ${textKey} text.`, path);
  }
  for (const key of present) {
    if (typeof record[key] !== "string") {
      throw new RecoveryValidationError("invalid-local-state", `Local draft ${key} alias must be text when present.`, `${path}.${key}`);
    }
  }
  if (present.length > 1) {
    throw new RecoveryValidationError("invalid-local-state", "Local draft contains ambiguous text aliases.", path);
  }
  const textKeyPresent = present[0];
  const result: Record<string, unknown> = { [textKeyPresent]: validateText(record[textKeyPresent], `${path}.${textKeyPresent}`) };
  for (const key of keys) {
    if (key === textKeyPresent || record[key] === undefined) continue;
    if (key === "editing" || key === "decoded" || key === "sanitized" || key === "normalized") {
      result[key] = validateBoolean(record[key], `${path}.${key}`);
    }
  }
  return result;
}

function validateMermaidPreview(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["generation", "status"]);
  requireKeys(record, ["generation", "status"], path, "invalid-local-state");
  const generation = validateNonNegativeSafeInteger(record.generation, `${path}.generation`, "Mermaid preview generation must be a non-negative safe integer.");
  if (typeof record.status !== "string" || record.status.length === 0 || record.status.length > MAX_LOCAL_PREVIEW_STATUS_LENGTH) {
    throw new RecoveryValidationError("invalid-local-state", "Mermaid preview status is invalid.", `${path}.status`);
  }
  return { generation, status: record.status };
}

function validateLocalMathContent(value: unknown, path: string) {
  const record = localPayloadRecord(value, path, ["tex", "delimiter", "raw", "originalTex", "displayMode"]);
  requireKeys(record, ["tex", "delimiter", "raw", "originalTex", "displayMode"], path, "invalid-local-state");
  for (const key of ["tex", "raw", "originalTex"] as const) validateMathText(record[key], `${path}.${key}`);
  if (typeof record.delimiter !== "string" || !mathDelimiters.has(record.delimiter)) {
    throw new RecoveryValidationError("invalid-local-state", "Math local delimiter is unsupported.", `${path}.delimiter`);
  }
  if (typeof record.displayMode !== "boolean") {
    throw new RecoveryValidationError("invalid-local-state", "Math local displayMode must be boolean.", `${path}.displayMode`);
  }
  return {
    tex: record.tex,
    delimiter: record.delimiter,
    raw: record.raw,
    originalTex: record.originalTex,
    displayMode: record.displayMode,
  };
}

function validateExposedMarkdownV3(
  value: unknown,
  path: string,
  localRevision: number,
  doc?: ProseMirrorNode,
): RecoveryExposedMarkdownV3 {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["active", "range", "docRevision", "selection"], path, "invalid-local-state");
  const active = validateBoolean(record.active, `${path}.active`);
  const docRevision = validateNonNegativeSafeInteger(record.docRevision, `${path}.docRevision`, "Exposed Markdown docRevision must be a non-negative safe integer.");
  if (docRevision > localRevision) {
    throw new RecoveryValidationError("invalid-local-state", "Exposed Markdown docRevision cannot be newer than local state revision.", `${path}.docRevision`);
  }
  const range = validateExposedMarkdownRange(record.range, `${path}.range`);
  const selection = validateSelectionOffsets(record.selection, `${path}.selection`);
  if (doc && active) validateExposedMarkdownBinding(range, selection, doc, path);
  return { active, range, docRevision, selection };
}

function validateExposedMarkdownRange(value: unknown, path: string): RecoveryExposedMarkdownRange {
  const record = expectRecord(value, path, "invalid-local-state");
  assertAllowedKeys(record, ["kind", "from", "to", "blockFrom", "open", "close", "markName", "headingLevel", "headingInvalid"], path, "invalid-local-state");
  requireKeys(record, ["kind", "from", "to", "blockFrom", "open", "close"], path, "invalid-local-state");
  if (record.kind !== "heading" && record.kind !== "inline") {
    throw new RecoveryValidationError("invalid-local-state", "Exposed Markdown range kind is unsupported.", `${path}.kind`);
  }
  const from = validateNonNegativeSafeInteger(record.from, `${path}.from`, "Exposed Markdown range from is invalid.");
  const to = validateNonNegativeSafeInteger(record.to, `${path}.to`, "Exposed Markdown range to is invalid.");
  const blockFrom = validateNonNegativeSafeInteger(record.blockFrom, `${path}.blockFrom`, "Exposed Markdown blockFrom is invalid.");
  if (from > to) throw new RecoveryValidationError("invalid-local-state", "Exposed Markdown range must be ordered.", path);
  const open = validateText(record.open, `${path}.open`);
  const close = validateText(record.close, `${path}.close`);
  const markName = record.markName === undefined ? undefined : validateIdentifierText(record.markName, `${path}.markName`);
  const headingLevel = record.headingLevel === undefined
    ? undefined
    : validateNonNegativeSafeInteger(record.headingLevel, `${path}.headingLevel`, "Exposed Markdown headingLevel is invalid.");
  if (record.kind === "heading" && (headingLevel === undefined || headingLevel < 1 || headingLevel > 6)) {
    throw new RecoveryValidationError("invalid-local-state", "Heading exposed Markdown range must retain a level from one to six.", `${path}.headingLevel`);
  }
  const headingInvalid = record.headingInvalid === undefined ? undefined : validateBoolean(record.headingInvalid, `${path}.headingInvalid`);
  return {
    kind: record.kind,
    from,
    to,
    blockFrom,
    open,
    close,
    ...(markName === undefined ? {} : { markName }),
    ...(headingLevel === undefined ? {} : { headingLevel }),
    ...(headingInvalid === undefined ? {} : { headingInvalid }),
  };
}

function validateCompositionV3(value: unknown, path: string, localRevision: number): RecoveryCompositionV3 {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["active", "source", "revision"], path, "invalid-local-state");
  const active = validateBoolean(record.active, `${path}.active`);
  if (record.source !== "pm" && record.source !== "node-view") {
    throw new RecoveryValidationError("invalid-local-state", "Composition source is unsupported.", `${path}.source`);
  }
  const revision = validateNonNegativeSafeInteger(record.revision, `${path}.revision`, "Composition revision is invalid.");
  if (revision > localRevision) {
    throw new RecoveryValidationError("invalid-local-state", "Composition revision cannot be newer than local state revision.", `${path}.revision`);
  }
  return { active, source: record.source, revision };
}

function validateHistoryV3(value: unknown, path: string): RecoveryHistoryV3 {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["sourceCheckpointId", "format", "pm", "source"], path, "invalid-local-state");
  const sourceCheckpointId = validateIdentifierText(record.sourceCheckpointId, `${path}.sourceCheckpointId`);
  const formatRecord = expectRecord(record.format, `${path}.format`, "invalid-local-state");
  assertExactKeys(formatRecord, ["undo", "redo"], `${path}.format`, "invalid-local-state");
  const undo = validateFormatHistoryStack(formatRecord.undo, `${path}.format.undo`);
  const redo = validateFormatHistoryStack(formatRecord.redo, `${path}.format.redo`);
  const pm = validateHistoryAvailability(record.pm, `${path}.pm`);
  const source = validateHistoryAvailability(record.source, `${path}.source`);
  return { sourceCheckpointId, format: { undo, redo }, pm, source };
}

function validateFormatHistoryStack(value: unknown, path: string): WysiwygFormatHistoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_LOCAL_HISTORY_ENTRIES) {
    throw new RecoveryValidationError("invalid-local-state", "Format history stack exceeds the supported limit.", path);
  }
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = expectRecord(entry, entryPath, "invalid-local-state");
    assertExactKeys(record, ["before", "after", "beforeAnchor", "beforeHead", "afterAnchor", "afterHead"], entryPath, "invalid-local-state");
    const before = validateText(record.before, `${entryPath}.before`);
    const after = validateText(record.after, `${entryPath}.after`);
    const beforeAnchor = validateNonNegativeSafeInteger(record.beforeAnchor, `${entryPath}.beforeAnchor`, "Format history beforeAnchor is invalid.");
    const beforeHead = validateNonNegativeSafeInteger(record.beforeHead, `${entryPath}.beforeHead`, "Format history beforeHead is invalid.");
    const afterAnchor = validateNonNegativeSafeInteger(record.afterAnchor, `${entryPath}.afterAnchor`, "Format history afterAnchor is invalid.");
    const afterHead = validateNonNegativeSafeInteger(record.afterHead, `${entryPath}.afterHead`, "Format history afterHead is invalid.");
    if (beforeAnchor > before.length || beforeHead > before.length) {
      throw new RecoveryValidationError("invalid-local-state", "Format history before selection is outside its source text.", entryPath);
    }
    if (afterAnchor > after.length || afterHead > after.length) {
      throw new RecoveryValidationError("invalid-local-state", "Format history after selection is outside its source text.", entryPath);
    }
    return { before, after, beforeAnchor, beforeHead, afterAnchor, afterHead };
  });
}

function validateHistoryAvailability(value: unknown, path: string) {
  const record = expectRecord(value, path, "invalid-local-state");
  assertAllowedKeys(record, ["status", "reason", "checkpointId"], path, "invalid-local-state");
  requireKeys(record, ["status"], path, "invalid-local-state");
  if (record.status !== "captured" && record.status !== "unavailable") {
    throw new RecoveryValidationError("invalid-local-state", "History availability status is unsupported.", `${path}.status`);
  }
  const reason = record.reason === undefined ? undefined : validateErrorText(record.reason, `${path}.reason`, MAX_LOCAL_ERROR_MESSAGE_LENGTH);
  const checkpointId = record.checkpointId === undefined ? undefined : validateIdentifierText(record.checkpointId, `${path}.checkpointId`);
  if (reason === undefined) {
    throw new RecoveryValidationError("invalid-local-state", "Unavailable history must retain a reason.", `${path}.reason`);
  }
  if (record.status === "captured") {
    throw new RecoveryValidationError(
      "invalid-local-state",
      "PM/CM history cannot be marked captured until a versioned history adapter is available.",
      `${path}.status`,
    );
  }
  return {
    status: "unavailable" as const,
    reason,
    ...(checkpointId === undefined ? {} : { checkpointId }),
  };
}

function validatePmPath(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length > MAX_PATH_LENGTH || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer PM path is invalid.", path);
  }
  return value.map((entry) => entry as number);
}

function validatePositionHint(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer positionHint must be null or a non-negative safe integer.", path);
  }
  return value;
}

function validateRawSpan(value: unknown, path: string, sourceUtf16Length: number | undefined) {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["from", "to"], path, "invalid-local-state");
  const from = validateNonNegativeSafeInteger(record.from, `${path}.from`, "Local buffer raw span from is invalid.");
  const to = validateNonNegativeSafeInteger(record.to, `${path}.to`, "Local buffer raw span to is invalid.");
  if (from > to || (sourceUtf16Length !== undefined && to > sourceUtf16Length)) {
    throw new RecoveryValidationError("invalid-local-state", "Local buffer raw span is outside the source snapshot.", path);
  }
  return { from, to };
}

function validateTextUi(value: unknown, path: string, textLength: number | undefined): RecoveryLocalTextUi {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["anchor", "head", "direction", "focused", "composing"], path, "invalid-local-state");
  const anchor = validateNonNegativeSafeInteger(record.anchor, `${path}.anchor`, "Local text selection anchor is invalid.");
  const head = validateNonNegativeSafeInteger(record.head, `${path}.head`, "Local text selection head is invalid.");
  if (textLength !== undefined && (anchor > textLength || head > textLength)) {
    throw new RecoveryValidationError("invalid-local-state", "Local text selection is outside its captured value.", path);
  }
  if (typeof record.direction !== "string" || !textUiDirections.has(record.direction)) {
    throw new RecoveryValidationError("invalid-local-state", "Local text selection direction is unsupported.", `${path}.direction`);
  }
  const focused = validateBoolean(record.focused, `${path}.focused`);
  const composing = validateBoolean(record.composing, `${path}.composing`);
  return { anchor, head, direction: record.direction as "forward" | "backward" | "none", focused, composing };
}

function validateSelectionOffsets(value: unknown, path: string) {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["anchor", "head"], path, "invalid-local-state");
  return {
    anchor: validateNonNegativeSafeInteger(record.anchor, `${path}.anchor`, "Selection anchor is invalid."),
    head: validateNonNegativeSafeInteger(record.head, `${path}.head`, "Selection head is invalid."),
  };
}

function validateLocalError(value: unknown, path: string) {
  const record = expectRecord(value, path, "invalid-local-state");
  assertExactKeys(record, ["code", "message"], path, "invalid-local-state");
  return {
    code: validateErrorText(record.code, `${path}.code`, MAX_LOCAL_ERROR_CODE_LENGTH),
    message: validateErrorText(record.message, `${path}.message`, MAX_LOCAL_ERROR_MESSAGE_LENGTH),
  };
}

function localPayloadRecord(value: unknown, path: string, keys: readonly string[]) {
  const record = expectRecord(value, path, "invalid-local-state");
  assertAllowedKeys(record, keys, path, "invalid-local-state");
  return record;
}

function localPayloadTextLength(kind: string, payload: any): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const draft = payload.draft;
  if (typeof draft === "string") return draft.length;
  if (draft && typeof draft === "object") {
    for (const key of ["yaml", "html", "value", "markdown", "code"]) {
      if (typeof draft[key] === "string") return draft[key].length;
    }
  }
  if (kind === "toc" && typeof payload.candidate === "string") return payload.candidate.length;
  if (kind === "math" && payload.local && typeof payload.local.raw === "string") return payload.local.raw.length;
  return undefined;
}

function validateLocalJsonValue(value: unknown, path: string) {
  try {
    validateJsonValue(value, path);
  } catch (error) {
    if (error instanceof RecoveryValidationError && error.code === "invalid-json") {
      throw new RecoveryValidationError("invalid-local-state", error.message, error.path);
    }
    throw error;
  }
}

function validateText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > MAX_STRING_LENGTH) {
    throw new RecoveryValidationError("invalid-local-state", "Local state text is invalid or too large.", path);
  }
  return value;
}

function validateMathText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > MAX_MATH_TEXT_LENGTH) {
    throw new RecoveryValidationError("invalid-local-state", "Math local text is invalid or too large.", path);
  }
  return value;
}

function validateIdentifierText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOCAL_BUFFER_ID_LENGTH || value.includes("\u0000")) {
    throw new RecoveryValidationError("invalid-local-state", "Identifier text is invalid.", path);
  }
  return value;
}

function validateErrorText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\u0000")) {
    throw new RecoveryValidationError("invalid-local-state", "Error text is invalid.", path);
  }
  return value;
}

function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new RecoveryValidationError("invalid-local-state", "Expected a boolean.", path);
  return value;
}

function validateOptionalBoolean(value: unknown, path: string): boolean | undefined {
  return value === undefined ? undefined : validateBoolean(value, path);
}

function validateOptionalRevision(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : validateNonNegativeSafeInteger(value, path, "Revision must be a non-negative safe integer.");
}

function validateOptionalFrame(value: unknown, path: string): "idle" | "scheduled" | undefined {
  if (value === undefined) return undefined;
  if (value !== "idle" && value !== "scheduled") {
    throw new RecoveryValidationError("invalid-local-state", "Footnote frame state is unsupported.", path);
  }
  return value;
}

function validateNonNegativeSafeInteger(value: unknown, path: string, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RecoveryValidationError("invalid-local-state", message, path);
  }
  return value as number;
}

function assertNonNegativeSafeInteger(value: unknown, path: string, message: string): asserts value is number {
  validateNonNegativeSafeInteger(value, path, message);
}

function assertIdentifier(value: unknown, path: string, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOCAL_BUFFER_ID_LENGTH || value.includes("\u0000")) {
    throw new RecoveryValidationError("invalid-local-state", message, path);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  code: RecoveryValidationCode = "invalid-json",
) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RecoveryValidationError(code, `Unexpected field ${key}.`, `${path}.${key}`);
  }
}

function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  code: RecoveryValidationCode = "invalid-json",
) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new RecoveryValidationError(code, `Missing field ${key}.`, `${path}.${key}`);
    }
  }
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

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  code: RecoveryValidationCode = "invalid-json",
) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RecoveryValidationError(code, `Unexpected field ${key}.`, `${path}.${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new RecoveryValidationError(code, `Missing field ${key}.`, `${path}.${key}`);
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
