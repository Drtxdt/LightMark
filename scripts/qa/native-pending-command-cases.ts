import { beginPendingAssetCommand, beginPendingImageCommand, captureDocumentCommandTarget, documentSessionForTab, snapshotDocumentTab } from '../../src/editor/documentRuntime';
import { pendingCommand, releasePendingCommand } from '../../src/editor/pendingDocumentCommands';
import { extractAssetReferences } from '../../src/utils/documentAssets';
import { dirname, join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { watch } from 'vue';

/** Native-only integration: real mounted adapters, appStore commands, history and disk saves. */
export async function runPendingCommandCases(q: any) {
  const results: Array<Record<string, unknown>> = [];
  q.pendingCommands = { status: 'running', cases: results };
  const directory = await dirname(q.fixturePath);
  const settings = Object.freeze({ ...q.store.appStore.settings.image });
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = async (check: () => boolean) => {
    const until = performance.now() + 8000;
    while (!check()) { if (performance.now() > until) throw new Error('Pending command native editor mount timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
    await nextFrame();
  };
  const open = async (name: string, source: string) => {
    const path = await join(directory, `native-pending-${name}.md`);
    const receipt = await invoke<any>('write_text_file', { path, content: source, expectedTargetFingerprint: null });
    if (receipt.outcome !== 'committed') throw new Error('Pending fixture write failed');
    await q.store.openFile(path, { paneId: 'main', recordNavigation: false });
    const tab = q.store.getPaneTab('main'); q.tabId = tab.id;
    await q.store.switchMode('wysiwyg');
    await wait(() => Boolean(q.editor()?.view.dom.isConnected));
    return tab;
  };
  const exact = (actual: string, expected: string, name: string) => {
    if (actual !== expected) throw new Error(`${name}: ${JSON.stringify({ actual, expected })}`);
  };
  const save = async (expected: string) => {
    const tab = q.store.getPaneTab('main'), alerts: string[] = [];
    const stop = watch(() => tab.externalState, state => { if (state !== 'clean') alerts.push(String(state)); }, { flush: 'sync' });
    try {
      await q.store.saveCurrentFile();
      exact(await invoke<string>('read_text_file', { path: tab.path }), expected, 'formal saved bytes');
      await q.store.checkOpenFileSnapshots();
      await new Promise(resolve => setTimeout(resolve, 250));
      if (alerts.length || tab.externalState !== 'clean') throw new Error(`Own save was reported as external: ${JSON.stringify({ alerts, state: tab.externalState, baseline: tab.fileSnapshot, external: tab.externalSnapshot })}`);
    } finally { stop(); }
  };
  const chosen = await join(directory, 'chosen image.png');
  const source = 'before  [first](same.png "first title") and [second](same.png "second title")\r\n\r\nTAIL\r\n';
  const first = await open('relink', source);
  const target = await captureDocumentCommandTarget(first.id, 'externalDiff');
  const second = extractAssetReferences(target.markdown)[1];
  const relink = beginPendingAssetCommand(target, { ...second, expected: second.source, insert: '' });
  try {
    q.editor().view.dispatch(q.editor().state.tr.insertText('NEW ', 1));
    q.editor().view.dispatch(q.editor().state.tr.insertText(' AFTER', q.editor().state.doc.firstChild.nodeSize - 1));
    const current = (await snapshotDocumentTab(first.id, 'save'))!.markdown;
    const reference = extractAssetReferences(current)[1];
    const nextSource = await invoke<string>('asset_path_to_reference', { markdownPath: first.path, path: chosen,
      useRelativePath: settings.useRelativePath, ensureDotSlash: settings.ensureDotSlash, escapePath: settings.escapePath });
    await q.store.completePendingAssetRelink(relink, chosen, settings);
    const expected = current.slice(0, reference.from) + nextSource + current.slice(reference.to);
    exact((await snapshotDocumentTab(first.id, 'save'))!.markdown, expected, 'mapped duplicate link relink preserves title and CRLF');
    await save(expected);
    results.push({ name: 'relink while typing preserves duplicate URI/title/raw bytes', passed: true });
  } catch (error) { results.push({ name: 'relink while typing preserves duplicate URI/title/raw bytes', passed: false, error: String(error instanceof Error ? error.stack : error) }); }
  finally { releasePendingCommand(relink); }

  const imageTab = await open('inactive-image', 'IMAGE before\r\n\r\nTAIL\r\n');
  const position = q.editor().state.doc.firstChild.nodeSize - 1;
  const image = beginPendingImageCommand(imageTab.id, position, position);
  const imageTarget = { markdownPath: imageTab.path, documentMode: 'normal', settings };
  try {
    q.editor().view.dispatch(q.editor().state.tr.insertText('NEW ', 1));
    await q.store.activateTab(first.id);
    await wait(() => !documentSessionForTab(imageTab.id));
    const otherBefore = (await snapshotDocumentTab(first.id, 'save'))!.markdown;
    await q.store.completePendingImageCommand(image, '![x](assets/x.png)', imageTarget);
    const expected = 'NEW IMAGE before\r\n\r\n![x](assets/x.png)\r\n\r\nTAIL\r\n';
    exact(imageTab.content, expected, 'inactive original image insertion');
    exact((await snapshotDocumentTab(first.id, 'save'))!.markdown, otherBefore, 'new active tab remains unchanged');
    await q.store.activateTab(imageTab.id); q.tabId = imageTab.id;
    await wait(() => Boolean(q.editor()?.view.dom.isConnected));
    await save(expected);
    await q.runtime.moveDocumentHistory(imageTab.id, -1);
    exact((await snapshotDocumentTab(imageTab.id, 'save'))!.markdown, 'NEW IMAGE before\r\n\r\nTAIL\r\n', 'inactive insertion undo retains recent typing');
    await q.runtime.moveDocumentHistory(imageTab.id, 1);
    exact((await snapshotDocumentTab(imageTab.id, 'save'))!.markdown, expected, 'inactive insertion redo');
    results.push({ name: 'image original tab survives unmount, save and undo/redo', passed: true });
  } catch (error) { results.push({ name: 'image original tab survives unmount, save and undo/redo', passed: false, error: String(error instanceof Error ? error.stack : error) }); }
  finally { releasePendingCommand(image); }

  const modeTab = await open('mode-image', 'before\r\n\r\nTAIL\r\n');
  const caret = q.editor().state.doc.firstChild.nodeSize - 1;
  const modeImage = beginPendingImageCommand(modeTab.id, caret, caret);
  try {
    await q.store.switchMode('source');
    await wait(() => documentSessionForTab(modeTab.id)?.mode === 'source');
    const sourceSession = documentSessionForTab(modeTab.id)!;
    await sourceSession.applySourcePatch!({ from: 0, to: 0, expected: '', insert: 'SOURCE ' }, sourceSession.revision);
    await q.store.completePendingImageCommand(modeImage, '![x](assets/x.png)', { markdownPath: modeTab.path, documentMode: 'normal', settings });
    const expected = 'SOURCE before\r\n\r\n![x](assets/x.png)\r\n\r\nTAIL\r\n';
    exact((await snapshotDocumentTab(modeTab.id, 'save'))!.markdown, expected, 'cross-mode mapped image insertion');
    await save(expected);
    results.push({ name: 'WYS image bookmark survives Source remount and later input', passed: true });
  } catch (error) { results.push({ name: 'WYS image bookmark survives Source remount and later input', passed: false, error: String(error instanceof Error ? error.stack : error) }); }
  finally { releasePendingCommand(modeImage); }

  const deletedTab = await open('deleted-reference', '[one](same.png) and [two](same.png)\r\n');
  const deleteTarget = await captureDocumentCommandTarget(deletedTab.id, 'externalDiff');
  const deletedRef = extractAssetReferences(deleteTarget.markdown)[1];
  const deleted = beginPendingAssetCommand(deleteTarget, { ...deletedRef, expected: deletedRef.source, insert: '' });
  try {
    const anchor = pendingCommand(deleted).native!.anchor!, editor = q.editor();
    const fragment = editor.state.doc.slice(anchor.from, anchor.to).content;
    editor.view.dispatch(editor.state.tr.delete(anchor.from, anchor.to).insert(anchor.from, fragment));
    const current = (await snapshotDocumentTab(deletedTab.id, 'save'))!.markdown;
    let rejected = false;
    try { await q.store.completePendingAssetRelink(deleted, chosen, settings); } catch { rejected = true; }
    if (!rejected) throw new Error('Deleted reference retargeted an identical replacement');
    exact((await snapshotDocumentTab(deletedTab.id, 'save'))!.markdown, current, 'deleted command leaves new identical input intact');
    results.push({ name: 'deleted link cannot retarget identical reinsertion', passed: true });
  } catch (error) { results.push({ name: 'deleted link cannot retarget identical reinsertion', passed: false, error: String(error instanceof Error ? error.stack : error) }); }
  finally { releasePendingCommand(deleted); }

  const mountedTab = await open('mounted-rich-image', '__word__   [link](same.png "keep title")\r\n');
  let word = -1;
  q.editor().state.doc.descendants((node: any, pos: number) => { if (node.isText && node.text.includes('word')) word = pos + node.text.indexOf('word') + 2; });
  const mounted = beginPendingImageCommand(mountedTab.id, word, word);
  try {
    await q.store.completePendingImageCommand(mounted, '![x](assets/x.png)', { markdownPath: mountedTab.path, documentMode: 'normal', settings });
    const expected = '__wo__\r\n\r\n![x](assets/x.png)\r\n\r\n__rd__   [link](same.png "keep title")\r\n';
    exact((await snapshotDocumentTab(mountedTab.id, 'save'))!.markdown, expected, 'mounted WYS local image preserves untouched rich source');
    await save(expected);
    await q.runtime.moveDocumentHistory(mountedTab.id, -1);
    exact((await snapshotDocumentTab(mountedTab.id, 'save'))!.markdown, '__word__   [link](same.png "keep title")\r\n', 'mounted image insertion is one undoable source-preserving command');
    results.push({ name: 'mounted rich WYS image has a staged-model proof and exact raw checkpoint', passed: true });
  } catch (error) { results.push({ name: 'mounted rich WYS image has a staged-model proof and exact raw checkpoint', passed: false, error: String(error instanceof Error ? error.stack : error) }); }
  finally { releasePendingCommand(mounted); }
  await q.store.activateTab(q.mainTabId); q.tabId = q.mainTabId;
  await wait(() => Boolean(q.editor()?.view.dom.isConnected));
  q.pendingCommands = { status: results.every(result => result.passed) ? 'passed' : 'failed', cases: results };
  return q.pendingCommands;
}
