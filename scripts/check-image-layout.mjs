import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-images-"));
try {
  const source = fs.readFileSync(path.join(root, "src/utils/enhancedImages.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(tempDir, "enhancedImages.mjs");
  fs.writeFileSync(modulePath, output);
  const images = await import(pathToFileURL(modulePath).href);

  assert.equal(images.clampImageWidth(1), 48);
  assert.equal(images.clampImageWidth(5000), 4096);
  assert.equal(images.clampImageWidth("640"), 640);
  assert.equal(images.clampImageWidth("bad"), null);
  assert.equal(images.clampImageWidth(null), null);
  assert.equal(images.clampImageWidth(""), null);
  const standard = images.imageMarkdownOrFigure({
    src: "assets/图 片.png", alt: "替代", title: null, widthPx: null, alignment: "left", caption: "",
  });
  assert.equal(standard, "![替代](assets/图 片.png)");
  const figure = images.imageMarkdownOrFigure({
    src: "assets/demo.png", alt: "替代", title: "提示", widthPx: 640, alignment: "center", caption: "独立标题",
  });
  assert.match(figure, /data-lightmark-image/);
  assert.match(figure, /data-align="center"/);
  assert.match(figure, /width="640"/);
  assert.match(figure, /<figcaption>独立标题<\/figcaption>/);
  const editor = images.enhanceImagesForEditor(figure);
  assert.match(editor, /data-lightmark-width="640"/);
  assert.match(editor, /data-lightmark-caption="独立标题"/);
  const pandoc = images.enhancedImagesForPandoc(figure);
  assert.match(pandoc, /\{width=640px\}/);
  assert.match(pandoc, /text-align: center/);
  const preview = images.protectEnhancedImagesForPreview(figure, (value) => `STASH(${value})`);
  assert.match(preview, /^STASH\(<figure data-lightmark-image/);
  assert.equal(images.unwrapEnhancedImageParagraphs(`<p>${figure}</p>`), figure);

  const wysiwyg = fs.readFileSync(path.join(root, "src/components/editor/WysiwygEditor.vue"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src/styles/index.css"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/utils/html.ts"), "utf8");
  assert.match(wysiwyg, /typora-image-toolbar/);
  assert.match(wysiwyg, /typora-image-resize-\$\{direction/);
  assert.match(wysiwyg, /setMeta\("addToHistory", false\)/);
  assert.match(styles, /\.typora-image-node-editing \.typora-image-toolbar/);
  assert.match(styles, /max-width:\s*100%/);
  assert.match(html, /"figure"/);
  assert.match(html, /"figcaption"/);
  assert.match(html, /"margin-left"/);
  console.log("Image layout checks passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
