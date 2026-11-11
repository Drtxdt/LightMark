import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const PERFORMANCE_FIXTURE_SCHEMA_VERSION = 1;
export const PERFORMANCE_FIXTURE_IDS = Object.freeze([
  "normal-writing",
  "large-document",
  "formula-dense",
  "table-dense",
  "image-dense",
  "long-lines",
  "source-50000-lines",
  "wys-50000-paragraphs",
]);
export const EXACT_SIZE_BYTES = Object.freeze({
  below: 5 * 1024 * 1024 - 1,
  exact: 5 * 1024 * 1024,
  above: 5 * 1024 * 1024 + 1,
});
export const DEFAULT_LARGE_DOCUMENT_BYTES = 6 * 1024 * 1024;
export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;
export const MIN_STARTUP_SAMPLES = 10;
export const MIN_INTERACTIVE_ROUNDS = 3;
export const MIN_OPERATIONS_PER_ROUND = 100;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  return Buffer.concat([length, body, checksum]);
}

function buildRgbaPng(width, height, [red, green, blue]) {
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = red;
    row[2 + x * 4] = green;
    row[3 + x * 4] = blue;
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const BASELINE_JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGw/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=",
  "base64",
);

const IMAGE_ASSETS = Object.freeze([
  {
    id: "perf-image-svg",
    relativePath: "assets/perf-image.svg",
    mediaType: "image/svg+xml",
    format: "svg",
    compression: "none (vector source)",
    width: 320,
    height: 180,
    content: [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
      '<rect width="320" height="180" fill="#f4efe6"/>',
      '<rect x="16" y="16" width="288" height="148" rx="12" fill="#d7e5f4" stroke="#3f6f9f" stroke-width="4"/>',
      '<path d="M32 132 94 76l42 38 42-52 110 70" fill="none" stroke="#27486d" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
      '<circle cx="238" cy="54" r="18" fill="#78a6d3"/>',
      "</svg>\n",
    ].join(""),
  },
  {
    id: "perf-image-svg-alt",
    relativePath: "assets/perf-image-alt.svg",
    mediaType: "image/svg+xml",
    format: "svg",
    compression: "none (vector source)",
    width: 320,
    height: 180,
    content: [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
      '<rect width="320" height="180" fill="#111318"/>',
      '<circle cx="160" cy="90" r="62" fill="#78a6d3"/>',
      '<path d="M115 92h90M160 47v86" stroke="#111318" stroke-width="12" stroke-linecap="round"/>',
      '<rect x="16" y="16" width="288" height="148" rx="12" fill="none" stroke="#fda29b" stroke-width="4"/>',
      "</svg>\n",
    ].join(""),
  },
  {
    id: "perf-image-png-01",
    relativePath: "assets/perf-image-01.png",
    mediaType: "image/png",
    format: "png",
    compression: "deflate",
    width: 320,
    height: 180,
    content: buildRgbaPng(320, 180, [63, 111, 159]),
  },
  {
    id: "perf-image-png-02",
    relativePath: "assets/perf-image-02.png",
    mediaType: "image/png",
    format: "png",
    compression: "deflate",
    width: 320,
    height: 180,
    content: buildRgbaPng(320, 180, [120, 166, 211]),
  },
  {
    id: "perf-image-png-03",
    relativePath: "assets/perf-image-03.png",
    mediaType: "image/png",
    format: "png",
    compression: "deflate",
    width: 320,
    height: 180,
    content: buildRgbaPng(320, 180, [253, 162, 155]),
  },
  {
    id: "perf-image-jpeg-01",
    relativePath: "assets/perf-image-01.jpg",
    mediaType: "image/jpeg",
    format: "jpeg",
    compression: "baseline",
    width: 1,
    height: 1,
    content: BASELINE_JPEG_1X1,
  },
]);

function resolveOwnedRoot(root) {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new TypeError("A non-empty owned fixture root is required.");
  }
  return path.resolve(root);
}

function assertWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error(`Fixture path escapes the owned root: ${candidate}`);
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`Fixture path must be a non-empty relative path: ${relativePath}`);
  }
  const normalized = relativePath.split(/[\\/]+/u).filter(Boolean);
  if (normalized.includes("..")) throw new Error(`Fixture path contains a parent traversal: ${relativePath}`);
  return relativePath;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function linesOf(value) {
  return value.split(/\r\n|\n|\r/u);
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/u.test(line);
}

function isTableSeparator(line) {
  if (!isTableRow(line)) return false;
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .every((cell) => /^\s*:?-{1,}:?\s*$/u.test(cell));
}

function countTableBlocks(lines) {
  let count = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (isTableRow(lines[index]) && isTableSeparator(lines[index + 1])) {
      count += 1;
      index += 1;
      while (index + 1 < lines.length && isTableRow(lines[index + 1])) index += 1;
    }
  }
  return count;
}

function countFormulaExpressions(value) {
  const blockMatches = value.match(/\$\$[\s\S]*?\$\$/gu) || [];
  const withoutBlocks = value.replace(/\$\$[\s\S]*?\$\$/gu, "");
  const inlineMatches = withoutBlocks.match(/(?<!\\)\$(?!\$)[^$\n]+(?<!\\)\$(?!\$)/gu) || [];
  return blockMatches.length + inlineMatches.length;
}

function countImages(value) {
  return value.match(/!\[[^\]]*\]\([^\)\s]+(?:\s+["'][^"']*["'])?\)/gu)?.length || 0;
}

function countBlocks(value) {
  return value
    .split(/(?:\r\n|\n|\r){2,}/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .length;
}

export function computeMarkdownMetrics(value) {
  if (typeof value !== "string") throw new TypeError("Markdown metrics require text.");
  const encoded = Buffer.from(value, "utf8");
  const decoded = UTF8_DECODER.decode(encoded);
  if (decoded !== value) throw new Error("Markdown fixture did not round-trip through UTF-8.");
  const lines = linesOf(value);
  const lineLengths = lines.map((line) => ({
    utf16: line.length,
    codePoints: Array.from(line).length,
    utf8Bytes: utf8Bytes(line),
  }));
  const longest = lineLengths.reduce(
    (current, line) => (line.codePoints > current.codePoints ? line : current),
    { utf16: 0, codePoints: 0, utf8Bytes: 0 },
  );
  return {
    utf8Bytes: encoded.byteLength,
    utf16Length: value.length,
    lineCount: lines.length,
    blockCount: countBlocks(value),
    blockCountMethod: "blank-line-groups-estimate",
    formulaCount: countFormulaExpressions(value),
    tableCount: countTableBlocks(lines),
    imageCount: countImages(value),
    maxLineLength: longest.codePoints,
    maxLineCodePoints: longest.codePoints,
    maxLineUtf16Length: longest.utf16,
    maxLineUtf8Bytes: longest.utf8Bytes,
  };
}

function markerSet(id) {
  return {
    operationStart: `<!-- LM-PERF operation start: ${id} -->`,
    operationEnd: `<!-- LM-PERF operation end: ${id} -->`,
    sentinelBefore: `LM_PERF_SENTINEL_BEFORE_${id.replaceAll("-", "_").toUpperCase()}_KEEP`,
    sentinelAfter: `LM_PERF_SENTINEL_AFTER_${id.replaceAll("-", "_").toUpperCase()}_KEEP`,
  };
}

function wrapFixture(id, title, body) {
  const markers = markerSet(id);
  const text = [
    `<!-- LM-PERF fixture: ${id} -->`,
    `<!-- ${markers.sentinelBefore} -->`,
    `# ${title}`,
    "",
    markers.operationStart,
    body.trimEnd(),
    markers.operationEnd,
    "",
    `<!-- ${markers.sentinelAfter} -->`,
    "",
  ].join("\n");
  return { text, markers };
}

function repeatToMinimum(pattern, minimumBytes) {
  const patternBytes = utf8Bytes(pattern);
  if (patternBytes === 0) throw new Error("Fixture repeat pattern cannot be empty.");
  return pattern.repeat(Math.ceil(minimumBytes / patternBytes));
}

function normalWritingBody() {
  const paragraph = "这是一段可重复的普通写作内容，包含 ASCII、中文、标点、[[Wiki Link]]、**强调** 和一个可编辑的操作锚点。";
  return [
    paragraph,
    "",
    "- first task",
    "- [ ] second task",
    "- [x] completed task",
    "",
    "> A quoted paragraph remains a correctness sentinel.",
    "",
    "```ts",
    "const stableFixture = true;",
    "```",
    "",
    repeatToMinimum(`${paragraph}\n\n`, 48 * 1024),
  ].join("\n");
}

function largeDocumentBody(targetBytes) {
  const paragraph = "大型文档负载用于打开、滚动和局部编辑测量。它保留中文🙂、ASCII、标点与稳定哨兵，并按完整 UTF-8 文本重复。";
  const unit = [
    paragraph,
    "",
    "## Large section",
    "",
    "- stable item A",
    "- stable item B",
    "",
  ].join("\n");
  return repeatToMinimum(unit, targetBytes);
}

function formulaDenseBody() {
  const formulas = [
    "Euler: $e^{i\\pi}+1=0$",
    "Inline: $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}=\\frac{\\pi^2}{6}$",
    "",
    "$$",
    "\\int_0^1 x^2 dx = \\frac{1}{3}",
    "$$",
  ].join("\n");
  return `${repeatToMinimum(`${formulas}\n\n`, 96 * 1024)}\nFormula sentinel: keep this paragraph unchanged.\n`;
}

function tableDenseBody() {
  const header = "| index | label | value | status |\n| ---: | :--- | ---: | :---: |";
  const rows = Array.from({ length: 120 }, (_, index) => `| ${index} | row-${index} | ${index * 17} | ${index % 2 ? "warm" : "cold"} |`).join("\n");
  const secondHeader = "| key | left | right |\n| :--- | ---: | :--- |";
  const secondRows = Array.from({ length: 80 }, (_, index) => `| key-${index} | ${index + 1} | value-${index % 11} |`).join("\n");
  return `${header}\n${rows}\n\n${secondHeader}\n${secondRows}\n`;
}

function imageDenseBody() {
  const rows = Array.from({ length: 80 }, (_, index) => {
    const assetNames = [
      "perf-image.svg",
      "perf-image-alt.svg",
      "perf-image-01.png",
      "perf-image-02.png",
      "perf-image-03.png",
      "perf-image-01.jpg",
    ];
    const asset = assetNames[index % assetNames.length];
    return `![fixed local image ${index}](assets/${asset})`;
  });
  return [
    "Every image is a local owned asset with fixed 320x180 SVG dimensions.",
    "",
    rows.join("\n\n"),
    "",
    "Image sentinel: this text must survive every image operation.",
    "",
  ].join("\n");
}

function longLinesBody() {
  const line = "long-line-".repeat(512) + "中文🙂" + "-tail";
  return [
    "The long-line fixture intentionally has few newline boundaries.",
    "",
    line,
    line.replace("long-line-", "second-long-line-"),
    line.replace("long-line-", "third-long-line-"),
    "",
    "Long line sentinel: preserve the exact Unicode sequence.",
    "",
  ].join("\n");
}

function fixtureDefinitions(largeDocumentBytes) {
  return [
    {
      id: "normal-writing",
      category: "normal-writing",
      title: "Normal writing load",
      relativePath: "fixtures/normal-writing.md",
      operation: "insert-delete",
      supportedModes: ["source", "wysiwyg"],
      build: normalWritingBody,
    },
    {
      id: "large-document",
      category: "large-document",
      title: "Large document load",
      relativePath: "fixtures/large-document.md",
      operation: "open-scroll-local-edit",
      supportedModes: ["source"],
      build: () => largeDocumentBody(largeDocumentBytes),
    },
    {
      id: "formula-dense",
      category: "formula-dense",
      title: "Formula dense load",
      relativePath: "fixtures/formula-dense.md",
      operation: "formula-commit",
      supportedModes: ["wysiwyg"],
      build: formulaDenseBody,
    },
    {
      id: "table-dense",
      category: "table-dense",
      title: "Table dense load",
      relativePath: "fixtures/table-dense.md",
      operation: "insert-delete",
      supportedModes: ["wysiwyg", "source"],
      build: tableDenseBody,
    },
    {
      id: "image-dense",
      category: "image-dense",
      title: "Image dense load",
      relativePath: "fixtures/image-dense.md",
      operation: "open-scroll",
      supportedModes: ["wysiwyg"],
      build: imageDenseBody,
      assetIds: [
        "perf-image-svg",
        "perf-image-svg-alt",
        "perf-image-png-01",
        "perf-image-png-02",
        "perf-image-png-03",
        "perf-image-jpeg-01",
      ],
    },
    {
      id: "long-lines",
      category: "long-lines",
      title: "Long lines load",
      relativePath: "fixtures/long-lines.md",
      operation: "head-tail-edit",
      supportedModes: ["source", "wysiwyg"],
      build: longLinesBody,
    },
    {
      id: "source-50000-lines",
      category: "source-head-edit",
      title: "50,000 source payload lines",
      relativePath: "fixtures/source-50000-lines.md",
      operation: "head-enter-delete-multi-range",
      supportedModes: ["source"],
      build: () => Array.from({ length: 50_000 }, (_, index) => `line ${index} 中文🙂`).join("\n"),
    },
    {
      id: "wys-50000-paragraphs",
      category: "wys-head-edit",
      title: "50,000 short payload paragraphs",
      relativePath: "fixtures/wys-50000-paragraphs.md",
      operation: "head-enter-delete-multi-range",
      supportedModes: ["wysiwyg"],
      build: () => Array.from({ length: 50_000 }, (_, index) => `paragraph ${index}`).join("\n\n"),
    },
  ];
}

function findMarkerOffsets(text, markers) {
  const start = text.indexOf(markers.operationStart);
  const end = text.indexOf(markers.operationEnd);
  if (start < 0 || end < start) throw new Error("Fixture operation markers are missing or reversed.");
  return {
    operationStartUtf16Offset: start,
    operationEndUtf16Offset: end + markers.operationEnd.length,
    operationStartUtf8Offset: utf8Bytes(text.slice(0, start)),
    operationEndUtf8Offset: utf8Bytes(text.slice(0, end + markers.operationEnd.length)),
    sentinelBefore: markers.sentinelBefore,
    sentinelAfter: markers.sentinelAfter,
  };
}

function describeContent(relativePath, text, definition, assetIds = []) {
  const metrics = computeMarkdownMetrics(text);
  const markers = markerSet(definition.id);
  return {
    id: definition.id,
    category: definition.category,
    relativePath: relativePath.replaceAll("\\", "/"),
    operation: definition.operation,
    supportedModes: definition.supportedModes,
    assets: assetIds,
    sha256: sha256(Buffer.from(text, "utf8")),
    metrics,
    markers: findMarkerOffsets(text, markers),
    payload: {
      utf16Start: text.indexOf(markers.operationStart) + markers.operationStart.length + 1,
      utf16End: text.indexOf(markers.operationEnd),
      sourceLineCount: definition.id === "source-50000-lines" ? 50_000 : null,
      paragraphCount: definition.id === "wys-50000-paragraphs" ? 50_000 : null,
      countMethod: "fixture generator exact payload count; wrapper is excluded",
    },
  };
}

function buildExactThresholdText(id, targetBytes) {
  const markers = markerSet(id);
  const prefix = [
    `<!-- LM-PERF threshold fixture: ${id} -->`,
    `<!-- ${markers.sentinelBefore} -->`,
    markers.operationStart,
    "UTF-8 boundary🙂中文: ",
  ].join("\n");
  const suffix = [
    "",
    markers.operationEnd,
    `<!-- ${markers.sentinelAfter} -->`,
    "",
  ].join("\n");
  const prefixBytes = utf8Bytes(prefix);
  const suffixBytes = utf8Bytes(suffix);
  if (prefixBytes + suffixBytes > targetBytes) throw new Error(`Threshold prefix exceeds target size for ${id}.`);
  const availableBytes = targetBytes - prefixBytes - suffixBytes;
  const lineUnit = "boundary-padding-0123456789abcdef0123456789abcdef0123456789abcdef\n";
  const lineBytes = utf8Bytes(lineUnit);
  const repeatedLines = lineUnit.repeat(Math.floor(availableBytes / lineBytes));
  const paddingBytes = availableBytes - utf8Bytes(repeatedLines);
  // The remainder is ASCII only, so the prefix's multibyte characters and
  // every complete line remain intact at all three exact byte boundaries.
  const filler = `${repeatedLines}${"A".repeat(paddingBytes)}`;
  return `${prefix}${filler}${suffix}`;
}

async function writeOwnedFile(root, relativePath, content) {
  const safeRelative = assertSafeRelativePath(relativePath);
  const absolute = assertWithin(root, path.resolve(root, safeRelative));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

async function describeAsset(root, asset) {
  const absolute = assertWithin(root, path.resolve(root, assertSafeRelativePath(asset.relativePath)));
  const bytes = await readFile(absolute);
  return {
    id: asset.id,
    relativePath: asset.relativePath,
    mediaType: asset.mediaType,
    format: asset.format,
    compression: asset.compression,
    width: asset.width,
    height: asset.height,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export function buildExactThresholdFixtures() {
  return Object.entries(EXACT_SIZE_BYTES).map(([name, targetBytes]) => ({
    id: `utf8-${name}`,
    category: "utf8-size-boundary",
    relativePath: `fixtures/utf8-${name}.md`,
    operation: "mode-selection-boundary",
    supportedModes: targetBytes >= LARGE_FILE_THRESHOLD_BYTES ? ["large"] : ["source", "wysiwyg"],
    targetBytes,
    text: buildExactThresholdText(`utf8-${name}`, targetBytes),
  }));
}

export async function createPerformanceFixtures(root, {
  largeDocumentBytes = DEFAULT_LARGE_DOCUMENT_BYTES,
  includeThresholdFixtures = true,
} = {}) {
  const ownedRoot = resolveOwnedRoot(root);
  if (!Number.isSafeInteger(largeDocumentBytes) || largeDocumentBytes < 1024) {
    throw new RangeError("largeDocumentBytes must be a safe integer of at least 1024 bytes.");
  }
  await mkdir(ownedRoot, { recursive: true });
  const assets = [];
  for (const asset of IMAGE_ASSETS) {
    const content = Buffer.isBuffer(asset.content) ? asset.content : Buffer.from(asset.content, "utf8");
    await writeOwnedFile(ownedRoot, asset.relativePath, content);
    assets.push(await describeAsset(ownedRoot, asset));
  }

  const fixtures = [];
  for (const definition of fixtureDefinitions(largeDocumentBytes)) {
    const { text } = wrapFixture(definition.id, definition.title, definition.build());
    await writeOwnedFile(ownedRoot, definition.relativePath, Buffer.from(text, "utf8"));
    fixtures.push(describeContent(definition.relativePath, text, definition, definition.assetIds || []));
  }

  const thresholds = [];
  if (includeThresholdFixtures) {
    for (const threshold of buildExactThresholdFixtures()) {
      await writeOwnedFile(ownedRoot, threshold.relativePath, Buffer.from(threshold.text, "utf8"));
      const definition = {
        id: threshold.id,
        category: threshold.category,
        operation: threshold.operation,
        supportedModes: threshold.supportedModes,
      };
      const record = describeContent(threshold.relativePath, threshold.text, definition);
      if (record.metrics.utf8Bytes !== threshold.targetBytes) {
        throw new Error(`UTF-8 threshold fixture size mismatch for ${threshold.id}.`);
      }
      thresholds.push({ ...record, targetBytes: threshold.targetBytes });
    }
  }

  const manifest = {
    schemaVersion: PERFORMANCE_FIXTURE_SCHEMA_VERSION,
    generatedBy: "scripts/qa/performance-fixtures.mjs",
    constraints: {
      exactThresholdBytes: EXACT_SIZE_BYTES,
      minStartupSamples: MIN_STARTUP_SAMPLES,
      minInteractiveRounds: MIN_INTERACTIVE_ROUNDS,
      minOperationsPerRound: MIN_OPERATIONS_PER_ROUND,
      largeDocumentBytes,
    },
    assets,
    fixtures,
    thresholds,
  };
  const manifestPath = await writeOwnedFile(
    ownedRoot,
    "performance-fixtures.manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    root: ownedRoot,
    manifestPath,
    manifest,
  };
}

export async function readPerformanceFixtureManifest(root) {
  const ownedRoot = resolveOwnedRoot(root);
  const manifestPath = assertWithin(ownedRoot, path.resolve(ownedRoot, "performance-fixtures.manifest.json"));
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  if (value?.schemaVersion !== PERFORMANCE_FIXTURE_SCHEMA_VERSION) {
    throw new Error(`Unsupported performance fixture manifest schema: ${value?.schemaVersion}`);
  }
  return value;
}

export function fixturePath(root, relativePath) {
  const ownedRoot = resolveOwnedRoot(root);
  return assertWithin(ownedRoot, path.resolve(ownedRoot, assertSafeRelativePath(relativePath)));
}
