import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';

const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-code-span-map-'));
try {
  const { createMarkdownPositionMap, pmPositionToSource, sourcePositionToPm } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/markdownPositionMap.ts'), temp)).href);
  const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} }, marks: { code: { attrs: { raw: {}, originalText: {}, delimiterLength: { default: 1 } } } } });
  const failures = [];
  for (const source of ['`first\nsecond`', '`first\r\nsecond`', '`` first\r\nsecond ``']) {
    try {
      const mark = schema.marks.code.create({ raw: source, originalText: 'first second', delimiterLength: source.startsWith('``') ? 2 : 1 });
      const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('first second', [mark])));
      const bindings = createMarkdownPositionMap(source, doc);
      assert.equal(pmPositionToSource(bindings, 4), source.indexOf('first') + 3, 'text inside a multiline code span must be editable without rebuilding the span');
      assert.equal(pmPositionToSource(bindings, 7), source.indexOf('second'), 'the position following a normalized newline must retain its original raw offset');
      assert.equal(sourcePositionToPm(bindings, source.indexOf('second') + 2), 9);
    } catch (error) { failures.push({ source, error: String(error) }); }
  }
  assert.deepEqual(failures, [], 'Multiline code normalization must preserve granular source coordinates');
  console.log('Multiline code span source coordinates passed (LF/CRLF/padding and interior text).');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
