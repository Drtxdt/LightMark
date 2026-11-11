import { invoke } from '@tauri-apps/api/core';
import { dirname, join } from '@tauri-apps/api/path';
import { nextTick } from 'vue';
import { documentSessionForTab } from '../../src/editor/documentRuntime';
import { getContentEditableCaret, setContentEditableCaret } from '../../src/extensions/LatexSuggest';

/** Unblurred controls save through the real app command and real file IO twice. */
export async function runNodeViewSaveCases(q: any) {
  const results: any[] = [];
  q.nodeViewSaves = { status: 'running', cases: results };
  const directory = await dirname(q.fixturePath);
  const cases = [
    { kind: 'frontmatter', source: '---\ntitle: accepted\n---\n\nTail\n', node: '.front-matter-node', control: '.front-matter-editor', event: 'mousedown', original: 'title: accepted', values: ['title: first 中文', 'title: second 中文'] },
    { kind: 'html', source: '<div>accepted</div>\n\nTail\n', node: '.html-block-node', control: '.html-block-editor', event: 'mousedown', original: '<div>accepted</div>', values: ['<div>first 中文</div>', '<div>second 中文</div>'] },
    { kind: 'footnote', source: 'Body[^qa].\n\n[^qa]: accepted\n', node: '.footnotes', control: '.footnotes-editor', event: 'click', original: '[^qa]: accepted', values: ['[^qa]: first 中文', '[^qa]: second 中文'] },
    { kind: 'math', source: 'Value $x$ tail\n', node: '.math-node-inline', control: '.math-inline-source-editor', event: 'mousedown', original: '$x$', values: ['x+1', 'x+2'] },
    { kind: 'mermaid', source: '```mermaid\ngraph TD\nA-->B\n```\n\nTail\n', node: '.mermaid-node', control: '.mermaid-source-editor', original: 'graph TD\nA-->B', values: ['graph TD\nA-->C', 'graph TD\nA-->D'] },
    { kind: 'toc-valid', source: '[TOC]\n\n# Heading\n', node: '.toc-node', control: '.toc-node-editor', event: 'mousedown', original: '[TOC]', values: ['[toc]', ' [TOC] '] },
    { kind: 'toc-to-paragraph', source: '[TOC]\n\n# Heading\n', node: '.toc-node', control: '.toc-node-editor', event: 'mousedown', original: '[TOC]', values: ['first toc replacement', 'first toc replacement second'] },
  ];
  const wait = async (label: string, predicate: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`NodeView save timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    for (const item of cases) {
      const saves: any[] = [];
      try {
        const path = await join(directory, `native-nodeview-save-${item.kind}.md`);
        const receipt = await invoke<any>('write_text_file', { path, content: item.source, expectedTargetFingerprint: null });
        if (receipt.outcome !== 'committed') throw new Error('Owned NodeView fixture creation failed');
        await q.store.openFile(path, { paneId: 'main', recordNavigation: false });
        q.tabId = q.store.getPaneTab('main').id;
        await q.store.switchMode('wysiwyg');
        await wait('mounted WYS', () => !!q.root()?.querySelector(item.node));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (item.kind === 'mermaid') {
          let pos = -1;
          q.editor().state.doc.descendants((node: any, position: number) => { if (node.type.name === 'mermaidDiagram') pos = position; });
          if (pos < 0 || !q.editor().commands.setNodeSelection(pos)) throw new Error('Mermaid real node selection failed');
        } else q.root().querySelector(item.node).dispatchEvent(new MouseEvent(item.event!, { bubbles: true, cancelable: true }));
        await wait('active control', () => !!q.root()?.querySelector(item.control));
        const control = q.root().querySelector(item.control) as HTMLInputElement | HTMLTextAreaElement;
        const contentEditable = item.kind === 'math';
        const caretPosition = () => contentEditable ? getContentEditableCaret(control) : control.selectionStart;
        let blurs = 0;
        control.addEventListener('blur', () => { blurs++; });
        control.focus();
        // Let activation's scheduled focus complete before measuring save.
        await new Promise(resolve => requestAnimationFrame(resolve));
        blurs = 0;
        for (const [index, value] of item.values.entries()) {
          const transformed = item.kind === 'toc-to-paragraph' && index === 1;
          if (transformed) {
            // The first save intentionally retired the TOC control. Continue in
            // the replacement paragraph through the live PM editing command.
            if (control.isConnected || documentSessionForTab(q.tabId)?.hasPendingEdits?.()) throw new Error('Retired TOC control remained pending');
            const editor = q.editor();
            let pos = -1;
            editor.state.doc.descendants((node: any, position: number) => { if (node.isText && node.text === item.values[0]) pos = position + node.text.length; });
            if (pos < 0) throw new Error('TOC replacement paragraph missing');
            editor.view.focus();
            editor.commands.setTextSelection(pos);
            editor.commands.insertContent(' second');
          } else {
            if (document.activeElement !== control || !control.isConnected) throw new Error('Save lost the same focused control before continuation');
            if (contentEditable) {
              control.textContent = value;
              setContentEditableCaret(control, value.length);
            } else {
              control.value = value;
              control.setSelectionRange(value.length, value.length);
            }
            control.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await nextTick();
          const tabButton = () => [...document.querySelectorAll<HTMLButtonElement>('.document-tabs button[title]')].find(button => button.title === path);
          const dirtyBefore = !!tabButton()?.querySelector('[aria-label="未保存"]');
          const pendingBefore = documentSessionForTab(q.tabId)?.hasPendingEdits?.() === true;
          const caret = transformed ? null : caretPosition();
          const saved = await q.store.saveCurrentFile();
          await nextTick();
          const disk = await invoke<string>('read_text_file', { path });
          const replacement = item.kind === 'math' ? `$${value}$` : item.kind === 'toc-valid' ? '[TOC]' : value;
          const expected = item.source.replace(item.original, replacement);
          const lifecycleException = item.kind === 'toc-to-paragraph';
          const focusPreserved = lifecycleException ? q.root()?.contains(document.activeElement) === true : document.activeElement === control;
          const sameControl = lifecycleException ? !control.isConnected : q.root()?.querySelector(item.control) === control && control.isConnected;
          const pendingCleared = documentSessionForTab(q.tabId)?.hasPendingEdits?.() === false;
          const renderedClean = !!tabButton() && !tabButton()?.querySelector('[aria-label="未保存"]');
          const selectionPreserved = lifecycleException || caretPosition() === caret && (contentEditable || control.selectionEnd === caret);
          const result = { ordinal: index + 1, saved, diskExact: disk === expected, dirtyBefore, pendingBefore, pendingCleared, renderedClean, focusPreserved, sameControl, selectionPreserved, blurs, lifecycleException };
          saves.push(result);
          if (!saved || disk !== expected || !pendingCleared || !renderedClean || !focusPreserved || !sameControl || !selectionPreserved || !lifecycleException && blurs !== 0 || item.kind !== 'toc-valid' && !dirtyBefore) {
            throw new Error(JSON.stringify({ result, expected, disk, controlValue: control.value, focus: document.activeElement?.outerHTML?.slice(0, 200), status: q.store.appStore.statusMessage }));
          }
        }
        results.push({ kind: item.kind, passed: true, saves });
      } catch (error) { results.push({ kind: item.kind, passed: false, saves, error: String(error instanceof Error ? error.stack : error) }); }
    }
  } finally {
    await q.store.activateTab(q.mainTabId); q.tabId = q.mainTabId;
    await wait('original WYS restored', () => !!q.editor()?.view?.dom?.isConnected);
    if (await invoke<string>('read_text_file', { path: q.fixturePath }) !== q.original) throw new Error('NodeView saves changed the main immutable fixture');
  }
  q.nodeViewSaves = { status: results.every(result => result.passed && result.saves.length === 2) ? 'passed' : 'failed', cases: results };
  return q.nodeViewSaves;
}
