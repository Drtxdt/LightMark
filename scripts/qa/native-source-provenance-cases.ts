import { snapshotDocumentTab, documentHistoryForTab, documentSessionForTab } from '../../src/editor/documentRuntime';
import { invoke } from '@tauri-apps/api/core';
import { dirname, join } from '@tauri-apps/api/path';
import { formatMarkdown } from '../../src/utils/markdownFormat';
import { historySourceBookmark } from '../../src/editor/historySource';
import { insertNativeSourceHistoryText } from './native-source-input';

/** Real WYS updates, not just a serializer invoked on a handcrafted final model. */
export async function runSourceProvenanceCases(q: any) {
  const results: Array<Record<string, unknown>> = [];
  const directory = await dirname(q.fixturePath);
  const cases = [
    { name: 'distant rich text keys', source: '__alpha__   [link](same.png "keep title")   omega\r\n', expected: '__alXpha__   [link](same.png "keep title")   omeYga\r\n', kind: 'two-keys' },
    { name: 'multi-step rich command', source: '__alpha__   [link](same.png "keep title")   omega\r\n', expected: '__alXpha__   [link](same.png "keep title")   omeYga\r\n', kind: 'one-command' },
    { name: 'rich formula local value', source: '__bold__   $x$   [link](same.png "keep title")\r\n', expected: '__bold__   $x^2$   [link](same.png "keep title")\r\n', kind: 'math' },
    { name: 'explicit formatter raw checkpoint', source: '__word__   [link](same.png "keep title")\n\n\n\nTAIL\n', expected: '__word__   [link](same.png "keep title")\n\n\nTAIL\n', kind: 'format' },
    { name: 'new format keeps existing rich syntax', source: 'before __keep__   [link](same.png "keep title")\r\n', expected: 'before __keep__   [link](same.png "keep title") **bold**\r\n', kind: 'inline-format' },
    { name: 'ordinary Source to WYS caret and focus after heading revelation', source: '# Heading\n\nChinese 你好 tail\n', expected: '# Heading\n\nChinese 你好新增 tail\n', kind: 'mode-caret' },
    { name: 'table edit retains adjacent HTML comment source boundary', source: '| a | b |\n| --- | --- |\n| x | y |\n<!-- after-table -->', expected: '| a | b |\n| --- | --- |\n| xQ | y |\n<!-- after-table -->', kind: 'table-comment' },
    ...['\n', '\r\n'].map(eol => ({ name: `100 Enter paragraphs ${eol === '\n' ? 'LF' : 'CRLF'} mode and history`, source: `first${eol}${eol}last`, expected: eol.repeat(200) + `first${eol}${eol}last`, kind: 'empty-paragraphs' })),
    ...['\uFEFF', '\uFEFF\r\n\r\n', '\uFEFF \t\n\r\n\r'].map((source, index) => ({ name: `BOM whitespace edit ${index}`, source, expected: '\uFEFFtyped' + source.slice(1), kind: 'bom-whitespace' })),
  ];
  q.sourceProvenanceCases = { status: 'running', cases: results };
  for (const [index, item] of cases.entries()) {
    try {
      const path = await join(directory, `native-source-provenance-${index}.md`);
      const receipt = await invoke<any>('write_text_file', { path, content: item.source, expectedTargetFingerprint: null });
      if (receipt.outcome !== 'committed') throw new Error('Provenance fixture write failed');
      await q.store.openFile(path, { paneId: 'main', recordNavigation: false });
      q.tabId = q.store.getPaneTab('main').id;
      await q.store.switchMode('wysiwyg');
      const until = performance.now() + 8000;
      while (!q.editor()?.view?.dom?.isConnected) { if (performance.now() > until) throw new Error('No mounted WYS'); await new Promise(resolve => setTimeout(resolve, 25)); }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const editor = q.editor();
      let caretEvidence: Record<string, unknown> | undefined;
      if (item.kind === 'empty-paragraphs') {
        editor.commands.setTextSelection(1);
        for (let count = 0; count < 100; count++) if (!editor.commands.splitBlock()) throw new Error(`Real splitBlock ${count} failed`);
        if (editor.state.doc.childCount !== 102) throw new Error('100 Enter paragraphs did not reach the real mounted PM document');
      } else if (item.kind === 'bom-whitespace') {
        editor.view.dispatch(editor.state.tr.insertText('typed', 1));
      } else if (item.kind === 'mode-caret') {
        await q.store.switchMode('source');
        const session = documentSessionForTab(q.tabId)!;
        const caret = item.source.indexOf(' tail');
        insertNativeSourceHistoryText(session, caret, '新增');
        await q.store.switchMode('wysiwyg');
        const deadline = performance.now() + 8000;
        for (;;) {
          const live = documentSessionForTab(q.tabId), root = q.editor()?.view?.dom;
          if (live?.mode === 'wysiwyg' && root?.isConnected && root.contains(document.activeElement)) {
            const bookmark = await historySourceBookmark({ root: live.captureHistoryRoot!(), bookmark: live.captureHistoryBookmark!() }, item.expected);
            if (bookmark.anchor === caret + 2 && bookmark.head === caret + 2) {
              caretEvidence = { rawBookmark: bookmark, focused: true, expectedPosition: caret + 2, compositionUsed: false };
              break;
            }
          }
          if (performance.now() > deadline) throw new Error('Source→WYS did not restore exact ordinary-input caret and editor focus');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } else if (item.kind === 'table-comment') {
        let position = -1;
        editor.state.doc.descendants((node: any, pos: number) => { if (node.isText && node.text === 'x') position = pos + 1; });
        if (position < 0) throw new Error('Table cell x missing');
        editor.view.dispatch(editor.state.tr.insertText('Q', position));
      } else if (item.kind === 'format') {
        const result = formatMarkdown(item.source);
        if (result.text !== item.expected) throw new Error('Formatter fixture expected text is stale');
        const detail = { paneId: 'main', source: item.source, result, handled: false };
        window.dispatchEvent(new CustomEvent('lightmark:apply-markdown-format', { detail }));
        if (!detail.handled) throw new Error('Production formatter handler did not run');
      } else if (item.kind === 'inline-format') {
        // Appending after a link must leave that link before typing new syntax.
        editor.view.dispatch(editor.state.tr.setStoredMarks([]).insertText(' **bold**', editor.state.doc.firstChild.nodeSize - 1));
      } else if (item.kind === 'math') {
        let mathPos = -1;
        editor.state.doc.descendants((node: any, pos: number) => { if (node.type.name === 'inlineMath') mathPos = pos; });
        if (mathPos < 0) throw new Error('Formula missing');
        const node = editor.state.doc.nodeAt(mathPos);
        editor.view.dispatch(editor.state.tr.setNodeMarkup(mathPos, undefined, { ...node.attrs, tex: 'x^2', raw: '', editing: false }));
      } else {
        const locate = (word: string, offset: number) => {
          let position = -1;
          editor.state.doc.descendants((node: any, pos: number) => { if (node.isText && node.text.includes(word)) position = pos + node.text.indexOf(word) + offset; });
          if (position < 0) throw new Error(`Word ${word} missing`);
          return position;
        };
        const alpha = locate('alpha', 2), omega = locate('omega', 3);
        if (item.kind === 'two-keys') {
          editor.view.dispatch(editor.state.tr.insertText('X', alpha));
          editor.view.dispatch(editor.state.tr.insertText('Y', locate('omega', 3)));
        } else editor.view.dispatch(editor.state.tr.insertText('Y', omega).insertText('X', alpha));
      }
      const snapshot = await snapshotDocumentTab(q.tabId, 'save');
      if (snapshot!.markdown !== item.expected) throw new Error(JSON.stringify({ actual: snapshot!.markdown, expected: item.expected }));
      await q.store.saveCurrentFile();
      if (await invoke<string>('read_text_file', { path }) !== item.expected) throw new Error('Saved bytes differ');
      const history = documentHistoryForTab(q.tabId);
      if (!history.canUndo || documentSessionForTab(q.tabId)?.mode !== 'wysiwyg') throw new Error('Command/history ownership lost');
      if (item.kind === 'empty-paragraphs' || item.kind === 'bom-whitespace') {
        for (const mode of ['source', 'wysiwyg']) {
          await q.store.switchMode(mode);
          if ((await snapshotDocumentTab(q.tabId, 'save'))!.markdown !== item.expected) throw new Error(`${mode} roundtrip changed exact bytes`);
        }
        let undoCount = 0;
        while (history.canUndo) {
          if (++undoCount > 110) throw new Error('Empty paragraph history did not reach its initial boundary');
          await q.runtime.moveDocumentHistory(q.tabId, -1);
        }
        if ((await snapshotDocumentTab(q.tabId, 'save'))!.markdown !== item.source) throw new Error('Undo changed initial BOM/empty paragraph source');
        let redoCount = 0;
        while (history.canRedo) {
          if (++redoCount > 110) throw new Error('Empty paragraph redo did not reach its final boundary');
          await q.runtime.moveDocumentHistory(q.tabId, 1);
        }
        if (redoCount !== undoCount || (await snapshotDocumentTab(q.tabId, 'save'))!.markdown !== item.expected) throw new Error('Redo changed BOM/empty paragraph bytes');
      }
      // A formatter checkpoint must remain authoritative after later edits and replay.
      if (item.kind === 'format') {
        const current = q.editor();
        current.view.dispatch(current.state.tr.insertText('X', current.state.doc.content.size - 1));
        const afterEdit = item.expected.replace('TAIL', 'TAILX');
        if ((await snapshotDocumentTab(q.tabId, 'save'))!.markdown !== afterEdit) throw new Error('Later edit resurrected pre-format raw spelling');
        await q.runtime.moveDocumentHistory(q.tabId, -1);
        if ((await snapshotDocumentTab(q.tabId, 'save'))!.markdown !== item.expected) throw new Error('Undo lost formatter raw checkpoint');
        await q.runtime.moveDocumentHistory(q.tabId, 1);
        if ((await snapshotDocumentTab(q.tabId, 'save'))!.markdown !== afterEdit) throw new Error('Redo lost formatter raw checkpoint');
      }
      results.push({ name: item.name, passed: true, formalSnapshot: true, diskSave: true, ...(caretEvidence ? { caretEvidence } : {}) });
    } catch (error) { results.push({ name: item.name, passed: false, error: String(error instanceof Error ? error.stack : error) }); }
  }
  await q.store.activateTab(q.mainTabId); q.tabId = q.mainTabId;
  const deadline = performance.now() + 8000;
  while (!q.editor()?.view?.dom?.isConnected) { if (performance.now() > deadline) throw new Error('Original WYS did not remount after provenance cases'); await new Promise(resolve => setTimeout(resolve, 25)); }
  q.sourceProvenanceCases = { status: results.every(result => result.passed) ? 'passed' : 'failed', cases: results };
  return q.sourceProvenanceCases;
}
