import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src", "editor", "sourceCompositionFence.ts");
const sourceEditorPath = path.join(root, "src", "components", "editor", "SourceEditor.vue");
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-source-composition-"));
try {
  const modulePath = path.join(tempDir, "sourceCompositionFence.mjs");
  fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText, "utf8");
  const { createSourceCompositionFence, isSourceEditorComposing } = await import(pathToFileURL(modulePath).href);
  const target = new EventTarget();
  const fence = createSourceCompositionFence();
  const detach = fence.attach(target);

  assert.equal(fence.isComposing(), false, "a new source view is not composing");
  assert.equal(fence.pendingEditVersion(), 0, "a new source view has no composition generation");
  assert.equal(isSourceEditorComposing({ compositionStarted: false, composing: false }, fence), false,
    "CodeMirror public getters report an idle source view");
  assert.equal(isSourceEditorComposing({ compositionStarted: true, composing: false }, fence), true,
    "compositionStarted blocks a snapshot before the first composition change");
  assert.equal(isSourceEditorComposing({ compositionStarted: false, composing: true }, fence), true,
    "CodeMirror composing blocks a snapshot after a composition change");
  target.dispatchEvent(new Event("compositionstart"));
  assert.equal(fence.isComposing(), true, "the view DOM compositionstart event blocks snapshots");
  assert.equal(fence.pendingEditVersion(), 1, "compositionstart advances the pending generation");
  target.dispatchEvent(new Event("compositionend"));
  assert.equal(fence.isComposing(), false, "the view DOM compositionend event releases the snapshot fence");
  assert.equal(fence.pendingEditVersion(), 2, "compositionend advances the boundary generation");

  target.dispatchEvent(new Event("compositionstart"));
  target.dispatchEvent(new Event("compositionstart"));
  assert.equal(fence.isComposing(), true, "nested composition starts remain pending");
  target.dispatchEvent(new Event("compositionend"));
  assert.equal(fence.isComposing(), true, "one nested end cannot release an active composition");
  target.dispatchEvent(new Event("compositionend"));
  assert.equal(fence.isComposing(), false, "the final composition end releases the fence");
  detach();
  target.dispatchEvent(new Event("compositionstart"));
  assert.equal(fence.isComposing(), false, "unmounted views no longer receive composition state");

  const sourceEditor = fs.readFileSync(sourceEditorPath, "utf8");
  const sourceComposition = fs.readFileSync(sourcePath, "utf8");
  assert.match(sourceEditor, /sourceCompositionFence\.attach\(view\.dom\)/u, "SourceEditor must bind the fence to the CodeMirror DOM");
  assert.match(sourceEditor, /isSourceEditorComposing\(activeEditor, sourceCompositionFence\)/u,
    "SourceEditor must combine CodeMirror public composition getters with the DOM fence");
  assert.match(sourceComposition, /editor\?\.compositionStarted\s*\|\|\s*editor\?\.composing/u,
    "the composition helper must read CodeMirror's public composition getters");
  console.log("source composition fence checks passed (CodeMirror public state and DOM fallback wiring)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
