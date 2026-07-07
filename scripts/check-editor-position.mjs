import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src", "utils", "editorPosition.ts");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmark-editor-position-"));
const tempPath = path.join(tempDir, "editorPosition.mjs");

try {
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  fs.writeFileSync(tempPath, transpiled, "utf8");

  const {
    clampMarkdownPosition,
    mergeEditorPosition,
    normalizeScrollSnapshot,
  } = await import(pathToFileURL(tempPath).href);

  assert.deepEqual(clampMarkdownPosition({ markdownAnchor: 99, markdownHead: -4 }, 12), {
    markdownAnchor: 12,
    markdownHead: 0,
  });

  assert.deepEqual(normalizeScrollSnapshot(250, 1000, 500), {
    scrollTop: 250,
    scrollRatio: 0.5,
  });

  assert.deepEqual(normalizeScrollSnapshot(900, 1000, 500), {
    scrollTop: 500,
    scrollRatio: 1,
  });

  const merged = mergeEditorPosition(
    {
      editorMode: "source",
      markdownAnchor: 10,
      markdownHead: 10,
      markdownLine: 2,
      markdownColumn: 3,
      markdownLineText: "hello",
      scrollTop: 120,
      scrollRatio: 0.2,
      updatedAt: 1,
    },
    {
      markdownAnchor: 15,
      scrollTop: 240,
      updatedAt: 2,
    },
    20,
  );
  assert.equal(merged.markdownAnchor, 15);
  assert.equal(merged.markdownHead, 10);
  assert.equal(merged.scrollTop, 240);
  assert.equal(merged.updatedAt, 2);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
