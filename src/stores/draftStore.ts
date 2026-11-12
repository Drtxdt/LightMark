import { invoke } from "@tauri-apps/api/core";
import { reactive, toRaw } from "vue";
import { isMacDesktop } from "../utils/documentPath";
import {
  appStore,
  captureLargeFileDraftSnapshot,
  preparePaneActivation,
  paneActivationFenceStillCurrent,
  createRecoveredLargeTab,
  createUntitledTabAfterFlush,
  type PaneActivationBoundary,
  flushDocumentSnapshotWithReceipt,
  getPaneTab,
  setContent,
  switchMode,
  largePaneForTab,
} from "./appStore";
import {
  documentMutationTokensEqual,
  type DocumentFlushReceipt,
  type DocumentMutationToken,
} from "../editor/documentMutationTracker";
import {
  documentSessionForTab,
  flushDocumentSessionPendingEdits,
  type DocumentSessionAdapter,
  type DocumentSessionFlushResult,
} from "../editor/documentRuntime";
import {
  mutationEpoch,
  SaveTransactionQueue,
  type WindowCloseDraftReceipt,
} from "./saveTransaction";
import { showDialog } from "./dialogStore";
import type {
  DocumentTab,
  DraftListReceipt,
  DraftRecord,
  FileSnapshot,
  LargeDraftDeleteReceipt,
  LargeDraftOpenReceipt,
  TextFileWriteReceipt,
} from "../types";

type DraftStatus = "idle" | "saved" | "failed" | "recoverable" | "restored";

export const draftStore = reactive({
  status: "idle" as DraftStatus,
  message: "",
  lastSavedAt: 0,
  activeDraftId: "",
});

let autosaveTimer = 0;
const lastCheckpoint = new WeakMap<DocumentTab, DraftVersion>();
const checkpointInProgress = new WeakSet<DocumentTab>();
const draftTransactionQueue = new SaveTransactionQueue();
const untitledDraftIds = new WeakMap<DocumentTab, string>();
// Native draft commands are individually locked, but a large-draft cleanup
// spans manifest deletion, owned-snapshot deletion, and possible manifest
// restoration. Serialize every operation for the same draft id in this
// process so a stale compensation write cannot overwrite a newer record.
const draftRecordLocks = new Map<string, Promise<void>>();

function withDraftRecordLock<T>(id: string, task: () => Promise<T> | T) {
  const previous = draftRecordLocks.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  const completion = next.then(() => undefined, () => undefined);
  draftRecordLocks.set(id, completion);
  void completion.then(() => {
    if (draftRecordLocks.get(id) === completion) draftRecordLocks.delete(id);
  });
  return next;
}

type DraftContext = {
  tab: DocumentTab;
  tabId: string;
  path: string;
  session: DocumentSessionAdapter | null;
  epoch: number;
  revision: number | null;
  pendingVersion: number | null;
  mutationToken: DocumentMutationToken | null;
};

type DraftVersion = DraftContext & {
  flushReceipt?: DocumentFlushReceipt;
  largeFlush?: DocumentSessionFlushResult;
};

export type WindowCloseDraftPolicy = "preserve" | "delete";

export interface WindowCloseDraftExpectedVersion {
  tab: DocumentTab;
  tabId: string;
  path: string;
  kind: DocumentTab["kind"];
  documentMode: DocumentTab["documentMode"];
  epoch: number;
  revision: number | null;
  pendingVersion: number | null;
  session: DocumentSessionAdapter | null;
  mutationToken: DocumentMutationToken | null;
  flushReceipt?: DocumentFlushReceipt;
  content: string;
  dirty: boolean;
  pending: boolean;
  largeFile: DocumentTab["largeFile"];
  largePendingEdits: string;
}

export type WindowCloseDraftFlushResult =
  | {
      ok: true;
      receipts: WindowCloseDraftReceipt[];
      failures: [];
    }
  | {
      ok: false;
      receipts: WindowCloseDraftReceipt[];
      failures: Array<{ tabId: string; error: unknown }>;
    };

export type DraftCleanupContext = DraftContext & {
  id: string;
  content: string;
};

export type DraftCleanupReceipt = DraftContext & {
  content: string;
  dirty: boolean;
};

type DraftRestoreFence = DraftContext & {
  kind: DocumentTab["kind"];
  documentMode: DocumentTab["documentMode"];
  content: string;
  dirty: boolean;
  pending: boolean;
  largeFile: DocumentTab["largeFile"];
};

export function startDraftAutosave() {
  stopDraftAutosave();
  if (!appStore.settings.general.autoSave) return;
  window.addEventListener("blur", checkpointOpenDrafts);
  document.addEventListener("visibilitychange", flushDraftWhenHidden);
  autosaveTimer = window.setInterval(() => {
    checkpointOpenDrafts();
  }, autosaveIntervalMs());
}

export function stopDraftAutosave() {
  if (autosaveTimer) {
    window.clearInterval(autosaveTimer);
    autosaveTimer = 0;
  }
  window.removeEventListener("blur", checkpointOpenDrafts);
  document.removeEventListener("visibilitychange", flushDraftWhenHidden);
}

export async function recoverStartupDrafts() {
  const expectedTab = activeDraftTab();
  const listing = await readDraftListing();
  if (!listing) return;
  const issueMessage = formatDraftIssues(listing.issues);
  const drafts = listing.records;
  const untitled = drafts.find((draft) => draft.kind === "untitled" && draft.content);
  const large = drafts.find((draft) => draft.kind === "large" && draft.largeSnapshot);
  if (!untitled && !large) {
    if (issueMessage) {
      draftStore.status = "failed";
      draftStore.message = issueMessage;
    }
    return;
  }
  draftStore.status = "recoverable";
  draftStore.message = `发现未命名草稿${issueMessage ? `；${issueMessage}` : ""}`;
  await promptRecoverDraft(
    untitled ?? large!,
    untitled ? "发现未保存的未命名草稿，是否恢复？" : "发现未保存的大文件草稿，是否恢复为新文档？",
    untitled ? expectedTab : null,
  );
}

export async function checkDraftForOpenedFile(path: string) {
  const expectedTab = activeDraftTab();
  const listing = await readDraftListing();
  if (!listing) return;
  const issueMessage = formatDraftIssues(listing.issues);
  const drafts = listing.records;
  const draft = drafts.find((item) => item.path === path && (item.kind === "file" || item.kind === "large"));
  if (!draft) {
    if (issueMessage) {
      draftStore.status = "failed";
      draftStore.message = issueMessage;
    }
    return;
  }
  const snapshot = await getFileSnapshot(path).catch((error) => {
    draftStore.status = "failed";
    draftStore.message = `文件状态读取失败：${formatDraftError(error)}`;
    return null;
  });
  if (!snapshot) return;
  const draftIsNewer = !snapshot.exists || !snapshot.mtime || draft.updatedAt > snapshot.mtime;
  if (!draftIsNewer) return;
  draftStore.status = "recoverable";
  draftStore.message = `发现可恢复草稿${issueMessage ? `；${issueMessage}` : ""}`;
  await promptRecoverDraft(draft, "发现这个文件有比磁盘更新的 LightMark 草稿，是否恢复？", expectedTab, path);
}

export async function flushCurrentDraft() {
  if (!appStore.settings.general.autoSave) return;
  const tab = activeDraftTab();
  if (!tab || (!tab.isDirty && documentSessionForTab(tab.id)?.hasPendingEdits?.() !== true)) return;
  const context = captureDraftContext(tab);
  const result = await draftTransactionQueue.enqueue(tab, () => flushDraftForContext(context));
  return result.saved;
}

/**
 * Flush recovery drafts for a window-close decision.  This deliberately does
 * not consult the normal auto-save setting: choosing “do not save” still
 * promises to retain the version shown by the prompt for recovery.  The
 * delete policy is intentionally explicit but unsupported until the product
 * defines which draft version it is allowed to remove.
 */
export async function flushDraftsForWindowClose(
  tabs: readonly DocumentTab[],
  policy: WindowCloseDraftPolicy = "preserve",
  expectedVersions: readonly WindowCloseDraftExpectedVersion[] = [],
): Promise<WindowCloseDraftFlushResult> {
  if (policy === "delete") {
    return {
      ok: false,
      receipts: [],
      failures: [{ tabId: "", error: new Error("窗口关闭草稿删除策略尚未定义。") }],
    };
  }

  const seen = new Set<DocumentTab>();
  const expectedByTab = new Map(expectedVersions.map((version) => [toRaw(version.tab), version]));
  const receipts: WindowCloseDraftReceipt[] = [];
  const failures: Array<{ tabId: string; error: unknown }> = [];
  for (const candidate of tabs) {
    const tab = toRaw(candidate) as DocumentTab;
    if (seen.has(tab)) continue;
    seen.add(tab);
    const expected = expectedByTab.get(tab);
    if (expected && !isWindowCloseDraftExpectedVersionCurrent(expected)) {
      failures.push({ tabId: tab.id, error: new Error("退出提示期间文档版本发生了变化。") });
      continue;
    }
    const session = documentSessionForTab(tab.id);
    if (!tab.isDirty && session?.hasPendingEdits?.() !== true) continue;
    const context = captureDraftContext(tab);
    try {
      const result = await draftTransactionQueue.enqueue(tab, () => (
        flushDraftForContext(context, { allowInactive: true, requirePromptVersion: true })
      ));
      if (!result.saved) {
        failures.push({
          tabId: tab.id,
          error: new Error(result.reason || "文档版本在退出草稿保存期间发生变化。"),
        });
      } else if (result.receipt) {
        receipts.push(result.receipt);
      }
    } catch (error) {
      failures.push({ tabId: tab.id, error });
    }
  }
  return failures.length > 0
    ? { ok: false, receipts, failures }
    : { ok: true, receipts, failures: [] };
}

export async function clearActiveDraft() {
  const tab = activeDraftTab();
  const context = tab ? captureDraftCleanupContext(tab) : null;
  return clearCapturedDraft(context);
}

export function captureDraftCleanupContext(tab: DocumentTab): DraftCleanupContext | null {
  tab = toRaw(tab) as DocumentTab;
  const id = tab.path ? draftIdForPath(tab.path) : untitledDraftIds.get(tab) ?? "";
  if (!id) return null;
  const context = captureDraftCleanupReceipt(tab);
  return {
    ...context,
    id,
  };
}

export function captureDraftCleanupReceipt(tab: DocumentTab): DraftCleanupReceipt {
  tab = toRaw(tab) as DocumentTab;
  const context = captureDraftContext(tab);
  return {
    ...context,
    content: tab.content,
    dirty: tab.isDirty,
  };
}

export function clearCapturedDraft(context: DraftCleanupContext | null, options: { receipt?: DraftCleanupReceipt } = {}) {
  if (!context?.id) return Promise.resolve(false);
  return draftTransactionQueue.enqueue(context.tab, async () => {
    const current = options.receipt
      ? isDraftCleanupReceiptCurrent(options.receipt)
      : isDraftCleanupCurrent(context);
    if (!current) return false;
    try {
      if (context.tab.documentMode === "large") {
        const listing = await listDrafts();
        const record = listing.records.find((item) => item.id === context.id && item.kind === "large");
        if (listing.issues.length > 0) draftStore.message = formatDraftIssues(listing.issues);
        if (record?.largeSnapshot) {
          await deleteLargeDraftRecord(context.id, record);
        } else {
          await deleteDraft(context.id);
        }
      } else {
        await deleteDraft(context.id);
      }
    } catch (error) {
      draftStore.status = "failed";
      draftStore.message = `草稿清理失败：${formatDraftError(error)}`;
      return false;
    }
    const stillCurrent = options.receipt
      ? isDraftCleanupReceiptCurrent(options.receipt)
      : isDraftCleanupCurrent(context);
    if (!stillCurrent) {
      draftStore.status = "failed";
      draftStore.message = "文档在草稿清理期间发生了变化，已保留当前修改。";
      return false;
    }
    if (!context.path && untitledDraftIds.get(context.tab) === context.id) untitledDraftIds.delete(context.tab);
    if (draftStore.activeDraftId === context.id) {
      draftStore.activeDraftId = "";
      draftStore.status = "idle";
      draftStore.message = "";
    }
    return true;
  });
}

export async function discardDraft(id: string, record?: DraftRecord) {
  if (record?.kind === "large" && record.largeSnapshot) {
    await deleteLargeDraftRecord(id, record);
  } else {
    await deleteDraft(id);
  }
  if (id === draftStore.activeDraftId) draftStore.activeDraftId = "";
  const active = activeDraftTab();
  if (active && !active.path && untitledDraftIds.get(active) === id) untitledDraftIds.delete(active);
}

function flushDraftWhenHidden() {
  if (document.visibilityState === "hidden") checkpointOpenDrafts();
}

function checkpointOpenDrafts() {
  for (const candidate of appStore.tabs) {
    const tab = toRaw(candidate);
    if (checkpointInProgress.has(tab)) continue;
    if (!tab.isDirty && !documentSessionForTab(tab.id)?.hasPendingEdits?.()) continue;
    const previous = lastCheckpoint.get(tab);
    if (previous && isDraftVersionCurrent(previous) && !previous.session?.hasPendingEdits?.()) continue;
    checkpointInProgress.add(tab);
    void draftTransactionQueue.enqueue(tab, async () => {
      if (!appStore.settings.general.autoSave || !isTabRegistered(tab)) return;
      if (!tab.isDirty && !documentSessionForTab(tab.id)?.hasPendingEdits?.()) return;
      await flushDraftForContext(captureDraftContext(tab), { allowInactive: true });
    }).finally(() => checkpointInProgress.delete(tab));
  }
}

async function flushDraftForContext(
  context: DraftContext,
  options: { allowInactive?: boolean; requirePromptVersion?: boolean } = {},
): Promise<{
  saved: boolean;
  reason?: string;
  receipt?: WindowCloseDraftReceipt;
}> {
  const beforePending = context.session?.hasPendingEdits?.() === true;
  const beforeContent = context.tab.content;
  const beforeDirty = context.tab.isDirty;
  let flushReceipt: DocumentFlushReceipt | undefined;
  let largeFlush: DocumentSessionFlushResult | undefined;
  try {
    if (!isCurrentDraftContext(context)) return { saved: false, reason: "草稿对应的标签页或编辑器会话已变化。" };
    if (context.tab.documentMode === "large") {
      largeFlush = (await flushDocumentSessionPendingEdits(context.tabId, "draft")) ?? undefined;
      if (!isCurrentDraftContext(context)) {
        return { saved: false, reason: "大文件草稿 flush 期间编辑器会话已被替换。" };
      }
    } else {
      const flushed = await flushDocumentSnapshotWithReceipt(context.tabId, "draft");
      flushReceipt = flushed.flushReceipt;
      if (!isCurrentDraftContext(context)) {
        return { saved: false, reason: "草稿快照期间编辑器会话已被替换。" };
      }
    }
    const version = captureDraftVersion(context, flushReceipt, largeFlush);
    const authorizedLargeFlush = Boolean(
      largeFlush
      && context.tab.documentMode === "large"
      && largeFlush.session === context.session
      && context.revision === largeFlush.beforeRevision
      && version.revision === largeFlush.afterRevision
      && version.session === context.session
      && version.pendingVersion === context.pendingVersion
      && largeFlush.afterRevision >= largeFlush.beforeRevision
      && mutationTokensMatch(largeFlush.beforeToken, context.mutationToken)
      && mutationTokensMatch(largeFlush.afterToken, version.mutationToken),
    );
    const record = await buildDraftRecord(context);
    const authorizedFlush = Boolean(
      flushReceipt
      && context.mutationToken
      && version.mutationToken
      && flushReceipt.sessionIdentity === context.session
      && documentMutationTokensEqual(flushReceipt.before, context.mutationToken)
      && documentMutationTokensEqual(flushReceipt.after, version.mutationToken),
    );
    if (options.requirePromptVersion === true
      && (version.session !== context.session
        || (beforePending && context.pendingVersion === null)
        || (!authorizedFlush && !authorizedLargeFlush && version.pendingVersion !== context.pendingVersion)
        || (context.mutationToken != null && !authorizedFlush && !authorizedLargeFlush
          && (version.mutationToken == null
            || !documentMutationTokensEqual(version.mutationToken, context.mutationToken)))
        || (beforePending && !flushReceipt && !authorizedLargeFlush)
        || (!authorizedFlush && !authorizedLargeFlush && version.epoch !== context.epoch)
        || (!authorizedFlush && !authorizedLargeFlush && version.revision !== context.revision)
        || (!authorizedFlush && !authorizedLargeFlush && version.tab.content !== beforeContent)
        || (!authorizedFlush && !authorizedLargeFlush && version.tab.isDirty !== beforeDirty))) {
      return { saved: false, reason: "退出提示期间文档版本发生了变化。" };
    }
    if (!isDraftVersionCurrent(version)) {
      return { saved: false, reason: "草稿版本在生成期间发生变化。" };
    }
    if (record) {
      const writeReceipt = await persistDraftRecord(record);
      if (!isDraftVersionCurrent(version)) {
        return { saved: false, reason: "草稿写入期间文档发生了变化。" };
      }
      if (options.allowInactive !== true && appStore.activeTabId !== context.tabId) {
        return { saved: false, reason: "草稿写入期间活动标签页发生变化。" };
      }
      lastCheckpoint.set(context.tab, version);
      if (appStore.activeTabId === context.tabId) {
        draftStore.activeDraftId = record.id;
        draftStore.status = "saved";
        draftStore.lastSavedAt = record.updatedAt;
        const receiptNotice = [
          writeReceipt.cleanupWarning ? `清理提示：${writeReceipt.cleanupWarning}` : "",
          writeReceipt.recoveryArtifact ? `恢复材料：${writeReceipt.recoveryArtifact}` : "",
        ].filter(Boolean).join("；");
        draftStore.message = receiptNotice
          ? `草稿已保存 ${formatTime(record.updatedAt)}；${receiptNotice}`
          : `草稿已保存 ${formatTime(record.updatedAt)}`;
      }
    }
    return {
      saved: true,
      receipt: {
        tab: context.tab,
        tabId: context.tabId,
        path: context.path,
        session: version.session,
        beforeEpoch: context.epoch,
        beforeRevision: context.revision,
        beforePendingVersion: context.pendingVersion,
        beforePending,
        beforeMutationToken: context.mutationToken,
        afterEpoch: version.epoch,
        afterRevision: version.revision,
        afterPendingVersion: version.pendingVersion,
        afterPending: version.session?.hasPendingEdits?.() === true,
        afterMutationToken: version.mutationToken,
        flushReceipt: version.flushReceipt,
        largeFlush: version.largeFlush
          ? {
              session: version.largeFlush.session,
              beforeRevision: version.largeFlush.beforeRevision,
              afterRevision: version.largeFlush.afterRevision,
              beforeToken: version.largeFlush.beforeToken,
              afterToken: version.largeFlush.afterToken,
            }
          : undefined,
        content: version.tab.content,
        dirty: version.tab.isDirty,
        draftId: record?.id ?? "",
      },
    };
  } catch (error) {
    if (isCurrentActiveDraftContext(context)) {
      draftStore.status = "failed";
      draftStore.message = `草稿保存失败：${formatDraftError(error)}`;
    }
    return { saved: false, reason: formatDraftError(error) };
  }
}

async function buildDraftRecord(context: DraftContext): Promise<DraftRecord | null> {
  const updatedAt = Date.now();
  if (context.tab.documentMode === "large" && context.tab.largeFile) {
    const largeFile = context.tab.largeFile;
    const id = largeFile.recoveryDraftId || (context.path ? draftIdForPath(context.path) : draftIdForTab(context.tab));
    const capture = await captureLargeDraftSnapshot(context, id);
    const originPath = capture.snapshot.originPath || context.path;
    return {
      id,
      kind: "large",
      schemaVersion: capture.snapshot.schemaVersion,
      path: originPath || undefined,
      largeSnapshot: capture.snapshot,
      fileMtime: capture.snapshot.originFingerprint.modifiedMillis ?? undefined,
      fileSize: capture.snapshot.originFingerprint.sizeBytes,
      updatedAt,
      editorMode: context.tab.editorMode,
    };
  }
  if (context.path) {
    const snapshot = await getFileSnapshot(context.path).catch((): FileSnapshot => missingSnapshot());
    return {
      id: draftIdForPath(context.path),
      kind: "file",
      path: context.path,
      content: context.tab.content,
      fileMtime: snapshot.mtime,
      fileSize: snapshot.size,
      updatedAt,
      editorMode: context.tab.editorMode,
    };
  }
  // A whitespace-only untitled document still contains user bytes and must
  // be recoverable.  Only a truly empty untitled buffer has no payload to
  // persist.
  if (context.tab.content.length === 0) return null;
  const id = draftIdForTab(context.tab);
  return {
    id,
    kind: "untitled",
    content: context.tab.content,
    updatedAt,
    editorMode: context.tab.editorMode,
  };
}

function activeDraftTab() {
  const tab = appStore.tabs.find((item) => item.id === appStore.activeTabId) ?? null;
  return tab ? toRaw(tab) as DocumentTab : null;
}

function captureDraftContext(tab: DocumentTab): DraftContext {
  tab = toRaw(tab) as DocumentTab;
  const session = documentSessionForTab(tab.id);
  return {
    tab,
    tabId: tab.id,
    path: tab.path,
    session,
    epoch: mutationEpoch(tab),
    revision: session?.revision ?? (tab.documentMode === "large" ? tab.largeFile?.revision ?? null : null),
    pendingVersion: pendingEditVersion(session),
    mutationToken: session?.mutationToken?.() ?? null,
  };
}

function captureDraftRestoreFence(tab: DocumentTab): DraftRestoreFence {
  tab = toRaw(tab) as DocumentTab;
  const context = captureDraftContext(tab);
  return {
    ...context,
    kind: tab.kind,
    documentMode: tab.documentMode,
    content: tab.content,
    dirty: tab.isDirty,
    pending: context.session?.hasPendingEdits?.() === true,
    largeFile: tab.largeFile,
  };
}

function captureDraftVersion(
  context: DraftContext,
  flushReceipt?: DocumentFlushReceipt,
  largeFlush?: DocumentSessionFlushResult,
): DraftVersion {
  const session = documentSessionForTab(context.tabId);
  return {
    ...context,
    epoch: mutationEpoch(context.tab),
    revision: session?.revision
      ?? (context.tab.documentMode === "large" ? context.tab.largeFile?.revision ?? null : null),
    pendingVersion: pendingEditVersion(session),
    session,
    mutationToken: session?.mutationToken?.() ?? null,
    flushReceipt,
    largeFlush,
  };
}

function isCurrentDraftContext(context: DraftContext) {
  return isTabRegistered(context.tab)
    && context.tab.id === context.tabId
    && context.tab.path === context.path
    && documentSessionForTab(context.tabId) === context.session;
}

function isDraftRestoreFenceCurrent(fence: DraftRestoreFence) {
  const tab = toRaw(fence.tab) as DocumentTab;
  const session = documentSessionForTab(fence.tabId);
  return isCurrentDraftContext(fence)
    && appStore.activeTabId === fence.tabId
    && tab.kind === fence.kind
    && tab.documentMode === fence.documentMode
    && tab.content === fence.content
    && tab.isDirty === fence.dirty
    && mutationEpoch(tab) === fence.epoch
    && (session?.revision
      ?? (tab.documentMode === "large" ? tab.largeFile?.revision ?? null : null)) === fence.revision
    && pendingEditVersion(session) === fence.pendingVersion
    && (session?.hasPendingEdits?.() === true) === fence.pending
    && toRaw(tab.largeFile) === toRaw(fence.largeFile)
    && ((fence.mutationToken == null && session?.mutationToken?.() == null)
      || (fence.mutationToken != null
        && session?.mutationToken?.() != null
        && documentMutationTokensEqual(fence.mutationToken, session.mutationToken())));
}

function isCurrentActiveDraftContext(context: DraftContext) {
  return isCurrentDraftContext(context) && appStore.activeTabId === context.tabId;
}

function isDraftVersionCurrent(version: DraftVersion) {
  const session = documentSessionForTab(version.tabId);
  const mutationToken = session?.mutationToken?.() ?? null;
  return isCurrentDraftContext(version)
    && mutationEpoch(version.tab) === version.epoch
    && (session?.revision
      ?? (version.tab.documentMode === "large" ? version.tab.largeFile?.revision ?? null : null)) === version.revision
    && pendingEditVersion(session) === version.pendingVersion
    && (!version.mutationToken
      || (mutationToken != null && documentMutationTokensEqual(version.mutationToken, mutationToken)))
    && (!version.flushReceipt
      || (version.flushReceipt.sessionIdentity === version.session
        && mutationToken != null
        && documentMutationTokensEqual(version.flushReceipt.after, mutationToken)))
    && (!version.largeFlush
      || (version.largeFlush.session === session
        && session?.revision === version.largeFlush.afterRevision
        && (version.largeFlush.afterToken == null
          || (mutationToken != null && documentMutationTokensEqual(version.largeFlush.afterToken, mutationToken)))))
    && session?.hasPendingEdits?.() !== true;
}

function isWindowCloseDraftExpectedVersionCurrent(expected: WindowCloseDraftExpectedVersion) {
  const tab = toRaw(expected.tab) as DocumentTab;
  const session = documentSessionForTab(expected.tabId);
  if (expected.pending && expected.pendingVersion === null) return false;
  return isTabRegistered(tab)
    && tab.id === expected.tabId
    && tab.path === expected.path
    && tab.kind === expected.kind
    && tab.documentMode === expected.documentMode
    && tab.content === expected.content
    && tab.isDirty === expected.dirty
    && toRaw(tab.largeFile) === toRaw(expected.largeFile)
    && JSON.stringify(tab.largeFile?.pendingEdits ?? []) === expected.largePendingEdits
    && mutationEpoch(tab) === expected.epoch
    && session === expected.session
    && ((expected.mutationToken == null && session?.mutationToken?.() == null)
      || (expected.mutationToken != null
        && session?.mutationToken?.() != null
        && documentMutationTokensEqual(expected.mutationToken, session.mutationToken())))
    && (session?.revision
      ?? (tab.documentMode === "large" ? tab.largeFile?.revision ?? null : null)) === expected.revision
    && pendingEditVersion(session) === expected.pendingVersion
    && (session?.hasPendingEdits?.() === true) === expected.pending;
}

function isDraftCleanupCurrent(context: DraftCleanupContext) {
  if (!isTabRegistered(context.tab)) return false;
  const session = documentSessionForTab(context.tabId);
  return context.tab.id === context.tabId
    && context.tab.path === context.path
    && session === context.session
    && mutationEpoch(context.tab) === context.epoch
    && (session?.revision
      ?? (context.tab.documentMode === "large" ? context.tab.largeFile?.revision ?? null : null)) === context.revision
    && pendingEditVersion(session) === context.pendingVersion
    && ((context.mutationToken == null && session?.mutationToken?.() == null)
      || (context.mutationToken != null
        && session?.mutationToken?.() != null
        && documentMutationTokensEqual(context.mutationToken, session.mutationToken())));
}

function isDraftCleanupReceiptCurrent(receipt: DraftCleanupReceipt) {
  if (!isTabRegistered(receipt.tab)) return false;
  const session = documentSessionForTab(receipt.tabId);
  return receipt.tab.id === receipt.tabId
    && receipt.tab.path === receipt.path
    && receipt.tab.content === receipt.content
    && receipt.tab.isDirty === receipt.dirty
    && mutationEpoch(receipt.tab) === receipt.epoch
    && session === receipt.session
    && (session?.revision
      ?? (receipt.tab.documentMode === "large" ? receipt.tab.largeFile?.revision ?? null : null)) === receipt.revision
    && pendingEditVersion(session) === receipt.pendingVersion
    && ((receipt.mutationToken == null && session?.mutationToken?.() == null)
      || (receipt.mutationToken != null
        && session?.mutationToken?.() != null
        && documentMutationTokensEqual(receipt.mutationToken, session.mutationToken())));
}

function isTabRegistered(tab: DocumentTab) {
  return appStore.tabs.some((item) => toRaw(item) === tab);
}

function draftIdForTab(tab: DocumentTab) {
  tab = toRaw(tab) as DocumentTab;
  if (tab.path) return draftIdForPath(tab.path);
  const existing = untitledDraftIds.get(tab);
  if (existing) return existing;
  const id = `untitled-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  untitledDraftIds.set(tab, id);
  return id;
}

function pendingEditVersion(session: DocumentSessionAdapter | null) {
  const value = session?.pendingEditVersion?.();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mutationTokensMatch(left: DocumentMutationToken | null, right: DocumentMutationToken | null) {
  if (left == null || right == null) return left == null && right == null;
  return documentMutationTokensEqual(left, right);
}

async function promptRecoverDraft(record: DraftRecord, message: string, expectedTab: DocumentTab | null = null, expectedPath?: string) {
  const restoreFence = expectedTab ? captureDraftRestoreFence(expectedTab) : null;
  const result = await showDialog({
    title: "发现可恢复草稿",
    message,
    cancelId: "keep",
    defaultId: "restore",
    buttons: [
      { id: "keep", label: "保留稍后处理", variant: "secondary" },
      { id: "discard", label: "丢弃草稿", variant: "danger" },
      { id: "restore", label: "恢复草稿", variant: "primary" },
    ],
  });
  if (result === "restore") {
    await restoreDraft(record, expectedTab, expectedPath, restoreFence);
    return;
  }
  if (result === "discard") {
    await discardDraft(record.id, record);
  }
}

async function restoreDraft(
  record: DraftRecord,
  expectedTab: DocumentTab | null = null,
  expectedPath?: string,
  restoreFence: DraftRestoreFence | null = null,
) {
  if (expectedTab && (!restoreFence
    || !isDraftRestoreFenceCurrent(restoreFence)
    || appStore.activeTabId !== expectedTab.id
    || (expectedPath !== undefined && expectedTab.path !== expectedPath))) {
    draftStore.message = "当前标签页已变化，草稿仍保留待处理。";
    return;
  }
  if (record.kind === "large") {
    if (!record.largeSnapshot) {
      draftStore.status = "recoverable";
      draftStore.message = "旧版大文件草稿只包含坐标编辑，已保留待人工处理。";
      return;
    }
    const activationFence = await prepareRecoveryActivationFence();
    if (!activationFence) return;
    const opened = await invoke<LargeDraftOpenReceipt>("open_large_file_draft", {
      snapshotId: record.largeSnapshot.snapshotId,
    });
    if (opened.targetPath !== null || opened.session.path !== "") {
      throw new Error("大文件恢复必须打开为无目标的新文档。");
    }
    if (!isRecoveryActivationFenceCurrent(activationFence)) {
      draftStore.message = "恢复期间当前标签页或编辑器会话发生了变化，草稿仍保留待处理。";
      return;
    }
    createRecoveredLargeTab(opened, activationFence.paneId);
  } else {
    if (record.kind === "untitled") {
      let tab: DocumentTab | null;
      try {
        tab = await createUntitledTabAfterFlush(
          appStore.splitLayout.activePaneId,
          record.content || "",
          true,
        );
      } catch (error) {
        draftStore.status = "failed";
        draftStore.message = `恢复草稿前的输入 flush 失败，草稿仍保留：${formatDraftError(error)}`;
        return;
      }
      if (!tab) {
        draftStore.message = "当前标签页或编辑器会话已变化，未覆盖当前输入；草稿仍保留待处理。";
        return;
      }
      untitledDraftIds.set(tab, record.id);
    } else {
      setContent(record.content || "", true);
    }
  }
  if (record.kind !== "large" && (record.editorMode === "wysiwyg" || record.editorMode === "source")) {
    await switchMode(record.editorMode);
  }
  draftStore.activeDraftId = record.id;
  draftStore.status = "restored";
  draftStore.message = "已恢复草稿";
}

type RecoveryActivationFence = {
  paneId: "main" | "secondary";
  boundary: PaneActivationBoundary;
};

/** Flush the active view before opening a recovered large document into it. */
async function prepareRecoveryActivationFence(): Promise<RecoveryActivationFence | null> {
  const paneId = appStore.splitLayout.activePaneId;
  const boundary = await preparePaneActivation(paneId, "tabSwitch");
  if (!boundary) {
    draftStore.message = "恢复期间当前标签页或编辑器会话发生了变化，草稿仍保留待处理。";
    return null;
  }
  return { paneId, boundary };
}

function isRecoveryActivationFenceCurrent(fence: RecoveryActivationFence) {
  return appStore.splitLayout.activePaneId === fence.paneId
    && paneActivationFenceStillCurrent(fence.boundary.fence, fence.boundary.flushed);
}

function draftIdForPath(path: string) {
  return `file-${fnv1a(isMacDesktop() ? path : path.toLowerCase())}`;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function autosaveIntervalMs() {
  const minutes = appStore.settings.general.autoSaveIntervalMinutes;
  return minutes > 0 ? minutes * 60_000 : 8_000;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function listDrafts() {
  return invoke<DraftListReceipt>("list_drafts");
}

async function readDraftListing(): Promise<DraftListReceipt | null> {
  try {
    return await listDrafts();
  } catch (error) {
    draftStore.status = "failed";
    draftStore.message = `草稿列表读取失败：${formatDraftError(error)}`;
    return null;
  }
}

function deleteDraftNative(draftId: string) {
  return invoke("delete_draft", { draftId });
}

function deleteDraft(draftId: string) {
  return withDraftRecordLock(draftId, () => deleteDraftNative(draftId));
}

async function captureLargeDraftSnapshot(context: DraftContext, draftId: string) {
  const largeFile = context.tab.largeFile;
  if (!largeFile) throw new Error("大文件草稿缺少会话。");
  const receipt = await captureLargeFileDraftSnapshot(
    draftId,
    context.session?.paneId ?? largePaneForTab(context.tab),
  );
  if (receipt.sessionId !== largeFile.sessionId
    || receipt.requestedRevision !== largeFile.revision
    || receipt.currentRevision !== receipt.requestedRevision
    || receipt.snapshot.coordinateSpace !== largeFile.coordinateSpace
    || receipt.snapshot.draftId !== draftId) {
    throw new Error("大文件草稿回执与当前会话版本不一致。");
  }
  return receipt;
}

async function persistDraftRecordNative(record: DraftRecord) {
  const receipt = await invoke<TextFileWriteReceipt>("write_draft", { record });
  if (receipt.outcome !== "committed" || receipt.diskWritten !== "yes") {
    throw new Error(formatDraftWriteReceiptError(receipt));
  }
  return receipt;
}

async function persistDraftRecord(record: DraftRecord) {
  return withDraftRecordLock(record.id, () => persistDraftRecordNative(record));
}

/**
 * Remove a large draft manifest and its owned snapshot as one recoverable
 * operation.  The manifest goes first so a rejected payload delete can never
 * leave a visible record pointing at a missing snapshot.  If the payload
 * delete fails, restore the manifest; only a second native write failure can
 * leave an orphan payload, which is reported to the user for cleanup.
 */
async function deleteLargeDraftRecord(id: string, record: DraftRecord) {
  return withDraftRecordLock(id, async () => {
    // A record supplied by an older listing must never delete or compensate
    // over a newer record with the same path-derived id.
    const listing = await listDrafts();
    const current = listing.records.find((candidate) => candidate.id === id);
    if (!current) return;
    if (draftRecordVersionKey(current) !== draftRecordVersionKey(record)) {
      throw new Error("草稿版本已更新，未清理旧的恢复记录。");
    }
    await deleteDraftNative(id);
    try {
      const deleted = await deleteLargeDraftSnapshot(record.largeSnapshot);
      if (!deleted.deleted) throw new Error("大文件草稿快照未确认删除。");
      if (deleted.cleanupWarning) draftStore.message = `草稿快照已删除，但清理提示：${deleted.cleanupWarning}`;
    } catch (error) {
      try {
        await persistDraftRecordNative(record);
        draftStore.message = `大文件草稿快照清理失败，已恢复草稿记录：${formatDraftError(error)}`;
      } catch (restoreError) {
        draftStore.message = `大文件草稿清理失败，恢复记录也失败：${formatDraftError(error)}；${formatDraftError(restoreError)}`;
      }
      // Preserve the recovery result for callers that surface the thrown error
      // through their own generic catch. Otherwise clearCapturedDraft would
      // replace the useful manifest/restore diagnosis with only the native
      // payload error, making a still recoverable draft look lost.
      throw new Error(draftStore.message || formatDraftError(error));
    }
  });
}

function draftRecordVersionKey(record: DraftRecord) {
  const snapshot = record.largeSnapshot;
  return JSON.stringify({
    id: record.id,
    kind: record.kind,
    path: record.path ?? "",
    updatedAt: record.updatedAt,
    content: record.content ?? "",
    snapshotId: snapshot?.snapshotId ?? "",
    snapshotSha256: snapshot?.sha256 ?? "",
    capturedRevision: snapshot?.capturedRevision ?? null,
  });
}

function deleteLargeDraftSnapshot(snapshot: DraftRecord["largeSnapshot"]) {
  if (!snapshot) throw new Error("大文件草稿缺少快照引用。");
  return invoke<LargeDraftDeleteReceipt>("delete_large_file_draft", {
    snapshotId: snapshot.snapshotId,
    expectedSha256: snapshot.sha256,
  });
}

function getFileSnapshot(path: string) {
  return invoke<FileSnapshot>("get_file_snapshot", { path });
}

function missingSnapshot(): FileSnapshot {
  return { exists: false, mtime: undefined, size: undefined };
}

function formatDraftIssues(issues: DraftListReceipt["issues"]) {
  if (issues.length === 0) return "";
  return `草稿读取问题：${issues.map((issue) => `${issue.code}（${issue.path}）：${issue.message}`).join("；")}`;
}

function formatDraftWriteReceiptError(receipt: TextFileWriteReceipt) {
  const details = [
    `outcome=${receipt.outcome}`,
    `diskWritten=${receipt.diskWritten}`,
    receipt.recoveryArtifact ? `recoveryArtifact=${receipt.recoveryArtifact}` : "",
    receipt.cleanupWarning ? `cleanupWarning=${receipt.cleanupWarning}` : "",
  ].filter(Boolean).join(", ");
  return `草稿写入未确认：${details}`;
}

function formatDraftError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "草稿事务失败";
    const details = [
      typeof record.code === "string" ? `code=${record.code}` : "",
      typeof record.outcome === "string" ? `outcome=${record.outcome}` : "",
      typeof record.diskWritten === "string" ? `diskWritten=${record.diskWritten}` : "",
      typeof record.recoveryArtifact === "string" ? `recoveryArtifact=${record.recoveryArtifact}` : "",
      typeof record.cleanupWarning === "string" ? `cleanupWarning=${record.cleanupWarning}` : "",
    ].filter(Boolean).join(", ");
    return details ? `${message}（${details}）` : message;
  }
  return String(error);
}
