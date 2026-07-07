import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src", "utils", "splitLayout.ts");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmark-split-layout-"));
const tempPath = path.join(tempDir, "splitLayout.mjs");

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
    defaultSplitLayout,
    enableSplitLayout,
    normalizeSplitLayout,
    paneTabId,
    resolveClosedTabSplitLayout,
    splitLayoutForPaneActivation,
  } = await import(pathToFileURL(tempPath).href);

  const tabs = ["tab-a", "tab-b", "tab-c"];
  const enabled = enableSplitLayout(defaultSplitLayout("tab-a"), tabs);
  assert.deepEqual(enabled, {
    enabled: true,
    activePaneId: "secondary",
    mainTabId: "tab-a",
    secondaryTabId: "tab-b",
    mainTabIds: ["tab-a"],
    secondaryTabIds: ["tab-b"],
    ratio: 0.5,
  });

  const activated = splitLayoutForPaneActivation(enabled, "secondary", "tab-c", tabs);
  assert.equal(activated.activePaneId, "secondary");
  assert.equal(activated.mainTabId, "tab-a");
  assert.equal(activated.secondaryTabId, "tab-c");
  assert.deepEqual(activated.mainTabIds, ["tab-a"]);
  assert.deepEqual(activated.secondaryTabIds, ["tab-b", "tab-c"]);

  const afterClose = resolveClosedTabSplitLayout(activated, "tab-c", ["tab-a", "tab-b"]);
  assert.equal(afterClose.secondaryTabId, "tab-b");
  assert.equal(afterClose.mainTabId, "tab-a");
  assert.deepEqual(afterClose.mainTabIds, ["tab-a"]);
  assert.deepEqual(afterClose.secondaryTabIds, ["tab-b"]);

  const normalized = normalizeSplitLayout(
    { enabled: true, activePaneId: "secondary", mainTabId: "missing", secondaryTabId: "tab-c", ratio: 0.95 },
    tabs,
    "tab-a",
  );
  assert.deepEqual(normalized, {
    enabled: true,
    activePaneId: "secondary",
    mainTabId: "tab-a",
    secondaryTabId: "tab-c",
    mainTabIds: ["tab-a"],
    secondaryTabIds: ["tab-c"],
    ratio: 0.7,
  });

  const withNewSecondary = splitLayoutForPaneActivation(enabled, "secondary", "tab-c", tabs);
  assert.deepEqual(withNewSecondary.mainTabIds, ["tab-a"]);
  assert.deepEqual(withNewSecondary.secondaryTabIds, ["tab-b", "tab-c"]);

  const singleEnabled = enableSplitLayout(defaultSplitLayout("tab-a"), ["tab-a"]);
  assert.notEqual(singleEnabled.mainTabId, singleEnabled.secondaryTabId, "split panes must not point at the same tab");

  const splitTabs = [
    { id: "tab-a", content: "left" },
    { id: "tab-b", content: "right" },
  ];
  const split = enableSplitLayout(defaultSplitLayout("tab-a"), splitTabs.map((tab) => tab.id));
  const writePaneContent = (layout, paneId, content) => {
    const tabId = paneTabId(layout, paneId);
    const tab = splitTabs.find((item) => item.id === tabId);
    if (tab) tab.content = content;
  };
  writePaneContent(split, "main", "left edited");
  writePaneContent(split, "secondary", "right edited");
  assert.equal(splitTabs[0].content, "left edited");
  assert.equal(splitTabs[1].content, "right edited");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
