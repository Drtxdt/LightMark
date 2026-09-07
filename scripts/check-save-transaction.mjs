import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";
import { installMathDomHarness, TestElement } from "./math-dom-harness.mjs";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-save-transaction-"));
const sourcePath = path.join(root, "src", "stores", "saveTransaction.ts");
const modulePath = path.join(tempDir, "stores", "saveTransaction.mjs");
const mutationTrackerPath = path.join(tempDir, "editor", "documentMutationTracker.mjs");
const closeCoordinatorPath = path.join(tempDir, "windowCloseCoordinator.mjs");
fs.mkdirSync(path.dirname(modulePath), { recursive: true });
fs.mkdirSync(path.dirname(mutationTrackerPath), { recursive: true });
const reactivityPackage = fs.readdirSync(path.join(root, "node_modules", ".pnpm"))
  .find((name) => name.startsWith("@vue+reactivity@"));
assert.ok(reactivityPackage, "the installed Vue reactivity runtime is required for raw/proxy coverage");
const reactivityModule = path.join(root, "node_modules", ".pnpm", reactivityPackage, "node_modules", "@vue", "reactivity", "dist", "reactivity.esm-browser.js");
const proxyStub = `export { reactive, toRaw } from ${JSON.stringify(pathToFileURL(reactivityModule).href)};\n`;
fs.writeFileSync(path.join(tempDir, "save-vue.mjs"), proxyStub);
fs.writeFileSync(mutationTrackerPath, ts.transpileModule(
  fs.readFileSync(path.join(root, "src", "editor", "documentMutationTracker.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  },
).outputText, "utf8");
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
  },
}).outputText
  .replaceAll('from "vue"', 'from "../save-vue.mjs"')
  .replaceAll('from "../editor/documentMutationTracker"', 'from "../editor/documentMutationTracker.mjs"');
fs.writeFileSync(modulePath, transpiled, "utf8");
fs.writeFileSync(closeCoordinatorPath, ts.transpileModule(
  fs.readFileSync(path.join(root, "src", "stores", "windowCloseCoordinator.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  },
).outputText, "utf8");

try {
  const {
    SaveTransactionQueue,
    runVersionedSave,
    saveVersionIsCurrent,
  } = await import(pathToFileURL(modulePath).href);
  const {
    closeWindowWithTicket,
    createWindowCloseTicket,
    createWindowClosePreparationGate,
    invalidateWindowCloseTicketIfStale,
    prepareWindowClose,
    windowCloseTicketIsCurrent,
  } = await import(pathToFileURL(closeCoordinatorPath).href);
  const preparationGate = createWindowClosePreparationGate();
  assert.equal(preparationGate.tryEnter(), true, "the first close request owns preparation");
  assert.equal(preparationGate.tryEnter(), false, "a reentrant close request is blocked while dialog/draft preparation awaits");
  preparationGate.release();
  assert.equal(preparationGate.tryEnter(), true, "the preparation gate can be reused after cancellation or failure");
  preparationGate.release();
  const ticketAuthorization = { id: "window-ticket" };
  const windowTicket = createWindowCloseTicket(ticketAuthorization, { requireClean: true });
  let ticketCurrent = true;
  let ticketDirty = false;
  const isTicketCurrent = (authorization, saveReceipts, draftReceipts) => ticketCurrent
    && authorization === ticketAuthorization
    && saveReceipts.length === 0
    && draftReceipts.length === 0;
  assert.equal(windowCloseTicketIsCurrent(windowTicket, isTicketCurrent, () => ticketDirty), true, "a final close ticket accepts its unchanged authorization");
  ticketDirty = true;
  assert.equal(windowCloseTicketIsCurrent(windowTicket, isTicketCurrent, () => ticketDirty), false, "a clean close ticket rejects new unsaved work");
  ticketDirty = false;
  ticketCurrent = false;
  assert.equal(windowCloseTicketIsCurrent(windowTicket, isTicketCurrent, () => ticketDirty), false, "a close ticket rejects a changed authorization");
  const transportTicket = createWindowCloseTicket({ id: "transport" });
  let transportCalls = 0;
  const transportFailure = await closeWindowWithTicket(
    transportTicket,
    () => true,
    () => false,
    async () => { transportCalls += 1; throw new Error("transport close failed"); },
  );
  assert.equal(transportFailure.closed, false, "a transport close failure is returned to the caller");
  assert.equal(String(transportFailure.error), "Error: transport close failed");
  assert.equal(transportCalls, 1);

  const staleCloseGate = createWindowClosePreparationGate();
  assert.equal(staleCloseGate.tryEnter(), true, "a close preparation owns the gate before native close resolves");
  const staleCloseAuthorization = { id: "stale-close" };
  let staleCloseCurrent = true;
  const staleCloseTicket = createWindowCloseTicket(staleCloseAuthorization);
  let staleClosingTicket = staleCloseTicket;
  let nativeCloseResolved = false;
  const firstNativeClose = await closeWindowWithTicket(
    staleCloseTicket,
    (authorization, saveReceipts, draftReceipts) => staleCloseCurrent
      && authorization === staleCloseAuthorization
      && saveReceipts.length === 0
      && draftReceipts.length === 0,
    () => false,
    async () => { nativeCloseResolved = true; },
  );
  assert.equal(firstNativeClose.closed, true, "the first native close promise resolves before the follow-up close event");
  assert.equal(nativeCloseResolved, true);
  assert.equal(staleCloseGate.active, true, "the original handler still owns the gate when close() resolves");
  staleCloseCurrent = false;
  let staleEventPrevented = false;
  if (invalidateWindowCloseTicketIfStale(
    staleClosingTicket,
    (authorization, saveReceipts, draftReceipts) => staleCloseCurrent
      && authorization === staleCloseAuthorization
      && saveReceipts.length === 0
      && draftReceipts.length === 0,
    () => false,
    () => staleCloseGate.release(),
  )) {
    staleEventPrevented = true;
    staleClosingTicket = null;
  }
  assert.equal(staleEventPrevented, true, "the second close event prevents a stale ticket from closing");
  assert.equal(staleClosingTicket, null);
  assert.equal(staleCloseGate.active, false, "invalidating the ticket releases the preparation gate");
  assert.equal(staleCloseGate.tryEnter(), true, "a later close request can prepare after the stale event");
  staleCloseGate.release();

  let coordinatorDirtyTabs = [{ name: "dirty.md" }];
  let coordinatorDecision = "discard";
  let coordinatorCurrent = true;
  let coordinatorFlushCalls = 0;
  const coordinatorAuthA = { id: "auth-a" };
  const preparedDiscard = await prepareWindowClose({
    captureAuthorization: () => coordinatorAuthA,
    getDirtyTabs: () => coordinatorDirtyTabs,
    requestDecision: async () => coordinatorDecision,
    saveAll: async () => ({ saved: true, receipts: [] }),
    flushDrafts: async (authorization, tabs) => {
      coordinatorFlushCalls += 1;
      assert.equal(authorization, coordinatorAuthA);
      assert.equal(tabs.length, 1);
      return { ok: true, receipts: [] };
    },
    isAuthorizationCurrent: () => coordinatorCurrent,
  });
  assert.equal(preparedDiscard.status, "ready", "the production close preparation accepts an unchanged discard version");
  assert.equal(preparedDiscard.status === "ready" && preparedDiscard.ticket.requireClean, false);
  assert.equal(coordinatorFlushCalls, 1);
  coordinatorCurrent = false;
  const blockedDiscard = await prepareWindowClose({
    captureAuthorization: () => coordinatorAuthA,
    getDirtyTabs: () => coordinatorDirtyTabs,
    requestDecision: async () => "discard",
    saveAll: async () => ({ saved: true, receipts: [] }),
    flushDrafts: async () => { throw new Error("draft flush must not run after an invalid prompt"); },
    isAuthorizationCurrent: () => coordinatorCurrent,
  });
  assert.equal(blockedDiscard.status, "blocked", "new input before draft preparation blocks discard without writing another version");
  coordinatorCurrent = true;
  const failedDraftPreparation = await prepareWindowClose({
    captureAuthorization: () => coordinatorAuthA,
    getDirtyTabs: () => coordinatorDirtyTabs,
    requestDecision: async () => "discard",
    saveAll: async () => ({ saved: true, receipts: [] }),
    flushDrafts: async () => ({ ok: false, receipts: [], failures: [{ error: new Error("draft write failed") }] }),
    isAuthorizationCurrent: () => true,
  });
  assert.equal(failedDraftPreparation.status, "blocked", "a recovery draft failure is an explicit close preparation failure");
  coordinatorCurrent = true;
  coordinatorDecision = "save";
  coordinatorDirtyTabs = [{ name: "save-a.md" }];
  const coordinatorAuthB = { id: "auth-b" };
  let captureCount = 0;
  const preparedSave = await prepareWindowClose({
    captureAuthorization: () => (++captureCount === 1 ? coordinatorAuthA : coordinatorAuthB),
    getDirtyTabs: () => coordinatorDirtyTabs,
    requestDecision: async () => "save",
    saveAll: async (authorization) => {
      assert.equal(authorization, coordinatorAuthB, "save uses the authorization captured after the dialog");
      coordinatorDirtyTabs = [];
      return { saved: true, receipts: [] };
    },
    flushDrafts: async (authorization, tabs) => {
      assert.equal(authorization, coordinatorAuthB);
      assert.equal(tabs.length, 0);
      return { ok: true, receipts: [] };
    },
    isAuthorizationCurrent: () => true,
  });
  assert.equal(preparedSave.status, "ready");
  assert.equal(preparedSave.status === "ready" && preparedSave.ticket.requireClean, true, "save preparation requires a clean final tab set");

  const tab = { id: "tab-a", path: "a.md", content: "old", isDirty: true };
  const tabProxy = (await import(pathToFileURL(path.join(tempDir, "save-vue.mjs")).href)).reactive(tab);
  const otherTab = { id: "tab-b", path: "b.md", content: "other", isDirty: true };
  const session = { pending: false };
  const baseVersion = {
    tab,
    tabId: tab.id,
    path: tab.path,
    epoch: 1,
    revision: 4,
    session,
  };
  assert.equal(saveVersionIsCurrent(baseVersion, { ...baseVersion }), true);
  assert.equal(saveVersionIsCurrent({ ...baseVersion, tab: tabProxy }, { ...baseVersion }), true, "raw and reactive tab identities share one save session");
  assert.equal(saveVersionIsCurrent(baseVersion, { ...baseVersion, tab: { ...tab } }), false, "a replacement tab object is a different save session");
  assert.equal(saveVersionIsCurrent({ ...baseVersion, revision: null }, { ...baseVersion, revision: 4 }), false, "unknown revision cannot pass as the captured revision");
  assert.equal(saveVersionIsCurrent({ ...baseVersion, revision: null }, { ...baseVersion, revision: null }), true, "two explicitly unknown revisions compare equal");

  const queue = new SaveTransactionQueue();
  const writes = [];
  const draftCommits = [];
  let releaseFirstWrite;
  const first = queue.enqueue(tab, () => runVersionedSave({
    isCurrent: () => tab.id === "tab-a" && tab.path === "a.md" && tab.content === "old" && tab.isDirty && session.pending === false,
    write: async () => {
      writes.push({ path: tab.path, content: tab.content });
      await new Promise((resolve) => { releaseFirstWrite = resolve; });
    },
    stat: async () => ({ exists: true, mtime: 2, size: 3 }),
    commit: () => {
      tab.isDirty = false;
      draftCommits.push("tab-a");
      return true;
    },
    isStable: () => !tab.isDirty,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [{ path: "a.md", content: "old" }], "the asynchronous writer receives the frozen path and content");

  tab.content = "new input";
  tab.isDirty = true;
  otherTab.content = "other input";
  releaseFirstWrite();
  const stale = await first;
  assert.deepEqual(stale, { saved: false, phase: "after-write" });
  assert.equal(tab.content, "new input", "a stale write does not replace newer input");
  assert.equal(tab.isDirty, true, "a stale write cannot clear dirty state");
  assert.deepEqual(otherTab, { id: "tab-b", path: "b.md", content: "other input", isDirty: true }, "another tab is untouched");
  assert.deepEqual(draftCommits, [], "a stale write cannot clear the captured tab's draft");

  const second = queue.enqueue(tab, () => runVersionedSave({
    isCurrent: () => tab.id === "tab-a" && tab.path === "a.md" && tab.isDirty,
    write: async () => { writes.push({ path: tab.path, content: tab.content }); },
    stat: async () => ({ exists: true, mtime: 3, size: 9 }),
    commit: () => {
      tab.isDirty = false;
      draftCommits.push("tab-a");
      return true;
    },
    isStable: () => !tab.isDirty,
  }));
  const saved = await second;
  assert.equal(saved.saved, true, "the per-tab queue continues after a stale transaction");
  assert.deepEqual(writes.at(-1), { path: "a.md", content: "new input" });
  assert.deepEqual(draftCommits, ["tab-a"], "only the stable current version may commit draft cleanup");

  const saveAsTab = { id: "untitled-tab", path: "", content: "save as", isDirty: true };
  const saveAsOtherTab = { id: "tab-c", path: "c.md", content: "c", isDirty: false };
  let remountedSession = { pending: false };
  let retargeted = false;
  const saveAsWrites = [];
  const saveAs = await runVersionedSave({
    isCurrent: () => !retargeted && saveAsTab.id === "untitled-tab" && saveAsTab.path === "" && saveAsTab.isDirty,
    write: async () => { saveAsWrites.push({ path: "copy.md", content: saveAsTab.content }); },
    stat: async () => ({ exists: true, mtime: 7, size: 7 }),
    commit: () => {
      saveAsTab.id = "file:copy";
      saveAsTab.path = "copy.md";
      saveAsTab.isDirty = false;
      remountedSession = { pending: false };
      retargeted = true;
      return true;
    },
    isStable: () => saveAsTab.id === "file:copy"
      && saveAsTab.path === "copy.md"
      && saveAsTab.isDirty === false
      && remountedSession.pending === false,
  });
  assert.equal(saveAs.saved, true, "SaveAs accepts an expected editor remount after atomic retarget");
  assert.deepEqual(saveAsWrites, [{ path: "copy.md", content: "save as" }]);
  assert.deepEqual(saveAsOtherTab, { id: "tab-c", path: "c.md", content: "c", isDirty: false }, "SaveAs does not retarget another tab");

  let releaseStaleSaveAs;
  const staleSaveAsTab = { id: "untitled-stale", path: "", content: "before", isDirty: true };
  const staleSaveAs = runVersionedSave({
    isCurrent: () => staleSaveAsTab.id === "untitled-stale" && staleSaveAsTab.path === "" && staleSaveAsTab.content === "before" && staleSaveAsTab.isDirty,
    write: async () => new Promise((resolve) => { releaseStaleSaveAs = resolve; }),
    stat: async () => ({ exists: true, mtime: 8, size: 6 }),
    commit: () => {
      staleSaveAsTab.id = "file:should-not-retarget";
      staleSaveAsTab.path = "should-not-retarget.md";
      staleSaveAsTab.isDirty = false;
      return true;
    },
    isStable: () => false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  staleSaveAsTab.content = "new input";
  releaseStaleSaveAs();
  const staleSaveAsResult = await staleSaveAs;
  assert.deepEqual(staleSaveAsResult, { saved: false, phase: "after-write" });
  assert.equal(staleSaveAsTab.path, "", "a SaveAs race leaves the current tab on its original path");
  assert.equal(staleSaveAsTab.isDirty, true, "a SaveAs race keeps the new input dirty");

  const runtimeDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-runtime-race-"));
  try {
    const runtimePath = path.join(runtimeDir, "editor", "documentRuntime.mjs");
    const runtimeTrackerPath = path.join(runtimeDir, "editor", "documentMutationTracker.mjs");
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimeTrackerPath, ts.transpileModule(fs.readFileSync(path.join(root, "src", "editor", "documentMutationTracker.ts"), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
      },
    }).outputText);
    fs.writeFileSync(runtimePath, ts.transpileModule(fs.readFileSync(path.join(root, "src", "editor", "documentRuntime.ts"), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
      },
    }).outputText.replaceAll('from "./documentMutationTracker"', 'from "./documentMutationTracker.mjs"'));
    const runtime = await import(pathToFileURL(runtimePath).href);
    let snapshotStarted;
    let releaseSnapshot;
    const oldSession = {
      tabId: "same-tab",
      paneId: "main",
      mode: "source",
      revision: 1,
      flushPendingEdits: async () => {},
      snapshot: async () => {
        snapshotStarted?.();
        await new Promise((resolve) => { releaseSnapshot = resolve; });
        return { tabId: "same-tab", revision: 1, markdown: "old", dirty: true };
      },
      derivedState: () => ({}),
      replaceMarkdown: async () => {},
      navigate: () => {},
    };
    const newSession = {
      ...oldSession,
      revision: 2,
      snapshot: async () => ({ tabId: "same-tab", revision: 2, markdown: "new", dirty: true }),
    };
    let startedResolve;
    snapshotStarted = () => startedResolve?.();
    const started = new Promise((resolve) => { startedResolve = resolve; });
    runtime.registerDocumentSession(oldSession);
    const staleSnapshot = runtime.snapshotDocumentTab("same-tab", "save");
    await started;
    runtime.registerDocumentSession(newSession);
    releaseSnapshot();
    await assert.rejects(staleSnapshot, /会话已被替换/, "an old adapter cannot commit after a same-tab remount");
    const freshSnapshot = await runtime.snapshotDocumentTab("same-tab", "save");
    assert.equal(freshSnapshot.markdown, "new", "the replacement adapter remains the only snapshot source");
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }

  const appStoreDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-appstore-save-"));
  let mathDir;
  let mathDom;
  let previousHTMLElement;
  let previousElement;
  let previousSVGElement;
  try {
    const appVuePath = path.join(appStoreDir, "app-vue.mjs");
    fs.writeFileSync(appVuePath, [
      `export { reactive, toRaw } from ${JSON.stringify(pathToFileURL(reactivityModule).href)};`,
      "export function computed(getter) { return { get value() { return getter(); } }; }",
      "export function nextTick() { return Promise.resolve(); }",
    ].join("\n"));
    const dialogStorePath = path.join(appStoreDir, "stores", "dialogStore.mjs");
    fs.mkdirSync(path.dirname(dialogStorePath), { recursive: true });
    fs.writeFileSync(dialogStorePath, [
      "const queued = [];",
      "const waiters = [];",
      "export const requests = [];",
      "export function showDialog(request) {",
      "  let resolveResult;",
      "  const result = new Promise((resolve) => { resolveResult = resolve; });",
      "  const entry = { request, resolve: resolveResult };",
      "  requests.push(request);",
      "  const waiter = waiters.shift();",
      "  if (waiter) waiter(entry); else queued.push(entry);",
      "  return result;",
      "}",
      "export function alertDialog(request) { requests.push({ ...request, __alert: true }); return Promise.resolve('ok'); }",
      "export function waitForDialog(timeoutMs = 500) {",
      "  if (queued.length) return Promise.resolve(queued.shift());",
      "  return new Promise((resolve, reject) => {",
      "    let timer;",
      "    const waiter = (entry) => { clearTimeout(timer); resolve(entry); };",
      "    timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('dialog timeout')); }, timeoutMs);",
      "    waiters.push(waiter);",
      "  });",
      "}",
      "export function resetDialogRequests() { requests.length = 0; queued.length = 0; }",
    ].join("\n"));
    const appTauriPath = path.join(appStoreDir, "app-tauri.mjs");
    fs.writeFileSync(appTauriPath, [
      "export const calls = [];",
      "export const files = new Map();",
      "export const draftRecords = new Map();",
      "export const draftEvents = [];",
      "let dialogPath = 'copy.md';",
      "let deferSaveDialog = false;",
      "let mtimeSerial = 1;",
      "let deferWrite = false;",
      "let shouldFailNextWrite = false;",
      "let deferDraftWrite = false;",
      "let shouldFailNextDraftDelete = false;",
      "let deferDraftDelete = false;",
      "let deferIndexRelease = false;",
      "let activeWrites = 0;",
      "let maxActiveWrites = 0;",
      "let writeStartedResolve = null;",
      "let releaseWriteResolve = null;",
      "let draftWriteStartedResolve = null;",
      "let releaseDraftWriteResolve = null;",
      "let draftDeleteStartedResolve = null;",
      "let releaseDraftDeleteResolve = null;",
      "let indexReleaseStartedResolve = null;",
      "let releaseIndexResolve = null;",
      "let saveDialogStartedResolve = null;",
      "let releaseSaveDialogResolve = null;",
      "export function setDialogPath(value) { dialogPath = value; }",
      "export function deferNextSaveDialog() { deferSaveDialog = true; }",
      "export function waitForSaveDialogStart() { return new Promise((resolve) => { saveDialogStartedResolve = resolve; }); }",
      "export function releaseSaveDialog() { releaseSaveDialogResolve?.(); releaseSaveDialogResolve = null; }",
      "export function deferNextWrite() { deferWrite = true; }",
      "export function failNextWrite() { shouldFailNextWrite = true; }",
      "export function deferNextDraftWrite() { deferDraftWrite = true; }",
      "export function failNextDraftDelete() { shouldFailNextDraftDelete = true; }",
      "export function deferNextDraftDelete() { deferDraftDelete = true; }",
      "export function deferNextIndexRelease() { deferIndexRelease = true; }",
      "export function waitForDraftWriteStart() { return new Promise((resolve) => { draftWriteStartedResolve = resolve; }); }",
      "export function releaseDraftWrite() { releaseDraftWriteResolve?.(); releaseDraftWriteResolve = null; }",
      "export function waitForDraftDeleteStart() { return new Promise((resolve) => { draftDeleteStartedResolve = resolve; }); }",
      "export function releaseDraftDelete() { releaseDraftDeleteResolve?.(); releaseDraftDeleteResolve = null; }",
      "export function waitForIndexReleaseStart() { return new Promise((resolve) => { indexReleaseStartedResolve = resolve; }); }",
      "export function releaseIndex() { releaseIndexResolve?.(); releaseIndexResolve = null; }",
      "export function resetWriteMetrics() { activeWrites = 0; maxActiveWrites = 0; }",
      "export function writeMetrics() { return { activeWrites, maxActiveWrites }; }",
      "export function waitForWriteStart() { return new Promise((resolve) => { writeStartedResolve = resolve; }); }",
      "export function releaseWrite() { releaseWriteResolve?.(); releaseWriteResolve = null; }",
      "export async function invoke(command, args = {}) {",
      "  calls.push({ command, args });",
      "  if (command === 'write_text_file') {",
      "    activeWrites += 1; maxActiveWrites = Math.max(maxActiveWrites, activeWrites);",
      "    try {",
      "      if (deferWrite) { deferWrite = false; writeStartedResolve?.(); writeStartedResolve = null; await new Promise((resolve) => { releaseWriteResolve = resolve; }); }",
      "      if (shouldFailNextWrite) { shouldFailNextWrite = false; throw new Error('simulated write failure'); }",
      "      files.set(args.path, { exists: true, mtime: ++mtimeSerial, size: args.content.length, content: args.content }); return null;",
      "    } finally { activeWrites -= 1; }",
      "  }",
      "  if (command === 'write_draft') {",
      "    draftEvents.push({ kind: 'write-start', id: args.record.id });",
      "    if (deferDraftWrite) { deferDraftWrite = false; draftWriteStartedResolve?.(); draftWriteStartedResolve = null; await new Promise((resolve) => { releaseDraftWriteResolve = resolve; }); }",
      "    draftRecords.set(args.record.id, args.record);",
      "    draftEvents.push({ kind: 'write-done', id: args.record.id });",
      "    return null;",
      "  }",
      "  if (command === 'delete_draft') {",
      "    draftEvents.push({ kind: 'delete-start', id: args.draftId });",
      "    if (deferDraftDelete) { deferDraftDelete = false; draftDeleteStartedResolve?.(); draftDeleteStartedResolve = null; await new Promise((resolve) => { releaseDraftDeleteResolve = resolve; }); }",
      "    if (shouldFailNextDraftDelete) { shouldFailNextDraftDelete = false; throw new Error('simulated draft delete failure'); }",
      "    draftRecords.delete(args.draftId);",
      "    draftEvents.push({ kind: 'delete-done', id: args.draftId });",
      "    return null;",
      "  }",
      "  if (command === 'save_large_file') return { isDirty: false, pendingEditCount: 0 };",
      "  if (command === 'close_large_file') return null;",
      "  if (command === 'get_file_snapshot') { const file = files.get(args.path); return file ? { exists: true, mtime: file.mtime, size: file.size } : { exists: false }; }",
      "  if (command === 'read_text_file') return files.get(args.path)?.content ?? '';",
      "  if (command === 'save_markdown_file_dialog') { if (deferSaveDialog) { deferSaveDialog = false; saveDialogStartedResolve?.(); saveDialogStartedResolve = null; await new Promise((resolve) => { releaseSaveDialogResolve = resolve; }); } return dialogPath; }",
      "  if (command === 'list_drafts') return [...draftRecords.values()];",
      "  if (command === 'list_markdown_files') return [];",
      "  if (command === 'workspace_index_open') return { root: args.root, generation: 0, busy: false, error: null, documentCount: 0, candidates: [] };",
      "  if (command === 'workspace_index_status') return { root: '', generation: 0, busy: false, error: null, documentCount: 0, candidates: [] };",
      "  if (command === 'workspace_index_release_open_document') { if (deferIndexRelease) { deferIndexRelease = false; indexReleaseStartedResolve?.(); indexReleaseStartedResolve = null; await new Promise((resolve) => { releaseIndexResolve = resolve; }); } return null; }",
      "  if (command === 'workspace_query_tags') return { generation: 0, data: [] };",
      "  if (command === 'workspace_query_backlinks' || command === 'workspace_query_mentions') return { generation: 0, data: [] };",
      "  return null;",
      "}",
    ].join("\n"));
    const compiledAppStore = compileTypeScriptModuleGraph(path.join(root, "src", "stores", "appStore.ts"), appStoreDir);
    fs.writeFileSync(dialogStorePath, [
      "const queued = [];",
      "const waiters = [];",
      "export const requests = [];",
      "export function showDialog(request) {",
      "  let resolveResult;",
      "  const result = new Promise((resolve) => { resolveResult = resolve; });",
      "  const entry = { request, resolve: resolveResult };",
      "  requests.push(request);",
      "  const waiter = waiters.shift();",
      "  if (waiter) waiter(entry); else queued.push(entry);",
      "  return result;",
      "}",
      "export function alertDialog(request) { requests.push({ ...request, __alert: true }); return Promise.resolve('ok'); }",
      "export function waitForDialog(timeoutMs = 500) {",
      "  if (queued.length) return Promise.resolve(queued.shift());",
      "  return new Promise((resolve, reject) => {",
      "    let timer;",
      "    const waiter = (entry) => { clearTimeout(timer); resolve(entry); };",
      "    timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('dialog timeout')); }, timeoutMs);",
      "    waiters.push(waiter);",
      "  });",
      "}",
      "export function resetDialogRequests() { requests.length = 0; queued.length = 0; }",
    ].join("\n"));
    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
    for (const file of walk(appStoreDir).filter((item) => item.endsWith(".mjs"))) {
      if (file === appVuePath || file === appTauriPath) continue;
      let source = fs.readFileSync(file, "utf8");
      const relativeVue = path.relative(path.dirname(file), appVuePath).replace(/\\/g, "/");
      const relativeTauri = path.relative(path.dirname(file), appTauriPath).replace(/\\/g, "/");
      source = source.replaceAll('from "vue"', `from "${relativeVue.startsWith(".") ? relativeVue : `./${relativeVue}`}"`);
      source = source.replaceAll('from "@tauri-apps/api/core"', `from "${relativeTauri.startsWith(".") ? relativeTauri : `./${relativeTauri}`}"`);
      fs.writeFileSync(file, source, "utf8");
    }
    const tauri = await import(pathToFileURL(appTauriPath).href);
    const store = await import(pathToFileURL(compiledAppStore).href);
    const runtime = await import(pathToFileURL(path.join(appStoreDir, "editor", "documentRuntime.mjs")).href);
    const dialog = await import(pathToFileURL(dialogStorePath).href);
    const draft = await import(pathToFileURL(path.join(appStoreDir, "stores", "draftStore.mjs")).href);
    const { effect, stop: stopEffect } = await import(pathToFileURL(reactivityModule).href);

    // Keep the store test on the real InlineMath NodeView and PM transaction
    // path.  MathNodes imports appStore for UI side effects, so this isolated
    // fixture supplies only the settings/navigation surface used by the view;
    // the store under test remains the production appStore/draftStore graph.
    mathDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-math-receipt-"));
    const mathAppStorePath = path.join(mathDir, "math-app-store.mjs");
    fs.writeFileSync(mathAppStorePath, [
      "export const appStore = { settings: { markdown: { mathNumbering: 'none' } }, splitLayout: { activePaneId: 'main' }, statusMessage: '' };",
      "export function recordNavigationLocation() {}",
    ].join("\n"));
    const compiledMathNodes = compileTypeScriptModuleGraph(
      path.join(root, "src", "extensions", "MathNodes.ts"),
      mathDir,
    );
    const mathAppStoreSpecifier = path.relative(path.dirname(compiledMathNodes), mathAppStorePath).replace(/\\/g, "/");
    const mathNodeSource = fs.readFileSync(compiledMathNodes, "utf8")
      .replaceAll('from "../stores/appStore.mjs"', `from "${mathAppStoreSpecifier.startsWith(".") ? mathAppStoreSpecifier : `./${mathAppStoreSpecifier}`}"`);
    fs.writeFileSync(compiledMathNodes, mathNodeSource, "utf8");
    const compiledMathTracker = path.join(mathDir, "editor", "documentMutationTracker.mjs");
    mathDom = installMathDomHarness();
    previousHTMLElement = globalThis.HTMLElement;
    previousElement = globalThis.Element;
    previousSVGElement = globalThis.SVGElement;
    globalThis.HTMLElement = TestElement;
    globalThis.Element = TestElement;
    globalThis.SVGElement = TestElement;
    const {
      InlineMath,
      finalizePendingMathForClosePrompt,
      flushPendingMathEdits,
      hasPendingMathEdits,
      getPendingMathInputVersion,
      getPendingMathEditVersion,
    } = await import(pathToFileURL(compiledMathNodes).href);
    const {
      DOCUMENT_FLUSH_META_KEY,
      createDocumentMutationTracker,
      documentMutationTokensEqual,
    } = await import(pathToFileURL(compiledMathTracker).href);
    const mathSchema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
        inlineMath: {
          group: "inline",
          inline: true,
          atom: true,
          selectable: true,
          attrs: {
            tex: { default: "" },
            delimiter: { default: "inline-dollar" },
            raw: { default: "" },
            originalTex: { default: "" },
            displayMode: { default: false },
            editing: { default: false },
          },
        },
      },
    });
    const inlineMathPlugin = InlineMath.config.addProseMirrorPlugins.call({
      type: mathSchema.nodes.inlineMath,
    })[0];
    const mathNode = (tex, editing = true) => mathSchema.nodes.inlineMath.create({
      tex,
      delimiter: "inline-dollar",
      raw: `$${tex}$`,
      originalTex: tex,
      displayMode: false,
      editing,
    });
    const makeTab = (id, tabPath, name, content, kind = "normal") => ({
      id,
      kind,
      path: tabPath,
      name,
      content,
      documentMode: "normal",
      largeFile: null,
      isDirty: true,
      editorMode: "source",
      pendingModeCursor: null,
      collapsedOutlineKeys: [],
      collapsedHeadingKeys: [],
      wysiwygFormatHistory: { undo: [], redo: [] },
      externalState: "clean",
      openedAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    const resetStore = (tabs, activeTab) => {
      store.appStore.tabs = tabs;
      store.appStore.activeTabId = activeTab.id;
      store.appStore.currentFilePath = activeTab.path;
      store.appStore.currentContent = activeTab.content;
      store.appStore.documentMode = "normal";
      store.appStore.largeFile = null;
      store.appStore.workspaceIndexReady = false;
      store.appStore.isDirty = activeTab.isDirty;
      store.appStore.saveState = activeTab.isDirty ? "dirty" : "saved";
      store.appStore.currentWorkspace = "";
      store.appStore.splitLayout = {
        enabled: false,
        activePaneId: "main",
        mainTabId: activeTab.id,
        secondaryTabId: "",
        mainTabIds: [activeTab.id],
        secondaryTabIds: [],
        ratio: 0.5,
      };
    };
    const mathNodeViewFactory = InlineMath.config.addNodeView();
    const createMathSession = (tab, options = {}) => {
      let revision = 1;
      let observedInputVersion = 0;
      let nextFlushGate = null;
      let nextClosePromptGate = null;
      let nodeView = null;
      let nodeViewUpdateCount = 0;
      let view;
      const editor = { view: null };
      const session = {
        tabId: tab.id,
        paneId: options.paneId ?? "main",
        mode: "wysiwyg",
        get revision() { return revision; },
        hasPendingEdits() { return hasPendingMathEdits(editor); },
        pendingEditVersion() { return getPendingMathEditVersion(editor); },
        mutationToken() {
          syncPendingInput();
          return tracker.token();
        },
        async flushPendingEdits(_reason, flushOptions = {}) {
          syncPendingInput();
          const expected = flushOptions.expectedToken ?? tracker.token();
          if (!documentMutationTokensEqual(expected, tracker.token())) {
            throw new Error("真实公式会话在 flush 开始前已变化。");
          }
          const flush = tracker.beginFlush(expected);
          const gate = nextFlushGate;
          nextFlushGate = null;
          if (gate) {
            gate.startedResolve();
            await gate.released;
          }
          try {
            await flushPendingMathEdits(editor, { flushId: flush.id });
            syncPendingInput();
            return flush.complete(tracker.token());
          } catch (error) {
            flush.fail();
            throw error;
          }
        },
        async finalizeClosePrompt(flushOptions = {}) {
          syncPendingInput();
          const expected = flushOptions.expectedToken ?? tracker.token();
          if (!documentMutationTokensEqual(expected, tracker.token())) {
            throw new Error("真实公式会话在关闭提示准备开始前已变化。");
          }
          const flush = tracker.beginFlush(expected);
          const gate = nextClosePromptGate;
          nextClosePromptGate = null;
          if (gate) {
            gate.startedResolve();
            await gate.released;
          }
          try {
            await finalizePendingMathForClosePrompt(editor, { flushId: flush.id });
            syncPendingInput();
            return flush.complete(tracker.token());
          } catch (error) {
            flush.fail();
            throw error;
          }
        },
        async snapshot(_reason) {
          if (options.onSnapshot) await options.onSnapshot(session, view);
          const math = view.state.doc.nodeAt(1);
          if (math?.type?.name === "inlineMath") tab.content = `formula ${math.attrs.tex}`;
          return { tabId: tab.id, revision, markdown: tab.content, dirty: tab.isDirty };
        },
        derivedState() { return { revision }; },
        async replaceMarkdown(markdown) { tab.content = markdown; },
        navigate() {},
      };
      const tracker = createDocumentMutationTracker({ sessionIdentity: session, initialRevision: revision });
      const syncPendingInput = () => {
        const current = getPendingMathInputVersion(editor);
        while (observedInputVersion < current) {
          observedInputVersion += 1;
          tracker.recordPendingInput();
        }
      };
      const initialNode = mathNode(options.tex ?? "x", true);
      const initialDoc = mathSchema.nodes.doc.create(null, [
        mathSchema.nodes.paragraph.create(null, [initialNode]),
      ]);
      view = {
        state: EditorState.create({ schema: mathSchema, doc: initialDoc, plugins: [inlineMathPlugin] }),
        dispatch(transaction) {
          const applied = view.state.applyTransaction(transaction);
          view.state = applied.state;
          let documentChanged = false;
          for (const current of applied.transactions) {
            if (!current.docChanged) continue;
            documentChanged = true;
            const flushId = current.getMeta(DOCUMENT_FLUSH_META_KEY);
            if (flushId && flushId === tracker.activeFlushId) {
              tracker.recordDocumentChange({ kind: "pending-flush", flushId });
            } else {
              tracker.recordDocumentChange();
            }
          }
          if (documentChanged) {
            revision += 1;
            tracker.setRevision(revision);
          }
          const nextNode = view.state.doc.nodeAt(1);
          if (nodeView && nextNode) {
            nodeViewUpdateCount += 1;
            nodeView.update(nextNode);
          }
          syncPendingInput();
          return applied;
        },
        focus() {},
      };
      editor.view = view;
      nodeView = mathNodeViewFactory({
        node: initialNode,
        editor,
        getPos: () => 1,
      });
      observedInputVersion = getPendingMathInputVersion(editor);
      return {
        session,
        editor,
        view,
        nodeView,
        source: nodeView.dom.querySelector(".math-inline-source-editor"),
        tracker,
        get nodeViewUpdateCount() { return nodeViewUpdateCount; },
        holdNextFlush() {
          let startedResolve;
          let releaseResolve;
          const started = new Promise((resolve) => { startedResolve = resolve; });
          const released = new Promise((resolve) => { releaseResolve = resolve; });
          nextFlushGate = { startedResolve, released, release: releaseResolve };
          return { started, release: releaseResolve };
        },
        holdNextClosePrompt() {
          let startedResolve;
          let releaseResolve;
          const started = new Promise((resolve) => { startedResolve = resolve; });
          const released = new Promise((resolve) => { releaseResolve = resolve; });
          nextClosePromptGate = { startedResolve, released, release: releaseResolve };
          return { started, release: releaseResolve };
        },
        syncPendingInput,
        close() { nodeView?.destroy(); },
      };
    };
    const makeSession = (tab, options = {}) => {
      const session = {
        tabId: tab.id,
        paneId: options.paneId ?? "main",
        mode: "source",
        revision: 1,
        pending: false,
        documentGeneration: 0,
        pendingInputVersion: 0,
        pendingBufferRevision: undefined,
        hasPendingEdits() { return this.pending; },
        mutationToken() {
          return {
            documentGeneration: this.documentGeneration,
            pendingInputVersion: this.pendingBufferRevision ?? this.pendingInputVersion,
            revision: this.revision,
          };
        },
        async flushPendingEdits(_reason, flushOptions = {}) {
          const before = this.mutationToken();
          if (this.pending) {
            this.pending = false;
            this.revision += 1;
            this.documentGeneration += 1;
            if (this.pendingBufferRevision != null) this.pendingBufferRevision += 1;
          }
          return {
            sessionIdentity: this,
            flushId: flushOptions.flushId ?? `mock-flush-${this.revision}`,
            before,
            after: this.mutationToken(),
            firstAuthorizedGeneration: this.documentGeneration || null,
            lastAuthorizedGeneration: this.documentGeneration || null,
            authorizedMutationCount: this.documentGeneration ? 1 : 0,
          };
        },
        async snapshot(reason) {
          await options.onSnapshot?.(this, reason);
          if (options.snapshotGate) await options.snapshotGate();
          return { tabId: tab.id, revision: this.revision, markdown: tab.content, dirty: tab.isDirty };
        },
        derivedState() { return {}; },
        async replaceMarkdown(markdown) { tab.content = markdown; },
        navigate() {},
      };
      return session;
    };

    const realMathPromptTab = makeTab("real-math-prompt", "real-math-prompt.md", "real-math-prompt.md", "prompt formula", "normal");
    resetStore([realMathPromptTab], realMathPromptTab);
    const realMathPrompt = createMathSession(realMathPromptTab, { tex: "prompt" });
    const unregisterRealMathPrompt = runtime.registerDocumentSession(realMathPrompt.session);
    try {
      const promptSource = realMathPrompt.source;
      assert.ok(promptSource, "close-prompt fixture exposes the real formula source editor");
      promptSource.textContent = "prompt+1";
      promptSource.dispatchEvent({ type: "input" });
      assert.equal(realMathPrompt.session.hasPendingEdits(), true);
      const promptAuthorization = await store.prepareWindowClosePrompt();
      assert.equal(realMathPrompt.session.hasPendingEdits(), false, "close-prompt preparation must settle the real formula buffer");
      assert.equal(realMathPrompt.nodeView.dom.className, "math-node math-node-inline");
      assert.equal(promptAuthorization.tabs[0].pending, false, "the prompt must capture the post-finalize formula lifecycle");
      assert.equal(
        store.isWindowCloseAuthorizationCurrent(promptAuthorization),
        true,
        "dialog focus after close-prompt preparation must not create a late formula blur mutation",
      );
    } finally {
      realMathPrompt.close();
      unregisterRealMathPrompt();
    }

    const closePromptPathRaceTab = makeTab("real-math-prompt-path-race", "real-math-prompt-path-race.md", "real-math-prompt-path-race.md", "prompt path race", "normal");
    resetStore([closePromptPathRaceTab], closePromptPathRaceTab);
    const closePromptPathRace = createMathSession(closePromptPathRaceTab, { tex: "race" });
    const unregisterClosePromptPathRace = runtime.registerDocumentSession(closePromptPathRace.session);
    const closePromptGate = closePromptPathRace.holdNextClosePrompt();
    try {
      const preparation = store.prepareWindowClosePrompt();
      await closePromptGate.started;
      closePromptPathRaceTab.path = "changed-during-close-prompt.md";
      closePromptGate.release();
      await assert.rejects(
        preparation,
        /标签页身份发生了变化/,
        "close-prompt preparation must reject a path retarget during its controlled flush",
      );
    } finally {
      closePromptPathRace.close();
      unregisterClosePromptPathRace();
    }

    const realMathSaveTab = makeTab("real-math-save", "real-math-save.md", "real-math-save.md", "formula", "normal");
    realMathSaveTab.fileSnapshot = { exists: true, mtime: 120, size: 7 };
    tauri.files.set(realMathSaveTab.path, {
      exists: true,
      mtime: 120,
      size: 7,
      content: realMathSaveTab.content,
    });
    resetStore([realMathSaveTab], realMathSaveTab);
    const realMathSave = createMathSession(realMathSaveTab, { tex: "x" });
    const unregisterRealMathSave = runtime.registerDocumentSession(realMathSave.session);
    try {
      const initialMathLifecycle = realMathSave.session.pendingEditVersion();
      const initialMathInput = getPendingMathInputVersion(realMathSave.editor);
      assert.ok(realMathSave.source, "the production InlineMath NodeView exposes its real source editor");
      realMathSave.source.textContent = "xy";
      realMathSave.source.dispatchEvent({ type: "input" });
      assert.ok(
        realMathSave.session.pendingEditVersion() > initialMathLifecycle,
        "a real NodeView input advances the production pending lifecycle version",
      );
      assert.ok(
        getPendingMathInputVersion(realMathSave.editor) > initialMathInput,
        "a real NodeView input advances the continuous input token",
      );
      const realMathBeforeSave = realMathSave.session.mutationToken();
      assert.equal(realMathSave.session.hasPendingEdits(), true);
      assert.equal(await store.saveCurrentFile(), true, "production save accepts a real PM flush receipt from InlineMath");
      const realMathAfterSave = realMathSave.session.mutationToken();
      assert.ok(realMathAfterSave.documentGeneration > realMathBeforeSave.documentGeneration);
      assert.ok(realMathSave.nodeViewUpdateCount > 0, "the real PM apply path calls the production NodeView.update");
      assert.equal(realMathAfterSave.pendingInputVersion, realMathBeforeSave.pendingInputVersion);
      assert.ok(
        realMathSave.session.pendingEditVersion() > initialMathLifecycle,
        "the authorized Math flush may advance lifecycle identity while preserving the input token",
      );
      assert.equal(realMathSave.session.hasPendingEdits(), false);
      assert.equal(realMathSaveTab.isDirty, false);
      assert.equal(tauri.files.get(realMathSaveTab.path)?.content, "formula xy");
      assert.equal(realMathSave.view.state.doc.nodeAt(1)?.attrs.tex, "xy");
    } finally {
      realMathSave.close();
      unregisterRealMathSave();
    }

    const realMathDraftTab = makeTab("real-math-draft", "", "real-math-draft", "draft formula", "untitled");
    resetStore([realMathDraftTab], realMathDraftTab);
    tauri.draftRecords.clear();
    const realMathDraft = createMathSession(realMathDraftTab, { tex: "draft" });
    const unregisterRealMathDraft = runtime.registerDocumentSession(realMathDraft.session);
    try {
      assert.ok(realMathDraft.source);
      realMathDraft.source.textContent = "draft+1";
      realMathDraft.source.dispatchEvent({ type: "input" });
      const draftAuthorization = store.captureWindowCloseAuthorization();
      const draftResult = await draft.flushDraftsForWindowClose(
        [realMathDraftTab],
        "preserve",
        draftAuthorization.tabs,
      );
      assert.equal(draftResult.ok, true, "window recovery draft accepts a real InlineMath flush receipt");
      assert.equal(draftResult.receipts.length, 1);
      const realMathDraftRecord = [...tauri.draftRecords.values()][0];
      assert.equal(realMathDraftRecord.content, "formula draft+1");
      assert.ok(draftResult.receipts[0].flushReceipt, "the recovery receipt carries the authorized PM flush");
      assert.equal(
        store.isWindowCloseAuthorizationCurrent(draftAuthorization, [], draftResult.receipts),
        true,
        "window authorization accepts lifecycle advancement caused only by the real Math flush",
      );
    } finally {
      realMathDraft.close();
      unregisterRealMathDraft();
    }

    const realMathWindowTab = makeTab("real-math-window", "real-math-window.md", "real-math-window.md", "window formula", "normal");
    realMathWindowTab.fileSnapshot = { exists: true, mtime: 120, size: 13 };
    tauri.files.set(realMathWindowTab.path, {
      exists: true,
      mtime: 120,
      size: 13,
      content: realMathWindowTab.content,
    });
    resetStore([realMathWindowTab], realMathWindowTab);
    const realMathWindow = createMathSession(realMathWindowTab, { tex: "window" });
    const unregisterRealMathWindow = runtime.registerDocumentSession(realMathWindow.session);
    try {
      realMathWindow.source.textContent = "window+1";
      realMathWindow.source.dispatchEvent({ type: "input" });
      const windowAuthorization = store.captureWindowCloseAuthorization();
      const windowSaveResult = await store.saveAllDirtyTabsForClose(windowAuthorization);
      assert.equal(windowSaveResult.saved, true, "window save accepts lifecycle advancement from the real authorized Math flush");
      assert.equal(windowSaveResult.receipts.length, 1);
      const windowReceipt = windowSaveResult.receipts[0];
      assert.ok(windowReceipt.after.pendingVersion !== windowReceipt.before.pendingVersion);
      assert.ok(windowReceipt.after.mutationToken.documentGeneration > windowReceipt.before.mutationToken.documentGeneration);
      assert.equal(windowReceipt.after.mutationToken.pendingInputVersion, windowReceipt.before.mutationToken.pendingInputVersion);
      assert.ok(realMathWindow.nodeViewUpdateCount > 0, "window save used PM apply plus production NodeView.update");
      assert.equal(
        store.isWindowCloseAuthorizationCurrent(windowAuthorization, windowSaveResult.receipts),
        true,
        "window save receipt proves the real NodeView flush rather than comparing the old lifecycle version",
      );
      assert.equal(realMathWindowTab.isDirty, false);
      assert.equal(tauri.files.get(realMathWindowTab.path)?.content, "formula window+1");
    } finally {
      realMathWindow.close();
      unregisterRealMathWindow();
    }

    const realMathWindowSaveAsTab = makeTab("real-math-window-save-as", "", "real-math-window-save-as", "window draft", "untitled");
    resetStore([realMathWindowSaveAsTab], realMathWindowSaveAsTab);
    tauri.setDialogPath("real-math-window-save-as.md");
    const realMathWindowSaveAs = createMathSession(realMathWindowSaveAsTab, { tex: "save-as" });
    const unregisterRealMathWindowSaveAs = runtime.registerDocumentSession(realMathWindowSaveAs.session);
    try {
      realMathWindowSaveAs.source.textContent = "save-as+1";
      realMathWindowSaveAs.source.dispatchEvent({ type: "input" });
      const saveAsWindowAuthorization = store.captureWindowCloseAuthorization();
      const saveAsWindowResult = await store.saveAllDirtyTabsForClose(saveAsWindowAuthorization);
      assert.equal(saveAsWindowResult.saved, true, "window SaveAs accepts a second no-op flush after a real Math receipt");
      assert.equal(realMathWindowSaveAsTab.path, "real-math-window-save-as.md");
      assert.equal(tauri.files.get(realMathWindowSaveAsTab.path)?.content, "formula save-as+1");
      assert.equal(
        store.isWindowCloseAuthorizationCurrent(saveAsWindowAuthorization, saveAsWindowResult.receipts),
        true,
        "window SaveAs keeps the first authorized Math flush in the receipt chain",
      );
    } finally {
      realMathWindowSaveAs.close();
      unregisterRealMathWindowSaveAs();
    }

    const finalizeRaceTab = makeTab("real-math-finalize-race", "real-math-finalize-race.md", "real-math-finalize-race.md", "formula", "normal");
    finalizeRaceTab.fileSnapshot = { exists: true, mtime: 121, size: 7 };
    tauri.files.set(finalizeRaceTab.path, { exists: true, mtime: 121, size: 7, content: finalizeRaceTab.content });
    resetStore([finalizeRaceTab], finalizeRaceTab);
    const finalizeRace = createMathSession(finalizeRaceTab, { tex: "race" });
    const finalizeGate = finalizeRace.holdNextFlush();
    const unregisterFinalizeRace = runtime.registerDocumentSession(finalizeRace.session);
    try {
      const pendingSave = store.saveCurrentFile();
      await finalizeGate.started;
      finalizeRace.source.textContent = "race-after-prompt";
      finalizeRace.source.dispatchEvent({ type: "input" });
      finalizeGate.release();
      await assert.rejects(
        pendingSave,
        /flush|版本|变化|文档更新/u,
        "input arriving during the real PM flush preparation invalidates the save receipt",
      );
      assert.equal(finalizeRaceTab.isDirty, true);
      assert.equal(tauri.files.has(finalizeRaceTab.path), true);
    } finally {
      finalizeRace.close();
      unregisterFinalizeRace();
    }

    const externalRaceTab = makeTab("real-math-external-race", "real-math-external-race.md", "real-math-external-race.md", "formula", "normal");
    externalRaceTab.fileSnapshot = { exists: true, mtime: 122, size: 7 };
    tauri.files.set(externalRaceTab.path, { exists: true, mtime: 122, size: 7, content: externalRaceTab.content });
    resetStore([externalRaceTab], externalRaceTab);
    const externalRace = createMathSession(externalRaceTab, { tex: "external" });
    const externalGate = externalRace.holdNextFlush();
    const unregisterExternalRace = runtime.registerDocumentSession(externalRace.session);
    try {
      const pendingSave = store.saveCurrentFile();
      await externalGate.started;
      externalRace.editor.view.dispatch(externalRace.editor.view.state.tr.insertText("outside", 1));
      externalGate.release();
      await assert.rejects(
        pendingSave,
        /flush|版本|变化|文档更新/u,
        "an untagged PM transaction during the real flush invalidates the receipt",
      );
      assert.equal(externalRaceTab.isDirty, true);
    } finally {
      externalRace.close();
      unregisterExternalRace();
    }

    const microtaskRaceTab = makeTab("real-math-microtask-race", "real-math-microtask-race.md", "real-math-microtask-race.md", "formula", "normal");
    microtaskRaceTab.fileSnapshot = { exists: true, mtime: 123, size: 7 };
    tauri.files.set(microtaskRaceTab.path, { exists: true, mtime: 123, size: 7, content: microtaskRaceTab.content });
    resetStore([microtaskRaceTab], microtaskRaceTab);
    let microtaskSession;
    const microtaskRace = createMathSession(microtaskRaceTab, {
      tex: "source",
      onSnapshot: async (_session, viewForRace) => {
        await Promise.resolve();
        queueMicrotask(() => {
          const current = viewForRace.state.doc.nodeAt(1);
          if (!current) return;
          viewForRace.dispatch(viewForRace.state.tr.setNodeMarkup(1, undefined, {
            ...current.attrs,
            tex: "microtask-external",
            editing: false,
          }));
        });
      },
    });
    microtaskSession = microtaskRace.session;
    const unregisterMicrotaskRace = runtime.registerDocumentSession(microtaskSession);
    try {
      await assert.rejects(
        store.saveCurrentFile(),
        /flush|版本|变化/u,
        "a source PM mutation queued during snapshot cannot cross the store commit boundary",
      );
      assert.equal(microtaskRaceTab.isDirty, true);
      assert.equal(tauri.files.has(microtaskRaceTab.path), true);
    } finally {
      microtaskRace.close();
      unregisterMicrotaskRace();
    }

    tauri.calls.length = 0;
    const tabA = makeTab("tab-a", "a.md", "a.md", "old");
    const tabB = makeTab("tab-b", "b.md", "b.md", "other");
    tabB.isDirty = false;
    tabA.fileSnapshot = { exists: true, mtime: 1, size: 3 };
    tauri.files.set("a.md", { exists: true, mtime: 1, size: 3, content: "old" });
    store.appStore.tabs = [tabA, tabB];
    store.appStore.activeTabId = tabA.id;
    store.appStore.currentFilePath = tabA.path;
    store.appStore.currentContent = tabA.content;
    store.appStore.splitLayout = { enabled: true, activePaneId: "main", mainTabId: tabA.id, secondaryTabId: tabB.id, mainTabIds: [tabA.id], secondaryTabIds: [tabB.id], ratio: 0.5 };

    tauri.deferNextWrite();
    const staleSave = store.saveCurrentFile();
    await tauri.waitForWriteStart();
    store.setContent("new", true);
    tauri.releaseWrite();
    assert.equal(await staleSave, false, "the real appStore save returns false when input changes during write");
    assert.equal(tabA.isDirty, true);
    assert.equal(tabA.content, "new");
    assert.equal(tabB.content, "other", "the real appStore save does not touch a second tab");
    assert.deepEqual(tauri.calls.filter((call) => call.command === "write_text_file")[0].args, { path: "a.md", content: "old" });

    assert.equal(tabA.fileSnapshot?.mtime, 1, "a stale write keeps the previous baseline for conservative conflict detection");

    const tabC = makeTab("tab-c", "c.md", "c.md", "one");
    tabC.fileSnapshot = { exists: true, mtime: 10, size: 3 };
    tauri.files.set("c.md", { exists: true, mtime: 10, size: 3, content: "one" });
    store.appStore.tabs.push(tabC);
    store.appStore.activeTabId = tabC.id;
    store.appStore.currentFilePath = tabC.path;
    store.appStore.currentContent = tabC.content;
    store.appStore.splitLayout = { enabled: false, activePaneId: "main", mainTabId: tabC.id, secondaryTabId: "", mainTabIds: [tabC.id], secondaryTabIds: [], ratio: 0.5 };
    assert.equal(await store.saveCurrentFile(), true, "a stable production save commits and refreshes its baseline");
    store.setContent("two", true);
    assert.equal(await store.saveCurrentFile(), true, "a queued second save compares against the first save's refreshed baseline");
    assert.deepEqual(tauri.calls.filter((call) => call.command === "write_text_file").slice(-1)[0].args, { path: "c.md", content: "two" });

    const untitled = makeTab("untitled-a", "", "untitled", "draft", "untitled");
    const previousSecondary = tabB.id;
    store.appStore.tabs.push(untitled);
    store.appStore.activeTabId = untitled.id;
    store.appStore.currentFilePath = "";
    store.appStore.currentContent = untitled.content;
    store.appStore.isDirty = true;
    store.appStore.splitLayout = { enabled: true, activePaneId: "main", mainTabId: untitled.id, secondaryTabId: previousSecondary, mainTabIds: [untitled.id], secondaryTabIds: [previousSecondary], ratio: 0.5 };
    tauri.setDialogPath("copy.md");
    tauri.deferNextWrite();
    const backgroundSaveAs = store.saveCurrentFile();
    await tauri.waitForWriteStart();
    store.appStore.activeTabId = tabB.id;
    store.appStore.currentFilePath = tabB.path;
    store.appStore.currentContent = tabB.content;
    store.appStore.isDirty = tabB.isDirty;
    store.appStore.splitLayout.activePaneId = "secondary";
    tauri.releaseWrite();
    assert.equal(await backgroundSaveAs, true, "the real appStore SaveAs path commits a stable untitled version");
    assert.equal(untitled.path, "copy.md");
    assert.equal(store.appStore.activeTabId, previousSecondary, "SaveAs does not retarget the page that became active during the write");
    assert.equal(store.appStore.splitLayout.activePaneId, "secondary");
    assert.equal(store.appStore.splitLayout.secondaryTabId, previousSecondary, "background SaveAs preserves the other pane");
    assert.equal(store.appStore.tabs.find((tab) => tab.id === previousSecondary)?.content, "other", "the other pane document remains intact");
    const dialogCall = tauri.calls.find((call) => call.command === "save_markdown_file_dialog");
    assert.equal(dialogCall.args.defaultFileName, "未命名.md", "SaveAs uses the captured tab name");
    assert.match(fs.readFileSync(path.join(root, "src", "stores", "appStore.ts"), "utf8"), /defaultFileName: defaultMarkdownFileName\(context\.tab\.name\)/, "the production dialog helper must use its captured tab name");

    const failedTab = makeTab("failed-tab", "failed.md", "failed.md", "bad");
    failedTab.fileSnapshot = { exists: true, mtime: 30, size: 3 };
    tauri.files.set("failed.md", { exists: true, mtime: 30, size: 3, content: "bad" });
    resetStore([failedTab], failedTab);
    tauri.failNextWrite();
    await assert.rejects(store.saveCurrentFile(), /simulated write failure/, "a production write error is surfaced to the caller");
    assert.equal(failedTab.isDirty, true, "a failed production write keeps the document dirty");
    assert.equal(await store.saveCurrentFile(), true, "the same production save lane remains usable after a write failure");
    assert.equal(failedTab.isDirty, false);

    const concurrentTab = makeTab("concurrent-tab", "concurrent.md", "concurrent.md", "one");
    concurrentTab.fileSnapshot = { exists: true, mtime: 40, size: 3 };
    tauri.files.set("concurrent.md", { exists: true, mtime: 40, size: 3, content: "one" });
    resetStore([concurrentTab], concurrentTab);
    tauri.resetWriteMetrics();
    tauri.deferNextWrite();
    const firstConcurrentSave = store.saveCurrentFile();
    await tauri.waitForWriteStart();
    const secondConcurrentSave = store.saveCurrentFile();
    tauri.releaseWrite();
    const concurrentResults = await Promise.all([firstConcurrentSave, secondConcurrentSave]);
    assert.deepEqual(concurrentResults, [true, true], "concurrent production saves drain in order");
    assert.equal(tauri.writeMetrics().maxActiveWrites, 1, "the production lane never overlaps two writes for one tab");
    assert.equal(tauri.calls.filter((call) => call.command === "write_text_file" && call.args.path === "concurrent.md").length, 2);

    const pendingTab = makeTab("pending-tab", "pending.md", "pending.md", "formula");
    pendingTab.fileSnapshot = { exists: true, mtime: 50, size: 7 };
    tauri.files.set("pending.md", { exists: true, mtime: 50, size: 7, content: "formula" });
    const pendingSession = makeSession(pendingTab);
    const unregisterPending = runtime.registerDocumentSession(pendingSession);
    resetStore([pendingTab], pendingTab);
    tauri.deferNextWrite();
    const pendingSave = store.saveCurrentFile();
    await tauri.waitForWriteStart();
    pendingSession.pending = true;
    tauri.releaseWrite();
    assert.equal(await pendingSave, false, "pending editor input arising during write invalidates the captured version");
    assert.equal(pendingTab.isDirty, true, "pending editor input remains dirty after the stale write");
    assert.equal(pendingTab.fileSnapshot?.mtime, 50, "pending editor input does not advance the tab baseline");
    unregisterPending();

    const replacedTab = makeTab("replaced-tab", "replaced.md", "replaced.md", "old");
    replacedTab.fileSnapshot = { exists: true, mtime: 60, size: 3 };
    tauri.files.set("replaced.md", { exists: true, mtime: 60, size: 3, content: "old" });
    let releaseOldSnapshot;
    let oldSnapshotStartedResolve;
    const oldSnapshotStarted = new Promise((resolve) => { oldSnapshotStartedResolve = resolve; });
    const oldSession = makeSession(replacedTab, {
      snapshotGate: () => {
        const gate = new Promise((resolve) => { releaseOldSnapshot = resolve; });
        oldSnapshotStartedResolve?.();
        oldSnapshotStartedResolve = null;
        return gate;
      },
    });
    const unregisterOld = runtime.registerDocumentSession(oldSession);
    resetStore([replacedTab], replacedTab);
    const replacedSave = store.saveCurrentFile();
    await oldSnapshotStarted;
    const newSession = makeSession(replacedTab);
    const unregisterNew = runtime.registerDocumentSession(newSession);
    releaseOldSnapshot();
    await assert.rejects(replacedSave, /会话已被替换/, "a same-ID replacement between snapshot and store commit rejects the old production save");
    assert.equal(replacedTab.content, "old", "a replaced session cannot commit its stale snapshot into the tab");
    assert.equal(tauri.calls.filter((call) => call.command === "write_text_file" && call.args.path === "replaced.md").length, 0, "the rejected snapshot never reaches disk");
    unregisterOld();
    unregisterNew();

    const saveAllA = makeTab("save-all-a", "save-all-a.md", "save-all-a.md", "A");
    const saveAllB = makeTab("save-all-b", "save-all-b.md", "save-all-b.md", "B");
    saveAllA.fileSnapshot = { exists: true, mtime: 70, size: 1 };
    saveAllB.fileSnapshot = { exists: true, mtime: 71, size: 1 };
    tauri.files.set("save-all-a.md", { exists: true, mtime: 70, size: 1, content: "A" });
    tauri.files.set("save-all-b.md", { exists: true, mtime: 71, size: 1, content: "B" });
    let saveAllBRegistered = false;
    let saveAllBSession;
    let unregisterSaveAllA;
    let unregisterSaveAllB;
    let saveAllPaneAdapter = null;
    const installSaveAllPaneAdapter = (session) => {
      assert.equal(saveAllPaneAdapter, null, "a pane never has two editor adapters during saveAll activation");
      saveAllPaneAdapter = session;
      const unregister = runtime.registerDocumentSession(session);
      return () => {
        assert.equal(saveAllPaneAdapter, session, "only the current pane adapter may be unregistered");
        saveAllPaneAdapter = null;
        unregister();
      };
    };
    const saveAllASession = makeSession(saveAllA, {
      onSnapshot: () => {
        assert.equal(store.appStore.activeTabId, saveAllA.id, "the first save snapshots while tab A is active");
        assert.equal(runtime.documentSessionForTab(saveAllB.id), null, "tab B is not mounted during tab A's snapshot");
        assert.equal(saveAllPaneAdapter, saveAllASession, "tab A is the only mounted pane adapter during its snapshot");
      },
    });
    unregisterSaveAllA = installSaveAllPaneAdapter(saveAllASession);
    resetStore([saveAllA, saveAllB], saveAllA);
    assert.equal(runtime.documentSessionForTab(saveAllB.id), null, "saveAll starts with only the current tab's editor adapter");
    const stopSaveAllActivationEffect = effect(() => {
      if (store.appStore.activeTabId !== saveAllB.id || saveAllBRegistered) return;
      queueMicrotask(() => {
        if (saveAllBRegistered || store.appStore.activeTabId !== saveAllB.id) return;
        saveAllBRegistered = true;
        unregisterSaveAllA?.();
        saveAllBSession = makeSession(saveAllB, { paneId: "main" });
        unregisterSaveAllB = installSaveAllPaneAdapter(saveAllBSession);
      });
    });
    assert.equal(await store.saveAllDirtyTabs(), true, "saveAll establishes the next adapter and saves both dirty tabs");
    stopEffect?.(stopSaveAllActivationEffect);
    assert.equal(saveAllA.isDirty, false);
    assert.equal(saveAllB.isDirty, false);
    assert.ok(saveAllBRegistered, "the second adapter is mounted only after appStore activates tab B");
    assert.equal(runtime.documentSessionForTab(saveAllA.id), null, "tab A is unmounted before tab B's save begins");
    assert.ok(runtime.documentSessionForTab(saveAllB.id), "the second tab's adapter is available before its save begins");
    unregisterSaveAllB?.();

    const closeA = makeTab("window-close-a", "window-close-a.md", "window-close-a.md", "A");
    const closeB = makeTab("window-close-b", "window-close-b.md", "window-close-b.md", "B");
    closeA.fileSnapshot = { exists: true, mtime: 81, size: 1 };
    closeB.fileSnapshot = { exists: true, mtime: 82, size: 1 };
    tauri.calls.length = 0;
    tauri.files.clear();
    tauri.files.set(closeA.path, { exists: true, mtime: 81, size: 1, content: closeA.content });
    tauri.files.set(closeB.path, { exists: true, mtime: 82, size: 1, content: closeB.content });
    resetStore([closeA, closeB], closeA);
    const unregisterCloseA = runtime.registerDocumentSession(makeSession(closeA));
    try {
      const closeAuthorization = store.captureWindowCloseAuthorization();
      tauri.deferNextWrite();
      const closeSave = store.saveAllDirtyTabsForClose(closeAuthorization);
      await tauri.waitForWriteStart();
      store.appStore.activeTabId = closeB.id;
      store.appStore.currentFilePath = closeB.path;
      store.appStore.currentContent = closeB.content;
      store.appStore.isDirty = closeB.isDirty;
      tauri.releaseWrite();
      const closeResult = await closeSave;
      assert.equal(closeResult.saved, true, "window save uses captured background tabs without activating them");
      assert.equal(store.appStore.activeTabId, closeB.id, "window save keeps a tab selected during a background write");
      assert.equal(closeA.isDirty, false);
      assert.equal(closeB.isDirty, false);
      assert.equal(tauri.calls.filter((call) => call.command === "write_text_file").length, 2);
    } finally {
      unregisterCloseA();
    }

    const saveAsDuringDialog = makeTab("window-save-as-race", "", "window-save-as-race", "before", "untitled");
    resetStore([saveAsDuringDialog], saveAsDuringDialog);
    tauri.calls.length = 0;
    tauri.files.clear();
    tauri.setDialogPath("window-save-as-race.md");
    const unregisterSaveAsDuringDialog = runtime.registerDocumentSession(makeSession(saveAsDuringDialog));
    try {
      const saveAsAuthorization = store.captureWindowCloseAuthorization();
      tauri.deferNextSaveDialog();
      const saveAsClose = store.saveAllDirtyTabsForClose(saveAsAuthorization);
      await tauri.waitForSaveDialogStart();
      saveAsDuringDialog.content = "new input during SaveAs";
      store.markDocumentChanged(saveAsDuringDialog.id, 2);
      tauri.releaseSaveDialog();
      const saveAsResult = await saveAsClose;
      assert.equal(saveAsResult.saved, false, "SaveAs input after the close choice cancels window exit");
      assert.equal(saveAsDuringDialog.isDirty, true, "SaveAs input remains dirty after the cancelled close");
      assert.equal(tauri.calls.some((call) => call.command === "write_text_file"), false, "unconfirmed SaveAs input is not written by the close transaction");
    } finally {
      unregisterSaveAsDuringDialog();
    }

    const extraSetA = makeTab("window-set-a", "window-set-a.md", "window-set-a.md", "A");
    extraSetA.fileSnapshot = { exists: true, mtime: 91, size: 1 };
    tauri.files.set(extraSetA.path, { exists: true, mtime: 91, size: 1, content: extraSetA.content });
    resetStore([extraSetA], extraSetA);
    tauri.calls.length = 0;
    const unregisterExtraSetA = runtime.registerDocumentSession(makeSession(extraSetA));
    try {
      const setAuthorization = store.captureWindowCloseAuthorization();
      tauri.deferNextWrite();
      const setSave = store.saveAllDirtyTabsForClose(setAuthorization);
      await tauri.waitForWriteStart();
      const unexpectedTab = makeTab("window-set-new", "window-set-new.md", "window-set-new.md", "new");
      store.appStore.tabs.push(unexpectedTab);
      tauri.releaseWrite();
      const setResult = await setSave;
      assert.equal(setResult.saved, false, "a new tab during window save blocks close");
      assert.equal(store.appStore.tabs.some((tab) => tab.id === unexpectedTab.id), true, "the new tab remains open");
    } finally {
      unregisterExtraSetA();
    }

    const preservedDraft = makeTab("window-draft-preserve", "", "window-draft-preserve", "prompt version", "untitled");
    resetStore([preservedDraft], preservedDraft);
    tauri.draftRecords.clear();
    store.appStore.settings.general.autoSave = false;
    const preservedAuthorization = store.captureWindowCloseAuthorization();
    const preservedResult = await draft.flushDraftsForWindowClose(
      [preservedDraft],
      "preserve",
      preservedAuthorization.tabs,
    );
    assert.equal(preservedResult.ok, true, "window discard preserves a recovery draft even when auto-save is disabled");
    assert.equal(preservedResult.receipts.length, 1);
    const preservedRecord = [...tauri.draftRecords.values()][0];
    assert.equal(preservedRecord.content, "prompt version");
    assert.equal(store.isWindowCloseAuthorizationCurrent(preservedAuthorization, [], preservedResult.receipts), true);

    const staleDraft = makeTab("window-draft-stale", "", "window-draft-stale", "old prompt", "untitled");
    resetStore([staleDraft], staleDraft);
    tauri.draftRecords.clear();
    store.appStore.settings.general.autoSave = false;
    const staleDraftAuthorization = store.captureWindowCloseAuthorization();
    const initialDraft = await draft.flushDraftsForWindowClose([staleDraft], "preserve", staleDraftAuthorization.tabs);
    assert.equal(initialDraft.ok, true);
    const staleDraftRecord = [...tauri.draftRecords.values()][0];
    staleDraft.content = "new input after prompt";
    store.markDocumentChanged(staleDraft.id, 2);
    const staleDraftResult = await draft.flushDraftsForWindowClose([staleDraft], "preserve", staleDraftAuthorization.tabs);
    assert.equal(staleDraftResult.ok, false, "new input after the window prompt prevents a draft overwrite");
    assert.equal(tauri.draftRecords.get(staleDraftRecord.id).content, "old prompt", "the prompt version remains recoverable");

    const pendingDraft = makeTab("window-pending-draft", "", "window-pending-draft", "formula prompt", "untitled");
    resetStore([pendingDraft], pendingDraft);
    tauri.draftRecords.clear();
    const pendingDraftSession = makeSession(pendingDraft);
    pendingDraftSession.pending = true;
    pendingDraftSession.pendingBufferRevision = 1;
    pendingDraftSession.pendingEditVersion = () => pendingDraftSession.pendingBufferRevision;
    const unregisterPendingDraft = runtime.registerDocumentSession(pendingDraftSession);
    try {
      const pendingAuthorization = store.captureWindowCloseAuthorization();
      const pendingResult = await draft.flushDraftsForWindowClose([pendingDraft], "preserve", pendingAuthorization.tabs);
      assert.equal(pendingResult.ok, true, "a stable pending buffer can be flushed to the authorized recovery draft");
      assert.equal(store.isWindowCloseAuthorizationCurrent(pendingAuthorization, [], pendingResult.receipts), true);
    } finally {
      unregisterPendingDraft();
    }

    const pendingRaceDraft = makeTab("window-pending-race", "", "window-pending-race", "formula race", "untitled");
    resetStore([pendingRaceDraft], pendingRaceDraft);
    tauri.draftRecords.clear();
    const pendingRaceSession = makeSession(pendingRaceDraft);
    pendingRaceSession.pending = true;
    pendingRaceSession.pendingBufferRevision = 1;
    pendingRaceSession.pendingEditVersion = () => pendingRaceSession.pendingBufferRevision;
    let pendingFlushStartedResolve;
    let releasePendingFlushResolve;
    const pendingFlushStarted = new Promise((resolve) => { pendingFlushStartedResolve = resolve; });
    const originalPendingFlush = pendingRaceSession.flushPendingEdits;
    pendingRaceSession.flushPendingEdits = async (reason) => {
      pendingFlushStartedResolve?.();
      await new Promise((resolve) => { releasePendingFlushResolve = resolve; });
      await originalPendingFlush.call(pendingRaceSession, reason);
    };
    const unregisterPendingRace = runtime.registerDocumentSession(pendingRaceSession);
    try {
      const pendingRaceAuthorization = store.captureWindowCloseAuthorization();
      const pendingRaceResultPromise = draft.flushDraftsForWindowClose(
        [pendingRaceDraft],
        "preserve",
        pendingRaceAuthorization.tabs,
      );
      await pendingFlushStarted;
      pendingRaceSession.pendingBufferRevision = 2;
      releasePendingFlushResolve?.();
      const pendingRaceResult = await pendingRaceResultPromise;
      assert.equal(pendingRaceResult.ok, false, "a new pending formula buffer token during flush cancels window discard");
      assert.equal(tauri.draftRecords.size, 0, "a changed pending buffer is not written as the prompt recovery version");
    } finally {
      unregisterPendingRace();
    }

    const wp04bFailures = [];
    const resetHarness = () => {
      tauri.calls.length = 0;
      tauri.files.clear();
      tauri.draftRecords.clear();
      tauri.draftEvents.length = 0;
      dialog.resetDialogRequests();
      draft.draftStore.activeDraftId = "";
      draft.draftStore.status = "idle";
      draft.draftStore.message = "";
    };
    const runWp04bRedCase = async (name, test) => {
      try {
        await test();
      } catch (error) {
        wp04bFailures.push({ name, error });
      }
    };

    await runWp04bRedCase("close saves the captured A after the dialog switches to B", async () => {
      resetHarness();
      const a = makeTab("close-captured-a", "close-captured-a.md", "close-captured-a.md", "old");
      const b = makeTab("close-captured-b", "close-captured-b.md", "close-captured-b.md", "other");
      b.isDirty = false;
      a.fileSnapshot = { exists: true, mtime: 301, size: 3 };
      b.fileSnapshot = { exists: true, mtime: 302, size: 5 };
      tauri.files.set(a.path, { exists: true, mtime: 301, size: 3, content: a.content });
      tauri.files.set(b.path, { exists: true, mtime: 302, size: 5, content: b.content });
      resetStore([a, b], a);
      const unregisterA = runtime.registerDocumentSession(makeSession(a));
      const unregisterB = runtime.registerDocumentSession(makeSession(b));
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog();
        await store.activateTab(b.id);
        a.content = "latest";
        store.markDocumentChanged(a.id, 2);
        prompt.resolve("save");
        prompt = null;
        await closePromise;
        assert.equal(tauri.files.get(a.path)?.content, "latest", "Save uses the latest captured A version");
        assert.equal(store.appStore.activeTabId, b.id, "switching during the dialog leaves B active");
        assert.equal(store.appStore.tabs.some((tab) => tab.id === a.id), false, `only the requested A tab closes (status=${store.appStore.statusMessage}, dirty=${a.isDirty}, path=${a.path}, active=${store.appStore.activeTabId})`);
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterB();
        unregisterA();
      }
    });

    await runWp04bRedCase("close removes a tab after SaveAs changes its id", async () => {
      resetHarness();
      const a = makeTab("close-save-as", "", "untitled-close", "draft", "untitled");
      resetStore([a], a);
      tauri.setDialogPath("close-save-as.md");
      const unregisterA = runtime.registerDocumentSession(makeSession(a));
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog();
        prompt.resolve("save");
        prompt = null;
        await closePromise;
        assert.equal(store.appStore.tabs.some((tab) => tab === a || tab.path === "close-save-as.md"), false, "the retargeted tab is removed by object identity");
        assert.equal(tauri.files.get("close-save-as.md")?.content, "draft", "SaveAs writes the captured untitled content");
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterA();
      }
    });

    await runWp04bRedCase("close discard rejects a same-ID replacement session", async () => {
      resetHarness();
      const a = makeTab("close-session-replacement", "", "replacement-close", "keep this", "untitled");
      resetStore([a], a);
      const oldSession = makeSession(a);
      const unregisterOld = runtime.registerDocumentSession(oldSession);
      let unregisterReplacement = () => {};
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog();
        unregisterReplacement = runtime.registerDocumentSession(makeSession(a));
        prompt.resolve("discard");
        prompt = null;
        await closePromise;
        assert.equal(store.appStore.tabs.some((tab) => tab.id === a.id), true, "an older discard prompt cannot close after same-ID session replacement");
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterReplacement();
        unregisterOld();
      }
    });

    await runWp04bRedCase("close-save routes large tabs through save_large_file", async () => {
      resetHarness();
      const large = makeTab("close-large", "large-close.md", "large-close.md", "", "large");
      large.documentMode = "large";
      large.largeFile = {
        sessionId: "large-close-session",
        sizeBytes: 4096,
        totalLines: 20,
        loadedRanges: [{ startLine: 0, endLine: 2 }],
        pendingEdits: [{ startLine: 1, startColumn: 0, endLine: 1, endColumn: 1, text: "x" }],
        outline: [],
      };
      resetStore([large], large);
      store.appStore.documentMode = "large";
      store.appStore.largeFile = large.largeFile;
      store.appStore.currentFilePath = large.path;
      store.appStore.currentContent = "";
      store.appStore.isDirty = true;
      store.appStore.saveState = "dirty";
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(large.id);
        prompt = await dialog.waitForDialog();
        prompt.resolve("save");
        prompt = null;
        await closePromise;
        assert.equal(tauri.calls.some((call) => call.command === "save_large_file" && call.args.sessionId === "large-close-session"), true, "large close-save uses the native large-file save command");
        assert.equal(tauri.calls.some((call) => call.command === "write_text_file"), false, "large close-save never writes the empty tab content as Markdown");
        assert.equal(tauri.calls.some((call) => call.command === "close_large_file" && call.args.sessionId === "large-close-session"), true, `large close releases its native session (status=${store.appStore.statusMessage}, calls=${JSON.stringify(tauri.calls)})`);
        assert.equal(store.appStore.tabs.some((tab) => tab.id === large.id), false, "the saved large tab closes");
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
      }
    });

    await runWp04bRedCase("pending editor input still opens the close prompt", async () => {
      resetHarness();
      const a = makeTab("close-pending-formula", "pending-formula.md", "pending-formula.md", "formula");
      a.isDirty = false;
      resetStore([a], a);
      const session = makeSession(a);
      session.pending = true;
      const unregisterA = runtime.registerDocumentSession(session);
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog(150);
        assert.equal(prompt.request.message.includes("未保存"), true, "pending input is described as unsaved work");
        prompt.resolve("cancel");
        prompt = null;
        await closePromise;
        assert.equal(store.appStore.tabs.some((tab) => tab.id === a.id), true);
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterA();
      }
    });

    await runWp04bRedCase("pending formula buffer identity changes invalidate discard", async () => {
      resetHarness();
      const a = makeTab("close-pending-buffer", "pending-buffer.md", "pending-buffer.md", "formula");
      a.isDirty = false;
      resetStore([a], a);
      const session = makeSession(a);
      session.pending = true;
      session.pendingBufferRevision = 1;
      session.pendingEditVersion = () => session.pendingBufferRevision;
      const unregisterA = runtime.registerDocumentSession(session);
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog();
        assert.equal(session.hasPendingEdits(), true, "the formula buffer remains pending at prompt time");
        session.pendingBufferRevision = 2;
        assert.equal(session.hasPendingEdits(), true, "the new local formula input still reports pending");
        prompt.resolve("discard");
        prompt = null;
        await closePromise;
        assert.equal(store.appStore.tabs.some((tab) => tab.id === a.id), true, "a changed pending formula buffer cannot be discarded by an older prompt");
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterA();
      }
    });

    await runWp04bRedCase("discard is bound to the version seen by the dialog", async () => {
      resetHarness();
      const a = makeTab("close-discard-race", "discard-race.md", "discard-race.md", "before");
      resetStore([a], a);
      const unregisterA = runtime.registerDocumentSession(makeSession(a));
      let closePromise;
      let prompt;
      try {
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog();
        store.setContent("new input during dialog", true);
        prompt.resolve("discard");
        prompt = null;
        await closePromise;
        assert.equal(store.appStore.tabs.some((tab) => tab.id === a.id), true, "the changed tab remains open");
        assert.equal(a.content, "new input during dialog");
        assert.equal(a.isDirty, true);
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterA();
      }
    });

    await runWp04bRedCase("draft cleanup is tab-scoped, queued behind writes, and preserves failed records", async () => {
      resetHarness();
      const localFailures = [];
      const check = (assertion) => {
        try {
          assertion();
        } catch (error) {
          localFailures.push(error);
        }
      };
      const a = makeTab("draft-close-a", "", "draft-close-a", "A draft", "untitled");
      const b = makeTab("draft-close-b", "", "draft-close-b", "B draft", "untitled");
      resetStore([a, b], b);
      store.appStore.settings.general.autoSave = true;
      const unregisterA = runtime.registerDocumentSession(makeSession(a));
      const unregisterB = runtime.registerDocumentSession(makeSession(b));
      let closePromise;
      let prompt;
      try {
        await draft.flushCurrentDraft();
        const bDraftId = draft.draftStore.activeDraftId;
        assert.ok(bDraftId, "B receives its own untitled draft id");
        store.appStore.activeTabId = a.id;
        store.appStore.currentFilePath = a.path;
        store.appStore.currentContent = a.content;
        store.appStore.isDirty = a.isDirty;
        store.appStore.splitLayout.mainTabId = a.id;
        tauri.deferNextDraftWrite();
        const pendingDraftWrite = draft.flushCurrentDraft();
        await tauri.waitForDraftWriteStart();
        closePromise = store.closeTab(a.id);
        prompt = await dialog.waitForDialog();
        store.appStore.activeTabId = b.id;
        store.appStore.currentFilePath = b.path;
        store.appStore.currentContent = b.content;
        store.appStore.isDirty = b.isDirty;
        store.appStore.splitLayout.mainTabId = b.id;
        prompt.resolve("discard");
        prompt = null;
        tauri.releaseDraftWrite();
        await Promise.all([pendingDraftWrite, closePromise]);
        const aDraftId = tauri.draftEvents.find((event) => event.kind === "write-start" && event.id !== bDraftId)?.id;
        check(() => assert.ok(aDraftId, "the captured A draft write completes before cleanup"));
        if (aDraftId) {
          const aEvents = tauri.draftEvents.filter((event) => event.id === aDraftId).map((event) => event.kind);
          check(() => assert.deepEqual(aEvents, ["write-start", "write-done", "delete-start", "delete-done"], "A draft cleanup waits behind A's queued write"));
          check(() => assert.equal(tauri.draftRecords.has(aDraftId), false, "closing A removes only A's draft"));
        }
        check(() => assert.equal(tauri.draftRecords.has(bDraftId), true, "closing A preserves B's draft"));

        const failed = makeTab("draft-delete-failure", "", "draft-delete-failure", "keep this", "untitled");
        resetStore([failed], failed);
        const unregisterFailed = runtime.registerDocumentSession(makeSession(failed));
        try {
          await draft.flushCurrentDraft();
          const failedDraftId = draft.draftStore.activeDraftId;
          tauri.failNextDraftDelete();
          closePromise = store.closeTab(failed.id);
          prompt = await dialog.waitForDialog();
          prompt.resolve("discard");
          prompt = null;
          await closePromise.catch(() => {});
          await new Promise((resolve) => setImmediate(resolve));
          check(() => assert.equal(tauri.draftEvents.some((event) => event.kind === "delete-start" && event.id === failedDraftId), true, "failed cleanup still attempts the captured draft id"));
          check(() => assert.equal(tauri.draftRecords.has(failedDraftId), true, "a failed draft delete preserves the recovery record"));
        } finally {
          if (prompt) prompt.resolve("cancel");
          await closePromise?.catch(() => {});
          unregisterFailed();
        }
      } finally {
        if (prompt) prompt.resolve("cancel");
        await closePromise?.catch(() => {});
        unregisterB();
        unregisterA();
      }
      if (localFailures.length > 0) throw new AggregateError(localFailures, "draft cleanup assertions");
    });

    await runWp04bRedCase("draft cleanup preserves a record across session loss or same-ID replacement", async () => {
      resetHarness();
      const a = makeTab("draft-session-loss", "", "draft-session-loss", "keep after remount", "untitled");
      resetStore([a], a);
      const oldSession = makeSession(a);
      const unregisterOld = runtime.registerDocumentSession(oldSession);
      try {
        await draft.flushCurrentDraft();
        const cleanup = draft.captureDraftCleanupContext(a);
        assert.ok(cleanup, "the cleanup captures the written draft identity");
        unregisterOld();
        await draft.clearCapturedDraft(cleanup);
        assert.equal(tauri.draftRecords.has(cleanup.id), true, "a missing editor session keeps its recovery draft");
      } finally {
        unregisterOld?.();
      }

      resetHarness();
      resetStore([a], a);
      const firstSession = makeSession(a);
      const unregisterFirst = runtime.registerDocumentSession(firstSession);
      const replacementCleanup = await (async () => {
        await draft.flushCurrentDraft();
        return draft.captureDraftCleanupContext(a);
      })();
      const replacementSession = makeSession(a);
      const unregisterReplacement = runtime.registerDocumentSession(replacementSession);
      try {
        assert.ok(replacementCleanup, "the replacement case captures the draft identity");
        await draft.clearCapturedDraft(replacementCleanup);
        assert.equal(tauri.draftRecords.has(replacementCleanup.id), true, "a same-ID replacement keeps the old session's draft");
      } finally {
        unregisterReplacement();
        unregisterFirst();
      }
    });

    await runWp04bRedCase("background close keeps its pane and aborts after delayed draft cleanup input", async () => {
      resetHarness();
      const active = makeTab("close-background-active", "close-background-active.md", "active.md", "active");
      active.isDirty = false;
      const target = makeTab("close-background-target", "", "target", "target draft", "untitled");
      const unregisterActive = runtime.registerDocumentSession(makeSession(active));
      const unregisterTarget = runtime.registerDocumentSession(makeSession(target));
      resetStore([active, target], target);
      store.appStore.settings.general.autoSave = true;
      try {
        await draft.flushCurrentDraft();
        const targetDraftId = draft.draftStore.activeDraftId;
        assert.ok(targetDraftId, "the background target has a captured draft");
        store.appStore.activeTabId = active.id;
        store.appStore.currentFilePath = active.path;
        store.appStore.currentContent = active.content;
        store.appStore.isDirty = active.isDirty;
        store.appStore.splitLayout = {
          enabled: false,
          activePaneId: "main",
          mainTabId: active.id,
          secondaryTabId: "",
          mainTabIds: [active.id],
          secondaryTabIds: [],
          ratio: 0.5,
        };
        tauri.deferNextDraftDelete();
        const closePromise = store.closeTab(target.id);
        const prompt = await dialog.waitForDialog();
        assert.equal(store.appStore.activeTabId, active.id, "closing a background target does not activate it");
        prompt.resolve("discard");
        await tauri.waitForDraftDeleteStart();
        target.content = "new input while draft cleanup waits";
        store.markDocumentChanged(target.id, 2);
        tauri.releaseDraftDelete();
        await closePromise;
        assert.equal(store.appStore.activeTabId, active.id, "the original active tab stays active");
        assert.equal(store.appStore.tabs.some((tab) => tab.id === target.id), true, "new input during cleanup keeps the target open");
        assert.equal(target.isDirty, true);
        assert.equal(tauri.draftEvents.some((event) => event.id === targetDraftId && event.kind === "delete-start"), true);
      } finally {
        tauri.releaseDraftDelete();
        unregisterTarget();
        unregisterActive();
      }
    });

    await runWp04bRedCase("delayed index release re-finds the target after tab and active-page changes", async () => {
      resetHarness();
      const first = makeTab("close-index-first", "close-index-first.md", "first.md", "first");
      const target = makeTab("close-index-target", "close-index-target.md", "target.md", "target");
      const neighbor = makeTab("close-index-neighbor", "close-index-neighbor.md", "neighbor.md", "neighbor");
      const next = makeTab("close-index-next", "close-index-next.md", "next.md", "next");
      for (const tab of [first, target, neighbor, next]) tab.isDirty = false;
      resetStore([first, target, neighbor, next], first);
      store.appStore.workspaceIndexReady = true;
      tauri.deferNextIndexRelease();
      const closePromise = store.closeTab(target.id);
      await tauri.waitForIndexReleaseStart();
      assert.equal(store.appStore.activeTabId, first.id, "background close leaves the active page unchanged while releasing its index");
      const firstIndex = store.appStore.tabs.findIndex((tab) => tab.id === first.id);
      assert.ok(firstIndex >= 0);
      store.appStore.tabs.splice(firstIndex, 1);
      store.appStore.activeTabId = next.id;
      store.appStore.currentFilePath = next.path;
      store.appStore.currentContent = next.content;
      store.appStore.isDirty = next.isDirty;
      store.appStore.splitLayout.mainTabId = next.id;
      store.appStore.splitLayout.mainTabIds = [next.id];
      tauri.releaseIndex();
      await closePromise;
      assert.equal(store.appStore.tabs.some((tab) => tab.id === target.id), false, "the requested object is removed after the delayed release");
      assert.equal(store.appStore.tabs.some((tab) => tab.id === neighbor.id), true, "a neighbor shifting into the old index is not removed");
      assert.equal(store.appStore.activeTabId, next.id, "the active page selected during release remains active");
    });

    if (wp04bFailures.length > 0) {
      const describe = (error) => error instanceof AggregateError
        ? [...error.errors].map((item) => describe(item)).join(" | ")
        : error instanceof Error ? error.stack : String(error);
      const summary = wp04bFailures.map(({ name, error }) => `${name}: ${describe(error)}`).join("\n");
      throw new Error(`WP04b red checks failed as expected before the close/draft implementation:\n${summary}`);
    }
  } finally {
    if (mathDom) mathDom.restore();
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else if (previousHTMLElement) globalThis.HTMLElement = previousHTMLElement;
    if (previousElement === undefined) delete globalThis.Element;
    else if (previousElement) globalThis.Element = previousElement;
    if (previousSVGElement === undefined) delete globalThis.SVGElement;
    else if (previousSVGElement) globalThis.SVGElement = previousSVGElement;
    if (mathDir) fs.rmSync(mathDir, { recursive: true, force: true });
    fs.rmSync(appStoreDir, { recursive: true, force: true });
  }

  const draftDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-draft-transaction-"));
  try {
    fs.writeFileSync(path.join(draftDir, "draft-vue.mjs"), proxyStub);
    fs.writeFileSync(path.join(draftDir, "draft-runtime.mjs"), "export function documentSessionForTab() { return null; }\n");
    fs.writeFileSync(path.join(draftDir, "draft-tracker.mjs"), fs.readFileSync(mutationTrackerPath));
    fs.writeFileSync(path.join(draftDir, "draft-dialog.mjs"), "export function showDialog() { return Promise.resolve('keep'); }\n");
    fs.writeFileSync(path.join(draftDir, "draft-app-store.mjs"), [
      "import { reactive } from './draft-vue.mjs';",
      "export const appStore = { settings: { general: { autoSave: true, autoSaveIntervalMinutes: 5 } }, tabs: reactive([]), activeTabId: '' };",
      "export async function flushDocumentSnapshot() {}",
      "export async function flushDocumentSnapshotWithReceipt() { return { markdown: '' }; }",
      "export function createUntitledTab(content = '', dirty = false) { const tab = { id: `created-${appStore.tabs.length}`, kind: 'untitled', path: '', content, isDirty: dirty, editorMode: 'wysiwyg' }; appStore.tabs.push(tab); appStore.activeTabId = tab.id; return tab; }",
      "export function setContent(content, dirty = true) { const tab = appStore.tabs.find((item) => item.id === appStore.activeTabId); if (tab) { tab.content = content; tab.isDirty = dirty; } }",
      "export async function switchMode() {}",
    ].join("\n"));
    fs.writeFileSync(path.join(draftDir, "draft-tauri.mjs"), [
      "export const draftWrites = [];",
      "let defer = false;",
      "let release = null;",
      "export function deferNextWrite() { defer = true; }",
      "export function releaseWrite() { release?.(); release = null; }",
      "export async function invoke(command, args = {}) {",
      "  if (command === 'write_draft') { draftWrites.push(args.record); if (defer) { defer = false; await new Promise((resolve) => { release = resolve; }); } return null; }",
      "  if (command === 'get_file_snapshot') return { exists: false };",
      "  if (command === 'list_drafts') return [];",
      "  return null;",
      "}",
    ].join("\n"));
    let draftSource = fs.readFileSync(path.join(root, "src", "stores", "draftStore.ts"), "utf8");
    draftSource = draftSource
      .replaceAll("from \"./appStore\"", "from \"./draft-app-store.mjs\"")
      .replaceAll("from \"../editor/documentRuntime\"", "from \"./draft-runtime.mjs\"")
      .replaceAll("from \"../editor/documentMutationTracker\"", "from \"./draft-tracker.mjs\"")
      .replaceAll("from \"./saveTransaction\"", "from \"./saveTransaction.mjs\"")
      .replaceAll("from \"./dialogStore\"", "from \"./draft-dialog.mjs\"")
      .replaceAll("from \"vue\"", "from \"./draft-vue.mjs\"")
      .replaceAll("from \"@tauri-apps/api/core\"", "from \"./draft-tauri.mjs\"");
    fs.writeFileSync(path.join(draftDir, "draftStore.mjs"), ts.transpileModule(draftSource, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
      },
    }).outputText);
    fs.writeFileSync(
      path.join(draftDir, "saveTransaction.mjs"),
      fs.readFileSync(modulePath, "utf8")
        .replaceAll('from "../editor/documentMutationTracker.mjs"', 'from "./draft-tracker.mjs"')
        .replaceAll('from "../save-vue.mjs"', 'from "./save-vue.mjs"'),
    );
    fs.copyFileSync(path.join(tempDir, "save-vue.mjs"), path.join(draftDir, "save-vue.mjs"));

    const draftApp = await import(pathToFileURL(path.join(draftDir, "draft-app-store.mjs")).href);
    const draftTauri = await import(pathToFileURL(path.join(draftDir, "draft-tauri.mjs")).href);
    const draftModule = await import(pathToFileURL(path.join(draftDir, "draftStore.mjs")).href);
    const untitledA = { id: "untitled-a", kind: "untitled", path: "", content: "A", isDirty: true, editorMode: "wysiwyg" };
    const untitledB = { id: "untitled-b", kind: "untitled", path: "", content: "B", isDirty: true, editorMode: "wysiwyg" };
    draftApp.appStore.tabs = [untitledA, untitledB];
    draftApp.appStore.activeTabId = untitledA.id;
    await draftModule.flushCurrentDraft();
    draftApp.appStore.activeTabId = untitledB.id;
    await draftModule.flushCurrentDraft();
    assert.equal(draftTauri.draftWrites.length, 2, "each untitled tab gets an independent draft write");
    assert.notEqual(draftTauri.draftWrites[0].id, draftTauri.draftWrites[1].id, "untitled draft IDs are bound to tab identity");
    assert.deepEqual(draftTauri.draftWrites.map((record) => record.content), ["A", "B"]);
    const bDraftId = draftModule.draftStore.activeDraftId;

    draftApp.appStore.activeTabId = untitledA.id;
    untitledA.content = "A after switch";
    draftTauri.deferNextWrite();
    const pendingDraft = draftModule.flushCurrentDraft();
    await new Promise((resolve) => setImmediate(resolve));
    draftApp.appStore.activeTabId = untitledB.id;
    draftTauri.releaseWrite();
    await pendingDraft;
    assert.equal(draftModule.draftStore.activeDraftId, bDraftId, "a draft finishing after a tab switch cannot retarget the active draft pointer");
  } finally {
    fs.rmSync(draftDir, { recursive: true, force: true });
  }

  console.log("save transaction and window-close coordinator checks passed (production appStore/draftStore with deferred races)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
