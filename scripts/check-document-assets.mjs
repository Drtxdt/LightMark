import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-assets-"));
try {
  const source = fs.readFileSync(path.join(root, "src/utils/documentAssets.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(tempDir, "documentAssets.mjs");
  fs.writeFileSync(modulePath, output);
  const assets = await import(pathToFileURL(modulePath).href);
  const markdown = [
    "---\ncover: hidden.png\n---",
    "![图](assets/a.png)",
    "[PDF](docs/a.pdf)",
    '<video src="media/demo.mp4"></video>',
    '<audio><source src="media/demo.ogg"></audio>',
    "![外部](https://example.com/a.jpg)",
    "`![代码](ignored.png)`",
    "```md\n![围栏](ignored-2.png)\n```",
    "$$ ignored.svg $$",
  ].join("\r\n");
  const references = assets.extractAssetReferences(markdown);
  assert.deepEqual(references.map((item) => item.kind), ["image", "pdf", "video", "audio", "image"]);
  assert.equal(references.at(-1).external, true);
  assert.ok(references.every((item) => markdown.slice(item.from, item.to) === item.source));
  const replaced = assets.replaceAssetReference(markdown, references[0], "assets/new.png");
  assert.match(replaced, /!\[图\]\(assets\/new\.png\)/);
  assert.equal(assets.replaceAssetReference(`${markdown}x`, references[0], "no.png")?.includes("no.png"), true);
  assert.equal(assets.replaceAssetReference(markdown.replace("assets/a.png", "changed.png"), references[0], "no.png"), null);

  const sidebar = fs.readFileSync(path.join(root, "src/components/layout/Sidebar.vue"), "utf8");
  const pane = fs.readFileSync(path.join(root, "src/components/layout/ResourcesPane.vue"), "utf8");
  const rust = fs.readFileSync(path.join(root, "src-tauri/src/commands/file.rs"), "utf8");
  assert.match(sidebar, /activePane === 'resources'/);
  assert.match(pane, /当前文档未引用/);
  assert.match(pane, /inspect_document_assets/);
  assert.match(pane, /该资源引用位置已经变化/);
  assert.match(rust, /resolve_asset_folder/);
  assert.match(rust, /不能包含“\.\.”/);
  assert.match(rust, /lightmark-asset-watch-event/);
  console.log("Document asset checks passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
