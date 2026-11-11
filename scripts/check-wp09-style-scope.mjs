import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadCompiler() {
  const require = createRequire(import.meta.url);
  try {
    return require("@vue/compiler-sfc");
  } catch {
    const pnpmRoot = path.join(root, "node_modules", ".pnpm");
    const packageDir = fs
      .readdirSync(pnpmRoot)
      .find((name) => name.startsWith("@vue+compiler-sfc@"));
    if (!packageDir) {
      throw new Error("@vue/compiler-sfc is required for the WP09 scoped-style check");
    }
    const packagePath = path.join(
      pnpmRoot,
      packageDir,
      "node_modules",
      "@vue",
      "compiler-sfc",
    );
    return require(fileURLToPath(pathToFileURL(packagePath)));
  }
}

const { compileStyle, parse } = loadCompiler();

const components = [
  {
    file: "src/components/dialog/AppDialog.vue",
    selectors: [".dialog-backdrop", ".dialog-button", ".dialog-button-secondary"],
  },
  {
    file: "src/components/find/FindReplacePanel.vue",
    selectors: [".find-panel", ".find-input-wrap", ".find-button"],
  },
  {
    file: "src/components/layout/EditorModeToggle.vue",
    selectors: [".editor-mode-toggle", ".editor-mode-toggle-dark", ".editor-mode-toggle-option"],
  },
  {
    file: "src/components/layout/ExternalFileNotice.vue",
    selectors: [".external-file-notice", ".external-file-notice.danger", ".notice-button"],
  },
  {
    file: "src/components/layout/ResourcesPane.vue",
    selectors: [".resource-tabs", ".resource-card", ".resource-main"],
  },
  {
    file: "src/components/layout/Toolbar.vue",
    selectors: [".lm-toolbar", ".lm-toolbar-dark", ".lm-toolbar-button"],
  },
  {
    file: "src/components/layout/DocumentTabs.vue",
    selectors: [".document-tabs", ".document-tab", ".new-tab-button", ".tab-menu-item"],
  },
  {
    file: "src/components/editor/EditorShell.vue",
    selectors: [".editor-page-shell"],
    focusOutline: false,
  },
];

function ruleSelectors(css) {
  const selectors = [];
  for (const match of css.matchAll(/(?:^|})\s*([^@{}]+)\{/g)) {
    selectors.push(
      ...match[1]
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
    );
  }
  return selectors;
}

for (const component of components) {
  const filename = path.join(root, component.file);
  const source = fs.readFileSync(filename, "utf8");
  const descriptor = parse(source, { filename }).descriptor;
  const style = descriptor.styles.find((entry) => entry.scoped);
  if (!style) throw new Error(`${component.file} must keep a scoped style block`);
  for (const token of ["--lm-accent-strong", "--lm-danger"]) {
    if (source.includes(token)) throw new Error(`${component.file} still references ${token}`);
  }
  if (source.includes(":global(.dark)")) {
    throw new Error(`${component.file} still relies on :global(.dark) in scoped CSS`);
  }

  const compiled = compileStyle({
    filename,
    id: "data-v-wp09",
    scoped: true,
    source: style.content,
  });
  if (compiled.errors.length > 0) {
    throw new Error(`${component.file} compileStyle errors: ${compiled.errors.join("; ")}`);
  }

  const selectors = ruleSelectors(compiled.code);
  const orphanDark = selectors.filter((selector) => selector === ".dark");
  if (orphanDark.length > 0) {
    throw new Error(`${component.file} emitted an orphan .dark selector`);
  }
  for (const selector of component.selectors) {
    if (!compiled.code.includes(selector)) {
      throw new Error(`${component.file} lost scoped selector ${selector}`);
    }
  }
  if (component.focusOutline !== false && !style.content.includes("outline: 2px solid var(--lm-accent)")) {
    throw new Error(`${component.file} has no solid accent focus outline`);
  }
}

const tokens = fs.readFileSync(path.join(root, "src/styles/index.css"), "utf8");
for (const token of ["--lm-on-accent", "--lm-on-error", "--lm-backdrop"]) {
  if (!tokens.includes(token)) throw new Error(`missing theme token ${token}`);
}
for (const token of ["--lm-accent-strong", "--lm-danger"]) {
  if (tokens.includes(token)) throw new Error(`undefined legacy token remains: ${token}`);
}

console.log(`WP09 compileStyle scoped-theme regression: ${components.length}/${components.length} passed`);
