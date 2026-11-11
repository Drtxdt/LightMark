import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** The caller must be the isolated launcher; this module never discovers arbitrary CDP ports. */
export async function runNativeCloseBufferProbe(client, context) {
  const phase = context?.manifest?.launch?.phases?.at(-1);
  assert.ok(context?.runToken && context.identifier && context.fixturePath && context.fixtureContent);
  assert.ok(context.manifest.isolation?.preexistingPathsChecked, 'isolated paths must be verified first');
  assert.equal(client.url, phase?.target?.webSocketDebuggerUrl, 'use only the owned launcher target');
  assert.ok(phase?.targetNonce && phase.pid && phase.loopback, 'nonce, process and profile evidence are required');
  const targetUrl = new URL(phase.target.url);
  assert.equal(targetUrl.hostname, '127.0.0.1');
  assert.equal(targetUrl.searchParams.get('lightmarkQa'), phase.targetNonce);

  const evidence = { method: 'host-polled-small-cdp-evaluations', steps: [], cases: [], browserTimersUsedForWaiting: false };
  const qaName = '__LIGHTMARK_CLOSE_BUFFER_QA';
  const read = expression => client.evaluate(`(() => { const q = globalThis.${qaName}; ${expression} })()`, 5000);
  async function hostWait(label, check, timeoutMs = 20000) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      last = await check();
      if (last?.ok) {
        evidence.steps.push({ label, elapsedMs: Date.now() - started, result: last });
        return last;
      }
      await delay(50);
    }
    const diagnostic = await read('return q?.snapshot?.() ?? { initialized: false };').catch(error => ({ readError: String(error) }));
    throw new Error(`${label} timed out: ${JSON.stringify({ last, diagnostic, evidence })}`);
  }
  async function startOperation(label, body) {
    return read(`
      if (!q) throw new Error('close QA context is missing');
      q.operations[${JSON.stringify(label)}] = { state: 'running', startedAt: Date.now() };
      Promise.resolve().then(async () => { ${body} }).then(
        value => q.operations[${JSON.stringify(label)}] = { state: 'fulfilled', value: value ?? null, at: Date.now() },
        error => q.operations[${JSON.stringify(label)}] = { state: 'rejected', error: String(error?.stack || error), at: Date.now() },
      );
      return { started: ${JSON.stringify(label)} };
    `);
  }
  async function operation(label, body, timeoutMs = 30000) {
    await startOperation(label, body);
    return hostWait(label, async () => {
      const result = await read(`return q.operations[${JSON.stringify(label)}];`);
      if (result?.state === 'rejected') throw new Error(`${label}: ${result.error}`);
      return { ok: result?.state === 'fulfilled', ...result };
    }, timeoutMs);
  }

  // Imports are deliberately retained in a page-owned object. No long Runtime.evaluate
  // Promise owns the rest of the test, and every production Promise gets a rejection handler.
  await client.evaluate(`(() => {
    globalThis.${qaName} = { operations: {}, events: [], ready: false };
    const q = globalThis.${qaName};
    q.initialization = (async () => {
      q.store = await import('/src/stores/appStore.ts');
      q.runtime = await import('/src/editor/documentRuntime.ts');
      q.dialog = await import('/src/stores/dialogStore.ts');
      q.editorRoot = () => {
        const tab = q.store.getPaneTab('main');
        if (!tab || tab.id !== q.tabId) return null;
        const session = q.runtime.documentSessionForTab(tab.id);
        const root = session?.mode === 'wysiwyg' ? session.editorIdentity?.view?.dom : null;
        return root?.isConnected ? root : null;
      };
      const pathApi = await import('/node_modules/@tauri-apps/api/path.js');
      q.paths = { config: await pathApi.appConfigDir(), data: await pathApi.appDataDir(), local: await pathApi.appLocalDataDir() };
      const expectedPaths = ${JSON.stringify({ config: context.expectedAppConfigDir, data: context.expectedAppDataDir, local: context.expectedAppLocalDataDir })};
      const normalize = value => {
        let normalized = String(value || '').replaceAll(String.fromCharCode(92), '/').toLowerCase();
        while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
        return normalized;
      };
      for (const key of Object.keys(expectedPaths)) if (normalize(q.paths[key]) !== normalize(expectedPaths[key])) throw new Error('wrong owned runtime path: ' + key);
      q.snapshot = () => {
        const store = q.store.appStore;
        const tab = q.store.getPaneTab('main');
        const session = tab && q.runtime.documentSessionForTab(tab.id);
        const active = q.dialog.dialogStore.active;
        const dialogs = [...document.querySelectorAll('section[role="dialog"]')].map(element => ({
          title: element.getAttribute('aria-label'), text: element.innerText?.slice(0, 800),
          buttons: [...element.querySelectorAll('button')].map(button => button.textContent?.trim()),
          connected: element.isConnected,
        }));
        return { at: Date.now(), href: location.href, visibility: document.visibilityState, hasFocus: document.hasFocus(),
          activeTabId: store.activeTabId, tabId: tab?.id, path: tab?.path, dirty: tab?.isDirty,
          revision: session?.revision, pending: session?.hasPendingEdits?.(), composing: session?.isComposing?.(),
          token: session?.mutationToken?.(), dialogs,
          activeDialog: active && { title: active.title, buttons: active.buttons.map(button => ({ id: button.id, label: button.label })) },
          activeElement: document.activeElement && { tag: document.activeElement.tagName, className: document.activeElement.className },
          pageClasses: [...document.querySelectorAll('.editor-page')].map(page => page.className),
          operations: { ...q.operations }, events: q.events.slice(-30), status: store.statusMessage };
      };
      q.fixturePath = ${JSON.stringify(context.fixturePath)};
      q.original = await globalThis.__TAURI_INTERNALS__.invoke('read_text_file', { path: q.fixturePath });
      if (q.original !== ${JSON.stringify(context.fixtureContent)}) throw new Error('fixture content differs from launcher evidence');
      q.ready = true;
    })().catch(error => { q.initializationError = String(error?.stack || error); });
    return { started: true };
  })()`, 5000);
  await hostWait('owned bootstrap', async () => {
    const result = await read('if (q.initializationError) throw new Error(q.initializationError); return { ok: q.ready, paths: q.paths };');
    return result;
  });

  for (let iteration = 0; iteration < 3; iteration++) {
    const prefix = `case-${iteration}`;
    await operation(`${prefix}:open`, `
      if (q.store.appStore.splitLayout.enabled) await q.store.toggleSplitLayout();
      await q.store.setActivePane('main');
      await q.store.openFile(q.fixturePath, { paneId: 'main', recordNavigation: false });
      await q.store.switchMode('wysiwyg');
      q.tabId = q.store.getPaneTab('main')?.id;
      if (!q.tabId) throw new Error('fixture did not open');
      return { tabId: q.tabId };
    `);
    await hostWait(`${prefix}:nodeview`, () => read(`
      const session = q.runtime.documentSessionForTab(q.tabId);
      const views = [...(q.editorRoot()?.querySelectorAll('.front-matter-node') ?? [])].filter(node => node.isConnected);
      return { ok: session?.mode === 'wysiwyg' && views.length === 1, views: views.length, snapshot: q.snapshot() };
    `));
    await read(`
      const node = q.editorRoot()?.querySelector('.front-matter-node');
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return { activated: true };
    `);
    await hostWait(`${prefix}:control`, () => read(`return { ok: Boolean(q.editorRoot()?.querySelector('.front-matter-editor')) };`));
    const draft = `title: close buffer ${context.runToken} ${iteration}`;
    const input = await read(`
      q.control = q.editorRoot()?.querySelector('.front-matter-editor');
      q.control.focus(); q.control.value = ${JSON.stringify(draft)};
      q.control.dispatchEvent(new Event('input', { bubbles: true }));
      return { focused: document.activeElement === q.control, ...q.snapshot() };
    `);
    assert.equal(input.focused, true);
    assert.equal(input.dirty, true);
    assert.equal(input.pending, true);
    await operation(`${prefix}:snapshots`, `
      const first = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
      const second = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
      if (!first.markdown.includes(${JSON.stringify(draft)}) || first.markdown !== second.markdown) throw new Error('focused snapshots differ or omit local value');
      if (document.activeElement !== q.control) throw new Error('snapshot blurred the local control');
      q.accepted = second.markdown;
      const session = q.runtime.documentSessionForTab(q.tabId);
      if (session.hasPendingEdits()) throw new Error('two snapshots left pending input');
      const finalize = session.finalizeClosePrompt;
      session.finalizeClosePrompt = async (...args) => {
        q.events.push({ stage: 'finalize-before', at: Date.now(), iteration: ${iteration} });
        try { const result = await finalize.apply(session, args); q.events.push({ stage: 'finalize-after', at: Date.now(), iteration: ${iteration} }); return result; }
        catch (error) { q.events.push({ stage: 'finalize-error', error: String(error), at: Date.now() }); throw error; }
      };
      return { focused: true, pending: false, snapshotLength: second.markdown.length };
    `);

    for (const action of ['取消', '不保存']) {
      const closeLabel = `${prefix}:close-${action}`;
      await startOperation(closeLabel, 'return await q.store.closeTab(q.tabId);');
      const visible = await hostWait(`${closeLabel}:dialog`, () => read(`
        const snapshot = q.snapshot();
        const matches = snapshot.dialogs.filter(dialog => dialog.buttons.some(label => label === ${JSON.stringify(action)}));
        return { ok: matches.length === 1 && Boolean(snapshot.activeDialog), ...snapshot };
      `));
      assert.equal(visible.dialogs.length, 1, 'exactly one application close dialog must be rendered');
      await read(`
        const buttons = [...document.querySelectorAll('section[role="dialog"] button')].filter(button => button.textContent.trim() === ${JSON.stringify(action)});
        if (buttons.length !== 1) throw new Error('ambiguous close action');
        buttons[0].click();
        return { clicked: ${JSON.stringify(action)}, snapshot: q.snapshot() };
      `);
      const settled = await hostWait(`${closeLabel}:resolved`, async () => {
        const result = await read(`
          const operation = q.operations[${JSON.stringify(closeLabel)}];
          if (operation?.state === 'rejected') throw new Error(operation.error);
          return { ok: operation?.state === 'fulfilled', ...q.snapshot() };
        `);
        return result;
      });
      const stillOpen = await read('return { open: q.store.appStore.tabs.some(tab => tab.id === q.tabId), dirty: q.store.appStore.tabs.find(tab => tab.id === q.tabId)?.isDirty };');
      assert.equal(stillOpen.open, action === '取消');
      if (action === '取消') {
        assert.equal(stillOpen.dirty, true, 'cancel must preserve unsaved document state');
        await operation(`${prefix}:after-cancel-snapshot`, `
          const snapshot = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
          if (snapshot.markdown !== q.accepted) throw new Error('cancel changed local content');
          return { preserved: true };
        `);
      }
      evidence.cases.push({ iteration, action, dialog: visible, settled });
    }
    await operation(`${prefix}:disk`, `
      const disk = await globalThis.__TAURI_INTERNALS__.invoke('read_text_file', { path: q.fixturePath });
      if (disk !== q.original) throw new Error('discard wrote the fixture');
      return { unchanged: true };
    `);
  }
  const finalState = await read('return q.snapshot();');
  evidence.finalState = finalState;
  evidence.status = 'passed';
  evidence.nativeKeyboardOrIMEClaimed = false;
  evidence.cleanupMethod = 'owned-window-destroy-after-host-probe';
  // Schedule owned-window cleanup only after evidence is returned to the host.
  await read(`q.cleanupTimer = setTimeout(() => { void globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }); }, 100); return { scheduled: true };`);
  return evidence;
}
