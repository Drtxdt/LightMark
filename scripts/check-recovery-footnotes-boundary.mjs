import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-recovery-footnotes-"));

try {
  const htmlPath = compileTypeScriptModuleGraph(path.resolve("src/utils/html.ts"), tempDir);
  const html = await import(pathToFileURL(htmlPath).href);
  const wysiwygSource = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");

  // The PM parser keeps FootnotesNode.parseHTML's innerHTML as opaque data.
  // The empty-view fallback is the display boundary and must pass through the
  // existing renderer before assigning innerHTML.
  const footnotesStart = wysiwygSource.indexOf('name: "footnotes"');
  const footnotesHtmlParse = wysiwygSource.indexOf("parseHTML: (element) => element.innerHTML", footnotesStart);
  assert.ok(footnotesStart >= 0 && footnotesHtmlParse > footnotesStart, "FootnotesNode is present");
  assert.match(wysiwygSource.slice(footnotesHtmlParse - 120, footnotesHtmlParse + 180), /element\.innerHTML/);
  const fallbackStart = wysiwygSource.indexOf("function renderFootnotesView");
  assert.match(wysiwygSource.slice(fallbackStart, fallbackStart + 700), /renderInlineMarkdownInHtml\(fallbackHtml\)/);

  const sentinel = "<script>globalThis.__lightmarkRecoverySentinel = true</script><b>keep as data</b>";
  const unsafeFallback = sentinel;
  assert.match(unsafeFallback, /<script>/, "the fixture represents the old raw fallback value");
  const safeFallback = html.renderInlineMarkdownInHtml(unsafeFallback);
  assert.doesNotMatch(safeFallback, /<script>/i, "the recovery display boundary does not expose script markup");
  assert.match(safeFallback, /raw-html-token/, "raw HTML remains visible as escaped data");
  assert.match(safeFallback, /&lt;script&gt;/, "the sentinel is preserved as text");
  assert.match(safeFallback, /<b>/, "safe allowed markup remains renderable");

  console.log("check-recovery-footnotes-boundary: passed (opaque PM HTML + sanitized fallback sentinel)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
