import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WP10_FORBIDDEN_SENTINEL,
  WP10_FORBIDDEN_TEXT_SENTINEL,
  createTemporaryWp10BoundaryFixture,
  inspectWp10FixtureResource,
  readWp10BoundaryManifest,
} from "./qa/wp10-desktop-content-boundary-fixtures.mjs";
import { checkBoundaryArtifacts } from "./qa/wp10-desktop-content-boundary-launcher.mjs";

// TEMP may name a Windows alias. Compare actual directories component by
// component; a string prefix can also mistake a sibling for a descendant.
async function assertDescendant(root, candidate) {
  const relative = path.relative(await realpath(root), await realpath(candidate));
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
    `${candidate} must be a descendant of ${root}`);
}

const fixture = await createTemporaryWp10BoundaryFixture();
try {
  const loaded = await readWp10BoundaryManifest(fixture.root);
  const { manifest } = loaded;
  assert.equal(manifest.boundary.productCommand, "read_export_resource");
  assert.equal(manifest.boundary.readExportResourceInvoked, false);
  assert.deepEqual(manifest.boundary.allowedResources, [
    "allowed-same-directory",
    "allowed-parent-directory",
  ]);
  assert.deepEqual(manifest.boundary.forbiddenResources, [
    "forbidden-pseudo-image",
    "forbidden-text-resource",
  ]);

  const documentBytes = await readFile(manifest.document.path);
  assert.equal(documentBytes.byteLength, manifest.document.bytes);
  assert.match(documentBytes.toString("utf8"), /same\.png/iu);
  assert.match(documentBytes.toString("utf8"), /\.\.\/parent\.svg/iu);
  assert.match(documentBytes.toString("utf8"), /forbidden\/forbidden\.png/iu);
  assert.match(documentBytes.toString("utf8"), /forbidden\/forbidden\.txt/iu);

  const observations = [];
  for (const resource of manifest.resources) {
    const observation = await inspectWp10FixtureResource(fixture, resource);
    observations.push(observation);
    assert.equal(observation.sha256, resource.sha256);
    assert.equal(observation.bytes, resource.bytes);
    assert.equal(observation.readSucceeded, true);
    if (resource.role === "allowed") {
      await assertDescendant(manifest.allowedRoot, observation.path);
      assert.equal(observation.utf8.includes("WP10_FORBIDDEN"), false);
    } else {
      await assertDescendant(manifest.forbiddenRoot, observation.path);
      assert.equal(observation.utf8.includes(resource.sentinel), true);
    }
  }

  const same = observations.find((entry) => entry.resourceId === "allowed-same-directory");
  const parent = observations.find((entry) => entry.resourceId === "allowed-parent-directory");
  const pseudoImage = observations.find((entry) => entry.resourceId === "forbidden-pseudo-image");
  const textResource = observations.find((entry) => entry.resourceId === "forbidden-text-resource");
  assert.equal(same.isPngSignature, true);
  assert.match(parent.utf8, /^<svg\b/iu);
  assert.equal(pseudoImage.isPngSignature, false);
  assert.match(pseudoImage.utf8, new RegExp(WP10_FORBIDDEN_SENTINEL, "u"));
  assert.match(textResource.utf8, new RegExp(WP10_FORBIDDEN_TEXT_SENTINEL, "u"));

  await assertDescendant(fixture.root, manifest.allowedRoot);
  await assertDescendant(fixture.root, manifest.forbiddenRoot);
  assert.equal(manifest.allowedRoot !== manifest.forbiddenRoot, true);

  const normalDist = path.join(fixture.root, "artifact-normal");
  const qaDist = path.join(fixture.root, "artifact-qa");
  await mkdir(normalDist);
  await mkdir(qaDist);
  const binary = Buffer.from([0x00, 0x80, 0xff, 0x0a]);
  await writeFile(path.join(normalDist, "binary.bin"), binary);
  await writeFile(path.join(qaDist, "bridge.js"), "globalThis.__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__ = true;\n", "utf8");
  const artifactCheck = await checkBoundaryArtifacts({ normalDist, qaDist });
  assert.equal(artifactCheck.passed, true);
  assert.equal(artifactCheck.forbiddenMarkers.length, 0);
  assert.equal(artifactCheck.qaMarker.includes("bridge.js"), true);
  assert.equal(artifactCheck.normal.files[0].sha256, createHash("sha256").update(binary).digest("hex"));

  await writeFile(path.join(normalDist, "leaked-bridge.js"), "desktopContentBoundaryQaBridge", "utf8");
  const contaminated = await checkBoundaryArtifacts({ normalDist, qaDist });
  assert.equal(contaminated.passed, false);
  assert.deepEqual(contaminated.forbiddenMarkers, [{ marker: "desktopContentBoundaryQaBridge", file: "leaked-bridge.js" }]);

  console.log(JSON.stringify({
    status: "fixture-ready-not-product-evidence",
    fixtureId: manifest.fixtureId,
    resourceCount: manifest.resources.length,
    allowedResources: manifest.boundary.allowedResources,
    forbiddenResources: manifest.boundary.forbiddenResources,
    readExportResourceInvoked: false,
    artifactBoundaryCheck: {
      cleanPassed: artifactCheck.passed,
      contaminationRejected: contaminated.passed === false,
      binaryHashChecked: true,
    },
    observation: "filesystem bytes only; native renderer/export path remains unverified",
  }, null, 2));
} finally {
  await rm(fixture.root, { recursive: true, force: true });
}
