import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-math-tools-"));

try {
  const compiled = compileTypeScriptModuleGraph(
    path.resolve("src/utils/mathExportCompatibility.ts"),
    tempDir,
  );
  const { analyzeMathExportCompatibility } =
    await import(pathToFileURL(compiled).href);

  const source = [
    "$$",
    "\\gdef\\RR{\\mathbb{R}}",
    "$$",
    "$$",
    "x\\in\\RR,\\quad \\ce{H2O}\\label{eq:water}",
    "$$",
    "See $\\ref{eq:water}$.",
  ].join("\n");
  const html = analyzeMathExportCompatibility(source, "html", "all-display");
  assert.deepEqual(
    html.features,
    ["basic-math", "macros", "mhchem", "numbering", "references", "navigation"],
  );
  assert.equal(html.status, "full");
  assert.equal(analyzeMathExportCompatibility(source, "docx", "all-display").status, "degraded");
  assert.equal(analyzeMathExportCompatibility(source, "mediawiki", "all-display").status, "degraded");

  const blocked = analyzeMathExportCompatibility(
    "$$x\\label{eq:x}$$\nSee $\\ref{eq:x}$.",
    "html",
    "none",
  );
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.issues.some((issue) => issue.blocking && /没有编号/.test(issue.message)));

  const mathNodes = fs.readFileSync(path.resolve("src/extensions/MathNodes.ts"), "utf8");
  for (const icon of ["Copy", "CodeXml", "Sigma", "RefreshCw"]) {
    assert.match(mathNodes, new RegExp(`icon: ${icon}`));
  }
  for (const label of ["复制公式源码", "复制 KaTeX HTML", "复制 MathML", "刷新当前文档全部公式"]) {
    assert.match(mathNodes, new RegExp(label));
  }
  assert.match(mathNodes, /lightmark:refresh-math/);
  assert.match(mathNodes, /serializeMathToken/);

  const cli = fs.readFileSync(path.resolve("src-tauri/src/bin/lightmark-cli.rs"), "utf8");
  for (const command of ["Export", "Check", "Formats"]) assert.match(cli, new RegExp(command));
  assert.match(cli, /Duration::from_secs\(180\)/);
  assert.match(cli, /child\.kill\(\)/);
  assert.match(cli, /overwrite/);

  const headless = fs.readFileSync(path.resolve("src/headlessExport.ts"), "utf8");
  assert.match(headless, /exportCurrentDocument/);
  assert.match(headless, /complete_headless_export/);
  assert.match(headless, /code:\s*3/);

  console.log("Math tools, compatibility, and CLI checks passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
