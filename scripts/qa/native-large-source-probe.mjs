import assert from 'node:assert/strict';
import { createNativeLargeEditorFixture } from './native-large-editor-probe.mjs';
export function createNativeLargeSourceFixture(token) {
  const fixture = createNativeLargeEditorFixture(token);
  fixture.fixtureContent = fixture.fixtureContent.replace(/[\r\n]+$/, '');
  fixture.evidence.name = 'large-source';
  fixture.evidence.terminalNewline = false;
  fixture.evidence.expectedMinimumBytes = 5 * 1024 * 1024;
  fixture.evidence.expectedSavedPrefix = '[large-source-1][large-source-2]';
  fixture.evidence.expectedSavedSuffix = '[tail-1][tail-2]';
  fixture.evidence.expectedSavedReplacements = [['body 0 ', 'BODY-ONCE 0 ']];
  return fixture;
}
export async function runNativeLargeSourceProbe(client, context) {
  assert.ok(context?.fixturePath && context?.fixtureContent);
  return client.evaluate(`(async () => {
    const fixturePath = ${JSON.stringify(context.fixturePath)};
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async (label, check) => {
      for (let i = 0; i < 1200; i++) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 25)); }
      throw new Error('timeout: ' + label);
    };
    const progress = (stage, detail = {}) => { globalThis.__LIGHTMARK_QA_PROGRESS = { stage, at: Date.now(), ...detail }; };
    progress('large-source:import-store');
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
    const largeClient = await import('/src/editor/largeSourceClient.ts');
    const internals = globalThis.__TAURI_INTERNALS__;
    const native = internals.invoke.bind(internals);
    const original = await native('read_text_file', { path: fixturePath });
    progress('large-source:before-open');
    await store.setActivePane('main');
    const opened = await store.openFile(fixturePath, { paneId: 'main', recordNavigation: false });
    const tab = store.getPaneTab('main');
    expect(tab?.documentMode === 'large', 'fixture must enter large mode: ' + JSON.stringify({ opened, path: tab?.path, mode: tab?.documentMode, status: store.appStore.statusMessage }));
    const session = await runtime.waitForDocumentSession(tab.id, 'source', 30000);
    progress('large-source:source-session');
    const content = await wait('CodeMirror source window', () => document.querySelector('[data-large-source-editor] .cm-content'));
    await wait('first range loaded', () => content.textContent.includes('alpha'));
    expect(document.querySelector('[data-large-source-editor] textarea') == null, 'large source must use CodeMirror');
    // Match Windows KeyboardEvent data. A lowercase synthetic z plus Shift
    // resolves as Mod-z in CodeMirror before its shifted-key fallback.
    const key = (value, shift = false) => content.dispatchEvent(new KeyboardEvent('keydown', {
      key: shift && value.length === 1 ? value.toUpperCase() : value,
      code: value.length === 1 ? 'Key' + value.toUpperCase() : value,
      keyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : value === 'Home' ? 36 : value === 'End' ? 35 : 0,
      ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true,
    }));
    content.focus(); key('Home');
    await new Promise(resolve => setTimeout(resolve, 50));
    let releaseAck; let held = false;
    let heldReceipt = null;
    const observedCalls = [];
    const ackGate = new Promise(resolve => { releaseAck = resolve; });
    const removeObserver = largeClient.observeLargeSourceReceipts(tab.largeFile.sessionId, async (command, args, result) => {
      observedCalls.push(command);
      if (!held && command === 'apply_file_operation') {
        expect(typeof args.operationId === 'string' && result.operationId === args.operationId, 'held receipt must match its exact operationId');
        heldReceipt = result; held = true; progress('large-source:held-ack'); await ackGate;
      }
    });
    expect(document.execCommand('insertText', false, '[large-source-1]'), 'native contenteditable insert must succeed');
    await wait('pending source edit', () => session.hasPendingEdits());
    let firstOutcome = null;
    const firstFlush = session.flushPendingEdits('save').then(() => firstOutcome = ({ ok: true }), error => firstOutcome = ({ ok: false, error: String(error) }));
    await wait('first apply held', () => { if (firstOutcome) throw new Error('first flush returned before apply hook: ' + JSON.stringify(firstOutcome) + ' calls=' + JSON.stringify(observedCalls) + ' status=' + store.appStore.statusMessage); return held; });
    const committedBeforeAck = await native('read_file_range', { sessionId: tab.largeFile.sessionId,
      expectedRevision: heldReceipt.revision, coordinateSpace: tab.largeFile.coordinateSpace,
      startLine: 0, startColumn: 0, maxBytes: 1024 });
    expect(committedBeforeAck.text.startsWith('[large-source-1]'), 'real Tauri operation must commit before the receipt observer releases');
    expect(tab.largeFile.revision < heldReceipt.revision, 'frontend must still await held operation ACK');
    content.focus();
    expect(document.execCommand('insertText', false, '[large-source-2]'), 'second input during held ACK must succeed');
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseAck();
    const firstResult = await firstFlush;
    removeObserver();
    await session.flushPendingEdits('save');
    let expected = '[large-source-1][large-source-2]' + original;
    expect(await store.saveCurrentFile(), 'real native save failed');
    expect(await native('read_text_file', { path: fixturePath }) === expected, 'two inputs/ACKs must preserve every mixed EOL byte');
    progress('large-source:saved');
    const beforeUndo = tab.largeFile.revision;
    content.focus(); key('z');
    await wait('backend undo revision', () => tab.largeFile.revision > beforeUndo);
    await wait('undo range loaded', () => content.textContent.includes('[large-source-1]') && !content.textContent.includes('[large-source-2]'));
    expect(await store.saveCurrentFile(), 'undo save failed');
    expect(await native('read_text_file', { path: fixturePath }) === '[large-source-1]' + original, 'backend undo did not restore exact first operation');
    const beforeRedo = tab.largeFile.revision;
    content.focus(); key('z', true);
    await wait('backend redo revision', () => tab.largeFile.revision > beforeRedo);
    const redoRange = await native('read_file_range', { sessionId: tab.largeFile.sessionId, expectedRevision: tab.largeFile.revision,
      coordinateSpace: tab.largeFile.coordinateSpace, startLine: 0, startColumn: 0, maxBytes: 1024 });
    const redoLocal = JSON.parse(await session.captureRecoveryBundle());
    progress('large-source:redo', { backendPrefix: redoRange.text.slice(0, 100), localPrefix: redoLocal.text?.slice(0, 100),
      domConnected: content.isConnected, currentDomPrefix: document.querySelector('[data-large-source-editor] .cm-content')?.textContent.slice(0, 100),
      sameSession: runtime.documentSessionForTab(tab.id) === session,
      localWindow: { startLine: redoLocal.windowRange?.startLine, startColumn: redoLocal.windowRange?.startColumn,
        endLine: redoLocal.windowRange?.endLine, endColumn: redoLocal.windowRange?.endColumn, revision: redoLocal.windowRange?.revision },
      status: store.appStore.statusMessage });
    expect(redoRange.text.startsWith('[large-source-1][large-source-2]'), 'backend redo after an intervening save did not restore the exact second operation: ' + redoRange.text.slice(0, 100));
    await wait('redo window', () => content.textContent.includes('[large-source-2]'));
    expect(await store.saveCurrentFile(), 'redo save failed');
    expect(await native('read_text_file', { path: fixturePath }) === expected, 'redo exact bytes differ');
    window.dispatchEvent(new CustomEvent('lightmark:jump-line', { detail: { line: 15000, paneId: 'main' } }));
    await wait('bounded far window', () => content.textContent.includes('body 1') && !content.textContent.includes('alpha'));
    expect(new TextEncoder().encode(content.textContent).byteLength <= 262144, 'bounded CM window exceeds 256KiB');
    expect(tab.largeFile.revision === beforeRedo + 1, 'window reload must not create a content revision');
    progress('large-source:far-window');
    const originalLines = original.replace(/\\r\\n?|\\n/g, '\\n').split('\\n');
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, bubbles: true, cancelable: true }));
    await wait('one-character navigation across a window start', async () => {
      const bundle = JSON.parse(await session.captureRecoveryBundle());
      return bundle.logicalHead.line === 14999 && bundle.logicalHead.column === originalLines[14999].length;
    });
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true }));
    await wait('return across the same line boundary', async () => {
      const bundle = JSON.parse(await session.captureRecoveryBundle());
      return bundle.logicalHead.line === 15000 && bundle.logicalHead.column === 0;
    });
    expect(tab.largeFile.revision === beforeRedo + 1, 'cursor navigation must not create a revision');
    content.focus(); const eofKeyAllowedDefault = key('End');
    await wait('canonical EOF window', async () => {
      const bundle = JSON.parse(await session.captureRecoveryBundle());
      progress('large-source:eof-wait', { keyHandled: !eofKeyAllowedDefault,
        logicalHead: bundle.logicalHead, logicalAnchor: bundle.logicalAnchor, totalLines: tab.largeFile.totalLines,
        window: bundle.windowRange && { startLine: bundle.windowRange.startLine, startColumn: bundle.windowRange.startColumn,
          endLine: bundle.windowRange.endLine, endColumn: bundle.windowRange.endColumn },
        textEnd: bundle.text?.slice(-80), status: store.appStore.statusMessage,
        pending: session.hasPendingEdits(), connected: content.isConnected });
      return bundle.logicalHead.line < tab.largeFile.totalLines && bundle.logicalHead.line >= tab.largeFile.totalLines - 1;
    });
    let eofInputVersion = session.pendingEditVersion();
    expect(document.execCommand('insertText', false, '[tail-1]'), 'first EOF input failed');
    await wait('first EOF input reaches CodeMirror', () => session.pendingEditVersion() > eofInputVersion);
    await session.flushPendingEdits('save');
    eofInputVersion = session.pendingEditVersion();
    expect(document.execCommand('insertText', false, '[tail-2]'), 'second EOF input failed');
    await wait('second EOF input reaches CodeMirror', () => session.pendingEditVersion() > eofInputVersion);
    await session.flushPendingEdits('save');
    expected += '[tail-1][tail-2]';
    expect(await store.saveCurrentFile(), 'EOF save failed');
    expect(await native('read_text_file', { path: fixturePath }) === expected, 'successive EOF edits must preserve exact bytes');
    progress('large-source:eof-saved');
    const find = await import('/src/stores/findReplaceStore.ts');
    const findCalls = [], completedSearches = new Set(), searchQueries = new Map();
    const stopFindObserver = largeClient.observeLargeSourceReceipts(tab.largeFile.sessionId, (command, args, result) => {
      findCalls.push({ command, args });
      if (command === 'start_large_search_job') searchQueries.set(result.jobId, args.query);
      if ((command === 'poll_large_job' || command === 'start_large_search_job') && result.status === 'completed'
        && searchQueries.has(result.jobId)) completedSearches.add(searchQueries.get(result.jobId));
    });
    find.findReplaceStore.open = true;
    find.findReplaceStore.query = 'missing-before-single-' + tab.largeFile.sessionId;
    find.runFindCommand('refresh');
    await wait('initial missing query completes', () => completedSearches.has(find.findReplaceStore.query));
    const beforeSingleReplace = tab.largeFile.revision;
    find.findReplaceStore.query = 'body';
    find.findReplaceStore.replaceText = 'BODY-ONCE';
    find.runFindCommand('replaceCurrent');
    await wait('single replacement commits', () => tab.largeFile.revision > beforeSingleReplace);
    await wait('single replacement range settles', async () => JSON.parse(await session.captureRecoveryBundle()).windowRange.revision === tab.largeFile.revision);
    const singleCalls = findCalls.filter(call => call.command === 'start_large_replace_job');
    expect(singleCalls.length === 1 && singleCalls[0].args.currentMatch != null, 'single replacement must carry an explicit match, never the replace-all null intent');
    expected = expected.replace('body 0 ', 'BODY-ONCE 0 ');
    expect(await store.saveCurrentFile(), 'single replacement save failed');
    expect(await native('read_text_file', { path: fixturePath }) === expected, 'single replacement changed more than its selected occurrence');
    const afterSingleReplace = tab.largeFile.revision;
    find.findReplaceStore.query = 'missing-after-single-' + tab.largeFile.sessionId;
    find.runFindCommand('replaceCurrent');
    await wait('missing single query completes', () => completedSearches.has(find.findReplaceStore.query));
    expect(findCalls.filter(call => call.command === 'start_large_replace_job').length === 1, 'a missing single match must not issue replace-all');
    expect(tab.largeFile.revision === afterSingleReplace, 'a missing single match changed the document revision');
    stopFindObserver(); find.closeFindPanel();
    progress('large-source:single-replace-intent');

    await store.closeTab(tab.id);
    await store.openFile(fixturePath, { paneId: 'main', recordNavigation: false });
    const reopened = store.getPaneTab('main');
    await runtime.waitForDocumentSession(reopened.id, 'source', 30000);
    await wait('reopened source prefix', () => document.querySelector('[data-large-source-editor] .cm-content')?.textContent.includes('[large-source-2]'));
    expect(await native('read_text_file', { path: fixturePath }) === expected, 'reopen changed disk bytes');
    const result = { status: 'passed', firstFlush: firstResult, revision: reopened.largeFile.revision,
      fixtureBytes: new TextEncoder().encode(expected).byteLength, boundedWindowBytes: new TextEncoder().encode(content.textContent).byteLength,
      checks: ['real-CodeMirror', 'held-ACK-new-input', 'mixed-EOL-save', 'backend-undo-redo', 'bounded-far-window', 'cross-window-character-navigation', 'canonical-EOF-two-appends', 'single-replace-intent', 'close-reopen'],
      ime: 'not-tested-real-Windows-composition', release: false };
    await native('plugin:window|close', { label: 'main' });
    return result;
  })()`, 120000);
}
