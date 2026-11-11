import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const script = fs.readFileSync('src/components/editor/WysiwygEditor.vue', 'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('WysiwygEditor.ts', script, ts.ScriptTarget.Latest, true);
let method;
function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'restoreSourceBookmark') method = node; ts.forEachChild(node, visit); }
visit(ast); assert.ok(method);
const compiled = ts.transpileModule(`async function ${method.getText(ast).replace(/^async\s+/, '')}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-mode-bookmark-'));
try {
  const { canonicalMarkdownHistoryState, exposeHeadingMarkdown } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygMarkdownEditing.ts'), temp)).href);
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } }, paragraph: { content: 'text*', group: 'block' }, text: {} } });
  const doc = schema.nodes.doc.create(null, [schema.nodes.heading.create(null, schema.text('title')), schema.nodes.paragraph.create(null, schema.text('Chinese 你好'))]);
  for (const change of ['presentation', 'selection', 'content']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let exposed = null, focused = false, projected, pending = { targetMode: 'wysiwyg' };
    const activeEditor = { state: EditorState.create({ doc }), view: { dispatch(tr) { activeEditor.state = activeEditor.state.apply(tr); }, focus() { focused = true; } } };
    const target = doc.content.size - 1;
    const env = { wysiwygSelectionRestoreEpoch: 0, wysiwygRevision: 9, activeEditor, editor: { value: activeEditor }, isCurrentOwnerTab: () => true,
      canonicalMarkdownHistoryState, exposedMarkdownLifecycleKey: { getState: () => exposed },
      historyPmBookmark: async () => { await gate; return { anchor: target, head: target }; }, TextSelection, markdownPresentationMeta: 'presentation',
      historyBookmark: null, historySourceBaseline: {}, documentHistory: { project(root, bookmark) { projected = { root, bookmark }; } },
      getPanePendingModeCursor: () => pending, setPanePendingModeCursor: (_pane, value) => { pending = value; }, props: { paneId: 'main' } };
    const restore = new Function(...Object.keys(env), `${compiled};return restoreSourceBookmark;`)(...Object.values(env));
    const work = restore('# title\n\nChinese 你好', { anchor: 1, head: 1 });
    if (change === 'presentation') {
      const tr = exposeHeadingMarkdown(activeEditor.state, 0, 1);
      exposed = { kind: 'heading', blockFrom: 0, from: 1, to: 8, open: '# ', close: '', headingLevel: 1 };
      activeEditor.view.dispatch(tr);
    } else if (change === 'selection') activeEditor.view.dispatch(activeEditor.state.tr.setSelection(TextSelection.create(activeEditor.state.doc, 2)));
    else activeEditor.view.dispatch(activeEditor.state.tr.insertText('X', 2));
    release(); await work;
    if (change === 'presentation') {
      assert.ok(focused, 'syntax revelation during async mapping must not discard focus restoration');
      assert.equal(activeEditor.state.selection.anchor, target + 2, 'canonical target maps back across the exposed heading prefix');
      assert.deepEqual(projected.bookmark, { anchor: target, head: target });
      assert.equal(pending, null);
    } else { assert.equal(focused, false); assert.equal(projected, undefined, 'new user selection or content must not be overwritten'); }
  }
  console.log('Production mode bookmark restoration survives presentation changes and preserves newer input/selection.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
