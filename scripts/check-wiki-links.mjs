import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

const sourcePath = path.resolve("src/utils/wikiLinks.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const sourceEditor = fs.readFileSync(path.resolve("src/components/editor/SourceEditor.vue"), "utf8");
const wysiwygEditor = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
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
    createWikiWorkspaceIndex,
    parseFrontMatterAliases,
    updateWikiIndexEntry,
    wikiCompletionCandidates,
    parseKnowledgeTags,
    knowledgeTags,
    backlinksFromIndex,
    unlinkedMentionsForPath,
    prepareUnlinkedMentionConversion,
    scoreKnowledgeQuickOpenEntry,
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

  assert.match(sourceEditor, /findWikiCompletionCandidates\(appStore\.wikiIndex/);
  assert.match(sourceEditor, /candidate\.matchedAlias/);
  assert.match(wysiwygEditor, /updateWysiwygWikiCompletion/);
  assert.match(wysiwygEditor, /wikiLinkHref\(\{ page: candidate\.name \}\)/);
  assert.match(wysiwygEditor, /setStoredMarks\(\[\]\)/);

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

  assert.deepEqual(parseFrontMatterAliases("---\nalias: Alpha\naliases: [项目甲, A]\n---\n# Title"), ["Alpha", "项目甲", "A"]);
  assert.deepEqual(parseFrontMatterAliases("---\naliases:\n  - First\n  - second\n  - FIRST\n---\n"), ["First", "second"]);
  assert.deepEqual(parseFrontMatterAliases("---\naliases: [broken\n---\n"), []);

  const index = createWikiWorkspaceIndex(files, "C:/vault");
  updateWikiIndexEntry(index, "C:/vault/Project Alpha.md", "---\naliases: [Alpha, 项目甲]\n---\n");
  updateWikiIndexEntry(index, "C:/vault/Nested/project alpha.md", "---\nalias: Alpha\n---\n");
  assert.equal(resolveWikiLink({ page: "项目甲" }, index).path, "C:/vault/Project Alpha.md");
  const aliasResolution = resolveWikiLink({ page: "Alpha" }, index);
  assert.equal(aliasResolution.status, "ambiguous");
  assert.equal(aliasResolution.path, "C:/vault/Project Alpha.md");
  const completion = wikiCompletionCandidates(index, "项目");
  assert.equal(completion[0].name, "Project Alpha");
  assert.equal(completion[0].matchedAlias, "项目甲");
  assert.equal(completion[0].relativePath, "Project Alpha.md");

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
  assert.equal(
    backlinksForPath("C:/vault/Project Alpha.md", "The final backlink was removed.", "C:/vault/Source.md").length,
    0,
  );
  const aliasBacklinks = backlinksForPath("C:/vault/Project Alpha.md", "Links to [[项目甲#设计]] and `[[项目甲]]`.", "C:/vault/Source.md", index);
  assert.deepEqual(aliasBacklinks.map((item) => ({ page: item.target.page, heading: item.target.heading })), [
    { page: "项目甲", heading: "设计" },
  ]);

  const tagged = [
    "---",
    "tags: [project/alpha, 中文]",
    "tag: writing",
    "---",
    "# Heading",
    "正文 #Writing #nested/child #中文",
    "\\#escaped https://example.test/#url",
    "`#inline-code` and $x_#math$",
    "```md",
    "#fenced",
    "```",
    "<div>#html</div>",
  ].join("\r\n");
  assert.deepEqual(parseKnowledgeTags(tagged), ["project/alpha", "中文", "writing", "nested/child"]);

  updateWikiIndexEntry(index, "C:/vault/Project Alpha.md", "---\naliases: [Alpha, 项目甲, A]\ntags: [project/alpha]\n---\n# Project Alpha");
  updateWikiIndexEntry(index, "C:/vault/Nested/Other.md", [
    "---",
    "tags: [research, project/alpha]",
    "---",
    "Project Alpha and 项目甲 are plain mentions.",
    "[[Project Alpha]] is linked.",
    "`Project Alpha` and $Project Alpha$ are protected.",
    "[Project Alpha](https://example.test) is a Markdown link.",
    "<div>项目甲</div>",
    "A is too short.",
  ].join("\r\n"));
  const groupedTags = knowledgeTags(index);
  assert.equal(groupedTags.find((item) => item.normalizedName === "project/alpha").paths.length, 2);
  const indexedBacklinks = backlinksFromIndex("C:/vault/Project Alpha.md", index);
  assert.equal(indexedBacklinks.length, 1);
  const mentions = unlinkedMentionsForPath("C:/vault/Project Alpha.md", index);
  assert.deepEqual(mentions.map((item) => item.text), ["Project Alpha", "项目甲"]);
  assert.ok(mentions.every((item) => item.sourcePath === "C:/vault/Nested/Other.md"));
  assert.ok(mentions.every((item) => item.to > item.from));
  const mentionSource = "Before Project Alpha after";
  const conversion = prepareUnlinkedMentionConversion(mentionSource, {
    from: 7,
    to: 20,
    text: "Project Alpha",
  });
  assert.deepEqual(conversion, {
    status: "ok",
    text: "Before [[Project Alpha]] after",
    replacement: "[[Project Alpha]]",
    from: 7,
    to: 24,
  });
  assert.deepEqual(
    prepareUnlinkedMentionConversion("Before changed after", { from: 7, to: 20, text: "Project Alpha" }),
    { status: "stale" },
  );

  const targetEntry = index.entries.find((entry) => entry.path === "C:/vault/Project Alpha.md");
  assert.equal(scoreKnowledgeQuickOpenEntry(targetEntry, "project alpha").score, 0);
  assert.deepEqual(scoreKnowledgeQuickOpenEntry(targetEntry, "项目甲"), {
    score: 100,
    matchKind: "alias",
    matchedAlias: "项目甲",
  });
  const metadataEntry = {
    ...targetEntry,
    name: "Document",
    aliases: ["Alpha"],
    tags: ["project/alpha"],
    path: "C:/vault/Nested/Document.md",
  };
  assert.equal(scoreKnowledgeQuickOpenEntry(metadataEntry, "lph").matchKind, "alias");
  assert.deepEqual(scoreKnowledgeQuickOpenEntry(metadataEntry, "#project").matchKind, "tag");
  assert.equal(scoreKnowledgeQuickOpenEntry(metadataEntry, "nested").matchKind, "path");
  assert.ok(
    scoreKnowledgeQuickOpenEntry(metadataEntry, "#project").score
      < scoreKnowledgeQuickOpenEntry(metadataEntry, "lph").score,
  );

  const storeSource = fs.readFileSync(path.resolve("src/stores/appStore.ts"), "utf8");
  const workspaceClientSource = fs.readFileSync(path.resolve("src/stores/workspaceIndexClient.ts"), "utf8");
  const sidebarSource = fs.readFileSync(path.resolve("src/components/layout/Sidebar.vue"), "utf8");
  const quickOpenSource = fs.readFileSync(path.resolve("src/components/command/QuickOpenPalette.vue"), "utf8");
  const watcherSource = fs.readFileSync(path.resolve("src-tauri/src/commands/file.rs"), "utf8");
  assert.doesNotMatch(
    storeSource,
    /function scheduleBacklinksRefresh\(\)\s*\{\s*if \(!appStore\.wikiBacklinksOpen/,
    "backlink detection must continue while the panel is hidden",
  );
  assert.match(sidebarSource, />知识</);
  assert.match(sidebarSource, /workspaceKnowledgeTags/);
  assert.match(sidebarSource, /convertUnlinkedMention/);
  assert.doesNotMatch(storeSource, /backlinksFromIndex|unlinkedMentionsForPath/,
    "the JS knowledge analyzer must remain a test oracle, not a production workspace scanner");
  assert.match(workspaceClientSource, /workspace_query_backlinks/);
  assert.match(workspaceClientSource, /workspace_query_mentions/);
  assert.match(storeSource, /workspaceIndexClient\.backlinks/);
  assert.match(storeSource, /watch_markdown_workspace/);
  assert.match(storeSource, /scoreKnowledgeQuickOpenEntry/);
  assert.match(quickOpenSource, /别名：/);
  assert.match(quickOpenSource, /matchedTag/);
  assert.match(watcherSource, /watch_markdown_workspace/);
  assert.match(watcherSource, /RecursiveMode::Recursive/);
  assert.match(watcherSource, /lightmark-workspace-watch-event/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
