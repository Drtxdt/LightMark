import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const BRIDGE_MARKER = "__LIGHTMARK_PERF_BRIDGE__";
const BRIDGE_MODULE_MARKER = "performanceQaBridge";
const BOUNDARY_BRIDGE_MODULE_MARKER = "desktopContentBoundaryQaBridge";
const CONFIG_MARKER = "VITE_LIGHTMARK_PERF_CONFIG_JSON";
const BOUNDARY_MODE_MARKER = "VITE_LIGHTMARK_QA_PROBE_MODE";

function resolveDirectory(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} requires a directory path.`);
  }
  return path.resolve(value);
}

async function walkFiles(root) {
  const files = [];
  async function visit(current) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Artifact directory contains a symlink: ${current}`);
    if (entry.isFile()) {
      files.push(current);
      return;
    }
    if (!entry.isDirectory()) throw new Error(`Artifact path is neither a file nor directory: ${current}`);
    const children = (await readdir(current)).sort((left, right) => left.localeCompare(right));
    for (const child of children) await visit(path.join(current, child));
  }
  await visit(root);
  return files;
}

async function inspectDirectory(root) {
  const files = await walkFiles(root);
  const records = [];
  const hash = createHash("sha256");
  for (const absolutePath of files) {
    const bytes = await readFile(absolutePath);
    const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
    hash.update(relativePath);
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    records.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("utf8"),
    });
  }
  return {
    root,
    files: records.map(({ content, ...record }) => record),
    sha256: hash.digest("hex"),
    hasMarker(marker) {
      return records.some((record) => record.content.includes(marker));
    },
    pathsWithMarker(marker) {
      return records.filter((record) => record.content.includes(marker)).map((record) => record.path);
    },
  };
}

/**
 * Verify that a normal release artifact does not expose the QA bridge and
 * that a QA artifact contains the one fixed marker used by the launcher.
 * This is an artifact check; it does not claim that either build was run.
 */
export async function checkPerformanceArtifacts({ normalDist, qaDist }) {
  const normalRoot = resolveDirectory(normalDist, "normalDist");
  const qaRoot = resolveDirectory(qaDist, "qaDist");
  const [normal, qa] = await Promise.all([
    inspectDirectory(normalRoot),
    inspectDirectory(qaRoot),
  ]);
  const forbiddenInNormal = [BRIDGE_MARKER, BRIDGE_MODULE_MARKER, BOUNDARY_BRIDGE_MODULE_MARKER, CONFIG_MARKER, BOUNDARY_MODE_MARKER]
    .flatMap((marker) => normal.pathsWithMarker(marker).map((file) => ({ marker, file })));
  const missingInQa = [BRIDGE_MARKER].filter((marker) => !qa.hasMarker(marker));
  return {
    passed: forbiddenInNormal.length === 0 && missingInQa.length === 0,
    normal: {
      root: normal.root,
      fileCount: normal.files.length,
      sha256: normal.sha256,
      forbiddenMarkers: forbiddenInNormal,
    },
    qa: {
      root: qa.root,
      fileCount: qa.files.length,
      sha256: qa.sha256,
      requiredMarkers: [BRIDGE_MARKER],
      missingMarkers: missingInQa,
    },
  };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const normalDist = argumentValue(args, "--normal-dist");
  const qaDist = argumentValue(args, "--qa-dist");
  if (!normalDist || !qaDist) throw new Error("Usage: node scripts/qa/check-performance-build.mjs --normal-dist DIR --qa-dist DIR");
  const result = await checkPerformanceArtifacts({ normalDist, qaDist });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
