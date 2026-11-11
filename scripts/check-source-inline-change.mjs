import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-inline-source-'));
try {
  const { inlineChangeSourceCandidates } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourceInlineChangeCandidates.ts'), temp)).href);
  const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' }, text: { group: 'inline' } },
    marks: { bold: {}, link: { attrs: { href: {}, title: { default: null } } } } });
  const before = schema.nodes.paragraph.create(null, [schema.text('before '), schema.text('keep', [schema.marks.bold.create()]), schema.text(' '),
    schema.text('link', [schema.marks.link.create({ href: 'same.png', title: 'keep title' })])]);
  const source = 'before __keep__   [link](same.png "keep title")\r\n';
  const state = EditorState.create({ doc: schema.nodes.doc.create(null, before) });
  const insertAt = state.doc.content.size - 1;
  const tr = state.tr.setStoredMarks([]).insertText(' bold', insertAt).addMark(insertAt + 1, insertAt + 5, schema.marks.bold.create());
  let serialized = 0;
  const candidates = inlineChangeSourceCandidates(source, before, tr.doc.firstChild, fragment => {
    serialized++;
    assert.equal(fragment.size, 5, 'only the actual changed inline fragment may be serialized');
    assert.equal(fragment.firstChild.text, ' ');
    assert.equal(fragment.lastChild.text, 'bold');
    assert.equal(fragment.lastChild.marks[0].type.name, 'bold');
    return '**bold**'; // The production Turndown serializer trims edge whitespace.
  });
  assert.equal(serialized, 1);
  assert.ok(candidates.includes(source.replace('\r\n', ' **bold**\r\n')), `new formatting retains all preexisting mark spelling, spaces, URI, title and EOL: ${JSON.stringify(candidates)}`);
  const plain = state.tr.setStoredMarks([]).insertText(' plain', insertAt).doc.firstChild;
  assert.deepEqual(inlineChangeSourceCandidates(source, before, plain, () => assert.fail('plain text uses the existing literal proof')), []);
  assert.deepEqual(inlineChangeSourceCandidates('unrelated source', before, tr.doc.firstChild, () => '**bold**'), [], 'unproven source alignment yields no candidate');
  assert.deepEqual(inlineChangeSourceCandidates(source, before, before, () => assert.fail('equal nodes need no serialization')), []);
  console.log('Inline source candidates serialize only the changed marked fragment and retain existing rich raw syntax; plain text and unproven mappings reject.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
