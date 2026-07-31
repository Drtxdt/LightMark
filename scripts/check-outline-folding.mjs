import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src", "utils", "outline.ts");
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-outline-folding-"));
const tempPath = path.join(tempDir, "outline.mjs");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

try {
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  fs.writeFileSync(tempPath, transpiled, "utf8");
  const {
    extractOutlineWithLines,
    reconcileCollapsedKeys,
    resolveActiveOutlineItem,
    resolveHeadingSection,
    structureOutline,
    visibleOutlineItems,
  } = await import(pathToFileURL(tempPath).href);

  const markdown = [
    "---",
    "title: '# hidden'",
    "---",
    "# Chapter",
    "intro",
    "### Skipped",
    "body",
    "#### Deep",
    "deep body",
    "```md",
    "##### fenced",
    "```",
    "$$",
    "###### math",
    "$$",
    "## Repeat",
    "one",
    "## Repeat",
    "two",
    "# Ending",
    "tail",
  ].join("\r\n");
  const raw = extractOutlineWithLines(markdown);
  const outline = structureOutline(raw, markdown.split(/\r?\n/).length);

  assert.deepEqual(outline.map((item) => [item.text, item.level, item.line]), [
    ["Chapter", 1, 3],
    ["Skipped", 3, 5],
    ["Deep", 4, 7],
    ["Repeat", 2, 15],
    ["Repeat", 2, 17],
    ["Ending", 1, 19],
  ]);
  assert.equal(outline[0].parentKey, null);
  assert.equal(outline[1].parentKey, outline[0].key);
  assert.equal(outline[2].parentKey, outline[1].key);
  assert.notEqual(outline[3].key, outline[4].key, "duplicate sibling headings need stable ordinals");
  assert.equal(outline[0].sectionEndLine, 19);
  assert.equal(outline[1].sectionEndLine, 15);
  assert.equal(outline[2].sectionEndLine, 15);
  assert.equal(resolveActiveOutlineItem(outline, 8)?.text, "Deep");
  assert.equal(resolveHeadingSection(outline, 16)?.text, "Repeat");
  assert.deepEqual(
    visibleOutlineItems(outline, [outline[0].key]).map((item) => item.text),
    ["Chapter", "Ending"],
  );
  assert.deepEqual(reconcileCollapsedKeys(outline, [outline[0].key, "stale"]), [outline[0].key]);

  const shifted = structureOutline(
    extractOutlineWithLines(`preface\n${markdown}`),
    markdown.split(/\r?\n/).length + 1,
  );
  assert.equal(shifted[0].key, outline[0].key, "line insertions must not change structural keys");

  const sidebar = read("src/components/layout/Sidebar.vue");
  const source = read("src/components/editor/SourceEditor.vue");
  const wysiwyg = read("src/components/editor/WysiwygEditor.vue");
  const store = read("src/stores/appStore.ts");
  const command = read("src/components/command/CommandPalette.vue");
  const rust = read("src-tauri/src/commands/models.rs");

  assert.match(sidebar, /visibleOutlineItems/);
  assert.match(sidebar, /activeOutlineItem/);
  assert.match(sidebar, /全部折叠/);
  assert.doesNotMatch(sidebar, /switchMode\("wysiwyg"\)/);
  assert.match(source, /sourceHeadingFoldField/);
  assert.match(source, /cm-heading-fold-gutter/);
  assert.match(wysiwyg, /lm-heading-fold-hidden/);
  assert.match(wysiwyg, /captureWysiwygScrollAnchor/);
  assert.match(store, /paneOutlineAnchorLines/);
  assert.match(store, /collapsedOutlineKeys/);
  assert.match(store, /collapsedHeadingKeys/);
  assert.match(command, /折叠\/展开当前标题/);
  assert.match(rust, /collapsed_outline_keys/);
  assert.match(rust, /collapsed_heading_keys/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("outline folding checks passed");
