import { invoke } from "@tauri-apps/api/core";
import { reactive, toRaw } from "vue";
import {
  appStore,
  createUntitledTab,
  flushDocumentSnapshotWithReceipt,
  setContent,
  switchMode,
} from "./appStore";
import {
  documentMutationTokensEqual,
  type DocumentFlushReceipt,
  type DocumentMutationToken,
} from "../editor/documentMutationTracker";
import { documentSessionForTab, type DocumentSessionAdapter } from "../editor/documentRuntime";
import {
  mutationEpoch,
  SaveTransactionQueue,
  type WindowCloseDraftReceipt,
} from "./saveTransaction";
import { showDialog } from "./dialogStore";
import type { DocumentTab, DraftRecord, FileSnapshot } from "../types";

type DraftStatus = "idle" | "saved" | "failed" | "recoverable" | "restored";

export const draftStore = reactive({
  status: "idle" as DraftStatus,
  message: "",
  lastSavedAt: 0,
  activeDraftId: "",
});

let autosaveTimer = 0;
const draftTransactionQueue = new SaveTransactionQueue();
const untitledDraftIds = new WeakMap<DocumentTab, string>();

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

export function startDraftAutosave() {
  stopDraftAutosave();
  window.addEventListener("blur", flushCurrentDraft);
  document.addEventListener("visibilitychange", flushDraftWhenHidden);
  autosaveTimer = window.setInterval(() => {
    void flushCurrentDraft();
  }, autosaveIntervalMs());
}

export function stopDraftAutosave() {
  if (autosaveTimer) {
    window.clearInterval(autosaveTimer);
    autosaveTimer = 0;
  }
  window.removeEventListener("blur", flushCurrentDraft);
  document.removeEventListener("visibilitychange", flushDraftWhenHidden);
}

export async function recoverStartupDrafts() {
  const expectedTab = activeDraftTab();
  const drafts = await listDrafts().catch(() => []);
  const untitled = drafts.find((draft) => draft.kind === "untitled" && draft.content);
  if (!untitled) return;
  draftStore.status = "recoverable";
  draftStore.message = "发现未命名草稿";
  await promptRecoverDraft(untitled, "发现未保存的未命名草稿，是否恢复？", expectedTab);
}

export async function checkDraftForOpenedFile(path: string) {
  const expectedTab = activeDraftTab();
  const drafts = await listDrafts().catch(() => []);
  const draft = drafts.find((item) => item.path === path && (item.kind === "file" || item.kind === "large"));
  if (!draft) return;
  const snapshot = await getFileSnapshot(path).catch((): FileSnapshot => missingSnapshot());
  const draftIsNewer = !snapshot.exists || !snapshot.mtime || draft.updatedAt > snapshot.mtime;
  if (!draftIsNewer) return;
  draftStore.status = "recoverable";
  draftStore.message = "发现可恢复草稿";
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
      await deleteDraft(context.id);
    } catch (error) {
      draftStore.status = "failed";
      draftStore.message = `草稿清理失败：${error}`;
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

export async function discardDraft(id: string) {
  await deleteDraft(id);
  if (id === draftStore.activeDraftId) draftStore.activeDraftId = "";
  const active = activeDraftTab();
  if (active && !active.path && untitledDraftIds.get(active) === id) untitledDraftIds.delete(active);
}

function flushDraftWhenHidden() {
  if (document.visibilityState === "hidden") void flushCurrentDraft();
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
  try {
    if (!isCurrentDraftContext(context)) return { saved: false, reason: "草稿对应的标签页或编辑器会话已变化。" };
    if (context.tab.documentMode !== "large") {
      const flushed = await flushDocumentSnapshotWithReceipt(context.tabId, "draft");
      flushReceipt = flushed.flushReceipt;
      if (!isCurrentDraftContext(context)) {
        return { saved: false, reason: "草稿快照期间编辑器会话已被替换。" };
      }
    }
    const version = captureDraftVersion(context, flushReceipt);
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
        || (!authorizedFlush && version.pendingVersion !== context.pendingVersion)
        || (context.mutationToken != null && !authorizedFlush
          && (version.mutationToken == null
            || !documentMutationTokensEqual(version.mutationToken, context.mutationToken)))
        || (beforePending && !flushReceipt)
        || (!authorizedFlush && version.epoch !== context.epoch)
        || (!authorizedFlush && version.revision !== context.revision)
        || (!authorizedFlush && version.tab.content !== beforeContent)
        || (!authorizedFlush && version.tab.isDirty !== beforeDirty))) {
      return { saved: false, reason: "退出提示期间文档版本发生了变化。" };
    }
    if (!isDraftVersionCurrent(version)) {
      return { saved: false, reason: "草稿版本在生成期间发生变化。" };
    }
    if (record) {
      await invoke("write_draft", { record });
      if (!isDraftVersionCurrent(version)) {
        return { saved: false, reason: "草稿写入期间文档发生了变化。" };
      }
      if (options.allowInactive !== true && appStore.activeTabId !== context.tabId) {
        return { saved: false, reason: "草稿写入期间活动标签页发生变化。" };
      }
      if (appStore.activeTabId === context.tabId) {
        draftStore.activeDraftId = record.id;
        draftStore.status = "saved";
        draftStore.lastSavedAt = record.updatedAt;
        draftStore.message = `草稿已保存 ${formatTime(record.updatedAt)}`;
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
        content: version.tab.content,
        dirty: version.tab.isDirty,
        draftId: record?.id ?? "",
      },
    };
  } catch (error) {
    if (isCurrentActiveDraftContext(context)) {
      draftStore.status = "failed";
      draftStore.message = `草稿保存失败：${error}`;
    }
    return { saved: false, reason: String(error) };
  }
}

async function buildDraftRecord(context: DraftContext): Promise<DraftRecord | null> {
  const updatedAt = Date.now();
  if (context.tab.documentMode === "large" && context.tab.largeFile && context.path) {
    if (context.tab.largeFile.pendingEdits.length === 0) return null;
    const snapshot = await getFileSnapshot(context.path).catch((): FileSnapshot => missingSnapshot());
    return {
      id: draftIdForPath(context.path),
      kind: "large",
      path: context.path,
      pendingEdits: [...context.tab.largeFile.pendingEdits],
      fileMtime: snapshot.mtime,
      fileSize: snapshot.size,
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
  if (!context.tab.content.trim()) return null;
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
    revision: session?.revision ?? null,
    pendingVersion: pendingEditVersion(session),
    mutationToken: session?.mutationToken?.() ?? null,
  };
}

function captureDraftVersion(context: DraftContext, flushReceipt?: DocumentFlushReceipt): DraftVersion {
  const session = documentSessionForTab(context.tabId);
  return {
    ...context,
    epoch: mutationEpoch(context.tab),
    revision: session?.revision ?? null,
    pendingVersion: pendingEditVersion(session),
    session,
    mutationToken: session?.mutationToken?.() ?? null,
    flushReceipt,
  };
}

function isCurrentDraftContext(context: DraftContext) {
  return isTabRegistered(context.tab)
    && context.tab.id === context.tabId
    && context.tab.path === context.path
    && documentSessionForTab(context.tabId) === context.session;
}

function isCurrentActiveDraftContext(context: DraftContext) {
  return isCurrentDraftContext(context) && appStore.activeTabId === context.tabId;
}

function isDraftVersionCurrent(version: DraftVersion) {
  const session = documentSessionForTab(version.tabId);
  const mutationToken = session?.mutationToken?.() ?? null;
  return isCurrentDraftContext(version)
    && mutationEpoch(version.tab) === version.epoch
    && (session?.revision ?? null) === version.revision
    && pendingEditVersion(session) === version.pendingVersion
    && (!version.mutationToken
      || (mutationToken != null && documentMutationTokensEqual(version.mutationToken, mutationToken)))
    && (!version.flushReceipt
      || (version.flushReceipt.sessionIdentity === version.session
        && mutationToken != null
        && documentMutationTokensEqual(version.flushReceipt.after, mutationToken)))
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
    && (session?.revision ?? null) === expected.revision
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
    && (session?.revision ?? null) === context.revision
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
    && (session?.revision ?? null) === receipt.revision
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

async function promptRecoverDraft(record: DraftRecord, message: string, expectedTab: DocumentTab | null = null, expectedPath?: string) {
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
    await restoreDraft(record, expectedTab, expectedPath);
    return;
  }
  if (result === "discard") {
    await discardDraft(record.id);
  }
}

async function restoreDraft(record: DraftRecord, expectedTab: DocumentTab | null = null, expectedPath?: string) {
  if (expectedTab && (!appStore.tabs.includes(expectedTab)
    || appStore.activeTabId !== expectedTab.id
    || (expectedPath !== undefined && expectedTab.path !== expectedPath))) {
    draftStore.message = "当前标签页已变化，草稿仍保留待处理。";
    return;
  }
  if (record.kind === "large" && appStore.largeFile && record.pendingEdits?.length) {
    const state = await invoke<{ isDirty: boolean; pendingEditCount: number }>("apply_file_edits", {
      sessionId: appStore.largeFile.sessionId,
      edits: record.pendingEdits,
    });
    appStore.largeFile.pendingEdits = [...record.pendingEdits];
    appStore.isDirty = state.isDirty;
  } else {
    if (record.kind === "untitled") {
      const tab = createUntitledTab(record.content || "", true);
      untitledDraftIds.set(tab, record.id);
    } else {
      setContent(record.content || "", true);
    }
  }
  if (record.editorMode === "wysiwyg" || record.editorMode === "source") {
    await switchMode(record.editorMode);
  }
  draftStore.activeDraftId = record.id;
  draftStore.status = "restored";
  draftStore.message = "已恢复草稿";
}

function draftIdForPath(path: string) {
  return `file-${fnv1a(path.toLowerCase())}`;
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
  return Math.max(1, appStore.settings.general.autoSaveIntervalMinutes || 5) * 60 * 1000;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function listDrafts() {
  return invoke<DraftRecord[]>("list_drafts");
}

function deleteDraft(draftId: string) {
  return invoke("delete_draft", { draftId });
}

function getFileSnapshot(path: string) {
  return invoke<FileSnapshot>("get_file_snapshot", { path });
}

function missingSnapshot(): FileSnapshot {
  return { exists: false, mtime: undefined, size: undefined };
}
