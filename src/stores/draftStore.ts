import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";
import { appStore, setContent } from "./appStore";
import type { DraftRecord, FileSnapshot, TextEdit } from "../types";

type DraftStatus = "idle" | "saved" | "failed" | "recoverable" | "restored";

export const draftStore = reactive({
  status: "idle" as DraftStatus,
  message: "",
  lastSavedAt: 0,
  activeDraftId: "",
});

let autosaveTimer = 0;
let untitledDraftId = "";

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
  const drafts = await listDrafts().catch(() => []);
  const untitled = drafts.find((draft) => draft.kind === "untitled" && draft.content);
  if (!untitled) return;
  draftStore.status = "recoverable";
  draftStore.message = "发现未命名草稿";
  await promptRecoverDraft(untitled, "发现未保存的未命名草稿，是否恢复？");
}

export async function checkDraftForOpenedFile(path: string) {
  const drafts = await listDrafts().catch(() => []);
  const draft = drafts.find((item) => item.path === path && (item.kind === "file" || item.kind === "large"));
  if (!draft) return;
  const snapshot = await getFileSnapshot(path).catch((): FileSnapshot => missingSnapshot());
  const draftIsNewer = !snapshot.exists || !snapshot.mtime || draft.updatedAt > snapshot.mtime;
  if (!draftIsNewer) return;
  draftStore.status = "recoverable";
  draftStore.message = "发现可恢复草稿";
  await promptRecoverDraft(draft, "发现这个文件有比磁盘更新的 LightMark 草稿，是否恢复？");
}

export async function flushCurrentDraft() {
  if (!appStore.settings.general.autoSave || !appStore.isDirty) return;
  const record = await buildCurrentDraftRecord();
  if (!record) return;
  try {
    await invoke("write_draft", { record });
    draftStore.activeDraftId = record.id;
    draftStore.status = "saved";
    draftStore.lastSavedAt = record.updatedAt;
    draftStore.message = `草稿已保存 ${formatTime(record.updatedAt)}`;
  } catch (error) {
    draftStore.status = "failed";
    draftStore.message = `草稿保存失败：${error}`;
  }
}

export async function clearActiveDraft() {
  const id = draftStore.activeDraftId || currentDraftId();
  if (!id) return;
  await deleteDraft(id);
  if (id === untitledDraftId) untitledDraftId = "";
  draftStore.activeDraftId = "";
  draftStore.status = "idle";
  draftStore.message = "";
}

export async function discardDraft(id: string) {
  await deleteDraft(id);
  if (id === draftStore.activeDraftId) draftStore.activeDraftId = "";
  if (id === untitledDraftId) untitledDraftId = "";
}

function flushDraftWhenHidden() {
  if (document.visibilityState === "hidden") void flushCurrentDraft();
}

async function buildCurrentDraftRecord(): Promise<DraftRecord | null> {
  const updatedAt = Date.now();
  if (appStore.documentMode === "large" && appStore.largeFile && appStore.currentFilePath) {
    if (appStore.largeFile.pendingEdits.length === 0) return null;
    const snapshot = await getFileSnapshot(appStore.currentFilePath).catch((): FileSnapshot => missingSnapshot());
    return {
      id: draftIdForPath(appStore.currentFilePath),
      kind: "large",
      path: appStore.currentFilePath,
      pendingEdits: appStore.largeFile.pendingEdits,
      fileMtime: snapshot.mtime,
      fileSize: snapshot.size,
      updatedAt,
      editorMode: appStore.editorMode,
    };
  }
  if (appStore.currentFilePath) {
    const snapshot = await getFileSnapshot(appStore.currentFilePath).catch((): FileSnapshot => missingSnapshot());
    return {
      id: draftIdForPath(appStore.currentFilePath),
      kind: "file",
      path: appStore.currentFilePath,
      content: appStore.currentContent,
      fileMtime: snapshot.mtime,
      fileSize: snapshot.size,
      updatedAt,
      editorMode: appStore.editorMode,
    };
  }
  if (!appStore.currentContent.trim()) return null;
  if (!untitledDraftId) untitledDraftId = `untitled-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: untitledDraftId,
    kind: "untitled",
    content: appStore.currentContent,
    updatedAt,
    editorMode: appStore.editorMode,
  };
}

async function promptRecoverDraft(record: DraftRecord, message: string) {
  if (window.confirm(message)) {
    await restoreDraft(record);
    return;
  }
  if (window.confirm("是否丢弃这个草稿？选择“取消”会保留草稿，稍后仍可恢复。")) {
    await discardDraft(record.id);
  }
}

async function restoreDraft(record: DraftRecord) {
  if (record.kind === "large" && appStore.largeFile && record.pendingEdits?.length) {
    const state = await invoke<{ isDirty: boolean; pendingEditCount: number }>("apply_file_edits", {
      sessionId: appStore.largeFile.sessionId,
      edits: record.pendingEdits,
    });
    appStore.largeFile.pendingEdits = [...record.pendingEdits];
    appStore.isDirty = state.isDirty;
  } else {
    setContent(record.content || "", true);
    if (record.kind === "untitled") {
      appStore.currentFilePath = "";
      untitledDraftId = record.id;
    }
  }
  if (record.editorMode === "wysiwyg" || record.editorMode === "source") {
    appStore.editorMode = record.editorMode;
  }
  draftStore.activeDraftId = record.id;
  draftStore.status = "restored";
  draftStore.message = "已恢复草稿";
}

function currentDraftId() {
  if (appStore.currentFilePath) return draftIdForPath(appStore.currentFilePath);
  return untitledDraftId;
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
