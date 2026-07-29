import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-front-matter-"));

try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/utils/frontMatter.ts"), tempDir);
  const {
    markdownForNativeExport,
    markdownForPandocExport,
    splitLeadingFrontMatter,
  } = await import(pathToFileURL(compiled).href);

  const lf = "---\ntitle: Demo\ntags: [one, two]\n---\n\n# Body";
  assert.deepEqual(splitLeadingFrontMatter(lf), {
    yaml: "title: Demo\ntags: [one, two]",
    rest: "# Body",
  });
  assert.equal(markdownForNativeExport(lf, false), "# Body");
  assert.equal(markdownForNativeExport(lf, true), lf);
  assert.equal(
    markdownForPandocExport(lf, true),
    "```yaml\ntitle: Demo\ntags: [one, two]\n```\n\n# Body",
  );

  const crlfAndDots = "\uFEFF---\r\ntitle: Windows\r\n...\r\n\r\nBody";
  assert.deepEqual(splitLeadingFrontMatter(crlfAndDots), {
    yaml: "title: Windows",
    rest: "Body",
  });
  assert.equal(markdownForPandocExport(crlfAndDots, false), "Body");
  assert.equal(markdownForPandocExport("No front matter", false), "No front matter");

  const storeSource = fs.readFileSync(path.resolve("src/stores/appStore.ts"), "utf8");
  const settingsSource = fs.readFileSync(path.resolve("src/components/settings/SettingsDialog.vue"), "utf8");
  const rustModels = fs.readFileSync(path.resolve("src-tauri/src/commands/models.rs"), "utf8");
  assert.match(storeSource, /includeYamlFrontMatter:\s*false/);
  assert.match(settingsSource, /导出 YAML Front Matter/);
  assert.match(rustModels, /include_yaml_front_matter:\s*false/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("front matter checks passed");
