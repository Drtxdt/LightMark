import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-atomic-source-'));
try {
  const { mathAttributeSourceCandidates } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourceAtomicPatches.ts'), temp)).href);
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, text: { group: 'inline' },
    inlineMath: { inline: true, group: 'inline', atom: true, attrs: { tex: {}, delimiter: { default: 'inline-dollar' }, raw: { default: '' }, originalTex: { default: '' }, editing: { default: false } } },
  }, marks: { bold: {}, link: { attrs: { href: {} } } } });
  const paragraph = (a, b, delimiter = 'inline-dollar') => schema.nodes.paragraph.create(null, [schema.text('bold', [schema.marks.bold.create()]), schema.text(' '),
    schema.nodes.inlineMath.create({ tex: a, delimiter }), schema.text(' '), schema.text('link', [schema.marks.link.create({ href: 'x.png' })]), schema.text(' '), schema.nodes.inlineMath.create({ tex: b })]);
  const source = '__bold__   $x$  [link](x.png "title")   $y$\r\n';
  const before = paragraph('x', 'y'), after = paragraph('x^2', 'z');
  assert.deepEqual(mathAttributeSourceCandidates(source, before, after), [source.replace('$x$', '$x^2$').replace('$y$', '$z$')]);
  const paren = '__bold__   \\(x\\)  [link](x.png "title")   $y$\r\n';
  assert.deepEqual(mathAttributeSourceCandidates(paren, paragraph('x', 'y', 'inline-paren'), paragraph('x+1', 'y', 'inline-paren')), [paren.replace('\\(x\\)', '\\(x+1\\)')]);
  assert.deepEqual(mathAttributeSourceCandidates(source, before, schema.nodes.paragraph.create(null, schema.text('different'))), []);
  assert.deepEqual(mathAttributeSourceCandidates(source.replace('$x$', '$different$'), before, after), [], 'unproven atom/source correspondence is rejected');
  console.log('Atomic math source candidates preserve original delimiters, distant atoms, marks, link titles and CRLF; mismatched source is rejected.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
