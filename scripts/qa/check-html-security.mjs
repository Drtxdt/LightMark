import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "../transpile-module-graph.mjs";

// Investigation-only evidence: this fixture records the old trust-boundary
// behavior and is not a release gate. The formal post-fix gate is
// check-html-security-regression.mjs.
const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-html-security-"));

try {
  const compiledHtml = compileTypeScriptModuleGraph(path.resolve("src/utils/html.ts"), tempDir);
  const compiledMarkdown = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const {
    findInlineHtmlMatch,
    findRawHtmlMatch,
    sanitizeHtmlFragment,
  } = await import(pathToFileURL(compiledHtml).href);
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(compiledMarkdown).href);

  const fixtures = [
    {
      name: "forged-inline-math-image",
      markdown: '<img data-type="inline-math" src="x" onerror="window.__LIGHTMARK_QA__=1">',
    },
    {
      name: "forged-inline-math-script",
      markdown: '<script data-type="inline-math">window.__LIGHTMARK_QA__=1</script>',
    },
    {
      name: "forged-inline-html-iframe",
      markdown: '<iframe data-type="inline-html" src="javascript:window.__LIGHTMARK_QA__=1"></iframe>',
    },
  ];

  const records = fixtures.map(({ name, markdown }) => {
    const inlineMatch = findInlineHtmlMatch(markdown);
    const rawMatch = findRawHtmlMatch(markdown);
    const sanitized = sanitizeHtmlFragment(markdown, { inlineOnly: true });
    const editorHtml = renderMarkdownForEditor(markdown);
    const previewHtml = renderMarkdown(markdown);
    const dangerousMarkupSurvives = /<script\b|onerror=|javascript:/i.test(editorHtml);
    const sourceSurvives = editorHtml.includes(markdown);
    return {
      name,
      inlineMatch,
      rawMatch,
      sanitized,
      editorHtml,
      previewHtml,
      sourceSurvives,
      dangerousMarkupSurvives,
      previewRetainsDangerousAttribute: previewHtml.includes("onerror=") || previewHtml.includes("javascript:"),
    };
  });

  const generatedPlaceholder = renderMarkdownForEditor("safe $x$");

  console.log(JSON.stringify({
    status: "investigation-only-bounded-evidence",
    classification: "investigation-only; historical forged-markup fixture, not a security pass/fail gate",
    scope: "local production renderer only; no filesystem fixture or user note accessed",
    formalGate: "scripts/qa/check-html-security-regression.mjs",
    generatedPlaceholder,
    fixtures: records,
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
