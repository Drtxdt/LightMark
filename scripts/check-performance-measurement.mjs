import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createPerformanceFixtures,
  EXACT_SIZE_BYTES,
  fixturePath,
  PERFORMANCE_FIXTURE_IDS,
  readPerformanceFixtureManifest,
} from "./qa/performance-fixtures.mjs";
import {
  buildPerformanceReport,
  collectMachineMetadata,
  evaluateCorrectnessGate,
  evaluateSamplingGate,
  writePerformanceResult,
  summarizeMeasurementStages,
} from "./qa/performance-report.mjs";
import { checkPerformanceArtifacts } from "./qa/check-performance-build.mjs";
import { parseArguments } from "./qa/performance-release-launcher.mjs";
import ts from "typescript";

const runRoot = await mkdtemp(path.join(os.tmpdir(), "lightmark-perf-measurement-"));
try {
  const stressArguments = parseArguments(['--formula-stress']);
  assert.equal(stressArguments.formulaStress, true);
  assert.equal(stressArguments.rounds, 3);
  assert.equal(stressArguments.operations, 100);
  assert.throws(() => parseArguments(['--formula-stress', '--smoke']), /cannot be combined/);
  assert.throws(() => parseArguments(['--formula-stress', '--operations', '1']), /unchanged 3×100/);
  const reportSource = await readFile('scripts/qa/performance-report.mjs', 'utf8');
  const reportAst = ts.createSourceFile('report.mjs', reportSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const reportFunction = reportAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildPerformanceReport').getText(reportAst).replace(/^export\s+/, '');
  const withPassingGates = new Function('collectMachineMetadata', 'evaluateSamplingGate', 'evaluateCorrectnessGate', 'evaluateEvidenceCompleteness', 'summarizeMeasurementStages', 'defaultCorrectnessKeys', 'REQUIRED_STARTUP_STAGES', 'PERFORMANCE_REPORT_SCHEMA_VERSION', 'PERFORMANCE_FIXTURE_SCHEMA_VERSION', `${reportFunction}; return buildPerformanceReport;`)(
    () => ({}), () => ({ passed: true }), () => ({ passed: true }), () => ({ passed: true }), () => ({}), () => [], [], 1, 1,
  );
  assert.equal(withPassingGates().verdict.validForPerformanceComparison, true);
  const diagnosticVerdict = withPassingGates({ diagnosticOnly: true });
  assert.equal(diagnosticVerdict.diagnosticOnly, true);
  assert.equal(diagnosticVerdict.verdict.validForPerformanceComparison, false, 'diagnostic mode stays ineligible even if every sampling/evidence/correctness gate passes');
  assert.match(diagnosticVerdict.verdict.reason, /diagnostic-only/);
  const launcherSource = await readFile('scripts/qa/performance-release-launcher.mjs', 'utf8');
  const launcherAst = ts.createSourceFile('launcher.mjs', launcherSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const operationNode = launcherAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'oneInteractiveOperation');
  const keyCalls = [];
  const oneOperation = new Function('bridgeCall', 'monotonicMs', 'serializeError', 'failureSample', 'PROBE_MODE', `${operationNode.getText(launcherAst)}; return oneInteractiveOperation;`)(
    async (_client, method) => method === 'prepareOperation'
      ? { supported: true, sampleId: 'formula-test', method: 'cdp.Input.dispatchKeyEvent' }
      : { status: 'ok', sampleId: 'formula-test', feedbackVerified: true },
    () => 0, error => ({ message: String(error) }), () => { throw new Error('unexpected failure'); }, 'synthetic',
  );
  const formulaOperation = await oneOperation({ runToken: 'test', buildId: 'synthetic' }, {
    call: async (method, params) => { keyCalls.push({ method, params }); },
  }, { fixtureId: 'formula-dense', mode: 'wysiwyg', operation: 'formula-commit', location: 'head' }, 1, 0, { warmup: true });
  assert.equal(formulaOperation.status, 'ok');
  assert.deepEqual(keyCalls.map(call => [call.method, call.params.type, call.params.key, call.params.modifiers]), [
    ['Input.dispatchKeyEvent', 'keyDown', 'Enter', 2], ['Input.dispatchKeyEvent', 'keyUp', 'Enter', 2],
  ], 'formula commit uses actual CDP Ctrl+Enter, not Backspace or a direct model transaction');

  const fixtureSet = await createPerformanceFixtures(runRoot, { largeDocumentBytes: 5 * 1024 * 1024 + 1024 });
  const manifest = await readPerformanceFixtureManifest(runRoot);
  assert.equal(fixtureSet.manifestPath, fixturePath(runRoot, "performance-fixtures.manifest.json"));
  assert.deepEqual(manifest.fixtures.map((fixture) => fixture.id), PERFORMANCE_FIXTURE_IDS);
  assert.equal(manifest.assets.length, 6);
  for (const asset of manifest.assets) {
    const bytes = await readFile(fixturePath(runRoot, asset.relativePath));
    assert.equal(bytes.byteLength, asset.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    assert.ok(asset.width > 0 && asset.height > 0);
    if (asset.format === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    if (asset.format === "jpeg") {
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.equal(bytes.at(-2), 0xff);
      assert.equal(bytes.at(-1), 0xd9);
    }
  }
  for (const fixture of [...manifest.fixtures, ...manifest.thresholds]) {
    const bytes = await readFile(fixturePath(runRoot, fixture.relativePath));
    assert.equal(bytes.byteLength, fixture.metrics.utf8Bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    assert.ok(fixture.metrics.utf16Length > 0);
    assert.equal((bytes.toString("utf8").match(/LM_PERF_SENTINEL_(?:BEFORE|AFTER)_[A-Z0-9_]+_KEEP/gu) || []).length, 2, `${fixture.id} has two production-recognized sentinels`);
    assert.ok(fixture.metrics.lineCount > 0);
    assert.equal(fixture.metrics.blockCountMethod, "blank-line-groups-estimate");
    assert.equal(fixture.metrics.maxLineCodePoints, fixture.metrics.maxLineLength);
    assert.ok(fixture.markers.operationEndUtf8Offset > fixture.markers.operationStartUtf8Offset);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  assert.deepEqual(
    Object.fromEntries(manifest.thresholds.map((fixture) => [fixture.id, fixture.metrics.utf8Bytes])),
    {
      "utf8-below": EXACT_SIZE_BYTES.below,
      "utf8-exact": EXACT_SIZE_BYTES.exact,
      "utf8-above": EXACT_SIZE_BYTES.above,
    },
  );
  assert.equal(manifest.fixtures.find((fixture) => fixture.id === "formula-dense").metrics.formulaCount > 0, true);
  assert.equal(manifest.fixtures.find((fixture) => fixture.id === "table-dense").metrics.tableCount, 2);
  assert.equal(manifest.fixtures.find((fixture) => fixture.id === "image-dense").metrics.imageCount, 80);
  assert.ok(manifest.fixtures.find((fixture) => fixture.id === "long-lines").metrics.maxLineLength > 4000);
  assert.deepEqual(manifest.fixtures.find((fixture) => fixture.id === "large-document").supportedModes, ["source"]);
  assert.deepEqual(manifest.fixtures.find((fixture) => fixture.id === "long-lines").supportedModes, ["source", "wysiwyg"]);
  for (const [id, pattern] of [["source-50000-lines", /^line \d+ 中文🙂$/gmu], ["wys-50000-paragraphs", /^paragraph \d+$/gmu]]) {
    const fixture = manifest.fixtures.find(item => item.id === id);
    const text = await readFile(fixturePath(runRoot, fixture.relativePath), "utf8");
    const payload = text.slice(fixture.payload.utf16Start, fixture.payload.utf16End);
    assert.equal([...payload.matchAll(pattern)].length, 50_000, `${id} exact payload count`);
  }
  const phases = summarizeMeasurementStages([
    { kind: "interactive", status: "ok", synchronousCommandMs: 2, timings: { dispatchAt: 10, modelAcceptedAt: 13, domUpdatedAt: 16, rafOpportunityAt: 20, presentationObservedAt: null }, longTasks: [{ startTime: 10, duration: 55 }] },
    { kind: "interactive", status: "failed", sampleId: "failed-one", failureReason: "timeout" },
  ]);
  assert.equal(phases.phases.synchronousCommandMs.p50Ms, 2);
  assert.equal(phases.phases.dispatchToModelPublicationMs.p95Ms, 3);
  assert.equal(phases.phases.dispatchToRafOpportunityMs.maxMs, 10);
  assert.equal(phases.phases.dispatchToPresentationObservedMs.count, 0);
  assert.equal(phases.phases.dispatchToPresentationObservedMs.missingCount, 1);
  assert.equal(phases.failedCount, 1);
  assert.equal(phases.longTasks.maxMs, 55);
  assert.equal(new Set(manifest.assets.filter((asset) => asset.format === "png").map((asset) => asset.sha256)).size, 3);
  assert.equal(manifest.assets.filter((asset) => asset.format === "jpeg").length, 1);

  const samples = [];
  for (const startupStage of ["cold-new-profile", "warm-restart"]) {
    for (let index = 0; index < 10; index += 1) {
      samples.push({
        kind: "startup",
        startupStage,
        measurementStage: "startup-request-to-ready",
        status: "ok",
        durationMs: 20 + index / 10,
        index,
        sampleId: `startup-${startupStage}-${index}`,
        method: "owned-release-launcher",
        buildId: "synthetic-build",
        probeMode: "no-extra-instrumentation",
        timingMetric: "request-to-ready",
      });
    }
  }
  const expectedGroups = [];
  const expectedCorrectnessKeys = [];
  for (const fixtureId of PERFORMANCE_FIXTURE_IDS) {
    const group = {
      fixtureId,
      mode: "source",
      operation: "input",
      location: "middle",
      measurementStage: "input-to-raf-opportunity",
      method: "owned-test-bridge",
      buildId: "synthetic-build",
      probeMode: "no-extra-instrumentation",
      timingMetric: "dispatch-to-raf-opportunity",
    };
    expectedGroups.push(group);
    for (let round = 1; round <= 3; round += 1) expectedCorrectnessKeys.push({ ...group, round });
    for (let round = 1; round <= 3; round += 1) {
      for (let index = 0; index < 100; index += 1) {
        samples.push({
          kind: "interactive",
          fixtureId,
          mode: "source",
          operation: "input",
          location: "middle",
          measurementStage: "input-to-raf-opportunity",
          round,
          index,
          sampleId: `${fixtureId}-round-${round}-index-${index}`,
          status: "ok",
          method: "owned-test-bridge",
          buildId: "synthetic-build",
          probeMode: "no-extra-instrumentation",
          timingMetric: "dispatch-to-raf-opportunity",
          durationMs: 1.2 + index / 1000,
          timings: {
            startedAt: 1000 + index,
            dispatchAt: 1000 + index + 0.1,
            modelAcceptedAt: 1000 + index + 0.2,
            domUpdatedAt: 1000 + index + 0.4,
            rafOpportunityAt: 1000 + index + 1.2,
          },
        });
      }
    }
  }
  const correctnessChecks = expectedCorrectnessKeys.map((expected) => ({
    ...expected,
    operation: "input-roundtrip",
    status: "passed",
    passed: true,
    bytesCompared: true,
    syntaxCompared: true,
    selectionCompared: true,
    historyCompared: true,
    sentinelCompared: true,
  }));
  const correctnessExpected = expectedCorrectnessKeys.map((expected) => ({
    ...expected,
    operation: "input-roundtrip",
  }));
  const sampling = evaluateSamplingGate(samples, {
    expectedFixtureIds: PERFORMANCE_FIXTURE_IDS,
    expectedInteractiveGroups: expectedGroups,
  });
  assert.equal(sampling.passed, true);
  assert.equal(sampling.startup.stages.length, 2);
  assert.ok(sampling.startup.stages.every((stage) => stage.summary.status === "eligible"));
  assert.equal(sampling.interactive.length, PERFORMANCE_FIXTURE_IDS.length);
  assert.ok(sampling.interactive.every((group) => group.summary.statistics.p95Ms != null));
  assert.ok(sampling.interactive.every((group) => group.summary.statistics.p99Ms == null));
  assert.equal(evaluateCorrectnessGate(correctnessChecks, {
    expectedFixtureIds: PERFORMANCE_FIXTURE_IDS,
    expectedKeys: correctnessExpected,
  }).passed, true);

  const report = buildPerformanceReport({
    build: {
      environment: "release",
      measurementKind: "synthetic",
      head: "synthetic-head",
      workingTreeSha256: "c".repeat(64),
      frontendSha256: "d".repeat(64),
      executableSha256: "a".repeat(64),
      configSha256: "e".repeat(64),
    },
    machine: collectMachineMetadata({
      viewport: { width: 1200, height: 780 },
      devicePixelRatio: 1,
      webview2: "synthetic-webview2",
      rust: "synthetic-rust",
      powerState: "ac",
      foreground: "owned-window",
    }),
    fixtureManifest: { ...manifest, path: "fixtures/performance-fixtures.manifest.json", sha256: "b".repeat(64) },
    bridge: {
      version: 1,
      nonceBound: true,
      ownedProcess: true,
      ownedProfile: true,
      nonce: "synthetic-nonce",
      expectedOrigin: "tauri://localhost",
      profileToken: "synthetic-profile",
      probeMode: "no-extra-instrumentation",
    },
    samples,
    correctnessChecks,
    expectedFixtureIds: PERFORMANCE_FIXTURE_IDS,
    expectedInteractiveGroups: expectedGroups,
    expectedCorrectnessKeys: correctnessExpected,
  });
  assert.equal(report.judgment, "synthetic-test-only");
  assert.equal(report.evidence.passed, false);
  assert.equal(report.verdict.validForPerformanceComparison, false);
  const result = await writePerformanceResult(path.join(runRoot, "result"), report, samples);
  const raw = await readFile(result.rawPath, "utf8");
  assert.equal(raw.split("\n").filter(Boolean).length, samples.length);
  assert.equal(result.report.rawSamples.sampleCount, samples.length);
  assert.equal(result.report.rawSamples.sha256, createHash("sha256").update(raw).digest("hex"));

  const normalDist = path.join(runRoot, "normal-dist");
  const qaDist = path.join(runRoot, "qa-dist");
  await Promise.all([mkdir(normalDist), mkdir(qaDist)]);
  await writeFile(path.join(normalDist, "index.js"), "console.log('normal');\n", "utf8");
  await writeFile(path.join(qaDist, "index.js"), "window.__LIGHTMARK_PERF_BRIDGE__ = {};\n", "utf8");
  const cleanArtifacts = await checkPerformanceArtifacts({ normalDist, qaDist });
  assert.equal(cleanArtifacts.passed, true);
  await writeFile(path.join(normalDist, "qa-marker.js"), "performanceQaBridge\n", "utf8");
  const contaminatedArtifacts = await checkPerformanceArtifacts({ normalDist, qaDist });
  assert.equal(contaminatedArtifacts.passed, false);
  assert.equal(contaminatedArtifacts.normal.forbiddenMarkers.some((entry) => entry.marker === "performanceQaBridge"), true);
  await writeFile(path.join(normalDist, "boundary-qa-marker.js"), "desktopContentBoundaryQaBridge\n", "utf8");
  const boundaryContaminatedArtifacts = await checkPerformanceArtifacts({ normalDist, qaDist });
  assert.equal(boundaryContaminatedArtifacts.normal.forbiddenMarkers.some((entry) => entry.marker === "desktopContentBoundaryQaBridge"), true);

  const failedSampling = evaluateSamplingGate(
    samples.slice(0, 10).concat([{
      kind: "interactive",
      fixtureId: "normal-writing",
      status: "failed",
      failureReason: "DOM mismatch",
      sampleId: "failed-sample",
      measurementStage: "input-to-raf-opportunity",
      method: "owned-test-bridge",
      buildId: "synthetic-build",
      probeMode: "no-extra-instrumentation",
      timingMetric: "dispatch-to-raf-opportunity",
    }]),
    {
      expectedStartupStages: ["cold-new-profile"],
      expectedFixtureIds: ["normal-writing"],
      expectedInteractiveGroups: [{
        fixtureId: "normal-writing",
        measurementStage: "input-to-raf-opportunity",
        method: "owned-test-bridge",
        buildId: "synthetic-build",
        probeMode: "no-extra-instrumentation",
        timingMetric: "dispatch-to-raf-opportunity",
      }],
    },
  );
  assert.equal(failedSampling.passed, false);
  assert.equal(failedSampling.startup.stages[0].summary.statistics.p99Ms, null);
  assert.equal(failedSampling.interactive[0].summary.statistics.p99Ms, null);
  assert.equal(evaluateCorrectnessGate([
    { fixtureId: "normal-writing", round: 1, operation: "input-roundtrip", status: "failed", passed: true },
  ], { expectedFixtureIds: ["normal-writing"] }).passed, false);
  const withoutStartup = evaluateSamplingGate(samples.filter((sample) => sample.kind !== "startup"), {
    requireStartup: false,
    expectedFixtureIds: PERFORMANCE_FIXTURE_IDS,
    expectedInteractiveGroups: expectedGroups,
    expectedBuildId: "synthetic-build",
  });
  assert.equal(withoutStartup.passed, true);
  assert.equal(evaluateSamplingGate(
    [samples.find((sample) => sample.kind === "interactive"), samples.find((sample) => sample.kind === "interactive")],
    { requireStartup: false },
  ).identityIssues.some((issue) => issue.code === "duplicate-sample-id"), true);

  assert.throws(() => parseArguments([
    "--launch",
    "--build-qa",
    "--executable",
    path.join(runRoot, "outside.exe"),
    "--output",
    path.join(runRoot, "rejected-launch-output"),
  ]), /External --executable is disabled/iu);
  assert.throws(() => parseArguments(["--unknown-launcher-flag"]), /Unknown launcher argument/iu);

  console.log(JSON.stringify({
    message: "performance fixture/report checks passed in an isolated temp directory",
    fixtureCount: manifest.fixtures.length,
    thresholdBytes: Object.fromEntries(manifest.thresholds.map((fixture) => [fixture.id, fixture.metrics.utf8Bytes])),
    sampleCount: samples.length,
    report: result.reportPath,
  }, null, 2));
} finally {
  await rm(runRoot, { recursive: true, force: true });
}
