import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const frontend = await readFile(new URL("../src/utils/export.ts", import.meta.url), "utf8");
const markdown = await readFile(new URL("../src/utils/markdown.ts", import.meta.url), "utf8");
const rust = await readFile(new URL("../src-tauri/src/commands/export.rs", import.meta.url), "utf8");

assert.match(frontend, /inlineExportResources\(buildExportHtml/, "styled HTML must inline resources");
assert.match(frontend, /removeAttribute\("srcset"\)/, "inlined images must not keep external srcset references");
assert.match(frontend, /rasterWidth: raster\?\.width/, "PNG dimensions must be sent to the desktop exporter");
assert.doesNotMatch(frontend, /toBlob\(/, "PNG export must not use the WebView canvas path");
assert.match(markdown, /max-height:\s*220mm/, "print CSS must constrain oversized images");
assert.match(rust, /"png"\s*=>\s*export_html_png/, "the desktop exporter must handle PNG");
assert.match(rust, /MAX_PIXELS:\s*u64\s*=\s*100_000_000/, "PNG export must enforce the pixel safety limit");
assert.match(rust, /RgbaImage/, "tall PNG tiles must be composited in Rust");
assert.match(rust, /top:-\{offset\}px/, "PNG tiles must use deterministic layout offsets");
assert.doesNotMatch(rust, /scrollTo\(0,\{offset\}\)/, "PNG tiles must not depend on asynchronous scripted scrolling");

console.log("Export preparation checks passed.");
