import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-table-source-'));
try {
  const { markdownTopLevelSourceBlocks, renderMarkdownForEditor } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/utils/markdown.ts'), temp)).href);
  const { combinePreservedSourceBlocks } = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/editor/sourcePreservation.ts'), temp)).href);
  for (const eol of ['\n', '\r\n']) {
    const table = ['| key | value |', '| --- | ---: |', '| a | 17 |'].join(eol);
    const comment = '<!-- after-table -->';
    const source = `before${eol}${eol}${table}${eol}${comment}${eol}${eol}after${eol}`;
    assert.match(renderMarkdownForEditor(source), /<\/table>\s*(?:<p>)?<span data-type="raw-html"/, 'rendered table and following comment are distinct PM blocks');
    const mapped = markdownTopLevelSourceBlocks(source);
    assert.deepEqual(mapped.blocks.map(block => block.source), ['before', table, comment, 'after'], 'source blocks must follow the same table boundary as the production renderer');
    const nodes = mapped.blocks.map(() => ({})), changed = {};
    const updated = combinePreservedSourceBlocks(nodes, mapped.blocks, [changed, ...nodes.slice(1)], ['changed', table, comment, 'after'], mapped.prefix, eol);
    assert.equal(updated, source.replace('before', 'changed'), 'editing adjacent prose preserves all table/comment bytes and EOLs');
    const fenced = `\`\`\`text${eol}${table}${eol}\`\`\`${eol}`;
    assert.equal(markdownTopLevelSourceBlocks(fenced).blocks[0].source, fenced.slice(0, -eol.length), 'fenced table text remains a single code source block');
  }
  // Same wrapper/table adjacency as the failed native table-dense fixture;
  // rows are shortened so this regression remains independent of .cache.
  const fixture = ['<!-- fixture -->', '<!-- before -->', '# Table dense', '', '<!-- start -->',
    '| key | value |', '| --- | ---: |', '| a | 17 |', '',
    '| second | value |', '| --- | ---: |', '| b | 18 |', '<!-- end -->', '', '<!-- after -->', ''].join('\n');
  assert.equal(markdownTopLevelSourceBlocks(fixture).blocks.length, 7, 'failed native table-dense fixture must align with its seven actual PM blocks');
  console.log('Table source provenance passed: shared renderer boundaries, adjacent HTML comments, exact LF/CRLF bytes, fenced literals and native dense fixture.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

