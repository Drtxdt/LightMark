// Read-only release review probes. Run with Node at the repository root.
// The store uses an in-memory IPC transport; no real notes or profiles are opened.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "../../../scripts/transpile-module-graph.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cache = path.join(root, ".cache");
fs.mkdirSync(cache, { recursive: true });
const compiled = fs.mkdtempSync(path.join(cache, "release-review-logic-"));
const load = (relative) => import(pathToFileURL(compileTypeScriptModuleGraph(
  path.join(root, "src", relative), compiled, path.join(root, "src"),
)).href);
const find = await load("editor/wysiwygFind.ts");
const store = await load("stores/appStore.ts");
const results = [];
const check = (id, expected, observed) =>
  results.push({ id, expected, observed, passed: isDeepStrictEqual(expected, observed) });

// An inline atom like the production inlineMath node; retain its identity when
// inspecting the result (textContent alone would hide the missing formula).
const schema = new Schema({ nodes: {
  doc: { content: "paragraph+" }, paragraph: { content: "inline*" },
  text: { group: "inline" }, inlineMath: { group: "inline", inline: true, atom: true },
} });
const atom = schema.nodes.inlineMath.create();
function replaceInParagraph(inline, search) {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, inline));
  let state = EditorState.create({ doc, plugins: [
    find.createWysiwygFindPlugin({ active: () => true, currentIndex: () => 0 }),
  ] });
  state = state.apply(find.setWysiwygFindQuery(state, {
    search, caseSensitive: false, wholeWord: false, regex: false,
  }));
  const hits = find.getWysiwygFindState(state).items;
  const hit = hits[0];
  // The single replacement uses the same EditorState operation as the Vue view.
  if (hit) state = state.apply(state.tr.insertText("X", hit.docFrom, hit.docTo));
  return { count: hits.length, content: state.doc.firstChild.content.content
    .map(node => node.isText ? node.text : node.type.name) };
}
check("plain-control", { count: 1, content: ["LX"] },
  replaceInParagraph([schema.text("LR")], "R"));
check("keep-formula-before-match", { count: 1, content: ["L", "inlineMath", "X"] },
  replaceInParagraph([schema.text("L"), atom, schema.text("R")], "R"));
check("do-not-match-across-formula", { count: 0, content: ["L", "inlineMath", "R"] },
  replaceInParagraph([schema.text("L"), atom, schema.text("R")], "LR"));
check("case-fold-uses-original-offsets", { count: 1, content: ["AİXC!"] },
  replaceInParagraph([schema.text("AİBC!")], "B"));

// Drive the actual exported store. Control only I/O results and their order.
const writes = [];
let dispatch;
globalThis.window = Object.assign(new EventTarget(), {
  setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: (...args) => dispatch(...args) },
});
dispatch = async (cmd, args) => {
  if (cmd === "read_app_config") throw Error("fixture: unreadable existing config");
  if (cmd === "write_app_config") { writes.push(args.config); return; }
  throw Error("Unexpected config probe command: " + cmd);
};
await store.loadConfig().catch(() => {});
await new Promise(resolve => setImmediate(resolve));
check("do-not-overwrite-unreadable-config", 0, writes.length);

const folderA = "C:/test-notes/A", folderB = "C:/test-notes/B";
const tree = (folder, name) => [{ name, path: folder + "/" + name, isDir: false, children: [] }];
const startedA = Promise.withResolvers(), finishA = Promise.withResolvers();
dispatch = async (cmd, args) => {
  if (cmd === "list_markdown_files") {
    if (args.folder === folderA) { startedA.resolve(); return finishA.promise; }
    if (args.folder === folderB) return tree(folderB, "b.md");
  }
  if (cmd === "workspace_index_open") return { root: args.root, generation: 2, busy: false, candidates: [] };
  if (cmd === "workspace_query_tags") return { generation: 2, data: [] };
  if (["watch_markdown_workspace", "unwatch_markdown_workspace", "write_app_config"].includes(cmd)) return;
  throw Error("Unexpected workspace probe command: " + cmd);
};
const first = store.openWorkspace(folderA);
await startedA.promise;
await store.openWorkspace(folderB);
check("workspace-before-late-reply", [folderB, "b.md"],
  [store.appStore.currentWorkspace, store.appStore.fileTree[0]?.name]);
finishA.resolve(tree(folderA, "a.md"));
await first;
check("workspace-after-late-reply", [folderB, "b.md"],
  [store.appStore.currentWorkspace, store.appStore.fileTree[0]?.name]);

console.log(JSON.stringify({ node: process.version, results }, null, 2));
process.exitCode = results.every(item => item.passed) ? 0 : 1;
