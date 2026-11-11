import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** An owned visible window for real OS keyboard/IME/visual checks, ended only by a sentinel or timeout. */
export async function runNativeManualUiProbe(client, context) {
  const phase = context?.manifest?.launch?.phases?.at(-1);
  assert.ok(context?.runToken && context.identifier && context.fixturePath && context.fixtureContent);
  assert.ok(context.manifest.isolation?.preexistingPathsChecked);
  assert.equal(client.url, phase?.target?.webSocketDebuggerUrl);
  assert.ok(phase.targetNonce && phase.pid && phase.loopback);
  const targetUrl = new URL(phase.target.url);
  assert.equal(targetUrl.hostname, '127.0.0.1');
  assert.equal(targetUrl.searchParams.get('lightmarkQa'), phase.targetNonce);
  const controlPath = path.join(context.runDir, 'manual-ui-control.json');
  const sentinelPath = path.join(context.runDir, 'manual-ui-finish.json');
  const commandPath = path.join(context.runDir, 'manual-ui-command.json');
  const resultPath = path.join(context.runDir, 'manual-ui-result.json');
  const commands = [], executedIds = new Set();
  const control = { schemaVersion: 1, status: 'bootstrapping', runDir: context.runDir, identifier: context.identifier,
    fixturePath: context.fixturePath, pid: phase.pid, cdpPort: phase.cdpPort, vitePort: phase.vitePort,
    webSocketDebuggerUrl: phase.target.webSocketDebuggerUrl, targetNonce: phase.targetNonce,
    controlPath, sentinelPath, commandPath, resultPath, browserGlobal: '__LIGHTMARK_MANUAL_UI_QA', createdAt: new Date().toISOString(),
    timeoutMs: 3600000, windowTitle: `LightMark QA Manual ${context.runToken}`,
    finish: 'Use browserGlobal.finish({status:"passed"|"failed",evidence:{...}}), or write the same JSON to sentinelPath.',
    isolation: { config: context.expectedAppConfigDir, data: context.expectedAppDataDir, local: context.expectedAppLocalDataDir } };
  await writeFile(controlPath, JSON.stringify(control, null, 2), 'utf8');
  await client.evaluate(`(() => {
    const q = globalThis.__LIGHTMARK_MANUAL_UI_QA = { ready: false, notes: [], snapshots: [], errors: [], operations: {}, keyboardEvents: [], droppedKeyboardEvents: 0 };
    q.initialize = (async () => {
      q.store = await import('/src/stores/appStore.ts'); q.runtime = await import('/src/editor/documentRuntime.ts');
      const pathApi = await import('/node_modules/@tauri-apps/api/path.js');
      q.paths = { config: await pathApi.appConfigDir(), data: await pathApi.appDataDir(), local: await pathApi.appLocalDataDir() };
      const expected = ${JSON.stringify(control.isolation)};
      const normalize = value => { let v = String(value || '').replaceAll(String.fromCharCode(92), '/').toLowerCase(); while (v.endsWith('/')) v = v.slice(0, -1); return v; };
      for (const key of Object.keys(expected)) if (normalize(q.paths[key]) !== normalize(expected[key])) throw new Error('manual profile isolation mismatch: ' + key);
      q.fixturePath = ${JSON.stringify(context.fixturePath)}; q.original = ${JSON.stringify(context.fixtureContent)};
      await q.store.openFile(q.fixturePath, { paneId: 'main', recordNavigation: false });
      const tab = q.store.getPaneTab('main'); if (tab?.path !== q.fixturePath) throw new Error('manual fixture did not open');
      q.tabId = tab.id; await q.store.switchMode('wysiwyg');
      q.session = () => q.runtime.documentSessionForTab(q.tabId);
      q.editor = () => q.session()?.editorIdentity;
      q.state = () => ({ tabId: q.tabId, activeTabId: q.store.appStore.activeTabId, path: q.store.getPaneTab('main')?.path,
        mode: q.session()?.mode, revision: q.session()?.revision, pending: q.session()?.hasPendingEdits?.(), composing: q.session()?.isComposing?.(),
        dirty: q.store.getPaneTab('main')?.isDirty, focus: document.activeElement && { tag: document.activeElement.tagName, className: document.activeElement.className },
        status: q.store.appStore.statusMessage, saveState: q.store.appStore.saveState });
      q.note = (name, evidence) => { const entry = { name, evidence, at: new Date().toISOString(), state: q.state() }; q.notes.push(entry); return entry; };
      q.captureSnapshot = async (label = 'manual') => {
        const snapshot = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
        // Flush receipts hold the live session identity; evidence must never retain
        // the editor graph (which can be circular) or serialize it over CDP.
        const evidence = { tabId: snapshot.tabId, revision: snapshot.revision,
          markdown: snapshot.markdown, dirty: snapshot.dirty,
          mutationToken: snapshot.mutationToken && { documentGeneration: snapshot.mutationToken.documentGeneration,
            pendingInputVersion: snapshot.mutationToken.pendingInputVersion, revision: snapshot.mutationToken.revision } };
        q.snapshots.push({ label, snapshot: evidence, at: new Date().toISOString(), state: q.state() }); return evidence;
      };
      q.startOperation = (id, work) => {
        if (q.operations[id]?.state === 'running') throw new Error('manual operation is already running');
        q.operations[id] = { state: 'running', startedAt: new Date().toISOString() };
        Promise.resolve().then(() => work(q)).then(result => { q.operations[id] = { state: 'fulfilled', result, at: new Date().toISOString() }; }, error => { q.operations[id] = { state: 'rejected', error: String(error?.stack || error), at: new Date().toISOString() }; });
        return { started: id };
      };
      q.finish = result => { if (!result || !['passed','failed'].includes(result.status)) throw new Error('finish requires an explicit passed or failed status'); q.finishRequest = { ...result, notes: q.notes, snapshots: q.snapshots, errors: q.errors, state: q.state() }; return { finishing: true }; };
      window.addEventListener('error', event => q.errors.push({ message: event.message, at: new Date().toISOString() }));
      window.addEventListener('unhandledrejection', event => q.errors.push({ message: String(event.reason), at: new Date().toISOString() }));
      for (const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup']) document.addEventListener(type, event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('.ProseMirror,.cm-editor')) return;
        if (q.keyboardEvents.length >= 2000) { q.droppedKeyboardEvents++; return; }
        q.keyboardEvents.push({ type, trusted: event.isTrusted, isComposing: event.isComposing, key: event.key, code: event.code, keyCode: event.keyCode,
          inputType: event.inputType, data: typeof event.data === 'string' ? event.data.slice(0, 200) : event.data,
          at: new Date().toISOString(), target: { tag: target.tagName, className: target.className }, mode: q.session()?.mode });
      }, true);
      q.ready = true;
    })().catch(error => { q.initializationError = String(error?.stack || error); });
    return { started: true };
  })()`, 5000);
  const started = Date.now();
  while (true) {
    const state = await client.evaluate(`(() => { const q = globalThis.__LIGHTMARK_MANUAL_UI_QA; return { ready: q?.ready, error: q?.initializationError, state: q?.state?.() }; })()`, 5000);
    if (state.error) throw new Error(state.error);
    if (state.ready) { control.status = 'ready'; control.readyAt = new Date().toISOString(); control.state = state.state; break; }
    if (Date.now() - started > 30000) throw new Error('manual UI initialization timed out');
    await delay(100);
  }
  await writeFile(controlPath, JSON.stringify(control, null, 2), 'utf8');
  console.log(JSON.stringify({ kind: 'manual-ui-ready', ...control }));
  let result;
  while (Date.now() - started < control.timeoutMs) {
    let command;
    try { command = JSON.parse(await readFile(commandPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (command && !executedIds.has(command.id)) {
      if (typeof command.id !== 'string' || !command.id || command.id.length > 128 || typeof command.expression !== 'string' || command.expression.length > 262144) throw new Error('manual command requires a unique string id and bounded expression');
      executedIds.add(command.id);
      const entry = { id: command.id, expression: command.expression, startedAt: new Date().toISOString() };
      try { entry.result = (await client.evaluate(command.expression, 5000)) ?? null; }
      catch (error) { entry.error = String(error?.stack || error); }
      entry.finishedAt = new Date().toISOString(); commands.push(entry);
      await writeFile(resultPath, JSON.stringify(entry, null, 2), 'utf8');
    }
    try {
      result = JSON.parse(await readFile(sentinelPath, 'utf8'));
      if (!['passed','failed'].includes(result?.status)) throw new Error('manual sentinel requires explicit status');
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    result = await client.evaluate('globalThis.__LIGHTMARK_MANUAL_UI_QA?.finishRequest ?? null', 5000);
    if (result) break;
    await delay(250);
  }
  if (!result) result = { status: 'failed', reason: 'manual UI timed out; no keyboard/IME or visual success is inferred' };
  const browser = await client.evaluate(`(() => { const q = globalThis.__LIGHTMARK_MANUAL_UI_QA; return { notes: q.notes, snapshots: q.snapshots, errors: q.errors, state: q.state(), keyboardEvents: q.keyboardEvents, droppedKeyboardEvents: q.droppedKeyboardEvents }; })()`, 5000);
  control.status = 'finished'; control.finishedAt = new Date().toISOString(); control.result = result;
  await writeFile(controlPath, JSON.stringify(control, null, 2), 'utf8');
  await client.evaluate(`(() => { setTimeout(() => { void globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }); }, 100); return { cleanupScheduled: true }; })()`, 5000);
  return { ...result, browser, commands, controlPath, sentinelPath, commandPath, resultPath, method: 'isolated-visible-window-with-explicit-human-or-computer-use-evidence', keyboardImeAutomaticallyClaimed: false };
}
