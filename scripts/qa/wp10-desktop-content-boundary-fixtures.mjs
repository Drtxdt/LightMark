import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const WP10_FIXTURE_SCHEMA_VERSION = 1;
export const WP10_FIXTURE_ID = "wp10-export-resource-boundary";
export const WP10_FORBIDDEN_SENTINEL = "WP10_FORBIDDEN_PSEUDO_PNG_SENTINEL_8E2F_KEEP";
export const WP10_FORBIDDEN_TEXT_SENTINEL = "WP10_FORBIDDEN_TEXT_RESOURCE_SENTINEL_2A71_KEEP";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const ALLOWED_PARENT_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">',
  '<rect width="64" height="32" fill="#f4efe6"/>',
  '<rect x="7" y="7" width="50" height="18" rx="4" fill="#78a6d3"/>',
  '<path d="M14 20h36" stroke="#111318" stroke-width="3"/>',
  "</svg>\n",
].join("");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return path.resolve(candidate);
  }
  throw new Error(`WP10 fixture path escapes the owned root: ${candidate}`);
}

function assertSafeRelative(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`WP10 fixture relative path is invalid: ${relativePath}`);
  }
  if (relativePath.split(/[\\/]+/u).includes("..")) {
    throw new Error(`WP10 fixture relative path contains traversal: ${relativePath}`);
  }
  return relativePath;
}

async function assertNoSymlinks(root) {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`WP10 fixture root is a symlink: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`WP10 fixture root is not a directory: ${root}`);
  async function visit(current) {
    for (const name of await readdir(current)) {
      const candidate = path.join(current, name);
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`WP10 fixture tree contains a symlink: ${candidate}`);
      if (stat.isDirectory()) await visit(candidate);
    }
  }
  await visit(root);
}

async function writeOwned(root, relativePath, content) {
  const safe = assertSafeRelative(relativePath);
  const absolute = assertWithin(root, path.join(root, safe));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

async function describeFile(root, relativePath, { role, mediaType = null, expectedMime = null } = {}) {
  const safe = assertSafeRelative(relativePath);
  const absolute = assertWithin(root, path.join(root, safe));
  const bytes = await readFile(absolute);
  return {
    relativePath: safe.replaceAll("\\", "/"),
    path: absolute,
    role,
    mediaType,
    expectedMime,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function imageReference(source, alt) {
  return `![${alt}](${source})`;
}

export function buildBoundaryMarkdown() {
  return [
    "# WP10 export resource boundary fixture",
    "",
    "The two first images are allowed local resources used for compatibility comparison.",
    "",
    imageReference("same.png", "allowed same directory image"),
    "",
    imageReference("../parent.svg", "allowed parent directory image"),
    "",
    "The next reference intentionally points to a neighboring forbidden fixture directory.",
    "",
    imageReference("../../forbidden/forbidden.png", "forbidden pseudo image"),
    "",
    imageReference("../../forbidden/forbidden.txt", "forbidden text resource"),
    "",
  ].join("\n");
}

function resourcePath(root, documentPath, source) {
  return assertWithin(root, path.resolve(path.dirname(documentPath), source));
}

export async function createWp10BoundaryFixture(root) {
  const ownedRoot = path.resolve(root);
  await mkdir(ownedRoot, { recursive: true });
  await assertNoSymlinks(ownedRoot);

  const documentRelativePath = "allowed/docs/export-boundary.md";
  const documentPath = await writeOwned(ownedRoot, documentRelativePath, buildBoundaryMarkdown());
  await writeOwned(ownedRoot, "allowed/docs/same.png", ONE_BY_ONE_PNG);
  await writeOwned(ownedRoot, "allowed/parent.svg", ALLOWED_PARENT_SVG);
  // The pseudo-image deliberately has a .png suffix but is plain UTF-8 text.
  // It is a harmless sentinel used to observe whether export reads arbitrary
  // bytes and labels them from the extension alone.
  await writeOwned(ownedRoot, "forbidden/forbidden.png", `${WP10_FORBIDDEN_SENTINEL}\n`);
  await writeOwned(ownedRoot, "forbidden/forbidden.txt", `${WP10_FORBIDDEN_TEXT_SENTINEL}\n`);
  await assertNoSymlinks(ownedRoot);

  const allowedRoot = await realpath(path.join(ownedRoot, "allowed"));
  const forbiddenRoot = await realpath(path.join(ownedRoot, "forbidden"));
  const document = await describeFile(ownedRoot, documentRelativePath, { role: "document", mediaType: "text/markdown" });
  const resources = [
    {
      id: "allowed-same-directory",
      source: "same.png",
      resolvedPath: resourcePath(ownedRoot, documentPath, "same.png"),
      role: "allowed",
      mediaType: "image/png",
      expectedMime: "image/png",
    },
    {
      id: "allowed-parent-directory",
      source: "../parent.svg",
      resolvedPath: resourcePath(ownedRoot, documentPath, "../parent.svg"),
      role: "allowed",
      mediaType: "image/svg+xml",
      expectedMime: "image/svg+xml",
    },
    {
      id: "forbidden-pseudo-image",
      source: "../../forbidden/forbidden.png",
      resolvedPath: resourcePath(ownedRoot, documentPath, "../../forbidden/forbidden.png"),
      role: "forbidden-neighbor",
      mediaType: "text/plain-bytes-with-png-suffix",
      expectedMime: "image/png",
      sentinel: WP10_FORBIDDEN_SENTINEL,
    },
    {
      id: "forbidden-text-resource",
      source: "../../forbidden/forbidden.txt",
      resolvedPath: resourcePath(ownedRoot, documentPath, "../../forbidden/forbidden.txt"),
      role: "forbidden-neighbor",
      mediaType: "text/plain",
      expectedMime: "image/png",
      sentinel: WP10_FORBIDDEN_TEXT_SENTINEL,
    },
  ];
  const describedResources = [];
  for (const resource of resources) {
    const relativePath = path.relative(ownedRoot, resource.resolvedPath);
    const description = await describeFile(ownedRoot, relativePath, resource);
    describedResources.push({ ...resource, ...description, source: resource.source });
  }

  const manifest = {
    schemaVersion: WP10_FIXTURE_SCHEMA_VERSION,
    fixtureId: WP10_FIXTURE_ID,
    generatedBy: "scripts/qa/wp10-desktop-content-boundary-fixtures.mjs",
    root: ownedRoot,
    allowedRoot,
    forbiddenRoot,
    document,
    resources: describedResources,
    boundary: {
      allowedResources: ["allowed-same-directory", "allowed-parent-directory"],
      forbiddenResources: ["forbidden-pseudo-image", "forbidden-text-resource"],
      forbiddenSentinels: [WP10_FORBIDDEN_SENTINEL, WP10_FORBIDDEN_TEXT_SENTINEL],
      expectation: "pending-native-export-observation",
      productCommand: "read_export_resource",
      productMimeRuleUnderTest: "extension-derived fallback in inlineExportResources",
      readExportResourceInvoked: false,
    },
  };
  const manifestPath = await writeOwned(
    ownedRoot,
    "wp10-desktop-content-boundary.manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { root: ownedRoot, manifestPath, manifest };
}

export async function readWp10BoundaryManifest(root) {
  const ownedRoot = path.resolve(root);
  const manifestPath = assertWithin(ownedRoot, path.join(ownedRoot, "wp10-desktop-content-boundary.manifest.json"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== WP10_FIXTURE_SCHEMA_VERSION || manifest.fixtureId !== WP10_FIXTURE_ID) {
    throw new Error("Unsupported WP10 boundary fixture manifest.");
  }
  if (path.resolve(manifest.root) !== ownedRoot) throw new Error("WP10 manifest root does not match the owned fixture root.");
  await assertNoSymlinks(ownedRoot);
  return { root: ownedRoot, manifestPath, manifest };
}

export async function inspectWp10FixtureResource(fixture, resource) {
  if (!fixture?.root || !resource?.relativePath) throw new TypeError("A fixture and resource are required.");
  const absolute = assertWithin(fixture.root, path.join(fixture.root, assertSafeRelative(resource.relativePath)));
  const bytes = await readFile(absolute);
  const text = bytes.toString("utf8");
  return {
    resourceId: resource.id,
    path: absolute,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    utf8: text,
    isPngSignature: bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    readSucceeded: true,
  };
}

export async function createTemporaryWp10BoundaryFixture(prefix = "lightmark-wp10-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return await createWp10BoundaryFixture(root);
}

export { ONE_BY_ONE_PNG };
