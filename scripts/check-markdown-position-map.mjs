import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from '@tiptap/pm/model';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-rich-map-'));
try {
  const { createMarkdownPositionMap, pmPositionToSource, sourcePositionToPm } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/markdownPositionMap.ts'), temp)).href);
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' }, heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    bulletList: { group: 'block', content: 'listItem+' }, listItem: { content: 'paragraph block*' },
    table: { group: 'block', content: 'tableRow+' }, tableRow: { content: 'tableCell+' }, tableCell: { content: 'paragraph+' },
    codeBlock: { group: 'block', content: 'text*', code: true }, text: { group: 'inline' },
    inlineMath: { inline: true, group: 'inline', atom: true, attrs: { tex: {} } },
  }, marks: { bold: {}, italic: {}, code: {}, link: { attrs: { href: {} } } } });
  const t = (text, marks) => schema.text(text, marks);
  const n = (name, content, attrs) => schema.nodes[name].create(attrs, content);
  const doc = content => n('doc', content);
  const verify = (source, model, samples) => {
    const bindings = createMarkdownPositionMap(source, model);
    for (const value of samples) {
      const raw = source.indexOf(value);
      assert.ok(raw >= 0);
      const pm = sourcePositionToPm(bindings, raw);
      assert.equal(model.textBetween(pm, pm + value.length), value);
      assert.equal(pmPositionToSource(bindings, pm), raw);
    }
    return bindings;
  };
  verify('# Title', doc(n('heading', t('Title'))), ['Title']);
  const rich = doc(n('heading', [t('Bold', [schema.marks.bold.create()]), t(' '), t('link', [schema.marks.link.create({ href: 'https://example.com' })]), t(' '), n('inlineMath', null, { tex: 'x^2' })]));
  verify('# **Bold** [link](https://example.com) $x^2$', rich, ['Bold', 'link']);
  const nested = doc(n('bulletList', [n('listItem', [n('paragraph', [t('a', [schema.marks.bold.create()]), t(' and '), t('b', [schema.marks.code.create()])]), n('bulletList', n('listItem', n('paragraph', t('nested'))))])]));
  verify('- [x] **a** and `b`\n  - nested\n', nested, ['a', 'and', 'b', 'nested']);
  const table = doc(n('table', [n('tableRow', [n('tableCell', n('paragraph', t('a'))), n('tableCell', n('paragraph', t('b', [schema.marks.bold.create()])))]), n('tableRow', [n('tableCell', n('paragraph', t('c'))), n('tableCell', n('paragraph', t('d')))])]));
  verify('| a | **b** |\n| --- | --- |\n| c | d |', table, ['a', 'b', 'c', 'd']);
  const decoded = doc(n('paragraph', t('para & * a next')));
  const bindings = createMarkdownPositionMap('para &amp; \\* a\nnext', decoded);
  assert.equal(sourcePositionToPm(bindings, 5), 6);
  assert.equal(pmPositionToSource(bindings, 7), 10, 'entity endpoint maps to the complete raw entity');
  verify('```ts\nconst x = 1\n```', doc(n('codeBlock', t('const x = 1'))), ['const x = 1']);
  verify('`first\nsecond`', doc(n('paragraph', t('first second', [schema.marks.code.create()]))), ['first', 'second']);
  verify('``first\r\nsecond``', doc(n('paragraph', t('first second', [schema.marks.code.create()]))), ['first', 'second']);
  verify('~~~js\r\nconst x = 1\r\n~~~', doc(n('codeBlock', t('const x = 1'))), ['const x = 1']);
  verify('中文与 emoji 😀', doc(n('paragraph', t('中文与 emoji 😀'))), ['中文', 'emoji', '😀']);
  verify('text [[Wiki Link]] **word**', doc(n('paragraph', [t('text '), t('Wiki Link', [schema.marks.link.create({ href: 'lightmark://wiki?page=Wiki%20Link' })]), t(' '), t('word', [schema.marks.bold.create()])])), ['Wiki', 'Link', 'word']);
  verify('[[ Page  #  Heading ]]', doc(n('paragraph', t('Page#Heading', [schema.marks.link.create({ href: 'lightmark://wiki?page=Page&heading=Heading' })]))), ['Page', 'Heading']);
  assert.throws(() => createMarkdownPositionMap('original', doc(n('paragraph', t('different')))), /不一致/);
  console.log('Rich Markdown mapping passed: headings, marks, links, math, nested tasks, tables, code, escapes, entities and Unicode.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
