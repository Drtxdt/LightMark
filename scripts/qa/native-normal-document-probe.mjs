import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Host-polled real NodeViews and formal snapshots; never fabricates PM/dirty setup. */
export async function runNativeNormalDocumentProbe(client, context) {
  const phase = context?.manifest?.launch?.phases?.at(-1);
  assert.ok(context?.runToken && context.identifier && context.fixturePath && context.fixtureContent);
  assert.ok(context.manifest.isolation?.preexistingPathsChecked, 'isolated paths must be verified first');
  assert.equal(client.url, phase?.target?.webSocketDebuggerUrl, 'use only the owned launcher target');
  assert.ok(phase?.targetNonce && phase.pid && phase.loopback);
  const targetUrl = new URL(phase.target.url);
  assert.equal(targetUrl.hostname, '127.0.0.1');
  assert.equal(targetUrl.searchParams.get('lightmarkQa'), phase.targetNonce);
  const qaName = '__LIGHTMARK_NORMAL_DOCUMENT_QA';
  const evidence = { method: 'host-polled-small-cdp-evaluations', steps: [], nodeViews: [], history: [], browserTimersUsedForWaiting: false };
  const read = async body => {
    try { return await client.evaluate(`(() => { const q = globalThis.${qaName}; if (!q) throw new Error('Owned normal QA context was lost during navigation or HMR: ' + location.href); ${body} })()`, 5000); }
    catch (error) {
      const diagnostic = await client.evaluate(`globalThis.${qaName}?.snapshot?.() ?? { contextLost: true }`, 5000).catch(cause => ({ readError: String(cause) }));
      if (context.runDir) await writeFile(path.join(context.runDir, 'normal-document-diagnostic.json'), JSON.stringify({ evidence, diagnostic, expression: body, error: String(error) }, null, 2), 'utf8');
      throw new Error(`${String(error)}\n${JSON.stringify(diagnostic)}`);
    }
  };
  async function hostWait(label, check, timeoutMs = 20000) {
    const start = Date.now(); let last;
    while (Date.now() - start < timeoutMs) {
      last = await check();
      if (last?.ok) { evidence.steps.push({ label, elapsedMs: Date.now() - start, result: last }); return last; }
      await delay(50);
    }
    const diagnostic = await read('return q?.snapshot?.() ?? { initialized: false };').catch(error => ({ error: String(error) }));
    throw new Error(`${label} timed out: ${JSON.stringify({ last, diagnostic, evidence })}`);
  }
  async function operation(label, body, timeoutMs = 30000) {
    await read(`
      q.operations[${JSON.stringify(label)}] = { state: 'running', startedAt: Date.now() };
      Promise.resolve().then(async () => { ${body} }).then(
        value => q.operations[${JSON.stringify(label)}] = { state: 'fulfilled', value: value ?? null },
        error => q.operations[${JSON.stringify(label)}] = { state: 'rejected', error: String(error?.stack || error) });
      return { started: true };
    `);
    const result = await hostWait(label, async () => {
      const item = await read(`return q.operations[${JSON.stringify(label)}];`);
      if (item?.state === 'rejected') {
        const diagnostic = await read('return q.snapshot();');
        throw new Error(`${label}: ${item.error}\n${JSON.stringify(diagnostic)}`);
      }
      return { ok: item?.state === 'fulfilled', ...item };
    }, timeoutMs);
    return result.value;
  }
  await client.evaluate(`(() => {
    const q = globalThis.${qaName} = { ready: false, operations: {}, results: [], history: [], selectionTrace: [] };
    q.initialize = (async () => {
      q.store = await import('/src/stores/appStore.ts');
      q.runtime = await import('/src/editor/documentRuntime.ts');
      const pathApi = await import('/node_modules/@tauri-apps/api/path.js');
      q.paths = { config: await pathApi.appConfigDir(), data: await pathApi.appDataDir(), local: await pathApi.appLocalDataDir() };
      const expected = ${JSON.stringify({ config: context.expectedAppConfigDir, data: context.expectedAppDataDir, local: context.expectedAppLocalDataDir })};
      const normalize = value => {
        let normalized = String(value || '').replaceAll(String.fromCharCode(92), '/').toLowerCase();
        while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
        return normalized;
      };
      for (const key of Object.keys(expected)) if (normalize(expected[key]) !== normalize(q.paths[key])) throw new Error('wrong owned runtime path: ' + key);
      q.fixturePath = ${JSON.stringify(context.fixturePath)};
      q.original = await globalThis.__TAURI_INTERNALS__.invoke('read_text_file', { path: q.fixturePath });
      if (q.original !== ${JSON.stringify(context.fixtureContent)}) throw new Error('fixture content differs from launcher evidence');
      q.expected = q.original;
      q.session = () => q.runtime.documentSessionForTab(q.tabId);
      q.editor = () => q.session()?.mode === 'wysiwyg' ? q.session().editorIdentity : null;
      q.root = () => { const root = q.editor()?.view?.dom; return root?.isConnected ? root : null; };
      q.selectionInfo = () => {
        const session = q.session(), history = q.runtime.documentHistoryForTab(q.tabId), current = history.current;
        const live = session?.captureHistoryBookmark?.(), projected = current && history.projection(current, session?.mode);
        return { mode: session?.mode, revision: session?.revision, live: live && { anchor: live.anchor, head: live.head },
          version: current?.id, primaryMode: current?.primary.root.mode, primary: current?.primary.bookmark,
          projectedMode: projected?.root.mode, projected: projected?.bookmark };
      };
      q.snapshot = () => ({ at: Date.now(), tabId: q.tabId, activeTabId: q.store.appStore.activeTabId,
        mode: q.session()?.mode, revision: q.session()?.revision, pending: q.session()?.hasPendingEdits?.(), dirty: q.store.getPaneTab('main')?.isDirty,
        token: q.session()?.mutationToken?.(), status: q.store.appStore.statusMessage,
        expected: q.expected, lastMarkdown: q.lastMarkdown, results: q.results, history: q.history, fineSourceCases: q.fineSourceCases, sourceProvenanceCases: q.sourceProvenanceCases,
        operations: { ...q.operations }, selectionTrace: q.selectionTrace, selection: q.selectionInfo(), focus: document.activeElement && { tag: document.activeElement.tagName, className: document.activeElement.className },
        pages: [...document.querySelectorAll('.editor-page')].map(page => page.className) });
      q.ready = true;
    })().catch(error => { q.initializationError = String(error?.stack || error); });
    return { started: true };
  })()`, 5000);
  await hostWait('owned bootstrap', () => read('if (q.initializationError) throw new Error(q.initializationError); return { ok: q.ready, paths: q.paths };'));
  await operation('open real fixture', `
    if (q.store.appStore.splitLayout.enabled) await q.store.toggleSplitLayout();
    await q.store.setActivePane('main');
    const opened = await q.store.openFile(q.fixturePath, { paneId: 'main', recordNavigation: false });
    const tab = q.store.getPaneTab('main');
    if (tab?.path !== q.fixturePath || tab.content !== q.original) throw new Error('production open did not load exact fixture: ' + JSON.stringify({ opened, path: tab?.path, status: q.store.appStore.statusMessage }));
    q.tabId = tab.id;
    q.mainTabId = tab.id;
    await q.store.switchMode('wysiwyg');
    return { tabId: q.tabId };
  `);
  await hostWait('real WYS session and four NodeViews', () => read(`
    const root = q.root(); const selectors = ['.front-matter-node','.footnotes','.toc-node','.html-block-node'];
    const page = root?.closest('.editor-page');
    const transitioning = page && [...page.classList].some(name => /-(enter|leave)-(active|from|to)$/.test(name));
    return { ok: q.session()?.mode === 'wysiwyg' && !transitioning && selectors.every(selector => root?.querySelectorAll(selector).length === 1), snapshot: q.snapshot() };
  `));
  const cases = [
    { kind: 'frontmatter', node: '.front-matter-node', control: '.front-matter-editor', event: 'mousedown', draft: `title: pending frontmatter ${context.runToken}`, before: '---\ntitle: Recovery bundle fixture\nqa: native\n---', wrap: value => `---\n${value}\n---` },
    { kind: 'footnote', node: '.footnotes', control: '.footnotes-editor', event: 'click', draft: `[^qa]: pending footnote ${context.runToken}`, before: '[^qa]: accepted footnote' },
    { kind: 'toc', node: '.toc-node', control: '.toc-node-editor', event: 'mousedown', draft: `pending toc ${context.runToken}`, before: '[TOC]' },
    { kind: 'html', node: '.html-block-node', control: '.html-block-editor', event: 'mousedown', draft: `<div>pending html ${context.runToken}</div>`, before: '<div data-lightmark-qa="html-block"><b>accepted html</b></div>' },
  ];
  for (const item of cases) {
    await read(`const node = q.root()?.querySelector(${JSON.stringify(item.node)}); if (!node) throw new Error('missing NodeView'); node.dispatchEvent(new MouseEvent(${JSON.stringify(item.event)}, { bubbles: true, cancelable: true })); return { activated: true };`);
    await hostWait(`${item.kind} control`, () => read(`return { ok: Boolean(q.root()?.querySelector(${JSON.stringify(item.control)})) };`));
    const input = await read(`
      q.control = q.root().querySelector(${JSON.stringify(item.control)}); q.blurs = 0;
      q.control.addEventListener('blur', () => { q.blurs++; });
      q.control.focus(); q.control.value = ${JSON.stringify(item.draft)}; q.control.dispatchEvent(new Event('input', { bubbles: true }));
      q.activationBlurs = q.blurs; q.blurs = 0;
      q.expected = q.expected.replace(${JSON.stringify(item.before)}, ${JSON.stringify(item.wrap ? item.wrap(item.draft) : item.draft)});
      return { focused: document.activeElement === q.control, dirty: q.store.getPaneTab('main')?.isDirty, pending: q.session()?.hasPendingEdits?.() };
    `);
    assert.equal(input.focused, true); assert.equal(input.dirty, true); assert.equal(input.pending, true);
    const result = await operation(`${item.kind} two snapshots`, `
      const first = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
      const second = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
      q.lastMarkdown = second.markdown;
      const result = { kind: ${JSON.stringify(item.kind)}, firstExact: first.markdown === q.expected, secondExact: second.markdown === q.expected,
        focused: document.activeElement === q.control, blurs: q.blurs, activationBlurs: q.activationBlurs, pending: q.session().hasPendingEdits(), revision: second.revision, dirty: q.store.getPaneTab('main')?.isDirty };
      if (!result.firstExact || !result.secondExact) { result.expected = q.expected; result.firstMarkdown = first.markdown; result.secondMarkdown = second.markdown; }
      q.results.push(result);
      if (result.pending) throw new Error('formal snapshot left unresolved local input');
      return result;
    `);
    evidence.nodeViews.push(result);
  }
  evidence.fineSourceCases = await operation('production fine source parser cases', `
    const { runFineSourceCases } = await import('/scripts/qa/fine-source-cases.ts');
    q.fineSourceCases = runFineSourceCases(q.editor().state.schema); return q.fineSourceCases;
  `);
  await operation('WYS history input', `
    q.historyBase = (await q.runtime.snapshotDocumentTab(q.tabId, 'save')).markdown;
    q.historyBefore = q.historyBase.indexOf('The source') + 4;
    q.historyAfter = q.historyBefore + 'HISTORY '.length;
    q.sourceAfter = q.historyAfter + 'SOURCE '.length;
    let position = null;
    q.editor().state.doc.descendants((node, pos) => { if (node.isText && node.text.startsWith('The source file must')) position = pos; });
    if (position == null) throw new Error('history target paragraph missing');
    q.editor().view.focus(); q.editor().commands.setTextSelection(position + 4);
    q.selectionTrace.push({ stage: 'before history input', ...q.selectionInfo() });
    q.editor().commands.insertContent('HISTORY ');
    q.selectionTrace.push({ stage: 'after history input', ...q.selectionInfo() });
    q.edited = (await q.runtime.snapshotDocumentTab(q.tabId, 'save')).markdown;
    q.selectionTrace.push({ stage: 'after history snapshot', ...q.selectionInfo() });
    if (q.edited !== q.historyBase.replace('The source', 'The HISTORY source')) throw new Error('WYS history edit changed untouched source');
    return { exact: true };
  `);
  async function mode(mode) {
    await operation(`switch ${mode}`, `q.selectionTrace.push({ stage: ${JSON.stringify(`before switch ${mode}`)}, ...q.selectionInfo() }); await q.store.switchMode(${JSON.stringify(mode)}); q.selectionTrace.push({ stage: ${JSON.stringify(`after switch ${mode}`)}, ...q.selectionInfo() }); return { requested: true, selection: q.selectionInfo() };`);
    await hostWait(`${mode} mounted session`, () => read(`return { ok: q.session()?.mode === ${JSON.stringify(mode)} };`));
  }
  async function replay(label, direction, expectedKey) {
    const result = await operation(label, `
      const modeBefore = q.session().mode;
      const changed = await q.runtime.moveDocumentHistory(q.tabId, ${direction});
      const snapshot = await q.runtime.snapshotDocumentTab(q.tabId, 'save'); q.lastMarkdown = snapshot.markdown;
      const root = q.session().captureHistoryRoot(), bookmark = q.session().captureHistoryBookmark();
      const { historySourceBookmark } = await import('/src/editor/historySource.ts');
      const rawBookmark = await historySourceBookmark({ root, bookmark }, snapshot.markdown);
      const expectedPosition = q[${JSON.stringify(expectedKey === 'historyBase' ? 'historyBefore' : expectedKey === 'sourceEdited' ? 'sourceAfter' : 'historyAfter')}];
      const limit = root.mode === 'source' ? root.doc.length : root.doc.content.size;
      const selectionValid = [bookmark.anchor, bookmark.head].every(position => Number.isInteger(position) && position >= 0 && position <= limit);
      const result = { label: ${JSON.stringify(label)}, changed, exact: snapshot.markdown === q[${JSON.stringify(expectedKey)}], mode: q.session().mode, revision: snapshot.revision,
        bookmark: { anchor: bookmark.anchor, head: bookmark.head }, rawBookmark, expectedPosition,
        selectionValid, bookmarkExact: rawBookmark.anchor === expectedPosition && rawBookmark.head === expectedPosition, modePreserved: modeBefore === q.session().mode };
      q.history.push(result); if (!changed || !result.exact || !selectionValid || !result.modePreserved || !result.bookmarkExact) throw new Error('history replay failed exact source, mode or selection check'); return result;
    `);
    evidence.history.push(result);
  }
  await mode('source');
  await replay('undo WYS in Source', -1, 'historyBase');
  await replay('redo WYS in Source', 1, 'edited');
  await operation('Source local patch', `
    const session = q.session(); const insertion = q.edited.indexOf('HISTORY ') + 'HISTORY '.length;
    const { insertNativeSourceHistoryText } = await import('/scripts/qa/native-source-input.ts');
    insertNativeSourceHistoryText(session, insertion, 'SOURCE ');
    q.sourceEdited = (await q.runtime.snapshotDocumentTab(q.tabId, 'save')).markdown;
    if (q.sourceEdited !== q.edited.replace('HISTORY ', 'HISTORY SOURCE ')) throw new Error('Source local patch changed unrelated content');
    return { exact: true };
  `);
  await mode('wysiwyg');
  await replay('undo Source in WYS', -1, 'edited');
  await replay('redo Source in WYS', 1, 'sourceEdited');
  await replay('undo Source again', -1, 'edited');
  await replay('undo WYS again', -1, 'historyBase');
  let count = 0;
  for (;;) {
    const status = await read('const history = q.runtime.documentHistoryForTab(q.tabId); return { canUndo: history.canUndo, canRedo: history.canRedo };');
    if (!status.canUndo) break;
    if (++count > 100) throw new Error('history did not reach its initial root');
    await operation(`undo local buffer ${count}`, `await q.runtime.moveDocumentHistory(q.tabId, -1); q.lastMarkdown = (await q.runtime.snapshotDocumentTab(q.tabId, 'save')).markdown; return { length: q.lastMarkdown.length };`);
  }
  const final = await operation('restore original bytes and disk unchanged', `
    const final = await q.runtime.snapshotDocumentTab(q.tabId, 'save');
    const disk = await globalThis.__TAURI_INTERNALS__.invoke('read_text_file', { path: q.fixturePath });
    if (final.markdown !== q.original || disk !== q.original) throw new Error('continuous undo or disk bytes differ from original fixture');
    return { sourceBytesRestored: true, diskUnchanged: true, dirty: q.store.getPaneTab('main')?.isDirty, revision: final.revision };
  `);
  evidence.continuousUndo = { count, ...final };
  await read(`
    const history = q.runtime.documentHistoryForTab(q.mainTabId), originalRecord = history.record;
    q.mainHistoryRecordTrace = [];
    history.record = function(root, input) {
      const previous = this.current && this.projection(this.current, root.mode);
      q.mainHistoryRecordTrace.push({ at: Date.now(), activeTabId: q.store.appStore.activeTabId,
        before: previous && { mode: previous.root.mode, doc: previous.root.doc.toJSON?.() ?? previous.root.doc.toString(), baseline: previous.root.baseline?.markdown, exactSource: this.exactSource() },
        next: { mode: root.mode, doc: root.doc.toJSON?.() ?? root.doc.toString(), baseline: root.baseline?.markdown },
        docEqual: previous?.root.mode === root.mode && Boolean(root.doc.eq?.(previous.root.doc)), input,
        stack: new Error('QA main document history.record').stack });
      return originalRecord.call(this, root, input);
    };
    q.mainHistoryBeforeTabs = { selection: q.selectionInfo(), exactSource: history.exactSource(), canUndo: history.canUndo, canRedo: history.canRedo };
    return { instrumented: true };
  `);
  evidence.contentIntegrity = [];
  const fenceBody = '==literal== ^sup^ ~sub~ [^not-a-reference] $x$ **bold**';
  const contentCases = [
    { name: 'format after formula', source: 'Math $x^2$\n', expected: 'Math $x^2$ **bold**\n', insert: ' **bold**' },
    { name: 'code literal during input', source: '`**literal**` tail\n', expected: '`**literal**` tail x\n', insert: ' x' },
    { name: 'rich heading prefix', source: '# **Bold** [link](https://example.com) $x^2$\n', expected: '## **Bold** [link](https://example.com) $x^2$\n' },
    ...['~~~', '````'].map(fence => ({ name: `${fence} fenced literal input`, kind: 'fence', source: `${fence}text\n${fenceBody}\n${fence}\n`, expected: `${fence}text\n${fenceBody.replace('literal', 'liXteral')}\n${fence}\n`, needle: 'literal', caret: 2, insert: 'X', expectedCode: fenceBody.replace('literal', 'liXteral') })),
    { name: 'long inline delimiter input', kind: 'code-span', source: '``outer ` inner`` then tail\n', expected: '``outer ` inXner`` then tail\n', needle: 'inner', caret: 2, insert: 'X', expectedCode: 'outer ` inXner' },
    { name: 'multiline inline code input', kind: 'code-span', source: '`first\nsecond` tail\n', expected: '`firXst\nsecond` tail\n', needle: 'first', caret: 3, insert: 'X', expectedCode: 'firXst second' },
  ];
  for (const [index, item] of contentCases.entries()) {
    const filePath = path.join(path.dirname(context.fixturePath), `native-content-integrity-${index}.md`);
    await operation(`${item.name}: create real fixture`, `
      q.contentPath = ${JSON.stringify(filePath)};
      const receipt = await globalThis.__TAURI_INTERNALS__.invoke('write_text_file', { path: q.contentPath, content: ${JSON.stringify(item.source)}, expectedTargetFingerprint: null });
      if (receipt.outcome !== 'committed' || receipt.diskWritten !== 'yes') throw new Error('content fixture write was not committed');
      await q.store.openFile(q.contentPath, { paneId: 'main', recordNavigation: false });
      const tab = q.store.getPaneTab('main');
      if (tab?.path !== q.contentPath || tab.content !== ${JSON.stringify(item.source)}) throw new Error('content fixture did not open through production path');
      q.tabId = tab.id; await q.store.switchMode('wysiwyg'); return { path: q.contentPath };
    `);
    await hostWait(`${item.name}: mounted real editor`, () => read(`
      const root = q.root(), page = root?.closest('.editor-page');
      const transitioning = page && [...page.classList].some(name => /-(enter|leave)-(active|from|to)$/.test(name));
      return { ok: Boolean(root) && !transitioning };
    `));
    const result = await operation(`${item.name}: formal save and structure`, `
      const editor = q.editor();
      try {
      if (${index} === 2) {
        const { exposeHeadingMarkdown } = await import('/src/editor/wysiwygMarkdownEditing.ts');
        const expose = exposeHeadingMarkdown(editor.state, 0, 1);
        if (!expose) throw new Error('production heading syntax could not be exposed');
        editor.view.dispatch(expose);
        editor.view.dispatch(editor.state.tr.insertText('#', 1));
      } else {
        let position = editor.state.doc.firstChild.nodeSize - 1;
        if (${JSON.stringify(item.kind ?? '')} === 'fence') {
          const offset = editor.state.doc.firstChild.textContent.indexOf(${JSON.stringify(item.needle ?? '')});
          if (offset < 0) throw new Error('literal code fixture did not render its original text');
          position = 1 + offset + ${item.caret ?? 0};
        } else if (${JSON.stringify(item.kind ?? '')} === 'code-span') {
          position = null;
          editor.state.doc.descendants((node, pos) => {
            if (position == null && node.isText && node.marks.some(mark => mark.type.name === 'code') && node.text.includes(${JSON.stringify(item.needle ?? '')})) position = pos + node.text.indexOf(${JSON.stringify(item.needle ?? '')}) + ${item.caret ?? 0};
          });
          if (position == null) throw new Error('inline code literal did not render as a protected code mark');
        }
        editor.chain().focus().setTextSelection(position).insertContent(${JSON.stringify(item.insert ?? '')}).run();
      }
      const contentHistory = q.runtime.documentHistoryForTab(q.tabId);
      const beforeSnapshotProjection = contentHistory.projection(contentHistory.current, 'wysiwyg');
      let fenceDiagnostic;
      if (${JSON.stringify(item.kind ?? '')} === 'fence') {
        const baseline = beforeSnapshotProjection.root.baseline, before = baseline?.nodes[0], after = beforeSnapshotProjection.root.doc.firstChild;
        const source = baseline?.blocks[0]?.source ?? ${JSON.stringify(item.source)};
        fenceDiagnostic = { measuredBeforeFormalSnapshot: true, baseline: { markdown: baseline?.markdown, aligned: baseline?.aligned, source, firstNode: before?.toJSON(), nodeCount: baseline?.nodes.length, blocks: baseline?.blocks }, liveCanonical: after?.toJSON(), liveNodeCount: beforeSnapshotProjection.root.doc.childCount, liveDocument: beforeSnapshotProjection.root.doc.toJSON() };
        try { const { preserveChangedBlock } = await import('/src/editor/fineSourcePreservation.ts'); fenceDiagnostic.directPreserved = preserveChangedBlock(source, before, after); } catch (error) { fenceDiagnostic.preserveError = String(error?.stack || error); }
        try { const { serializePreservedDocument } = await import('/src/editor/wysiwygCodec.ts'); fenceDiagnostic.directDocument = serializePreservedDocument(beforeSnapshotProjection.root.doc, baseline); } catch (error) { fenceDiagnostic.documentError = String(error?.stack || error); }
        try { const { createMarkdownPositionMap } = await import('/src/editor/markdownPositionMap.ts'); fenceDiagnostic.positionMap = createMarkdownPositionMap(source, before.type.schema.nodes.doc.create(null, before)); } catch (error) { fenceDiagnostic.positionMapError = String(error?.stack || error); }
      }
      const snapshot = await q.runtime.snapshotDocumentTab(q.tabId, 'save'); q.lastMarkdown = snapshot.markdown;
      const math = [], bold = [], links = [], code = [];
      editor.state.doc.descendants(node => {
        if (node.type.name === 'inlineMath') math.push(node.attrs.tex);
        if (node.isText) for (const mark of node.marks) {
          if (mark.type.name === 'bold') bold.push(node.text);
          if (mark.type.name === 'link') links.push(mark.attrs.href);
          if (mark.type.name === 'code') code.push(node.text);
        }
      });
      const structure = ${JSON.stringify(item.kind ?? '')} === 'fence' ? editor.state.doc.firstChild.type.name === 'codeBlock' && editor.state.doc.firstChild.textContent.includes(${JSON.stringify(item.expectedCode ?? '')}) && math.length === 0 && bold.length === 0
        : ${JSON.stringify(item.kind ?? '')} === 'code-span' ? code.includes(${JSON.stringify(item.expectedCode ?? '')}) && math.length === 0 && bold.length === 0
        : ${index} === 0 ? math.includes('x^2') && bold.includes('bold')
        : ${index} === 1 ? code.includes('**literal**') && !bold.includes('literal')
        : editor.state.doc.firstChild.attrs.level === 2 && math.includes('x^2') && bold.includes('Bold') && links.includes('https://example.com');
      const snapshotExact = snapshot.markdown === ${JSON.stringify(item.expected)};
      // Let Vue's already queued render flush before observing the real tab.
      await Promise.resolve();
      const renderedTab = () => [...document.querySelectorAll('.document-tabs button[title]')].find(button => button.title === q.contentPath);
      const dirtyBeforeSave = Boolean(renderedTab()?.querySelector('[aria-label="未保存"]'));
      const saved = snapshotExact && structure ? await q.store.saveCurrentFile() : false;
      await Promise.resolve();
      const tabAfterSave = renderedTab();
      const savedTabRenderedClean = Boolean(tabAfterSave) && dirtyBeforeSave && !tabAfterSave.querySelector('[aria-label="未保存"]');
      const disk = await globalThis.__TAURI_INTERNALS__.invoke('read_text_file', { path: q.contentPath });
      const result = { name: ${JSON.stringify(item.name)}, sourcePath: q.contentPath, formalSnapshotExact: snapshotExact, nodeStructurePreserved: structure, savedDiskExact: saved && disk === ${JSON.stringify(item.expected)}, savedTabRenderedClean, dirtyBeforeSave };
      if (!result.formalSnapshotExact || !result.nodeStructurePreserved || !result.savedDiskExact) Object.assign(result, { actual: snapshot.markdown, expected: ${JSON.stringify(item.expected)}, disk, saved, math, bold, links, code });
      if (fenceDiagnostic) result.fenceDiagnostic = fenceDiagnostic;
      return result;
      } catch (error) {
        return { name: ${JSON.stringify(item.name)}, sourcePath: q.contentPath, formalSnapshotExact: false, nodeStructurePreserved: false, savedDiskExact: false,
          error: String(error?.stack || error), document: editor?.state.doc.toJSON() };
      }
    `);
    evidence.contentIntegrity.push(result);
  }
  await operation('return to original document tab', `
    await q.store.activateTab(q.mainTabId); q.tabId = q.mainTabId;
    return { tabId: q.tabId };
  `);
  await hostWait('original document remounted', () => read(`
    const root = q.root(), page = root?.closest('.editor-page');
    const transitioning = page && [...page.classList].some(name => /-(enter|leave)-(active|from|to)$/.test(name));
    return { ok: Boolean(root) && !transitioning && q.store.getPaneTab('main')?.id === q.mainTabId };
  `));
  await operation('snapshot original document after remount', `
    q.lastMarkdown = (await q.runtime.snapshotDocumentTab(q.mainTabId, 'save')).markdown;
    return { length: q.lastMarkdown.length };
  `);
  const acrossTabs = { redo: 0, undo: 0 };
  await read('q.crossTabTrace = []; return { ready: true };');
  try {
  for (const [direction, field, can] of [[1, 'redo', 'canRedo'], [-1, 'undo', 'canUndo']]) {
    for (;;) {
      const status = await read(`const history = q.runtime.documentHistoryForTab(q.tabId); const state = { stage: ${JSON.stringify(field)}, available: history.${can}, selection: q.selectionInfo(), latestSource: history.exactSource(), tabContent: q.store.getPaneTab('main')?.content }; q.crossTabTrace.push(state); return state;`);
      if (!status.available) break;
      if (++acrossTabs[field] > 100) throw new Error('cross-tab history did not reach its boundary');
      await operation(`cross-tab ${field} ${acrossTabs[field]}`, `
        await q.runtime.moveDocumentHistory(q.tabId, ${direction});
        q.lastMarkdown = (await q.runtime.snapshotDocumentTab(q.tabId, 'save')).markdown; return { length: q.lastMarkdown.length };
      `);
    }
    await read(`const actual = q.lastMarkdown, expected = q[${JSON.stringify(direction === 1 ? 'sourceEdited' : 'original')}]; if (actual !== expected) throw new Error('cross-tab history changed its content boundary: ' + JSON.stringify({ actual, expected, trace: q.crossTabTrace, canUndo: q.runtime.documentHistoryForTab(q.tabId).canUndo, canRedo: q.runtime.documentHistoryForTab(q.tabId).canRedo, live: q.selectionInfo() })); return { exact: true };`);
  }
  if (acrossTabs.redo === 0 || acrossTabs.undo !== acrossTabs.redo) throw new Error('switching tabs lost the original document history');
  evidence.acrossTabs = { ...acrossTabs, originalBytesRestored: true };
  } catch (error) {
    evidence.acrossTabs = { ...acrossTabs, originalBytesRestored: false, error: String(error) };
  }
  evidence.mainHistoryRecordTrace = await read('return { before: q.mainHistoryBeforeTabs, records: q.mainHistoryRecordTrace, trace: q.crossTabTrace, current: q.selectionInfo(), liveDocument: q.editor()?.state.doc.toJSON() };');
  try {
    evidence.sourceProvenanceCases = await operation('production source provenance cases', `
      const { runSourceProvenanceCases } = await import('/scripts/qa/native-source-provenance-cases.ts');
      q.sourceProvenanceCases = await runSourceProvenanceCases(q); return q.sourceProvenanceCases;
    `, 60000);
  } catch (error) {
    evidence.sourceProvenanceCases = { ...await read('return q.sourceProvenanceCases ?? {};'), status: 'failed', error: String(error) };
  }
  try {
  evidence.pendingCommands = await operation('owned asynchronous command cases', `
    const { runPendingCommandCases } = await import('/scripts/qa/native-pending-command-cases.ts');
    q.pendingCommands = await runPendingCommandCases(q); return q.pendingCommands;
  `, 60000);
  } catch (error) {
    evidence.pendingCommands = { ...await read('return q.pendingCommands ?? {};'), status: 'failed', error: String(error) };
  }
  try {
    evidence.nodeViewSaves = await operation('owned NodeView twice disk saves', `
      const { runNodeViewSaveCases } = await import('/scripts/qa/native-nodeview-save-cases.ts');
      q.nodeViewSaves = await runNodeViewSaveCases(q); return q.nodeViewSaves;
    `, 120000);
  } catch (error) {
    evidence.nodeViewSaves = { ...await read('return q.nodeViewSaves ?? {};'), status: 'failed', error: String(error) };
  }
  try {
    await read('q.contrastOriginalTheme = q.store.appStore.theme; return { captured: true };');
    evidence.visibleTextContrast = {};
    try {
      for (const mode of ['light', 'dark']) {
        await operation(`contrast theme ${mode}`, `await q.store.setTheme(${JSON.stringify(mode)}); return { changed: true };`);
        await hostWait(`${mode} page and theme transitions settled`, () => read(`
          const pages = [...document.querySelectorAll('.editor-page')];
          const pageTransition = pages.some(page => [...page.classList].some(name => /-(enter|leave)-(active|from|to)$/.test(name)));
          const running = document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
          return { ok: pages.length === 1 && !pageTransition && running.length === 0, pages: pages.length, finiteAnimations: running.length };
        `));
        evidence.visibleTextContrast[mode] = await operation(`sample ${mode} visible text contrast`, `
          const { inspectVisibleTextContrast } = await import('/scripts/qa/visible-text-contrast.ts');
          return inspectVisibleTextContrast();
        `);
      }
    } finally { await operation('restore contrast theme', 'await q.store.setTheme(q.contrastOriginalTheme); return { restored: true };'); }
  } catch (error) { evidence.visibleTextContrast = { error: String(error) }; }
  evidence.finalState = await read('return q.snapshot();');
  evidence.fineSourceFailures = (evidence.fineSourceCases ?? []).filter(item => !item.passed);
  evidence.nodeViewFailures = evidence.nodeViews.filter(item => !item.firstExact || !item.secondExact || item.pending || !item.dirty || item.kind !== 'toc' && (!item.focused || item.blurs !== 0));
  evidence.contentIntegrityFailures = evidence.contentIntegrity.filter(item => !item.formalSnapshotExact || !item.nodeStructurePreserved || !item.savedDiskExact || !item.savedTabRenderedClean);
  const pendingCommandsPassed = evidence.pendingCommands?.status === 'passed' && Array.isArray(evidence.pendingCommands.cases)
    && evidence.pendingCommands.cases.length >= 5 && evidence.pendingCommands.cases.every(item => item.passed === true);
  const sourceProvenancePassed = evidence.sourceProvenanceCases?.status === 'passed' && Array.isArray(evidence.sourceProvenanceCases.cases)
    && evidence.sourceProvenanceCases.cases.length >= 7 && evidence.sourceProvenanceCases.cases.every(item => item.passed === true);
  const nodeViewSavesPassed = evidence.nodeViewSaves?.status === 'passed' && Array.isArray(evidence.nodeViewSaves.cases)
    && evidence.nodeViewSaves.cases.length === 7 && evidence.nodeViewSaves.cases.every(item => item.passed === true && item.saves?.length === 2
      && item.saves.every(save => save.saved && save.diskExact && save.pendingCleared && save.renderedClean && save.focusPreserved && save.sameControl && save.selectionPreserved));
  evidence.status = evidence.fineSourceFailures.length || evidence.nodeViewFailures.length || evidence.contentIntegrityFailures.length || evidence.acrossTabs.error || !pendingCommandsPassed || !sourceProvenancePassed || !nodeViewSavesPassed ? 'failed' : 'passed';
  evidence.nativeKeyboardOrIMEClaimed = false;
  evidence.cleanupMethod = 'owned-window-destroy-after-host-probe';
  await read(`q.cleanupTimer = setTimeout(() => { void globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }); }, 100); return { scheduled: true };`);
  return evidence;
}
