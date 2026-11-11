import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  MIN_INTERACTIVE_ROUNDS,
  MIN_OPERATIONS_PER_ROUND,
  MIN_STARTUP_SAMPLES,
  PERFORMANCE_FIXTURE_SCHEMA_VERSION,
} from "./performance-fixtures.mjs";

export const PERFORMANCE_REPORT_SCHEMA_VERSION = 1;
export const REQUIRED_STARTUP_STAGES = Object.freeze(["cold-new-profile", "warm-restart"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim().length > 0 && value !== "unknown";
}

function validSha(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function keyPart(value) {
  return value == null ? "" : String(value);
}

function startupStage(sample) {
  return sample.startupStage || sample.stage || "";
}

function measurementStage(sample) {
  return sample.measurementStage || "";
}

function interactiveKey(sample) {
  return [
    sample.fixtureId,
    sample.mode,
    sample.operation,
    sample.location,
    measurementStage(sample),
    sample.method,
    sample.buildId,
    sample.probeMode,
    sample.timingMetric,
  ].map(keyPart).join("|");
}

function expectedInteractiveKey(expected) {
  return [
    expected.fixtureId,
    expected.mode,
    expected.operation,
    expected.location,
    expected.measurementStage,
    expected.method,
    expected.buildId,
    expected.probeMode,
    expected.timingMetric,
  ].map(keyPart).join("|");
}

function correctnessKey(entry) {
  return [
    entry.fixtureId,
    entry.round,
    entry.operation,
    entry.location,
    entry.measurementStage,
    entry.method,
    entry.buildId,
    entry.probeMode,
  ].map(keyPart).join("|");
}

export function percentile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("Percentile probability must be between 0 and 1.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1));
  return sorted[index];
}

function durationForSample(sample) {
  // The launcher must provide the selected metric explicitly. In particular,
  // started-to-rAF is never inferred from timestamps and mixed with a bridge
  // duration. Physical presentation is not measured by this report layer.
  return finiteNonNegative(sample.durationMs) ? sample.durationMs : null;
}

function failureReason(sample) {
  return sample.failureReason || sample.error || sample.status || "unknown failure";
}

function sampleStatus(sample) {
  if (sample.status === "failed" || sample.success === false) return "failed";
  if (sample.status === "ok" || sample.status === "passed" || sample.success === true) return "ok";
  return "failed";
}

// Each clock below is browser-monotonic except the explicitly separate host
// CDP round trip. Missing observations remain missing; no phase is inferred
// from a different clock or substituted for physical presentation.
export function summarizeMeasurementStages(samples) {
  const phases = {
    synchronousCommandMs: sample => sample.synchronousCommandMs,
    modelComputeMs: sample => sample.modelComputeMs,
    dispatchObservableMs: sample => sample.dispatchObservableMs,
    keyHandlerObservableMs: sample => sample.keyHandlerObservableMs,
    viewUpdateObservableMs: sample => sample.viewUpdateObservableMs,
    remainingKeyHandlerObservableMs: sample => sample.remainingKeyHandlerObservableMs,
    dispatchToModelPublicationMs: sample => delta(sample, "modelAcceptedAt"),
    dispatchToDomObserverMs: sample => delta(sample, "domUpdatedAt"),
    dispatchToRafOpportunityMs: sample => delta(sample, "rafOpportunityAt"),
    dispatchToPresentationObservedMs: sample => delta(sample, "presentationObservedAt"),
    hostCdpRoundTripMs: sample => sample.launcherInputCallDurationMs,
    dispatchToCompositorReadbackUpperBoundMs: sample => {
      const start = sample.timings?.dispatchAt;
      const end = sample.compositorObservation?.browserObservedAt;
      return finiteNonNegative(start) && finiteNonNegative(end) && end >= start ? end - start : null;
    },
  };
  function delta(sample, key) {
    const start = sample.timings?.dispatchAt;
    const end = sample.timings?.[key];
    return finiteNonNegative(start) && finiteNonNegative(end) && end >= start ? end - start : null;
  }
  const stats = values => ({ count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: values.length ? Math.max(...values) : null });
  const interactive = samples.filter(sample => sample.kind === "interactive");
  const successful = interactive.filter(sample => sampleStatus(sample) === "ok");
  const longTasks = interactive.flatMap(sample => sample.longTasks || []).map(entry => entry.duration).filter(finiteNonNegative);
  return {
    sampleCount: interactive.length,
    failedCount: interactive.length - successful.length,
    failedSamples: interactive.filter(sample => sampleStatus(sample) !== "ok").map(sample => ({ sampleId: sample.sampleId, reason: failureReason(sample) })),
    phases: Object.fromEntries(Object.entries(phases).map(([name, measure]) => {
      const values = successful.map(measure).filter(finiteNonNegative);
      return [name, { ...stats(values), missingCount: successful.length - values.length }];
    })),
    longTasks: { ...stats(longTasks), observedSamples: interactive.filter(sample => Array.isArray(sample.longTasks)).length, missingSamples: interactive.filter(sample => !Array.isArray(sample.longTasks)).length, note: "entries overlap operation intervals; overlapping intervals may include the same long task" },
    interpretation: "DOM is MutationObserver callback time; rAF is an opportunity, never evidence of physical presentation. Host CDP duration includes transport. Null means unobserved.",
  };
}

function summarizeGroup(samples, { kind = "interactive" } = {}) {
  const failures = samples.filter((sample) => sampleStatus(sample) !== "ok");
  const successful = samples.filter((sample) => sampleStatus(sample) === "ok");
  const durations = successful.map(durationForSample).filter((value) => finiteNonNegative(value));
  const invalidTimingCount = successful.length - durations.length;
  const rounds = new Map();
  const operationPairs = new Set();
  let duplicateOperationCount = 0;
  for (const sample of samples) {
    const round = sample.round == null ? "unassigned" : String(sample.round);
    const current = rounds.get(round) || {
      round: sample.round ?? null,
      sampleCount: 0,
      successfulCount: 0,
      failedCount: 0,
      uniqueOperationCount: 0,
      duplicateOperationCount: 0,
    };
    current.sampleCount += 1;
    if (sampleStatus(sample) === "ok") current.successfulCount += 1;
    else current.failedCount += 1;
    if (sample.round != null && sample.index != null) {
      const operationKey = `${sample.round}|${sample.index}`;
      if (operationPairs.has(operationKey)) {
        current.duplicateOperationCount += 1;
        duplicateOperationCount += 1;
      } else {
        operationPairs.add(operationKey);
        current.uniqueOperationCount += 1;
      }
    }
    rounds.set(round, current);
  }
  const roundValues = [...rounds.values()].filter((round) => round.round != null);
  const sufficientRounds = kind === "startup"
    ? successful.length >= MIN_STARTUP_SAMPLES
    : roundValues.length >= MIN_INTERACTIVE_ROUNDS
      && roundValues.every((round) => round.uniqueOperationCount >= MIN_OPERATIONS_PER_ROUND);
  const noFailures = failures.length === 0 && invalidTimingCount === 0 && duplicateOperationCount === 0;
  return {
    sampleCount: samples.length,
    successfulCount: successful.length,
    failedCount: failures.length,
    failureReasons: [...new Set(failures.map(failureReason))],
    invalidTimingCount,
    duplicateOperationCount,
    rounds: roundValues,
    coverage: {
      requiredRounds: kind === "startup" ? null : MIN_INTERACTIVE_ROUNDS,
      requiredOperationsPerRound: kind === "startup" ? MIN_STARTUP_SAMPLES : MIN_OPERATIONS_PER_ROUND,
      observedRounds: roundValues.length,
      sufficient: sufficientRounds,
    },
    statistics: {
      sampleCount: durations.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length > 0 ? Math.max(...durations) : null,
      p99Ms: null,
      p99Eligible: false,
      p99Note: "not reported during pre-sampled phase",
    },
    measurementStages: kind === "interactive" ? summarizeMeasurementStages(samples) : null,
    status: sufficientRounds && noFailures ? "eligible" : "insufficient-or-failed",
  };
}

function sampleIdentityIssues(samples) {
  const seen = new Map();
  const issues = [];
  for (const [index, sample] of samples.entries()) {
    const sampleId = typeof sample.sampleId === "string" ? sample.sampleId.trim() : "";
    if (!sampleId) {
      issues.push({ index, code: "missing-sample-id", message: "every raw sample needs a unique sampleId" });
      continue;
    }
    if (seen.has(sampleId)) {
      issues.push({ index, code: "duplicate-sample-id", sampleId, firstIndex: seen.get(sampleId) });
    } else {
      seen.set(sampleId, index);
    }
  }
  return issues;
}

function sampleEvidenceIssues(samples, { expectedBuildId = null } = {}) {
  const issues = [];
  const required = ["method", "buildId", "probeMode", "timingMetric"];
  for (const [index, sample] of samples.entries()) {
    for (const field of required) {
      if (!present(sample[field])) issues.push({ index, code: `missing-${field}`, field });
    }
    if (expectedBuildId && sample.buildId !== expectedBuildId) {
      issues.push({ index, code: "build-id-mismatch", expectedBuildId, actualBuildId: sample.buildId || null });
    }
    if (!present(measurementStage(sample)) && sample.kind !== "startup") {
      issues.push({ index, code: "missing-measurement-stage", field: "measurementStage" });
    }
    if (sample.kind === "startup" && !present(startupStage(sample))) {
      issues.push({ index, code: "missing-startup-stage", field: "startupStage" });
    }
  }
  return issues;
}

export function evaluateSamplingGate(samples, {
  expectedFixtureIds = [],
  expectedInteractiveGroups = [],
  expectedStartupStages = REQUIRED_STARTUP_STAGES,
  expectedBuildId = null,
  requireStartup = true,
} = {}) {
  const allSamples = Array.isArray(samples) ? samples : [];
  const startupSamples = allSamples.filter((sample) => sample.kind === "startup");
  const interactiveSamples = allSamples.filter((sample) => sample.kind !== "startup");
  const identityIssues = sampleIdentityIssues(allSamples);
  const evidenceIssues = sampleEvidenceIssues(allSamples, { expectedBuildId });

  const startupGroups = new Map();
  for (const sample of startupSamples) {
    const stage = startupStage(sample) || "unassigned";
    const key = [stage, measurementStage(sample), sample.method, sample.buildId, sample.probeMode, sample.timingMetric]
      .map(keyPart)
      .join("|");
    startupGroups.set(key, [...(startupGroups.get(key) || []), sample]);
  }
  const startupSummaries = [...startupGroups.entries()].map(([key, group]) => ({
    key,
    stage: startupStage(group[0]) || "unassigned",
    measurementStage: measurementStage(group[0] || {}),
    method: group[0]?.method || null,
    buildId: group[0]?.buildId || null,
    probeMode: group[0]?.probeMode || null,
    timingMetric: group[0]?.timingMetric || null,
    summary: summarizeGroup(group, { kind: "startup" }),
  }));
  const missingStartupStages = expectedStartupStages.filter(
    (stage) => !startupSummaries.some((summary) => summary.stage === stage),
  );
  const invalidStartupStages = startupSummaries.filter((summary) => summary.summary.status !== "eligible");
  const startupPassed = !requireStartup || (
    missingStartupStages.length === 0
    && invalidStartupStages.length === 0
  );

  const groups = new Map();
  for (const sample of interactiveSamples) {
    const key = interactiveKey(sample);
    groups.set(key, [...(groups.get(key) || []), sample]);
  }
  const groupSummaries = [...groups.entries()].map(([key, group]) => ({
    key,
    fixtureId: group[0]?.fixtureId || null,
    mode: group[0]?.mode || null,
    operation: group[0]?.operation || null,
    location: group[0]?.location || null,
    measurementStage: measurementStage(group[0] || {}),
    method: group[0]?.method || null,
    buildId: group[0]?.buildId || null,
    probeMode: group[0]?.probeMode || null,
    timingMetric: group[0]?.timingMetric || null,
    summary: summarizeGroup(group),
  }));
  const requiredGroups = expectedInteractiveGroups.length > 0
    ? expectedInteractiveGroups
    : expectedFixtureIds.map((fixtureId) => ({ fixtureId }));
  const missingGroups = requiredGroups.filter((expected) => {
    const expectedKey = expectedInteractiveKey(expected);
    return !groupSummaries.some((group) => group.key === expectedKey);
  });
  const missingFixtureIds = expectedFixtureIds.filter((fixtureId) => (
    !groupSummaries.some((group) => group.fixtureId === fixtureId)
  ));
  const invalidGroups = groupSummaries.filter((group) => group.summary.status !== "eligible");
  const passed = startupPassed
    && missingGroups.length === 0
    && missingFixtureIds.length === 0
    && invalidGroups.length === 0
    && identityIssues.length === 0
    && evidenceIssues.length === 0;
  return {
    passed,
    status: passed ? "passed" : "insufficient-or-failed",
    startup: {
      passed: startupPassed,
      expectedStages: expectedStartupStages,
      missingStages: missingStartupStages,
      invalidStages: invalidStartupStages.map(({ stage, summary }) => ({
        stage,
        status: summary.status,
        failedCount: summary.failedCount,
        coverage: summary.coverage,
      })),
      stages: startupSummaries,
    },
    interactive: groupSummaries,
    expected: {
      startupSamplesPerStage: requireStartup ? MIN_STARTUP_SAMPLES : 0,
      fixtureIds: expectedFixtureIds,
      groups: requiredGroups,
    },
    missingGroups,
    missingFixtureIds,
    invalidGroups: invalidGroups.map(({ key, fixtureId, mode, operation, location, summary }) => ({
      key,
      fixtureId,
      mode,
      operation,
      location,
      status: summary.status,
      failedCount: summary.failedCount,
      coverage: summary.coverage,
    })),
    identityIssues,
    evidenceIssues,
  };
}

function correctnessEntryPasses(entry) {
  // Check failure status first so a contradictory { status: "failed",
  // passed: true } cannot accidentally authorize a result.
  if (entry?.status === "failed" || entry?.passed === false) return false;
  if (entry?.status === "not-applicable") return entry.feedbackVerified === true;
  const requiredChecks = ["bytesCompared", "syntaxCompared", "selectionCompared", "historyCompared", "sentinelCompared"];
  if (!requiredChecks.every((field) => entry?.[field] === true)) return false;
  return entry?.passed === true || entry?.status === "passed";
}

export function evaluateCorrectnessGate(checks, {
  expectedFixtureIds = [],
  expectedKeys = [],
} = {}) {
  const entries = Array.isArray(checks) ? checks : [];
  const expected = expectedKeys.length > 0
    ? expectedKeys
    : expectedFixtureIds.map((fixtureId) => ({ fixtureId }));
  const presentKeys = new Map();
  const duplicateKeys = [];
  for (const [index, entry] of entries.entries()) {
    const key = correctnessKey(entry);
    if (presentKeys.has(key)) duplicateKeys.push({ key, firstIndex: presentKeys.get(key), index });
    else presentKeys.set(key, index);
  }
  const missingChecks = expected.filter((entry) => !presentKeys.has(correctnessKey(entry)));
  const failures = entries.filter((entry) => !correctnessEntryPasses(entry));
  const passed = expected.length > 0
    && missingChecks.length === 0
    && duplicateKeys.length === 0
    && failures.length === 0
    && entries.length > 0;
  return {
    passed,
    status: passed ? "passed" : "failed",
    checkedCount: entries.length,
    expectedCount: expected.length,
    missingChecks,
    duplicateChecks: duplicateKeys,
    failures: failures.map((entry) => ({
      fixtureId: entry.fixtureId || null,
      round: entry.round ?? null,
      operation: entry.operation || null,
      status: entry.status || null,
      reason: entry.reason || entry.error || "correctness check failed",
    })),
    notApplicable: entries
      .filter((entry) => entry.status === "not-applicable")
      .map((entry) => ({ fixtureId: entry.fixtureId || null, round: entry.round ?? null, operation: entry.operation || null, reason: entry.reason || null })),
  };
}

export function evaluateEvidenceCompleteness({
  build = {},
  machine = {},
  fixtureManifest = {},
  bridge = {},
  samples = [],
} = {}) {
  const issues = [];
  if (build.measurementKind === "synthetic") issues.push({ code: "synthetic-build", message: "synthetic tests cannot authorize a production comparison" });
  if (build.environment !== "release") issues.push({ code: "not-release", message: "release environment is required" });
  if (!present(build.buildId)) issues.push({ code: "missing-build-id", message: "build id is required to bind raw samples" });
  if (!present(build.head || build.commit?.head)) issues.push({ code: "missing-commit", message: "exact source commit is missing" });
  if (!validSha(build.workingTreeSha256 || build.workingTreeHash)) issues.push({ code: "missing-working-tree-hash", message: "working-tree evidence hash is missing" });
  if (!validSha(build.frontendSha256 || build.frontend?.sha256)) issues.push({ code: "missing-frontend-hash", message: "frontend artifact hash is missing" });
  if (!validSha(build.executableSha256 || build.executable?.sha256)) issues.push({ code: "missing-executable-hash", message: "executable artifact hash is missing" });
  if (!validSha(build.configSha256 || build.config?.sha256)) issues.push({ code: "missing-config-hash", message: "isolated config hash is missing" });
  if (!present(machine.os?.release) || !present(machine.os?.version)) issues.push({ code: "missing-os", message: "OS build metadata is missing" });
  if (!present(machine.cpu?.model) || !finiteNonNegative(machine.physicalMemoryBytes) || machine.physicalMemoryBytes <= 0) {
    issues.push({ code: "missing-machine", message: "CPU and physical-memory metadata are required" });
  }
  if (!present(machine.runtimes?.node) || !present(machine.runtimes?.webview2) || !present(machine.runtimes?.rust)) {
    issues.push({ code: "missing-runtimes", message: "Node, WebView2 and Rust versions are required" });
  }
  if (!finiteNonNegative(machine.viewport?.width) || !finiteNonNegative(machine.viewport?.height)
    || !finiteNonNegative(machine.devicePixelRatio) || machine.devicePixelRatio <= 0) {
    issues.push({ code: "missing-viewport", message: "viewport and device-pixel-ratio metadata are required" });
  }
  if (!present(machine.powerState) || !present(machine.foreground)) issues.push({ code: "missing-machine-state", message: "power/frontmost state is required" });
  if (fixtureManifest.schemaVersion !== PERFORMANCE_FIXTURE_SCHEMA_VERSION || !validSha(fixtureManifest.sha256) || !present(fixtureManifest.path)) {
    issues.push({ code: "missing-fixture-evidence", message: "fixture manifest path, schema and hash are required" });
  }
  if (bridge.version !== 1 || bridge.nonceBound !== true || bridge.ownedProcess !== true || bridge.ownedProfile !== true
    || bridge.runtimePathsVerified !== true) {
    issues.push({ code: "unbound-bridge", message: "bridge nonce, process, profile and Tauri runtime-path ownership evidence is required" });
  }
  if (!present(bridge.nonce) || !present(bridge.expectedOrigin) || !present(bridge.profileToken) || !present(bridge.probeMode)) {
    issues.push({ code: "missing-bridge-metadata", message: "bridge nonce/origin/profile/probe metadata is required" });
  }
  issues.push(...sampleEvidenceIssues(samples, { expectedBuildId: build.buildId || null }));
  return {
    passed: issues.length === 0,
    status: issues.length === 0 ? "complete" : "partial-or-invalid",
    issues,
  };
}

export function collectMachineMetadata({
  viewport = null,
  devicePixelRatio = null,
  powerState = "unknown",
  foreground = "unknown",
  webview2 = "unknown",
  rust = "unknown",
} = {}) {
  const cpus = os.cpus();
  return {
    capturedAt: new Date().toISOString(),
    os: {
      platform: process.platform,
      release: os.release() || "unknown",
      version: typeof os.version === "function" ? os.version() : "unknown",
      arch: process.arch,
    },
    cpu: {
      model: cpus[0]?.model || "unknown",
      logicalCpuCount: cpus.length || null,
    },
    physicalMemoryBytes: os.totalmem() || null,
    runtimes: {
      node: process.version,
      v8: process.versions.v8 || "unknown",
      webview2,
      rust,
    },
    viewport,
    devicePixelRatio,
    powerState,
    foreground,
  };
}

export async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  return { path: filePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function defaultCorrectnessKeys(expectedFixtureIds, expectedInteractiveGroups) {
  const keys = [];
  for (const group of expectedInteractiveGroups) {
    for (let round = 1; round <= MIN_INTERACTIVE_ROUNDS; round += 1) {
      keys.push({ ...group, round });
    }
  }
  if (keys.length > 0) return keys;
  return expectedFixtureIds.map((fixtureId) => ({ fixtureId }));
}

export function buildPerformanceReport({
  build = {},
  machine = collectMachineMetadata(),
  fixtureManifest = {},
  bridge = {},
  samples = [],
  correctnessChecks = [],
  memorySamples = [],
  expectedFixtureIds = [],
  expectedInteractiveGroups = [],
  expectedCorrectnessKeys = [],
  expectedStartupStages = REQUIRED_STARTUP_STAGES,
  requireStartup = true,
  diagnosticOnly = false,
  generatedAt = new Date().toISOString(),
} = {}) {
  const fixtureIds = expectedFixtureIds.length > 0
    ? expectedFixtureIds
    : (fixtureManifest.fixtures || []).map((fixture) => fixture.id);
  const sampling = evaluateSamplingGate(samples, {
    expectedFixtureIds: fixtureIds,
    expectedInteractiveGroups,
    expectedStartupStages,
    expectedBuildId: build.buildId || null,
    requireStartup,
  });
  const correctness = evaluateCorrectnessGate(correctnessChecks, {
    expectedFixtureIds: fixtureIds,
    expectedKeys: expectedCorrectnessKeys.length > 0
      ? expectedCorrectnessKeys
      : defaultCorrectnessKeys(fixtureIds, expectedInteractiveGroups),
  });
  const evidence = evaluateEvidenceCompleteness({ build, machine, fixtureManifest, bridge, samples });
  const comparisonValid = !diagnosticOnly && sampling.passed && correctness.passed && evidence.passed;
  return {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    diagnosticOnly,
    generatedAt,
    judgment: build.measurementKind === "synthetic" ? "synthetic-test-only" : "pre-sampled-pending-baseline",
    build,
    machine,
    bridge,
    fixtureManifest: {
      schemaVersion: fixtureManifest.schemaVersion || PERFORMANCE_FIXTURE_SCHEMA_VERSION,
      fixtureCount: fixtureIds.length,
      fixtureIds,
      sha256: fixtureManifest.sha256 || null,
      path: fixtureManifest.path || null,
    },
    evidence,
    sampling,
    correctness,
    measurementStages: summarizeMeasurementStages(samples),
    memory: { samples: memorySamples, note: "JS heap snapshots at fixture/round boundaries; process tree memory requires launcher evidence. Retained growth cannot be inferred from one final snapshot." },
    verdict: {
      validForPerformanceComparison: comparisonValid,
      reason: diagnosticOnly ? "diagnostic-only run cannot authorize a full performance comparison" : comparisonValid
        ? "release evidence, required samples and per-round correctness checks passed; baseline review remains pending"
        : "performance comparison is invalid until release evidence, sampling and correctness gates pass",
      p99ClaimAllowed: false,
    },
    rawSamples: null,
  };
}

function normalizeOutputRoot(root) {
  if (typeof root !== "string" || root.trim().length === 0) throw new TypeError("An output directory is required.");
  return path.resolve(root);
}

export async function writePerformanceResult(outputRoot, report, samples = []) {
  const root = normalizeOutputRoot(outputRoot);
  await mkdir(root, { recursive: true });
  const rawPath = path.join(root, "raw-samples.ndjson");
  const rawBytes = Buffer.from(samples.map((sample) => `${JSON.stringify(sample)}\n`).join(""), "utf8");
  await writeFile(rawPath, rawBytes);
  const completedReport = {
    ...report,
    rawSamples: {
      path: "raw-samples.ndjson",
      bytes: rawBytes.byteLength,
      sha256: sha256(rawBytes),
      sampleCount: samples.length,
    },
  };
  const reportPath = path.join(root, "performance-report.json");
  await writeFile(reportPath, `${JSON.stringify(completedReport, null, 2)}\n`, "utf8");
  return { reportPath, rawPath, report: completedReport };
}
