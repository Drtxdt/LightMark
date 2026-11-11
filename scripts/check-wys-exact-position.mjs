import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const source = fs.readFileSync('src/components/editor/WysiwygEditor.vue', 'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('editor.ts', source, ts.ScriptTarget.Latest, true);
const method = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureExactWysiwygPosition');
const compiled = ts.transpileModule(method.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-exact-position-'));
try {
  const { historySourceBookmark } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/historySource.ts'), temp)).href);
  const { captureWysiwygSourceBaseline } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygCodec.ts'), temp)).href);
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'text*', group: 'block' }, text: {} } });
  const markdown = Array.from({ length: 50_000 }, (_, i) => `paragraph ${i}`).join('\n\n');
  const doc = schema.nodes.doc.create(null, Array.from({ length: 50_000 }, (_, i) => schema.nodes.paragraph.create(null, schema.text(`paragraph ${i}`))));
  const baseline = captureWysiwygSourceBaseline(markdown, doc);
  let published, fallback = 0, mapper = historySourceBookmark;
  const capture = new Function('historySourceBookmark', 'editorShell', 'props', 'updatePanePosition', 'buildEditorPositionSnapshot', 'docPosToMarkdownOffset', 'captureWysiwygPosition', `${compiled}; return captureExactWysiwygPosition;`)((...args) => mapper(...args), { value: null }, { paneId: 'main' }, (_, value) => { published = value; }, value => value, () => assert.fail('exact snapshot position must never serialize the document prefix'), () => { fallback++; });
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) });
  const view = { state };
  const canonical = { doc, bookmark: { anchor: state.selection.anchor, head: state.selection.head } };
  const parser = markdownLanguage.parser, originalParse = parser.parse;
  const parsedLengths = [];
  parser.parse = function(input, ...args) { parsedLengths.push(input.length); return originalParse.call(this, input, ...args); };
  try { await capture(view, markdown, canonical, baseline); }
  finally { parser.parse = originalParse; }
  assert.ok(parsedLengths.length > 0);
  assert.ok(parsedLengths.every(length => length <= 'paragraph 49999'.length), 'reuse exact baseline; parse selected blocks only');
  assert.equal(published.markdownAnchor, markdown.length);
  assert.equal(published.markdownHead, markdown.length);
  const backward = { ...canonical, bookmark: { anchor: doc.content.size - 2, head: 3 } };
  await capture(view, markdown, backward, baseline);
  assert.equal(published.markdownAnchor, markdown.length - 1);
  assert.equal(published.markdownHead, 2);
  // Optional position capture must not make a valid snapshot unsavable when a
  // preserved HTML/comment block has no proven source/model position map.
  published = undefined;
  await capture(view, 'unrelated source', canonical, { ...baseline, markdown: 'unrelated source', aligned: false });
  assert.equal(published, undefined);
  assert.equal(fallback, 1);
  let release;
  mapper = async () => new Promise(resolve => { release = resolve; });
  const pending = capture(view, markdown, canonical, baseline);
  view.state = state.apply(state.tr.setSelection(TextSelection.create(doc, 2)));
  release({ anchor: markdown.length, head: markdown.length });
  await pending;
  assert.equal(published, undefined, 'async mapping must not overwrite newer selection state');
  // Empty paragraphs have no text bindings but have an exact source boundary.
  const empty = schema.nodes.doc.create(null, schema.nodes.paragraph.create());
  assert.deepEqual(await historySourceBookmark({ root: { mode: 'wysiwyg', doc: empty, baseline: captureWysiwygSourceBaseline('', empty) }, bookmark: { anchor: 1, head: 1 } }, ''), { anchor: 0, head: 0 });
  console.log('Exact 50k snapshot bookmark: EOF/backward range without prefix serialization; unproven map preserves prior raw position; empty paragraph exact boundary passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
