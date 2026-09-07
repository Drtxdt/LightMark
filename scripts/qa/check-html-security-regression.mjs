import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "../transpile-module-graph.mjs";

// This is the formal LM-011 regression gate. A non-zero exit is a security
// regression in the production renderer's per-render capability boundary.
const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-html-security-regression-"));
const failures = [];
const records = [];

function check(name, callback) {
  try {
    const value = callback();
    records.push({ name, status: "passed", value });
  } catch (error) {
    failures.push({
      name,
      message: error instanceof Error ? error.message : String(error),
    });
    records.push({ name, status: "failed" });
  }
}

function assertNoExecutableMarkup(html, name) {
  assert.doesNotMatch(html, /<\s*script\b/i, `${name}: literal script element survived editor rendering`);
  assert.doesNotMatch(
    html,
    /<(?:img|iframe|video|source|script|object|embed|input|button|select|option|label)\b[^>]*\bon[a-z]+\s*=/i,
    `${name}: executable event attribute survived editor rendering`,
  );
  assert.doesNotMatch(
    html,
    /<(?:a|img|iframe|video|source)\b[^>]*\b(?:href|src|poster)\s*=\s*["']\s*(?:javascript|vbscript):/i,
    `${name}: executable URL survived editor rendering`,
  );
  assert.equal(
    hasOpeningAttribute(html, "data-lightmark-internal"),
    false,
    `${name}: capability leaked into editor output`,
  );
}

function hasOpeningAttribute(html, expectedName) {
  const attributePattern = /\s([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  for (const opening of html.match(/<\s*[a-zA-Z][^<>]*>/g) || []) {
    attributePattern.lastIndex = 0;
    let match = attributePattern.exec(opening);
    while (match) {
      if (match[1].toLowerCase() === expectedName.toLowerCase()) return true;
      match = attributePattern.exec(opening);
    }
  }
  return false;
}

try {
  const compiledHtml = compileTypeScriptModuleGraph(path.resolve("src/utils/html.ts"), tempDir);
  const compiledMarkdown = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const compiledRenderContext = compileTypeScriptModuleGraph(
    path.resolve("src/utils/internalRenderContext.ts"),
    tempDir,
  );
  const {
    createInternalRenderContext,
    hasInternalHtmlCapability,
    markInternalHtml,
    stripInternalHtmlCapability,
    stripInternalHtmlCapabilities,
  } = await import(pathToFileURL(compiledRenderContext).href);
  const {
    findInlineHtmlMatch,
    findRawHtmlMatch,
    renderInlineMarkdownInHtml,
  } = await import(pathToFileURL(compiledHtml).href);
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(compiledMarkdown).href);

  const forgedFixtures = [
    {
      name: "forged-inline-math-image",
      markdown: '<img data-type="inline-math" src="x" onerror="this.dataset.qa=1">',
      expectedMatch: "inline",
    },
    {
      name: "forged-inline-math-script",
      markdown: '<script data-type="inline-math">window.__LIGHTMARK_QA__=1</script>',
      expectedMatch: "raw",
    },
    {
      name: "forged-inline-html-iframe",
      markdown: '<iframe data-type="inline-html" src="javascript:window.__LIGHTMARK_QA__=1"></iframe>',
      expectedMatch: "inline",
    },
  ];

  for (const fixture of forgedFixtures) {
    check(fixture.name, () => {
      const inlineMatch = findInlineHtmlMatch(fixture.markdown);
      const rawMatch = findRawHtmlMatch(fixture.markdown);
      const matchKind = inlineMatch ? "inline" : rawMatch ? "raw" : "none";
      assert.equal(matchKind, fixture.expectedMatch, `${fixture.name}: user HTML was treated as trusted internal HTML`);
      const editorHtml = renderMarkdownForEditor(fixture.markdown);
      assertNoExecutableMarkup(editorHtml, fixture.name);
      return {
        matchKind,
        editorHtml,
      };
    });
  }

  check("forged-wrapper-around-internal-child", () => {
    const context = createInternalRenderContext();
    const trustedChild = markInternalHtml('<span data-type="inline-math" data-tex="x"></span>', context);
    const wrapped = `<div onmouseover="this.dataset.qa=1">${trustedChild}</div>`;
    assert.equal(
      hasInternalHtmlCapability(wrapped, context),
      false,
      "a capability on a nested child granted trust to the outer fragment",
    );
    const editorHtml = renderMarkdownForEditor(wrapped);
    assertNoExecutableMarkup(editorHtml, "forged-wrapper-around-internal-child");
    return { editorHtml };
  });

  check("forged-unclosed-internal-block", () => {
    const editorHtml = renderMarkdownForEditor(
      '<section data-type="front-matter" onmouseover="this.dataset.qa=1">user content',
    );
    assert.doesNotMatch(
      editorHtml,
      /<section\b[^>]*\bdata-type\s*=\s*["']front-matter["']/i,
      "an unclosed user block retained an internal node identity",
    );
    assertNoExecutableMarkup(editorHtml, "forged-unclosed-internal-block");
    return { editorHtml };
  });

  check("root-capability-sibling-boundary", () => {
    const context = createInternalRenderContext();
    const trustedChild = markInternalHtml('<span data-type="inline-math" data-tex="x"></span>', context);
    const rendered = renderInlineMarkdownInHtml(
      `${trustedChild}<img src="x" onerror="this.dataset.qa=1">`,
      { internalRenderContext: context },
    );
    const finalRendered = stripInternalHtmlCapabilities(rendered, context);
    assert.match(finalRendered, /data-type="inline-math"/, "trusted generated child was sanitized away");
    assertNoExecutableMarkup(finalRendered, "root-capability-sibling-boundary");
    return { rendered: finalRendered };
  });

  check("enhanced-image-dangerous-url", () => {
    const editorHtml = renderMarkdownForEditor(
      '<figure data-lightmark-image data-align="left"><img src="javascript:alert(1)" alt="bad"></figure>',
    );
    assertNoExecutableMarkup(editorHtml, "enhanced-image-dangerous-url");
    return { editorHtml };
  });

  check("enhanced-image-valid-data-url", () => {
    const editorHtml = renderMarkdownForEditor(
      '<figure data-lightmark-image data-align="center"><img src="data:image/png;base64,aA==" alt="ok"></figure>',
    );
    assert.match(editorHtml, /data:image\/png;base64,aA==/i, "valid data image was removed");
    assertNoExecutableMarkup(editorHtml, "enhanced-image-valid-data-url");
    return { editorHtml };
  });

  const generatedFixtures = [
    ["generated-inline-math", "$x$", /data-type="inline-math"/],
    ["generated-frontmatter", "---\ntitle: x\n---\n\nbody", /data-type="front-matter"/],
    ["generated-mermaid", "```mermaid\nA-->B\n```", /data-type="mermaid"/],
    ["generated-toc", "[TOC]\n\n# Heading", /data-type="table-of-contents"/],
    ["generated-footnote", "reference[^a]\n\n[^a]: note", /data-type="footnote-ref"/],
    ["generated-task-item", "- [x] done", /data-task-item="checked"/],
  ];
  for (const [name, markdown, expected] of generatedFixtures) {
    check(name, () => {
      const editorHtml = renderMarkdownForEditor(markdown);
      assert.match(editorHtml, expected, `${name}: generated internal node disappeared`);
      assertNoExecutableMarkup(editorHtml, name);
      return { editorHtml };
    });
  }

  const previewFixtures = [
    ["preview-footnote-backrefs", "reference[^a]\n\n[^a]: note", /data-footnote-link="backref"/],
    ["preview-task-item", "- [x] done", /data-task-item="checked"/],
    ["preview-frontmatter", "---\ntitle: x\n---\n\nbody", /data-type="front-matter"/],
    ["preview-toc", "[TOC]\n\n# Heading", /data-type="table-of-contents"/],
  ];
  for (const [name, markdown, expected] of previewFixtures) {
    check(name, () => {
      const previewHtml = renderMarkdown(markdown);
      assert.match(previewHtml, expected, `${name}: generated preview node lost its internal attribute`);
      assertNoExecutableMarkup(previewHtml, name);
      return { previewHtml };
    });
  }

  check("preview-enhanced-image-dangerous-url", () => {
    const previewHtml = renderMarkdown(
      '<figure data-lightmark-image data-align="left"><img src="javascript:alert(1)" alt="bad"></figure>',
    );
    assertNoExecutableMarkup(previewHtml, "preview-enhanced-image-dangerous-url");
    return { previewHtml };
  });

  check("preview-enhanced-image-valid-data-url", () => {
    const previewHtml = renderMarkdown(
      '<figure data-lightmark-image data-align="center"><img src="data:image/png;base64,aA==" alt="ok"></figure>',
    );
    assert.match(previewHtml, /data:image\/png;base64,aA==/i, "valid preview data image was removed");
    assertNoExecutableMarkup(previewHtml, "preview-enhanced-image-valid-data-url");
    return { previewHtml };
  });

  check("placeholder-token-collision", () => {
    const editorHtml = renderMarkdownForEditor("`@@LIGHTMARK_PLACEHOLDER_0@@`");
    assert.match(editorHtml, /@@LIGHTMARK_PLACEHOLDER_0@@/, "user placeholder-shaped text was replaced");
    assert.match(editorHtml, /data-code-raw=/, "inline code editor metadata disappeared");
    return { editorHtml };
  });

  check("table-generated-internals", () => {
    const editorHtml = renderMarkdownForEditor("| formula | note |\n| --- | --- |\n| $x$ | reference[^a] |\n\n[^a]: footnote");
    assert.match(editorHtml, /data-type="inline-math"/, "table formula lost its editor node");
    assert.match(editorHtml, /data-type="footnote-ref"/, "table footnote lost its editor node");
    assertNoExecutableMarkup(editorHtml, "table-generated-internals");
    return { editorHtml };
  });

  check("internal-capability-contract", () => {
    const context = createInternalRenderContext();
    const otherContext = createInternalRenderContext();
    const original = '<span data-type="inline-math" data-tex="x"></span>';
    const marked = markInternalHtml(original, context);
    assert.equal(hasInternalHtmlCapability(marked, context), true, "marked app fragment was not recognized");
    assert.equal(hasInternalHtmlCapability(marked, otherContext), false, "capability crossed render contexts");
    assert.equal(
      hasInternalHtmlCapability('<span data-type="inline-math" data-tex="x"></span>', context),
      false,
      "data-type alone granted internal capability",
    );
    assert.equal(
      hasInternalHtmlCapability(
        `<span data-type="inline-math" data-lightmark-internal="${otherContext.token}"></span>`,
        context,
      ),
      false,
      "a token from another render context was accepted",
    );
    assert.equal(stripInternalHtmlCapability(marked, context), original, "capability was not removed after rendering");
    return { marked, tokenLength: context.token.length };
  });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const report = {
  status: failures.length > 0 ? "failed-security-regression" : "passed-security-regression",
  classification: "formal LM-011 renderer gate; exact per-render root capability required and stripped before editor output",
  failures,
  records,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;
