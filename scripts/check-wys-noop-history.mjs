import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

const source = fs.readFileSync('src/components/editor/WysiwygEditor.vue', 'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('WysiwygEditor.ts', source, ts.ScriptTarget.Latest, true);
let update;
function walk(node) { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'onUpdate') update = node; ts.forEachChild(node, walk); }
walk(ast); assert.ok(update);
const compiled = ts.transpileModule(`function ${update.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, text: { group: 'inline' },
  inlineMath: { group: 'inline', inline: true, atom: true, attrs: { tex: {} } },
}, marks: { code: { attrs: { raw: { default: '' } } } } });
const doc = content => schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, content));
const before = doc(schema.text('word'));
const stop = new Error('recorded real content');
const equality = ts.transpileModule(fs.readFileSync('src/editor/canonicalDocumentEquality.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export /gm, '');
const equalCanonicalDocument = new Function(`${equality};return equalCanonicalDocument;`)();
const calls = { recorded: 0, projected: 0, advanced: 0, dirty: 0 };
let lastBookmark;
let previousDoc = before;
const environment = {
  isCurrentWysiwygEditor: () => true, markdownPresentationMeta: 'presentation', LOCAL_EDITOR_UI_TRANSACTION_META_KEY: 'local',
  reconcileExposedHeading() {}, suppressWysiwygUpdate: false, historySourceBaseline: {}, editorOwnerTab: { id: 'main' },
  documentHistoryForTab: () => ({ current: {}, isReplaying: false, projection: () => ({ root: { mode: 'wysiwyg', doc: previousDoc }, bookmark: { anchor: 3, head: 3 } }),
    project(_root, bookmark) { calls.projected++; lastBookmark = bookmark; }, record() { calls.recorded++; throw stop; } }),
  canonicalMarkdownHistoryState: state => ({ doc: state.doc, bookmark: { anchor: 1, head: 1 } }),
  exposedMarkdownLifecycleKey: { getState: () => null }, trackSourceProvenance() {}, historyBookmark: { anchor: 1, head: 1 },
  equalCanonicalDocument,
  advanceDocumentRevision() { calls.advanced++; }, markDocumentChanged() { calls.dirty++; },
};
const run = new Function(...Object.keys(environment), `${compiled};return onUpdate;`)(...Object.values(environment));
const clone = schema.nodeFromJSON(before.toJSON());
assert.notEqual(clone, before); assert.ok(clone.eq(before));
run({ editor: { state: { doc: clone }, view: {} }, transaction: { getMeta() {}, steps: [] } });
assert.deepEqual(calls, { recorded: 0, projected: 1, advanced: 0, dirty: 0 }, 'a remount clone must preserve redo without marking input dirty');
const otherSchema = new Schema(schema.spec);
const remount = otherSchema.nodeFromJSON(before.toJSON());
assert.equal(before.eq(remount), false);
run({ editor: { state: { doc: remount }, view: {} }, transaction: { getMeta() {}, steps: [] } });
assert.deepEqual(calls, { recorded: 0, projected: 2, advanced: 0, dirty: 0 }, 'fresh-schema remount must preserve redo with a name/value model comparison');
assert.deepEqual(lastBookmark, { anchor: 3, head: 3 }, 'fresh-schema mount retains the existing document bookmark');
for (const next of [doc(schema.text('wordX')), doc(schema.nodes.inlineMath.create({ tex: 'new' })), doc(schema.text('word', [schema.marks.code.create({ raw: '``word``' })]))]) {
  const tr = EditorState.create({ doc: before }).tr.insertText('X', 2);
  assert.throws(() => run({ editor: { state: { doc: next }, view: {} }, transaction: tr }), error => error === stop, 'real text/math/code-source attributes remain content history');
}
assert.equal(calls.recorded, 3);
console.log('Production WYS onUpdate ignores only equal canonical models; text, formula and code-source changes still enter history.');
