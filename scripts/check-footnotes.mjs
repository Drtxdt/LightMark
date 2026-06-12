import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/markdown.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const htmlSourcePath = path.resolve("src/utils/html.ts");
const htmlSource = fs.readFileSync(htmlSourcePath, "utf8");
const timestamp = Date.now();
const tempDir = path.resolve(`scripts/.lightmark-check-${timestamp}`);
fs.mkdirSync(tempDir, { recursive: true });
const htmlTempPath = path.join(tempDir, `.lightmark-html-${timestamp}.mjs`);
const tempPath = path.join(tempDir, `.lightmark-markdown-${timestamp}.mjs`);
const htmlCompiled = ts.transpileModule(htmlSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
}).outputText;
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
}).outputText.replace('from "./html";', `from "./${path.basename(htmlTempPath)}";`);

fs.writeFileSync(htmlTempPath, htmlCompiled, "utf8");
fs.writeFileSync(tempPath, compiled, "utf8");

try {
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(tempPath).href);
  const sample = `## 九、脚注测试

这里有一个脚注引用。[^1]

这里有第二个脚注。[^long]

[^long]: 

    这是一个较长的脚注。
    
    它应该支持：
    - 段落
    - 列表
    - **Markdown 样式**
    - *斜体样式*
    - [链接](https://example.com)
    - \`inline code\`

    \`\`\`ts
    const answer = 42
    \`\`\`

同一个脚注重复引用。[^1]

这里有一个没有定义回收的脚注。[^missing]

脚注行为测试：

- 点击脚注编号应跳转到底部
- 点击返回按钮应回到原位置
- 编辑模式中脚注不应错位

[^1]: 这是一个简单脚注。`;
  const adjacentDefinitions = `正文。[^a]

[^a]: 第一个脚注。

[^b]: 第二个脚注。

继续正文。[^b]`;
  const inlineHtmlSample = `这里有 <span style="color:red; background-image:url(javascript:alert(1))" onclick="alert(1)">红色</span> 文本。

<u>下划线</u> 和 <kbd>Ctrl</kbd>。

<b>HTML 加粗里有 *Markdown 斜体*</b>

HTML 内含公式：<span>$a^2 + b^2 = c^2$</span>

危险链接 <a href="javascript:alert(1)">x</a>。

<script>alert(1)</script>`;
  const blockHtmlSample = `<div>
这是 div 内部的普通文本。

这里有 <span style="color:purple;">紫色 span</span>。
</div>

段落后面继续正常 Markdown。`;
  const horizontalRuleSample = `上文

---

下文`;
  const githubAlertSample = `> [!NOTE]
> 这是 **Note** 内容。

> [!WARNING]
> 第一行
> 第二行带 $E = mc^2$。

> [!CAUTION]
> 小心 <span style="color:red;">HTML</span>。`;
  const blockquoteSample = `> 普通引用

> [!NOTE]
> 提示内容`;
  const githubAlertSingleBodySample = `> [!NOTE]
> ddd`;
  const githubAlertMarkerBodySample = `> [!NOTE]
> [!TIP]
> 这里的 TIP 标记只是正文`;
  const rawHtmlSample = `输入框：<input type="checkbox" checked>

未闭合标签测试：<span style="color:red;">这里没有闭合

<!-- this is a comment -->

代码里的公式：\`$E = mc^2$\`

<pre>
function hello() {
  console.log("Hello from pre");
}
</pre>`;

  const editorHtml = renderMarkdownForEditor(sample);
  const previewHtml = renderMarkdown(sample);
  const adjacentEditorHtml = renderMarkdownForEditor(adjacentDefinitions);
  const inlineEditorHtml = renderMarkdownForEditor(inlineHtmlSample);
  const inlinePreviewHtml = renderMarkdown(inlineHtmlSample);
  const blockEditorHtml = renderMarkdownForEditor(blockHtmlSample);
  const blockPreviewHtml = renderMarkdown(blockHtmlSample);
  const horizontalEditorHtml = renderMarkdownForEditor(horizontalRuleSample);
  const horizontalPreviewHtml = renderMarkdown(horizontalRuleSample);
  const alertEditorHtml = renderMarkdownForEditor(githubAlertSample);
  const alertPreviewHtml = renderMarkdown(githubAlertSample);
  const blockquoteEditorHtml = renderMarkdownForEditor(blockquoteSample);
  const blockquotePreviewHtml = renderMarkdown(blockquoteSample);
  const singleBodyAlertEditorHtml = renderMarkdownForEditor(githubAlertSingleBodySample);
  const markerBodyAlertEditorHtml = renderMarkdownForEditor(githubAlertMarkerBodySample);
  const markerBodyAlertPreviewHtml = renderMarkdown(githubAlertMarkerBodySample);
  const rawEditorHtml = renderMarkdownForEditor(rawHtmlSample);
  const rawPreviewHtml = renderMarkdown(rawHtmlSample);
  const examplePath = path.resolve("example/inline-html-test.md");
  const exampleMarkdown = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, "utf8") : "";
  const exampleEditorHtml = exampleMarkdown ? renderMarkdownForEditor(exampleMarkdown) : "";
  const examplePreviewHtml = exampleMarkdown ? renderMarkdown(exampleMarkdown) : "";
  const previewFootnoteItems = previewHtml.match(/class="footnote-item"/g) || [];
  const longDefinitionPosition = previewHtml.indexOf('id="fn-long"');
  const repeatedReferencePosition = previewHtml.indexOf("同一个脚注重复引用");
  const missingDefinitionPosition = previewHtml.indexOf('id="fn-missing"');
  const simpleDefinitionPosition = previewHtml.indexOf('id="fn-1"');
  const checks = [
    [editorHtml.includes('data-type="footnote-ref"'), "editor footnote refs use stable node placeholders"],
    [(editorHtml.match(/data-footnote-ref="1"/g) || []).length === 2, "editor preserves duplicate [^1] refs"],
    [editorHtml.includes('data-ref-id="fnref-1-2"'), "editor creates second backref target"],
    [editorHtml.includes('data-type="footnotes"'), "editor renders footnote source block"],
    [editorHtml.includes("[^1]: 这是一个简单脚注。"), "editor preserves simple footnote source"],
    [editorHtml.includes("[^long]:"), "editor preserves long footnote source"],
    [editorHtml.includes("[^missing]:"), "editor appends missing footnote definition source"],
    [adjacentEditorHtml.includes("[^a]: 第一个脚注。"), "editor preserves first adjacent footnote definition"],
    [adjacentEditorHtml.includes("[^b]: 第二个脚注。"), "editor preserves second adjacent footnote definition"],
    [!adjacentEditorHtml.includes("[^a]: 第一个脚注。 [^b]:"), "editor keeps adjacent footnote definitions separated"],
    [!editorHtml.includes("@@LIGHTMARK_PLACEHOLDER_"), "editor restores nested placeholders inside footnotes"],
    [editorHtml.includes("`inline code`"), "editor preserves inline code source inside footnote definitions"],
    [previewHtml.includes('href="#fn-1"'), "preview links ref to footnote"],
    [previewHtml.includes('class="footnotes-list"'), "preview footnotes use block list layout"],
    [previewFootnoteItems.length === 3, "preview renders each footnote as a separate item"],
    [longDefinitionPosition > -1 && longDefinitionPosition < repeatedReferencePosition, "preview renders inline footnote definition in place"],
    [missingDefinitionPosition > simpleDefinitionPosition, "preview appends missing footnote definition at document end"],
    [previewHtml.includes('<span class="footnote-id">[1]</span>'), "preview renders first footnote number"],
    [previewHtml.includes('<span class="footnote-id">[2]</span>'), "preview renders second footnote number"],
    [previewHtml.includes('<span class="footnote-id">[3]</span>'), "preview renders missing footnote number"],
    [previewHtml.includes('href="#fnref-1-1" class="footnote-backref" data-footnote-link="backref">返回1</a>'), "preview creates first numbered backref"],
    [previewHtml.includes('href="#fnref-1-2"'), "preview creates duplicate return links"],
    [previewHtml.includes('href="#fnref-1-2" class="footnote-backref" data-footnote-link="backref">返回2</a>'), "preview creates second numbered backref"],
    [previewHtml.includes('href="#fnref-long-1" class="footnote-backref" data-footnote-link="backref">返回1</a>'), "preview creates numbered backref for single-use long footnote"],
    [previewHtml.includes('href="#fnref-missing-1" class="footnote-backref" data-footnote-link="backref">返回1</a>'), "preview creates numbered backref for missing footnote"],
    [previewHtml.includes("<strong>Markdown 样式</strong>"), "preview renders markdown inside long footnote"],
    [previewHtml.includes("<em>斜体样式</em>"), "preview renders italic inside long footnote"],
    [previewHtml.includes('href="https://example.com"'), "preview renders links inside long footnote"],
    [previewHtml.includes("<code>inline code</code>"), "preview renders inline code inside long footnote"],
    [previewHtml.includes('class="hljs language-ts"'), "preview renders fenced code inside long footnote"],
    [inlineEditorHtml.includes('data-type="inline-html"'), "editor protects inline html as placeholders"],
    [inlineEditorHtml.includes('data-html="&lt;span style=&quot;color: red&quot;&gt;红色&lt;/span&gt;"'), "editor stores inline html with single-escaped data-html"],
    [!inlineEditorHtml.includes("&amp;lt;span"), "editor does not double-escape inline html placeholders"],
    [inlineEditorHtml.includes("color: red"), "editor preserves safe inline styles"],
    [!inlineEditorHtml.includes("onclick"), "editor removes inline event handlers"],
    [!inlineEditorHtml.includes("background-image"), "editor removes unsafe style declarations"],
    [inlinePreviewHtml.includes("<u>下划线</u>"), "preview renders safe inline html"],
    [inlinePreviewHtml.includes("<kbd>Ctrl</kbd>"), "preview renders keyboard inline html"],
    [inlinePreviewHtml.includes("<b>HTML 加粗里有 <em>Markdown 斜体</em></b>"), "preview renders markdown emphasis inside inline html"],
    [inlineEditorHtml.includes("$a^2 + b^2 = c^2$"), "editor preserves math source inside inline html"],
    [inlinePreviewHtml.includes("katex") && inlinePreviewHtml.includes("a^2"), "preview renders math inside inline html"],
    [!inlinePreviewHtml.includes("javascript:"), "preview removes dangerous javascript urls"],
    [!inlinePreviewHtml.includes("<script>"), "preview does not emit executable script tags"],
    [blockEditorHtml.includes('data-type="html-block"'), "editor protects block html as block node"],
    [blockEditorHtml.includes("段落后面继续正常 Markdown"), "editor does not swallow content after block html"],
    [blockPreviewHtml.includes('style="color: purple"'), "preview renders safe styles inside block html"],
    [blockPreviewHtml.includes("<p>段落后面继续正常 Markdown。</p>"), "preview keeps markdown after block html outside html block"],
    [horizontalEditorHtml.includes("<hr"), "editor renders markdown horizontal rules"],
    [horizontalPreviewHtml.includes("<hr"), "preview renders markdown horizontal rules"],
    [alertEditorHtml.includes('class="markdown-alert markdown-alert-note"'), "editor renders GitHub note alert class"],
    [alertEditorHtml.includes('data-alert="warning"'), "editor preserves GitHub alert kind"],
    [!alertEditorHtml.includes("markdown-alert-title"), "editor does not render GitHub alert titles as editable content"],
    [!alertEditorHtml.includes("<p>Note</p>") && !alertPreviewHtml.includes("<p>Note</p>"), "GitHub alert title is not stored as body text"],
    [alertEditorHtml.includes("<strong>Note</strong>"), "editor renders markdown inside GitHub alerts"],
    [alertPreviewHtml.includes('class="markdown-alert markdown-alert-caution"'), "preview renders GitHub caution alert class"],
    [alertPreviewHtml.includes("katex") && alertPreviewHtml.includes("E = mc"), "preview renders math inside GitHub alerts"],
    [alertPreviewHtml.includes('style="color: red"'), "preview renders safe inline html inside GitHub alerts"],
    [blockquoteEditorHtml.includes("<blockquote>") && blockquoteEditorHtml.includes("普通引用"), "editor renders ordinary blockquotes"],
    [blockquotePreviewHtml.includes("<blockquote>") && blockquotePreviewHtml.includes("普通引用"), "preview renders ordinary blockquotes"],
    [blockquoteEditorHtml.includes('class="markdown-alert markdown-alert-note"'), "editor renders GitHub alert after ordinary blockquote"],
    [(blockquoteEditorHtml.match(/markdown-alert-title/g) || []).length === 0, "GitHub alerts do not render editable title placeholders"],
    [!blockquoteEditorHtml.includes("[!NOTE]") && !blockquotePreviewHtml.includes("[!NOTE]"), "GitHub alert markers are hidden after render"],
    [(singleBodyAlertEditorHtml.match(/ddd/g) || []).length === 1, "GitHub alert body renders exactly once"],
    [!singleBodyAlertEditorHtml.includes("<p>Note</p>"), "GitHub alert single body does not receive a title paragraph"],
    [markerBodyAlertEditorHtml.includes('markdown-alert-note') && !markerBodyAlertEditorHtml.includes('markdown-alert-tip'), "GitHub alert body marker does not override editor alert kind"],
    [markerBodyAlertPreviewHtml.includes('markdown-alert-note') && !markerBodyAlertPreviewHtml.includes('markdown-alert-tip'), "GitHub alert body marker does not override preview alert kind"],
    [markerBodyAlertEditorHtml.includes("[!TIP]") && markerBodyAlertPreviewHtml.includes("[!TIP]"), "GitHub alert body marker remains plain text"],
    [rawEditorHtml.includes('data-type="raw-html"'), "editor preserves unsupported html as raw placeholders"],
    [rawEditorHtml.includes('&lt;input type=&quot;checkbox&quot; checked&gt;'), "editor stores raw input source"],
    [rawEditorHtml.includes('&lt;!-- this is a comment --&gt;'), "editor stores html comments as raw source"],
    [rawPreviewHtml.includes("raw-html-token") && rawPreviewHtml.includes("&lt;input"), "preview renders unsupported input as muted raw html"],
    [rawPreviewHtml.includes("raw-html-comment") && rawPreviewHtml.includes("&lt;!-- this is a comment --&gt;"), "preview renders html comments as muted comments"],
    [rawPreviewHtml.includes("&lt;span style=\"color:red;\"&gt;这里没有闭合"), "preview keeps unclosed tags as raw html"],
    [rawEditorHtml.includes("<code>$E = mc^2$</code>"), "editor keeps dollar math inside inline code"],
    [!rawEditorHtml.includes('data-tex="E = mc^2"'), "editor does not convert inline-code math to math node"],
    [rawPreviewHtml.includes("<code>$E = mc^2$</code>"), "preview keeps dollar math inside inline code"],
    [rawEditorHtml.includes("console.log(&quot;Hello from pre&quot;);"), "editor html block stores quotes with one attribute escape"],
    [!rawEditorHtml.includes("&amp;quot;") && !rawPreviewHtml.includes("&amp;quot;"), "html block rendering does not amplify quote entities"],
    [!exampleEditorHtml || exampleEditorHtml.includes('data-type="inline-html"'), "example renders inline html as editor placeholders"],
    [!exampleEditorHtml || !/&amp;(?:amp;)*lt;span/.test(exampleEditorHtml), "example editor html does not repeatedly escape spans"],
    [!examplePreviewHtml || !/&amp;(?:amp;)*lt;span/.test(examplePreviewHtml), "example preview html does not repeatedly escape spans"],
    [!examplePreviewHtml || examplePreviewHtml.includes("<b>HTML 加粗</b>"), "example preview renders inline bold html"],
    [!examplePreviewHtml || examplePreviewHtml.includes("<code>$E = mc^2$</code>"), "example preview keeps code math as inline code"],
    [!examplePreviewHtml || examplePreviewHtml.includes("raw-html-comment"), "example preview renders html comments safely"],
    [!examplePreviewHtml || !/\s(?:href|src|action)=["']javascript:/i.test(examplePreviewHtml), "example preview removes dangerous javascript urls"],
    [!examplePreviewHtml || !examplePreviewHtml.includes("<script"), "example preview does not emit script tags"],
  ];

  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length > 0) {
    console.error("footnote check failed:");
    failed.forEach((label) => console.error(`- ${label}`));
    throw new Error("footnote render check failed");
  }

  console.log("footnote render check passed");
} finally {
  fs.rmSync(tempPath, { force: true });
  fs.rmSync(htmlTempPath, { force: true });
  fs.rmSync(tempDir, { force: true, recursive: true });
}
