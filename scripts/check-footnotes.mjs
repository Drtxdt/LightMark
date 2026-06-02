import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourcePath = path.resolve("src/utils/markdown.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
}).outputText;

const tempPath = path.resolve(`scripts/.lightmark-markdown-${Date.now()}.mjs`);
fs.writeFileSync(tempPath, compiled, "utf8");

try {
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(tempPath).href);
  const sample = `## 九、脚注测试

这里有一个脚注引用。[^1]

这里有第二个脚注。[^long]

同一个脚注重复引用。[^1]

[^1]: 这是一个简单脚注。

[^long]: 

    这是一个较长的脚注。
    
    它应该支持：
    - 段落
    - 列表
    - **Markdown 样式**
    - \`inline code\`

脚注行为测试：

- 点击脚注编号应跳转到底部
- 点击返回按钮应回到原位置
- 编辑模式中脚注不应错位`;

  const editorHtml = renderMarkdownForEditor(sample);
  const previewHtml = renderMarkdown(sample);
  const checks = [
    [editorHtml.includes('data-type="footnote-ref"'), "editor footnote refs use stable node placeholders"],
    [(editorHtml.match(/data-footnote-ref="1"/g) || []).length === 2, "editor preserves duplicate [^1] refs"],
    [editorHtml.includes('data-ref-id="fnref-1-2"'), "editor creates second backref target"],
    [editorHtml.includes('data-type="footnotes"'), "editor renders footnote source block"],
    [editorHtml.includes("[^1]: 这是一个简单脚注。"), "editor preserves simple footnote source"],
    [editorHtml.includes("[^long]:"), "editor preserves long footnote source"],
    [!editorHtml.includes("@@LIGHTMARK_PLACEHOLDER_"), "editor restores nested placeholders inside footnotes"],
    [editorHtml.includes("`inline code`"), "editor preserves inline code source inside footnote definitions"],
    [previewHtml.includes('href="#fn-1"'), "preview links ref to footnote"],
    [previewHtml.includes('href="#fnref-1-2"'), "preview creates duplicate return links"],
    [previewHtml.includes("<strong>Markdown 样式</strong>"), "preview renders markdown inside long footnote"],
    [previewHtml.includes("<code>inline code</code>"), "preview renders inline code inside long footnote"],
  ];

  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length > 0) {
    console.error("footnote check failed:");
    failed.forEach((label) => console.error(`- ${label}`));
    process.exit(1);
  }

  console.log("footnote render check passed");
} finally {
  fs.rmSync(tempPath, { force: true });
}
