import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { TestElement } from './math-dom-harness.mjs';

const source = fs.readFileSync('src/extensions/MermaidNode.ts', 'utf8');
const ast = ts.createSourceFile('MermaidNode.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['readMermaidNodePosition', 'readMermaidNodeBinding', 'restoreMermaidTextUi', 'createMermaidView'];
const productionFunctions = names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `${name} must exist`);
  return node.getText(ast);
}).join('\n');
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: { group: 'inline' },
  mermaidDiagram: { group: 'block', atom: true, attrs: { code: {}, editing: { default: true } } },
} });
let buffer, recovery, retained = 0, nodeView, exits = 0;
const document = { activeElement: null, createElement(tag) {
  const element = new TestElement();
  element.tagName = tag.toUpperCase(); element.ownerDocument = this;
  element.selectionStart = 0; element.selectionEnd = 0; element.selectionDirection = 'none';
  element.setSelectionRange = (from, to) => { element.selectionStart = from; element.selectionEnd = to; };
  element.blur = () => { this.activeElement = null; };
  return element;
} };
const context = vm.createContext({
  document, mermaidId: 0, HTMLTextAreaElement: TestElement,
  requestAnimationFrame: callback => { callback(); return 1; },
  window: { setTimeout: () => 1, clearTimeout() {} },
  DOCUMENT_FLUSH_META_KEY: 'lightmarkDocumentFlush',
  registerPendingEditorBuffer: (_, value) => { buffer = value; return () => {}; },
  notifyPendingEditorInput() {}, registerRecoveryLocalBufferForOwner: (_, value) => { recovery = value; return () => {}; },
  retainAndUnregisterRecoveryLocalBufferForOwner: () => { retained++; },
  renderMermaid: async () => {}, setBlockSelectionAfter: () => { exits++; },
});
vm.runInContext(ts.transpileModule(productionFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const editor = { view: { state: EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.mermaidDiagram.create({ code: 'graph TD; A-->B', editing: true })) }), dispatch(transaction) {
  this.state = this.state.apply(transaction);
  nodeView?.update(this.state.doc.firstChild);
} } };
nodeView = context.createMermaidView({ code: 'graph TD; A-->B', editing: true }, editor, () => 0);
const textarea = nodeView.dom.querySelector('.mermaid-source-editor');
textarea.focus();
textarea.value = 'graph TD; A-->C'; textarea.selectionStart = textarea.selectionEnd = 9;
textarea.dispatchEvent({ type: 'input' });
assert.equal(buffer.hasPending(), true);
buffer.flush({ flushId: 'first' });
buffer.flush({ flushId: 'second' });
assert.equal(editor.view.state.doc.firstChild.attrs.code, textarea.value);
assert.equal(buffer.hasPending(), false);
assert.equal(nodeView.dom.querySelector('.mermaid-source-editor'), textarea);
assert.equal(document.activeElement, textarea);
assert.equal(textarea.selectionStart, 9);

editor.view.dispatch(editor.view.state.tr.setNodeMarkup(0, undefined, { code: 'graph TD; X-->Y', editing: true }));
assert.equal(textarea.value, 'graph TD; X-->Y', 'history replay must update a clean focused local control');
assert.equal(buffer.hasPending(), false, 'history replay must not manufacture a pending old value');
buffer.flush({ flushId: 'after-undo' });
assert.equal(editor.view.state.doc.firstChild.attrs.code, 'graph TD; X-->Y');

textarea.value = 'graph TD; LOCAL-->DRAFT'; textarea.dispatchEvent({ type: 'input' });
editor.view.dispatch(editor.view.state.tr.setNodeMarkup(0, undefined, { code: 'graph TD; EXTERNAL-->NEW', editing: true }));
assert.equal(textarea.value, 'graph TD; LOCAL-->DRAFT', 'conflicting local input remains recoverable');
assert.equal(buffer.hasPending(), true);
assert.throws(() => buffer.flush({ flushId: 'conflict' }), /冲突/);
assert.equal(editor.view.state.doc.firstChild.attrs.code, 'graph TD; EXTERNAL-->NEW', 'conflict flush must not overwrite the new model');
assert.ok(recovery.capture().payload || recovery.capture().buffer?.payload);

textarea.dispatchEvent({ type: 'compositionstart' });
for (const key of ['Escape', 'ArrowRight']) {
  let prevented = false;
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  textarea.dispatchEvent({ type: 'keydown', key, isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, `IME ${key} stays with the input method`);
}
assert.equal(exits, 0);
nodeView.destroy();
assert.equal(retained, 1, 'pending/conflicting input must be retained on destruction');
console.log('Mermaid pending-buffer checks passed: two focused saves, clean replay, conflict retention and IME keys (DOM harness).');
