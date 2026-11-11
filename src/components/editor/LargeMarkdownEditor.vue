<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from "vue";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, cursorCharLeft, cursorCharRight, selectCharLeft, selectCharRight, cursorLineUp, cursorLineDown, selectLineUp, selectLineDown } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { appStore, applyLargeFileEdits, exportLargeFileRange, formatLargeTransactionEvidence, getPaneTab,
  moveLargeFileHistory, readLargeFileRange, replaceLargeFileMatches, retryLargeFileEdits,
  searchLargeFile, updateLargeFileViewportLine } from "../../stores/appStore";
import { registerDocumentSession, type DocumentSessionAdapter, type PendingFlushOptions } from "../../editor/documentRuntime";
import { createDocumentMutationTracker, type DocumentFlushHandle, type DocumentMutationTracker } from "../../editor/documentMutationTracker";
import { LargeSessionStaleError } from "../../editor/largeOperationQueue";
import { largeSessionBookmarks, largeSessionOpenedSize, releaseLargeSessionBookmarks, type LargeHistoryBookmark } from "../../editor/largeSourceBookmarks";
import { parseSourceDocument, resetSourceLineEndings, serializeSourceDocument, sourceLineEndingsExtension, sourceLineEndingsField, sourceOffsetToRawOffset } from "../../editor/sourceLineEndings";
import { findOptions, findReplaceStore, setFindResult } from "../../stores/findReplaceStore";
import { renderMarkdownForEditor } from "../../utils/markdown";
import { expandSnippet } from "../../utils/snippets";
import { clipboardPayloadFromDataTransfer, prepareSmartPaste, readClipboardPayload, type PasteConversionResult } from "../../utils/smartPaste";
import { LARGE_COPY_BYTES, LARGE_EDIT_BYTES, LARGE_PREVIEW_BYTES, LargeWindowCache,
  advanceLargePosition, compareLargePosition, orderedLargeRange, replacementForRawWindow,
  windowOffsetPosition, windowPositionOffset, safeLargeWindowOffset, type LargePosition } from "../../editor/largeSourceWindow";
import { LargeSearchCoordinator } from '../../editor/largeSearchCoordinator';
import type { LargeSourceRange } from "../../editor/largeSourceClient";
import { cancelLargeSourceJob, largeSourceJobs, resolveLargeSourcePosition } from "../../editor/largeSourceClient";
import type { CapturedEditorTarget, EditorPaneId, LargeFindMatch, LargeFindResult, TextEdit, TextFileWriteReceipt } from "../../types";

const props = withDefaults(defineProps<{ paneId?: EditorPaneId }>(), { paneId: "main" });
const host = ref<HTMLElement | null>(null);
const loading = ref(false);
const failed = ref("");
const previewHtml = ref("");
const previewReliable = ref(false);
const jumpLine = ref(1);
const jumpColumn = ref(1);
const selectionLabel = ref("");
const windowLabel = ref("");
const tab = computed(() => getPaneTab(props.paneId));
const largeFile = computed(() => tab.value?.documentMode === "large" ? tab.value.largeFile : null);
const readOnly = computed(() => largeFile.value
  ? largeSessionOpenedSize(largeFile.value.sessionId, largeFile.value.sizeBytes) > LARGE_EDIT_BYTES : false);
const totalLines = computed(() => largeFile.value?.totalLines ?? 1);
const backgroundJob = computed(() => largeSourceJobs.get(largeFile.value?.sessionId ?? ""));
let view: EditorView | null = null;
let windowRange: LargeSourceRange | null = null;
let baseText = "";
let baseRaw = "";
let pendingVersion = 0;
let submitting: Promise<void> | null = null;
let submittedInputVersion = -1;
let submitFlush: DocumentFlushHandle | undefined;
let unregister: (() => void) | null = null;
let tracker: DocumentMutationTracker | null = null;
let replacingWindow = false;
let requestGeneration = 0;
let submitTimer: ReturnType<typeof setTimeout> | undefined;
let compositionResolve: (() => void) | null = null;
let compositionWait: Promise<void> | null = null;
let logicalAnchor: LargePosition = { line: 0, column: 0 };
let logicalHead: LargePosition = { line: 0, column: 0 };
let extending = false;
const cache = new LargeWindowCache<LargeSourceRange>();
let ownerSession = "";
let failedSubmission: { text: string; raw: string; edit: TextEdit } | null = null;
let pendingGlobalPatch: { start: LargePosition; end: LargePosition; prefix: number; suffix: number } | null = null;
let beforeInputSelection: { anchor: LargePosition; head: LargePosition } | null = null;
let undoSelections: LargeHistoryBookmark[] = [];
let redoSelections: LargeHistoryBookmark[] = [];
let findMatches: LargeFindMatch[] = [];
let findRevision = -1;
let findFingerprint = "";
const searchCoordinator = new LargeSearchCoordinator<LargeFindResult>();
let navigationTail: Promise<void> = Promise.resolve();
let queuedNavigation = 0;

function currentIdentity() {
  const state = largeFile.value;
  if (!state) throw new LargeSessionStaleError();
  return { sessionId: state.sessionId, revision: state.revision, coordinateSpace: state.coordinateSpace };
}
function assertIdentity(identity: ReturnType<typeof currentIdentity>) {
  const state = largeFile.value;
  if (!state || state.sessionId !== identity.sessionId || state.revision !== identity.revision
    || state.coordinateSpace !== identity.coordinateSpace) throw new LargeSessionStaleError();
}
function isPending() { return Boolean(view && view.state.doc.toString() !== baseText); }
function showError(error: unknown) {
  failed.value = formatLargeTransactionEvidence(error);
  appStore.statusMessage = `大文件输入已保留：${failed.value}`;
}
function recordSelection() {
  if (!view || !windowRange) return;
  const text = view.state.doc.toString();
  const start = { line: windowRange.startLine, column: windowRange.startColumn };
  const selection = view.state.selection.main;
  if (!extending) logicalAnchor = windowOffsetPosition(text, start, selection.anchor);
  logicalHead = windowOffsetPosition(text, start, selection.head);
  jumpLine.value = logicalHead.line + 1;
  jumpColumn.value = logicalHead.column + 1;
  selectionLabel.value = `${logicalAnchor.line + 1}:${logicalAnchor.column + 1} → ${logicalHead.line + 1}:${logicalHead.column + 1}`;
  if (ownerSession) largeSessionBookmarks(ownerSession).selection = { anchor: { ...logicalAnchor }, head: { ...logicalHead } };
  updateLargeFileViewportLine(props.paneId, logicalHead.line);
}
function normalized(value: string) { return value.replace(/\r\n?|\n/g, "\n"); }

async function submitPending(explicit = false, flush?: DocumentFlushHandle): Promise<void> {
  if (submitTimer) clearTimeout(submitTimer);
  if (compositionWait) await compositionWait;
  if (submitting) {
    if (flush) submitFlush = flush;
    await submitting;
    if (isPending()) return submitPending(explicit, flush);
    return;
  }
  if (!view || !windowRange || !isPending()) return;
  if (failedSubmission && !explicit) throw new Error("上次提交未确认，请先重试；当前输入仍保留在源码窗口中。");
  const identity = currentIdentity();
  if (identity.revision !== windowRange.revision) throw new LargeSessionStaleError("窗口版本已过期，输入已保留。");
  const submittedText = explicit && failedSubmission ? failedSubmission.text : view.state.doc.toString();
  const submittedRaw = explicit && failedSubmission ? failedSubmission.raw : serializeSourceDocument(view.state.doc, view.state.field(sourceLineEndingsField));
  const inputVersion = pendingVersion;
  const edit = explicit && failedSubmission ? failedSubmission.edit : pendingGlobalPatch
    ? { startLine: pendingGlobalPatch.start.line, startColumn: pendingGlobalPatch.start.column,
      endLine: pendingGlobalPatch.end.line, endColumn: pendingGlobalPatch.end.column,
      text: submittedRaw.slice(sourceOffsetToRawOffset(submittedRaw, pendingGlobalPatch.prefix),
        sourceOffsetToRawOffset(submittedRaw, submittedText.length - pendingGlobalPatch.suffix)) }
    : replacementForRawWindow(baseRaw, submittedRaw, { line: windowRange.startLine, column: windowRange.startColumn });
  if (!edit) return;
  const beforeSelection = beforeInputSelection ?? { anchor: { ...logicalAnchor }, head: { ...logicalHead } };
  const afterSelection = { anchor: { ...logicalAnchor }, head: { ...logicalHead } };
  const stateIdentity = toRaw(largeFile.value!);
  submitFlush = flush;
  submittedInputVersion = inputVersion;
  submitting = (async () => {
    try {
      const receipt = explicit && failedSubmission
        ? await retryLargeFileEdits([edit], props.paneId)
        : await applyLargeFileEdits([edit], props.paneId);
      if (!receipt || toRaw(largeFile.value!) !== stateIdentity || largeFile.value?.sessionId !== identity.sessionId) {
        throw new LargeSessionStaleError("编辑回执不属于原文档，输入已保留。");
      }
      baseText = submittedText;
      baseRaw = submittedRaw;
      windowRange = { ...windowRange!, revision: receipt.revision,
        ...(() => { const end = advanceLargePosition({ line: windowRange!.startLine, column: windowRange!.startColumn }, submittedText);
          return { endLine: end.line, endColumn: end.column }; })() };
      tracker?.setRevision(receipt.revision);
      tracker?.recordDocumentChange(submitFlush ? { kind: "pending-flush", flushId: submitFlush.id } : { kind: "document" });
      cache.clear();
      failed.value = "";
      failedSubmission = null;
      pendingGlobalPatch = null;
      undoSelections.push({ before: beforeSelection, after: afterSelection });
      redoSelections.length = 0;
      if (inputVersion === pendingVersion) beforeInputSelection = null;
      if (isPending()) scheduleSubmission();
    } catch (error) { failedSubmission = { text: submittedText, raw: submittedRaw, edit }; showError(error); throw error; }
    finally { submitting = null; submitFlush = undefined; submittedInputVersion = -1; }
  })();
  return submitting;
}
function scheduleSubmission() {
  if (submitTimer) clearTimeout(submitTimer);
  if (!compositionWait && !failedSubmission) submitTimer = setTimeout(() => { void submitPending().catch(showError); }, 500);
}
async function flushPending(options: PendingFlushOptions = {}) {
  if (compositionWait) await compositionWait;
  const handle = tracker?.beginFlush(options.expectedToken);
  try { await submitPending(false, handle); return handle?.complete(); }
  catch (error) { handle?.fail(); throw error; }
}

async function loadWindow(position: LargePosition, extend = false, skipFlush = false) {
  if (!view || !largeFile.value) return;
  if (skipFlush && isPending()) throw new LargeSessionStaleError("后台结果已更新，但窗口中有新的未确认输入；已保留输入，请先导出未确认窗口。");
  if (!skipFlush) await submitPending();
  if (compositionWait) await compositionWait;
  const identity = currentIdentity();
  const generation = ++requestGeneration;
  loading.value = true;
  try {
    const start = { line: Math.max(0, Math.min(position.line, totalLines.value)), column: Math.max(0, position.column) };
    // Place the requested column inside a bounded horizontal segment, including ultra-long lines.
    start.column = Math.max(0, start.column - 2048);
    const key = `${identity.sessionId}:${identity.revision}:${start.line}:${start.column}`;
    let response = cache.get(key) ?? await readLargeFileRange({ start }, props.paneId);
    const requestedEnd = position.line >= response.totalLines;
    if (requestedEnd && response.endColumn > 0) {
      // EOF is a permitted remote sentinel, but local edits need the real
      // last-line column. Show a bounded tail rather than an empty fake line.
      response = await readLargeFileRange({ start: { line: response.endLine, column: Math.max(0, response.endColumn - 2048) } }, props.paneId);
    }
    assertIdentity(identity);
    if (generation !== requestGeneration || !view) return;
    cache.set(key, response);
    baseText = normalized(response.text);
    baseRaw = response.text;
    windowRange = response;
    const windowStart = { line: response.startLine, column: response.startColumn };
    const resolvedPosition = requestedEnd ? { line: response.endLine, column: response.endColumn } : position;
    const head = safeLargeWindowOffset(baseText, windowPositionOffset(baseText, windowStart, resolvedPosition) ?? 0);
    const canonicalHead = windowOffsetPosition(baseText, windowStart, head);
    if (!extend) logicalAnchor = { ...canonicalHead };
    logicalHead = canonicalHead;
    const anchor = safeLargeWindowOffset(baseText, windowPositionOffset(baseText, windowStart, logicalAnchor) ?? (compareLargePosition(logicalAnchor, windowStart) < 0 ? 0 : baseText.length));
    extending = extend;
    replacingWindow = true;
    try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: baseText },
      effects: resetSourceLineEndings.of(parseSourceDocument(response.text).lineEndings),
      selection: EditorSelection.single(anchor, head), annotations: Transaction.addToHistory.of(false), scrollIntoView: true }); }
    finally { replacingWindow = false; }
    windowLabel.value = `${response.startLine + 1}:${response.startColumn + 1}–${response.endLine + 1}:${response.endColumn + 1}`;
    selectionLabel.value = `${logicalAnchor.line + 1}:${logicalAnchor.column + 1} → ${logicalHead.line + 1}:${logicalHead.column + 1}`;
    largeSessionBookmarks(identity.sessionId).selection = { anchor: { ...logicalAnchor }, head: { ...logicalHead } };
    jumpLine.value = canonicalHead.line + 1; jumpColumn.value = canonicalHead.column + 1;
    updateLargeFileViewportLine(props.paneId, canonicalHead.line);
  } catch (error) { showError(error); throw error; }
  finally { if (generation === requestGeneration) loading.value = false; }
}
async function moveWindow(direction: 1 | -1, extend = false) {
  if (!windowRange) return;
  const position = direction > 0
    ? { line: windowRange.endLine, column: windowRange.endColumn }
    : windowRange.startColumn > 0
      ? { line: windowRange.startLine, column: Math.max(0, windowRange.startColumn - 60000) }
      : { line: Math.max(0, windowRange.startLine - 200), column: 0 };
  await loadWindow(position, extend);
  view?.focus();
}
async function goToPosition() {
  await submitPending();
  const identity = currentIdentity(), inputVersion = pendingVersion;
  const position = await resolveLargeSourcePosition(identity,
    { line: Math.max(0, jumpLine.value - 1), column: Math.max(0, jumpColumn.value - 1) }, 'clamp');
  assertIdentity(identity);
  if (pendingVersion !== inputVersion || isPending()) throw new LargeSessionStaleError('跳转等待期间输入已变化，已保留当前窗口。');
  await loadWindow(position, false, true); view?.focus();
}
async function undo(direction: "undo" | "redo") {
  try {
    await submitPending();
    const previousRevision = largeFile.value!.revision;
    await moveLargeFileHistory(direction, props.paneId);
    if (previousRevision === largeFile.value!.revision) return;
    tracker?.setRevision(largeFile.value!.revision); tracker?.recordDocumentChange();
    cache.clear();
    const selection = direction === "undo" ? undoSelections.pop() : redoSelections.pop();
    if (selection) {
      (direction === "undo" ? redoSelections : undoSelections).push(selection);
      const bookmark = direction === "undo" ? selection.before : selection.after;
      logicalAnchor = { ...bookmark.anchor }; logicalHead = { ...bookmark.head };
      await loadWindow(logicalHead, true, true);
    } else await loadWindow(logicalHead, false, true);
  } catch (error) { showError(error); }
}
function keyBoundary(direction: 1 | -1, extend = false) {
  if (!view || !windowRange) return false;
  const head = view.state.selection.main.head;
  const collapseGlobalSelection = !extend && compareLargePosition(logicalAnchor, logicalHead) !== 0;
  if (!collapseGlobalSelection && !queuedNavigation && (direction > 0 && head !== view.state.doc.length || direction < 0 && head !== 0)) return false;
  queueBoundaryNavigation(direction, extend, false); return true;
}
function verticalBoundary(direction: 1 | -1, extend = false) {
  if (!view || !windowRange) return false;
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  if (!queuedNavigation && (direction > 0 && line.number !== view.state.doc.lines || direction < 0 && line.number !== 1)) return false;
  const targetLine = logicalHead.line + direction;
  if (targetLine < 0 || targetLine >= totalLines.value) return false;
  queueBoundaryNavigation(direction, extend, true); return true;
}
function queueBoundaryNavigation(direction: 1 | -1, extend: boolean, vertical: boolean) {
  const session = ownerSession;
  queuedNavigation++;
  navigationTail = navigationTail.catch(() => undefined).then(async () => {
    if (!view || !windowRange || ownerSession !== session) return;
    if (!vertical && !extend && compareLargePosition(logicalAnchor, logicalHead) !== 0) {
      await submitPending();
      const range = orderedLargeRange(logicalAnchor, logicalHead);
      await loadWindow(direction < 0 ? range.start : range.end, false, true);
      view?.focus();
      return;
    }
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const boundary = vertical ? direction > 0 ? line.number === view.state.doc.lines : line.number === 1
      : direction > 0 ? head === view.state.doc.length : head === 0;
    if (!boundary) {
      extending = extend;
      const command = vertical ? direction > 0 ? extend ? selectLineDown : cursorLineDown : extend ? selectLineUp : cursorLineUp
        : direction > 0 ? extend ? selectCharRight : cursorCharRight : extend ? selectCharLeft : cursorCharLeft;
      command(view);
      return;
    }
    await submitPending();
    const identity = currentIdentity(), inputVersion = pendingVersion;
    const position = vertical ? { line: Math.max(0, logicalHead.line + direction), column: logicalHead.column } : { ...logicalHead };
    const target = await resolveLargeSourcePosition(identity, position, vertical ? 'clamp' : direction > 0 ? 'next' : 'previous');
    assertIdentity(identity);
    if (pendingVersion !== inputVersion || isPending()) throw new LargeSessionStaleError('光标导航等待期间输入已变化，已保留当前窗口。');
    await loadWindow(target, extend, true);
    view?.focus();
  }).catch(showError).finally(() => { queuedNavigation--; });
}
function selectAllGlobal() {
  if (!view) return true;
  replacingWindow = true;
  try { view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) }); }
  finally { replacingWindow = false; }
  logicalAnchor = { line: 0, column: 0 }; logicalHead = { line: totalLines.value, column: 0 };
  extending = true; selectionLabel.value = "已选择全文（跨窗口）"; return true;
}
async function selectedText(limit: number, selection = orderedLargeRange(logicalAnchor, logicalHead), context?: { prefix: string; reliable: boolean }) {
  await submitPending();
  const identity = currentIdentity();
  const range = selection;
  let position = range.start; let text = ""; let bytes = 0; let first = true;
  while (compareLargePosition(position, range.end) < 0) {
    const response = await readLargeFileRange({ start: position, end: range.end, includeContext: Boolean(context && first) }, props.paneId);
    if (context && first) { context.prefix = response.contextPrefix ?? ""; context.reliable = response.contextReliable === true; }
    first = false;
    assertIdentity(identity);
    const size = new TextEncoder().encode(response.text).byteLength;
    if (bytes + size > limit) throw new Error(`选区超过 ${limit / 1024 / 1024}MiB，请导出选区或缩小范围。`);
    text += response.text; bytes += size;
    const next = { line: response.endLine, column: response.endColumn };
    if (compareLargePosition(next, position) <= 0) break;
    position = next;
    if (!response.truncated) break;
  }
  return text;
}
async function exportSelection() {
  try {
    await submitPending();
    const identity = currentIdentity(); const range = orderedLargeRange(logicalAnchor, logicalHead);
    const path = await invoke<string | null>("save_markdown_file_dialog", { defaultFileName: "selection.md" });
    if (!path) return;
    assertIdentity(identity);
    const receipt = await exportLargeFileRange({ start: range.start, end: range.end }, path, props.paneId);
    appStore.statusMessage = `已导出选区 ${receipt.byteLength} 字节：${receipt.path}`;
  } catch (error) { showError(error); }
}
async function exportUnconfirmedWindow() {
  if (!view || !windowRange) return;
  // Freeze a small, self-contained recovery artifact before opening a dialog.
  const frozen = JSON.stringify({ schemaVersion: 1, kind: "lightmark-large-source-window", path: tab.value?.path,
    sessionId: windowRange.sessionId, baseRevision: windowRange.revision, currentRevision: largeFile.value?.revision,
    window: { startLine: windowRange.startLine, startColumn: windowRange.startColumn,
      endLine: windowRange.endLine, endColumn: windowRange.endColumn },
    base: baseRaw, input: serializeSourceDocument(view.state.doc, view.state.field(sourceLineEndingsField)),
    anchor: logicalAnchor, head: logicalHead, pendingVersion }, null, 2);
  try {
    const path = await invoke<string | null>("save_markdown_file_dialog", { defaultFileName: "large-window-recovery.json" });
    if (!path) return;
    const expectedTargetFingerprint = await invoke("get_large_file_fingerprint", { path });
    const receipt = await invoke<TextFileWriteReceipt>("write_text_file", { path, content: frozen, expectedTargetFingerprint });
    if (receipt.outcome !== "committed" || receipt.diskWritten !== "yes") throw new Error("未确认恢复窗口已完整写入。");
    appStore.statusMessage = `已导出未确认窗口恢复材料：${path}`;
  } catch (error) { showError(error); }
}
async function copySelection(cut = false) {
  try {
    if (compareLargePosition(logicalAnchor, logicalHead) === 0) return;
    const identity = currentIdentity(); const version = pendingVersion;
    const range = orderedLargeRange(logicalAnchor, logicalHead);
    const text = await selectedText(LARGE_COPY_BYTES);
    const afterRead = currentIdentity();
    await navigator.clipboard.writeText(text);
    if (cut && !readOnly.value && text) {
      assertIdentity(afterRead);
      if (pendingVersion !== version || identity.sessionId !== afterRead.sessionId) throw new LargeSessionStaleError("等待剪贴板期间输入已变化，已保留正文。");
      await applyLargeFileEdits([{ startLine: range.start.line, startColumn: range.start.column,
        endLine: range.end.line, endColumn: range.end.column, text: "" }], props.paneId);
      logicalHead = logicalAnchor = range.start;
      cache.clear(); await loadWindow(range.start, false, true);
    }
  } catch (error) { showError(error); }
}
async function previewSelection() {
  try {
    const range = compareLargePosition(logicalAnchor, logicalHead) === 0 && windowRange
      ? { start: { line: windowRange.startLine, column: windowRange.startColumn }, end: { line: windowRange.endLine, column: windowRange.endColumn } }
      : orderedLargeRange(logicalAnchor, logicalHead);
    const context = { prefix: "", reliable: false };
    const text = await selectedText(LARGE_PREVIEW_BYTES, range, context);
    previewReliable.value = context.reliable;
    previewHtml.value = renderMarkdownForEditor(context.prefix + text);
  } catch (error) { showError(error); }
}
async function handleFind(event: Event) {
  if (appStore.splitLayout.activePaneId !== props.paneId || !largeFile.value) return;
  if (!findReplaceStore.open || !findReplaceStore.query) { searchCoordinator.cancel(); setFindResult(0, -1); return; }
  const command = (event as CustomEvent<string>).detail;
  const query = findReplaceStore.query, replacement = findReplaceStore.replaceText;
  const options = { ...findOptions() }, initialIndex = findReplaceStore.currentIndex;
  const sessionId = largeFile.value.sessionId;
  const fingerprint = JSON.stringify([query, options]);
  const stillCurrent = () => appStore.splitLayout.activePaneId === props.paneId && largeFile.value?.sessionId === sessionId
    && findReplaceStore.open && JSON.stringify([findReplaceStore.query, findOptions()]) === fingerprint;
  try {
    await submitPending();
    if (!stillCurrent()) return;
    const inputVersion = pendingVersion;
    let index = initialIndex, searched = false;
    if (command === 'refresh' || findRevision !== largeFile.value.revision || findFingerprint !== fingerprint) {
      const result = await searchCoordinator.search(fingerprint, largeFile.value.revision,
        signal => searchLargeFile(query, options, 0, 5000, props.paneId, signal));
      if (!stillCurrent()) return;
      if (pendingVersion !== inputVersion || isPending()) throw new LargeSessionStaleError('查找等待期间输入已变化，请重新查找；新输入已保留。');
      findRevision = result.revision; findMatches = result.matches; findFingerprint = fingerprint;
      index = result.matches.length ? 0 : -1; searched = true;
      setFindResult(result.total, index, result.error);
      if (command === 'refresh') return;
    }
    if (command === 'replaceAll' || command === 'replaceCurrent') {
      if (readOnly.value) return;
      const currentMatch = command === 'replaceCurrent' ? findMatches[Math.max(0, index)] : null;
      // A missing single match must never become the backend's null = replace-all intent.
      if (command === 'replaceCurrent' && !currentMatch) return;
      await replaceLargeFileMatches(query, replacement, options, currentMatch ?? null, props.paneId);
      if (pendingVersion !== inputVersion || isPending()) {
        throw new LargeSessionStaleError('替换已在原版本完成，等待期间的新输入仍保留在旧窗口；请导出未确认窗口后处理冲突。');
      }
      cache.clear(); await loadWindow(logicalHead, false, true); findRevision = -1; findFingerprint = ''; return;
    }
    if (!findMatches.length) return;
    index = searched ? command === 'previous' ? findMatches.length - 1 : 0
      : (index + (command === 'previous' ? -1 : 1) + findMatches.length) % findMatches.length;
    const match = findMatches[index];
    if (match) { setFindResult(findReplaceStore.total, index); await loadWindow({ line: match.line, column: match.startColumn }); view?.focus(); }
  } catch (error) {
    if (!stillCurrent() || error instanceof DOMException && error.name === 'AbortError') return;
    showError(error); setFindResult(0, -1, formatLargeTransactionEvidence(error));
  }
}
function handleJump(event: Event) {
  const detail = (event as CustomEvent<number | { line?: number; paneId?: EditorPaneId }>).detail;
  if (typeof detail !== "number" && detail.paneId && detail.paneId !== props.paneId) return;
  void loadWindow({ line: typeof detail === "number" ? detail : detail.line ?? 0, column: 0 }).catch(showError);
}
function captureLargeEditorTarget(event: Event) {
  const detail = (event as CustomEvent<{ target: CapturedEditorTarget | null }>).detail;
  if (!view?.hasFocus || !tab.value || !largeFile.value) return;
  const selection = view.state.selection.main;
  const range = orderedLargeRange(logicalAnchor, logicalHead);
  detail.target = { tabId: tab.value.id, paneId: props.paneId, documentMode: "large", editorMode: "source",
    anchor: selection.anchor, head: selection.head, selection: view.state.sliceDoc(selection.from, selection.to), capturedAt: Date.now(),
    large: { sessionId: largeFile.value.sessionId, revision: largeFile.value.revision, inputVersion: pendingVersion,
      startLine: range.start.line, startColumn: range.start.column, endLine: range.end.line, endColumn: range.end.column } };
}

function insertSnippetIntoLargeEditor(event: Event) {
  const { target, snippetId } = (event as CustomEvent<{ target: CapturedEditorTarget; snippetId: string }>).detail;
  const snippet = appStore.settings.snippets.items.find((item) => item.id === snippetId && item.enabled);
  if (!view || !snippet || readOnly.value || target.tabId !== tab.value?.id || target.paneId !== props.paneId
    || target.large?.sessionId !== largeFile.value?.sessionId || target.large?.revision !== largeFile.value?.revision
    || target.large?.inputVersion !== pendingVersion) return;
  if (view.state.sliceDoc(Math.min(target.anchor, target.head), Math.max(target.anchor, target.head)) !== target.selection) {
    showError("片段插入位置已经变化，请重新选择。"); return;
  }
  const expansion = expandSnippet(snippet.markdown, { selection: target.selection });
  const from = Math.min(target.anchor, target.head); const to = Math.max(target.anchor, target.head);
  view.dispatch({ changes: { from, to, insert: normalized(expansion.markdown) },
    selection: { anchor: from + normalized(expansion.markdown.slice(0, expansion.cursorOffset)).length }, scrollIntoView: true });
  view.focus();
}
function insertLargePaste(result: PasteConversionResult) {
  if (!view || readOnly.value) return;
  if (result.kind === "image-files") { appStore.statusMessage = "大文件源码暂不支持图片文件粘贴。"; return; }
  const selection = view.state.selection.main;
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert: normalized(result.markdown ?? "") },
    selection: { anchor: selection.from + normalized(result.markdown ?? "").length }, scrollIntoView: true });
  if (result.warnings.length) appStore.statusMessage = result.warnings.join(" ");
}
function handleLargePaste(event: ClipboardEvent) {
  event.preventDefault(); insertLargePaste(prepareSmartPaste(clipboardPayloadFromDataTransfer(event.clipboardData)));
}
async function pasteLargePlainText() {
  if (!view) return;
  const identity = currentIdentity(); const version = pendingVersion;
  const payload = await readClipboardPayload();
  assertIdentity(identity);
  if (pendingVersion !== version) { showError("等待剪贴板期间输入已变化，请重新粘贴。"); return; }
  insertLargePaste(prepareSmartPaste(payload, { plainText: true }));
}

function registerSession() {
  unregister?.(); unregister = null;
  if (!tab.value || !largeFile.value) return;
  const sessionId = largeFile.value.sessionId;
  const bookmarks = largeSessionBookmarks(sessionId);
  undoSelections = bookmarks.undo; redoSelections = bookmarks.redo;
  logicalAnchor = { ...bookmarks.selection.anchor }; logicalHead = { ...bookmarks.selection.head };
  const adapter: DocumentSessionAdapter = {
    get tabId() { return tab.value?.id ?? ""; }, paneId: props.paneId, mode: "source",
    get revision() { return largeFile.value?.revision ?? 0; },
    hasPendingEdits: () => isPending() || Boolean(submitting || compositionWait),
    pendingEditVersion: () => pendingVersion,
    isComposing: () => Boolean(compositionWait),
    mutationToken: () => tracker!.token(),
    async flushPendingEdits(_reason, options) { return flushPending(options); },
    finalizeClosePrompt: (options) => flushPending(options),
    async captureRecoveryBundle() { return JSON.stringify({ sessionId, windowRange, baseText, text: view?.state.doc.toString(), logicalAnchor, logicalHead }); },
    async snapshot() { throw new Error("大文件快照必须使用远端草稿，禁止构造全文字符串。"); },
    derivedState: () => ({ revision: largeFile.value?.revision, lines: totalLines.value }),
    async replaceMarkdown() { throw new Error("大文件不接受 JavaScript 全文替换。"); },
    navigate: (target) => { void loadWindow({ line: target.line ?? 0, column: 0 }).catch(showError); },
  };
  tracker = createDocumentMutationTracker({ sessionIdentity: adapter, initialRevision: largeFile.value.revision });
  unregister = registerDocumentSession(adapter);
}
onMounted(() => {
  view = new EditorView({ parent: host.value!, state: EditorState.create({ doc: "", extensions: [
    sourceLineEndingsExtension(parseSourceDocument("").lineEndings),
    lineNumbers({ formatNumber: (line) => String(line + (windowRange?.startLine ?? 0)) }),
    EditorState.readOnly.of(readOnly.value), EditorView.editable.of(!readOnly.value),
    keymap.of([
      { key: "Mod-z", run: () => { void undo("undo"); return true; } },
      { key: "Mod-Shift-z", run: () => { void undo("redo"); return true; } },
      { key: "Mod-y", run: () => { void undo("redo"); return true; } },
      { key: "Mod-a", run: selectAllGlobal },
      { key: "Mod-c", run: () => { void copySelection(); return true; } },
      { key: "Mod-x", run: () => { void copySelection(true); return true; } },
      { key: "Mod-Shift-v", run: () => { void pasteLargePlainText().catch(showError); return true; } },
      { key: "ArrowRight", run: () => keyBoundary(1) }, { key: "ArrowLeft", run: () => keyBoundary(-1) },
      { key: "Shift-ArrowRight", run: () => keyBoundary(1, true) }, { key: "Shift-ArrowLeft", run: () => keyBoundary(-1, true) },
      { key: "ArrowDown", run: () => verticalBoundary(1) }, { key: "ArrowUp", run: () => verticalBoundary(-1) },
      { key: "Shift-ArrowDown", run: () => verticalBoundary(1, true) }, { key: "Shift-ArrowUp", run: () => verticalBoundary(-1, true) },
      { key: "Mod-Home", run: () => { void loadWindow({ line: 0, column: 0 }).catch(showError); return true; } },
      { key: "Mod-End", run: () => { void loadWindow({ line: totalLines.value, column: 0 }).catch(showError); return true; } },
      { key: "Mod-Shift-Home", run: () => { void loadWindow({ line: 0, column: 0 }, true).catch(showError); return true; } },
      { key: "Mod-Shift-End", run: () => { void loadWindow({ line: totalLines.value, column: 0 }, true).catch(showError); return true; } },
      { key: "Mod-Enter", run: () => { void submitPending(true).catch(showError); return true; } }, ...defaultKeymap,
    ]),
    EditorView.domEventHandlers({
      paste: handleLargePaste,
      compositionstart: () => { compositionWait = new Promise<void>((resolve) => { compositionResolve = resolve; }); },
      compositionend: () => { compositionResolve?.(); compositionResolve = null; compositionWait = null; scheduleSubmission(); },
      mousedown: (event) => { extending = event.shiftKey && compareLargePosition(logicalAnchor, logicalHead) !== 0; },
      keydown: (event) => { if (!event.shiftKey && !event.metaKey && !event.ctrlKey) extending = false; },
      wheel: (event) => {
        if (!view || compositionWait || loading.value) return;
        if (event.deltaY > 0 && view.scrollDOM.scrollTop + view.scrollDOM.clientHeight >= view.scrollDOM.scrollHeight - 4 && windowRange?.truncated) {
          event.preventDefault(); void moveWindow(1).catch(showError);
        } else if (event.deltaY < 0 && view.scrollDOM.scrollTop <= 0 && windowRange && (windowRange.startLine > 0 || windowRange.startColumn > 0)) {
          event.preventDefault(); void moveWindow(-1).catch(showError);
        }
      },
    }),
    EditorView.updateListener.of((update) => {
      if (replacingWindow) return;
      if (update.docChanged) {
        // A range response started before this keystroke must never replace it.
        requestGeneration += 1; loading.value = false;
        if (!beforeInputSelection || submitting && pendingVersion === submittedInputVersion) {
          beforeInputSelection = { anchor: { ...logicalAnchor }, head: { ...logicalHead } };
        }
        if (!pendingGlobalPatch && windowRange) {
          const range = orderedLargeRange(logicalAnchor, logicalHead);
          const start = { line: windowRange.startLine, column: windowRange.startColumn };
          const end = advanceLargePosition(start, update.startState.doc.toString());
          if (compareLargePosition(range.start, start) < 0 || compareLargePosition(range.end, end) > 0) {
            const local = update.startState.selection.main;
            pendingGlobalPatch = { ...range, prefix: local.from, suffix: update.startState.doc.length - local.to };
            if (compareLargePosition(range.start, start) < 0) {
              windowRange = { ...windowRange, startLine: range.start.line, startColumn: range.start.column };
            }
            extending = false;
          }
        }
        pendingVersion += 1; tracker?.recordPendingInput();
        searchCoordinator.cancel(); findRevision = -1; findFingerprint = '';
        if (findReplaceStore.open && appStore.splitLayout.activePaneId === props.paneId) setFindResult(0, -1);
        if (tab.value) tab.value.isDirty = true;
        if (appStore.activeTabId === tab.value?.id) appStore.isDirty = true;
        scheduleSubmission();
      }
      if (update.docChanged || update.selectionSet) recordSelection();
    }),
    EditorView.theme({ "&": { height: "100%", fontSize: "14px" }, ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, monospace" },
      ".cm-content": { whiteSpace: "pre", minWidth: "100%", caretColor: "var(--lm-ink)" }, ".cm-line": { padding: "0 8px" },
      ".cm-gutters": { backgroundColor: "var(--lm-surface-soft)", color: "var(--lm-ink-muted)", borderColor: "var(--lm-border)" } }),
  ] }) });
  registerSession();
  ownerSession = largeFile.value?.sessionId ?? "";
  void loadWindow(logicalHead, true, true).catch(showError);
  window.addEventListener("lightmark:jump-line", handleJump);
  window.addEventListener("lightmark:find-command", handleFind);
  window.addEventListener("lightmark:capture-editor-target", captureLargeEditorTarget);
  window.addEventListener("lightmark:insert-snippet", insertSnippetIntoLargeEditor);
});
watch(() => JSON.stringify([findReplaceStore.open, findReplaceStore.query, findOptions(), appStore.splitLayout.activePaneId, largeFile.value?.sessionId]), () => {
  searchCoordinator.cancel(); findRevision = -1; findFingerprint = '';
});
watch(() => largeFile.value?.sessionId, (next) => {
  if (!view || next === ownerSession) return;
  ownerSession = next ?? ""; requestGeneration += 1; cache.clear(); failed.value = ""; baseText = "";
  baseRaw = ""; failedSubmission = null; pendingGlobalPatch = null; beforeInputSelection = null;
  logicalAnchor = logicalHead = { line: 0, column: 0 }; registerSession();
  void loadWindow(logicalHead, false, true).catch(showError);
});
onUnmounted(() => {
  searchCoordinator.cancel();
  if (submitTimer) clearTimeout(submitTimer);
  requestGeneration += 1;
  if (!appStore.tabs.some(item => item.largeFile?.sessionId === ownerSession)) releaseLargeSessionBookmarks(ownerSession);
  unregister?.(); view?.destroy(); view = null; cache.clear();
  window.removeEventListener("lightmark:jump-line", handleJump);
  window.removeEventListener("lightmark:find-command", handleFind);
  window.removeEventListener("lightmark:capture-editor-target", captureLargeEditorTarget);
  window.removeEventListener("lightmark:insert-snippet", insertSnippetIntoLargeEditor);
});
</script>

<template>
  <section class="large-source-editor">
    <div class="large-source-bar">
      <strong>大文件源码</strong><span>{{ totalLines.toLocaleString() }} 行</span>
      <span v-if="readOnly">超过 500MiB · 只读</span><span v-if="loading">读取中…</span>
      <span v-if="backgroundJob">{{ backgroundJob.kind === 'search' ? '查找' : '替换' }} {{ Math.round(backgroundJob.progress * 100) }}% <button @click="cancelLargeSourceJob(backgroundJob.sessionId).catch(showError)">取消</button></span>
      <button @click="moveWindow(-1).catch(showError)">上一窗口</button><button @click="moveWindow(1).catch(showError)">下一窗口</button>
      <label>行 <input v-model.number="jumpLine" type="number" min="1" :max="totalLines" @keydown.enter="goToPosition().catch(showError)"></label>
      <label>列 <input v-model.number="jumpColumn" type="number" min="1" @keydown.enter="goToPosition().catch(showError)"></label>
      <button @click="goToPosition().catch(showError)">跳转</button>
      <button @click="previewSelection">预览选区</button><button @click="exportSelection">导出选区</button>
    </div>
    <div v-if="failed" role="alert" class="large-source-error">{{ failed }} <button @click="submitPending(true).catch(showError)">重试提交</button><button @click="exportUnconfirmedWindow">导出未确认窗口</button><button @click="exportSelection">导出选区</button></div>
    <div class="large-source-content"><div ref="host" class="large-source-host" data-large-source-editor />
      <aside v-if="previewHtml" class="large-source-preview"><button @click="previewHtml = ''">关闭预览</button><p v-if="!previewReliable">片段之前的语法上下文无法可靠验证，请缩小范围或从章节起点预览。</p><article v-html="previewHtml" /></aside>
    </div>
    <div class="large-source-status">窗口 {{ windowLabel }} · 选区 {{ selectionLabel }} · 默认不折行 · Shift＋窗口边界方向键扩展选区 · 预览上限 1MiB / 复制上限 16MiB</div>
    <input class="large-source-track" type="range" min="0" :max="Math.max(0, totalLines - 1)" :value="jumpLine - 1" aria-label="跳转到文档逻辑行" @change="loadWindow({ line: Number(($event.target as HTMLInputElement).value), column: 0 }).catch(showError)">
  </section>
</template>
<style scoped>
.large-source-editor { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--lm-ink); background:var(--lm-surface); }
.large-source-bar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid #94a3b844; font-size:12px; }
.large-source-bar label { display:flex; align-items:center; gap:4px; }.large-source-bar input { width:72px; background:transparent; border:1px solid #94a3b866; border-radius:4px; }
button { padding:3px 6px; border:1px solid #94a3b855; border-radius:4px; }button:hover { background:#64748b22; }
.large-source-content { display:flex; flex:1; min-height:0; min-width:0; }.large-source-host { flex:1; min-width:0; overflow:hidden; }
.large-source-preview { width:40%; overflow:auto; padding:16px; border-left:1px solid #94a3b855; }.large-source-preview :deep(pre) { overflow:auto; }
.large-source-error { padding:8px 12px; color:#991b1b; background:#fee2e2; font-size:12px; }
.large-source-status { padding:4px 10px; font-size:11px; color:var(--lm-ink-muted); }.large-source-track { width:calc(100% - 24px); height:12px; margin:0 12px 4px; }
:global(.dark) .large-source-error { color:#fecaca; background:#450a0a; }
</style>
