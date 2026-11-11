import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-content-integrity-'));
const source = fs.readFileSync('src/components/editor/WysiwygEditor.vue', 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0];
const ast = ts.createSourceFile('editor.ts', source, ts.ScriptTarget.Latest, true);
function extract(names, name) {
  const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text));
  assert.equal(functions.length, names.length);
  const output = path.join(temp, name + '.mjs');
  fs.writeFileSync(output, ts.transpileModule(`import { TextSelection } from '@tiptap/pm/state';\n${functions.map(s => s.getText(ast)).join('\n')}\nexport { ${names.join(',')} };`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  return import(pathToFileURL(output).href);
}
const failures = [];
function check(name, run) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
}
try {
  const inline = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/inlineMarkdownConversion.ts'), temp)).href);
  const heading = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/wysiwygMarkdownEditing.ts'), temp)).href);
  const headingConversion = await extract(['convertMarkdownHeading'], 'heading');
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
      heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
      text: { group: 'inline' }, mathInline: { inline: true, group: 'inline', atom: true, attrs: { tex: {} } },
    },
    marks: { bold: {}, italic: {}, strike: {}, highlight: {}, superscript: {}, subscript: {}, code: {}, plainPaste: {}, link: { attrs: { href: {} } } },
  });
  const math = () => schema.nodes.mathInline.create({ tex: 'x^2' });
  const text = (value, marks) => schema.text(value, marks);
  const state = (children, type = 'paragraph') => {
    const doc = schema.nodes.doc.create(null, schema.nodes[type].create(type === 'heading' ? { level: 1 } : null, children));
    return EditorState.create({ doc, schema, selection: TextSelection.create(doc, doc.content.size - 1) });
  };
  check('format after an atom retains the formula and delimiters resolve at PM positions', () => {
    const tr = inline.convertInlineMarkdownSyntax(state([math(), text('**bold**')]));
    assert.ok(tr); assert.equal(tr.doc.firstChild.firstChild.type.name, 'mathInline');
    assert.equal(tr.doc.firstChild.firstChild.attrs.tex, 'x^2');
    assert.equal(tr.doc.firstChild.textContent, 'bold');
    assert.equal(tr.doc.firstChild.lastChild.marks[0].type.name, 'bold');
  });
  check('inline code literals survive ordinary text changes', () => {
    const s = state([text('**literal**', [schema.marks.code.create()]), text(' tail x')]);
    assert.ok(inline.convertInlineMarkdownSyntax(s) === null, 'code must remain literal');
  });
  check('formatting preserves inner marks and atoms', () => {
    const s = state([text('**a '), text('link', [schema.marks.link.create({ href: 'https://example.com' })]), math(), text(' z**')]);
    const tr = inline.convertInlineMarkdownSyntax(s); assert.ok(tr);
    const json = JSON.stringify(tr.doc.toJSON());
    assert.ok(json.includes('https://example.com')); assert.ok(json.includes('x^2'));
    assert.equal(tr.doc.firstChild.textContent, 'a link z');
  });
  check('escaped formatting remains literal', () => {
    assert.equal(inline.convertInlineMarkdownSyntax(state([text('\\**literal**')])), null);
  });
  check('plain pasted syntax is protected even after an atom', () => {
    const s = state([math(), text(' **literal**', [schema.marks.plainPaste.create()])]);
    assert.ok(inline.convertInlineMarkdownSyntax(s) === null);
    assert.ok(inline.convertInlineCodeSyntax(state([text('`literal`', [schema.marks.plainPaste.create()])])) === null);
  });
  check('code conversion after an atom uses structured positions', () => {
    const tr = inline.convertInlineCodeSyntax(state([math(), text(' `literal`')])); assert.ok(tr);
    assert.equal(tr.doc.firstChild.firstChild.type.name, 'mathInline');
    assert.equal(tr.doc.firstChild.textContent, ' literal');
  });
  const rich = () => [text('## '), text('Bold', [schema.marks.bold.create()]), text(' '), text('link', [schema.marks.link.create({ href: 'https://example.com' })]), text(' '), math()];
  check('editing a heading level retains its complete inline fragment', () => {
    const s = state(rich(), 'heading');
    const tr = heading.reconcileExposedHeading(s, { kind: 'heading', from: 1, to: s.doc.content.size - 1, blockFrom: 0, open: '# ', close: '', headingLevel: 1 });
    assert.ok(tr); assert.equal(tr.doc.firstChild.attrs.level, 2);
    assert.ok(tr.doc.firstChild.content.eq(s.doc.firstChild.content.cut(3)));
  });
  check('canonical history removes only presentation delimiters and keeps rich heading content', () => {
    const original = state(rich(), 'heading');
    const canonical = heading.canonicalMarkdownHistoryState(original, { kind: 'heading', from: 1, to: original.doc.content.size - 1, blockFrom: 0, open: '# ', close: '', headingLevel: 1 });
    assert.equal(canonical.doc.firstChild.attrs.level, 2);
    assert.ok(canonical.doc.firstChild.content.eq(original.doc.firstChild.content.cut(3)));
    const formatted = state([text('**'), text('Bold', [schema.marks.bold.create()]), math(), text('**')]);
    const result = heading.canonicalMarkdownHistoryState(formatted, { kind: 'inline', from: 1, to: formatted.doc.content.size - 1, blockFrom: 0, open: '**', close: '**' });
    assert.ok(result.doc.firstChild.content.eq(formatted.doc.firstChild.content.cut(2, formatted.doc.firstChild.content.size - 2)));
  });
  check('converting a source heading retains its complete inline fragment', () => {
    const s = state(rich());
    const tr = headingConversion.convertMarkdownHeading(s, { force: true }); assert.ok(tr);
    assert.ok(tr.doc.firstChild.content.eq(s.doc.firstChild.content.cut(3)));
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
assert.deepEqual(failures, [], 'content integrity regressions must all pass');
