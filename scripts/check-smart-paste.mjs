import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(root, "node_modules", ".lightmark-smart-paste-"));

try {
  const source = fs.readFileSync(path.join(root, "src/utils/smartPaste.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(tempDir, "smartPaste.mjs");
  fs.writeFileSync(modulePath, output);
  const smartPaste = await import(pathToFileURL(modulePath).href);

  assert.equal(
    smartPaste.delimitedTextToMarkdownTable("姓名\t城市\r\n小明\t杭州\r\n小李\t上海\r\n"),
    "| 姓名 | 城市 |\n| --- | --- |\n| 小明 | 杭州 |\n| 小李 | 上海 |",
  );
  assert.equal(
    smartPaste.delimitedTextToMarkdownTable('Name,Note\nAlice,"hello, world"\nBob,"line 1\nline 2"'),
    "| Name | Note |\n| --- | --- |\n| Alice | hello, world |\n| Bob | line 1<br>line 2 |",
  );
  assert.equal(
    smartPaste.delimitedTextToMarkdownTable("A,B,C\n1,,3"),
    "| A | B | C |\n| --- | --- | --- |\n| 1 |  | 3 |",
  );
  assert.equal(
    smartPaste.delimitedTextToMarkdownTable("A,B\nback\\slash,x|y"),
    "| A | B |\n| --- | --- |\n| back\\\\slash | x\\|y |",
  );
  assert.equal(smartPaste.delimitedTextToMarkdownTable("hello, world\nsecond line"), null);
  assert.equal(smartPaste.delimitedTextToMarkdownTable("one\ttwo"), null);
  assert.equal(smartPaste.delimitedTextToMarkdownTable("A,B\n1,2,3"), null);
  assert.equal(smartPaste.delimitedTextToMarkdownTable('A,B\n1,"unfinished'), null);
  assert.equal(
    smartPaste.delimitedTextToMarkdownTable('A,B\n1,"tab\there"'),
    "| A | B |\n| --- | --- |\n| 1 | tab\there |",
  );

  const tableResult = smartPaste.prepareSmartPaste({ plainText: "A\tB\n1\t2", html: "", files: [] });
  assert.equal(tableResult.kind, "table");
  const markdownResult = smartPaste.prepareSmartPaste({ plainText: "# Heading", html: "", files: [] });
  assert.equal(markdownResult.kind, "markdown");
  const plainResult = smartPaste.prepareSmartPaste(
    { plainText: "**literal**", html: "<b>ignored</b>", files: [] },
    { plainText: true },
  );
  assert.equal(plainResult.kind, "plain");
  assert.equal(plainResult.markdown, "**literal**");
  assert.equal(smartPaste.plainTextToLiteralMarkdown("**literal**\n# heading\nA|B"), "\\*\\*literal\\*\\*\n\\# heading\nA\\|B");

  assert.match(source, /script,style,noscript,template,iframe,object,embed,form/);
  assert.match(source, /MsoListParagraph/);
  assert.match(source, /rowSpan/);
  assert.match(source, /colSpan/);
  assert.match(source, /\^https\?:/);
  assert.match(source, /无法安全保存的内嵌图片/);

  const wysiwyg = fs.readFileSync(path.join(root, "src/components/editor/WysiwygEditor.vue"), "utf8");
  const sourceEditor = fs.readFileSync(path.join(root, "src/components/editor/SourceEditor.vue"), "utf8");
  const largeEditor = fs.readFileSync(path.join(root, "src/components/editor/LargeMarkdownEditor.vue"), "utf8");
  assert.match(wysiwyg, /prepareSmartPaste\(clipboardPayloadFromDataTransfer/);
  assert.match(wysiwyg, /智能粘贴/);
  assert.match(wysiwyg, /纯文本粘贴/);
  assert.match(wysiwyg, /event\.shiftKey && event\.key\.toLowerCase\(\) === "v"/);
  assert.match(wysiwyg, /handleWysiwygPlainPasteCapture/);
  assert.match(wysiwyg, /new Slice\(Fragment\.fromArray\(paragraphs\)/);
  assert.match(wysiwyg, /plainTextToLiteralMarkdown\(node\.textContent/);
  assert.match(wysiwyg, /function plainPasteRanges/);
  assert.match(sourceEditor, /key:\s*"Mod-Shift-v"/);
  assert.match(sourceEditor, /handleSourcePlainPasteCapture/);
  assert.match(sourceEditor, /insertSmartPasteIntoSource/);
  assert.match(largeEditor, /@paste="handleLargePaste"/);
  assert.match(largeEditor, /@keydown\.ctrl\.shift\.v="pasteLargePlainText"/);
  console.log("Smart paste checks passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
