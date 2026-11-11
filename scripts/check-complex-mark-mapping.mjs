import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-complex-map-'));
try {
  const { createMarkdownPositionMap, pmPositionToSource, sourcePositionToPm } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/markdownPositionMap.ts'), temp)).href);
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' }, text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', atom: true },
  }, marks: { highlight: {}, superscript: {}, subscript: {}, strike: {}, link: { attrs: { href: {} } } } });
  const doc = content => schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, content));
  const cases = [
    { name: 'highlight', source: '==word==', doc: doc(schema.text('word', [schema.marks.highlight.create()])), word: 'word' },
    { name: 'superscript', source: '^word^', doc: doc(schema.text('word', [schema.marks.superscript.create()])), word: 'word' },
    { name: 'subscript', source: '~word~', doc: doc(schema.text('word', [schema.marks.subscript.create()])), word: 'word' },
    { name: 'strike', source: '~~word~~', doc: doc(schema.text('word', [schema.marks.strike.create()])), word: 'word' },
    { name: 'hard break', source: 'left\\\nright', doc: doc([schema.text('left'), schema.nodes.hardBreak.create(), schema.text('right')]), word: 'right' },
    { name: 'reference link with inherited definition', source: '[word][ref]', doc: doc(schema.text('word', [schema.marks.link.create({ href: 'https://example.com' })])), word: 'word' },
  ];
  const failures = [];
  for (const item of cases) {
    try {
      const bindings = createMarkdownPositionMap(item.source, item.doc);
      const raw = item.source.indexOf(item.word);
      const pm = sourcePositionToPm(bindings, raw);
      assert.equal(item.doc.textBetween(pm, pm + item.word.length), item.word);
      assert.equal(pmPositionToSource(bindings, pm), raw);
    } catch (error) { failures.push(`${item.name}: ${error.message}`); }
  }
  assert.deepEqual(failures, [], `Supported rich syntax must map across history modes:\n${failures.join('\n')}`);
  console.log('Complex mark, hard break and reference-link history mapping passed.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
