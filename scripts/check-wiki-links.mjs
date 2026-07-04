import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/wikiLinks.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const timestamp = Date.now();
const tempDir = path.resolve(`scripts/.lightmark-wiki-check-${timestamp}`);
fs.mkdirSync(tempDir, { recursive: true });
const tempPath = path.join(tempDir, `.lightmark-wiki-links-${timestamp}.mjs`);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
}).outputText;
fs.writeFileSync(tempPath, compiled, "utf8");

try {
  const {
    parseWikiLinks,
    resolveWikiLink,
    wikiLinkMarkdown,
    renderWikiLinksInEscapedText,
    wikiLinkHref,
    backlinksForPath,
  } = await import(pathToFileURL(tempPath).href);

  const sample = [
    "See [[Project Alpha]] and [[Project Alpha#Design Notes]].",
    "",
    "`[[Inline Code]]` should be ignored.",
    "",
    "```",
    "[[Fenced Code]] should be ignored.",
    "```",
    "",
    "[[Missing Note]] is still a link.",
  ].join("\n");

  const links = parseWikiLinks(sample);
  assert.deepEqual(
    links.map((item) => ({ page: item.page, heading: item.heading, line: item.line })),
    [
      { page: "Project Alpha", heading: undefined, line: 0 },
      { page: "Project Alpha", heading: "Design Notes", line: 0 },
      { page: "Missing Note", heading: undefined, line: 8 },
    ],
  );

  const files = [
    { name: "Project Alpha.md", path: "C:/vault/Project Alpha.md", isDir: false, children: [] },
    { name: "Nested", path: "C:/vault/Nested", isDir: true, children: [
      { name: "project alpha.md", path: "C:/vault/Nested/project alpha.md", isDir: false, children: [] },
      { name: "Other.md", path: "C:/vault/Nested/Other.md", isDir: false, children: [] },
    ] },
  ];
  const resolved = resolveWikiLink({ page: "PROJECT ALPHA" }, files);
  assert.equal(resolved.status, "ambiguous");
  assert.equal(resolved.path, "C:/vault/Project Alpha.md");
  assert.equal(resolved.candidates.length, 2);

  assert.equal(resolveWikiLink({ page: "Nope" }, files).status, "missing");

  const href = wikiLinkHref({ page: "Project Alpha", heading: "Design Notes" });
  assert.equal(href, "lightmark://wiki?page=Project%20Alpha&heading=Design%20Notes");

  const rendered = renderWikiLinksInEscapedText("Open [[Project Alpha#Design Notes]]");
  assert.match(rendered, /data-wiki-link="true"/);
  assert.match(rendered, /href="lightmark:\/\/wiki\?page=Project%20Alpha&amp;heading=Design%20Notes"/);
  assert.match(rendered, />Project Alpha#Design Notes<\/a>/);

  assert.equal(wikiLinkMarkdown({ page: "Project Alpha", heading: "Design Notes" }), "[[Project Alpha#Design Notes]]");

  const backlinks = backlinksForPath("C:/vault/Project Alpha.md", "Links to [[Project Alpha]].", "C:/vault/Source.md");
  assert.deepEqual(backlinks.map((item) => ({ sourceName: item.sourceName, line: item.line, preview: item.preview })), [
    { sourceName: "Source.md", line: 0, preview: "Links to [[Project Alpha]]." },
  ]);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
