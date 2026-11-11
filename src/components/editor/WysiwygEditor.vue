<script setup lang="ts">
import { prepareFineSourcePreservation, preserveFineSourceBlock, captureWysiwygSourceBaseline, type WysiwygSourceBaseline, removeGithubAlertTitle, serializeGithubAlertBody, serializeTableCell, normalizeFootnoteSource, preserveMarkdownTerminalNewlines, editorHtmlToMarkdown, normalizeLeadingImageWhitespace, normalizeCodeLanguage, displayCodeLanguage, codeLanguageItems, codeLanguageNames } from '../../editor/wysiwygCodec';

import { matchesShortcut } from '../../utils/shortcuts';
import { computed, ref, onBeforeUnmount, onMounted, toRaw, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import { CommandManager, Extension, Mark, mergeAttributes, Node, wrappingInputRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { openUrl } from "@tauri-apps/plugin-opener";

import { createLowlight } from "lowlight";
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Fragment, Slice } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  appStore,
  consumePanePendingEditorPosition,
  getPaneContent,
  getPaneDocumentMode,
  getPaneEditorMode,
  getPaneStructuredOutline,
  getPanePendingModeCursor,
  getPaneTab,
  markDocumentChanged,
  completePendingImageCommand,
  openWikiLink,
  revealHeadingAtLine,
  setPaneContent,
  setPanePendingModeCursor,
  toggleHeadingFoldByKey,
  updatePaneOutlineAnchor,
  updatePanePosition,
} from "../../stores/appStore";
import {
  publishDocumentDerivedState,
  documentHistoryForTab,
  moveDocumentHistory,
  advanceDocumentRevision,
  documentRevision,
  registerDocumentSession,
  beginPendingImageCommand,
  documentCommandLease,
  mapPendingDocumentCommands,
  type DocumentSessionAdapter,
  type PendingFlushOptions,
  type SnapshotReason,
} from "../../editor/documentRuntime";
import {
  DOCUMENT_APPENDED_TRANSACTION_META_KEY,
  DOCUMENT_FLUSH_META_KEY,
  createDocumentMutationTracker,
  documentMutationTokensEqual,
  type DocumentMutationTracker,
  type PendingMathFlushRequest,
} from "../../editor/documentMutationTracker";
import { assetReferenceTransaction, captureAssetReferenceBookmark, projectAssetReferenceBookmark, validateAssetReferenceBookmark, assetBookmarkTransaction } from "../../editor/assetReferenceTransaction";
import { releasePendingCommand } from '../../editor/pendingDocumentCommands';
import { markAssetAttributeTransaction, pendingPmCommandMaps } from '../../editor/pendingPmCommandMaps';
import { checkpointSourceTransactionNode, compactSourceTransactionProvenance, recordSourceTransactionProvenance, sourceProvenanceDepth } from '../../editor/sourceTransactionProvenance';
import { equalCanonicalDocument } from '../../editor/canonicalDocumentEquality';
import type { ImageAssetTarget } from '../../utils/imageAssets';
import { convertInlineMarkdownSyntax, convertInlineCodeSyntax } from "../../editor/inlineMarkdownConversion";
import { materializeHistoryRoot, historySourceBookmark, historyPmBookmark, historyPmDocumentForSchema } from '../../editor/historySource';
import { subscribePendingEditorInput, hasPendingEditorBuffers, flushPendingEditorBuffers, pendingEditorInputVersion } from '../../editor/pendingEditorBuffer';
import { WysiwygSnapshotCache } from "../../editor/wysiwygSnapshot";
import { createWysiwygDerivedPlugin, getWysiwygDerivedState } from "../../editor/wysiwygDerived";
import { createWysiwygFocusPlugin } from "../../editor/wysiwygFocus";
import {
  canonicalMarkdownHistoryState,
  clearExposeMarkdownMeta,
  exposeHeadingMarkdown,
  exposeMarkdownAtCursor,
  exposeInlineMarkdown,
  exposeMarkdownMeta,
  headingPositionAt,
  markdownPresentationMeta,
  markdownMarkRangeAt,
  reconcileExposedHeading as reconcileExposedHeadingTransaction,
  removeExposedMarkdownFormatting,
  type ExposedMarkdownRange,
} from "../../editor/wysiwygMarkdownEditing";
import {
  formatMarkdownTable as formatMarkdownTableFromDom,
  markdownTableDividerForAlign,
  parseTableCellAlign,
  renderTableCellAlign,
  resizedTableElement,
  tableColumnAlignments,
  tableResizeWouldDropContent,
} from "../../editor/wysiwygTables";
import {
  createWysiwygFindPlugin,
  getWysiwygFindState,
  refreshWysiwygFindDecorations,
  setWysiwygFindQuery,
  type WysiwygFindMatch,
} from "../../editor/wysiwygFind";
import { ensureLowlightLanguage, installLowlightPlainTextFallback } from "../../editor/lowlightLanguages";
import { incrementalLowlightPlugin } from "../../editor/incrementalLowlight";
import { recordStartupStage } from "../../editor/startupMetrics";
import { findOptions, findReplaceStore, setFindResult } from "../../stores/findReplaceStore";
import { normalizeMatchIndex, replacementForMatch } from "../../utils/findReplace";
import { markdownTopLevelSourceBlocks, renderMarkdownForEditor } from "../../utils/markdown";
import { combinePreservedSourceBlocks, inspectSourceEnvelope, sourceBlocksForNodes } from "../../editor/sourcePreservation";
import { extractMathMacroDefinitions, mathTokenFromParts, parseMarkdownMath, serializeMathToken, type MathDelimiter } from "../../utils/mathMarkdown";
import { buildEditorPositionSnapshot, normalizeScrollSnapshot, scrollTopFromSnapshot } from "../../utils/editorPosition";
import {
  codeBlockIndentEdits,
  decidePairAction,
  detectMarkdownShortcut,
  type MarkdownShortcutMatch,
} from "../../utils/inputRules";
import { mapMarkdownOffset, type MarkdownFormatResult } from "../../utils/markdownFormat";
import { typewriterScrollDelta } from "../../utils/writingModes";
import { extractOutlineWithLines, resolveHeadingSection, structureOutline, type StructuredOutlineItem } from "../../utils/outline";
import {
  builtinSlashCommands,
  expandSnippet,
  filterSlashCommands,
  snippetSlashCommands,
} from "../../utils/snippets";
import {
  parseWikiLinkHref,
  wikiCompletionCandidates as findWikiCompletionCandidates,
  wikiLinkHref,
  wikiLinkMarkdown,
  type WikiCompletionCandidate,
} from "../../utils/wikiLinks";
import { containsInlineHtml, decodeHtmlEntities, renderInlineMarkdownInHtml, sanitizeHtmlFragment, sanitizeInlineHtmlSource } from "../../utils/html";
import { escapeMarkdownTableCell, markdownPipeRowToTableHtml } from "../../utils/tableMarkdown";
import {
  clipboardPayloadFromDataTransfer,
  plainTextToLiteralMarkdown,
  prepareSmartPaste,
  readClipboardPayload,
  type PasteConversionResult,
} from "../../utils/smartPaste";
import {
  buildClipboardCopyPayload,
  writeClipboardPayloadToEvent,
  type ClipboardCopyPayload,
} from "../../utils/clipboardCopy";
import {
  getImageFilesFromClipboard,
  getImageFilesFromDrop,
  imagePathsAsMarkdown,
  markdownImageSourceFromElement,
  resolveMarkdownImageSource,
  resolveRenderedImageSources,
  saveImagesAsMarkdown,
} from "../../utils/imageAssets";
import {
  clampImageWidth,
  imageMarkdownOrFigure,
  parseEnhancedFigureElement,
  type ImageAlignment,
} from "../../utils/enhancedImages";
import { MarkdownHeading } from "../../extensions/MarkdownHeading";
import {
  BlockMath,
  InlineMath,
  capturePendingMathRecovery,
  finalizePendingMathForClosePrompt,
  flushPendingMathEdits,
  getPendingMathEditVersion,
  getPendingMathInputVersion,
  hasPendingMathEdits,
} from "../../extensions/MathNodes";
import { InlineHtmlNode, RawHtmlNode } from "../../extensions/InlineHtmlNode";
import { EscapedDollarNode } from "../../extensions/EscapedDollarNode";
import { MermaidNode } from "../../extensions/MermaidNode";
import {
  decodeRecoveryBundleV3,
  encodeRecoveryBundleV3,
  assertRecoverySourceMappingProven,
  mergeRecoveryPendingMath,
  subtractCapturedPendingMath,
  type RecoveryCaptureV3,
  type RecoveryExposedMarkdownV3,
  type RecoveryLocalBufferV3,
  type RecoveryLocalStateV3,
  type RecoveryPendingMath,
} from "../../editor/recoveryCodec";
import {
  captureRecoveryLocalBuffersForOwner,
  hasRecoveryLocalBufferIssuesForOwner,
  registerRecoveryLocalBufferForOwner,
  recoveryLocalBufferRestoreIssuesForOwner,
  retainAndUnregisterRecoveryLocalBufferForOwner,
  restoreRecoveryLocalBuffersForOwner,
  type RecoveryLocalBufferRestoreIssue,
} from "../../editor/recoveryLocalState";
import type { CapturedEditorTarget, EditorPaneId, SlashCommandDefinition, WysiwygFormatHistoryEntry } from "../../types";
import UiIcon from "../ui/UiIcon.vue";

const props = withDefaults(defineProps<{ paneId?: EditorPaneId }>(), {
  paneId: "main",
});

const lowlight = installLowlightPlainTextFallback(createLowlight());
let wysiwygRevision = 0;
let documentMutationTracker: DocumentMutationTracker | null = null;
let observedPendingMathInputVersion = 0;
let observedPendingLocalInputVersion = 0;
let unregisterDocumentSession = () => {};
let pendingCommandLease = 0;
let unsubscribePendingEditorInput = () => {};
let snapshotCache: WysiwygSnapshotCache | null = null;
let primeExactWysiwygMarkdown: ((markdown: string) => void) | null = null;
let cachedWysiwygFind: { items: WysiwygFindMatch[]; error: string } = { items: [], error: "" };
let outlineDecorationEpoch = 0;
let outlineDecorationCache: { state: object; epoch: number; collapsed: string; value: Decoration[] } | null = null;
type WysiwygDocumentSessionAdapter = DocumentSessionAdapter & { readonly editorIdentity: object };
const outlineHeadingDecorationsKey = new PluginKey<{
  decorations: DecorationSet;
  epoch: number;
  collapsed: string;
}>("lightmarkOutlineHeadingDecorations");
const LOCAL_EDITOR_UI_TRANSACTION_META_KEY = "lightmarkLocalEditorUi";

function syncTrackedPendingMathInput(editor: object) {
  const nextVersion = getPendingMathInputVersion(editor);
  if (nextVersion === observedPendingMathInputVersion) return nextVersion;
  observedPendingMathInputVersion = nextVersion;
  documentMutationTracker?.recordPendingInput();
  return nextVersion;
}

type PendingLocalEditor = {
  readonly id: string;
  readonly hasPending: () => boolean;
  readonly flush: (request: PendingMathFlushRequest) => void | Promise<void>;
};

type PendingLocalEditorRegistry = {
  readonly entries: Set<PendingLocalEditor>;
  version: number;
  inputVersion: number;
};

type CombinedPendingEditVersion = {
  mathVersion: number;
  localVersion: number;
  epoch: number;
};

// Math and NodeView-local registries have independent counters.  Combining
// them with Math.max can hide a change whenever the smaller counter advances;
// keep a monotonic per-editor epoch keyed by the pair instead.
const combinedPendingEditVersions = new WeakMap<object, CombinedPendingEditVersion>();

function getCombinedPendingEditVersion(editor: object) {
  const mathVersion = getPendingMathInputVersion(editor);
  const localVersion = getPendingLocalInputVersion(editor);
  const previous = combinedPendingEditVersions.get(editor);
  if (!previous) {
    combinedPendingEditVersions.set(editor, { mathVersion, localVersion, epoch: 0 });
    return 0;
  }
  if (previous.mathVersion === mathVersion && previous.localVersion === localVersion) return previous.epoch;
  const next = {
    mathVersion,
    localVersion,
    epoch: previous.epoch + 1,
  };
  combinedPendingEditVersions.set(editor, next);
  return next.epoch;
}

// Local NodeView controls update a closure first and only write PM attrs at a
// commit boundary.  Keep a small per-editor registry so ordinary save/close
// can observe those buffers without serializing the whole document on input.
const pendingLocalEditors = new WeakMap<object, PendingLocalEditorRegistry>();

function registerPendingLocalEditor(editor: object, entry: PendingLocalEditor) {
  let registry = pendingLocalEditors.get(editor);
  if (!registry) {
    registry = { entries: new Set(), version: 0, inputVersion: 0 };
    pendingLocalEditors.set(editor, registry);
  }
  if ([...registry.entries].some((candidate) => candidate.id === entry.id)) {
    throw new Error(`本地编辑器缓冲 id 重复：${entry.id}`);
  }
  registry.entries.add(entry);
  registry.version += 1;
  let active = true;
  return {
    markInputChanged() {
      if (!active) return;
      registry!.version += 1;
      registry!.inputVersion += 1;
    },
    markChanged() {
      if (active) registry!.version += 1;
    },
    unregister() {
      if (!active) return;
      active = false;
      registry!.entries.delete(entry);
      registry!.version += 1;
    },
  };
}

function hasPendingLocalEdits(editor: object) {
  return hasRecoveryLocalBufferIssuesForOwner(editor)
    || [...(pendingLocalEditors.get(editor)?.entries ?? [])].some((entry) => entry.hasPending());
}

function getPendingLocalEditVersion(editor: object) {
  return pendingLocalEditors.get(editor)?.version ?? 0;
}

function getPendingLocalInputVersion(editor: object) {
  return pendingLocalEditors.get(editor)?.inputVersion ?? 0;
}

function markPendingLocalInput(ownerEditor: object) {
  const registry = pendingLocalEditors.get(ownerEditor);
  if (!registry) return;
  registry.version += 1;
  registry.inputVersion += 1;
  if (editor.value === ownerEditor && ownerTabStillExists() && editorOwnerTab) {
    markDocumentChanged(editorOwnerTab.id, wysiwygRevision);
  }
}

function syncTrackedPendingLocalInput(editor: object) {
  const nextVersion = getPendingLocalInputVersion(editor);
  if (nextVersion === observedPendingLocalInputVersion) return nextVersion;
  observedPendingLocalInputVersion = nextVersion;
  documentMutationTracker?.recordPendingInput();
  return nextVersion;
}

async function flushPendingLocalEditors(editor: object, request: PendingMathFlushRequest) {
  if (hasRecoveryLocalBufferIssuesForOwner(editor)) {
    throw new Error("存在未解决的本地恢复缓冲，已保留当前窗口。请先从恢复列表处理。");
  }
  const entries = pendingLocalEditors.get(editor)?.entries;
  if (!entries?.size) return;
  for (const entry of [...entries]) await entry.flush(request);
}

function recordTrackedTransactions(
  editor: object,
  transaction: Transaction,
  appendedTransactions: Transaction[] = [],
) {
  const tracker = documentMutationTracker;
  if (!tracker) return;
  syncTrackedPendingMathInput(editor);
  syncTrackedPendingLocalInput(editor);
  const activeFlushId = tracker.activeFlushId;
  const transactions = [transaction, ...appendedTransactions];
  for (const current of transactions) {
    if (!current.docChanged) continue;
    if (current.getMeta(LOCAL_EDITOR_UI_TRANSACTION_META_KEY)) continue;
    const isRoot = current === transaction;
    const authorized = Boolean(activeFlushId) && (
      isRoot
        ? current.getMeta(DOCUMENT_FLUSH_META_KEY) === activeFlushId
        : transaction.getMeta(DOCUMENT_FLUSH_META_KEY) === activeFlushId
          && (
            current.getMeta(DOCUMENT_APPENDED_TRANSACTION_META_KEY) === transaction
            || current.getMeta(DOCUMENT_FLUSH_META_KEY) === activeFlushId
          )
    );
    tracker.recordDocumentChange(
      authorized
        ? { kind: "pending-flush", flushId: activeFlushId! }
        : { kind: "document" },
    );
  }
}

let nextRecoveryNodeViewId = 0;

function recoveryNodeViewId(kind: string) {
  nextRecoveryNodeViewId += 1;
  return `${kind}-local-${nextRecoveryNodeViewId}`;
}

type RecoveryNodeViewPosition = (() => number | undefined) | boolean;

type RecoveryNodeBinding = {
  position: number | null;
  currentNode: any | null;
  failure?: {
    code: string;
    message: string;
    status: "conflicted" | "orphaned";
  };
};

function readRecoveryNodePosition(getPos: RecoveryNodeViewPosition) {
  if (typeof getPos !== "function") return null;
  try {
    const position = getPos();
    return Number.isSafeInteger(position) && (position as number) >= 0 ? position as number : null;
  } catch {
    return null;
  }
}

function sameRecoveryNodeAttrs(left: any, right: any) {
  if (!left || !right || left.type?.name !== right.type?.name) return false;
  const keys = new Set([...Object.keys(left.attrs || {}), ...Object.keys(right.attrs || {})]);
  return [...keys].every((key) => left.attrs?.[key] === right.attrs?.[key]);
}

function readRecoveryNodeBinding(
  editor: any,
  getPos: RecoveryNodeViewPosition,
  acceptedNode: any,
  expectedType: string,
  lastKnownPosition: number | null,
): RecoveryNodeBinding {
  const position = readRecoveryNodePosition(getPos);
  if (position === null) {
    return {
      position: lastKnownPosition,
      currentNode: null,
      failure: {
        code: "node-view-position-unavailable",
        message: "NodeView position is unavailable; its local value was retained as an orphan.",
        status: "orphaned",
      },
    };
  }
  const doc = editor?.view?.state?.doc;
  let currentNode: any = null;
  try {
    currentNode = doc?.nodeAt?.(position) ?? null;
  } catch {
    currentNode = null;
  }
  if (!currentNode || currentNode.type?.name !== expectedType) {
    return {
      position,
      currentNode,
      failure: {
        code: "document-node-unavailable",
        message: "The current PM node no longer matches this local NodeView.",
        status: "conflicted",
      },
    };
  }
  if (!sameRecoveryNodeAttrs(currentNode, acceptedNode)) {
    return {
      position,
      currentNode,
      failure: {
        code: "document-node-changed",
        message: "The PM node changed while its local value was pending.",
        status: "conflicted",
      },
    };
  }
  return { position, currentNode };
}

function readRecoveryTextUi(
  control: HTMLInputElement | HTMLTextAreaElement,
  composing: boolean,
) {
  const direction = control.selectionDirection === "forward" || control.selectionDirection === "backward"
    ? control.selectionDirection
    : "none" as const;
  return {
    anchor: control.selectionStart ?? control.value.length,
    head: control.selectionEnd ?? control.value.length,
    direction,
    focused: document.activeElement === control,
    composing,
  };
}

function recoveryTextFailurePayload(
  accepted: Record<string, unknown>,
  textKey: string,
  value: string,
  extra: Record<string, unknown> = {},
) {
  return {
    accepted,
    draft: { [textKey]: value },
    ...extra,
  };
}

type RecoverySourceBaseline = {
  readonly sourceText: string;
  readonly sourceBytes: Uint8Array;
  readonly revision: number;
  readonly mappingProven: false;
  readonly reason: string;
};

const recoveryNodeKinds = {
  frontMatter: "frontmatter",
  htmlBlock: "htmlBlock",
  footnotes: "footnote",
  tableOfContents: "toc",
  mermaidDiagram: "mermaid",
  inlineMath: "math",
  blockMath: "math",
} as const;

function recoveryNodeCounts(doc: any) {
  const counts: Record<string, number> = {
    frontmatter: 0,
    htmlBlock: 0,
    footnote: 0,
    toc: 0,
    mermaid: 0,
    math: 0,
  };
  doc?.descendants?.((node: any) => {
    const kind = recoveryNodeKinds[node?.type?.name as keyof typeof recoveryNodeKinds];
    if (kind) counts[kind] += 1;
    return true;
  });
  return counts;
}

function recoveryBufferCounts(buffers: readonly RecoveryLocalBufferV3[]) {
  const counts: Record<string, number> = {
    frontmatter: 0,
    htmlBlock: 0,
    footnote: 0,
    toc: 0,
    mermaid: 0,
    math: 0,
  };
  for (const buffer of buffers) counts[buffer.kind] += 1;
  return counts;
}

function recoveryCountsMismatch(doc: any, buffers: readonly RecoveryLocalBufferV3[]) {
  const expected = recoveryNodeCounts(doc);
  const actual = recoveryBufferCounts(buffers);
  const mismatches: string[] = [];
  for (const kind of Object.keys(expected)) {
    if (actual[kind] < expected[kind]) {
      mismatches.push(`${kind}: expected at least ${expected[kind]}, captured ${actual[kind]}`);
      continue;
    }
    if (actual[kind] <= expected[kind]) continue;
    const extras = buffers.filter((buffer) => buffer.kind === kind && (buffer.status === "accepted" || buffer.status === "editing"));
    if (extras.length) {
      mismatches.push(`${kind}: ${extras.length} accepted/editing buffer(s) have no current PM node`);
    }
  }
  return mismatches;
}

function defaultRecoveryExposedRange(state: any) {
  let blockFrom = 0;
  let blockEnd = 0;
  state.doc.descendants((node: any, pos: number) => {
    if (!node?.isTextblock) return true;
    blockFrom = pos;
    blockEnd = pos + node.nodeSize - 1;
    return false;
  });
  const from = blockFrom + 1 <= blockEnd ? blockFrom + 1 : 0;
  const to = from;
  return {
    kind: "inline" as const,
    from,
    to,
    blockFrom,
    open: "",
    close: "",
  };
}

function recoveryExposedMarkdownState(state: any, revision: number): RecoveryExposedMarkdownV3 {
  const active = exposedMarkdownLifecycleKey.getState(state);
  const selection = { anchor: state.selection.anchor, head: state.selection.head };
  if (!active) {
    return {
      active: false,
      range: defaultRecoveryExposedRange(state),
      docRevision: revision,
      selection,
    };
  }
  return {
    active: true,
    range: { ...active },
    docRevision: revision,
    selection,
  };
}

function recoverableTextControl(dom: HTMLElement, selector: string) {
  return dom.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
}

function restoreRecoveryTextUi(
  control: HTMLInputElement | HTMLTextAreaElement | null,
  ui: RecoveryLocalBufferV3["ui"],
) {
  if (!control || !ui) return;
  requestAnimationFrame(() => {
    if (ui.focused) control.focus();
    const max = control.value.length;
    control.setSelectionRange(
      Math.max(0, Math.min(ui.anchor, max)),
      Math.max(0, Math.min(ui.head, max)),
      ui.direction === "none" ? undefined : ui.direction,
    );
  });
}

function recoveryIssuePayloadText(issue: RecoveryLocalBufferRestoreIssue) {
  try {
    return JSON.stringify(issue.buffer, null, 2);
  } catch {
    return String(issue.buffer.payload);
  }
}

const slashMenu = ref({
  visible: false,
  query: "",
  from: 0,
  to: 0,
  blockFrom: 0,
  blockTo: 0,
  x: 0,
  y: 0,
  highlightedIndex: 0,
  flipY: false,
});
const slashCandidates = computed(() => filterSlashCommands([
  ...builtinSlashCommands,
  ...snippetSlashCommands(appStore.settings.snippets.items),
], slashMenu.value.query));

type ContextMenuMode = "default" | "code";
type ImageInsertDetail = { files?: File[]; paths?: string[]; source?: "clipboard" | "drop"; position?: { x?: number; y?: number } };
type ToolbarEditorCommand =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "blockquote"
  | "orderedList"
  | "bulletList"
  | "taskList"
  | "heading"
  | "image"
  | "table"
  | "alert";
type ToolbarEditorCommandDetail = { command?: ToolbarEditorCommand; value?: string | number | null };
const WYSIWYG_FORMAT_HISTORY_LIMIT = 20;
let suppressWysiwygUpdate = false;
const composingControls = new Set<EventTarget>();
function trackCompositionStart(event: CompositionEvent) {
  if (event.target instanceof globalThis.Node && editorShell.value?.contains(event.target)) composingControls.add(event.target);
}
function trackCompositionEnd(event: CompositionEvent) { if (event.target) composingControls.delete(event.target); }
let historySourceBaseline: WysiwygSourceBaseline | null = null;
let sourceProvenanceDoc: ReturnType<typeof canonicalMarkdownHistoryState>['doc'] | null = null;
const sourceProvenancePending = new Map<number, ReturnType<typeof canonicalMarkdownHistoryState>['doc']>();
let sourceProvenanceTimer: number | null = null;
function trackSourceProvenance(transaction: Transaction, canonical: ReturnType<typeof canonicalMarkdownHistoryState>) {
  if (sourceProvenanceDoc) {
    if (sourceProvenanceDoc.childCount !== canonical.doc.childCount) sourceProvenancePending.clear();
    for (const { index, node } of recordSourceTransactionProvenance(sourceProvenanceDoc, canonical.doc, transaction)) {
      if (sourceProvenanceDepth(node) >= 256) sourceProvenancePending.set(index, node);
    }
  }
  sourceProvenanceDoc = canonical.doc;
  scheduleSourceProvenanceCompaction();
}
function scheduleSourceProvenanceCompaction() {
  if (!sourceProvenancePending.size || sourceProvenanceTimer != null) return;
  sourceProvenanceTimer = window.setTimeout(async () => {
    sourceProvenanceTimer = null;
    try {
      await prepareFineSourcePreservation();
      if (!editor.value || editor.value.isDestroyed) { sourceProvenancePending.clear(); return; }
      const started = performance.now();
      for (const [index, node] of sourceProvenancePending) {
        sourceProvenancePending.delete(index);
        compactSourceTransactionProvenance(node, preserveFineSourceBlock);
        if (performance.now() - started > 8) break;
      }
    } catch (error) { appStore.statusMessage = String(error); }
    scheduleSourceProvenanceCompaction();
  }, 50);
}
let historyBookmark = { anchor: 1, head: 1 };
let wysiwygSelectionRestoreEpoch = 0;
let wysiwygTypewriterFrame = 0;
let wysiwygManualScrollUntil = 0;

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  mode: "default" as ContextMenuMode,
  inTable: false,
  flipX: false,
  flipY: false,
});
const editorShell = ref<HTMLElement | null>(null);
const recoveryRestoreIssues = ref<RecoveryLocalBufferRestoreIssue[]>([]);
const recoveryRestoreNotice = ref("");
const codeLanguageInput = ref<HTMLInputElement | null>(null);
const codeLanguageControl = ref({
  visible: false,
  open: false,
  x: 0,
  y: 0,
  pos: -1,
  language: "",
  query: "",
  highlightedIndex: 0,
});
const tableControl = ref({
  visible: false,
  resizeOpen: false,
  moreOpen: false,
  x: 0,
  y: 0,
  tablePos: -1,
  activeColumn: -1,
  rows: 0,
  columns: 0,
  resizeText: "",
  resizeError: "",
});
const wikiCompletion = ref({
  visible: false,
  query: "",
  from: 0,
  to: 0,
  x: 0,
  y: 0,
  highlightedIndex: 0,
});
const savedSelection = ref<{ from: number; to: number } | null>(null);
const linkUrl = ref("");
const canUseTableMenu = computed(() => contextMenu.value.inTable && contextMenu.value.mode !== "code");
const paneTab = computed(() => getPaneTab(props.paneId));
const paneContent = computed(() => getPaneContent(props.paneId));
const paneEditorMode = computed(() => getPaneEditorMode(props.paneId));
const paneDocumentMode = computed(() => getPaneDocumentMode(props.paneId));
// A WYSIWYG instance belongs to the raw tab that created it.  During the
// EditorShell transition the old and new instances briefly coexist; looking
// up only the current tab id in an event callback lets an old editor mark the
// new tab dirty.  Keep the raw object as the lifetime fence and let explicit
// rebind paths create a new session when the document really changes owner.
const editorOwnerTab = paneTab.value ? toRaw(paneTab.value) : null;
wysiwygRevision = editorOwnerTab ? documentRevision(editorOwnerTab.id) : 0;
const floatingCodeLanguageCandidates = computed(() => filterCodeLanguages(codeLanguageControl.value.query));
const wysiwygWikiCandidates = computed(() => findWikiCompletionCandidates(appStore.wikiIndex, wikiCompletion.value.query));
const typoraInlineMarkNames = ["bold", "italic", "code", "strike", "highlight", "superscript", "subscript", "link"];
const githubAlertKinds = [
  { kind: "note", label: "Note" },
  { kind: "tip", label: "Tip" },
  { kind: "important", label: "Important" },
  { kind: "warning", label: "Warning" },
  { kind: "caution", label: "Caution" },
] as const;
let pendingWysiwygRestoreTimer: number | null = null;

const TyporaHeading = Heading.extend({
  addInputRules() {
    return [];
  },
});

const TyporaBlockquote = Node.create({
  name: "blockquote",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      alert: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-alert") || null,
        renderHTML: (attributes) => {
          const alert = attributes.alert;
          if (!alert) return {};
          return {
            "data-alert": alert,
            class: `markdown-alert markdown-alert-${alert}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "blockquote" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(HTMLAttributes), 0];
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*>\s$/,
        type: this.type,
        joinPredicate: () => false,
      }),
    ];
  },
});

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) => {
          return attributes.markdownSrc ? { "data-markdown-src": attributes.markdownSrc } : {};
        },
      },
      editing: {
        default: false,
        rendered: false,
      },
      widthPx: {
        default: null,
        parseHTML: (element) => clampImageWidth(element.getAttribute("data-lightmark-width")),
        renderHTML: (attributes) => attributes.widthPx ? { "data-lightmark-width": attributes.widthPx } : {},
      },
      alignment: {
        default: "left",
        parseHTML: (element) => element.getAttribute("data-lightmark-align") || "left",
        renderHTML: (attributes) => ({ "data-lightmark-align": attributes.alignment || "left" }),
      },
      caption: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-lightmark-caption") || "",
        renderHTML: (attributes) => attributes.caption ? { "data-lightmark-caption": attributes.caption } : {},
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createTyporaImageView(node, editor, getPos);
  },
});

const HighlightMark = Mark.create({
  name: "highlight",
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
});

const SuperscriptMark = Mark.create({
  name: "superscript",
  parseHTML() {
    return [{ tag: "sup:not([data-footnote-ref])" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes), 0];
  },
});

const SubscriptMark = Mark.create({
  name: "subscript",
  parseHTML() {
    return [{ tag: "sub" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes), 0];
  },
});

const TaskStateMark = Mark.create({
  name: "taskState",
  addAttributes() {
    return {
      state: {
        default: "unchecked",
        parseHTML: (element) => element.getAttribute("data-task-item") || "unchecked",
        renderHTML: (attributes) => ({ "data-task-item": attributes.state }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-task-item]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const checked = HTMLAttributes["data-task-item"] === "checked";
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "task-state" }),
      ["input", { type: "checkbox", checked: checked ? "checked" : null, contenteditable: "false", "data-task-checkbox": "true" }],
      ["span", { class: "task-state-content" }, 0],
    ];
  },
});

const FrontMatterNode = Node.create({
  name: "frontMatter",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      yaml: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-yaml") || element.textContent || "",
        renderHTML: (attributes) => ({
          "data-type": "front-matter",
          "data-yaml": attributes.yaml,
        }),
      },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-type="front-matter"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), HTMLAttributes.yaml || ""];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.contentEditable = "false";
      let yaml = node.attrs.yaml || "";
      let editing = Boolean(node.attrs.editing);
      let composing = false;
      let pendingConflict = false;
      let acceptedNode = node;
      let lastKnownPosition = readRecoveryNodePosition(getPos as RecoveryNodeViewPosition);
      const recoveryId = recoveryNodeViewId("frontmatter");

      const updateYaml = (flushRequest?: PendingMathFlushRequest) => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "frontMatter", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        if (binding.failure || binding.position === null) {
          pendingConflict = true;
          return false;
        }
        const pos = binding.position;
        const acceptedYaml = String(acceptedNode.attrs.yaml || "");
        const contentChanged = yaml !== acceptedYaml;
        let transaction = editor.view.state.tr.setNodeMarkup(pos, undefined, { yaml, editing });
        if (!contentChanged) {
          transaction = transaction
            .setMeta(LOCAL_EDITOR_UI_TRANSACTION_META_KEY, true)
            .setMeta("addToHistory", false);
        }
        if (flushRequest) transaction = transaction.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
        editor.view.dispatch(transaction);
        return true;
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "front-matter-node";
        const pre = document.createElement("pre");
        pre.className = yaml.trim() ? "" : "front-matter-placeholder";
        pre.textContent = yaml.trim() ? yaml : "请输入yaml";
        dom.append(pre);
      };

      const renderEditor = (focus = true) => {
        dom.innerHTML = "";
        dom.className = "front-matter-node front-matter-node-editing";
        const textarea = document.createElement("textarea");
        textarea.className = "front-matter-editor";
        textarea.placeholder = "请输入yaml";
        textarea.value = yaml;
        textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          yaml = textarea.value;
          textarea.rows = Math.max(3, yaml.split(/\r?\n/).length);
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("compositionstart", () => {
          composing = true;
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("compositionend", () => {
          composing = false;
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("blur", () => {
          if (composing) return;
          editing = false;
          updateYaml();
          renderDisplay();
        });
        dom.append(textarea);
        if (focus) requestAnimationFrame(() => textarea.focus());
      };

      const captureRecovery = () => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "frontMatter", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        const control = dom.querySelector<HTMLTextAreaElement>(".front-matter-editor");
        const accepted = {
          yaml: String(acceptedNode.attrs.yaml || ""),
          editing: Boolean(acceptedNode.attrs.editing),
        };
        const value = control?.value ?? yaml;
        const payload = {
          accepted,
          draft: { yaml: value, editing },
          valueRevision: wysiwygRevision,
        };
        if (binding.failure) {
          return {
            ok: false as const,
            ...binding.failure,
            payload,
            positionHint: binding.position,
          };
        }
        if (editing && !control) {
          return {
            ok: false as const,
            code: "dom-value-unavailable",
            message: "FrontMatter editor value is unavailable while the NodeView is editing.",
            status: "orphaned" as const,
            payload,
            positionHint: binding.position,
          };
        }
        if (control && control.value !== yaml) {
          return {
            ok: false as const,
            code: "dom-closure-mismatch",
            message: "FrontMatter DOM value and closure value disagree.",
            status: "conflicted" as const,
            payload,
            positionHint: binding.position,
          };
        }
        return {
          ok: true as const,
          buffer: {
            id: recoveryId,
            kind: "frontmatter" as const,
            status: editing ? "editing" as const : "accepted" as const,
            sourceRevision: wysiwygRevision,
            positionHint: binding.position,
            payload,
            ...(control ? { ui: readRecoveryTextUi(control, composing) } : {}),
          },
        };
      };

      const restoreRecovery = (buffer: RecoveryLocalBufferV3) => {
        const payload = buffer.payload as {
          accepted?: { yaml?: string; editing?: boolean };
          draft?: string | { yaml?: string; editing?: boolean };
        };
        const draft = payload.draft;
        yaml = typeof draft === "string" ? draft : String(draft?.yaml ?? payload.accepted?.yaml ?? "");
        pendingConflict = false;
        editing = buffer.status === "editing" || Boolean(typeof draft === "object" && draft?.editing);
        editing ? renderEditor(false) : renderDisplay();
        if (editing) restoreRecoveryTextUi(recoverableTextControl(dom, ".front-matter-editor"), buffer.ui);
      };
      const hasPending = () => {
        const control = dom.querySelector<HTMLTextAreaElement>(".front-matter-editor");
        const acceptedYaml = String(acceptedNode.attrs.yaml || "");
        return composing
          || pendingConflict
          || (editing && !control)
          || (control?.value ?? yaml) !== acceptedYaml;
      };
      const flushPending = (request: PendingMathFlushRequest) => {
        if (pendingConflict) throw new Error("FrontMatter 节点与未提交输入发生冲突，已保留当前窗口。");
        if (composing) throw new Error("FrontMatter 输入法组合尚未结束，已保留当前窗口。");
        if (!hasPending()) return;
        const control = dom.querySelector<HTMLTextAreaElement>(".front-matter-editor");
        if (editing && !control) throw new Error("FrontMatter 编辑框已不可用，已保留当前窗口。");
        if (control) yaml = control.value;
        if (!updateYaml(request)) {
          throw new Error("FrontMatter 节点位置已失效，已保留当前输入。");
        }
      };
      const unregisterRecovery = registerRecoveryLocalBufferForOwner(editor, {
        id: recoveryId,
        kind: "frontmatter",
        sourceRevision: wysiwygRevision,
        positionHint: lastKnownPosition,
        capture: captureRecovery,
        restore: restoreRecovery,
      });
      const unregisterPending = registerPendingLocalEditor(editor, {
        id: recoveryId,
        hasPending,
        flush: flushPending,
      }).unregister;

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        renderEditor();
      });

      editing ? renderEditor() : renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          const previousYaml = String(acceptedNode.attrs.yaml || "");
          const incomingYaml = String(nextNode.attrs.yaml || "");
          const localChanged = yaml !== previousYaml;
          const incomingChanged = incomingYaml !== previousYaml;
          if (editing && nextNode.attrs.editing && incomingYaml === yaml) {
            acceptedNode = nextNode;
            pendingConflict = false;
            return true;
          }
          if (editing && localChanged && !incomingChanged) {
            acceptedNode = nextNode;
            return true;
          }
          if (editing && localChanged && incomingChanged && incomingYaml !== yaml) {
            pendingConflict = true;
            return true;
          }
          pendingConflict = false;
          acceptedNode = nextNode;
          yaml = incomingYaml;
          editing = Boolean(nextNode.attrs.editing);
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        destroy() {
          const pending = hasPending();
          unregisterPending();
          if (pending) retainAndUnregisterRecoveryLocalBufferForOwner(editor, recoveryId);
          else unregisterRecovery();
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const FrontMatterInput = Extension.create({
  name: "frontMatterInput",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            return convertLeadingFrontMatter(view, event);
          },
        },
      }),
    ];
  },
});

const FencedCodeBlockInput = Extension.create({
  name: "fencedCodeBlockInput",
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            return convertFencedCodeBlock(view, event);
          },
        },
      }),
    ];
  },
});

const LightMarkCodeBlock = CodeBlockLowlight.extend({
  addProseMirrorPlugins() {
    return [incrementalLowlightPlugin({
      name: this.name,
      lowlight: this.options.lowlight,
      defaultLanguage: this.options.defaultLanguage,
    })];
  },
  addAttributes() {
    const parentAttributes = this.parent?.() ?? {};
    const languageAttribute = (parentAttributes as Record<string, any>).language ?? {};
    return {
      ...parentAttributes,
      language: {
        ...languageAttribute,
        parseHTML: (element: HTMLElement) => {
          const language = readCodeLanguageFromElement(element);
          return language ? normalizeCodeLanguage(language) || language : null;
        },
      },
    };
  },
});

function isLeadingFrontMatterFence(state: any) {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const firstNode = state.doc.firstChild;
  if (!firstNode || $from.depth !== 1 || $from.before(1) !== 0) return false;
  if ($from.parent !== firstNode || !firstNode.isTextblock) return false;
  if ($from.parentOffset !== firstNode.content.size) return false;
  return firstNode.textContent.trim() === "---";
}

function getFencedCodeLanguage(text: string) {
  const match = text.match(/^```([A-Za-z0-9_+-]*)\s*$/);
  return match ? match[1] : null;
}

function readCodeLanguageFromElement(element: HTMLElement) {
  const code = element.matches("code") ? element : element.querySelector("code");
  const className = code instanceof HTMLElement ? code.className : element.className;
  return className.match(/(?:^|\s)language-([^\s]+)/)?.[1] || element.getAttribute("data-language") || "";
}

function filterCodeLanguages(query: string) {
  const value = query.trim().toLowerCase();
  if (!value) return codeLanguageNames.slice(0, 12);
  const normalized = normalizeCodeLanguage(value);
  const exact = normalized ? [normalized] : [];
  const matches = codeLanguageItems
    .filter((item) => item.name.includes(value) || item.aliases.some((alias) => alias.includes(value)))
    .map((item) => item.name);
  return Array.from(new Set([...exact, ...matches])).slice(0, 12);
}

function convertFencedCodeBlock(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter") return false;
  const { state } = view;
  const { selection, schema } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;

  const language = getFencedCodeLanguage($from.parent.textContent.trim());
  if (language === null) return false;

  const codeBlockType = schema.nodes.codeBlock;
  if (!codeBlockType) return false;

  const from = $from.before();
  const to = $from.after();
  const normalizedLanguage = displayCodeLanguage(language);
  const codeBlock = codeBlockType.create(normalizedLanguage ? { language: normalizedLanguage } : undefined);
  const tr = state.tr.replaceWith(from, to, codeBlock);
  tr.setSelection(TextSelection.create(tr.doc, from + 1));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

function convertLeadingFrontMatter(view: any, event: KeyboardEvent) {
  if (event.key !== "Enter") return false;
  const { state } = view;
  if (!isLeadingFrontMatterFence(state)) return false;

  const { schema } = state;
  const firstNode = state.doc.firstChild;
  const frontMatterType = schema.nodes.frontMatter;
  const paragraphType = schema.nodes.paragraph;
  if (!firstNode || !frontMatterType || !paragraphType) return false;

  const frontMatter = frontMatterType.create({ yaml: "", editing: true });
  const paragraph = paragraphType.create();
  const tr = state.tr.replaceWith(0, firstNode.nodeSize, [frontMatter, paragraph]);
  tr.setSelection(NodeSelection.create(tr.doc, 0));
  view.dispatch(tr.scrollIntoView());
  event.preventDefault();
  return true;
}

const TableOfContentsNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'nav[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["nav", mergeAttributes(HTMLAttributes, { "data-type": "table-of-contents" }), "[TOC]"];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("nav");
      dom.className = "toc-node";
      dom.contentEditable = "false";
      let editing = Boolean(node.attrs.editing);
      let candidate = "[TOC]";
      let composing = false;
      let pendingConflict = false;
      let acceptedNode = node;
      let lastKnownPosition = readRecoveryNodePosition(getPos as RecoveryNodeViewPosition);
      const recoveryId = recoveryNodeViewId("toc");
      let retiring = false;

      const updateAttrs = (nextEditing: boolean, flushRequest?: PendingMathFlushRequest, uiOnly = false) => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "tableOfContents", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        if (binding.failure || binding.position === null) {
          pendingConflict = true;
          return false;
        }
        const pos = binding.position;
        let transaction = editor.view.state.tr.setNodeMarkup(pos, undefined, { editing: nextEditing });
        if (uiOnly) {
          transaction = transaction
            .setMeta(LOCAL_EDITOR_UI_TRANSACTION_META_KEY, true)
            .setMeta("addToHistory", false);
        }
        if (flushRequest) transaction = transaction.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
        editor.view.dispatch(transaction);
        pendingConflict = false;
        return true;
      };

      const render = (focus = true) => {
        dom.className = editing ? "toc-node toc-node-editing" : "toc-node";
        const headings: Array<{ level: number; text: string }> = [];
        editor.state.doc.descendants((node: any) => {
          if (node.type.name === "heading" || node.type.name === "markdownHeading") {
            headings.push({ level: node.attrs.level || 1, text: node.textContent });
          }
          return true;
        });
        dom.innerHTML = "";
        const label = document.createElement("div");
        label.className = "toc-node-label";
        label.textContent = "[TOC]";
        dom.appendChild(label);
        if (editing) {
          const input = document.createElement("input");
          input.className = "toc-node-editor";
          input.value = candidate;
          input.spellcheck = false;
          input.addEventListener("input", () => {
            candidate = input.value;
            markPendingLocalInput(editor);
          });
          input.addEventListener("compositionstart", () => {
            composing = true;
            markPendingLocalInput(editor);
          });
          input.addEventListener("compositionend", () => {
            composing = false;
            markPendingLocalInput(editor);
          });
          input.addEventListener("blur", () => {
            window.setTimeout(() => {
              if (document.activeElement === input) return;
              if (composing) return;
              candidate = input.value;
              if (candidate.trim().toUpperCase() !== "[TOC]") {
                retiring = true;
                if (!replaceTocWithText(editor, getPos, candidate)) retiring = false;
                return;
              }
              editing = false;
              updateAttrs(false, undefined, true);
              render();
            }, 100);
          });
          dom.appendChild(input);
          if (focus) requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
          return;
        }
        headings.forEach((heading) => {
          const item = document.createElement("div");
          item.className = `toc-node-item toc-node-item-${heading.level}`;
          item.textContent = heading.text;
          dom.appendChild(item);
        });
      };
      const captureRecovery = () => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "tableOfContents", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        const control = dom.querySelector<HTMLInputElement>(".toc-node-editor");
        const payload = {
          candidate: control?.value ?? candidate,
          accepted: "[TOC]",
          editing,
          valueRevision: wysiwygRevision,
        };
        if (binding.failure) {
          return {
            ok: false as const,
            ...binding.failure,
            payload,
            positionHint: binding.position,
          };
        }
        if (editing && !control) {
          return {
            ok: false as const,
            code: "dom-value-unavailable",
            message: "TOC editor value is unavailable while the NodeView is editing.",
            status: "orphaned" as const,
            payload,
            positionHint: binding.position,
          };
        }
        if (control && control.value !== candidate) {
          return {
            ok: false as const,
            code: "dom-closure-mismatch",
            message: "TOC DOM value and closure value disagree.",
            status: "conflicted" as const,
            payload,
            positionHint: binding.position,
          };
        }
        return {
          ok: true as const,
          buffer: {
            id: recoveryId,
            kind: "toc" as const,
            status: editing ? "editing" as const : "accepted" as const,
            sourceRevision: wysiwygRevision,
            positionHint: binding.position,
            payload,
            ...(control ? { ui: readRecoveryTextUi(control, composing) } : {}),
          },
        };
      };
      const restoreRecovery = (buffer: RecoveryLocalBufferV3) => {
        const payload = buffer.payload as { candidate?: string; accepted?: string; editing?: boolean };
        candidate = String(payload.candidate ?? payload.accepted ?? "[TOC]");
        editing = buffer.status === "editing" || Boolean(payload.editing);
        render(false);
        if (editing) restoreRecoveryTextUi(recoverableTextControl(dom, ".toc-node-editor"), buffer.ui);
      };
      const hasPending = () => !retiring && (pendingConflict || composing || candidate.trim().toUpperCase() !== "[TOC]");
      const flushPending = (request: PendingMathFlushRequest) => {
        if (pendingConflict) throw new Error("TOC 节点与未提交输入发生冲突，已保留当前窗口。");
        if (composing) throw new Error("TOC 输入法组合尚未结束，已保留当前窗口。");
        if (!hasPending()) return;
        const control = dom.querySelector<HTMLInputElement>(".toc-node-editor");
        if (editing && !control) throw new Error("TOC 编辑框已不可用，已保留当前窗口。");
        if (control) candidate = control.value;
        if (candidate.trim().toUpperCase() !== "[TOC]") {
          retiring = true;
          editing = false;
          if (!replaceTocWithText(editor, getPos, candidate, request)) {
            retiring = false;
            editing = true;
            throw new Error("TOC 节点位置已失效，已保留当前输入。");
          }
          return;
        }
        editing = false;
        if (!updateAttrs(false, request, true)) {
          editing = true;
          throw new Error("TOC 节点位置已失效，已保留当前输入。");
        }
        render();
      };
      const unregisterRecovery = registerRecoveryLocalBufferForOwner(editor, {
        id: recoveryId,
        kind: "toc",
        sourceRevision: wysiwygRevision,
        positionHint: lastKnownPosition,
        capture: captureRecovery,
        restore: restoreRecovery,
      });
      const unregisterPending = registerPendingLocalEditor(editor, {
        id: recoveryId,
        hasPending,
        flush: flushPending,
      }).unregister;
      const refresh = () => {
        if (!editing) render();
      };
      editor.on?.("update", refresh);
      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs(true, undefined, true);
        render();
      });
      render();
      return {
        dom,
        update: (nextNode: any) => {
          if (editing && candidate.trim().toUpperCase() !== "[TOC]") {
            acceptedNode = nextNode;
            return true;
          }
          acceptedNode = nextNode;
          editing = Boolean(nextNode.attrs.editing);
          render();
          return true;
        },
        selectNode() {
          editing = true;
          updateAttrs(true, undefined, true);
          render();
        },
        deselectNode() {
          if (!editing) return;
          editing = false;
          updateAttrs(false, undefined, true);
          render();
        },
        destroy() {
          editor.off?.("update", refresh);
          const pending = hasPending();
          unregisterPending();
          if (pending) retainAndUnregisterRecoveryLocalBufferForOwner(editor, recoveryId);
          else unregisterRecovery();
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLInputElement,
      };
    };
  },
});

const HtmlBlockNode = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: {
        default: "",
        // Keep the source string as data.  The NodeView display path applies
        // the existing HTML renderer/sanitizer separately; parsing or
        // committing a sanitized value would silently destroy recoverable
        // source bytes.
        parseHTML: (element) => element.getAttribute("data-html") || "",
        renderHTML: (attributes) => ({
          "data-type": "html-block",
          "data-html": attributes.html || "",
        }),
      },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), HTMLAttributes.html || ""];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.contentEditable = "false";
      let html = String(node.attrs.html || "");
      let editing = Boolean(node.attrs.editing);
      let committing = false;
      let composing = false;
      let pendingConflict = false;
      let acceptedNode = node;
      let lastKnownPosition = readRecoveryNodePosition(getPos as RecoveryNodeViewPosition);
      const recoveryId = recoveryNodeViewId("html");

      const updateAttrs = (
        next: { html?: string; editing?: boolean },
        flushRequest?: PendingMathFlushRequest,
        uiOnly = false,
      ) => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "htmlBlock", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        if (binding.failure || binding.position === null) {
          pendingConflict = true;
          return false;
        }
        const pos = binding.position;
        const nextHtml = next.html ?? html;
        const nextEditing = next.editing ?? editing;
        const nextAttrs = { html: nextHtml, editing: nextEditing };
        if (Object.entries(nextAttrs).every(([key, value]) => acceptedNode.attrs[key] === value)) return true;
        const acceptedHtml = String(acceptedNode.attrs.html || "");
        const contentChanged = nextHtml !== acceptedHtml;
        let transaction = editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
        if (uiOnly || !contentChanged) {
          transaction = transaction
            .setMeta(LOCAL_EDITOR_UI_TRANSACTION_META_KEY, true)
            .setMeta("addToHistory", false);
        }
        if (flushRequest) transaction = transaction.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
        editor.view.dispatch(transaction);
        return true;
      };

      const commitEditor = (textarea?: HTMLTextAreaElement, flushRequest?: PendingMathFlushRequest) => {
        if (committing || composing) return false;
        const acceptedHtml = String(acceptedNode.attrs.html || "");
        if (!editing && (!textarea || textarea.value === acceptedHtml)) return true;
        committing = true;
        if (textarea) html = textarea.value;
        editing = false;
        const updated = updateAttrs({ html, editing: false }, flushRequest);
        if (!updated) {
          editing = true;
          committing = false;
          return false;
        }
        renderDisplay();
        if (flushRequest) committing = false;
        else window.setTimeout(() => {
          committing = false;
        }, 0);
        return true;
      };

      const renderDisplay = () => {
        dom.innerHTML = "";
        dom.className = "html-block-node";
        const rendered = document.createElement("div");
        rendered.className = "html-block-rendered";
        rendered.innerHTML = renderInlineMarkdownInHtml(html);
        dom.appendChild(rendered);
      };

      const renderEditor = (focus = true) => {
        dom.innerHTML = "";
        dom.className = "html-block-node html-block-node-editing";
        const label = document.createElement("div");
        label.className = "html-block-label";
        label.textContent = "HTML";
        const textarea = document.createElement("textarea");
        textarea.className = "html-block-editor";
        textarea.value = html;
        textarea.rows = Math.max(3, html.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          html = textarea.value;
          textarea.rows = Math.max(3, html.split(/\r?\n/).length);
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("compositionstart", () => {
          composing = true;
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("compositionend", () => {
          composing = false;
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("keydown", (event) => {
          if (event.key !== "Escape" && !(event.key === "Enter" && (event.ctrlKey || event.metaKey))) return;
          if (composing) return;
          event.preventDefault();
          commitEditor(textarea);
        });
        textarea.addEventListener("blur", () => {
          if (composing) return;
          commitEditor(textarea);
        });
        dom.append(label, textarea);
        if (focus) requestAnimationFrame(() => textarea.focus());
      };

      const captureRecovery = () => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "htmlBlock", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        const control = dom.querySelector<HTMLTextAreaElement>(".html-block-editor");
        const accepted = {
          html: String(acceptedNode.attrs.html || ""),
          editing: Boolean(acceptedNode.attrs.editing),
          decoded: true,
          sanitized: false,
        };
        const value = control?.value ?? html;
        const payload = {
          accepted,
          draft: { html: value, editing },
          committing,
          valueRevision: wysiwygRevision,
        };
        if (binding.failure) {
          return {
            ok: false as const,
            ...binding.failure,
            payload,
            positionHint: binding.position,
          };
        }
        if (editing && !control) {
          return {
            ok: false as const,
            code: "dom-value-unavailable",
            message: "HTML editor value is unavailable while the NodeView is editing.",
            status: "orphaned" as const,
            payload,
            positionHint: binding.position,
          };
        }
        if (control && control.value !== html) {
          return {
            ok: false as const,
            code: "dom-closure-mismatch",
            message: "HTML DOM value and closure value disagree.",
            status: "conflicted" as const,
            payload,
            positionHint: binding.position,
          };
        }
        return {
          ok: true as const,
          buffer: {
            id: recoveryId,
            kind: "htmlBlock" as const,
            status: editing ? "editing" as const : "accepted" as const,
            sourceRevision: wysiwygRevision,
            positionHint: binding.position,
            payload,
            ...(control ? { ui: readRecoveryTextUi(control, composing) } : {}),
          },
        };
      };

      const restoreRecovery = (buffer: RecoveryLocalBufferV3) => {
        const payload = buffer.payload as {
          accepted?: { html?: string; editing?: boolean };
          draft?: string | { html?: string; editing?: boolean };
          committing?: boolean;
        };
        const draft = payload.draft;
        html = typeof draft === "string" ? draft : String(draft?.html ?? payload.accepted?.html ?? "");
        pendingConflict = false;
        committing = Boolean(payload.committing);
        editing = buffer.status === "editing" || Boolean(typeof draft === "object" && draft?.editing);
        editing ? renderEditor(false) : renderDisplay();
        if (editing) restoreRecoveryTextUi(recoverableTextControl(dom, ".html-block-editor"), buffer.ui);
      };
      const hasPending = () => {
        const control = dom.querySelector<HTMLTextAreaElement>(".html-block-editor");
        const acceptedHtml = String(acceptedNode.attrs.html || "");
        const localHtml = control?.value ?? html;
        return pendingConflict
          || composing
          || (editing && !control)
          || localHtml !== acceptedHtml;
      };
      const flushPending = (request: PendingMathFlushRequest) => {
        if (pendingConflict) throw new Error("HTML 节点与未提交输入发生冲突，已保留当前窗口。");
        if (composing) throw new Error("HTML 输入法组合尚未结束，已保留当前窗口。");
        if (!hasPending()) return;
        if (committing) throw new Error("HTML 编辑器仍在提交，已保留当前窗口。");
        const control = dom.querySelector<HTMLTextAreaElement>(".html-block-editor");
        if (editing && !control) throw new Error("HTML 编辑框已不可用，已保留当前窗口。");
        if (control) html = control.value;
        if (!updateAttrs({ html, editing }, request)) throw new Error("HTML 节点位置已失效，已保留当前输入。");
      };
      const unregisterRecovery = registerRecoveryLocalBufferForOwner(editor, {
        id: recoveryId,
        kind: "htmlBlock",
        sourceRevision: wysiwygRevision,
        positionHint: lastKnownPosition,
        capture: captureRecovery,
        restore: restoreRecovery,
      });
      const unregisterPending = registerPendingLocalEditor(editor, {
        id: recoveryId,
        hasPending,
        flush: flushPending,
      }).unregister;

      dom.addEventListener("mousedown", (event) => {
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs({ editing: true }, undefined, true);
        renderEditor();
      });

      editing ? renderEditor() : renderDisplay();
      return {
        dom,
        update(nextNode: any) {
          const previousHtml = String(acceptedNode.attrs.html || "");
          const incomingHtml = String(nextNode.attrs.html || "");
          const localHtml = html;
          const localChanged = localHtml !== previousHtml;
          const incomingChanged = incomingHtml !== previousHtml;
          if (editing && nextNode.attrs.editing && incomingHtml === localHtml) {
            acceptedNode = nextNode;
            pendingConflict = false;
            return true;
          }
          if (editing && localChanged && !incomingChanged) {
            acceptedNode = nextNode;
            return true;
          }
          if (editing && localChanged && incomingChanged && incomingHtml !== localHtml) {
            pendingConflict = true;
            return true;
          }
          pendingConflict = false;
          acceptedNode = nextNode;
          html = incomingHtml;
          editing = Boolean(nextNode.attrs.editing);
          editing ? renderEditor() : renderDisplay();
          return true;
        },
        selectNode() {
          if (editing) return;
          editing = true;
          updateAttrs({ editing: true }, undefined, true);
          renderEditor();
        },
        deselectNode() {
          commitEditor();
        },
        destroy() {
          const pending = hasPending();
          unregisterPending();
          if (pending) retainAndUnregisterRecoveryLocalBufferForOwner(editor, recoveryId);
          else unregisterRecovery();
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const StrikeMark = Mark.create({
  name: "strike",
  parseHTML() {
    return [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["s", mergeAttributes(HTMLAttributes), 0];
  },
});

const FootnoteRefNode = Node.create({
  name: "footnoteRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  priority: 10000,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-footnote-ref") || "",
        renderHTML: () => ({}),
      },
      index: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-footnote-index") || element.textContent?.replace(/\D/g, "") || "",
        renderHTML: () => ({}),
      },
      refId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-ref-id") || element.querySelector("a")?.getAttribute("id") || "",
        renderHTML: () => ({}),
      },
      preview: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-preview") || "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="footnote-ref"]' }, { tag: "sup[data-footnote-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id || HTMLAttributes.id || "";
    const index = node.attrs.index || HTMLAttributes.index || "";
    const refId = node.attrs.refId || HTMLAttributes.refId || `fnref-${id}-1`;
    const preview = node.attrs.preview || HTMLAttributes.preview || "";
    return [
      "span",
      {
        "data-type": "footnote-ref",
        "data-footnote-ref": id,
        "data-footnote-index": index,
        "data-ref-id": refId,
        "data-preview": preview,
      },
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("sup");
      const id = node.attrs.id || "";
      const index = node.attrs.index || id;
      const refId = node.attrs.refId || `fnref-${id}-1`;
      let editing = false;
      dom.dataset.footnoteRef = id;
      dom.dataset.footnoteIndex = String(index);
      dom.dataset.preview = node.attrs.preview || "";
      dom.contentEditable = "false";
      dom.className = "footnote-ref-node";

      const link = document.createElement("a");
      link.href = `#fn-${id}`;
      link.id = refId;
      link.dataset.footnoteLink = "ref";
      link.title = formatFootnotePreview(node.attrs.preview || id);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) {
          scrollInternalLink(`#fn-${id}`);
          return;
        }
        editing = !editing;
        render();
      });
      dom.addEventListener("dblclick", (event) => {
        event.preventDefault();
        scrollInternalLink(`#fn-${id}`);
      });

      const preview = document.createElement("span");
      preview.className = "footnote-ref-preview";
      preview.innerHTML = renderMarkdownForEditorWithAssets(node.attrs.preview || "");

      const render = () => {
        link.textContent = editing ? `[^${id}]` : `[${index}]`;
        dom.classList.toggle("footnote-ref-node-editing", editing);
      };
      dom.appendChild(link);
      if (node.attrs.preview) dom.appendChild(preview);
      render();
      return { dom, ignoreMutation: () => true };
    };
  },
});

const FootnotesNode = Node.create({
  name: "footnotes",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      markdown: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-markdown") || "",
        renderHTML: (attributes) => ({
          "data-type": "footnotes",
          "data-markdown": attributes.markdown,
        }),
      },
      html: {
        default: "",
        parseHTML: (element) => element.innerHTML || "",
        rendered: false,
      },
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-type="footnotes"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("section");
      dom.className = "footnotes";
      dom.dataset.type = "footnotes";
      dom.dataset.markdown = node.attrs.markdown || "";
      dom.contentEditable = "false";
      let markdown = node.attrs.markdown || "";
      let fallbackHtml = node.attrs.html || "";
      let editing = Boolean(node.attrs.editing);
      let committing = false;
      let composing = false;
      let frame = 0;
      let pendingConflict = false;
      let acceptedNode = node;
      let lastKnownPosition = readRecoveryNodePosition(getPos as RecoveryNodeViewPosition);
      const recoveryId = recoveryNodeViewId("footnote");
      const updateAttrs = (
        next: { markdown?: string; editing?: boolean },
        flushRequest?: PendingMathFlushRequest,
        uiOnly = false,
      ) => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "footnotes", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        if (binding.failure || binding.position === null) {
          pendingConflict = true;
          return false;
        }
        const pos = binding.position;
        const nextMarkdown = next.markdown ?? markdown;
        const nextHtml = fallbackHtml;
        const nextEditing = next.editing ?? editing;
        const nextAttrs = { markdown: nextMarkdown, html: nextHtml, editing: nextEditing };
        if (Object.entries(nextAttrs).every(([key, value]) => acceptedNode.attrs[key] === value)) return true;
        const acceptedMarkdown = normalizeFootnoteSource(String(acceptedNode.attrs.markdown || ""));
        const acceptedHtml = String(acceptedNode.attrs.html || "");
        const contentChanged = nextMarkdown !== acceptedMarkdown || nextHtml !== acceptedHtml;
        let transaction = editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
        if (uiOnly || !contentChanged) {
          transaction = transaction
            .setMeta(LOCAL_EDITOR_UI_TRANSACTION_META_KEY, true)
            .setMeta("addToHistory", false);
        }
        if (flushRequest) transaction = transaction.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
        editor.view.dispatch(transaction);
        return true;
      };
      const renderDisplay = () => {
        dom.className = "footnotes";
        dom.innerHTML = "";
        renderFootnotesView(dom, markdown, fallbackHtml);
      };
      const commitEditor = (textarea?: HTMLTextAreaElement, flushRequest?: PendingMathFlushRequest) => {
        if (committing || composing) return false;
        const acceptedMarkdown = normalizeFootnoteSource(String(acceptedNode.attrs.markdown || ""));
        if (!editing && (!textarea || normalizeFootnoteSource(textarea.value) === acceptedMarkdown)) return true;
        committing = true;
        if (textarea) markdown = normalizeFootnoteSource(textarea.value);
        editing = false;
        dom.dataset.markdown = markdown;
        const updated = updateAttrs({ markdown, editing: false }, flushRequest);
        if (!updated) {
          editing = true;
          committing = false;
          return false;
        }
        renderDisplay();
        if (flushRequest) committing = false;
        else window.setTimeout(() => {
          committing = false;
        }, 0);
        return true;
      };
      const renderEditor = (focus = true) => {
        dom.className = "footnotes footnotes-editing";
        dom.innerHTML = "";
        const label = document.createElement("div");
        label.className = "footnotes-editor-label";
        label.textContent = "脚注定义";
        const textarea = document.createElement("textarea");
        textarea.className = "footnotes-editor";
        textarea.value = markdown;
        textarea.rows = Math.max(2, markdown.split(/\r?\n/).length);
        textarea.spellcheck = false;
        textarea.addEventListener("input", () => {
          markdown = textarea.value;
          textarea.rows = Math.max(2, markdown.split(/\r?\n/).length);
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("compositionstart", () => {
          composing = true;
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("compositionend", () => {
          composing = false;
          markPendingLocalInput(editor);
        });
        textarea.addEventListener("keydown", (event) => {
          if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
            if (composing) return;
            event.preventDefault();
            commitEditor(textarea);
          }
        });
        textarea.addEventListener("blur", () => {
          if (composing) return;
          commitEditor(textarea);
        });
        dom.append(label, textarea);
        if (focus) requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        });
      };
      const captureRecovery = () => {
        const binding = readRecoveryNodeBinding(editor, getPos as RecoveryNodeViewPosition, acceptedNode, "footnotes", lastKnownPosition);
        if (binding.position !== null) lastKnownPosition = binding.position;
        const control = dom.querySelector<HTMLTextAreaElement>(".footnotes-editor");
        const payload = {
          accepted: {
            markdown: String(acceptedNode.attrs.markdown || ""),
            html: String(acceptedNode.attrs.html || ""),
            editing: Boolean(acceptedNode.attrs.editing),
          },
          draft: { markdown: control?.value ?? markdown, editing, normalized: !editing },
          fallbackHtml,
          normalized: !editing,
          committing,
          frame: frame ? "scheduled" as const : "idle" as const,
          valueRevision: wysiwygRevision,
        };
        if (binding.failure) {
          return {
            ok: false as const,
            ...binding.failure,
            payload,
            positionHint: binding.position,
          };
        }
        if (editing && !control) {
          return {
            ok: false as const,
            code: "dom-value-unavailable",
            message: "Footnote editor value is unavailable while the NodeView is editing.",
            status: "orphaned" as const,
            payload,
            positionHint: binding.position,
          };
        }
        if (control && control.value !== markdown) {
          return {
            ok: false as const,
            code: "dom-closure-mismatch",
            message: "Footnote DOM value and closure value disagree.",
            status: "conflicted" as const,
            payload,
            positionHint: binding.position,
          };
        }
        return {
          ok: true as const,
          buffer: {
            id: recoveryId,
            kind: "footnote" as const,
            status: editing ? "editing" as const : "accepted" as const,
            sourceRevision: wysiwygRevision,
            positionHint: binding.position,
            payload,
            ...(control ? { ui: readRecoveryTextUi(control, composing) } : {}),
          },
        };
      };
      const restoreRecovery = (buffer: RecoveryLocalBufferV3) => {
        const payload = buffer.payload as {
          accepted?: { markdown?: string; html?: string; editing?: boolean };
          draft?: string | { markdown?: string; editing?: boolean };
          fallbackHtml?: string;
          committing?: boolean;
        };
        const draft = payload.draft;
        markdown = typeof draft === "string" ? draft : String(draft?.markdown ?? payload.accepted?.markdown ?? "");
        fallbackHtml = String(payload.fallbackHtml ?? payload.accepted?.html ?? "");
        pendingConflict = false;
        committing = Boolean(payload.committing);
        editing = buffer.status === "editing" || Boolean(typeof draft === "object" && draft?.editing);
        editing ? renderEditor(false) : renderDisplay();
        if (editing) restoreRecoveryTextUi(recoverableTextControl(dom, ".footnotes-editor"), buffer.ui);
      };
      const hasPending = () => {
        const control = dom.querySelector<HTMLTextAreaElement>(".footnotes-editor");
        const acceptedMarkdown = normalizeFootnoteSource(String(acceptedNode.attrs.markdown || ""));
        const localMarkdown = normalizeFootnoteSource(control?.value ?? markdown);
        return pendingConflict
          || composing
          || (editing && !control)
          || localMarkdown !== acceptedMarkdown;
      };
      const flushPending = (request: PendingMathFlushRequest) => {
        if (pendingConflict) throw new Error("脚注节点与未提交输入发生冲突，已保留当前窗口。");
        if (composing) throw new Error("脚注输入法组合尚未结束，已保留当前窗口。");
        if (!hasPending()) return;
        if (committing) throw new Error("脚注编辑器仍在提交，已保留当前窗口。");
        const control = dom.querySelector<HTMLTextAreaElement>(".footnotes-editor");
        if (editing && !control) throw new Error("脚注编辑框已不可用，已保留当前输入。");
        if (control) markdown = control.value;
        if (!updateAttrs({ markdown: normalizeFootnoteSource(markdown), editing }, request)) throw new Error("脚注节点位置已失效，已保留当前输入。");
      };
      const unregisterRecovery = registerRecoveryLocalBufferForOwner(editor, {
        id: recoveryId,
        kind: "footnote",
        sourceRevision: wysiwygRevision,
        positionHint: lastKnownPosition,
        capture: captureRecovery,
        restore: restoreRecovery,
      });
      const unregisterPending = registerPendingLocalEditor(editor, {
        id: recoveryId,
        hasPending,
        flush: flushPending,
      }).unregister;
      const render = () => editing ? renderEditor() : renderDisplay();
      const scheduleRender = () => {
        if (editing) return;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          render();
        });
      };
      const refreshAfterMount = () => {
        render();
        scheduleRender();
        window.setTimeout(scheduleRender, 80);
      };
      refreshAfterMount();
      dom.addEventListener("click", (event) => {
        const target = getEventElement(event);
        const link = target?.closest<HTMLAnchorElement>("a[href^='#'],button[data-footnote-target]");
        if (link) {
          event.preventDefault();
          const href = link instanceof HTMLButtonElement ? link.dataset.footnoteTarget || "" : link.getAttribute("href") || "";
          scrollInternalLink(href);
          return;
        }
        if (editing) return;
        event.preventDefault();
        editing = true;
        updateAttrs({ editing: true }, undefined, true);
        renderEditor();
      });
      editor.on?.("update", scheduleRender);
      return {
        dom,
        update(nextNode: any) {
          const previousMarkdown = normalizeFootnoteSource(String(acceptedNode.attrs.markdown || ""));
          const incomingMarkdown = normalizeFootnoteSource(String(nextNode.attrs.markdown || ""));
          const localMarkdown = normalizeFootnoteSource(markdown);
          const localChanged = localMarkdown !== previousMarkdown;
          const incomingChanged = incomingMarkdown !== previousMarkdown;
          if (editing && nextNode.attrs.editing && incomingMarkdown === localMarkdown) {
            acceptedNode = nextNode;
            pendingConflict = false;
            return true;
          }
          if (editing && localChanged && !incomingChanged) {
            acceptedNode = nextNode;
            fallbackHtml = nextNode.attrs.html || fallbackHtml;
            return true;
          }
          if (editing && localChanged && incomingChanged && incomingMarkdown !== localMarkdown) {
            pendingConflict = true;
            return true;
          }
          pendingConflict = false;
          acceptedNode = nextNode;
          markdown = incomingMarkdown;
          fallbackHtml = nextNode.attrs.html || "";
          editing = Boolean(nextNode.attrs.editing);
          dom.dataset.markdown = markdown;
          render();
          return true;
        },
        selectNode() {
          if (editing) return;
          editing = true;
          updateAttrs({ editing: true }, undefined, true);
          renderEditor();
        },
        deselectNode() {
          commitEditor();
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          editor.off?.("update", scheduleRender);
          const pending = hasPending();
          unregisterPending();
          if (pending) retainAndUnregisterRecoveryLocalBufferForOwner(editor, recoveryId);
          else unregisterRecovery();
        },
        ignoreMutation: () => true,
        stopEvent: (event: Event) => event.target instanceof HTMLTextAreaElement,
      };
    };
  },
});

const exposedMarkdownLifecycleKey = new PluginKey<ExposedMarkdownRange | null>("lightmarkExposedMarkdownLifecycle");

const ExposedMarkdownLifecycle = Extension.create({
  name: "exposedMarkdownLifecycle",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: exposedMarkdownLifecycleKey,
      state: {
        init: (): ExposedMarkdownRange | null => null,
        apply: (transaction, active: ExposedMarkdownRange | null): ExposedMarkdownRange | null => {
          if (transaction.getMeta(clearExposeMarkdownMeta)) return null;
          const exposed = transaction.getMeta(exposeMarkdownMeta) as ExposedMarkdownRange | undefined;
          if (exposed) return exposed;
          if (!active || !transaction.docChanged) return active;
          return {
            ...active,
            from: transaction.mapping.map(active.from, -1),
            to: transaction.mapping.map(active.to, 1),
            blockFrom: transaction.mapping.map(active.blockFrom, -1),
          };
        },
      },
      appendTransaction: (transactions, oldState, newState) => {
        if (exposedMarkdownLifecycleKey.getState(oldState) || exposedMarkdownLifecycleKey.getState(newState)) return null;
        if (transactions.some((transaction) => transaction.docChanged)) return null;
        if (!oldState.selection.empty || !newState.selection.empty) return null;
        const oldPos = oldState.selection.from;
        const newPos = newState.selection.from;
        if (oldPos === newPos) return null;
        return exposeMarkdownAtCursor(newState, newPos > oldPos ? "right" : "left");
      },
    })];
  },
});

const TyporaSourceMarkers = Extension.create({
  name: "typoraSourceMarkers",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: outlineHeadingDecorationsKey,
        state: {
          init: (_, state) => buildOutlineHeadingDecorationState(state),
          apply: (transaction, previous, oldState, newState) => {
            const collapsed = currentCollapsedHeadingSignature();
            if (previous.epoch !== outlineDecorationEpoch || previous.collapsed !== collapsed) {
              return buildOutlineHeadingDecorationState(newState);
            }
            if (!transaction.docChanged) return previous;
            if (canMapOutlineHeadingDecorations(oldState, newState)) {
              return {
                ...previous,
                decorations: previous.decorations.map(transaction.mapping, transaction.doc),
              };
            }
            return buildOutlineHeadingDecorationState(newState);
          },
        },
        props: {
          decorations(state) {
            return outlineHeadingDecorationsKey.getState(state)?.decorations ?? null;
          },
        },
      }),
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const exposed = exposedMarkdownLifecycleKey.getState(state);

            if (exposed) {
              decorations.push(...createExposedMarkdownDecorations(state, exposed));
            } else if (state.selection.empty) {
              decorations.push(
                ...createMarkDecorations(state, "bold", "**", "**"),
                ...createMarkDecorations(state, "italic", "*", "*"),
                ...createMarkDecorations(state, "code", "`", "`"),
                ...createMarkDecorations(state, "strike", "~~", "~~"),
                ...createMarkDecorations(state, "highlight", "==", "=="),
                ...createMarkDecorations(state, "superscript", "^", "^"),
                ...createMarkDecorations(state, "subscript", "~", "~"),
                ...createLinkDecorations(state),
                ...createHeadingDecorations(state),
              );
            }

            return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          if (transactions.some((transaction) => transaction.getMeta(exposeMarkdownMeta))) return null;
          if (exposedMarkdownLifecycleKey.getState(newState)) return null;
          return convertInlineMarkdownSyntax(newState, { onlySelectionBlock: true });
        },
      }),
    ];
  },
});

const FindReplaceDecorations = Extension.create({
  name: "findReplaceDecorations",

  addProseMirrorPlugins() {
    return [
      createWysiwygFindPlugin({
        active: () => Boolean(findReplaceStore.open && findReplaceStore.query),
        currentIndex: () => findReplaceStore.currentIndex,
      }),
    ];
  },
});

const TyporaInlineCode = Extension.create({
  name: "typoraInlineCode",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "`" || event.ctrlKey || event.metaKey || event.altKey) return false;
            if (!convertInlineCodeBeforeCursor(view)) return false;
            event.preventDefault();
            return true;
          },
          handleTextInput: (view, from, to, text) => {
            if (text !== "`") return false;
            return convertInlineCodeBeforeCursor(view);
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          if (transactions.some((transaction) => transaction.getMeta(exposeMarkdownMeta))) return null;
          if (exposedMarkdownLifecycleKey.getState(newState)) return null;
          return convertInlineCodeSyntax(newState, { onlySelectionBlock: true });
        },
      }),
    ];
  },
});

const TyporaHorizontalRule = Node.create({
  name: "horizontalRule",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      editing: {
        default: false,
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "hr" }, { tag: 'div[data-type="horizontal-rule"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["hr", mergeAttributes(HTMLAttributes)];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "Enter") return false;

            const { state } = view;
            const { $from, empty } = state.selection;
            if (!empty || !$from.parent.isTextblock) return false;
            if (isLeadingFrontMatterFence(state)) return false;
            if (!/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test($from.parent.textContent)) return false;

            event.preventDefault();
            const from = $from.before();
            const to = $from.after();
            const rule = state.schema.nodes.horizontalRule.create();
            let tr = state.tr.replaceWith(from, to, rule);
            const after = from + rule.nodeSize;
            if (state.schema.nodes.paragraph) {
              tr = tr.insert(after, state.schema.nodes.paragraph.create());
              tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => createHorizontalRuleView(Boolean(node.attrs.editing), editor, getPos);
  },
});

const WritingFocusDecorations = Extension.create({
  name: "writingFocusDecorations",

  addProseMirrorPlugins() {
    return [
      createWysiwygDerivedPlugin(),
      createWysiwygFocusPlugin({
        enabled: () => Boolean(
          appStore.settings.editor.focusMode
          && props.paneId === appStore.splitLayout.activePaneId
          && paneEditorMode.value === "wysiwyg"
          && paneDocumentMode.value === "normal"
        ),
        matches: () => findReplaceStore.open ? cachedWysiwygFind.items : [],
      }),
    ];
  },
});

const FootnoteMetadataSync = Extension.create({
  name: "footnoteMetadataSync",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const $head = newState.selection.$head;
          const nearFootnote = [
            $head.parent.type?.name,
            $head.nodeBefore?.type?.name,
            $head.nodeAfter?.type?.name,
          ].some((name) => name === "footnoteRef" || name === "footnotes");
          if (!nearFootnote && !transactions.some((transaction) => transaction.getMeta("lightmarkFootnoteSync"))) return null;
          const definitions = new Map<string, string>();
          newState.doc.descendants((node: any) => {
            if (node.type?.name !== "footnotes") return true;
            for (const definition of parseFootnoteSource(String(node.attrs.markdown || ""))) {
              if (!definitions.has(definition.id)) definitions.set(definition.id, definition.content.trim());
            }
            return true;
          });

          const indexes = new Map<string, number>();
          const occurrences = new Map<string, number>();
          let nextIndex = 1;
          let tr = newState.tr;
          let changed = false;
          newState.doc.descendants((node: any, pos: number) => {
            if (node.type?.name !== "footnoteRef") return true;
            const id = String(node.attrs.id || "");
            if (!indexes.has(id)) indexes.set(id, nextIndex++);
            const occurrence = (occurrences.get(id) || 0) + 1;
            occurrences.set(id, occurrence);
            const attrs = {
              ...node.attrs,
              index: String(indexes.get(id)),
              refId: `fnref-${id}-${occurrence}`,
              preview: definitions.get(id) || "",
            };
            if (
              node.attrs.index !== attrs.index ||
              node.attrs.refId !== attrs.refId ||
              node.attrs.preview !== attrs.preview
            ) {
              tr = tr.setNodeMarkup(pos, undefined, attrs);
              changed = true;
            }
            return true;
          });
          return changed ? tr.setMeta("addToHistory", false) : null;
        },
      }),
    ];
  },
});

const PlainPasteMark = Mark.create({
  name: "plainPaste",
  parseHTML() {
    return [{ tag: 'span[data-plain-paste="true"]' }];
  },
  renderHTML() {
    return ["span", { "data-plain-paste": "true" }, 0];
  },
});

const LightMarkInlineCode = Mark.create({
  name: "code",
  code: true,
  excludes: "_",

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-code-raw") || "",
        renderHTML: (attributes) => attributes.raw ? { "data-code-raw": attributes.raw } : {},
      },
      originalText: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-code-original") || element.textContent || "",
        renderHTML: (attributes) => attributes.originalText ? { "data-code-original": attributes.originalText } : {},
      },
      delimiterLength: {
        default: 1,
        parseHTML: (element) => Number.parseInt(element.getAttribute("data-code-delimiter-length") || "1", 10) || 1,
        renderHTML: (attributes) => ({ "data-code-delimiter-length": String(attributes.delimiterLength || 1) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "code" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["code", mergeAttributes(HTMLAttributes), 0];
  },
});

const LightMarkTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null,
        parseHTML: parseTableCellAlign,
        renderHTML: renderTableCellAlign,
      },
    };
  },
});

const LightMarkTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null,
        parseHTML: parseTableCellAlign,
        renderHTML: renderTableCellAlign,
      },
    };
  },
});

function renderMarkdownForEditorWithAssets(markdown: string) {
  return resolveRenderedImageSources(renderMarkdownForEditor(markdown));
}

function createTyporaImageView(node: any, editor: any, getPos: (() => number | undefined) | boolean) {
  const dom = document.createElement("figure");
  const toolbar = document.createElement("div");
  const source = document.createElement("input");
  const error = document.createElement("div");
  const stage = document.createElement("div");
  const image = document.createElement("img");
  const caption = document.createElement("input");
  let currentNode = node;
  let sourceVisible = Boolean(node.attrs.editing);
  let errorMessage = "";
  let dragStart: { x: number; width: number; original: number | null } | null = null;

  dom.className = "typora-image-node";
  dom.contentEditable = "false";
  toolbar.className = "typora-image-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "图片排版");
  source.type = "text";
  source.className = "typora-image-source";
  source.spellcheck = false;
  error.className = "typora-image-error";
  stage.className = "typora-image-stage";
  image.draggable = false;
  caption.type = "text";
  caption.className = "typora-image-caption";
  caption.placeholder = "添加图片 Caption";

  const alignmentButtons = (["left", "center", "right"] as ImageAlignment[]).map((alignment) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "typora-image-tool";
    button.dataset.align = alignment;
    button.textContent = alignment === "left" ? "左" : alignment === "center" ? "中" : "右";
    button.title = `${button.textContent}对齐`;
    toolbar.append(button);
    return button;
  });
  const widthInput = document.createElement("input");
  widthInput.type = "number";
  widthInput.min = "48";
  widthInput.max = "4096";
  widthInput.className = "typora-image-width";
  widthInput.setAttribute("aria-label", "图片宽度（像素）");
  const unit = document.createElement("span");
  unit.textContent = "px";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "typora-image-tool";
  reset.textContent = "原始";
  const captionToggle = document.createElement("button");
  captionToggle.type = "button";
  captionToggle.className = "typora-image-tool";
  captionToggle.textContent = "Caption";
  toolbar.append(widthInput, unit, reset, captionToggle);

  const handles = [-1, 1].map((direction) => {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `typora-image-resize typora-image-resize-${direction < 0 ? "left" : "right"}`;
    handle.setAttribute("aria-label", "调整图片宽度");
    stage.append(handle);
    return { handle, direction };
  });
  stage.insertBefore(image, handles[1].handle);
  dom.append(toolbar, source, error, stage, caption);

  const sourceMarkdown = () => basicImageMarkdownFromAttrs(currentNode.attrs);
  const patchAttrs = (attrs: Record<string, unknown>, addToHistory = true) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const transaction = markAssetAttributeTransaction(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, ...attrs }), pos);
    if (!addToHistory) transaction.setMeta("addToHistory", false);
    editor.view.dispatch(transaction);
  };
  const render = () => {
    if (document.activeElement !== source) source.value = sourceMarkdown();
    error.textContent = errorMessage;
    image.src = currentNode.attrs.src || "";
    image.alt = currentNode.attrs.alt || "";
    if (currentNode.attrs.title) image.title = currentNode.attrs.title;
    else image.removeAttribute("title");
    const width = clampImageWidth(currentNode.attrs.widthPx);
    dom.dataset.align = currentNode.attrs.alignment || "left";
    dom.style.width = width ? `${width}px` : "";
    widthInput.value = width ? String(width) : "";
    if (document.activeElement !== caption) caption.value = currentNode.attrs.caption || "";
    caption.hidden = !currentNode.attrs.caption && !sourceVisible;
    alignmentButtons.forEach((button) => button.classList.toggle("active", button.dataset.align === dom.dataset.align));
    captionToggle.classList.toggle("active", !caption.hidden);
    dom.classList.toggle("typora-image-node-editing", sourceVisible);
    dom.classList.toggle("typora-image-node-error", Boolean(errorMessage));
  };
  const showSource = (focus = false) => {
    sourceVisible = true;
    render();
    if (focus) {
      requestAnimationFrame(() => {
        source.focus();
        source.select();
      });
    }
  };
  const hideSource = (reset = false) => {
    sourceVisible = false;
    errorMessage = "";
    if (reset) source.value = sourceMarkdown();
    render();
  };
  const commitSource = () => {
    if (!sourceVisible) return true;
    const parsed = parseSingleMarkdownImage(source.value.trim());
    if (!parsed) {
      errorMessage = "图片 Markdown 格式无效，应为 ![alt](path) 或 ![alt](path \"title\")";
      sourceVisible = true;
      render();
      requestAnimationFrame(() => source.focus());
      return false;
    }
    if (typeof getPos !== "function") return true;
    const pos = getPos();
    if (typeof pos !== "number") return true;
    const nextAttrs = {
      ...currentNode.attrs,
      src: parsed.src,
      markdownSrc: parsed.markdownSrc,
      alt: parsed.alt,
      title: parsed.title,
      editing: false,
    };
    errorMessage = "";
    sourceVisible = false;
    editor.view.dispatch(markAssetAttributeTransaction(editor.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs), pos));
    render();
    return true;
  };
  const selectImage = () => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, pos)));
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.target instanceof globalThis.Node && dom.contains(event.target)) return;
    commitSource();
  };
  const onEditorBlur = () => {
    window.setTimeout(() => {
      if (document.activeElement instanceof globalThis.Node && dom.contains(document.activeElement)) return;
      commitSource();
    });
  };

  image.addEventListener("click", (event) => {
    event.preventDefault();
    showSource(false);
    selectImage();
  });
  toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
  alignmentButtons.forEach((button) => button.addEventListener("click", () => {
    patchAttrs({ alignment: button.dataset.align as ImageAlignment });
    selectImage();
  }));
  widthInput.addEventListener("change", () => patchAttrs({ widthPx: clampImageWidth(widthInput.value) }));
  widthInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    patchAttrs({ widthPx: clampImageWidth(widthInput.value) });
    editor.view.focus();
  });
  reset.addEventListener("click", () => {
    patchAttrs({ widthPx: null });
    selectImage();
  });
  captionToggle.addEventListener("click", () => {
    sourceVisible = true;
    render();
    requestAnimationFrame(() => caption.focus());
  });
  caption.addEventListener("input", () => patchAttrs({ caption: caption.value }, false));
  caption.addEventListener("change", () => patchAttrs({ caption: caption.value.trim() }));
  caption.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    patchAttrs({ caption: caption.value.trim() });
    editor.view.focus();
  });
  const beginResize = (event: PointerEvent, direction: number) => {
    event.preventDefault();
    selectImage();
    const width = image.getBoundingClientRect().width || 320;
    dragStart = { x: event.clientX * direction, width, original: clampImageWidth(currentNode.attrs.widthPx) };
    const move = (next: PointerEvent) => {
      if (!dragStart) return;
      patchAttrs({ widthPx: clampImageWidth(dragStart.width + next.clientX * direction - dragStart.x) }, false);
    };
    const finish = () => {
      if (!dragStart) return;
      const finalWidth = clampImageWidth(currentNode.attrs.widthPx);
      const original = dragStart.original;
      dragStart = null;
      if (finalWidth !== original) {
        patchAttrs({ widthPx: original }, false);
        patchAttrs({ widthPx: finalWidth });
      }
      window.removeEventListener("pointermove", move);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  handles.forEach(({ handle, direction }) => {
    handle.addEventListener("pointerdown", (event) => beginResize(event, direction));
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = clampImageWidth(currentNode.attrs.widthPx) || Math.round(image.getBoundingClientRect().width);
      const delta = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 10 : 1);
      patchAttrs({ widthPx: clampImageWidth(current + delta) });
    });
  });
  source.addEventListener("click", (event) => {
    event.stopPropagation();
    showSource(false);
    selectImage();
  });
  source.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitSource();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideSource(true);
      editor.view.focus();
    }
  });
  source.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement instanceof globalThis.Node && dom.contains(document.activeElement)) return;
      commitSource();
    });
  });
  editor.on?.("blur", onEditorBlur);
  document.addEventListener("mousedown", onMouseDown);
  render();
  if (sourceVisible) showSource(true);

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type !== currentNode.type) return false;
      currentNode = nextNode;
      if (nextNode.attrs.editing) sourceVisible = true;
      render();
      return true;
    },
    destroy() {
      editor.off?.("blur", onEditorBlur);
      document.removeEventListener("mousedown", onMouseDown);
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof globalThis.Node && dom.contains(event.target),
  };
}

function basicImageMarkdownFromAttrs(attrs: Record<string, string | null | undefined>) {
  const src = attrs.markdownSrc || attrs.src || "";
  const alt = (attrs.alt || "").replace(/]/g, "\\]");
  const title = attrs.title ? ` "${attrs.title.replace(/"/g, '\\"')}"` : "";
  return `![${alt}](${src}${title})`;
}

function createCodeBlockLanguageView({ node, editor, getPos }: any) {
  let currentNode = node;
  let open = false;
  let query = "";
  let highlightedIndex = 0;

  const dom = document.createElement("div");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const toolbar = document.createElement("div");
  const button = document.createElement("button");
  const menu = document.createElement("div");
  const input = document.createElement("input");
  const list = document.createElement("div");

  dom.className = "lightmark-code-block-shell";
  pre.className = "lightmark-code-block";
  toolbar.className = "code-language-toolbar";
  button.type = "button";
  button.className = "code-language-button";
  button.title = "选择代码语言";
  menu.className = "code-language-menu";
  input.className = "code-language-input";
  input.placeholder = "搜索语言";
  list.className = "code-language-list";

  menu.append(input, list);
  toolbar.append(button, menu);
  pre.append(code);
  dom.append(toolbar, pre);

  const codeLanguage = () => displayCodeLanguage(currentNode.attrs.language || "");

  const setLanguage = (value: string) => {
    const typed = value.trim().toLowerCase();
    const language = normalizeCodeLanguage(typed) || typed;
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const attrs = { ...currentNode.attrs, language: language || null };
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, attrs));
    open = false;
    query = "";
    highlightedIndex = 0;
    render();
    editor.commands.focus();
  };

  const chooseHighlighted = () => {
    if (!query.trim()) {
      setLanguage("");
      return;
    }
    const candidates = filterCodeLanguages(query);
    setLanguage(candidates[highlightedIndex] || query);
  };

  const isSelectionInsideCodeBlock = () => {
    if (typeof getPos !== "function") return false;
    const pos = getPos();
    if (typeof pos !== "number") return false;
    const { selection } = editor.view.state;
    const from = pos;
    const to = pos + currentNode.nodeSize;
    return selection.from >= from && selection.to <= to;
  };

  const renderCandidates = () => {
    const candidates = filterCodeLanguages(query);
    highlightedIndex = Math.min(highlightedIndex, Math.max(candidates.length - 1, 0));
    list.innerHTML = "";
    candidates.forEach((language, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = index === highlightedIndex ? "code-language-option active" : "code-language-option";
      option.textContent = language;
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        setLanguage(language);
      });
      list.append(option);
    });
    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "code-language-empty";
      empty.textContent = query.trim() ? `使用 "${query.trim().toLowerCase()}"` : "输入语言";
      list.append(empty);
    }
  };

  const render = () => {
    const language = codeLanguage();
    const active = open || isSelectionInsideCodeBlock();
    dom.className = `lightmark-code-block-shell${active ? " is-code-language-active" : ""}${open ? " is-code-language-open" : ""}`;
    code.className = language ? `language-${language}` : "";
    button.textContent = language || "代码语言";
    button.classList.toggle("placeholder", !language);
    menu.hidden = !open;
    if (open) {
      input.value = query;
      renderCandidates();
    }
  };

  const openMenu = () => {
    open = true;
    query = codeLanguage();
    highlightedIndex = 0;
    render();
    window.setTimeout(() => {
      input.focus();
      input.select();
    });
  };

  const closeMenu = () => {
    open = false;
    query = "";
    highlightedIndex = 0;
    render();
    editor.commands.focus();
  };

  const updateActive = () => {
    if (open) return;
    dom.classList.toggle("is-code-language-active", isSelectionInsideCodeBlock());
  };
  const onDocumentMouseDown = (event: MouseEvent) => {
    if (!open) return;
    if (event.target instanceof globalThis.Node && toolbar.contains(event.target)) return;
    open = false;
    query = "";
    highlightedIndex = 0;
    render();
  };

  const stopToolbarEvent = (event: Event) => {
    event.stopPropagation();
  };

  toolbar.addEventListener("pointerdown", stopToolbarEvent);
  toolbar.addEventListener("mousedown", stopToolbarEvent);
  toolbar.addEventListener("click", stopToolbarEvent);
  toolbar.addEventListener("keydown", stopToolbarEvent);
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  });
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  });
  input.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("input", () => {
    query = input.value;
    highlightedIndex = 0;
    renderCandidates();
  });
  input.addEventListener("keydown", (event) => {
    const candidates = filterCodeLanguages(query);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, Math.max(candidates.length - 1, 0));
      renderCandidates();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
      renderCandidates();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      chooseHighlighted();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const candidates = filterCodeLanguages(query);
      setLanguage(candidates[highlightedIndex] || query);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  });
  dom.addEventListener("mouseup", updateActive);
  dom.addEventListener("keyup", updateActive);
  document.addEventListener("selectionchange", updateActive);
  document.addEventListener("mousedown", onDocumentMouseDown);
  editor.on?.("selectionUpdate", updateActive);
  editor.on?.("focus", updateActive);
  editor.on?.("blur", updateActive);
  render();
  window.setTimeout(updateActive);

  return {
    dom,
    contentDOM: code,
    update(nextNode: any) {
      if (nextNode.type !== currentNode.type) return false;
      currentNode = nextNode;
      render();
      updateActive();
      return true;
    },
    destroy() {
      document.removeEventListener("selectionchange", updateActive);
      document.removeEventListener("mousedown", onDocumentMouseDown);
      toolbar.removeEventListener("pointerdown", stopToolbarEvent);
      toolbar.removeEventListener("mousedown", stopToolbarEvent);
      toolbar.removeEventListener("click", stopToolbarEvent);
      toolbar.removeEventListener("keydown", stopToolbarEvent);
      editor.off?.("selectionUpdate", updateActive);
      editor.off?.("focus", updateActive);
      editor.off?.("blur", updateActive);
    },
    stopEvent(event: Event) {
      return event.target instanceof globalThis.Node && toolbar.contains(event.target);
    },
    ignoreMutation(mutation: any) {
      return mutation.target instanceof globalThis.Node && toolbar.contains(mutation.target);
    },
  };
}

const editor = useEditor({
  enableInputRules: ["blockquote", "bulletList", "orderedList"],
  extensions: [
    StarterKit.configure({
      undoRedo: false,
      heading: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      code: false,
      link: false,
    }),
    LightMarkCodeBlock.configure({
      lowlight,
      defaultLanguage: "plaintext",
    }),
    TyporaHeading.configure({
      levels: [1, 2, 3, 4, 5, 6],
    }),
    TyporaBlockquote,
    Link.configure({ openOnClick: false, protocols: ["lightmark"] }),
    MarkdownImage,
    Table.configure({ resizable: true }),
    TableRow,
    LightMarkTableHeader,
    LightMarkTableCell,
    MarkdownHeading,
    InlineMath,
    EscapedDollarNode,
    InlineHtmlNode,
    RawHtmlNode,
    BlockMath,
    MermaidNode,
    FootnoteRefNode,
    HighlightMark,
    StrikeMark,
    PlainPasteMark,
    SuperscriptMark,
    SubscriptMark,
    TaskStateMark,
    FrontMatterNode,
    TableOfContentsNode,
    HtmlBlockNode,
    FootnotesNode,
    FootnoteMetadataSync,
    LightMarkInlineCode,
    TyporaInlineCode,
    TyporaHorizontalRule,
    FrontMatterInput,
    FencedCodeBlockInput,
    FindReplaceDecorations,
    WritingFocusDecorations,
    ExposedMarkdownLifecycle,
    TyporaSourceMarkers,
  ],
  content: renderMarkdownForEditorWithAssets(paneContent.value),
  editorProps: {
    attributes: {
      class: "prose prose-stone dark:prose-invert mx-auto min-h-full max-w-[var(--lm-editor-width)] px-8 pb-12 pt-6 focus:outline-none",
    },
    handleKeyDown(view, event) {
      if (handleSlashMenuKeydown(view, event)) return true;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        const { from, to } = view.state.selection;
        void pasteWysiwygFromClipboard(true, from, to);
        return true;
      }
      if (handleExactFormatHistoryKeydown(view, event)) return true;
      if (handleWikiCompletionKeydown(view, event)) return true;
      if (handleExposedMarkdownDeletion(view, event)) return true;
      if (handleWysiwygPair(view, event)) return true;
      if (handleWysiwygTab(view, event)) return true;
      if (convertLeadingFrontMatter(view, event)) return true;
      if (convertFencedCodeBlock(view, event)) return true;
      if (event.key === "Backspace" && exitEmptyStoredFormattingOnBackspace(view)) {
        event.preventDefault();
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
        return true;
      }
      if (exposeMarkdownBeforeCursorMove(view, event)) {
        event.preventDefault();
        return true;
      }
      if (event.key === "Enter") {
        if ((event.ctrlKey || event.metaKey) && insertTableRowAfterAndFocusFirstCell(view)) {
          event.preventDefault();
          return true;
        }

        if (continueTaskItem(view)) {
          event.preventDefault();
          return true;
        }

        if (handleWysiwygMarkdownShortcutEnter(view)) {
          event.preventDefault();
          return true;
        }

        const headingTr = convertMarkdownHeading(view.state, {
          force: true,
          onlySelectionBlock: true,
          insertParagraph: true,
        });
        if (headingTr) {
          event.preventDefault();
          view.dispatch(headingTr.scrollIntoView());
          return true;
        }
        window.setTimeout(() => clearStoredMarks(view, ["strike"]), 0);
      }
      return false;
    },
    handleTextInput(view, from, to, text) {
      if (handleExposedMarkdownTextInput(view, from, to, text)) return true;
      scheduleSlashMenuUpdate(view);
      return handleWysiwygMarkdownShortcutText(view, from, to, text);
    },
    handleDOMEvents: {
      copy(view, event) {
        const payload = selectionClipboardPayload(view.state);
        return payload ? writeClipboardPayloadToEvent(event as ClipboardEvent, payload) : false;
      },
      cut(view, event) {
        if (view.state.selection.empty) return false;
        const payload = selectionClipboardPayload(view.state);
        if (!payload || !writeClipboardPayloadToEvent(event as ClipboardEvent, payload)) return false;
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
        return true;
      },
      mousedown(view, event) {
        const mouseEvent = event as MouseEvent;
        const marker = getEventElement(mouseEvent)?.closest<HTMLElement>(".md-live-marker");
        if (marker) {
          if (exposedMarkdownLifecycleKey.getState(view.state)) return false;
          const heading = marker.closest<HTMLElement>("h1,h2,h3,h4,h5,h6");
          if (heading) {
            mouseEvent.preventDefault();
            editHeadingAsMarkdown(view, heading, mouseEvent);
            return true;
          }
          const clickPos = view.posAtCoords({ left: mouseEvent.clientX, top: mouseEvent.clientY });
          if (clickPos && editInlineSyntaxAsMarkdown(view, marker, clickPos.pos)) {
            mouseEvent.preventDefault();
            return true;
          }
        }
        return convertPendingMarkdownBeforeMouseSelection(view, mouseEvent);
      },
      contextmenu(view, event) {
        const mouseEvent = event as MouseEvent;
        const target = getEventElement(mouseEvent);
        if (!target || !view.dom.contains(target)) return false;

        mouseEvent.preventDefault();
        const position = view.posAtCoords({ left: mouseEvent.clientX, top: mouseEvent.clientY });
        if (position && !isPositionInsideSelection(view.state.selection, position.pos)) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))));
        }
          savedSelection.value = {
            from: view.state.selection.from,
            to: view.state.selection.to,
          };
        const mode: ContextMenuMode =
          target.closest("pre, code") || view.state.selection.$from.parent.type.name === "codeBlock" ? "code" : "default";
        const menuPosition = getContextMenuPosition(mouseEvent.clientX, mouseEvent.clientY);

        contextMenu.value = {
          visible: true,
          x: menuPosition.x,
          y: menuPosition.y,
          mode,
          inTable: Boolean(target.closest("table")),
          flipX: menuPosition.flipX,
          flipY: menuPosition.flipY,
        };
        return true;
      },
      click(view, event) {
        hideContextMenu();
        const mouseEvent = event as MouseEvent;
        const target = getEventElement(mouseEvent);
        const link = target?.closest<HTMLAnchorElement>("a[href]");
        if (link) {
          mouseEvent.preventDefault();
          const href = link.getAttribute("href") || "";
          const wikiTarget = parseWikiLinkHref(href);
          if (wikiTarget) {
            void openWikiLink(wikiTarget);
            return true;
          }
          if (href.startsWith("#")) {
            scrollInternalLink(href);
            return true;
          }
          if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
            mouseEvent.stopPropagation();
            void openExternalLink(link.href);
            return true;
          }
          return false;
        }
        return false;
      },
      dragover(_view, event) {
        const dragEvent = event as DragEvent;
        if (getImageFilesFromDrop(dragEvent.dataTransfer).length === 0) return false;
        dragEvent.preventDefault();
        return true;
      },
      drop(view, event) {
        const dragEvent = event as DragEvent;
        const files = getImageFilesFromDrop(dragEvent.dataTransfer);
        if (files.length === 0) return false;
        dragEvent.preventDefault();
        const position = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY });
        const insertAt = position?.pos ?? view.state.doc.content.size;
        void insertImageFilesIntoWysiwyg(files, insertAt, insertAt, "drop");
        return true;
      },
      blur(view) {
        window.setTimeout(() => {
          if (view.hasFocus()) return;
          if (convertPendingInlineMarkdown(view)) return;

          const blockTr =
            convertBlockquoteMarkdown(view.state, { force: true }) ||
            convertHorizontalRuleMarkdown(view.state, { force: true }) ||
            convertMarkdownHeading(view.state, { force: true });
          if (blockTr) view.dispatch(blockTr);
        }, 0);
        return false;
      },
    },
    handleClick(view, pos, event) {
      const target = getEventElement(event);
      if (exposedMarkdownLifecycleKey.getState(view.state)) return false;
      const table = target?.closest<HTMLTableElement>("table");
      if (table && view.dom.contains(table)) {
        const cell = target?.closest<HTMLTableCellElement>("td,th") || null;
        window.setTimeout(() => updateTableControl(view, table, cell), 0);
      }

      const heading = target?.closest<HTMLElement>("h1,h2,h3,h4,h5,h6");
      if (heading && view.dom.contains(heading)) {
        event.preventDefault();
        editHeadingAsMarkdown(view, heading, event as MouseEvent);
        return true;
      }

      if (target && view.dom.contains(target) && editInlineSyntaxAsMarkdown(view, target, pos)) {
        event.preventDefault();
        return true;
      }

      const checkbox = target?.closest<HTMLInputElement>("input[data-task-checkbox]");
      const task = checkbox?.closest<HTMLElement>("[data-task-item]");
      if (checkbox && task) {
        event.preventDefault();
        toggleTaskItem(view, task);
        return true;
      }

      return false;
    },
    handlePaste(view, event) {
      const imageFiles = getImageFilesFromClipboard(event.clipboardData);
      if (imageFiles.length > 0) {
        event.preventDefault();
        const { from, to } = view.state.selection;
        void insertImageFilesIntoWysiwyg(imageFiles, from, to, "clipboard");
        return true;
      }
      const result = prepareSmartPaste(clipboardPayloadFromDataTransfer(event.clipboardData));
      if (!result.markdown) return false;
      event.preventDefault();
      const { from, to } = view.state.selection;
      insertPreparedPasteIntoWysiwyg(result, from, to);
      return true;
    },
  },
  onTransaction({ editor: updatedEditor, transaction, appendedTransactions }) {
    if (!isCurrentWysiwygEditor(updatedEditor)) return;
    recordTrackedTransactions(updatedEditor, transaction, appendedTransactions);
    trackSourceProvenance(transaction, canonicalMarkdownHistoryState(updatedEditor.state, exposedMarkdownLifecycleKey.getState(updatedEditor.state)));
    if (editorOwnerTab && pendingCommandLease) {
      const maps = pendingPmCommandMaps([transaction, ...(appendedTransactions ?? [])]);
      mapPendingDocumentCommands(editorOwnerTab.id, pendingCommandLease, maps, anchor => validateAssetReferenceBookmark(updatedEditor.state.doc, anchor));
    }
  },
  onUpdate({ editor: updatedEditor, transaction }) {
    if (!isCurrentWysiwygEditor(updatedEditor)) return;
    if (transaction.getMeta(markdownPresentationMeta)) return;
    if (transaction.getMeta(LOCAL_EDITOR_UI_TRANSACTION_META_KEY)) return;
    reconcileExposedHeading(updatedEditor.view);
    if (suppressWysiwygUpdate || transaction.getMeta("lightmarkLowlightRefresh")) return;
    if (historySourceBaseline && editorOwnerTab) {
      const history = documentHistoryForTab(editorOwnerTab.id);
      const canonical = canonicalMarkdownHistoryState(updatedEditor.state, exposedMarkdownLifecycleKey.getState(updatedEditor.state));
      trackSourceProvenance(transaction, canonical);
      const previousProjection = history.current && history.projection(history.current, 'wysiwyg');
      const previousRoot = previousProjection?.root;
      if (previousRoot?.mode === 'wysiwyg' && equalCanonicalDocument(previousRoot.doc, canonical.doc)) {
        const bookmark = previousRoot.doc.type.schema === canonical.doc.type.schema ? canonical.bookmark : previousProjection!.bookmark;
        history.project({ mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline }, bookmark);
        historyBookmark = bookmark;
        return;
      }
      if (history.current && !history.isReplaying) {
        const inputType = transaction.getMeta('uiEvent');
        const composition = transaction.getMeta('composition');
        const textOnly = transaction.steps.length === 1 && transaction.steps[0].toJSON().stepType === 'replace';
        const step = textOnly ? transaction.steps[0].toJSON() : null;
        const inserted = step?.slice?.content?.every((node: any) => node.type === 'text') && step.slice.content.map((node: any) => node.text).join('');
        const kind = composition != null ? 'composition' : inputType === 'paste' || inputType === 'drop' || !textOnly ? 'command'
          : inserted && step.from === step.to ? 'typing'
          : !step.slice && step.to > step.from ? step.from < historyBookmark.head ? 'delete-backward' : 'delete-forward' : 'command';
        history.record({ mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline }, {
          kind, before: historyBookmark, after: canonical.bookmark, time: Date.now(), composition,
        });
      }
      historyBookmark = canonical.bookmark;
    }
    wysiwygRevision = advanceDocumentRevision(editorOwnerTab!.id, wysiwygRevision);
    documentMutationTracker?.setRevision(wysiwygRevision);
    snapshotCache?.invalidate();
    const tab = getPaneTab(props.paneId);
    const derived = getWysiwygDerivedState(updatedEditor.state);
    if (tab) markDocumentChanged(tab.id, wysiwygRevision, {
      words: derived.words,
      chars: derived.chars,
      lines: derived.lines,
      outline: derived.outlineChanged ? wysiwygStructuredOutline(updatedEditor.state) : undefined,
    });
    publishToolbarFormatState(updatedEditor);
    syncWysiwygFindState(updatedEditor.state);
    if (transactionChangesMathDependencies(transaction)) {
      window.dispatchEvent(new CustomEvent("lightmark:refresh-math"));
    }
    updateCodeLanguageControl(updatedEditor.view);
    void ensureSelectedCodeLanguage(updatedEditor.view);
    updateTableControl(updatedEditor.view);
    captureWysiwygPosition(updatedEditor.view);
    captureWysiwygSelectionAnchor(updatedEditor.view);
    updateWysiwygWikiCompletion(updatedEditor.view);
    updateSlashMenu(updatedEditor.view);
    scheduleWysiwygTypewriter(updatedEditor.view);
  },
  onSelectionUpdate({ editor: updatedEditor, transaction }) {
    if (!isCurrentWysiwygEditor(updatedEditor)) return;
    publishToolbarFormatState(updatedEditor);
    if (!transaction.docChanged && !transaction.getMeta(markdownPresentationMeta) && editorOwnerTab) documentHistoryForTab(editorOwnerTab.id).closeGroup();
    if (!transaction.docChanged) historyBookmark = canonicalMarkdownHistoryState(updatedEditor.state, exposedMarkdownLifecycleKey.getState(updatedEditor.state)).bookmark;
    if (restoreExposedMarkdownWhenOutside(updatedEditor.view)) return;
    updateCodeLanguageControl(updatedEditor.view);
    updateTableControl(updatedEditor.view);
    captureWysiwygPosition(updatedEditor.view);
    captureWysiwygSelectionAnchor(updatedEditor.view);
    updateWysiwygWikiCompletion(updatedEditor.view);
    updateSlashMenu(updatedEditor.view);
    scheduleWysiwygTypewriter(updatedEditor.view);
  },
  onFocus({ editor: updatedEditor }) {
    if (!isCurrentWysiwygEditor(updatedEditor)) return;
    updateCodeLanguageControl(updatedEditor.view);
    updateTableControl(updatedEditor.view);
    scheduleWysiwygTypewriter(updatedEditor.view);
  },
  onBlur({ editor: updatedEditor }) {
    if (!isCurrentWysiwygEditor(updatedEditor)) return;
    restoreExposedMarkdownWhenOutside(updatedEditor.view, true);
    window.setTimeout(() => {
      if (!isCurrentWysiwygEditor(updatedEditor)) return;
      closeWysiwygWikiCompletion();
      if (!document.activeElement?.closest?.(".slash-command-menu")) closeSlashMenu();
      if (codeLanguageControl.value.open) return;
      codeLanguageControl.value.visible = false;
      if (!tableControl.value.resizeOpen && !tableControl.value.moreOpen) tableControl.value.visible = false;
    }, 120);
  },
});

function ownerTabStillExists() {
  return Boolean(editorOwnerTab && appStore.tabs.some((tab) => toRaw(tab) === editorOwnerTab));
}

function isCurrentOwnerTab() {
  const currentTab = getPaneTab(props.paneId);
  return Boolean(editorOwnerTab && currentTab && toRaw(currentTab) === editorOwnerTab);
}

function isCurrentWysiwygEditor(candidate: any) {
  return Boolean(candidate && candidate === editor.value && isCurrentOwnerTab());
}

function scheduleSlashMenuUpdate(view: EditorView) {
  window.setTimeout(() => updateSlashMenu(view), 0);
}

function updateSlashMenu(view = editor.value?.view) {
  if (!view || view.composing || props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") {
    closeSlashMenu();
    return;
  }
  const { selection } = view.state;
  const { $from } = selection;
  if (!selection.empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph") {
    closeSlashMenu();
    return;
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
  const match = before.match(/^\s*\/([^\s/]*)$/u);
  if (!match || $from.parentOffset !== $from.parent.content.size) {
    closeSlashMenu();
    return;
  }
  const coords = view.coordsAtPos(selection.from);
  const shell = editorShell.value;
  const rect = shell?.getBoundingClientRect();
  const x = rect && shell ? coords.left - rect.left + shell.scrollLeft : coords.left;
  const below = rect && shell ? coords.bottom - rect.top + shell.scrollTop + 6 : coords.bottom + 6;
  const menuHeight = 330;
  const availableBelow = rect ? rect.bottom - coords.bottom : window.innerHeight - coords.bottom;
  slashMenu.value = {
    visible: true,
    query: match[1],
    from: selection.from - match[0].length,
    to: selection.from,
    blockFrom: $from.before(),
    blockTo: $from.after(),
    x: Math.max(8, Math.min(x, Math.max(8, (shell?.clientWidth ?? window.innerWidth) - 328))),
    y: availableBelow < menuHeight && coords.top > menuHeight
      ? (rect && shell ? coords.top - rect.top + shell.scrollTop - 6 : coords.top - 6)
      : below,
    highlightedIndex: Math.min(slashMenu.value.highlightedIndex, Math.max(0, slashCandidates.value.length - 1)),
    flipY: availableBelow < menuHeight && coords.top > menuHeight,
  };
  closeWysiwygWikiCompletion();
}

function handleSlashMenuKeydown(view: EditorView, event: KeyboardEvent) {
  if (!slashMenu.value.visible) {
    if (["Backspace", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) scheduleSlashMenuUpdate(view);
    return false;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const total = slashCandidates.value.length;
    if (total > 0) slashMenu.value.highlightedIndex = (slashMenu.value.highlightedIndex + (event.key === "ArrowDown" ? 1 : -1) + total) % total;
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    const candidate = slashCandidates.value[slashMenu.value.highlightedIndex];
    if (!candidate) return false;
    event.preventDefault();
    executeSlashCommand(candidate);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSlashMenu();
    return true;
  }
  if (event.key === " " || event.key === "/") {
    closeSlashMenu();
    return false;
  }
  if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) scheduleSlashMenuUpdate(view);
  return false;
}

function closeSlashMenu() {
  slashMenu.value.visible = false;
  slashMenu.value.query = "";
  slashMenu.value.highlightedIndex = 0;
}

function executeSlashCommand(command: SlashCommandDefinition) {
  const activeEditor = editor.value;
  if (!activeEditor || !slashMenu.value.visible) return;
  const { blockFrom, blockTo } = slashMenu.value;
  closeSlashMenu();
  if (command.kind === "snippet") {
    const snippet = appStore.settings.snippets.items.find((item) => item.id === command.snippetId && item.enabled);
    if (!snippet) return;
    const expansion = expandSnippet(snippet.markdown, { selection: "" });
    replaceWysiwygRangeWithMarkdown(blockFrom, blockTo, expansion.markdown, expansion.cursorOffset, undefined, true);
    appStore.statusMessage = `已插入片段：${snippet.name}`;
    return;
  }
  const template = slashBuiltinMarkdown(command);
  if (!template) return;
  const expansion = expandSnippet(template.markdown, { selection: "" });
  replaceWysiwygRangeWithMarkdown(blockFrom, blockTo, expansion.markdown, expansion.cursorOffset, template.selectText, true);
}

function slashBuiltinMarkdown(command: SlashCommandDefinition): { markdown: string; selectText?: string } | null {
  switch (command.action) {
    case "paragraph": return { markdown: "${cursor}" };
    case "heading": return { markdown: `${"#".repeat(Number(command.value) || 1)} \${cursor}` };
    case "bulletList": return { markdown: "- ${cursor}" };
    case "orderedList": return { markdown: "1. ${cursor}" };
    case "taskList": return { markdown: "- [ ] ${cursor}" };
    case "blockquote": return { markdown: "> ${cursor}" };
    case "codeBlock": return { markdown: "```\n${cursor}\n```" };
    case "mathBlock": return { markdown: "$$\n${cursor}\n$$" };
    case "table": return { markdown: "| 标题 1 | 标题 2 |\n| --- | --- |\n| ${cursor} |  |" };
    case "horizontalRule": return { markdown: "---\n\n${cursor}" };
    case "image": return { markdown: "![图片描述](image-url)", selectText: "图片描述" };
    case "toc": return { markdown: "[TOC]\n\n${cursor}" };
    case "alert": return { markdown: `> [!${String(command.value || "note").toUpperCase()}]\n> \${cursor}` };
    default: return null;
  }
}

function captureWysiwygEditorTarget(event: CustomEvent<{ target: CapturedEditorTarget | null }>) {
  const activeEditor = editor.value;
  const tab = getPaneTab(props.paneId);
  if (!activeEditor || !tab || props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const { anchor, head } = activeEditor.state.selection;
  event.detail.target = {
    paneId: props.paneId,
    tabId: tab.id,
    documentMode: "normal",
    editorMode: "wysiwyg",
    anchor,
    head,
    selection: getSelectedMarkdown(),
    capturedAt: Date.now(),
  };
}

function insertSnippetIntoWysiwyg(event: CustomEvent<{ snippetId: string; target: CapturedEditorTarget }>) {
  const target = event.detail?.target;
  const activeEditor = editor.value;
  const tab = getPaneTab(props.paneId);
  const snippet = appStore.settings.snippets.items.find((item) => item.id === event.detail?.snippetId && item.enabled);
  if (!activeEditor || !target || !snippet || target.paneId !== props.paneId || target.tabId !== tab?.id || target.editorMode !== "wysiwyg" || target.documentMode !== "normal") return;
  const from = Math.max(0, Math.min(target.anchor, target.head, activeEditor.state.doc.content.size));
  const to = Math.max(from, Math.min(Math.max(target.anchor, target.head), activeEditor.state.doc.content.size));
  activeEditor.view.dispatch(activeEditor.state.tr.setSelection(TextSelection.create(activeEditor.state.doc, from, to)).setMeta("addToHistory", false));
  if (getSelectedMarkdown() !== target.selection) {
    appStore.statusMessage = "片段插入位置已经变化，请重试。";
    return;
  }
  const expansion = expandSnippet(snippet.markdown, { selection: target.selection });
  replaceWysiwygRangeWithMarkdown(from, to, expansion.markdown, expansion.cursorOffset);
  appStore.statusMessage = `已插入片段：${snippet.name}`;
}

function replaceWysiwygRangeWithMarkdown(from: number, to: number, markdown: string, cursorOffset: number, selectText?: string, closedBlock = false) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const state = activeEditor.view.state;
  const container = document.createElement("div");
  container.innerHTML = renderMarkdownForEditorWithAssets(markdown || " ");
  const parsed = ProseMirrorDOMParser.fromSchema(state.schema).parse(container);
  const slice = closedBlock ? new Slice(parsed.content, 0, 0) : Slice.maxOpen(parsed.content);
  let transaction = state.tr.replaceRange(from, to, slice);
  const insertedFrom = transaction.mapping.map(from, -1);
  const insertedTo = transaction.mapping.map(to, 1);
  let selectionFrom = insertedTo;
  let selectionTo = insertedTo;
  if (selectText) {
    transaction.doc.nodesBetween(Math.max(0, insertedFrom), Math.min(transaction.doc.content.size, insertedTo), (node, position) => {
      if (selectionFrom !== insertedTo || !node.isText || !node.text) return;
      const index = node.text.indexOf(selectText);
      if (index >= 0) {
        selectionFrom = position + index;
        selectionTo = selectionFrom + selectText.length;
      }
    });
  } else {
    const local = markdownOffsetToDocPos({ doc: parsed }, Math.min(cursorOffset, markdown.length), markdown || " ");
    selectionFrom = Math.max(insertedFrom, Math.min(insertedTo, insertedFrom + Math.max(0, local - 1)));
    selectionTo = selectionFrom;
  }
  try {
    transaction = transaction.setSelection(TextSelection.create(transaction.doc, selectionFrom, selectionTo));
  } catch {
    transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(insertedTo, transaction.doc.content.size))));
  }
  activeEditor.view.dispatch(transaction.scrollIntoView());
  activeEditor.view.focus();
}

function updateWysiwygWikiCompletion(view = editor.value?.view) {
  if (!view || !appStore.currentWorkspace || paneEditorMode.value !== "wysiwyg") {
    closeWysiwygWikiCompletion();
    return;
  }
  const { selection } = view.state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock || isWikiCompletionProtected($from)) {
    closeWysiwygWikiCompletion();
    return;
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
  const match = before.match(/\[\[([^\[\]\n]*)$/);
  if (!match) {
    closeWysiwygWikiCompletion();
    return;
  }
  const coords = view.coordsAtPos(selection.from);
  const shell = editorShell.value;
  const rect = shell?.getBoundingClientRect();
  const desiredX = rect && shell ? coords.left - rect.left + shell.scrollLeft : coords.left;
  const desiredY = rect && shell ? coords.bottom - rect.top + shell.scrollTop + 6 : coords.bottom + 6;
  const menuWidth = 288;
  const menuHeight = 272;
  const x = shell ? Math.max(shell.scrollLeft + 8, Math.min(desiredX, shell.scrollLeft + shell.clientWidth - menuWidth - 8)) : desiredX;
  const y = shell && desiredY + menuHeight > shell.scrollTop + shell.clientHeight
    ? Math.max(shell.scrollTop + 8, coords.top - (rect?.top ?? 0) + shell.scrollTop - menuHeight - 6)
    : desiredY;
  wikiCompletion.value = {
    visible: true,
    query: match[1],
    from: selection.from - match[0].length,
    to: selection.from,
    x,
    y,
    highlightedIndex: Math.min(wikiCompletion.value.highlightedIndex, Math.max(wysiwygWikiCandidates.value.length - 1, 0)),
  };
}

function isWikiCompletionProtected($from: any) {
  const protectedNodes = new Set(["codeBlock", "frontMatter", "inlineMath", "blockMath", "rawHtml", "inlineHtml"]);
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if (protectedNodes.has($from.node(depth).type.name)) return true;
  }
  return $from.marks().some((mark: any) => mark.type.name === "code" || mark.type.name === "link");
}

function handleWikiCompletionKeydown(view: any, event: KeyboardEvent) {
  if (!wikiCompletion.value.visible) return false;
  const count = wysiwygWikiCandidates.value.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count > 0) {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      wikiCompletion.value.highlightedIndex = (wikiCompletion.value.highlightedIndex + delta + count) % count;
    }
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && count > 0) {
    event.preventDefault();
    chooseWysiwygWikiCompletion(wysiwygWikiCandidates.value[wikiCompletion.value.highlightedIndex], view);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeWysiwygWikiCompletion();
    return true;
  }
  return false;
}

function chooseWysiwygWikiCompletion(candidate: WikiCompletionCandidate | undefined, view = editor.value?.view) {
  if (!candidate || !view) return;
  const link = view.state.schema.marks.link.create({ href: wikiLinkHref({ page: candidate.name }) });
  const linkedText = view.state.schema.text(candidate.name, [link]);
  const trailing = view.state.doc.textBetween(
    wikiCompletion.value.to,
    Math.min(view.state.doc.content.size, wikiCompletion.value.to + 2),
    "",
    "\0",
  );
  const replaceTo = wikiCompletion.value.to + (trailing.startsWith("]]") ? 2 : trailing.startsWith("]") ? 1 : 0);
  const tr = view.state.tr.replaceWith(wikiCompletion.value.from, replaceTo, linkedText);
  view.dispatch(
    tr
      .setSelection(TextSelection.create(tr.doc, wikiCompletion.value.from + candidate.name.length))
      .setStoredMarks([])
      .scrollIntoView(),
  );
  closeWysiwygWikiCompletion();
  view.focus();
}

function closeWysiwygWikiCompletion() {
  wikiCompletion.value.visible = false;
}

function handleWysiwygPair(view: any, event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  const { selection } = view.state;
  const { $from, $to } = selection;
  if (!$from.parent.isTextblock || $from.parent !== $to.parent) return false;
  const selectedText = view.state.doc.textBetween(selection.from, selection.to, "\n", "\0");
  const before = selection.from > 0 ? view.state.doc.textBetween(selection.from - 1, selection.from, "", "\0") : "";
  const after = selection.to < view.state.doc.content.size ? view.state.doc.textBetween(selection.to, selection.to + 1, "", "\0") : "";
  const action = decidePairAction({ key: event.key, selectedText, before, after });
  if (!action) return false;

  event.preventDefault();
  if (action.type === "skip") {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.to + 1)));
    return true;
  }
  if (action.type === "delete") {
    const tr = view.state.tr.delete(selection.from - 1, selection.from + 1);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, selection.from - 1)));
    return true;
  }
  if (action.type === "wrap") {
    let tr = view.state.tr.insertText(action.close, selection.to).insertText(action.open, selection.from);
    tr = tr.setSelection(TextSelection.create(tr.doc, selection.from + 1, selection.to + 1));
    view.dispatch(tr);
    return true;
  }
  let tr = view.state.tr.insertText(`${action.open}${action.close}`, selection.from, selection.to);
  tr = tr.setSelection(TextSelection.create(tr.doc, selection.from + action.open.length));
  view.dispatch(tr);
  return true;
}

function handleWysiwygTab(view: any, event: KeyboardEvent) {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return false;
  const editorCommands = (editor.value as any)?.commands;
  const { $from } = view.state.selection;
  const nodeNames = Array.from({ length: $from.depth + 1 }, (_, depth) => $from.node(depth).type.name);

  if (nodeNames.includes("tableCell") || nodeNames.includes("tableHeader")) {
    event.preventDefault();
    const command = event.shiftKey ? editorCommands?.goToPreviousCell : editorCommands?.goToNextCell;
    if (typeof command === "function") command();
    return true;
  }
  if (nodeNames.includes("listItem")) {
    event.preventDefault();
    const command = event.shiftKey ? editorCommands?.liftListItem : editorCommands?.sinkListItem;
    if (typeof command === "function") command("listItem");
    return true;
  }
  if ($from.parent.type.name === "codeBlock") {
    event.preventDefault();
    indentWysiwygCodeSelection(view, event.shiftKey);
    return true;
  }
  return false;
}

function indentWysiwygCodeSelection(view: any, reverse: boolean) {
  const { selection } = view.state;
  const { $from, $to } = selection;
  if ($from.parent.type.name !== "codeBlock" || $from.parent !== $to.parent) return false;
  if (selection.empty) {
    if (!reverse) view.dispatch(view.state.tr.insertText("  ", selection.from));
    return true;
  }

  const blockStart = $from.start();
  const text = $from.parent.textContent;
  const edits = codeBlockIndentEdits(text, selection.from - blockStart, selection.to - blockStart, reverse);
  let tr = view.state.tr;
  for (const edit of edits.reverse()) {
    if (edit.insert) tr = tr.insertText(edit.insert, blockStart + edit.from, blockStart + edit.to);
    else tr = tr.delete(blockStart + edit.from, blockStart + edit.to);
  }
  if (tr.docChanged) view.dispatch(tr.scrollIntoView());
  return true;
}

function getSelectedCodeBlock(view: any) {
  const { selection } = view.state;
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "codeBlock") {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

function updateCodeLanguageControl(view = editor.value?.view) {
  if (!view || paneEditorMode.value !== "wysiwyg") {
    codeLanguageControl.value.visible = false;
    return;
  }
  const active = getSelectedCodeBlock(view);
  if (!active) {
    if (!codeLanguageControl.value.open) codeLanguageControl.value.visible = false;
    return;
  }
  const dom = view.nodeDOM(active.pos);
  const element =
    dom instanceof HTMLElement
      ? dom
      : dom instanceof Text
        ? dom.parentElement
        : null;
  if (!element) {
    codeLanguageControl.value.visible = false;
    return;
  }
  const rect = element.getBoundingClientRect();
  const controlWidth = 96;
  codeLanguageControl.value = {
    ...codeLanguageControl.value,
    visible: true,
    x: Math.max(12, Math.min(rect.right - controlWidth, window.innerWidth - controlWidth - 12)),
    y: Math.max(8, rect.top - 28),
    pos: active.pos,
    language: displayCodeLanguage(active.node.attrs.language || ""),
  };
}

function openFloatingCodeLanguageMenu({ select = false } = {}) {
  updateCodeLanguageControl();
  codeLanguageControl.value.open = true;
  codeLanguageControl.value.query = codeLanguageControl.value.language;
  codeLanguageControl.value.highlightedIndex = 0;
  window.setTimeout(() => {
    codeLanguageInput.value?.focus();
    if (select) codeLanguageInput.value?.select();
  });
}

function closeFloatingCodeLanguageMenu({ focusEditor = true } = {}) {
  codeLanguageControl.value.open = false;
  codeLanguageControl.value.query = "";
  codeLanguageControl.value.highlightedIndex = 0;
  if (focusEditor) editor.value?.commands.focus();
  updateCodeLanguageControl();
}

function applyFloatingCodeLanguage(value: string) {
  const activeEditor = editor.value as any;
  const view = activeEditor?.view;
  if (!view) return;
  const pos = codeLanguageControl.value.pos;
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "codeBlock") return;
  const typed = value.trim().toLowerCase();
  const language = normalizeCodeLanguage(typed) || typed;
  const attrs = { ...node.attrs, language: language || null };
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, attrs).scrollIntoView());
  codeLanguageControl.value.language = language;
  closeFloatingCodeLanguageMenu();
}

function chooseFloatingCodeLanguage() {
  const query = codeLanguageControl.value.query;
  if (!query.trim()) {
    applyFloatingCodeLanguage("");
    return;
  }
  const candidates = floatingCodeLanguageCandidates.value;
  applyFloatingCodeLanguage(candidates[codeLanguageControl.value.highlightedIndex] || query);
}

function handleFloatingCodeLanguageInput(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  codeLanguageControl.value.open = true;
  codeLanguageControl.value.query = target.value;
  codeLanguageControl.value.highlightedIndex = 0;
}

function commitFloatingCodeLanguageInput() {
  const query = codeLanguageControl.value.open ? codeLanguageControl.value.query : codeLanguageControl.value.language;
  applyFloatingCodeLanguage(query);
}

function handleFloatingCodeLanguageBlur() {
  window.setTimeout(() => {
    if (!codeLanguageControl.value.open) return;
    commitFloatingCodeLanguageInput();
  }, 120);
}

function handleFloatingCodeLanguageKeydown(event: KeyboardEvent) {
  const candidates = floatingCodeLanguageCandidates.value;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    codeLanguageControl.value.highlightedIndex = Math.min(
      codeLanguageControl.value.highlightedIndex + 1,
      Math.max(candidates.length - 1, 0),
    );
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    codeLanguageControl.value.highlightedIndex = Math.max(codeLanguageControl.value.highlightedIndex - 1, 0);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    chooseFloatingCodeLanguage();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    applyFloatingCodeLanguage(candidates[codeLanguageControl.value.highlightedIndex] || codeLanguageControl.value.query);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeFloatingCodeLanguageMenu();
  }
}

function handleEditorShellScroll() {
  if (codeLanguageControl.value.visible) updateCodeLanguageControl();
  if (tableControl.value.visible) updateTableControl();
  if (wikiCompletion.value.visible) updateWysiwygWikiCompletion();
  captureWysiwygPosition();
  if (Date.now() <= wysiwygManualScrollUntil) captureWysiwygScrollAnchor();
}

async function ensureSelectedCodeLanguage(view: EditorView) {
  const active = getSelectedCodeBlock(view);
  const language = String(active?.node.attrs.language || "");
  if (!active || !language) return;
  const loaded = await ensureLowlightLanguage(lowlight, language);
  if (!loaded || editor.value?.view !== view) return;
  refreshLowlightCodeBlock(view, active.pos, language);
}

async function ensureInitialCodeLanguages(view = editor.value?.view) {
  if (!view) return;
  const languages = new Set<string>();
  const positions = new Map<string, number>();
  view.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "codeBlock") return true;
    const language = String(node.attrs.language || "");
    if (language) {
      languages.add(language);
      if (!positions.has(language)) positions.set(language, pos);
    }
    return false;
  });
  const loaded = await Promise.all([...languages].map(async (language) => ({
    language,
    loaded: await ensureLowlightLanguage(lowlight, language),
  })));
  if (editor.value?.view !== view) return;
  const first = loaded.find((item) => item.loaded);
  if (first) refreshLowlightCodeBlock(view, positions.get(first.language) ?? 0, first.language);
}

function refreshLowlightCodeBlock(view: EditorView, position: number, language: string) {
  const node = view.state.doc.nodeAt(position);
  if (node?.type.name !== "codeBlock" || String(node.attrs.language || "") !== language) return;
  view.dispatch(
    view.state.tr
      .replaceWith(position, position + node.nodeSize, node)
      .setMeta("addToHistory", false)
      .setMeta("lightmarkLowlightRefresh", language),
  );
}

function markWysiwygManualScroll(duration = 500) {
  wysiwygManualScrollUntil = Date.now() + duration;
}

function handleWysiwygScrollPointer(event: PointerEvent) {
  const shell = editorShell.value;
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  if (event.clientX >= rect.right - 18) markWysiwygManualScroll(1500);
}

function handleWysiwygScrollKey(event: KeyboardEvent) {
  if (["PageDown", "PageUp", "Home", "End"].includes(event.key)) markWysiwygManualScroll();
}

function captureWysiwygSelectionAnchor(view = editor.value?.view) {
  if (!view || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const derived = getWysiwygDerivedState(view.state);
  const selectionHead = view.state.selection.head;
  const active = derived.headingBefore(selectionHead);
  if (!active) {
    updatePaneOutlineAnchor(props.paneId, 0, 'selection');
    return;
  }
  const activeIndex = active.index;
  const tab = getPaneTab(props.paneId);
  const projected = tab ? appStore.runtimeDerivedByTab[tab.id]?.outline : undefined;
  updatePaneOutlineAnchor(
    props.paneId,
    projected?.[activeIndex]?.line ?? active.heading.blockIndex,
    "selection",
  );
}

function captureWysiwygScrollAnchor() {
  const shell = editorShell.value;
  if (!shell) return;
  const anchorY = shell.getBoundingClientRect().top + Math.min(96, shell.clientHeight * 0.2);
  let activeLine = 0;
  const headings = Array.from(
    shell.querySelectorAll<HTMLElement>(".ProseMirror h1[data-outline-line],.ProseMirror h2[data-outline-line],.ProseMirror h3[data-outline-line],.ProseMirror h4[data-outline-line],.ProseMirror h5[data-outline-line],.ProseMirror h6[data-outline-line]"),
  );
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top > anchorY) break;
    const line = Number.parseInt(heading.dataset.outlineLine || "", 10);
    if (Number.isFinite(line)) activeLine = line;
  }
  updatePaneOutlineAnchor(props.paneId, activeLine, "scroll");
}

function markdownLineAtOffset(markdown: string, offset: number) {
  let line = 0;
  for (let index = 0; index < Math.min(Math.max(0, offset), markdown.length); index += 1) {
    if (markdown.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function getSelectedTableInfo(view = editor.value?.view, explicitTable?: HTMLTableElement | null, explicitCell?: HTMLTableCellElement | null) {
  if (!view || paneEditorMode.value !== "wysiwyg") return null;
  const table = explicitTable || getCurrentTableElement();
  if (!table) return null;
  const resolved = resolveTableNodeFromDom(view, table, explicitCell);
  if (!resolved) return null;
  const { pos, node } = resolved;
  const rows = table.rows.length;
  const columns = rows ? Math.max(...Array.from(table.rows).map((row) => row.cells.length)) : 0;
  return { table, pos, node, rows, columns };
}

function updateTableControl(view = editor.value?.view, explicitTable?: HTMLTableElement | null, explicitCell?: HTMLTableCellElement | null) {
  const active = getSelectedTableInfo(view, explicitTable, explicitCell);
  if (!active) {
    if (!tableControl.value.resizeOpen && !tableControl.value.moreOpen) tableControl.value.visible = false;
    return;
  }
  const rect = active.table.getBoundingClientRect();
  const shellTop = editorShell.value?.getBoundingClientRect().top ?? 0;
  const width = 160;
  const nextRows = active.rows;
  const nextColumns = active.columns;
  const activeColumn = explicitCell?.cellIndex ?? getCurrentTableCell()?.cellIndex ?? tableControl.value.activeColumn;
  tableControl.value = {
    ...tableControl.value,
    visible: true,
    x: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
    y: Math.max(shellTop + 8, rect.top - 36),
    tablePos: active.pos,
    activeColumn,
    rows: nextRows,
    columns: nextColumns,
    resizeText: tableControl.value.resizeOpen ? tableControl.value.resizeText : `${nextRows} x ${nextColumns}`,
  };
}

function resolveTableNodeFromDom(view: any, table: HTMLTableElement, cell?: HTMLTableCellElement | null) {
  const candidates: number[] = [];
  const pushDomPos = (element: HTMLElement | null) => {
    if (!element) return;
    try {
      candidates.push(view.posAtDOM(element, 0));
    } catch {
      // Ignore DOM positions ProseMirror cannot map directly.
    }
  };

  pushDomPos(cell || null);
  pushDomPos(table);
  pushDomPos(table.parentElement);
  if (tableControl.value.tablePos >= 0) candidates.push(tableControl.value.tablePos);

  for (const pos of candidates) {
    const resolved = resolveTableNodeAtDocPos(view.state.doc, pos);
    if (resolved) return resolved;
  }

  return null;
}

function resolveTableNodeAtDocPos(doc: any, pos: number) {
  const max = doc.content.size;
  const candidates = Array.from(new Set([pos, pos - 1, pos + 1]))
    .filter((candidate) => Number.isInteger(candidate) && candidate >= 0 && candidate <= max);

  for (const candidate of candidates) {
    const direct = doc.nodeAt(candidate);
    if (direct?.type?.name === "table") return { pos: candidate, node: direct };

    try {
      const $pos = doc.resolve(candidate);
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        if (node?.type?.name === "table") {
          return { pos: $pos.before(depth), node };
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function openTableResizePanel() {
  updateTableControl();
  tableControl.value.resizeOpen = !tableControl.value.resizeOpen;
  tableControl.value.moreOpen = false;
  tableControl.value.resizeText = `${tableControl.value.rows} x ${tableControl.value.columns}`;
  tableControl.value.resizeError = "";
}

function toggleTableMoreMenu() {
  updateTableControl();
  tableControl.value.moreOpen = !tableControl.value.moreOpen;
  tableControl.value.resizeOpen = false;
}

function closeTablePopovers() {
  tableControl.value.resizeOpen = false;
  tableControl.value.moreOpen = false;
  tableControl.value.resizeError = "";
}

function parseTableSizeInput(value: string) {
  const match = value.trim().match(/^(\d{1,2})\s*(?:x|\*|×)\s*(\d{1,2})$/i);
  if (!match) return null;
  const rows = Number(match[1]);
  const columns = Number(match[2]);
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) return null;
  return { rows, columns };
}

function setTableResizeDelta(kind: "rows" | "columns", delta: 1 | -1) {
  const size = parseTableSizeInput(tableControl.value.resizeText) || {
    rows: tableControl.value.rows || 1,
    columns: tableControl.value.columns || 1,
  };
  const next = {
    rows: kind === "rows" ? Math.max(1, size.rows + delta) : size.rows,
    columns: kind === "columns" ? Math.max(1, size.columns + delta) : size.columns,
  };
  tableControl.value.resizeText = `${next.rows} x ${next.columns}`;
  tableControl.value.rows = next.rows;
  tableControl.value.columns = next.columns;
  tableControl.value.resizeError = "";
}

function handleTableResizeTextInput(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  tableControl.value.resizeText = target.value;
  const size = parseTableSizeInput(target.value);
  if (size) {
    tableControl.value.rows = size.rows;
    tableControl.value.columns = size.columns;
  }
  tableControl.value.resizeError = "";
}

function applyTableResizeFromInput() {
  const size = parseTableSizeInput(tableControl.value.resizeText);
  if (!size) {
    tableControl.value.resizeError = "请输入类似 4 x 6 的行列数。";
    return;
  }
  applyTableSize(size.rows, size.columns);
}

function applyTableSize(targetRows: number, targetColumns: number) {
  const info = getSelectedTableInfo();
  if (!info) return;
  if (tableResizeWouldDropContent(info.table, targetRows, targetColumns)) {
    tableControl.value.resizeError = "缩小会删除非空单元格，已阻止。";
    return;
  }
  const nextTable = resizedTableElement(info.table, targetRows, targetColumns);
  replaceCurrentTableFromDom(nextTable);
  tableControl.value.resizeOpen = false;
  tableControl.value.resizeError = "";
  window.setTimeout(() => updateTableControl(), 0);
}

function applyTableAlignment(align: "left" | "center" | "right") {
  const info = getSelectedTableInfo();
  if (!info) return;
  const allColumns = isWholeTableSelected(info);
  const activeCell = getCurrentTableCell();
  const targetColumn = activeCell?.cellIndex ?? tableControl.value.activeColumn;
  if (!allColumns && targetColumn < 0) return;

  const activeEditor = editor.value;
  if (!activeEditor) return;
  let tr = activeEditor.state.tr;
  tableCellPositions(info.pos, info.node).forEach(({ pos, columnIndex, node }) => {
    if (!allColumns && columnIndex !== targetColumn) return;
    // Tiptap's table extension also owns `align`. Keep its semantic value
    // consistent with our UI attribute so parsing the saved divider is exact.
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, align, textAlign: align }, node.marks);
  });
  if (tr.docChanged) activeEditor.view.dispatch(tr.scrollIntoView());
  window.setTimeout(() => updateTableControl(), 0);
}

function tableCellPositions(tablePos: number, tableNode: any) {
  const cells: Array<{ pos: number; rowIndex: number; columnIndex: number; node: any }> = [];
  let rowPos = tablePos + 1;
  for (let rowIndex = 0; rowIndex < tableNode.childCount; rowIndex += 1) {
    const row = tableNode.child(rowIndex);
    let cellPos = rowPos + 1;
    for (let columnIndex = 0; columnIndex < row.childCount; columnIndex += 1) {
      const cell = row.child(columnIndex);
      if (cell?.type?.name === "tableCell" || cell?.type?.name === "tableHeader") {
        cells.push({ pos: cellPos, rowIndex, columnIndex, node: cell });
      }
      cellPos += cell.nodeSize;
    }
    rowPos += row.nodeSize;
  }
  return cells;
}

function isWholeTableSelected(info: { pos: number; node: any }) {
  const activeEditor = editor.value;
  if (!activeEditor) return false;
  const selection = activeEditor.state.selection;
  if (selection instanceof AllSelection) return true;
  if (selection instanceof NodeSelection && selection.from === info.pos && selection.node.type.name === "table") return true;
  return !selection.empty && selection.from <= info.pos && selection.to >= info.pos + info.node.nodeSize;
}

async function insertImagesAtBookmark(from: number, to: number, produce: (target: ImageAssetTarget) => Promise<string>) {
  const ownerEditor = editor.value;
  const owner = editorOwnerTab;
  if (!ownerEditor || !owner) return;
  const command = beginPendingImageCommand(owner.id, from, to);
  const target: ImageAssetTarget = { markdownPath: owner.path, documentMode: 'normal', settings: Object.freeze({ ...appStore.settings.image }) };
  try {
    const markdown = await produce(target);
    if (!markdown) return;
    await completePendingImageCommand(command, markdown, target);
  } catch (error) { appStore.statusMessage = String(error); }
  finally { releasePendingCommand(command); }
}

async function insertImageFilesIntoWysiwyg(files: File[], from: number, to: number, source: 'clipboard' | 'drop' = 'drop') {
  await insertImagesAtBookmark(from, to, target => saveImagesAsMarkdown(files, { source, target }));
}
async function insertImagePathsIntoWysiwyg(paths: string[], from: number, to: number) {
  await insertImagesAtBookmark(from, to, target => imagePathsAsMarkdown(paths, target));
}

function parseMarkdownImageSnippets(markdown: string) {
  const images: Array<{ src: string; markdownSrc: string; alt: string; title: string | null }> = [];
  const pattern = /!\[([^\]\n]*)\]\((\S+?)(?:\s+"([^"\n]*)")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown))) {
    const image = parseSingleMarkdownImage(match[0]);
    if (image) images.push(image);
  }
  return images;
}

function parseSingleMarkdownImage(markdown: string) {
  const match = markdown.match(/^!\[([^\]\n]*)\]\((\S+?)(?:\s+"([^"\n]*)")?\)$/);
  if (!match) return null;
  const markdownSrc = match[2]?.trim();
  if (!markdownSrc) return null;
  return {
    src: resolveMarkdownImageSource(markdownSrc),
    markdownSrc,
    alt: match[1].replace(/\\]/g, "]"),
    title: match[3] || null,
  };
}

watch(
  () => paneTab.value?.id || "",
  () => {
    if (!isCurrentOwnerTab()) return;
    closeWysiwygWikiCompletion();
    editor.value?.commands.setContent(renderMarkdownForEditorWithAssets(paneContent.value), { emitUpdate: false });
    registerWysiwygDocumentSession();
    void ensureInitialCodeLanguages();
    schedulePendingWysiwygPositionRestore();
  },
);

watch(
  () => paneEditorMode.value,
  () => {
    if (!isCurrentOwnerTab()) return;
    closeWysiwygWikiCompletion();
    if (paneEditorMode.value === "wysiwyg") {
      editor.value?.commands.setContent(renderMarkdownForEditorWithAssets(paneContent.value), { emitUpdate: false });
      void ensureInitialCodeLanguages();
      schedulePendingWysiwygCursorRestore();
      schedulePendingWysiwygPositionRestore();
    }
  },
);

watch(
  () => editor.value,
  () => {
    registerWysiwygDocumentSession();
    schedulePendingWysiwygCursorRestore();
    schedulePendingWysiwygPositionRestore();
  },
);

onMounted(() => {
  document.addEventListener("compositionstart", trackCompositionStart, true);
  document.addEventListener("compositionend", trackCompositionEnd, true);
  schedulePendingWysiwygCursorRestore();
  schedulePendingWysiwygPositionRestore();
  document.addEventListener("pointerdown", handleDocumentTablePointerDown, true);
  window.addEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.addEventListener("lightmark:restore-position", handleRestorePosition as EventListener);
  window.addEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.addEventListener("lightmark:capture-editor-target", captureWysiwygEditorTarget as EventListener);
  window.addEventListener("lightmark:insert-snippet", insertSnippetIntoWysiwyg as EventListener);
  window.addEventListener("lightmark:editor-command", handleToolbarEditorCommand as EventListener);
  window.addEventListener("lightmark:find-command", handleFindCommand as EventListener);
  window.addEventListener("lightmark:jump-heading", handleJumpHeading as EventListener);
  window.addEventListener("lightmark:jump-math", handleJumpMath as EventListener);
  window.addEventListener("lightmark:jump-knowledge-occurrence", handleKnowledgeOccurrence as EventListener);
  window.addEventListener("lightmark:apply-markdown-format", handleApplyMarkdownFormat as EventListener);
  window.addEventListener("lightmark:close-transient-editor-ui", closeWysiwygWikiCompletion);
  window.addEventListener("lightmark:close-transient-editor-ui", closeSlashMenu);
  window.addEventListener("lightmark:writing-modes-changed", handleWysiwygWritingModesChanged);
  window.addEventListener("lightmark:heading-folds-changed", handleWysiwygHeadingFoldsChanged as EventListener);
  window.addEventListener("resize", handleEditorShellScroll);
  window.addEventListener("keydown", handlePendingControlHistory, true);
  window.addEventListener("keydown", handleWysiwygPlainPasteCapture, true);
  syncWysiwygWritingModes();
  void ensureInitialCodeLanguages();
  requestAnimationFrame(() => recordStartupStage("wysiwyg"));
});

onBeforeUnmount(() => {
  primeExactWysiwygMarkdown = null;
  if (sourceProvenanceTimer != null) window.clearTimeout(sourceProvenanceTimer);
  sourceProvenanceTimer = null;
  sourceProvenancePending.clear();
  sourceProvenanceDoc = null;
  document.removeEventListener("compositionstart", trackCompositionStart, true);
  document.removeEventListener("compositionend", trackCompositionEnd, true);
  composingControls.clear();
  unsubscribePendingEditorInput();
  documentMutationTracker = null;
  observedPendingMathInputVersion = 0;
  observedPendingLocalInputVersion = 0;
  unregisterDocumentSession();
  snapshotCache = null;
  document.removeEventListener("pointerdown", handleDocumentTablePointerDown, true);
  window.removeEventListener("lightmark:capture-mode-cursor", handleModeCursorCapture as EventListener);
  window.removeEventListener("lightmark:restore-position", handleRestorePosition as EventListener);
  window.removeEventListener("lightmark:insert-images", handleGlobalImageInsert as EventListener);
  window.removeEventListener("lightmark:capture-editor-target", captureWysiwygEditorTarget as EventListener);
  window.removeEventListener("lightmark:insert-snippet", insertSnippetIntoWysiwyg as EventListener);
  window.removeEventListener("lightmark:editor-command", handleToolbarEditorCommand as EventListener);
  window.removeEventListener("lightmark:find-command", handleFindCommand as EventListener);
  window.removeEventListener("lightmark:jump-heading", handleJumpHeading as EventListener);
  window.removeEventListener("lightmark:jump-math", handleJumpMath as EventListener);
  window.removeEventListener("lightmark:jump-knowledge-occurrence", handleKnowledgeOccurrence as EventListener);
  window.removeEventListener("lightmark:apply-markdown-format", handleApplyMarkdownFormat as EventListener);
  window.removeEventListener("lightmark:close-transient-editor-ui", closeWysiwygWikiCompletion);
  window.removeEventListener("lightmark:close-transient-editor-ui", closeSlashMenu);
  window.removeEventListener("lightmark:writing-modes-changed", handleWysiwygWritingModesChanged);
  window.removeEventListener("lightmark:heading-folds-changed", handleWysiwygHeadingFoldsChanged as EventListener);
  window.removeEventListener("resize", handleEditorShellScroll);
  window.removeEventListener("keydown", handlePendingControlHistory, true);
  window.removeEventListener("keydown", handleWysiwygPlainPasteCapture, true);
  window.cancelAnimationFrame(wysiwygTypewriterFrame);
  if (pendingWysiwygRestoreTimer !== null) window.clearTimeout(pendingWysiwygRestoreTimer);
  editor.value?.destroy();
});

function registerWysiwygDocumentSession() {
  const activeEditor = editor.value;
  const tab = getPaneTab(props.paneId);
  if (!activeEditor || !tab || !isCurrentOwnerTab()) return;
  unregisterDocumentSession();
  const ownerTab = toRaw(tab);
  const tabId = ownerTab.id;
  unsubscribePendingEditorInput();
  unsubscribePendingEditorInput = subscribePendingEditorInput(activeEditor, () => {
    if (editor.value === activeEditor && ownerTabStillExists()) {
      documentMutationTracker?.recordPendingInput();
      markDocumentChanged(ownerTab.id, wysiwygRevision);
    }
  });
  const documentHistory = documentHistoryForTab(tabId);
  const initialHistoryState = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
  historySourceBaseline = captureWysiwygSourceBaseline(ownerTab.content, initialHistoryState.doc);
  historyBookmark = initialHistoryState.bookmark;
  documentHistory.mount({ mode: 'wysiwyg', doc: initialHistoryState.doc, baseline: historySourceBaseline }, historyBookmark, ownerTab.content, !ownerTab.isDirty);
  const capturePreservationBaseline = (markdown: string) => {
    const nodes: object[] = [];
    activeEditor.state.doc.forEach((node: object) => nodes.push(node));
    const source = markdownTopLevelSourceBlocks(markdown);
    const alignment = sourceBlocksForNodes(source.blocks, nodes as Array<{ type: { name: string }; content: { size: number } }>, source.prefix);
    if (alignment) {
      nodes.forEach((node, index) => checkpointSourceTransactionNode(node as ReturnType<typeof canonicalMarkdownHistoryState>['doc'], alignment.blocks[index].source));
      sourceProvenanceDoc = activeEditor.state.doc;
    }
    return alignment
      ? {
        nodes,
        blocks: alignment.blocks,
        preservedMarkdownByNode: new WeakMap<object, string>(nodes.flatMap((node, index): Array<[object, string]> => alignment.blocks[index].generated ? [] : [[node, alignment.blocks[index].source.replace(/^[\r\n]+|[\r\n]+$/g, '')]])),
        syntheticTailOmitted: alignment.syntheticTailOmitted,
        prefix: alignment.prefix,
        lineEnding: inspectSourceEnvelope(markdown).lineEnding,
      }
      : null;
  };
  let preservationBaseline = capturePreservationBaseline(ownerTab.content);
  let recoverySourceBaseline: RecoverySourceBaseline | null = null;
  let recoveryPendingMathRetention: RecoveryPendingMath = { version: 0, entries: [] };
  snapshotCache = new WysiwygSnapshotCache({
    tabId: () => ownerTab.id,
    revision: () => wysiwygRevision,
    dirty: () => ownerTab.isDirty,
    preservedBlockMarkdown: (block) => preservationBaseline?.preservedMarkdownByNode.get(block),
    previousMarkdown: () => ownerTab.content,
    blocks: () => {
      const blocks: object[] = [];
      activeEditor.state.doc.forEach((node: object) => blocks.push(node));
      return blocks;
    },
    serializeBlock: (block) => {
      const container = document.createElement("div");
      container.appendChild(DOMSerializer.fromSchema(activeEditor.state.schema).serializeNode(block as any));
      return container.innerHTML;
    },
    convertBlock: (html) => editorHtmlToMarkdown(html).replace(/^\n+|\n+$/g, ""),
    combineBlocks: (blocks, previousMarkdown, sourceBlocks) => {
      if (preservationBaseline) return combinePreservedSourceBlocks(
        preservationBaseline.nodes,
        preservationBaseline.blocks,
        sourceBlocks,
        blocks,
        preservationBaseline.prefix,
        preservationBaseline.lineEnding,
        preservationBaseline.syntheticTailOmitted,
        preserveFineSourceBlock,
      );
      if (previousMarkdown.length > 0) {
        throw new Error("无法建立 Markdown 源码映射，已阻止静默覆盖。请切换到源码模式恢复或另存为副本。");
      }
      return preserveMarkdownTerminalNewlines(blocks
        .map((block, index) => {
          const nodeType = (sourceBlocks[index] as { type?: { name?: string } })?.type?.name;
          const listNeedsFollowingBlockPadding = index < blocks.length - 1
            && (nodeType === "bulletList" || nodeType === "orderedList");
          if (listNeedsFollowingBlockPadding) return `${block}\n    `;
          if (index > 0 && nodeType === "footnotes") return `\n\n${block}`;
          return block;
        })
        .filter((block) => block.length > 0)
        .join("\n\n"),
        previousMarkdown,
      );
    },
    oracle: (previousMarkdown) => {
      return preserveMarkdownTerminalNewlines(editorHtmlToMarkdown(activeEditor.getHTML()), previousMarkdown);
    },
    verifyIncremental: () => window.localStorage.getItem("lightmark:verify-wysiwyg-snapshot") === "1",
    trustIncremental: () => Boolean(preservationBaseline),
  });
  const commitExactSourceCheckpoint = (markdown: string) => {
    if (editor.value !== activeEditor || !ownerTabStillExists()) throw new Error('精确源码提交的原文档已关闭。');
    preservationBaseline = capturePreservationBaseline(markdown);
    const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
    historySourceBaseline = captureWysiwygSourceBaseline(markdown, canonical.doc);
    documentHistory.checkpoint(markdown);
    documentHistory.project({ mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline }, canonical.bookmark);
    snapshotCache!.prime(markdown, wysiwygRevision, ownerTab.id);
  };
  primeExactWysiwygMarkdown = commitExactSourceCheckpoint;
  const sessionAdapter: WysiwygDocumentSessionAdapter = {
    tabId,
    paneId: props.paneId,
    mode: "wysiwyg",
    editorIdentity: activeEditor,
    captureHistoryRoot() {
      const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
      return { mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline! };
    },
    captureHistoryBookmark() { return canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state)).bookmark; },
    async restoreSourceBookmark(markdown, rawBookmark) {
      const restoreEpoch = ++wysiwygSelectionRestoreEpoch;
      const before = activeEditor.state, revision = wysiwygRevision;
      const original = canonicalMarkdownHistoryState(before, exposedMarkdownLifecycleKey.getState(before));
      const bookmark = await historyPmBookmark(original.doc, markdown, rawBookmark);
      if (restoreEpoch !== wysiwygSelectionRestoreEpoch || editor.value !== activeEditor || !isCurrentOwnerTab() || wysiwygRevision !== revision) return;
      const current = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
      // Mount-time syntax revelation changes the live model without changing
      // content or the user's canonical selection. Restore through its inverse
      // mapping, rather than abandoning the requested caret at the default H1.
      if (!current.doc.eq(original.doc) || current.bookmark.anchor !== original.bookmark.anchor || current.bookmark.head !== original.bookmark.head) return;
      const intoLive = current.mapping.invert();
      const anchor = intoLive.map(bookmark.anchor, 1), head = intoLive.map(bookmark.head, 1);
      const transaction = activeEditor.state.tr.setSelection(TextSelection.between(activeEditor.state.doc.resolve(anchor), activeEditor.state.doc.resolve(head)))
        .setMeta(markdownPresentationMeta, true).setMeta('addToHistory', false);
      activeEditor.view.dispatch(transaction);
      const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
      historyBookmark = canonical.bookmark;
      documentHistory.project({ mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline! }, canonical.bookmark);
      const pending = getPanePendingModeCursor(props.paneId);
      if (pending?.targetMode === 'wysiwyg') setPanePendingModeCursor(props.paneId, null);
      activeEditor.view.focus();
    },
    async prepareHistoryReplay(projection, exactSource, dirty) {
      const markdown = await materializeHistoryRoot(projection.root, exactSource);
      let nextDoc;
      let bookmark;
      if (projection.root.mode === 'wysiwyg') {
        nextDoc = historyPmDocumentForSchema(projection.root.doc, activeEditor.state.schema);
        bookmark = projection.bookmark;
      } else {
        const container = document.createElement('div');
        container.innerHTML = renderMarkdownForEditorWithAssets(markdown);
        nextDoc = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parse(container);
        bookmark = await historyPmBookmark(nextDoc, markdown, await historySourceBookmark(projection, markdown));
      }
      let transaction = activeEditor.state.tr.replaceWith(0, activeEditor.state.doc.content.size, nextDoc.content)
        .setMeta(clearExposeMarkdownMeta, true).setMeta('addToHistory', false);
      transaction = transaction.setSelection(TextSelection.between(transaction.doc.resolve(Math.min(transaction.doc.content.size, bookmark.anchor)), transaction.doc.resolve(Math.min(transaction.doc.content.size, bookmark.head)))).scrollIntoView();
      return () => {
        suppressWysiwygUpdate = true;
        try { activeEditor.view.dispatch(transaction); }
        finally { suppressWysiwygUpdate = false; }
        historySourceBaseline = captureWysiwygSourceBaseline(markdown, activeEditor.state.doc);
        preservationBaseline = capturePreservationBaseline(markdown);
        historyBookmark = { anchor: activeEditor.state.selection.anchor, head: activeEditor.state.selection.head };
        wysiwygRevision = advanceDocumentRevision(ownerTab.id, wysiwygRevision);
        documentMutationTracker?.setRevision(wysiwygRevision);
        snapshotCache?.invalidate();
        setPaneContent(props.paneId, markdown, dirty, false);
        publishDocumentDerivedState(ownerTab.id, { revision: wysiwygRevision, ...getWysiwygDerivedState(activeEditor.state) });
        activeEditor.view.focus();
      };
    },
    get revision() {
      return wysiwygRevision;
    },
    isComposing() { return activeEditor.view.composing || composingControls.size > 0; },
    hasPendingEdits() {
      const currentEditor = editor.value;
      return currentEditor === activeEditor && ownerTabStillExists()
        ? (syncTrackedPendingMathInput(currentEditor), syncTrackedPendingLocalInput(currentEditor), hasPendingMathEdits(currentEditor) || hasPendingLocalEdits(currentEditor) || hasPendingEditorBuffers(currentEditor))
        : false;
    },
    pendingEditVersion() {
      const currentEditor = editor.value;
      return currentEditor === activeEditor && ownerTabStillExists()
        ? getCombinedPendingEditVersion(currentEditor) + pendingEditorInputVersion(currentEditor)
        : 0;
    },
    mutationToken() {
      const currentEditor = editor.value;
      if (currentEditor !== activeEditor || !ownerTabStillExists()) {
        throw new Error("所见即所得编辑器会话已被替换。");
      }
      syncTrackedPendingMathInput(currentEditor);
      syncTrackedPendingLocalInput(currentEditor);
      if (!documentMutationTracker) throw new Error("所见即所得文档变更跟踪器已经关闭。");
      return documentMutationTracker.token();
    },
    async flushPendingEdits(_reason: SnapshotReason, options?: PendingFlushOptions) {
      const currentEditor = editor.value;
      if (!currentEditor || currentEditor !== activeEditor || !ownerTabStillExists()) {
        throw new Error("所见即所得编辑器会话已被替换。");
      }
      const tracker = documentMutationTracker;
      if (!tracker) throw new Error("所见即所得文档变更跟踪器已经关闭。");
      syncTrackedPendingMathInput(currentEditor);
      syncTrackedPendingLocalInput(currentEditor);
      const expectedToken = options?.expectedToken ?? tracker.token();
      if (!documentMutationTokensEqual(tracker.token(), expectedToken)) {
        throw new Error("公式或文档版本在 flush 开始前已变化。");
      }
      const flush = tracker.beginFlush(expectedToken);
      try {
        await finalizeMarkdownExposure(currentEditor.view, flush.id);
      } catch (error) {
        flush.fail();
        throw error;
      }
      if (editor.value !== currentEditor || documentMutationTracker !== tracker || !ownerTabStillExists()) {
        flush.fail();
        throw new Error("所见即所得编辑器会话已被替换。");
      }
      syncTrackedPendingMathInput(currentEditor);
      syncTrackedPendingLocalInput(currentEditor);
      try {
        const request: PendingMathFlushRequest = { flushId: flush.id };
        await flushPendingMathEdits(currentEditor, request);
        if (editor.value !== currentEditor || documentMutationTracker !== tracker || !ownerTabStillExists()) {
          flush.fail();
          throw new Error("所见即所得编辑器会话已被替换。");
        }
        syncTrackedPendingMathInput(currentEditor);
        syncTrackedPendingLocalInput(currentEditor);
        await flushPendingLocalEditors(currentEditor, request);
        await flushPendingEditorBuffers(currentEditor, request);
        if (editor.value !== currentEditor || documentMutationTracker !== tracker || !ownerTabStillExists()) {
          flush.fail();
          throw new Error("所见即所得编辑器会话已被替换。");
        }
        syncTrackedPendingMathInput(currentEditor);
        syncTrackedPendingLocalInput(currentEditor);
        return flush.complete(tracker.token());
      } catch (error) {
        flush.fail();
        throw error;
      }
    },
    async finalizeClosePrompt(options?: PendingFlushOptions) {
      const currentEditor = editor.value;
      if (!currentEditor || currentEditor !== activeEditor || !ownerTabStillExists()) {
        throw new Error("所见即所得编辑器会话已被替换。");
      }
      const tracker = documentMutationTracker;
      if (!tracker) throw new Error("所见即所得文档变更跟踪器已经关闭。");
      if (currentEditor.view.composing) {
        throw new Error("输入法组合尚未结束，已保留当前窗口。");
      }
      syncTrackedPendingMathInput(currentEditor);
      syncTrackedPendingLocalInput(currentEditor);
      const expectedToken = options?.expectedToken ?? tracker.token();
      if (!documentMutationTokensEqual(tracker.token(), expectedToken)) {
        throw new Error("公式或文档版本在关闭提示准备开始前已变化。");
      }
      const flush = tracker.beginFlush(expectedToken);
      try {
        const request: PendingMathFlushRequest = { flushId: flush.id };
        await finalizeMarkdownExposure(currentEditor.view, flush.id);
        if (editor.value !== currentEditor || documentMutationTracker !== tracker || !ownerTabStillExists()) {
          flush.fail();
          throw new Error("所见即所得编辑器会话已被替换。");
        }
        syncTrackedPendingMathInput(currentEditor);
        await finalizePendingMathForClosePrompt(currentEditor, request);
        if (editor.value !== currentEditor || documentMutationTracker !== tracker || !ownerTabStillExists()) {
          flush.fail();
          throw new Error("所见即所得编辑器会话已被替换。");
        }
        syncTrackedPendingMathInput(currentEditor);
        syncTrackedPendingLocalInput(currentEditor);
        await flushPendingLocalEditors(currentEditor, request);
        await flushPendingEditorBuffers(currentEditor, request);
        if (editor.value !== currentEditor || documentMutationTracker !== tracker || !ownerTabStillExists()) {
          flush.fail();
          throw new Error("所见即所得编辑器会话已被替换。");
        }
        syncTrackedPendingMathInput(currentEditor);
        syncTrackedPendingLocalInput(currentEditor);
        if (hasPendingMathEdits(currentEditor) || hasPendingLocalEdits(currentEditor) || hasPendingEditorBuffers(currentEditor)) {
          flush.fail();
          throw new Error("局部编辑界面尚未安全收束，已保留当前窗口。");
        }
        return flush.complete(tracker.token());
      } catch (error) {
        flush.fail();
        throw error;
      }
    },
    async captureRecoveryBundle() {
      const currentEditor = editor.value;
      if (!currentEditor || currentEditor !== activeEditor || !isCurrentOwnerTab()) {
        throw new Error("所见即所得编辑器会话已被替换，无法捕获恢复文件。");
      }
      const beforeState = currentEditor.view.state;
      const beforeDoc = beforeState.doc;
      const sourceText = ownerTab.content;
      const sourceBytes = new TextEncoder().encode(sourceText);
      const tokenBefore = documentMutationTracker?.token() ?? null;
      const localSnapshot = captureRecoveryLocalBuffersForOwner(currentEditor);
      if (!localSnapshot.complete) {
        const details = localSnapshot.failures.map((failure) => `${failure.kind}/${failure.id}: ${failure.message}`).join("; ");
        recoveryRestoreNotice.value = `恢复捕获不完整，已保留当前编辑会话。${details ? ` ${details}` : ""}`;
        throw new Error(recoveryRestoreNotice.value);
      }
      const countMismatches = recoveryCountsMismatch(beforeDoc, localSnapshot.buffers);
      if (countMismatches.length) {
        recoveryRestoreNotice.value = `恢复捕获不完整，特殊节点尚未全部绑定：${countMismatches.join("；")}`;
        throw new Error(recoveryRestoreNotice.value);
      }

      let pendingMath: RecoveryPendingMath;
      let capturedPendingMath: RecoveryPendingMath;
      try {
        capturedPendingMath = capturePendingMathRecovery(currentEditor);
        pendingMath = mergeRecoveryPendingMath(capturedPendingMath, recoveryPendingMathRetention);
      } catch (error) {
        recoveryRestoreNotice.value = "恢复捕获不完整，公式本地状态无法验证或存在冲突；已保留当前编辑会话。";
        throw error instanceof Error ? error : new Error(String(error));
      }
      const localComposing = localSnapshot.buffers.some((buffer) => {
        const payload = buffer.payload as { ui?: { composing?: boolean } } | null;
        return Boolean(buffer.ui?.composing || payload?.ui?.composing);
      });
      const exposedMarkdown = recoveryExposedMarkdownState(beforeState, wysiwygRevision);
      const scroll = normalizeScrollSnapshot(
        editorShell.value?.scrollTop ?? 0,
        editorShell.value?.scrollHeight ?? 0,
        editorShell.value?.clientHeight ?? 0,
      );
      const formatHistory = ownerTab.wysiwygFormatHistory ?? { undo: [], redo: [] };
      const localState: RecoveryLocalStateV3 = {
        schema: "lightmark.local-state",
        revision: wysiwygRevision,
        buffers: localSnapshot.buffers,
        exposedMarkdown,
        composition: {
          active: Boolean(currentEditor.view.composing || localComposing),
          source: currentEditor.view.composing ? "pm" : "node-view",
          revision: wysiwygRevision,
        },
        history: {
          sourceCheckpointId: `recovery-${wysiwygRevision}`,
          format: {
            undo: formatHistory.undo.map((entry) => ({ ...entry })),
            redo: formatHistory.redo.map((entry) => ({ ...entry })),
          },
          pm: {
            status: "unavailable",
            reason: "ProseMirror history adapter is unavailable in this recovery slice.",
          },
          source: {
            status: "unavailable",
            reason: "CodeMirror history adapter is unavailable in this recovery slice.",
          },
        },
      };
      const capture: RecoveryCaptureV3 = {
        sourceBytes,
        doc: beforeDoc,
        selection: beforeState.selection,
        scroll,
        pendingMath,
        origin: {
          path: ownerTab.path || null,
          kind: ownerTab.kind,
        },
        localState,
      };
      const isStable = () => {
        if (editor.value !== currentEditor || !isCurrentOwnerTab() || !ownerTabStillExists()) return false;
        if (currentEditor.view.state !== beforeState || currentEditor.view.state.doc !== beforeDoc) return false;
        if (ownerTab.content !== sourceText) return false;
        if (!documentMutationTracker || !tokenBefore) return true;
        return documentMutationTokensEqual(documentMutationTracker.token(), tokenBefore);
      };
      if (!isStable()) {
        recoveryRestoreNotice.value = "恢复捕获期间编辑会话发生变化，已保留当前编辑会话。";
        throw new Error(recoveryRestoreNotice.value);
      }
      let serialized: string;
      try {
        serialized = encodeRecoveryBundleV3(capture);
      } catch (error) {
        recoveryRestoreNotice.value = "恢复捕获不完整，恢复材料未生成；已保留当前编辑会话。";
        throw error;
      }
      if (!isStable()) {
        recoveryRestoreNotice.value = "恢复捕获期间编辑会话发生变化，已丢弃不一致恢复材料。";
        throw new Error(recoveryRestoreNotice.value);
      }
      recoveryPendingMathRetention = subtractCapturedPendingMath(recoveryPendingMathRetention, capturedPendingMath);
      recoveryRestoreNotice.value = "";
      return serialized;
    },
    async restoreRecoveryBundle(serialized: string) {
      const currentEditor = editor.value;
      const currentTab = getPaneTab(props.paneId);
      if (!currentEditor || currentEditor !== activeEditor || !currentTab || toRaw(currentTab) !== ownerTab || !isCurrentOwnerTab()) {
        throw new Error("所见即所得编辑器会话已被替换，无法恢复。");
      }
      if (currentTab.kind !== "untitled" || currentTab.path) {
        throw new Error("恢复文件只能导入新的未命名会话。");
      }
      const initialDoc = currentEditor.state.doc;
      const initialParagraph = initialDoc.childCount === 1
        && initialDoc.firstChild?.type.name === "paragraph"
        && initialDoc.firstChild.content.size === 0;
      if (currentTab.isDirty || currentTab.content.length > 0 || !initialParagraph) {
        throw new Error("恢复文件只能导入内容为空且未发生编辑的新未命名会话，当前会话已有内容或编辑历史。");
      }
      // Decode and validate the complete bundle before changing the PM model,
      // source projection, format history, or mounted local editors.
      const decoded = decodeRecoveryBundleV3(serialized, currentEditor.state.schema);
      if (editor.value !== currentEditor || !isCurrentOwnerTab()) {
        throw new Error("所见即所得编辑器会话已被替换，无法恢复。");
      }

      const selectionJson = decoded.selection.toJSON();
      const recoveredSourceText = decoded.sourceText;
      const recoveredSourceBytes = new Uint8Array(decoded.sourceBytes);
      const recoveredRevision = Math.max(wysiwygRevision + 1, decoded.localState.revision);

      currentEditor.commands.setContent(decoded.doc.toJSON(), { emitUpdate: false });
      if (editor.value !== currentEditor) {
        throw new Error("恢复过程中所见即所得编辑器会话已被替换。");
      }
      let recoveredSelection: Selection;
      try {
        recoveredSelection = Selection.fromJSON(currentEditor.state.doc, selectionJson);
      } catch (error) {
        throw new Error(`恢复选择区无法绑定到恢复文档：${error instanceof Error ? error.message : String(error)}`);
      }
      let transaction = currentEditor.view.state.tr
        .setSelection(recoveredSelection)
        .setMeta("addToHistory", false);
      const exposed = decoded.localState.exposedMarkdown;
      transaction = exposed?.active
        ? transaction.setMeta(exposeMarkdownMeta, exposed.range)
        : transaction.setMeta(clearExposeMarkdownMeta, true);
      currentEditor.view.dispatch(transaction);

      // Keep the recovered source bytes as a separate baseline.  The PM model
      // may include edits that have no proven source mapping; snapshot() will
      // reject a source overwrite until a later piece/provenance layer proves
      // that relation.
      preservationBaseline = null;
      recoverySourceBaseline = {
        sourceText: recoveredSourceText,
        sourceBytes: recoveredSourceBytes,
        revision: recoveredRevision,
        mappingProven: false,
        reason: "Recovered source bytes and PM document have no proven mapping in this slice.",
      };
      recoveryPendingMathRetention = {
        version: decoded.pendingMath.version,
        entries: decoded.pendingMath.entries.map((entry) => ({
          ...entry,
          binding: { ...entry.binding },
          accepted: { ...entry.accepted },
          local: { ...entry.local },
        })),
      };
      wysiwygRevision = recoveredRevision;
      documentMutationTracker?.setRevision(wysiwygRevision);
      snapshotCache?.invalidate();
      currentTab.wysiwygFormatHistory = {
        undo: decoded.localState.history.format.undo.map((entry) => ({ ...entry })),
        redo: decoded.localState.history.format.redo.map((entry) => ({ ...entry })),
      };
      setPaneContent(props.paneId, recoveredSourceText, true, false);
      restoreRecoveryLocalBuffersForOwner(currentEditor, decoded.localState.buffers);
      recoveryRestoreIssues.value = [...recoveryLocalBufferRestoreIssuesForOwner(currentEditor).issues];
      recoveryRestoreNotice.value = [
        decoded.localState.history.pm.reason,
        decoded.localState.history.source.reason,
        recoverySourceBaseline.reason,
      ].join(" ");
      if (editorShell.value) {
        const maxScrollTop = Math.max(0, editorShell.value.scrollHeight - editorShell.value.clientHeight);
        editorShell.value.scrollTop = Math.max(0, Math.min(decoded.scroll.scrollTop, maxScrollTop));
      }
      outlineDecorationEpoch += 1;
      void ensureInitialCodeLanguages(currentEditor.view);
    },
    async snapshot(reason, options) {
      if (!snapshotCache) throw new Error("所见即所得快照会话已经关闭。");
      if (editor.value !== activeEditor || !ownerTabStillExists()) {
        throw new Error("所见即所得编辑器会话已被替换。");
      }
      if (recoverySourceBaseline) {
        const currentModelText = editorHtmlToMarkdown(activeEditor.getHTML());
        assertRecoverySourceMappingProven({
          sourceText: recoverySourceBaseline.sourceText,
          modelText: currentModelText,
          mappingProven: recoverySourceBaseline.mappingProven,
        });
      }
      await prepareFineSourcePreservation();
      const snapshot = await snapshotCache.snapshot(reason, options);
      if (activeEditor.view && wysiwygRevision === snapshot.revision) {
        preservationBaseline = capturePreservationBaseline(snapshot.markdown);
        const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
        historySourceBaseline = captureWysiwygSourceBaseline(snapshot.markdown, canonical.doc);
        documentHistory.checkpoint(snapshot.markdown);
        documentHistory.project({ mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline }, canonical.bookmark);
        await captureExactWysiwygPosition(activeEditor.view, snapshot.markdown, canonical, historySourceBaseline);
        if (editor.value !== activeEditor || !ownerTabStillExists() || wysiwygRevision !== snapshot.revision) return snapshot;
        const derived = getWysiwygDerivedState(activeEditor.view.state);
        publishDocumentDerivedState(tabId, {
          revision: wysiwygRevision,
          words: derived.words,
          chars: derived.chars,
          lines: derived.lines,
          outline: structureOutline(
            extractOutlineWithLines(snapshot.markdown),
            snapshot.markdown.split(/\r?\n/).length,
          ),
          findMatches: cachedWysiwygFind.items.length,
          snapshotDiagnostics: snapshotCache.diagnostics(),
        });
      }
      return snapshot;
    },
    derivedState() {
      const currentEditor = activeEditor;
      if (!ownerTabStillExists()) return { revision: wysiwygRevision };
      const derived = getWysiwygDerivedState(currentEditor.state);
      return {
        revision: wysiwygRevision,
        words: derived.words,
        chars: derived.chars,
        lines: derived.lines,
        outline: wysiwygStructuredOutline(currentEditor.state),
        findMatches: cachedWysiwygFind.items.length,
        snapshotDiagnostics: snapshotCache?.diagnostics(),
      };
    },
    initialCommandMarkdown: ownerTab.content,
    captureAssetCommandAnchor(patch, markdown) { return captureAssetReferenceBookmark(activeEditor.state, markdown, patch); },
    validateCommandAnchor(anchor) { return validateAssetReferenceBookmark(activeEditor.state.doc, anchor); },
    async commandAnchorToSource(anchor, kind, markdown) {
      if (kind === 'asset') return projectAssetReferenceBookmark(activeEditor.state, markdown, anchor);
      const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
      const from = canonical.mapping.map(anchor.from, 1);
      const to = anchor.from === anchor.to ? from : canonical.mapping.map(anchor.to, -1);
      const bookmark = await historySourceBookmark({ root: { mode: 'wysiwyg', doc: canonical.doc, baseline: captureWysiwygSourceBaseline(markdown, canonical.doc) }, bookmark: { anchor: from, head: to } }, markdown);
      return { from: Math.min(bookmark.anchor, bookmark.head), to: Math.max(bookmark.anchor, bookmark.head), expected: markdown.slice(Math.min(bookmark.anchor, bookmark.head), Math.max(bookmark.anchor, bookmark.head)) };
    },
    async commandAnchorFromSource(anchor, kind, markdown) {
      if (kind === 'asset') return captureAssetReferenceBookmark(activeEditor.state, markdown, anchor);
      const doc = activeEditor.state.doc;
      const bookmark = await historyPmBookmark(doc, markdown, { anchor: anchor.from, head: anchor.to });
      return { from: Math.min(bookmark.anchor, bookmark.head), to: Math.max(bookmark.anchor, bookmark.head) };
    },
    async applyPendingCommand(anchor, payload, expectedRevision, assertCurrent) {
      assertCurrent();
      if (payload.kind === 'image') {
        const images = parseMarkdownImageSnippets(payload.markdown);
        if (!images.length) throw new Error('图片引用解析失败，文件已保留在资源目录。');
        const snapshot = await snapshotCache!.snapshot('externalDiff');
        const [{ sourceBlockInsertionCandidates }, { sameSourceSemanticNode }] = await Promise.all([
          import('../../editor/sourceBlockInsertionCandidates'), import('../../editor/fineSourcePreservation'),
        ]);
        assertCurrent();
        const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
        const raw = await historySourceBookmark({ root: { mode: 'wysiwyg', doc: canonical.doc, baseline: captureWysiwygSourceBaseline(snapshot.markdown, canonical.doc) }, bookmark: { anchor: canonical.mapping.map(anchor.from, 1), head: canonical.mapping.map(anchor.to, anchor.from === anchor.to ? 1 : -1) } }, snapshot.markdown);
        assertCurrent();
        let staged: Transaction | null = null;
        new CommandManager({ editor: activeEditor, state: activeEditor.state }).chain().insertContentAt({ from: anchor.from, to: anchor.to }, images.map(image => ({ type: 'image', attrs: { ...image, editing: true } })), { updateSelection: false }).command(({ tr }) => { staged = tr; return true; }).run();
        if (!staged || !(staged as Transaction).docChanged) throw new Error('图片插入未能建立局部事务，文件已保留。');
        const transaction = staged as Transaction;
        const candidate = sourceBlockInsertionCandidates(snapshot.markdown, Math.min(raw.anchor, raw.head), Math.max(raw.anchor, raw.head), payload.markdown).find(candidate => {
          const container = document.createElement('div'); container.innerHTML = renderMarkdownForEditorWithAssets(candidate.markdown);
          const parsed = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parse(container);
          return sameSourceSemanticNode(parsed, transaction.doc);
        });
        if (!candidate) throw new Error('无法在该位置精确保留源码并插入图片；资源已保存，请在段落边界或源码模式插入。');
        assertCurrent();
        activeEditor.view.dispatch(transaction);
        commitExactSourceCheckpoint(candidate.markdown);
        return;
      }
      const snapshot = await snapshotCache!.snapshot('externalDiff');
      assertCurrent();
      if (wysiwygRevision !== expectedRevision) throw new Error('原文档已变化，请重试重链。');
      const raw = projectAssetReferenceBookmark(activeEditor.state, snapshot.markdown, anchor);
      const transaction = assetBookmarkTransaction(activeEditor.state, anchor, payload.insert, source => resolveMarkdownImageSource(source, ownerTab.path));
      activeEditor.view.dispatch(transaction);
      const markdown = snapshot.markdown.slice(0, raw.from) + payload.insert + snapshot.markdown.slice(raw.to);
      commitExactSourceCheckpoint(markdown);
    },
    async applySourcePatch(patch, expectedRevision) {
      if (editor.value !== activeEditor || !ownerTabStillExists() || wysiwygRevision !== expectedRevision || hasPendingLocalEdits(activeEditor) || hasPendingMathEdits(activeEditor)) {
        throw new Error("资源重链目标已变化，已保留当前输入。");
      }
      const snapshot = await snapshotCache!.snapshot("externalDiff");
      if (editor.value !== activeEditor || !ownerTabStillExists() || wysiwygRevision !== expectedRevision) throw new Error("资源重链期间文档已变化。");
      activeEditor.view.dispatch(assetReferenceTransaction(activeEditor.state, snapshot.markdown, patch, source => resolveMarkdownImageSource(source, ownerTab.path)));
      const markdown = snapshot.markdown.slice(0, patch.from) + patch.insert + snapshot.markdown.slice(patch.to);
      commitExactSourceCheckpoint(markdown);
    },
    async replaceMarkdown(markdown) {
      const currentEditor = activeEditor;
      if (!currentEditor || !ownerTabStillExists()) {
        throw new Error("所见即所得编辑器会话已被替换。");
      }
      currentEditor.commands.setContent(renderMarkdownForEditorWithAssets(markdown), { emitUpdate: false });
      preservationBaseline = capturePreservationBaseline(markdown);
      wysiwygRevision = advanceDocumentRevision(editorOwnerTab!.id, wysiwygRevision);
      documentMutationTracker?.setRevision(wysiwygRevision);
      snapshotCache?.invalidate();
      outlineDecorationEpoch += 1;
      void ensureInitialCodeLanguages(currentEditor.view);
    },
    navigate(target) {
      const currentEditor = editor.value;
      if (!currentEditor || currentEditor !== activeEditor || !ownerTabStillExists()) return;
      let requested = target.position;
      if (requested == null && target.offset != null) {
        requested = markdownOffsetToDocPos(currentEditor.state, target.offset, ownerTab.content);
      }
      if (requested == null && target.line != null) {
        const targetLine = target.line;
        const outline = wysiwygStructuredOutline(currentEditor.state) as Array<StructuredOutlineItem & { position?: number }>;
        requested = [...outline].reverse().find((item) => item.line <= targetLine)?.position;
      }
      const position = Math.max(1, Math.min(currentEditor.state.doc.content.size, requested ?? 1));
      currentEditor.chain().focus().setTextSelection(position).scrollIntoView().run();
    },
  };
  observedPendingMathInputVersion = 0;
  observedPendingLocalInputVersion = 0;
  documentMutationTracker = createDocumentMutationTracker({
    sessionIdentity: sessionAdapter,
    initialRevision: wysiwygRevision,
  });
  unregisterDocumentSession = registerDocumentSession(sessionAdapter);
  pendingCommandLease = documentCommandLease(ownerTab.id);
  publishToolbarFormatState(activeEditor);
}

function handleWysiwygHeadingFoldsChanged(event: CustomEvent<{ paneId?: EditorPaneId }>) {
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  outlineDecorationEpoch += 1;
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const tab = getPaneTab(props.paneId);
  const outline = getPaneStructuredOutline(props.paneId);
  const current = resolveHeadingSection(outline, appStore.paneOutlineAnchorLines[props.paneId]);
  if (current && tab?.collapsedHeadingKeys.includes(current.key)) {
    const heading = activeEditor.view.dom.querySelector<HTMLElement>(`[data-outline-key="${cssEscape(current.key)}"]`);
    if (heading) {
      const position = activeEditor.view.posAtDOM(heading, 0);
      activeEditor.view.dispatch(
        activeEditor.view.state.tr
          .setSelection(TextSelection.near(activeEditor.view.state.doc.resolve(Math.min(position + 1, activeEditor.view.state.doc.content.size))))
          .setMeta("addToHistory", false),
      );
    }
  }
  activeEditor.view.dispatch(activeEditor.view.state.tr.setMeta("lightmarkHeadingFolds", Date.now()).setMeta("addToHistory", false));
}

function handleModeCursorCapture(event: CustomEvent<{ from?: string; to?: string; paneId?: EditorPaneId }>) {
  const activeEditor = editor.value;
  if (event.detail?.paneId !== props.paneId || paneEditorMode.value !== "wysiwyg" || event.detail?.to !== "source" || !activeEditor) return;
  // `onUpdate` already keeps the tab synchronized after real edits. Reusing
  // that exact source here avoids normalizing whitespace and marking a clean
  // document dirty merely because the user changed editor modes.
  const markdown = paneContent.value;
  const { anchor, head } = activeEditor.view.state.selection;
  setPanePendingModeCursor(props.paneId, {
    targetMode: "source",
    markdownAnchor: docPosToMarkdownOffset(activeEditor.view.state, anchor, markdown),
    markdownHead: docPosToMarkdownOffset(activeEditor.view.state, head, markdown),
    reason: "mode-switch",
  });
}

function handleApplyMarkdownFormat(event: CustomEvent<{ paneId: EditorPaneId; source: string; result: MarkdownFormatResult; handled: boolean }>) {
  const activeEditor = editor.value;
  if (event.detail?.paneId !== props.paneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal" || !activeEditor) return;
  const state = activeEditor.view.state;
  const currentMarkdown = event.detail.source;
  const anchorOffset = docPosToMarkdownOffset(state, state.selection.anchor, currentMarkdown);
  const headOffset = docPosToMarkdownOffset(state, state.selection.head, currentMarkdown);
  const mappedAnchor = mapMarkdownOffset(event.detail.source, event.detail.result, anchorOffset);
  const mappedHead = mapMarkdownOffset(event.detail.source, event.detail.result, headOffset);
  const container = document.createElement("div");
  container.innerHTML = renderMarkdownForEditorWithAssets(event.detail.result.text);
  const nextDoc = ProseMirrorDOMParser.fromSchema(state.schema).parse(container);
  let transaction = state.tr.replaceWith(0, state.doc.content.size, nextDoc.content);
  const nextState = { doc: transaction.doc };
  const anchor = markdownOffsetToDocPos(nextState, mappedAnchor, event.detail.result.text);
  const head = markdownOffsetToDocPos(nextState, mappedHead, event.detail.result.text);
  transaction = transaction
    .setSelection(TextSelection.create(transaction.doc, anchor, head))
    .setMeta("addToHistory", false)
    .scrollIntoView();
  event.detail.handled = true;
  suppressWysiwygUpdate = true;
  activeEditor.view.dispatch(transaction);
  suppressWysiwygUpdate = false;
  // The visual document is semantic HTML; retain the formatter's canonical
  // Markdown in the tab instead of immediately re-serializing table padding.
  setPaneContent(props.paneId, event.detail.result.text, true, false);
  const canonical = canonicalMarkdownHistoryState(activeEditor.state, exposedMarkdownLifecycleKey.getState(activeEditor.state));
  historySourceBaseline = captureWysiwygSourceBaseline(event.detail.result.text, canonical.doc);
  if (editorOwnerTab) {
    const history = documentHistoryForTab(editorOwnerTab.id);
    history.record({ mode: 'wysiwyg', doc: canonical.doc, baseline: historySourceBaseline }, { kind: 'command', before: historyBookmark, after: canonical.bookmark, time: Date.now() });
    history.checkpoint(event.detail.result.text);
  }
  historyBookmark = canonical.bookmark;
  wysiwygRevision = advanceDocumentRevision(editorOwnerTab!.id, wysiwygRevision);
  documentMutationTracker?.setRevision(wysiwygRevision);
  if (primeExactWysiwygMarkdown) primeExactWysiwygMarkdown(event.detail.result.text);
  else snapshotCache?.invalidate();
  activeEditor.view.focus();
}

function handlePendingControlHistory(event: KeyboardEvent) {
  const activeEditor = editor.value;
  if (!activeEditor || !isCurrentWysiwygEditor(activeEditor) || !(event.target instanceof Element)) return;
  const control = event.target.closest('input, textarea, [contenteditable]');
  if (!control || control === activeEditor.view.dom || control.getAttribute('contenteditable') === 'false' || !editorShell.value?.contains(control)) return;
  if (handleExactFormatHistoryKeydown(activeEditor.view, event)) event.stopImmediatePropagation();
}

function handleExactFormatHistoryKeydown(view: EditorView, event: KeyboardEvent) {
  if (event.isComposing || view.composing || composingControls.size) return false;
  const undo = matchesShortcut('Mod+Z', event);
  const redo = matchesShortcut('Mod+Shift+Z', event) || matchesShortcut('Mod+Y', event);
  if (!undo && !redo) return false;
  const tab = getPaneTab(props.paneId);
  if (!tab) return false;
  event.preventDefault();
  event.stopPropagation();
  void moveDocumentHistory(tab.id, redo ? 1 : -1).catch(error => {
    appStore.statusMessage = error instanceof Error ? error.message : String(error);
  });
  return true;
}

function captureWysiwygPosition(view = editor.value?.view) {
  if (!view || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const shell = editorShell.value;
  const previous = getPaneTab(props.paneId)?.position;
  const { anchor, head } = view.state.selection;
  const scroll = normalizeScrollSnapshot(shell?.scrollTop ?? 0, shell?.scrollHeight ?? 0, shell?.clientHeight ?? 0);
  updatePanePosition(props.paneId, {
    editorMode: "wysiwyg",
    editorAnchor: anchor,
    editorHead: head,
    markdownAnchor: previous?.markdownAnchor ?? 0,
    markdownHead: previous?.markdownHead ?? previous?.markdownAnchor ?? 0,
    markdownLine: previous?.markdownLine ?? 1,
    markdownColumn: previous?.markdownColumn ?? 0,
    markdownLineText: previous?.markdownLineText ?? "",
    ...scroll,
    updatedAt: Date.now(),
  });
}

async function captureExactWysiwygPosition(view: EditorView, markdown: string, canonical: ReturnType<typeof canonicalMarkdownHistoryState>, baseline: WysiwygSourceBaseline) {
  const state = view.state;
  let bookmark;
  try {
    // Map only the selected canonical blocks. Serializing the complete prefix
    // here made an EOF selection after reset allocate a second 50k-block DOM.
    bookmark = await historySourceBookmark({ root: { mode: 'wysiwyg', doc: canonical.doc, baseline }, bookmark: canonical.bookmark }, markdown);
  } catch {
    // Position persistence is optional. Unsupported source must not prevent a
    // valid snapshot/save, or replace the last proven source offsets by guesses.
    if (!view.isDestroyed && view.state === state) captureWysiwygPosition(view);
    return;
  }
  if (view.isDestroyed || view.state !== state) return;
  const shell = editorShell.value;
  const { anchor, head } = state.selection;
  updatePanePosition(props.paneId, {
    ...buildEditorPositionSnapshot({
      editorMode: "wysiwyg",
      markdown,
      markdownAnchor: bookmark.anchor,
      markdownHead: bookmark.head,
      scrollTop: shell?.scrollTop ?? 0,
      scrollHeight: shell?.scrollHeight ?? 0,
      clientHeight: shell?.clientHeight ?? 0,
    }),
    editorAnchor: anchor,
    editorHead: head,
  });
}

function schedulePendingWysiwygPositionRestore() {
  if (getPanePendingModeCursor(props.paneId)) return;
  const position = consumePanePendingEditorPosition(props.paneId, "wysiwyg");
  if (!position) return;
  window.setTimeout(() => restoreWysiwygPosition(position), 0);
}

function handleRestorePosition(event: CustomEvent) {
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  if (paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  restoreWysiwygPosition(event.detail);
}

function restoreWysiwygPosition(position: any) {
  const activeEditor = editor.value;
  const shell = editorShell.value;
  if (!activeEditor || !position || position.editorMode !== "wysiwyg") return;
  const revision = wysiwygRevision, restoreEpoch = ++wysiwygSelectionRestoreEpoch;
  window.requestAnimationFrame(() => {
    if (editor.value !== activeEditor || !isCurrentWysiwygEditor(activeEditor) || revision !== wysiwygRevision || restoreEpoch !== wysiwygSelectionRestoreEpoch) return;
    const view = activeEditor.view;
    const docPos = typeof position.editorAnchor === "number"
      ? clampDocPos(position.editorAnchor, view.state.doc.content.size)
      : markdownOffsetToDocPos(view.state, position.markdownAnchor, paneContent.value);
    const headPos = typeof position.editorHead === "number"
      ? clampDocPos(position.editorHead, view.state.doc.content.size)
      : markdownOffsetToDocPos(view.state, position.markdownHead, paneContent.value);
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, clampDocPos(docPos, view.state.doc.content.size), clampDocPos(headPos, view.state.doc.content.size))));
    } catch {
      scrollWysiwygPositionIntoView(view, docPos);
    }
    if (shell) shell.scrollTop = scrollTopFromSnapshot(position, shell.scrollHeight, shell.clientHeight);
    view.focus();
    window.requestAnimationFrame(() => scheduleWysiwygTypewriter(view));
  });
}

function handleWysiwygWritingModesChanged() {
  syncWysiwygWritingModes();
  const view = editor.value?.view;
  if (!view) return;
  view.dispatch(view.state.tr.setMeta("lightmarkWritingModes", true));
  scheduleWysiwygTypewriter(view);
}

function syncWysiwygWritingModes() {
  editorShell.value?.classList.toggle(
    "lm-typewriter-mode",
    appStore.settings.editor.typewriterMode && paneDocumentMode.value === "normal",
  );
}

function scheduleWysiwygTypewriter(view = editor.value?.view) {
  window.cancelAnimationFrame(wysiwygTypewriterFrame);
  wysiwygTypewriterFrame = window.requestAnimationFrame(() => {
    wysiwygTypewriterFrame = window.requestAnimationFrame(() => {
      const shell = editorShell.value;
      if (
        !view ||
        !shell ||
        !appStore.settings.editor.typewriterMode ||
        props.paneId !== appStore.splitLayout.activePaneId ||
        paneEditorMode.value !== "wysiwyg" ||
        paneDocumentMode.value !== "normal"
      ) {
        return;
      }
      const caret = view.coordsAtPos(view.state.selection.head);
      const viewport = shell.getBoundingClientRect();
      const delta = typewriterScrollDelta(caret.top, caret.bottom, viewport.top, viewport.bottom);
      if (Math.abs(delta) < 1) return;
      shell.scrollBy({
        top: delta,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
  });
}

function restorePendingWysiwygCursor() {
  const pending = getPanePendingModeCursor(props.paneId);
  if (!pending || pending.targetMode !== "wysiwyg") return false;
  const view = editor.value?.view;
  if (!view) return false;
  window.requestAnimationFrame(() => {
    const activeView = editor.value?.view;
    if (!activeView || getPanePendingModeCursor(props.paneId) !== pending) return;
    const target = findWysiwygScrollTarget(activeView, pending, paneContent.value);
    if (target) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
    } else {
      const scrollPos = markdownOffsetToDocPos(activeView.state, pending.markdownAnchor, paneContent.value);
      scrollWysiwygPositionIntoView(activeView, scrollPos);
    }
    if (getPanePendingModeCursor(props.paneId) === pending) setPanePendingModeCursor(props.paneId, null);
  });
  return true;
}

function schedulePendingWysiwygCursorRestore(attempt = 0) {
  const pending = getPanePendingModeCursor(props.paneId);
  if (!pending || pending.targetMode !== "wysiwyg") return;
  if (pendingWysiwygRestoreTimer !== null) window.clearTimeout(pendingWysiwygRestoreTimer);
  pendingWysiwygRestoreTimer = window.setTimeout(() => {
    pendingWysiwygRestoreTimer = null;
    if (restorePendingWysiwygCursor()) return;
    if (attempt < 8) schedulePendingWysiwygCursorRestore(attempt + 1);
  }, attempt === 0 ? 0 : 24);
}

function scrollWysiwygPositionIntoView(view: any, pos: number) {
  window.requestAnimationFrame(() => {
    try {
      const dom = view.domAtPos(clampDocPos(pos, view.state.doc.content.size)).node;
      const element = dom instanceof Element ? dom : dom.parentElement;
      element?.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      view.dom.querySelector(".ProseMirror-selectednode")?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  });
}

function findWysiwygScrollTarget(view: any, pending: any, markdown: string) {
  const blocks = collectWysiwygScrollBlocks(view.dom);
  if (blocks.length === 0) return null;
  const lineText = findNearbySourceLineText(markdown, pending.markdownLine, pending.markdownLineText);
  const needle = normalizeSourceLineForSearch(lineText);
  const expectedRatio = sourceLineRatio(markdown, pending.markdownLine);

  if (needle.length >= 2) {
    const matches = blocks.filter((block) => normalizeDomTextForSearch(block.textContent || "").includes(needle));
    if (matches.length > 0) return chooseNearestBlockByRatio(blocks, matches, expectedRatio);
  }

  if (typeof pending.markdownLine === "number") {
    return blocks[Math.max(0, Math.min(blocks.length - 1, Math.round(expectedRatio * (blocks.length - 1))))] ?? null;
  }
  return null;
}

function collectWysiwygScrollBlocks(root: HTMLElement) {
  const selector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "pre",
    "table",
    "figure",
    "section[data-type]",
    "[data-type='inline-html']",
    "[data-type='raw-html']",
    ".typora-image-node",
    ".html-block-node",
    ".markdown-alert",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => root.contains(element));
}

function chooseNearestBlockByRatio(allBlocks: HTMLElement[], matches: HTMLElement[], expectedRatio: number) {
  if (matches.length === 1) return matches[0];
  const denominator = Math.max(allBlocks.length - 1, 1);
  return matches
    .map((block) => ({ block, distance: Math.abs(allBlocks.indexOf(block) / denominator - expectedRatio) }))
    .sort((left, right) => left.distance - right.distance)[0]?.block ?? matches[0];
}

function findNearbySourceLineText(markdown: string, lineNumber?: number, lineText?: string) {
  if (lineText && normalizeSourceLineForSearch(lineText).length >= 2) return lineText;
  if (!lineNumber) return lineText || "";
  const lines = markdown.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  for (let radius = 0; radius <= 4; radius += 1) {
    const candidates = radius === 0 ? [index] : [index - radius, index + radius];
    for (const candidate of candidates) {
      const text = lines[candidate] || "";
      if (normalizeSourceLineForSearch(text).length >= 2) return text;
    }
  }
  return lineText || "";
}

function sourceLineRatio(markdown: string, lineNumber?: number) {
  if (!lineNumber) return 0;
  const total = Math.max(markdown.split(/\r?\n/).length, 1);
  return Math.max(0, Math.min(1, (lineNumber - 1) / Math.max(total - 1, 1)));
}

function normalizeSourceLineForSearch(value: string) {
  return normalizeDomTextForSearch(
    value
      .replace(/^ {0,3}> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i, "")
      .replace(/^ {0,3}>\s?/g, "")
      .replace(/^ {0,3}#{1,6}\s+/g, "")
      .replace(/^(\s*)([-*+]|\d+\.)\s+\[[ xX]\]\s+/g, "")
      .replace(/^(\s*)([-*+]|\d+\.)\s+/g, "")
      .replace(/^ {0,3}(```|~~~).*$/g, "")
      .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, "$1")
      .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
      .replace(/\[\^([^\]\n]+)\]/g, "$1")
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/_([^_\n]+)_/g, "$1")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/==([^=\n]+)==/g, "$1")
      .replace(/\$([^$\n]+)\$/g, "$1")
      .replace(/<[^>\n]+>/g, "")
      .replace(/^\|?|\|?$/g, ""),
  );
}

function normalizeDomTextForSearch(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function handleFindCommand(event: CustomEvent<string>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const command = event.detail || "refresh";
  if (command === "next" || command === "previous") {
    navigateWysiwygFind(command === "next" ? 1 : -1);
    return;
  }
  if (command === "replaceCurrent") {
    replaceCurrentWysiwygFind();
    return;
  }
  if (command === "replaceAll") {
    replaceAllWysiwygFind();
    return;
  }
  refreshWysiwygFind();
}

function refreshWysiwygFind() {
  const view = editor.value?.view;
  if (!view) return;
  const options = findOptions();
  view.dispatch(setWysiwygFindQuery(view.state, findReplaceStore.open && findReplaceStore.query
    ? { search: findReplaceStore.query, ...options }
    : null));
  syncWysiwygFindState(view.state);
}

function syncWysiwygFindState(state: any) {
  const matches = getWysiwygFindState(state);
  cachedWysiwygFind = { items: matches.items, error: matches.error };
  const current = findReplaceStore.currentIndex < 0 ? 0 : normalizeMatchIndex(findReplaceStore.currentIndex, matches.items.length);
  setFindResult(matches.items.length, current, matches.error);
}

function transactionChangesMathDependencies(transaction: any) {
  let changed = false;
  transaction.mapping.maps.forEach((stepMap: any, index: number) => {
    if (changed) return;
    const before = transaction.docs[index];
    const after = transaction.docs[index + 1] ?? transaction.doc;
    stepMap.forEach((oldFrom: number, oldTo: number, newFrom: number, newTo: number) => {
      if (changed) return;
      changed = rangeContainsMathMacro(before, oldFrom, oldTo) || rangeContainsMathMacro(after, newFrom, newTo);
    });
  });
  return changed;
}

function rangeContainsMathMacro(doc: any, rawFrom: number, rawTo: number) {
  if (!doc) return false;
  const from = Math.max(0, Math.min(doc.content.size, rawFrom));
  const to = Math.max(from, Math.min(doc.content.size, rawTo));
  let found = false;
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node: any) => {
    if ((node.type?.name === "inlineMath" || node.type?.name === "blockMath") && extractMathMacroDefinitions(String(node.attrs.tex || "")).length > 0) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function navigateWysiwygFind(delta: 1 | -1) {
  const view = editor.value?.view;
  if (!view) return;
  const matches = getWysiwygFindState(view.state);
  if (matches.error || matches.items.length === 0) {
    setFindResult(0, -1, matches.error);
    view.dispatch(refreshWysiwygFindDecorations(view.state));
    return;
  }

  const current = normalizeMatchIndex(findReplaceStore.currentIndex + delta, matches.items.length);
  const match = matches.items[current];
  const markdown = paneContent.value;
  const targetLine = markdownLineAtOffset(markdown, docPosToMarkdownOffset(view.state, match.docFrom, markdown));
  revealHeadingAtLine(props.paneId, targetLine);
  setFindResult(matches.items.length, current, "");
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.docFrom, match.docTo)).scrollIntoView());
}

function replaceCurrentWysiwygFind() {
  const view = editor.value?.view;
  if (!view) return;
  const matches = getWysiwygFindState(view.state);
  const current = normalizeMatchIndex(findReplaceStore.currentIndex, matches.items.length);
  const match = matches.items[current];
  if (!match || matches.error) {
    setFindResult(matches.items.length, current, matches.error);
    return;
  }
  const replacement = replacementForMatch(match, findReplaceStore.replaceText, findReplaceStore.regex);
  view.dispatch(view.state.tr.insertText(replacement, match.docFrom, match.docTo).scrollIntoView());
}

function replaceAllWysiwygFind() {
  const view = editor.value?.view;
  if (!view) return;
  const matches = getWysiwygFindState(view.state);
  if (matches.error || matches.items.length === 0) {
    setFindResult(0, -1, matches.error);
    return;
  }
  let tr = view.state.tr;
  for (const match of [...matches.items].reverse()) {
    tr = tr.insertText(replacementForMatch(match, findReplaceStore.replaceText, findReplaceStore.regex), match.docFrom, match.docTo);
  }
  view.dispatch(tr.scrollIntoView());
  appStore.statusMessage = `已替换 ${matches.items.length} 处`;
}

function publishToolbarFormatState(activeEditor: import('@tiptap/core').Editor | undefined | null = editor.value) {
  if (!activeEditor || !editorOwnerTab) return;
  const headingLevel = activeEditor.isActive('heading') ? Number(activeEditor.getAttributes('heading').level || 1) : 0;
  const flags = Object.fromEntries(['bold', 'italic', 'code', 'link', 'blockquote', 'bulletList', 'orderedList', 'taskList'].map(name => [name, activeEditor.isActive(name)]));
  window.dispatchEvent(new CustomEvent('lightmark:editor-format-state', { detail: { tabId: editorOwnerTab.id, headingLevel, ...flags } }));
}

function handleToolbarEditorCommand(event: CustomEvent<ToolbarEditorCommandDetail>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const command = event.detail?.command;
  switch (command) {
    case "bold":
    case "italic":
    case "code":
    case "blockquote":
    case "orderedList":
    case "bulletList":
      runFormatCommand(command);
      break;
    case "link":
      toggleLink();
      break;
    case "taskList":
      insertTaskItem();
      break;
    case "heading":
      setHeadingLevel(typeof event.detail?.value === "number" ? event.detail.value : 2);
      break;
    case "image":
      insertImageByUrl();
      break;
    case "table":
      editor.value?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      break;
    case "alert":
      insertGithubAlert(typeof event.detail?.value === "string" ? event.detail.value : "note");
      break;
    default:
      break;
  }
}

function handleGlobalImageInsert(event: CustomEvent<ImageInsertDetail>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  const files = event.detail?.files || [];
  const paths = event.detail?.paths || [];
  if (files.length === 0 && paths.length === 0) return;
  const view = editor.value?.view;
  if (!view) return;
  const insertAt = imageInsertPositionFromEventDetail(event.detail, view.state.doc.content.size);
  if (paths.length > 0) {
    void insertImagePathsIntoWysiwyg(paths, insertAt, insertAt);
    return;
  }
  void insertImageFilesIntoWysiwyg(files, insertAt, insertAt, event.detail?.source || "drop");
}

function imageInsertPositionFromEventDetail(detail: ImageInsertDetail | undefined, fallback: number) {
  const view = editor.value?.view;
  if (!view || typeof detail?.position?.x !== "number" || typeof detail.position.y !== "number") return fallback;
  return view.posAtCoords({ left: detail.position.x, top: detail.position.y })?.pos ?? fallback;
}

function getContextMenuPosition(clientX: number, clientY: number) {
  const margin = 8;
  const menuWidth = 280;
  const menuHeight = 390;
  const maxX = Math.max(margin, window.innerWidth - menuWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - menuHeight - margin);
  return {
    x: Math.min(Math.max(clientX, margin), maxX),
    y: Math.min(Math.max(clientY, margin), maxY),
    flipX: clientX > window.innerWidth - 320,
    flipY: clientY > window.innerHeight - 300,
  };
}

function hideContextMenu() {
  contextMenu.value.visible = false;
}

function handleEditorShellClick(event?: MouseEvent) {
  hideContextMenu();
  if (event?.target instanceof HTMLElement && !event.target.closest(".wiki-completion-menu")) closeWysiwygWikiCompletion();
  if (codeLanguageControl.value.open) closeFloatingCodeLanguageMenu({ focusEditor: false });
  const target = event?.target instanceof HTMLElement ? event.target : null;
  const table = target?.closest("table") as HTMLTableElement | null;
  if (table) {
    closeTablePopovers();
    const cell = target?.closest("td,th") as HTMLTableCellElement | null;
    updateTableControl(editor.value?.view, table, cell);
    return;
  }
  if (target && !target.closest("table,.table-floating-toolbar")) {
    tableControl.value.visible = false;
    closeTablePopovers();
  }
}

function handleDocumentTablePointerDown(event: PointerEvent) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target || target.closest(".table-floating-toolbar")) return;
  const view = editor.value?.view;
  const table = target.closest("table") as HTMLTableElement | null;
  if (!view || !table || !view.dom.contains(table)) return;
  closeTablePopovers();
  const cell = target.closest("td,th") as HTMLTableCellElement | null;
  updateTableControl(view, table, cell);
  window.requestAnimationFrame(() => updateTableControl(view, table, cell));
}

function isPositionInsideSelection(selection: any, pos: number) {
  return !selection.empty && pos >= selection.from && pos <= selection.to;
}

function restoreEditorSelection() {
  const activeEditor = editor.value;
  if (!activeEditor || !savedSelection.value) {
    activeEditor?.view.focus();
    return;
  }

  const { state, view } = activeEditor;
  const docSize = state.doc.content.size;
  const from = Math.max(0, Math.min(savedSelection.value.from, docSize));
  const to = Math.max(from, Math.min(savedSelection.value.to, docSize));

  try {
    const selection = TextSelection.between(
      state.doc.resolve(from),
      state.doc.resolve(to),
      -1,
    );
    view.dispatch(state.tr.setSelection(selection));
  } catch {
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(from))));
  }

  activeEditor.view.focus();
}

function runMenuCommand(command: () => void | Promise<void>, keepOpen = false) {
  restoreEditorSelection();
  void Promise.resolve(command()).finally(() => {
    if (!keepOpen) hideContextMenu();
  });
}

function runTableFloatingCommand(command: () => void | Promise<void>, closePopovers = true) {
  editor.value?.commands.focus();
  void Promise.resolve(command()).finally(() => {
    if (closePopovers) closeTablePopovers();
  });
}

async function writeClipboard(text: string, html?: string) {
  if (html && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Plain text fallback below.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function getSelectedHtml() {
  const activeEditor = editor.value;
  if (!activeEditor) return "";
  const { state } = activeEditor.view;
  const fragment = state.selection.content().content;
  if (!fragment.size) return "";
  const div = document.createElement("div");
  const serializer = DOMSerializer.fromSchema(state.schema);
  div.appendChild(serializer.serializeFragment(fragment));
  return div.innerHTML;
}

function getSelectedMarkdown() {
  const html = getSelectedHtml();
  if (!html) return "";
  return editorHtmlToMarkdown(html);
}

function getSelectedPlainText() {
  const activeEditor = editor.value;
  if (!activeEditor) return "";
  const { from, to } = activeEditor.state.selection;
  return activeEditor.state.doc.textBetween(from, to, "\n", "\n");
}

async function cutSelection() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  if (state.selection.empty) return;
  const payload = selectionClipboardPayload(state);
  if (!payload) return;
  await writeRichClipboard(payload);
  activeEditor.view.dispatch(state.tr.deleteSelection().scrollIntoView());
}

async function copySelectionAsMarkdown() {
  const payload = selectionClipboardPayload(editor.value?.state);
  if (!payload) return;
  await writeClipboard(payload.markdown || payload.plainText);
  appStore.statusMessage = "已复制 Markdown";
}

async function copySelectionClean() {
  const payload = selectionClipboardPayload(editor.value?.state);
  if (!payload) return;
  await writeClipboard(payload.plainText);
  appStore.statusMessage = "已复制纯文本";
}

async function copySelectionAsHtml() {
  const payload = selectionClipboardPayload(editor.value?.state);
  if (!payload) return;
  await writeRichClipboard(payload);
  appStore.statusMessage = "已复制干净 HTML";
}

function selectionClipboardPayload(state = editor.value?.state): ClipboardCopyPayload | null {
  if (!state || state.selection.empty) return null;
  const markdown = getSelectedMarkdown();
  const plainText = getSelectedPlainText();
  if (!markdown && !plainText) return null;
  return buildClipboardCopyPayload({
    markdown: markdown || plainText,
    plainText,
    mathPrelude: mathMacroPreludeBeforeSelection(state),
  });
}

function mathMacroPreludeBeforeSelection(state: any) {
  const markdown = paneContent.value;
  const offset = docPosToMarkdownOffset(state, state.selection.from, markdown);
  return parseMarkdownMath(markdown.slice(0, offset)).tokens
    .filter((token) => extractMathMacroDefinitions(token.tex).length > 0)
    .map((token) => token.raw)
    .join("\n\n");
}

async function writeRichClipboard(payload: ClipboardCopyPayload) {
  await writeClipboard(payload.markdown || payload.plainText, payload.html);
}

async function pasteFromClipboard(plainText: boolean) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { from, to } = activeEditor.state.selection;
  await pasteWysiwygFromClipboard(plainText, from, to);
}

async function pasteWysiwygFromClipboard(plainText: boolean, from: number, to: number) {
  const result = prepareSmartPaste(await readClipboardPayload(), { plainText });
  if (result.kind === "image-files") {
    await insertImageFilesIntoWysiwyg(result.files, from, to, "clipboard");
    return;
  }
  if (!result.markdown) return;
  insertPreparedPasteIntoWysiwyg(result, from, to);
}

function handleWysiwygPlainPasteCapture(event: KeyboardEvent) {
  const activeEditor = editor.value;
  const target = event.target;
  if (
    !activeEditor
    || props.paneId !== appStore.splitLayout.activePaneId
    || paneEditorMode.value !== "wysiwyg"
    || paneDocumentMode.value !== "normal"
    || !(target instanceof HTMLElement)
    || !activeEditor.view.dom.contains(target)
    || !(event.ctrlKey || event.metaKey)
    || !event.shiftKey
    || event.key.toLowerCase() !== "v"
  ) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const { from, to } = activeEditor.state.selection;
  void pasteWysiwygFromClipboard(true, from, to);
}

function insertPreparedPasteIntoWysiwyg(result: PasteConversionResult, from: number, to: number) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const max = activeEditor.state.doc.content.size;
  const boundedFrom = Math.max(0, Math.min(from, max));
  const boundedTo = Math.max(boundedFrom, Math.min(to, max));
  if (activeEditor.state.doc.resolve(boundedFrom).parent.type.name === "codeBlock") {
    activeEditor.view.dispatch(activeEditor.state.tr.insertText(result.markdown, boundedFrom, boundedTo).scrollIntoView());
    activeEditor.commands.focus();
    if (result.warnings.length > 0) appStore.statusMessage = result.warnings.join(" ");
    return;
  }
  if (result.kind === "plain") {
    const mark = activeEditor.state.schema.marks.plainPaste.create();
    if (!/\r?\n/.test(result.markdown)) {
      activeEditor.view.dispatch(
        activeEditor.state.tr
          .replaceRangeWith(boundedFrom, boundedTo, activeEditor.state.schema.text(result.markdown, [mark]))
          .scrollIntoView(),
      );
    } else {
      const paragraphs = result.markdown.replace(/\r\n?/g, "\n").split("\n").map((line) => (
        activeEditor.state.schema.nodes.paragraph.create(
          null,
          line ? activeEditor.state.schema.text(line, [mark]) : null,
        )
      ));
      activeEditor.view.dispatch(
        activeEditor.state.tr
          .replaceRange(boundedFrom, boundedTo, new Slice(Fragment.fromArray(paragraphs), 0, 0))
          .scrollIntoView(),
      );
    }
    activeEditor.commands.focus();
    return;
  }
  const content = renderMarkdownForEditorWithAssets(result.markdown);
  activeEditor.commands.insertContentAt({ from: boundedFrom, to: boundedTo }, content);
  activeEditor.commands.focus();
  if (result.warnings.length > 0) appStore.statusMessage = result.warnings.join(" ");
}

function insertMarkdownText(text: string, selectFromOffset?: number, selectToOffset?: number) {
  const activeEditor = editor.value;
  if (!activeEditor) return;

  const view = activeEditor.view;
  const { state } = view;
  const from = state.selection.from;
  const to = state.selection.to;
  let tr = state.tr.insertText(text, from, to);

  if (typeof selectFromOffset === "number" && typeof selectToOffset === "number") {
    const selectFrom = from + selectFromOffset;
    const selectTo = from + selectToOffset;
    tr = tr.setSelection(TextSelection.create(tr.doc, selectFrom, selectTo));
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function runFormatCommand(commandName: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const chain = activeEditor.chain().focus();
  switch (commandName) {
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "code":
      chain.toggleCode().run();
      break;
    case "blockquote":
      chain.toggleBlockquote().run();
      break;
    case "orderedList":
      chain.toggleOrderedList().run();
      break;
    case "bulletList":
      chain.toggleBulletList().run();
      break;
    default:
      break;
  }
}

function toggleLink() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const selectedText = getSelectedPlainText().trim();
  const label = selectedText || "链接文本";
  const snippet = `[${label}](https://example.com)`;
  const labelStart = 1;
  const labelEnd = labelStart + label.length;
  insertMarkdownText(snippet, selectedText ? snippet.length - "https://example.com)".length : labelStart, selectedText ? snippet.length - 1 : labelEnd);
}

function insertTaskItem() {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  activeEditor.commands.insertContent(renderMarkdownForEditorWithAssets("- [ ] "));
}

function insertGithubAlert(kind: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const selectedText = getSelectedPlainText().trim();
  const body = selectedText || "警示内容";
  const quotedBody = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const markdown = `> [!${kind.toUpperCase()}]\n${quotedBody}`;
  activeEditor.commands.insertContent(renderMarkdownForEditorWithAssets(markdown));
}

function setHeadingLevel(level: number | null) {
  const chain = (editor.value as any)?.chain().focus();
  if (!chain) return;
  if (level === null || level === 0) {
    chain.setParagraph().run();
    return;
  }
  chain.toggleHeading({ level }).run();
}

function insertImageByUrl() {
  insertMarkdownText("![图片描述](image-url)", 2, 6);
}

function insertParagraphAround(position: "before" | "after") {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return;
  const { $from } = state.selection;
  const insertAt = position === "before" ? $from.before() : $from.after();
  const tr = state.tr.insert(insertAt, paragraph.create());
  activeEditor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, insertAt + 1)).scrollIntoView());
  activeEditor.view.focus();
}

function runTableCommand(commandName: string) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return;
  const chain = activeEditor.chain().focus();
  switch (commandName) {
    case "addRowBefore":
      chain.addRowBefore().run();
      break;
    case "addRowAfter":
      chain.addRowAfter().run();
      break;
    case "addColumnBefore":
      chain.addColumnBefore().run();
      break;
    case "addColumnAfter":
      chain.addColumnAfter().run();
      break;
    case "deleteRow":
      chain.deleteRow().run();
      break;
    case "deleteColumn":
      chain.deleteColumn().run();
      break;
    case "deleteTable":
      chain.deleteTable().run();
      break;
    default:
      break;
  }
}

function insertTableRowAfterAndFocusFirstCell(view: any) {
  const activeEditor = editor.value as any;
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!activeEditor || !table || !activeCell || !view.dom.contains(table)) return false;
  const tableInfo = getSelectedTableInfo(view, table, activeCell);
  if (!tableInfo) return false;

  const row = activeCell.parentElement as HTMLTableRowElement | null;
  const rowIndex = row ? Array.from(table.rows).indexOf(row) : -1;
  if (rowIndex < 0) return false;

  const inserted = activeEditor.chain().focus().addRowAfter().run();
  if (!inserted) return false;

  window.setTimeout(() => {
    focusTableCellAt(tableInfo.pos, rowIndex + 1, 0);
  }, 0);

  return true;
}

function focusTableCellAt(tablePos: number, rowIndex: number, columnIndex: number) {
  const activeEditor = editor.value as any;
  if (!activeEditor) return false;
  const { doc } = activeEditor.state;
  const cellStart = tableCellTextStart(doc, tablePos, rowIndex, columnIndex);
  if (typeof cellStart !== "number") return false;

  try {
    activeEditor.view.dispatch(
      activeEditor.state.tr
        .setSelection(TextSelection.near(activeEditor.state.doc.resolve(cellStart), 1))
        .scrollIntoView(),
    );
    activeEditor.view.focus();
    const tableDom = activeEditor.view.nodeDOM(tablePos);
    const table = tableDom instanceof HTMLTableElement
      ? tableDom
      : tableDom instanceof HTMLElement
        ? tableDom.querySelector("table")
        : null;
    const cell = table?.rows[rowIndex]?.cells[columnIndex] as HTMLTableCellElement | undefined;
    if (table instanceof HTMLTableElement && cell) updateTableControl(activeEditor.view, table, cell);
    return true;
  } catch {
    updateTableControl(activeEditor.view);
    return false;
  }
}

function tableCellTextStart(doc: any, tablePos: number, rowIndex: number, columnIndex: number) {
  const table = doc.nodeAt(tablePos);
  if (!table || table.type?.name !== "table") return null;

  let rowPos = tablePos + 1;
  for (let rowOffset = 0; rowOffset < table.childCount; rowOffset += 1) {
    const row = table.child(rowOffset);
    if (rowOffset !== rowIndex) {
      rowPos += row.nodeSize;
      continue;
    }

    let cellPos = rowPos + 1;
    for (let cellOffset = 0; cellOffset < row.childCount; cellOffset += 1) {
      const cell = row.child(cellOffset);
      if (cellOffset === columnIndex) {
        const firstChild = cell.firstChild;
        if (firstChild?.isTextblock) return cellPos + 2;
        return cellPos + 1;
      }
      cellPos += cell.nodeSize;
    }
  }

  return null;
}

function copyCurrentTable() {
  const table = getCurrentTableElement();
  if (!table) return;
  void writeClipboard(editorHtmlToMarkdown(table.outerHTML).trim(), table.outerHTML);
}

function copyFormattedTableSource() {
  const table = getCurrentTableElement();
  if (!table) return;
  void writeClipboard(formatMarkdownTableFromDom(table, serializeTableCell));
}

function getCurrentTableElement() {
  const activeEditor = editor.value;
  if (!activeEditor) return null;
  try {
    const dom = activeEditor.view.domAtPos(activeEditor.state.selection.from).node;
    const element = dom instanceof HTMLElement ? dom : dom.parentElement;
    const selectedTable = element?.closest("table");
    if (selectedTable) return selectedTable;
  } catch {
    // Fall through to the floating-toolbar target.
  }
  if (tableControl.value.visible && tableControl.value.tablePos >= 0) {
    const dom = activeEditor.view.nodeDOM(tableControl.value.tablePos);
    if (dom instanceof HTMLTableElement) return dom;
    if (dom instanceof HTMLElement) {
      if (dom.matches("table")) return dom as HTMLTableElement;
      const table = dom.querySelector("table");
      if (table instanceof HTMLTableElement) return table;
    }
  }
  return null;
}

function moveCurrentTableRow(direction: -1 | 1) {
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!table || !activeCell) return;
  const rowIndex = activeCell.parentElement ? Array.from(table.rows).indexOf(activeCell.parentElement as HTMLTableRowElement) : -1;
  const targetIndex = rowIndex + direction;
  if (rowIndex < 0 || targetIndex < 0 || targetIndex >= table.rows.length) return;
  swapTableRowContent(table.rows[rowIndex], table.rows[targetIndex]);
  replaceCurrentTableFromDom(table);
}

function moveCurrentTableColumn(direction: -1 | 1) {
  const table = getCurrentTableElement();
  const activeCell = getCurrentTableCell();
  if (!table || !activeCell) return;
  const columnIndex = activeCell.cellIndex;
  const targetIndex = columnIndex + direction;
  if (targetIndex < 0) return;
  Array.from(table.rows).forEach((row) => {
    if (targetIndex >= row.cells.length) return;
    const left = row.cells[columnIndex];
    const right = row.cells[targetIndex];
    if (!left || !right) return;
    const temp = left.innerHTML;
    left.innerHTML = right.innerHTML;
    right.innerHTML = temp;
  });
  replaceCurrentTableFromDom(table);
}

function swapTableRowContent(a: HTMLTableRowElement, b: HTMLTableRowElement) {
  const valuesA = Array.from(a.cells).map((cell) => cell.innerHTML);
  const valuesB = Array.from(b.cells).map((cell) => cell.innerHTML);
  Array.from(a.cells).forEach((cell, index) => {
    cell.innerHTML = valuesB[index] || "";
  });
  Array.from(b.cells).forEach((cell, index) => {
    cell.innerHTML = valuesA[index] || "";
  });
}

function getCurrentTableCell() {
  const activeEditor = editor.value;
  if (!activeEditor) return null;
  try {
    const dom = activeEditor.view.domAtPos(activeEditor.state.selection.from).node;
    const element = dom instanceof HTMLElement ? dom : dom.parentElement;
    const cell = element?.closest("td,th") as HTMLTableCellElement | null;
    if (cell) return cell;
  } catch {
    // Fall through to no current cell.
  }
  return null;
}

function replaceCurrentTableFromDom(table: HTMLTableElement) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const resolved = table.isConnected
    ? resolveTableNodeFromDom(activeEditor.view, table, getCurrentTableCell())
    : null;
  const fallback = resolved ? null : getSelectedTableInfo(activeEditor.view);
  const pos = resolved?.pos ?? fallback?.pos;
  const node = resolved?.node ?? fallback?.node;
  if (typeof pos !== "number" || !node) return;
  (activeEditor as any).commands.insertContentAt({ from: pos, to: pos + node.nodeSize }, table.outerHTML);
}

function indentCode(scope: "selection" | "block", delta: 1 | -1) {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const { from, to, $from } = state.selection;
  const blockFrom = scope === "block" ? $from.before() + 1 : from;
  const blockTo = scope === "block" ? $from.after() - 1 : to;
  const text = state.doc.textBetween(blockFrom, blockTo, "\n", "\n");
  const next = text
    .split("\n")
    .map((line) => (delta > 0 ? `  ${line}` : line.replace(/^ {1,2}/, "")))
    .join("\n");
  activeEditor.view.dispatch(state.tr.insertText(next, blockFrom, blockTo).scrollIntoView());
}

function deleteCodeBlock() {
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const { state } = activeEditor.view;
  const { $from } = state.selection;
  if ($from.parent.type.name !== "codeBlock") return;
  activeEditor.view.dispatch(state.tr.delete($from.before(), $from.after()).scrollIntoView());
}

function normalizeTableCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function docPosToMarkdownOffset(state: any, pos: number, markdown: string) {
  const docSize = state.doc.content.size;
  const target = clampDocPos(pos, docSize);
  if (target <= 0) return 0;
  const prefix = trimSyntheticMarkdownClosers(serializeDocRangeToMarkdown(state, 0, target), state, target);
  return clampMarkdownOffset(prefix.length, markdown);
}

function trimSyntheticMarkdownClosers(prefix: string, state: any, pos: number) {
  const marks = activeMarksAtDocPos(state, pos);
  let next = prefix;
  if (marks.has("link")) next = next.replace(/\]\([^)\n]*\)$/, "");
  if (marks.has("bold")) next = trimSuffix(next, "**");
  if (marks.has("strike")) next = trimSuffix(next, "~~");
  if (marks.has("highlight")) next = trimSuffix(next, "==");
  if (marks.has("code")) next = trimSuffix(next, "`");
  if (marks.has("italic")) next = trimSuffix(next, "*");
  if (marks.has("superscript")) next = trimSuffix(next, "^");
  if (marks.has("subscript")) next = trimSuffix(next, "~");
  return next;
}

function activeMarksAtDocPos(state: any, pos: number) {
  const docSize = state.doc.content.size;
  const safePos = clampDocPos(pos, docSize);
  const resolved = state.doc.resolve(safePos);
  const marks = new Set<string>((resolved.marks?.() || []).map((mark: any) => mark.type.name));
  const before = safePos > 0 ? state.doc.resolve(safePos - 1).marks?.() || [] : [];
  before.forEach((mark: any) => marks.add(mark.type.name));
  return marks;
}

function trimSuffix(value: string, suffix: string) {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function serializeDocRangeToMarkdown(state: any, from: number, to: number) {
  if (to <= from) return "";
  const slice = state.doc.slice(from, to);
  const serializer = DOMSerializer.fromSchema(state.schema);
  const div = document.createElement("div");
  div.appendChild(serializer.serializeFragment(slice.content));
  return editorHtmlToMarkdown(div.innerHTML);
}

function markdownOffsetToDocPos(state: any, offset: number, markdown: string) {
  const targetPlainOffset = plainMarkdownLength(markdown.slice(0, clampMarkdownOffset(offset, markdown)));
  return textOffsetToDocumentPos(state, targetPlainOffset);
}

function textOffsetToDocumentPos(state: any, targetOffset: number) {
  let remaining = Math.max(0, targetOffset);
  let fallbackPos = 1;
  let found: number | null = null;

  state.doc.descendants((node: any, pos: number) => {
    if (found !== null) return false;
    if (node.isText && typeof node.text === "string") {
      fallbackPos = pos + node.nodeSize;
      if (remaining <= node.text.length) {
        found = pos + remaining;
        return false;
      }
      remaining -= node.text.length;
      return false;
    }
    if (node.isBlock && pos > 0) {
      fallbackPos = pos + 1;
      if (remaining === 0 && node.isTextblock) {
        found = pos + 1;
        return false;
      }
      if (pos > 0 && remaining > 0) remaining -= 1;
    }
    return true;
  });

  return found ?? fallbackPos;
}

function plainMarkdownLength(markdown: string) {
  return markdownToPlainText(markdown).length;
}

function markdownToPlainText(markdown: string) {
  return markdown
    .replace(/^(?:\uFEFF)?---[^\S\r\n]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?=\r?\n|$)/, "")
    .replace(/```[\w#+.-]*\n([\s\S]*?)\n```/g, "$1")
    .replace(/\$\$\s*\n?([\s\S]*?)\n?\s*\$\$/g, "$1")
    .replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/gim, "")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)([-*+]|\d+\.)\s+\[[ xX]\]\s+/gm, "")
    .replace(/^(\s*)([-*+]|\d+\.)\s+/gm, "")
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
    .replace(/\[\^([^\]\n]+)\]/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/\n{2,}/g, "\n");
}

function clampMarkdownOffset(value: number, markdown: string) {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, markdown.length));
}

function clampDocPos(value: number, docSize: number) {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, docSize));
}

function renderFootnotesView(dom: HTMLElement, markdown: string, fallbackHtml: string) {
  dom.innerHTML = "";
  const source = markdown.trim();
  if (!source) {
    dom.innerHTML = renderInlineMarkdownInHtml(fallbackHtml);
    return;
  }

  const list = document.createElement("ol");
  list.className = "footnotes-list";
  parseFootnoteSource(source).forEach((definition) => {
    const block = document.createElement("li");
    block.id = `fn-${definition.id}`;
    block.className = "footnote-item";
    const index = definition.order || definition.id;

    const marker = document.createElement("span");
    marker.className = "footnote-id";
    marker.textContent = `[${index}]`;

    const content = document.createElement("div");
    content.className = "footnote-content";
    content.innerHTML = renderMarkdownForEditorWithAssets(definition.content || " ");
    content.title = definition.refs.length > 0 ? "点击返回正文引用" : "";
    content.addEventListener("click", () => {
      const firstRef = definition.refs[0];
      if (firstRef) scrollInternalLink(`#${firstRef}`);
    });

    block.append(marker, content);
    const backrefs = document.createElement("div");
    backrefs.className = "footnote-backrefs";
    definition.refs.forEach((refId, index) => {
      const backref = document.createElement("button");
      backref.type = "button";
      backref.className = "footnote-backref";
      backref.dataset.footnoteTarget = `#${refId}`;
      backref.textContent = `返回${index + 1}`;
      backref.addEventListener("click", () => scrollInternalLink(`#${refId}`));
      backrefs.appendChild(backref);
    });
    block.appendChild(backrefs);
    list.appendChild(block);
  });
  dom.appendChild(list);
}

function parseFootnoteSource(markdown: string) {
  const definitions = markdown.split(/\n{2,}(?= {0,3}\[\^[^\]]+\]:)/).map((item) => item.trim()).filter(Boolean);
  const refMeta = collectFootnoteRefMeta();
  return definitions.map((raw, orderIndex) => {
    const id = raw.match(/^ {0,3}\[\^([^\]]+)\]:/)?.[1] || "";
    const content = raw
      .replace(/^ {0,3}\[\^[^\]]+\]:\s*/, "")
      .replace(/^\n+/, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^( {4}|\t)/, ""))
      .join("\n")
      .trim();
    const meta = refMeta.get(id);
    return { id, raw, content, refs: meta?.refs || [], order: meta?.order || orderIndex + 1 };
  }).sort((left, right) => left.order - right.order);
}

function collectFootnoteRefMeta() {
  const meta = new Map<string, { order: number; refs: string[] }>();
  document.querySelectorAll<HTMLElement>('span[data-type="footnote-ref"][data-footnote-ref][data-ref-id]').forEach((item) => {
    const id = item.dataset.footnoteRef || "";
    if (!id) return;
    const order = Number(item.dataset.footnoteIndex || meta.size + 1);
    const entry = meta.get(id) || { order, refs: [] };
    entry.order = Math.min(entry.order, order);
    if (item.dataset.refId) entry.refs.push(item.dataset.refId);
    meta.set(id, entry);
  });
  document.querySelectorAll<HTMLElement>('sup[data-footnote-ref][data-footnote-index]').forEach((item) => {
    const id = item.dataset.footnoteRef || "";
    if (!id) return;
    const order = Number(item.dataset.footnoteIndex || meta.size + 1);
    const entry = meta.get(id) || { order, refs: [] };
    entry.order = Math.min(entry.order, order);
    item.querySelectorAll<HTMLElement>("a[id]").forEach((link) => {
      if (link.id) entry.refs.push(link.id);
    });
    meta.set(id, entry);
  });
  return meta;
}

function formatFootnotePreview(value: string) {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function convertInlineCodeBeforeCursor(view: any) {
  const { state } = view;
  const { $from, empty } = state.selection;
  const codeMark = state.schema.marks.code;
  if (!empty || !codeMark || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;

  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const openerOffset = findInlineCodeOpener(before);
  if (openerOffset < 0) return false;

  const code = before.slice(openerOffset + 1);
  if (!code || /`/.test(code)) return false;

  const cursorPos = state.selection.from;
  const openerPos = cursorPos - (before.length - openerOffset);
  const tr = state.tr.insertText(code, openerPos, cursorPos);
  tr.addMark(openerPos, openerPos + code.length, codeMark.create());
  tr.removeStoredMark(codeMark);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function findInlineCodeOpener(text: string) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "`") continue;
    if (index > 0 && text[index - 1] === "\\") continue;
    return index;
  }
  return -1;
}

function createMarkDecorations(state: any, markName: string, open: string, close: string) {
  const range = getActiveMarkRange(state, markName);
  if (!range) return createStoredMarkDecorations(state, markName, open, close);
  return [
    Decoration.widget(range.from, () => createSourceMarker(open), createMarkerSpec(-1, `${markName}-open-${range.from}`)),
    Decoration.widget(range.to, () => createSourceMarker(close), createMarkerSpec(1, `${markName}-close-${range.to}`)),
  ];
}

function createStoredMarkDecorations(state: any, markName: string, open: string, close: string) {
  if (!state.selection.empty) return [];
  const markType = state.schema.marks[markName];
  if (!markType || !(state.storedMarks || []).some((mark: any) => mark.type === markType)) return [];

  const pos = state.selection.from;
  return [
    Decoration.widget(pos, () => createSourceMarker(open), createMarkerSpec(-1, `${markName}-stored-open-${pos}`)),
    Decoration.widget(pos, () => createSourceMarker(close), createMarkerSpec(1, `${markName}-stored-close-${pos}`)),
  ];
}

function createLinkDecorations(state: any) {
  const range = getActiveMarkRange(state, "link");
  if (!range) return [];
  const href = range.mark.attrs.href || "";
  return [
    Decoration.widget(range.from, () => createSourceMarker("["), createMarkerSpec(-1, `link-open-${range.from}`)),
    Decoration.widget(range.to, () => createSourceMarker(`](${href})`), createMarkerSpec(1, `link-close-${range.to}`)),
  ];
}

function createHeadingDecorations(state: any) {
  if (!state.selection.empty) return [];
  const { $from } = state.selection;
  if ($from.parent.type.name !== "heading") return [];

  const level = $from.parent.attrs.level || 1;
  return [
    Decoration.widget($from.start(), () => createSourceMarker(`${"#".repeat(level)} `), {
      side: -1,
      key: `heading-marker-${$from.before()}`,
      ignoreSelection: true,
    }),
  ];
}

function createOutlineHeadingDecorations(state: any) {
  const derived = getWysiwygDerivedState(state);
  const collapsedKeys = getPaneTab(props.paneId)?.collapsedHeadingKeys ?? [];
  const collapsedSignature = collapsedKeys.join("\u0000");
  if (
    outlineDecorationCache?.state === derived &&
    outlineDecorationCache.epoch === outlineDecorationEpoch &&
    outlineDecorationCache.collapsed === collapsedSignature
  ) return outlineDecorationCache.value;
  const decorations: any[] = [];
  const blocks = derived.blocks;
  const headings = derived.headings;
  const structured = wysiwygStructuredOutline(state);
  const collapsed = new Set(collapsedKeys);
  const hiddenBlockPositions = new Set<number>();

  headings.forEach((heading, index) => {
    const item = structured[index];
    if (!item) return;
    const isCollapsed = collapsed.has(item.key);
    decorations.push(
      Decoration.node(heading.pos, heading.pos + heading.node.nodeSize, {
        "data-outline-id": item.id,
        "data-outline-key": item.key,
        "data-outline-line": String(item.line),
        class: isCollapsed ? "lm-heading-is-collapsed" : "",
      }),
      Decoration.widget(
        heading.pos,
        () => createWysiwygHeadingFoldButton(item, isCollapsed),
        {
          side: -4,
          key: `heading-fold-toggle-${item.key}-${isCollapsed ? "closed" : "open"}`,
          ignoreSelection: true,
          stopEvent: (event: Event) => event.target instanceof globalThis.Node,
        },
      ),
    );
    if (!isCollapsed) return;
    let hiddenBlocks = 0;
    for (let cursor = heading.blockIndex + 1; cursor < blocks.length; cursor += 1) {
      const candidate = blocks[cursor];
      if (candidate.node.type.name === "heading" && candidate.node.attrs.level <= item.level) break;
      hiddenBlockPositions.add(candidate.pos);
      hiddenBlocks += 1;
    }
    if (hiddenBlocks > 0) {
      decorations.push(
        Decoration.widget(
          heading.pos + heading.node.nodeSize,
          () => createWysiwygHeadingFoldSummary(hiddenBlocks),
          {
            side: 4,
            key: `heading-fold-summary-${item.key}-${hiddenBlocks}`,
            ignoreSelection: true,
          },
        ),
      );
    }
  });
  for (const block of blocks) {
    if (!hiddenBlockPositions.has(block.pos)) continue;
    decorations.push(
      Decoration.node(block.pos, block.pos + block.node.nodeSize, {
        class: "lm-heading-fold-hidden",
        "aria-hidden": "true",
      }),
    );
  }
  const value = decorations as Decoration[];
  outlineDecorationCache = { state: derived, epoch: outlineDecorationEpoch, collapsed: collapsedSignature, value };
  return value;
}

function createExposedMarkdownDecorations(state: any, exposed: ExposedMarkdownRange) {
  const decorations: Decoration[] = [];
  if (exposed.kind === "heading" && exposed.headingInvalid) return decorations;
  const max = state.doc.content.size;
  const from = Math.max(0, Math.min(exposed.from, max));
  const openTo = Math.max(from, Math.min(from + exposed.open.length, max));
  const closeFrom = Math.max(openTo, Math.min(exposed.to - exposed.close.length, max));
  const to = Math.max(closeFrom, Math.min(exposed.to, max));
  if (openTo > from) decorations.push(Decoration.inline(from, openTo, { class: "md-live-marker" }));
  if (to > closeFrom) decorations.push(Decoration.inline(closeFrom, to, { class: "md-live-marker" }));
  return decorations;
}

function currentCollapsedHeadingSignature() {
  return (getPaneTab(props.paneId)?.collapsedHeadingKeys ?? []).join("\u0000");
}

function buildOutlineHeadingDecorationState(state: any) {
  const collapsed = currentCollapsedHeadingSignature();
  const decorations = createOutlineHeadingDecorations(state);
  return {
    decorations: decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty,
    epoch: outlineDecorationEpoch,
    collapsed,
  };
}

function canMapOutlineHeadingDecorations(oldState: any, newState: any) {
  return getWysiwygDerivedState(oldState).headingContentRevision === getWysiwygDerivedState(newState).headingContentRevision;
}

function wysiwygStructuredOutline(state: any) {
  const derived = getWysiwygDerivedState(state);
  return derived.outline;
}

function createWysiwygHeadingFoldButton(item: StructuredOutlineItem, collapsed: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `lm-heading-fold-toggle${collapsed ? " collapsed" : ""}`;
  button.contentEditable = "false";
  button.tabIndex = 0;
  button.textContent = collapsed ? "›" : "⌄";
  button.title = `${collapsed ? "展开" : "折叠"} ${item.text}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleHeadingFoldByKey(props.paneId, item.key);
  });
  return button;
}

function createWysiwygHeadingFoldSummary(hiddenBlocks: number) {
  const summary = document.createElement("span");
  summary.className = "lm-heading-fold-summary";
  summary.contentEditable = "false";
  summary.textContent = `… ${hiddenBlocks} 个块`;
  return summary;
}

function getEventElement(event: Event) {
  const target = event.target;
  if (target instanceof HTMLElement) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
}

function convertPendingMarkdownBeforeMouseSelection(view: any, event: MouseEvent) {
  if (event.button !== 0 || !view.state.selection.empty) return false;

  const clickPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!clickPos || !isClickOutsideSelectionBlock(view.state, clickPos.pos)) return false;

  let tr =
    convertBlockquoteMarkdown(view.state, { force: true, onlySelectionBlock: true }) ||
    convertHorizontalRuleMarkdown(view.state, { force: true, onlySelectionBlock: true }) ||
    convertMarkdownHeading(view.state, { force: true, onlySelectionBlock: true }) ||
    convertInlineCodeSyntax(view.state, { onlySelectionBlock: true }) ||
    convertInlineMarkdownSyntax(view.state, { onlySelectionBlock: true });
  if (!tr) return false;

  const mappedPos = Math.max(0, Math.min(tr.mapping.map(clickPos.pos, clickPos.pos >= view.state.selection.from ? 1 : -1), tr.doc.content.size));
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mappedPos), clickPos.pos >= view.state.selection.from ? 1 : -1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  event.preventDefault();
  return true;
}

function isClickOutsideSelectionBlock(state: any, pos: number) {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return false;
  const blockFrom = $from.before();
  const blockTo = $from.after();
  return pos <= blockFrom || pos >= blockTo;
}

function scrollInternalLink(href: string) {
  if (!href.startsWith("#")) return;
  const id = decodeURIComponent(href.slice(1));
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function handleJumpHeading(event: CustomEvent<{ id?: string; text?: string; line?: number; paneId?: EditorPaneId }>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  if (typeof event.detail?.line === "number") revealHeadingAtLine(props.paneId, event.detail.line);
  const id = event.detail?.id;
  const target = id ? document.querySelector<HTMLElement>(`.ProseMirror [data-outline-id="${cssEscape(id)}"]`) : null;
  const fallback = event.detail?.text ? findHeadingByText(event.detail.text) : null;
  const heading = target || fallback;
  const activeEditor = editor.value;
  if (!heading || !activeEditor) return;
  const position = activeEditor.view.posAtDOM(heading, 0);
  activeEditor.view.dispatch(
    activeEditor.view.state.tr
      .setSelection(TextSelection.near(activeEditor.view.state.doc.resolve(position + 1)))
      .scrollIntoView(),
  );
  if (typeof event.detail?.line === "number") {
    const line = Math.max(0, event.detail.line);
    appStore.paneContextLines[props.paneId] = line;
    updatePaneOutlineAnchor(props.paneId, line, "navigation");
    window.requestAnimationFrame(() => {
      appStore.paneContextLines[props.paneId] = line;
    });
  }
  activeEditor.view.focus();
}

function handleKnowledgeOccurrence(event: CustomEvent<{ paneId?: EditorPaneId; line?: number; from?: number; to?: number }>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  const activeEditor = editor.value;
  if (!activeEditor) return;
  const markdown = paneContent.value;
  const fromOffset = typeof event.detail?.from === "number"
    ? event.detail.from
    : markdownLineStartOffset(markdown, event.detail?.line ?? 0);
  const toOffset = typeof event.detail?.to === "number" ? event.detail.to : fromOffset;
  const targetLine = Math.max(0, event.detail?.line ?? markdownLineAtOffset(markdown, fromOffset));
  revealHeadingAtLine(props.paneId, targetLine);
  const from = markdownOffsetToDocPos(activeEditor.view.state, fromOffset, markdown);
  const to = markdownOffsetToDocPos(activeEditor.view.state, toOffset, markdown);
  activeEditor.view.dispatch(
    activeEditor.view.state.tr
      .setSelection(TextSelection.create(activeEditor.view.state.doc, clampDocPos(from, activeEditor.view.state.doc.content.size), clampDocPos(to, activeEditor.view.state.doc.content.size)))
      .scrollIntoView(),
  );
  appStore.paneContextLines[props.paneId] = Math.max(0, event.detail?.line ?? 0);
  updatePaneOutlineAnchor(props.paneId, targetLine, "navigation");
  activeEditor.view.focus();
}

function markdownLineStartOffset(markdown: string, line: number) {
  let offset = 0;
  const target = Math.max(0, Math.floor(line));
  for (let index = 0; index < target; index += 1) {
    const next = markdown.indexOf("\n", offset);
    if (next < 0) return markdown.length;
    offset = next + 1;
  }
  return offset;
}

function handleJumpMath(event: CustomEvent<{ targetId?: string; paneId?: EditorPaneId }>) {
  if (props.paneId !== appStore.splitLayout.activePaneId || paneEditorMode.value !== "wysiwyg" || paneDocumentMode.value !== "normal") return;
  if (event.detail?.paneId && event.detail.paneId !== props.paneId) return;
  const targetId = event.detail?.targetId;
  const activeEditor = editor.value;
  if (!targetId || !activeEditor) return;
  const target = activeEditor.view.dom.querySelector<HTMLElement>(`#${cssEscape(targetId)}`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("math-equation-flash");
  requestAnimationFrame(() => target.classList.add("math-equation-flash"));
  window.setTimeout(() => target.classList.remove("math-equation-flash"), 1400);
}

function findHeadingByText(text: string) {
  const expected = normalizeHeadingText(text);
  return (
    Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6")).find((heading) => {
      return normalizeHeadingText(heading.textContent || "") === expected;
    }) || null
  );
}

function normalizeHeadingText(value: string) {
  return value.replace(/[#*_`[\]()]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function openExternalLink(href: string) {
  try {
    await openUrl(href);
  } catch (error) {
    console.error("打开链接失败", error);
  }
}

function getActiveMarkRange(state: any, markName: string) {
  const markType = state.schema.marks[markName];
  if (!markType || !state.selection.empty) return null;

  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;

  const storedMark = (state.storedMarks || []).find((mark: any) => mark.type === markType);
  const activeMark = storedMark || $from.marks().find((mark: any) => mark.type === markType);
  if (!activeMark) return null;

  const parentStart = $from.start();
  const cursorOffset = $from.parentOffset;
  const children: Array<{ node: any; offset: number }> = [];
  $from.parent.forEach((node: any, offset: number) => children.push({ node, offset }));

  const hasActiveMark = (node: any) => Boolean(activeMark.isInSet(node.marks));
  let activeIndex = children.findIndex(({ node, offset }) => {
    return hasActiveMark(node) && cursorOffset >= offset && cursorOffset <= offset + node.nodeSize;
  });

  if (activeIndex < 0) {
    activeIndex = children.findIndex(({ node, offset }) => {
      return hasActiveMark(node) && (cursorOffset === offset || cursorOffset === offset + node.nodeSize);
    });
  }

  if (activeIndex < 0) return null;

  let startIndex = activeIndex;
  let endIndex = activeIndex;
  while (startIndex > 0 && hasActiveMark(children[startIndex - 1].node)) startIndex -= 1;
  while (endIndex < children.length - 1 && hasActiveMark(children[endIndex + 1].node)) endIndex += 1;

  const from = parentStart + children[startIndex].offset;
  const endChild = children[endIndex];
  const to = parentStart + endChild.offset + endChild.node.nodeSize;
  const atRightBoundary = cursorOffset === endChild.offset + endChild.node.nodeSize;
  if (!storedMark && atRightBoundary) return null;
  return { from, to, mark: activeMark };
}

function restoreExposedMarkdownWhenOutside(view: any, force = false, flushId?: string) {
  const exposed = exposedMarkdownLifecycleKey.getState(view.state);
  if (!exposed) return false;
  if (exposed.kind === "heading" && exposed.headingInvalid) return false;
  const { from, to } = view.state.selection;
  if (!force && from === to && from >= exposed.from && from <= exposed.to) return false;

  const options = { targetBlockFrom: exposed.blockFrom };
  let tr = exposed.kind === "heading"
    ? convertMarkdownHeading(view.state, { force: true, ...options })
    : convertInlineCodeSyntax(view.state, options) || convertInlineMarkdownSyntax(view.state, options);
  if (!tr) {
    view.dispatch(view.state.tr
      .setMeta(clearExposeMarkdownMeta, true)
      .setMeta(markdownPresentationMeta, true)
      .setMeta("addToHistory", false));
    return false;
  }
  if (flushId) tr = tr.setMeta(DOCUMENT_FLUSH_META_KEY, flushId);
  view.dispatch(tr
    .setMeta(clearExposeMarkdownMeta, true)
    .setMeta(markdownPresentationMeta, true)
    .setMeta("addToHistory", false)
    .scrollIntoView());
  return true;
}

async function finalizeMarkdownExposure(view: any, flushId?: string) {
  if (view.composing) {
    await new Promise<void>((resolve) => {
      view.dom.addEventListener("compositionend", () => resolve(), { once: true });
    });
  }
  reconcileExposedHeading(view, flushId);
  restoreExposedMarkdownWhenOutside(view, true, flushId);
}

function handleExposedMarkdownDeletion(view: any, event: KeyboardEvent) {
  if (event.key !== "Backspace" && event.key !== "Delete") return false;
  const exposed = exposedMarkdownLifecycleKey.getState(view.state);
  if (!exposed) return false;
  if (exposed.kind === "heading" && exposed.headingInvalid) return false;
  const selection = view.state.selection;
  const deletionFrom = selection.empty
    ? selection.from + (event.key === "Backspace" ? -1 : 0)
    : selection.from;
  const deletionTo = selection.empty ? deletionFrom + 1 : selection.to;
  const openFrom = exposed.from;
  const openTo = openFrom + exposed.open.length;
  const closeFrom = exposed.to - exposed.close.length;
  const touchesOpen = deletionFrom < openTo && deletionTo > openFrom;
  const touchesClose = exposed.close.length > 0 && deletionFrom < exposed.to && deletionTo > closeFrom;
  if (!touchesOpen && !touchesClose) return false;

  event.preventDefault();
  let tr = removeExposedMarkdownFormatting(view.state, exposed, touchesOpen ? "open" : "close");
  if (tr && !selection.empty) {
    const mappedFrom = tr.mapping.map(selection.from, -1);
    const mappedTo = tr.mapping.map(selection.to, 1);
    if (mappedTo > mappedFrom) tr = tr.delete(mappedFrom, mappedTo);
    tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(mappedFrom, tr.doc.content.size)));
  }
  if (tr) view.dispatch(tr.scrollIntoView());
  return true;
}

function handleExposedMarkdownTextInput(view: any, from: number, to: number, text: string) {
  const exposed = exposedMarkdownLifecycleKey.getState(view.state);
  if (!exposed) return false;
  const openFrom = exposed.from;
  const openTo = openFrom + exposed.open.length;
  const closeFrom = exposed.to - exposed.close.length;
  const intersects = (rangeFrom: number, rangeTo: number) => from === to
    ? from > rangeFrom && from < rangeTo
    : from < rangeTo && to > rangeFrom;
  const touchesOpen = intersects(openFrom, openTo);
  const touchesClose = exposed.close.length > 0 && intersects(closeFrom, exposed.to);
  if (!touchesOpen && !touchesClose) return false;
  let tr = removeExposedMarkdownFormatting(view.state, exposed, touchesOpen ? "open" : "close");
  if (!tr) return false;
  if (to > from) {
    const mappedFrom = tr.mapping.map(from, -1);
    const mappedTo = tr.mapping.map(to, 1);
    if (mappedTo > mappedFrom) tr = tr.delete(mappedFrom, mappedTo);
    tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(mappedFrom, tr.doc.content.size)));
  }
  if (text) tr = tr.insertText(text, tr.selection.from, tr.selection.to);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function reconcileExposedHeading(view: any, flushId?: string) {
  const exposed = exposedMarkdownLifecycleKey.getState(view.state);
  if (!exposed || exposed.kind !== "heading") return false;
  let tr = reconcileExposedHeadingTransaction(view.state, exposed);
  if (!tr) return false;
  if (flushId) tr = tr.setMeta(DOCUMENT_FLUSH_META_KEY, flushId);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function exposeMarkdownBeforeCursorMove(view: any, event: KeyboardEvent) {
  const directions = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  } as const;
  const direction = directions[event.key as keyof typeof directions];
  if (!direction || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (!view.state.selection.empty || exposedMarkdownLifecycleKey.getState(view.state)) return false;
  const tr = exposeMarkdownAtCursor(view.state, direction);
  if (!tr) return false;
  view.dispatch(tr.scrollIntoView());
  return true;
}

function exitEmptyStoredFormattingOnBackspace(view: any) {
  const { state } = view;
  if (!state.selection.empty) return false;
  const activeStoredMarks = (state.storedMarks || []).filter((mark: any) => typoraInlineMarkNames.includes(mark.type.name));
  if (!activeStoredMarks.length) return false;

  const hasRenderedContent = activeStoredMarks.some((mark: any) => getActiveMarkRange(state, mark.type.name));
  if (hasRenderedContent) return false;

  let tr = state.tr.setStoredMarks([]);
  activeStoredMarks.forEach((mark: any) => {
    tr = tr.removeStoredMark(mark.type);
  });
  view.dispatch(tr.scrollIntoView());
  return true;
}

function clearStoredMarks(view: any, markNames: string[]) {
  const { state } = view;
  let tr = state.tr;
  let changed = false;
  markNames.forEach((markName) => {
    const markType = state.schema.marks[markName];
    if (!markType) return;
    tr = tr.removeStoredMark(markType);
    changed = true;
  });
  if (changed) view.dispatch(tr);
}

function createMarkerSpec(side: -1 | 1, key: string) {
  return { side, key, ignoreSelection: true };
}

function createSourceMarker(text: string) {
  const marker = document.createElement("span");
  marker.className = "md-live-marker";
  marker.dataset.markdownMarker = text;
  marker.textContent = text;
  marker.contentEditable = "false";
  marker.draggable = false;
  return marker;
}

function convertPendingInlineMarkdown(view: any) {
  let converted = false;
  for (let index = 0; index < 12; index += 1) {
    const tr = convertInlineCodeSyntax(view.state) || convertInlineMarkdownSyntax(view.state);
    if (!tr) break;
    view.dispatch(tr);
    converted = true;
  }
  return converted;
}

function markdownShortcutEnabled() {
  return (
    props.paneId === appStore.splitLayout.activePaneId &&
    paneDocumentMode.value === "normal" &&
    paneEditorMode.value === "wysiwyg"
  );
}

function hasAncestorNode($pos: any, names: string[]) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (names.includes($pos.node(depth)?.type?.name)) return true;
  }
  return false;
}

function isMarkdownShortcutProtected(state: any) {
  const { $from } = state.selection;
  return hasAncestorNode($from, [
    "codeBlock",
    "tableCell",
    "tableHeader",
    "frontMatter",
    "htmlBlock",
    "rawHtml",
    "blockMath",
    "mermaid",
    "footnotes",
  ]);
}

function handleWysiwygMarkdownShortcutText(view: any, from: number, to: number, text: string) {
  if (!markdownShortcutEnabled() || from !== to || view.composing || isMarkdownShortcutProtected(view.state)) return false;
  const { $from } = view.state.selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false;
  const prefix = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const insideListItem = hasAncestorNode($from, ["listItem"]);
  const match = detectMarkdownShortcut({
    text: prefix,
    insertedText: text,
    trigger: "text",
    protectedContext: false,
    insideListItem,
  });
  if (!match) return false;
  view.dispatch(closeHistory(view.state.tr.insertText(text, from, to)));
  if (match.kind === "task") {
    convertTaskShortcut(view, match);
    return true;
  }
  if (match.kind === "footnote-reference") {
    convertFootnoteReferenceShortcut(view, match);
    return true;
  }
  return false;
}

function handleWysiwygMarkdownShortcutEnter(view: any) {
  const { state } = view;
  if (!markdownShortcutEnabled() || !state.selection.empty || view.composing || isMarkdownShortcutProtected(state)) return false;
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false;
  const insideBlockquote = hasAncestorNode($from, ["blockquote"]);
  const match = detectMarkdownShortcut({
    text: $from.parent.textContent,
    trigger: "enter",
    atDocumentStart: $from.depth === 1 && $from.before(1) === 0,
    insideBlockquote,
  });
  if (!match) return false;

  // Keep the literal trigger as the previous history event. One undo then
  // reveals exactly what the user typed instead of deleting the whole input.
  view.dispatch(closeHistory(state.tr));
  const conversionState = view.state;

  if (match.kind === "table") return convertMarkdownPipeTable(view);
  if (match.kind === "footnote-definition") return convertFootnoteDefinitionShortcut(view, match);
  if (match.kind === "blockquote" || match.kind === "alert") {
    const tr = convertBlockquoteMarkdown(conversionState, {
      force: true,
      onlySelectionBlock: true,
      insertParagraph: true,
    });
    if (!tr) return false;
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  if (match.kind === "horizontal-rule") {
    const tr = convertHorizontalRuleMarkdown(conversionState, {
      force: true,
      onlySelectionBlock: true,
      insertParagraph: true,
    });
    if (!tr) return false;
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  return false;
}

function convertTaskShortcut(view: any, match: Extract<MarkdownShortcutMatch, { kind: "task" }>) {
  const { state } = view;
  const { $from } = state.selection;
  if (!hasAncestorNode($from, ["listItem"])) return false;
  const markType = state.schema.marks.taskState;
  if (!markType) return false;
  const mark = markType.create({ state: match.checked ? "checked" : "unchecked" });
  const paragraphStart = $from.start();
  const placeholder = state.schema.text(" ", [mark]);
  const tr = state.tr.replaceWith(paragraphStart, $from.pos, placeholder);
  tr.setSelection(TextSelection.create(tr.doc, paragraphStart + 1));
  tr.setStoredMarks([mark]);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function convertFootnoteReferenceShortcut(
  view: any,
  match: Extract<MarkdownShortcutMatch, { kind: "footnote-reference" }>,
) {
  const { state } = view;
  const { $from } = state.selection;
  const type = state.schema.nodes.footnoteRef;
  if (!type) return false;
  let index = 1;
  let occurrence = 1;
  state.doc.descendants((node: any) => {
    if (node.type?.name !== "footnoteRef") return true;
    index += 1;
    if (node.attrs.id === match.id) occurrence += 1;
    return true;
  });
  const start = $from.start() + match.from;
  const node = type.create({
    id: match.id,
    index: String(index),
    refId: `fnref-${match.id}-${occurrence}`,
    preview: footnotePreviewFromState(state, match.id),
  });
  const tr = state.tr.replaceWith(start, $from.pos, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(start + node.nodeSize), 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function convertFootnoteDefinitionShortcut(
  view: any,
  match: Extract<MarkdownShortcutMatch, { kind: "footnote-definition" }>,
) {
  const { state } = view;
  const { $from } = state.selection;
  const type = state.schema.nodes.footnotes;
  const paragraph = state.schema.nodes.paragraph;
  if (!type || !paragraph) return false;
  const markdown = `[^${match.id}]:${match.text ? ` ${match.text}` : ""}`;
  const definition = type.create({ markdown, html: "", editing: false });
  const from = $from.before();
  const to = $from.after();
  let tr = state.tr.replaceWith(from, to, definition);
  const after = from + definition.nodeSize;
  tr = tr.insert(after, paragraph.create());
  tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function footnotePreviewFromState(state: any, id: string) {
  let preview = "";
  state.doc.descendants((node: any) => {
    if (preview || node.type?.name !== "footnotes") return true;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(node.attrs.markdown || "").match(new RegExp(`^ {0,3}\\[\\^${escaped}\\]:\\s*(.*)$`, "m"));
    if (match) preview = match[1].trim();
    return !preview;
  });
  return preview;
}

function convertMarkdownPipeTable(view: any) {
  const activeEditor = editor.value;
  if (!activeEditor) return false;
  const { state } = view;
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  const node = $from.parent;
  if (!node?.isTextblock || node.type.name === "codeBlock") return false;

  const html = markdownPipeRowToTableHtml(node.textContent);
  if (!html) return false;

  const from = $from.before();
  const to = $from.after();
  (activeEditor as any).commands.insertContentAt({ from, to }, html);
  window.setTimeout(() => {
    if (!focusTableCellAt(from, 1, 0)) updateTableControl(view);
  }, 0);
  return true;
}

function convertBlockquoteMarkdown(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false } = options;
  const blockquote = state.schema.nodes.blockquote;
  const paragraph = state.schema.nodes.paragraph;
  if (!blockquote || !paragraph) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const parentPos = state.doc.resolve(pos);
    const blockquoteRange = findParentBlockquote(parentPos);
    const insideBlockquote = Boolean(blockquoteRange);
    const text = node.textContent.trim();
    const canConvertInnerAlert = insideBlockquote && blockquoteRange && !blockquoteRange.node.attrs.alert;
    const alertMatch = canConvertInnerAlert
      ? text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i)
      : text.match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i);
    const quoteMatch = text.match(/^(>+)\s+(.*)$/);

    if (alertMatch) {
      const kind = alertMatch[1].toLowerCase();
      const body = (alertMatch[2] || "").trim();
      const bodyParagraph = body ? paragraph.create(null, state.schema.text(body)) : paragraph.create();
      const content = [bodyParagraph];

      if (blockquoteRange) {
        const alertNode = blockquote.create({ ...blockquoteRange.node.attrs, alert: kind }, content);
        tr = tr.replaceWith(
          blockquoteRange.pos,
          blockquoteRange.pos + blockquoteRange.node.nodeSize,
          alertNode,
        );
        const selectionPos = blockquoteRange.pos + 2 + body.length;
        tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos));
      } else {
        const alertNode = blockquote.create({ alert: kind }, content);
        tr = tr.replaceWith(pos, pos + node.nodeSize, alertNode);
        const selectionPos = pos + 2 + body.length;
        tr = tr.setSelection(TextSelection.create(tr.doc, selectionPos));
      }
      converted = true;
      return false;
    }

    if (!insideBlockquote && quoteMatch) {
      const depth = quoteMatch[1].length;
      const body = quoteMatch[2];
      let quote = blockquote.create(null, [
        body ? paragraph.create(null, state.schema.text(body)) : paragraph.create(),
        paragraph.create(),
      ]);
      for (let level = 1; level < depth; level += 1) quote = blockquote.create(null, quote);
      tr = tr.replaceWith(pos, pos + node.nodeSize, quote);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + quote.nodeSize - 1), -1));
      converted = true;
      return false;
    }

    return true;
  });

  return converted ? tr : null;
}

function findParentBlockquote($pos: any) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node?.type?.name === "blockquote") {
      return { node, pos: $pos.before(depth) };
    }
  }
  return null;
}

function convertMarkdownHeading(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean; targetBlockFrom?: number } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false, targetBlockFrom } = options;
  const heading = state.schema.nodes.heading;
  if (!heading) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (targetBlockFrom != null && pos !== targetBlockFrom) return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;

    const prefixText = node.firstChild?.isText ? node.firstChild.text : "";
    const match = prefixText.match(/^(#{1,6})([ \t]+)/);
    if (!match) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const level = match[1].length;
    const headingNode = heading.create({ ...node.attrs, level }, node.content.cut(match[0].length), node.marks);
    tr = tr.replaceWith(pos, pos + node.nodeSize, headingNode);
    if (insertParagraph) {
      const paragraph = state.schema.nodes.paragraph;
      const after = pos + headingNode.nodeSize;
      if (paragraph) {
        tr = tr.insert(after, paragraph.create());
        tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
      }
    }
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function editHeadingAsMarkdown(view: any, element: HTMLElement, _event?: MouseEvent) {
  const insidePos = view.posAtDOM(element, 0);
  const pos = headingPositionAt(view.state, insidePos);
  if (pos == null) return;
  const tr = exposeHeadingMarkdown(view.state, pos, pos + 1);
  if (!tr) return;
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function editInlineSyntaxAsMarkdown(view: any, target: HTMLElement, pos: number) {
  const definitions: Record<string, { open: string; close: (mark: any) => string }> = {
    bold: { open: "**", close: () => "**" },
    italic: { open: "*", close: () => "*" },
    code: { open: "`", close: () => "`" },
    strike: { open: "~~", close: () => "~~" },
    highlight: { open: "==", close: () => "==" },
    superscript: { open: "^", close: () => "^" },
    subscript: { open: "~", close: () => "~" },
    link: { open: "[", close: (mark) => `](${mark.attrs.href || ""})` },
  };
  const tagDefinitions: Array<[string, string]> = [
    ["a[href]", "link"],
    ["strong,b", "bold"],
    ["em,i", "italic"],
    ["s,del", "strike"],
    ["code", "code"],
    ["mark", "highlight"],
    ["sup", "superscript"],
    ["sub", "subscript"],
  ];
  const markerText = target.closest<HTMLElement>(".md-live-marker")?.dataset.markdownMarker || "";
  const tagMark = tagDefinitions.find(([selector]) => target.closest(selector))?.[1];
  for (const [markName, definition] of Object.entries(definitions)) {
    if (tagMark && tagMark !== markName) continue;
    const range = markdownMarkRangeAt(view.state, pos, markName) || getActiveMarkRange(view.state, markName);
    if (!range) continue;
    const close = definition.close(range.mark);
    if (markerText && markerText !== definition.open && markerText !== close) continue;
    const tr = exposeInlineMarkdown(
      view.state,
      range.from,
      range.to,
      range.mark.type,
      definition.open,
      close,
      markerText === close ? "close" : "open",
      pos,
    );
    if (!tr) return false;
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }
  return false;
}

function convertHorizontalRuleMarkdown(
  state: any,
  options: { force?: boolean; onlySelectionBlock?: boolean; insertParagraph?: boolean } = {},
) {
  const { force = false, onlySelectionBlock = false, insertParagraph = false } = options;
  const horizontalRule = state.schema.nodes.horizontalRule;
  if (!horizontalRule) return null;

  let tr = state.tr;
  let converted = false;
  const selectionBlockFrom = onlySelectionBlock ? state.selection.$from.before() : null;
  const selectionBlockTo = onlySelectionBlock ? state.selection.$from.after() : null;

  state.doc.descendants((node: any, pos: number) => {
    if (converted) return false;
    if (!node.isTextblock || node.type.name === "codeBlock") return true;
    if (onlySelectionBlock && (pos !== selectionBlockFrom || pos + node.nodeSize !== selectionBlockTo)) return true;
    if (!/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(node.textContent)) return true;
    if (!force && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize) return true;

    const rule = horizontalRule.create();
    tr = tr.replaceWith(pos, pos + node.nodeSize, rule);
    if (insertParagraph && state.schema.nodes.paragraph) {
      const after = pos + rule.nodeSize;
      tr = tr.insert(after, state.schema.nodes.paragraph.create());
      tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
    }
    converted = true;
    return false;
  });

  return converted ? tr : null;
}

function getTaskMarkAtSelection(state: any) {
  const taskMark = state.schema.marks.taskState;
  if (!taskMark || !state.selection.empty) return null;
  const { $from } = state.selection;
  return (state.storedMarks || $from.marks()).find((mark: any) => mark.type === taskMark) || null;
}

function continueTaskItem(view: any) {
  const taskMark = getTaskMarkAtSelection(view.state);
  if (!taskMark) return false;

  const listItem = view.state.schema.nodes.listItem;
  if (!listItem) return false;
  if (!view.state.selection.$from.parent.textContent.trim()) {
    const { $from } = view.state.selection;
    return Boolean(
      (editor.value as any)?.chain()
        .deleteRange({ from: $from.start(), to: $from.end() })
        .liftListItem("listItem")
        .run(),
    );
  }

  const splitCommand = (editor.value as any)?.commands?.splitListItem;
  if (typeof splitCommand === "function" && splitCommand("listItem")) {
    const { state } = view;
    const mark = state.schema.marks.taskState.create({ state: "unchecked" });
    const insertAt = state.selection.from;
    let tr = state.tr
      .insertText(" ", insertAt, insertAt)
      .addMark(insertAt, insertAt + 1, mark);
    tr = tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  return false;
}

function replaceTocWithText(
  editor: any,
  getPos: (() => number | undefined) | boolean,
  value: string,
  flushRequest?: PendingMathFlushRequest,
) {
  if (typeof getPos !== "function") return false;
  const pos = getPos();
  if (typeof pos !== "number") return false;
  const { state } = editor.view;
  const node = state.doc.nodeAt(pos);
  const paragraph = state.schema.nodes.paragraph;
  if (!node || !paragraph) return false;

  const text = value.trim();
  const replacement = text ? paragraph.create(null, state.schema.text(text)) : paragraph.create();
  let tr = state.tr.replaceWith(pos, pos + node.nodeSize, replacement);
  if (flushRequest) tr = tr.setMeta(DOCUMENT_FLUSH_META_KEY, flushRequest.flushId);
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

function toggleTaskItem(view: any, element: HTMLElement) {
  const state = view.state;
  const taskMark = state.schema.marks.taskState;
  if (!taskMark) return;

  const pos = view.posAtDOM(element.firstChild || element, 0);
  const from = Math.max(0, pos - 2);
  const to = Math.min(state.doc.content.size, pos + element.textContent.length + 2);
  let tr = state.tr;
  let handled = false;

  state.doc.nodesBetween(from, to, (node: any, nodePos: number) => {
    if (handled || !node.isText) return true;
    const mark = node.marks.find((candidate: any) => candidate.type === taskMark);
    if (!mark) return true;

    const checked = mark.attrs.state === "checked";
    const nextState = checked ? "unchecked" : "checked";
    const textFrom = nodePos;
    const textTo = nodePos + node.nodeSize;
    const nextText = node.text.replace(/^\s+/, "");
    tr = tr.insertText(nextText, textFrom, textTo);
    tr = tr.addMark(textFrom, textFrom + nextText.length, taskMark.create({ state: nextState }));
    handled = true;
    return false;
  });

  if (handled) view.dispatch(tr.scrollIntoView());
}

function createHorizontalRuleView(editing: boolean, editor: any, getPos: (() => number | undefined) | boolean) {
  const dom = document.createElement("div");
  dom.className = "typora-hr-node";
  dom.contentEditable = "false";

  const updateAttrs = (nextEditing: boolean) => {
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { editing: nextEditing }));
  };

  const render = () => {
    dom.innerHTML = "";
    dom.className = editing ? "typora-hr-node typora-hr-node-editing" : "typora-hr-node";
    if (editing) {
      const marker = document.createElement("span");
      marker.className = "typora-hr-source";
      marker.textContent = "---";
      const line = document.createElement("span");
      line.className = "typora-hr-line";
      dom.append(marker, line);
    } else {
      dom.appendChild(document.createElement("hr"));
    }
  };

  dom.addEventListener("mousedown", (event) => {
    if (editing) return;
    event.preventDefault();
    editing = true;
    selectHorizontalRule(editor, getPos, true);
    render();
  });

  render();

  return {
    dom,
    update(nextNode: any) {
      if (nextNode.type.name !== "horizontalRule") return false;
      editing = Boolean(nextNode.attrs.editing);
      render();
      return true;
    },
    selectNode() {
      editing = true;
      updateAttrs(true);
      render();
    },
    deselectNode() {
      if (!editing) return;
      editing = false;
      updateAttrs(false);
      render();
    },
    ignoreMutation: () => true,
  };
}

function selectHorizontalRule(editor: any, getPos: (() => number | undefined) | boolean, editing: boolean) {
  if (typeof getPos !== "function") return;
  const pos = getPos();
  if (typeof pos !== "number") return;
  const { state } = editor.view;
  const tr = state.tr
    .setSelection(NodeSelection.create(state.doc, pos))
    .setNodeMarkup(pos, undefined, { editing });
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
</script>

<template>
  <div
    ref="editorShell"
    class="lm-editor-scroll relative h-full overflow-auto"
    @click="handleEditorShellClick"
    @scroll="handleEditorShellScroll"
    @wheel.passive="markWysiwygManualScroll()"
    @touchmove.passive="markWysiwygManualScroll()"
    @pointerdown="handleWysiwygScrollPointer"
    @keydown.capture="handleWysiwygScrollKey"
  >
    <div
      v-if="recoveryRestoreNotice || recoveryRestoreIssues.length"
      class="mx-auto mt-3 max-w-[var(--lm-editor-width)] px-8"
      role="status"
      aria-live="polite"
    >
      <div class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
        <p v-if="recoveryRestoreNotice" class="whitespace-pre-wrap">{{ recoveryRestoreNotice }}</p>
        <details v-for="issue in recoveryRestoreIssues" :key="`${issue.id}:${issue.code}`" class="mt-1">
          <summary class="cursor-pointer">恢复保留项：{{ issue.kind }} / {{ issue.status }}（{{ issue.message }}）</summary>
          <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{{ recoveryIssuePayloadText(issue) }}</pre>
        </details>
      </div>
    </div>
    <EditorContent :editor="editor" />
    <div
      v-if="slashMenu.visible"
      class="slash-command-menu absolute z-50 w-80 overflow-hidden rounded-lg border border-paper-200 bg-paper-50 shadow-[0_16px_42px_rgba(31,30,27,0.18)] dark:border-paper-800 dark:bg-paper-900"
      :class="{ 'slash-command-menu-flip': slashMenu.flipY }"
      :style="{ left: `${slashMenu.x}px`, top: `${slashMenu.y}px` }"
      role="listbox"
      aria-label="斜杠命令"
      @mousedown.prevent
    >
      <div class="slash-command-header">
        <span>{{ slashMenu.query ? `搜索“${slashMenu.query}”` : "插入内容" }}</span>
        <kbd>Esc</kbd>
      </div>
      <div v-if="slashCandidates.length" class="slash-command-list">
        <button
          v-for="(command, index) in slashCandidates"
          :key="command.id"
          type="button"
          class="slash-command-item"
          :class="{ active: index === slashMenu.highlightedIndex }"
          role="option"
          :aria-selected="index === slashMenu.highlightedIndex"
          @mouseenter="slashMenu.highlightedIndex = index"
          @click="executeSlashCommand(command)"
        >
          <span class="slash-command-icon">{{ command.kind === "snippet" ? "S" : command.category.slice(0, 1) }}</span>
          <span class="min-w-0 flex-1">
            <b>{{ command.label }}</b>
            <small>{{ command.description }}</small>
          </span>
          <span class="slash-command-category">{{ command.category }}</span>
        </button>
      </div>
      <div v-else class="slash-command-empty">没有匹配的命令</div>
    </div>
    <div
      v-if="wikiCompletion.visible && wysiwygWikiCandidates.length > 0"
      class="wiki-completion-menu absolute z-50 max-h-64 w-72 overflow-auto rounded-lg border border-paper-200 bg-paper-50 p-1.5 shadow-[0_14px_36px_rgba(31,30,27,0.16)] dark:border-paper-800 dark:bg-paper-900"
      :style="{ left: `${wikiCompletion.x}px`, top: `${wikiCompletion.y}px` }"
      role="listbox"
      aria-label="Wiki Link 候选"
      @pointerdown.stop
      @click.stop
    >
      <button
        v-for="(candidate, index) in wysiwygWikiCandidates"
        :key="candidate.path"
        type="button"
        class="block w-full rounded-md px-2.5 py-2 text-left text-sm"
        :class="index === wikiCompletion.highlightedIndex
          ? 'bg-paper-200 text-ink-900 dark:bg-paper-800 dark:text-ink-100'
          : 'text-ink-700 hover:bg-paper-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-ink-100'"
        role="option"
        :aria-selected="index === wikiCompletion.highlightedIndex"
        @mousedown.prevent.stop="chooseWysiwygWikiCompletion(candidate)"
      >
        <span class="block truncate font-medium">{{ candidate.name }}</span>
        <span class="block truncate text-xs opacity-65">
          {{ candidate.matchedAlias ? `别名：${candidate.matchedAlias} · ` : "" }}{{ candidate.relativePath }}
        </span>
      </button>
    </div>
    <div
      v-if="codeLanguageControl.visible"
      class="code-language-floating"
      :class="{ 'is-code-language-open': codeLanguageControl.open }"
      :style="{ left: `${codeLanguageControl.x}px`, top: `${codeLanguageControl.y}px` }"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @keydown.stop
    >
      <input
        ref="codeLanguageInput"
        class="code-language-field"
        :class="{ placeholder: !codeLanguageControl.language && !codeLanguageControl.open }"
        :value="codeLanguageControl.open ? codeLanguageControl.query : codeLanguageControl.language"
        placeholder="代码语言"
        title="代码语言"
        spellcheck="false"
        @focus="() => openFloatingCodeLanguageMenu()"
        @input="handleFloatingCodeLanguageInput"
        @keydown="handleFloatingCodeLanguageKeydown"
        @blur="handleFloatingCodeLanguageBlur"
      />
      <div v-if="codeLanguageControl.open" class="code-language-menu">
        <div class="code-language-list">
          <button
            v-for="(language, index) in floatingCodeLanguageCandidates"
            :key="language"
            type="button"
            class="code-language-option"
            :class="{ active: index === codeLanguageControl.highlightedIndex }"
            @mousedown.prevent.stop="applyFloatingCodeLanguage(language)"
          >
            {{ language }}
          </button>
          <div v-if="floatingCodeLanguageCandidates.length === 0" class="code-language-empty">
            {{ codeLanguageControl.query.trim() ? `使用 "${codeLanguageControl.query.trim().toLowerCase()}"` : "输入语言" }}
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="tableControl.visible"
      class="table-floating-toolbar"
      :style="{ left: `${tableControl.x}px`, top: `${tableControl.y}px` }"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @keydown.stop
      @contextmenu.prevent
    >
      <div class="table-floating-group">
        <button type="button" class="table-floating-button" title="调整表格" aria-label="调整表格" @click="openTableResizePanel">
          <span class="table-ico table-ico-grid" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button" title="左对齐" aria-label="左对齐" @click="runTableFloatingCommand(() => applyTableAlignment('left'))">
          <span class="table-ico table-ico-align-left" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button" title="居中" aria-label="居中" @click="runTableFloatingCommand(() => applyTableAlignment('center'))">
          <span class="table-ico table-ico-align-center" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button" title="右对齐" aria-label="右对齐" @click="runTableFloatingCommand(() => applyTableAlignment('right'))">
          <span class="table-ico table-ico-align-right" aria-hidden="true"></span>
        </button>
      </div>
      <div class="table-floating-group">
        <button type="button" class="table-floating-button" title="更多表格选项" aria-label="更多表格选项" @click="toggleTableMoreMenu">
          <span class="table-ico table-ico-more" aria-hidden="true"></span>
        </button>
        <button type="button" class="table-floating-button table-floating-danger" title="删除表格" aria-label="删除表格" @click="runTableFloatingCommand(() => runTableCommand('deleteTable'))">
          <span class="table-ico table-ico-trash" aria-hidden="true"></span>
        </button>
      </div>

      <div v-if="tableControl.resizeOpen" class="table-resize-popover">
        <div class="table-resize-title">表格尺寸</div>
        <div class="table-resize-controls">
          <button type="button" aria-label="减少行" @click="setTableResizeDelta('rows', -1)"><UiIcon name="minus" :size="14" /></button>
          <span>{{ tableControl.rows }} 行</span>
          <button type="button" aria-label="增加行" @click="setTableResizeDelta('rows', 1)"><UiIcon name="plus" :size="14" /></button>
          <button type="button" aria-label="减少列" @click="setTableResizeDelta('columns', -1)"><UiIcon name="minus" :size="14" /></button>
          <span>{{ tableControl.columns }} 列</span>
          <button type="button" aria-label="增加列" @click="setTableResizeDelta('columns', 1)"><UiIcon name="plus" :size="14" /></button>
        </div>
        <form class="table-resize-form" @submit.prevent="applyTableResizeFromInput">
          <input
            :value="tableControl.resizeText"
            spellcheck="false"
            placeholder="4 x 6"
            @input="handleTableResizeTextInput"
          />
          <button type="submit">应用</button>
        </form>
        <div v-if="tableControl.resizeError" class="table-resize-error">{{ tableControl.resizeError }}</div>
      </div>

      <div v-if="tableControl.moreOpen" class="table-more-popover">
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addRowBefore'), false)">上方插入行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addRowAfter'), false)">下方插入行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addColumnBefore'), false)">左侧插入列</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('addColumnAfter'), false)">右侧插入列</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableRow(-1), false)">上移该行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableRow(1), false)">下移该行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableColumn(-1), false)">左移该列</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => moveCurrentTableColumn(1), false)">右移该列</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('deleteRow'), false)">删除行</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(() => runTableCommand('deleteColumn'), false)">删除列</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(copyCurrentTable, false)">复制表格</button>
        <button class="lm-menu-item" @click="runTableFloatingCommand(copyFormattedTableSource, false)">格式化表格源码</button>
        <button class="lm-menu-item lm-menu-danger" @click="runTableFloatingCommand(() => runTableCommand('deleteTable'))">删除表格</button>
      </div>
    </div>
    <div
      v-if="contextMenu.visible"
      class="lm-context-menu"
      :class="{ 'lm-context-menu-left': contextMenu.flipX, 'lm-context-menu-up': contextMenu.flipY }"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @mousedown.prevent
      @contextmenu.prevent
    >
      <template v-if="contextMenu.mode === 'code'">
        <button class="lm-menu-item" @click="runMenuCommand(cutSelection)">剪切</button>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">复制</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsMarkdown)">以 Markdown 复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionClean)">复制为纯文本</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsHtml)">以 HTML 复制</button>
          </div>
        </div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">粘贴</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(false))">智能粘贴</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(true))">纯文本粘贴</button>
          </div>
        </div>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('selection', 1))">为选中内容增加缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('selection', -1))">为选中内容减少缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('block', 1))">为整个代码块增加缩进</button>
        <button class="lm-menu-item" @click="runMenuCommand(() => indentCode('block', -1))">为整个代码块减少缩进</button>
        <div class="lm-menu-separator"></div>
        <button class="lm-menu-item lm-menu-danger" @click="runMenuCommand(deleteCodeBlock)">删除代码块</button>
      </template>

      <template v-else>
        <button class="lm-menu-item" @click="runMenuCommand(cutSelection)">剪切</button>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">复制</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsMarkdown)">以 Markdown 复制</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionClean)">复制为纯文本</button>
            <button class="lm-menu-item" @click="runMenuCommand(copySelectionAsHtml)">以 HTML 复制</button>
          </div>
        </div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">粘贴</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(false))">智能粘贴</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => pasteFromClipboard(true))">纯文本粘贴</button>
          </div>
        </div>

        <div class="lm-menu-separator"></div>
        <div class="lm-format-grid" aria-label="格式">
          <button title="加粗" aria-label="加粗" @click="runMenuCommand(() => runFormatCommand('bold'))"><UiIcon name="bold" :size="16" /></button>
          <button title="斜体" aria-label="斜体" @click="runMenuCommand(() => runFormatCommand('italic'))"><UiIcon name="italic" :size="16" /></button>
          <button title="行内代码" aria-label="行内代码" @click="runMenuCommand(() => runFormatCommand('code'))"><UiIcon name="code" :size="16" /></button>
          <button title="链接" aria-label="链接" @click="runMenuCommand(toggleLink)"><UiIcon name="link" :size="16" /></button>
          <button title="引用" aria-label="引用" @click="runMenuCommand(() => runFormatCommand('blockquote'))"><UiIcon name="quote" :size="16" /></button>
          <button title="有序列表" aria-label="有序列表" @click="runMenuCommand(() => runFormatCommand('orderedList'))"><UiIcon name="list-ordered" :size="16" /></button>
          <button title="无序列表" aria-label="无序列表" @click="runMenuCommand(() => runFormatCommand('bulletList'))"><UiIcon name="list" :size="16" /></button>
          <button title="任务清单" aria-label="任务清单" @click="runMenuCommand(insertTaskItem)"><UiIcon name="list-checks" :size="16" /></button>
        </div>

        <div class="lm-menu-separator"></div>
        <div class="lm-menu-sub">
          <button class="lm-menu-item">GitHub 警示框</button>
          <div class="lm-menu-pop">
            <button
              v-for="alert in githubAlertKinds"
              :key="alert.kind"
              class="lm-menu-item"
              @click="runMenuCommand(() => insertGithubAlert(alert.kind))"
            >
              {{ alert.label }}
            </button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item" :class="{ 'lm-menu-disabled': !canUseTableMenu }">表格</button>
          <div class="lm-menu-pop lm-menu-pop-wide" v-if="canUseTableMenu">
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addRowBefore'))">上方插入行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addRowAfter'))">下方插入行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addColumnBefore'))">左侧插入列</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('addColumnAfter'))">右侧插入列</button>
            <div class="lm-menu-separator"></div>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableRow(-1))">上移该行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableRow(1))">下移该行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableColumn(-1))">左移该列</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => moveCurrentTableColumn(1))">右移该列</button>
            <div class="lm-menu-separator"></div>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('deleteRow'))">删除行</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => runTableCommand('deleteColumn'))">删除列</button>
            <button class="lm-menu-item" @click="runMenuCommand(copyCurrentTable)">复制表格</button>
            <button class="lm-menu-item" @click="runMenuCommand(copyFormattedTableSource)">格式化表格源码</button>
            <button class="lm-menu-item lm-menu-danger" @click="runMenuCommand(() => runTableCommand('deleteTable'))">删除表格</button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item">插入</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(insertImageByUrl)">图片</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => insertParagraphAround('before'))">上方段落</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => insertParagraphAround('after'))">下方段落</button>
          </div>
        </div>

        <div class="lm-menu-sub">
          <button class="lm-menu-item">标题</button>
          <div class="lm-menu-pop">
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(1))">一级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(2))">二级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(3))">三级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(4))">四级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(5))">五级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(6))">六级标题</button>
            <button class="lm-menu-item" @click="runMenuCommand(() => setHeadingLevel(null))">正文</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
