import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTypeScriptModuleGraph } from './transpile-module-graph.mjs';
const temp = fs.mkdtempSync(path.resolve('node_modules/.lightmark-code-render-'));
try {
  const markdown = await import(pathToFileURL(compileTypeScriptModuleGraph(path.resolve('src/utils/markdown.ts'), temp)).href);
  const failures = [];
  assert.doesNotMatch(markdown.renderMarkdownForEditor('A.md'), /<a\b/, 'a plain filename must stay editable as plain text');
  assert.match(markdown.renderMarkdownForEditor('[note](A.md)'), /<a\b/, 'explicit Markdown links still open as links');
  for (const fence of ['```', '~~~', '````']) {
    const body = '==literal== ^sup^ ~sub~ [^not-a-reference] $x$ **bold**';
    const html = markdown.renderMarkdownForEditor(`${fence}text\n${body}\n${fence}\n`);
    if (!html.includes(body)) failures.push({ fence, html });
    if (html.includes('data-type="inline-math"') || html.includes('footnote-ref')) failures.push({ fence, unexpectedNode: html });
  }
  const inline = markdown.renderMarkdownForEditor('``outer ` inner`` then `**literal**`');
  assert.ok(inline.includes('outer ` inner'));
  assert.ok(inline.includes('**literal**'), inline);
  const multiline = markdown.renderMarkdownForEditor('`first\nsecond`');
  assert.ok(multiline.includes('<code') && multiline.includes('first second'), 'multiline code spans must be protected as one literal');
  assert.deepEqual(failures, [], 'fenced code must bypass enhanced Markdown interpretation');
  console.log('Code rendering literals passed: tilde/long fences, inline delimiters and multiline spans.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
