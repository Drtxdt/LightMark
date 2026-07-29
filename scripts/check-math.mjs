import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-math-"));

try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/utils/mathMarkdown.ts"), tempDir);
  const {
    mathTokenFromParts,
    evaluateMarkdownMath,
    extractMathMacroDefinitions,
    parseMarkdownMath,
    preparePandocMath,
    renderMathToken,
    serializeMathToken,
    validateMathToken,
  } = await import(pathToFileURL(compiled).href);

  const inlineCases = [
    ["$x$", ["x"]],
    ["$ x$", []],
    ["$x $", []],
    ["$x$2", []],
    ["$20,000 and $30,000", []],
    ["USD $5", []],
    ["\\$x$", []],
    ["`$x$`", []],
    ["``$x$``", []],
    ["a $x\\$$ b", ["x\\$"]],
    ["a $$x$$ b", ["x"]],
    ["中文$x$正文", ["x"]],
    ["$5 and $x$", ["x"]],
    ["\\(a+b\\)", ["a+b"]],
  ];
  for (const [source, expected] of inlineCases) {
    assert.deepEqual(parseMarkdownMath(source).tokens.map((token) => token.tex), expected, source);
  }

  const protectedSource = [
    "---",
    "price: $5$",
    "---",
    "```md",
    "$code$",
    "```",
    "~~~",
    "$tilde$",
    "~~~",
    "<div>",
    "$html$",
    "</div>",
    "real $x$",
  ].join("\n");
  assert.deepEqual(parseMarkdownMath(protectedSource).tokens.map((token) => token.tex), ["x"]);

  const display = "$$\n  x + y  \n$$";
  const displayToken = parseMarkdownMath(display).tokens[0];
  assert.equal(displayToken.delimiter, "display-dollar");
  assert.equal(displayToken.tex, "  x + y  ");
  assert.equal(displayToken.raw, display);
  assert.equal(serializeMathToken(displayToken), display);

  const bracket = "\\[\r\nx^2\r\n\\]";
  const bracketToken = parseMarkdownMath(bracket).tokens[0];
  assert.equal(bracketToken.delimiter, "display-bracket");
  assert.equal(bracketToken.tex, "x^2");
  assert.equal(serializeMathToken(bracketToken), bracket);

  const environment = "\\begin{align}\na &= b\n\\end{align}";
  const environmentToken = parseMarkdownMath(environment).tokens[0];
  assert.equal(environmentToken.delimiter, "environment");
  assert.equal(environmentToken.tex, environment);

  const missing = parseMarkdownMath("before\n$$\nx + y");
  assert.equal(missing.tokens.length, 0);
  assert.match(missing.diagnostics[0].message, /缺少结束分隔符/);

  const valid = mathTokenFromParts({ tex: "\\frac{1}{2}", delimiter: "inline-dollar" });
  assert.equal(validateMathToken(valid), null);
  assert.equal(renderMathToken(valid).ok, true);

  const invalid = mathTokenFromParts({ tex: "\\frac{", delimiter: "inline-dollar" });
  const diagnostic = validateMathToken(invalid);
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /^公式语法错误：/);
  assert.equal(renderMathToken(invalid).ok, false);

  const sequentialMacros = [
    "Before: $x \\in \\RR$",
    "$$",
    "\\newcommand{\\RR}{\\mathbb{R}}",
    "$$",
    "After: $x \\in \\RR$",
    "Argument: $\\def\\sq#1{#1^2}\\sq{y}$",
  ].join("\n");
  const macroEvaluation = evaluateMarkdownMath(sequentialMacros);
  assert.equal(macroEvaluation.entries.length, 4);
  assert.equal(macroEvaluation.entries[0].result.ok, false, "definition must not apply backwards");
  assert.equal(macroEvaluation.entries[1].result.ok, true);
  assert.equal(macroEvaluation.entries[1].definitionOnly, true);
  assert.deepEqual(macroEvaluation.entries[1].definedMacroNames, ["\\RR"]);
  assert.equal(macroEvaluation.entries[2].result.ok, true, "definition must apply to later math");
  assert.deepEqual(macroEvaluation.entries[2].availableMacroNames, ["\\RR"]);
  assert.equal(macroEvaluation.entries[3].result.ok, true, "argument macros work in the defining formula");
  assert.deepEqual(macroEvaluation.macroNames, ["\\RR", "\\sq"]);

  const invalidDefinition = evaluateMarkdownMath([
    "$\\newcommand{\\broken}[1]{#1$",
    "$\\broken{x}$",
  ].join("\n"));
  assert.equal(invalidDefinition.entries[0].result.ok, false);
  assert.equal(invalidDefinition.entries[1].result.ok, false, "invalid definitions must not poison later context");
  assert.ok(
    invalidDefinition.entries[0].diagnostic.to > invalidDefinition.entries[0].diagnostic.from,
    "end-of-input macro errors need a visible source range",
  );
  assert.deepEqual(invalidDefinition.macroNames, []);

  const isolated = evaluateMarkdownMath("$x \\in \\RR$");
  assert.equal(isolated.entries[0].result.ok, false, "document contexts must be isolated");

  const chemistry = evaluateMarkdownMath([
    "$\\ce{H2O}$",
    "$\\ce{2H2 + O2 -> 2H2O}$",
    "$\\ce{^{227}_{90}Th+}$",
    "$\\pu{1.23e4 J mol-1}$",
    "$\\ce{CH4 + 2 $\\left( O2 + 79/21 N2 \\right)$}$",
  ].join("\n"));
  assert.equal(chemistry.entries.every((entry) => entry.result.ok), true);
  assert.equal(chemistry.usesMhchem, true);
  assert.equal(
    chemistry.entries.at(-1).token.raw,
    "$\\ce{CH4 + 2 $\\left( O2 + 79/21 N2 \\right)$}$",
    "mhchem nested math dollars must not terminate the outer Markdown formula",
  );

  const recursive = evaluateMarkdownMath("$\\def\\loop{\\loop}\\loop$");
  assert.equal(recursive.entries[0].result.ok, false);
  assert.match(recursive.diagnostics[0].message, /expand|扩展|loop/i);

  assert.deepEqual(
    extractMathMacroDefinitions("\\def\\a#1{#1}\\gdef\\b{x}\\newcommand{\\cc}[2]{#1+#2}").map((item) => item.name),
    ["\\a", "\\b", "\\cc"],
  );

  const pandocPrepared = preparePandocMath([
    "$$",
    "\\newcommand{\\RR}{\\mathbb{R}}",
    "$$",
    "$x \\in \\RR$ and $\\ce{H2O}$",
  ].join("\n"));
  assert.match(pandocPrepared.markdown, /\\globaldefs=1\s+\\newcommand/);
  assert.match(pandocPrepared.latexHeader, /usepackage\[version=4\]\{mhchem\}/);
  assert.match(pandocPrepared.latexHeader, /providecommand\{\\pu\}\[1\]\{\\ce\{#1\}\}/);
  assert.deepEqual(pandocPrepared.macroNames, ["\\RR"]);

  const numbered = evaluateMarkdownMath([
    "$\\ref{later}$",
    "$$",
    "x=1\\label{first}",
    "$$",
    "$$",
    "y=2\\tag{A}\\label{later}",
    "$$",
    "$$",
    "z=3\\label{third}",
    "$$",
  ].join("\n"), { numberingMode: "all-display" });
  assert.deepEqual(numbered.equations.map((item) => item.display), ["1", "A", "3"]);
  assert.equal(numbered.references[0].display, "A", "forward references resolve in the second pass");
  assert.match(numbered.entries[0].result.html, /math-ref-link/);
  assert.match(numbered.entries[1].result.html, /tag/);
  assert.equal(numbered.labels.length, 3);

  const numberingOff = evaluateMarkdownMath("$$\nx=1\\label{x}\n$$");
  assert.equal(numberingOff.equations.length, 1);
  assert.equal(numberingOff.equations[0].display, "");
  assert.match(numberingOff.diagnostics[0].message, /没有编号/);

  const ams = evaluateMarkdownMath([
    "$$",
    "x=1",
    "$$",
    "\\begin{equation}",
    "y=2\\label{eq:y}",
    "\\end{equation}",
    "\\begin{align*}",
    "z&=3",
    "\\end{align*}",
  ].join("\n"), { numberingMode: "ams-block" });
  assert.deepEqual(ams.equations.map((item) => item.display), ["", "1", ""]);

  const duplicate = evaluateMarkdownMath([
    "$$",
    "x=1\\tag{X}\\label{dup}",
    "$$",
    "$$",
    "y=2\\tag{Y}\\label{dup}",
    "$$",
    "$\\ref{missing}$",
  ].join("\n"));
  assert.equal(duplicate.labels[1].duplicate, true);
  assert.match(duplicate.diagnostics.map((item) => item.message).join("\n"), /重复/);
  assert.match(duplicate.diagnostics.map((item) => item.message).join("\n"), /未找到/);

  const semanticEdges = evaluateMarkdownMath([
    "$\\label{inline}x$",
    "$$",
    "x=1\\tag{A}\\tag{B}\\label{}\\label{one}\\label{two}",
    "$$",
    "$\\ref{two}$",
  ].join("\n"));
  const semanticMessages = semanticEdges.diagnostics.map((item) => item.message).join("\n");
  assert.match(semanticMessages, /只能用于块级公式/);
  assert.match(semanticMessages, /只能包含一个/);
  assert.match(semanticMessages, /不能为空/);
  assert.equal(semanticEdges.references[0].display, "A");
  assert.deepEqual(semanticEdges.equations[0].labels, ["one", "two"]);

  const numberedPandoc = preparePandocMath("$$\nx=1\\label{x}\n$$\n$\\ref{x}$", {
    numberingMode: "all-display",
  });
  assert.match(numberedPandoc.markdown, /\\tag\{1\}/);
  assert.match(numberedPandoc.markdown, /\\label\{x\}/);
  assert.match(numberedPandoc.markdown, /\\ref\{x\}/);
  assert.throws(
    () => preparePandocMath("$\\ref{missing}$", { numberingMode: "all-display" }),
    /missing/,
  );

  assert.equal(
    serializeMathToken(
      mathTokenFromParts({ tex: "x", delimiter: "inline-paren", raw: "\\(x\\)" }),
      "y",
      false,
    ),
    "\\(y\\)",
  );

  const compiledMarkdown = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(compiledMarkdown).href);
  assert.match(renderMarkdown("中文$x$正文"), /class="katex"/);
  assert.doesNotMatch(renderMarkdown("价格是 $20,000 and $30,000"), /class="katex"/);
  assert.doesNotMatch(renderMarkdown("`$x$`"), /class="katex"/);
  assert.match(renderMarkdown("错误 $\\frac{$"), /math-render-error/);
  const editorMath = renderMarkdownForEditor("before \\( a+b \\) after");
  assert.match(editorMath, /data-math-delimiter="inline-paren"/);
  assert.match(editorMath, /data-math-raw="\\\( a\+b \\\)"/);
  const escapedDollar = renderMarkdownForEditor("literal \\$x$ and formula $y$");
  assert.match(escapedDollar, /data-type="escaped-dollar"/);
  assert.match(escapedDollar, /data-raw="\\\$"/);
  assert.equal((escapedDollar.match(/data-type="inline-math"/g) || []).length, 1);

  const markdownSource = fs.readFileSync(path.resolve("src/utils/markdown.ts"), "utf8");
  const htmlSource = fs.readFileSync(path.resolve("src/utils/html.ts"), "utf8");
  const wysiwygSource = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  const sourceEditor = fs.readFileSync(path.resolve("src/components/editor/SourceEditor.vue"), "utf8");
  assert.doesNotMatch(markdownSource, /markdownItKatex|protectInlineMath|normalizeLatexMathDelimiters/);
  assert.match(markdownSource, /parseMarkdownMath/);
  assert.match(htmlSource, /parseInlineMathText/);
  assert.match(wysiwygSource, /serializeMathToken/);
  assert.match(wysiwygSource, /EscapedDollarNode/);
  assert.match(wysiwygSource, /LightMarkInlineCode/);
  assert.match(wysiwygSource, /LIGHTMARK_TURNDOWN_HTML_BLOCK/);
  assert.match(wysiwygSource, /InlineMath/);
  assert.match(sourceEditor, /cm-math-error/);
  assert.match(sourceEditor, /evaluateMarkdownMath/);
  const mathNodeSource = fs.readFileSync(path.resolve("src/extensions/MathNodes.ts"), "utf8");
  const suggestSource = fs.readFileSync(path.resolve("src/extensions/LatexSuggest.ts"), "utf8");
  const exportSource = fs.readFileSync(path.resolve("src/utils/export.ts"), "utf8");
  const rustExportSource = fs.readFileSync(path.resolve("src-tauri/src/commands/export.rs"), "utf8");
  assert.match(mathNodeSource, /math-macro-definition/);
  assert.match(mathNodeSource, /availableMacroNames/);
  assert.match(suggestSource, /getAdditionalSuggestions/);
  assert.match(suggestSource, /\\\\ce/);
  assert.match(exportSource, /preparePandocMath/);
  assert.match(rustExportSource, /pandoc_latex_header/);
  assert.match(rustExportSource, /lightmark-math-header/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("math checks passed");
