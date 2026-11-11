import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createNativeLargeSourceFixture, runNativeLargeSourceProbe } from "./native-large-source-probe.mjs";
import {
  captureRepositoryEvidence,
  createEvidenceDirectory,
  repositoryRoot,
  runCaptured,
  writeJson,
} from "./evidence.mjs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const requestedOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!requestedOutput || requestedOutput.startsWith("--"))) {
  throw new Error("--output requires a directory path");
}
const scenarioIndex = args.indexOf("--scenario");
const requestedScenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] : "smoke";
const supportedScenarios = new Set(["smoke", "html-security", "math-receipt", "recovery-bundle", "lm004-pending", "native-close-buffer", "normal-document", "export-document", "manual-ui", "large-source", "find-integrity", "workspace-profile", "split-images"]);
const MATH_PROBE_WAIT_TIMEOUT_MS = 15000;
const MATH_PROBE_EVALUATE_TIMEOUT_MS = 60000;
const MATH_PROBE_POLL_INTERVAL_MS = 25;
if (scenarioIndex >= 0 && (!requestedScenario || requestedScenario.startsWith("--"))) {
  throw new Error("--scenario requires a scenario name");
}
if (!supportedScenarios.has(requestedScenario)) {
  throw new Error(`Unsupported native QA scenario: ${requestedScenario}`);
}

class NativeIsolationError extends Error {}

async function main() {
  const result = args.includes("--launch")
    ? await launchEvidence(requestedOutput, requestedScenario)
    : summarizePrepared(await prepareEvidence(requestedOutput, requestedScenario));
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
}

async function prepareEvidence(requestedPath, scenario = "smoke") {
  const runDir = path.resolve(await createEvidenceDirectory("lightmark-native-qa-", requestedPath));
  const runToken = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const identifier = `com.lightmark.qa.${runToken.replace(/[^a-z0-9]/gi, "")}`.toLowerCase();
  const configDir = path.join(runDir, "config");
  const fixtureDir = path.join(runDir, "fixtures");
  const outputDir = path.join(runDir, "output");
  const logDir = path.join(runDir, "logs");
  await Promise.all([configDir, fixtureDir, outputDir, logDir].map((dir) => mkdir(dir, { recursive: true })));

  const baseConfigPath = path.join(repositoryRoot, "src-tauri", "tauri.conf.json");
  const baseConfig = JSON.parse(await readFile(baseConfigPath, "utf8"));
  const windows = baseConfig.app?.windows;
  if (scenario === "manual-ui" && Array.isArray(windows)) {
    for (const window of windows) if (!window.label || window.label === "main") window.title = `LightMark QA Manual ${runToken}`;
  }
  if (Array.isArray(windows) && windows.some((window) => window?.dataDirectory != null)) {
    throw new NativeIsolationError(
      "The base Tauri configuration already overrides dataDirectory; refusing to infer profile isolation.",
    );
  }

  const configPath = path.join(configDir, "tauri.qa.json");
  const fixture = createScenarioFixture(scenario, runToken);
  const fixturePath = path.join(fixtureDir, fixture.fileName);
  const { fixtureContent } = fixture;
  await writeLaunchConfig(configPath, baseConfig, identifier, 1420, `${runToken}-prepared`);
  await writeFile(fixturePath, fixtureContent, "utf8");

  assertWithin(runDir, configPath);
  assertWithin(runDir, fixturePath);
  assertWithin(runDir, outputDir);
  assertWithin(runDir, logDir);

  const evidence = await captureRepositoryEvidence(repositoryRoot, runDir);
  const roamingRoot = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const expectedAppConfigDir = path.resolve(roamingRoot, identifier);
  const expectedAppDataDir = path.resolve(roamingRoot, identifier);
  const expectedAppLocalDataDir = path.resolve(localRoot, identifier);
  const expectedWebviewProfileDir = path.join(expectedAppLocalDataDir, "EBWebView");
  const manifest = {
    schemaVersion: 2,
    kind: "lightmark-native-evidence",
    status: "prepared-not-launched",
    createdAt: new Date().toISOString(),
    repositoryRoot,
    runDir,
    configPath,
    identifier,
    scenario,
    scenarioEvidence: fixture.evidence,
    isolation: {
      expectedAppConfigDir,
      expectedAppDataDir,
      expectedAppLocalDataDir,
      expectedWebviewProfileDir,
      profileBinding: "tauri-default:identifier",
      reason: "A unique Tauri identifier is used and the base configuration has no window dataDirectory override; runtime paths are checked before and after launch.",
      preexistingPathsChecked: false,
    },
    fixtures: [fixturePath],
    outputDir,
    logDir,
    execution: {
      entryScript: "scripts/qa/isolated-native-evidence.mjs",
      importedHelpers: ["scripts/qa/evidence.mjs"],
    },
    launch: {
      invoked: false,
      cdpInvoked: false,
      phases: [],
      cleanup: "retain-run-directory-and-isolated-profile-for-review",
    },
    repository: evidence,
  };
  const context = {
    runDir,
    runToken,
    identifier,
    configPath,
    fixturePath,
    fixtureContent,
    scenario,
    scenarioEvidence: fixture.evidence,
    outputDir,
    logDir,
    baseConfig,
    expectedAppConfigDir,
    expectedAppDataDir,
    expectedAppLocalDataDir,
    expectedWebviewProfileDir,
    manifest,
  };
  await persistManifest(context);
  return context;
}

function summarizePrepared(context) {
  return {
    runDir: context.runDir,
    configPath: context.configPath,
    fixturePath: context.fixturePath,
    identifier: context.identifier,
    scenario: context.scenario,
    fixture: describeBytes(Buffer.from(context.fixtureContent, "utf8")),
    scenarioEvidence: context.scenarioEvidence,
    status: context.manifest.status,
  };
}

function createScenarioFixture(scenario, runToken) {
  if (scenario === "split-images") {
    return { fileName: "左侧笔记.md", fixtureContent: "![封面](cover.svg)\n",
      evidence: { name: scenario, expectedWidths: [13, 29] } };
  }
  if (scenario === 'find-integrity' || scenario === 'workspace-profile') {
    return { fileName: '查找完整性.md', fixtureContent: 'L$x$R\n\nAİBC!\n',
      evidence: { name: scenario, expectedSaved: 'L$x$Z\n\nAİQC!\n' } };
  }
  if (scenario === 'manual-ui') {
    return { fileName: 'native-manual-ui.md', fixtureContent: '# 原生中文输入验收\n\nIME_TARGET：请在这一段使用真实中文输入法。\n\n第二段用于选区、撤销、切换模式和保存重开。\n\n```text\nCODE_TARGET literal **text** $x$\n```\n\nFORMULA_TARGET $x^2$\n',
      evidence: { name: scenario, note: 'A dedicated visible native window stays alive until an explicit finish sentinel; no IME or visual success is inferred.' } };
  }

  if (scenario === "large-source") return createNativeLargeSourceFixture(runToken);
  if (scenario === "smoke") {
    return {
      fileName: "native-isolation-smoke.md",
      fixtureContent: [
        "# QA fixture",
        "",
        "This fixture belongs to one isolated evidence run.",
        "",
        "| key | value |",
        "| --- | --- |",
        "| profile | temporary |",
        "",
      ].join("\n"),
    evidence: {
      name: "smoke",
    },
  };
  }
  if (scenario === "math-receipt") {
    const fixtureContent = [
      "# Math receipt fixture",
      "",
      "A $x$ B",
      "",
    ].join("\n");
    return {
      fileName: "native-isolation-math-receipt.md",
      fixtureContent,
      evidence: {
        name: "math-receipt",
        initialFormula: "x",
        draftInitialFormula: "d",
        savedFormula: "x+1",
        draftFormula: "draft+1",
        expectedSavedContent: fixtureContent.replace("$x$", "$x+1$"),
        expectedDraftContent: "Draft $draft+1$",
        notes: "The WYSIWYG editor remains focused during ordinary save; close-dialog blur is recorded separately and is not treated as pending-flush evidence.",
      },
    };
  }
  if (scenario === "recovery-bundle" || scenario === "lm004-pending" || scenario === "native-close-buffer" || scenario === "normal-document" || scenario === "export-document") {
    const fixtureContent = [
      "---",
      "title: Recovery bundle fixture",
      "qa: native",
      "---",
      "",
      "# Recovery bundle fixture",
      "",
      "The source file must remain byte-identical while the recovery bundle is exercised.",
      "",
      "[TOC]",
      "",
      "<div data-lightmark-qa=\"html-block\"><b>accepted html</b></div>",
      "",
      "A footnote reference[^qa] is present in the real source fixture.",
      "",
      "[^qa]: accepted footnote",
      "",
    ].join("\n");
    return {
      fileName: "native-recovery-bundle.md",
      fixtureContent,
      evidence: {
        name: scenario,
        sourceFixture: fixtureContent,
        footnoteSentinel: "recovery-footnote-raw-html-sentinel",
        notes: scenario === "lm004-pending"
          ? "The probe owns a fresh Tauri profile, opens this real Markdown fixture through the production file path, exercises ordinary focused NodeView input and runtime snapshots, and never writes the fixture source file."
          : "The probe owns a fresh Tauri profile, opens this real Markdown fixture through the production file path, verifies the real PM DOMParser and recovery NodeViews, and never writes the fixture source file.",
      },
    };
  }
  if (scenario !== "html-security") {
    throw new NativeIsolationError(`Unsupported native QA scenario: ${scenario}`);
  }

  const thresholdBytes = 5 * 1024 * 1024 + 1;
  const sentinel = `${runToken}-html-security-sentinel`;
  const onerror = `this.dataset.lightmarkQaSentinel='${sentinel}'`;
  const maliciousSource = "data:image/png;base64,aA==";
  const safeSource = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const marker = `<img data-type="inline-math" src="${maliciousSource}" onerror="${onerror}">`;
  const safeFigure = `<figure data-lightmark-image data-align="center"><img src="${safeSource}" alt="isolated-safe-image"></figure>`;
  const fillerLine = "LightMark isolated HTML security fixture filler.\n";
  let fixtureContent = [
    marker,
    safeFigure,
    "",
    "# Large HTML security fixture",
    "",
  ].join("\n");
  const fillerBytes = Buffer.byteLength(fillerLine, "utf8");
  const prefixBytes = Buffer.byteLength(fixtureContent, "utf8");
  const repetitions = Math.max(0, Math.floor((thresholdBytes - prefixBytes) / fillerBytes));
  fixtureContent += fillerLine.repeat(repetitions);
  const remainingBytes = thresholdBytes - Buffer.byteLength(fixtureContent, "utf8");
  if (remainingBytes > 0) fixtureContent += "x".repeat(remainingBytes);

  return {
    fileName: "native-isolation-html-security.md",
    fixtureContent,
    evidence: {
      name: "html-security",
      thresholdBytes,
      sentinel,
      marker,
      safeFigure,
      maliciousSource,
      safeSource,
      onerrorEffect: "sets only the test image dataset sentinel",
    },
  };
}

async function launchEvidence(requestedPath, scenario = "smoke") {
  if (process.platform !== "win32") {
    throw new NativeIsolationError("The native isolated launcher currently requires Windows WebView2.");
  }
  const forbiddenEnvironment = [
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "WEBVIEW2_USER_DATA_FOLDER",
    "WEBVIEW2_USER_DATA_DIR",
    "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
    "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
  ];
  const inheritedOverrides = forbiddenEnvironment.filter((name) => Object.hasOwn(process.env, name));
  if (inheritedOverrides.length > 0) {
    throw new NativeIsolationError(
      `Refusing inherited WebView2 isolation overrides: ${inheritedOverrides.join(", ")}`,
    );
  }

  const context = await prepareEvidence(requestedPath, scenario);
  const isolatedPaths = uniquePaths([
    context.expectedAppConfigDir,
    context.expectedAppDataDir,
    context.expectedAppLocalDataDir,
  ]);
  try {
    await assertPathsAbsent(isolatedPaths, "before native launch");
    context.manifest.status = "launching";
    context.manifest.isolation.preexistingPathsChecked = true;
    context.manifest.launch.invoked = true;
    await persistManifest(context);

    if (context.scenario === "large-source") {
      const phase = await runNativePhase(context, "large-source", client => runNativeLargeSourceProbe(client, context));
      const saved = await readFile(context.fixturePath);
      let expected = context.scenarioEvidence.expectedSavedPrefix + context.fixtureContent + (context.scenarioEvidence.expectedSavedSuffix ?? '');
      for (const [from, to] of context.scenarioEvidence.expectedSavedReplacements ?? []) expected = expected.replace(from, to);
      assertBytesEqual(saved, Buffer.from(expected, "utf8"), "large source saved and reopened bytes");
      phase.diskAfterClose = describeBytes(saved);
      context.manifest.launch.stateArchive = await archiveIsolatedState(context);
      context.manifest.status = "passed";
      await persistManifest(context);
      return { runDir: context.runDir, identifier: context.identifier, scenario: context.scenario, status: "passed", probe: phase.probe };
    }
    if (context.scenario === "html-security") {
      const phase = await runNativePhase(context, "html-security", async (client) => {
        return await runHtmlSecurityProbe(client, context);
      });
      const afterProbe = await readFile(context.fixturePath);
      assertBytesEqual(afterProbe, Buffer.from(context.fixtureContent, "utf8"), "HTML security fixture after probe");
      phase.diskAfterClose = describeBytes(afterProbe);
      await persistManifest(context);

      await assertPathsPresent([context.expectedAppConfigDir], "after HTML security probe config persistence");
      await assertPathsPresent(
        [context.expectedAppLocalDataDir, context.expectedWebviewProfileDir],
        "after HTML security probe WebView2 launch",
      );
      const stateArchive = await archiveIsolatedState(context);
      context.manifest.launch.stateArchive = stateArchive;
      context.manifest.launch.cleanupResult = {
        retained: isolatedPaths,
        note: "The random-identifier Tauri config, data, and WebView2 profile are retained for evidence review.",
      };
      context.manifest.status = "passed";
      await persistManifest(context);
      return {
        runDir: context.runDir,
        identifier: context.identifier,
        scenario: context.scenario,
        fixturePath: context.fixturePath,
        status: context.manifest.status,
        phases: context.manifest.launch.phases.map((nativePhase) => ({
          name: nativePhase.name,
          status: nativePhase.status,
          pid: nativePhase.pid,
          cdpPort: nativePhase.cdpPort,
          vitePort: nativePhase.vitePort,
          probe: nativePhase.probe,
        })),
        stateArchive,
        retainedIsolationPaths: isolatedPaths,
      };
    }

    if (context.scenario === "math-receipt") {
      const expectedSaved = Buffer.from(context.scenarioEvidence.expectedSavedContent, "utf8");
      const savePhase = await runNativePhase(context, "math-save", async (client) => {
        return await runMathSaveProbe(client, context);
      });
      const afterSave = await readFile(context.fixturePath);
      assertBytesEqual(afterSave, expectedSaved, "real WYSIWYG Math save");
      savePhase.diskAfterClose = describeBytes(afterSave);
      await persistManifest(context);

      await assertPathsPresent([context.expectedAppConfigDir], "after real Math save config persistence");
      await assertPathsPresent(
        [context.expectedAppLocalDataDir, context.expectedWebviewProfileDir],
        "after real Math save WebView2 launch",
      );

      const draftPhase = await runNativePhase(context, "math-window-draft", async (client) => {
        return await runMathWindowDraftProbe(client, context);
      });
      await persistManifest(context);

      const recoveryPhase = await runNativePhase(context, "math-recover", async (client) => {
        return await runMathRecoveryProbe(client, context);
      });
      await persistManifest(context);

      const stateArchive = await archiveIsolatedState(context);
      context.manifest.launch.stateArchive = stateArchive;
      context.manifest.launch.cleanupResult = {
        retained: isolatedPaths,
        note: "The random-identifier Tauri config, data, and WebView2 profile are retained for review; the math receipt fixture and recovery draft stay inside this isolated run.",
      };
      context.manifest.status = "passed";
      await persistManifest(context);
      return {
        runDir: context.runDir,
        identifier: context.identifier,
        scenario: context.scenario,
        fixturePath: context.fixturePath,
        status: context.manifest.status,
        phases: [savePhase, draftPhase, recoveryPhase].map((phase) => ({
          name: phase.name,
          status: phase.status,
          pid: phase.pid,
          cdpPort: phase.cdpPort,
          vitePort: phase.vitePort,
          probe: phase.probe,
          diskAfterClose: phase.diskAfterClose,
        })),
        stateArchive,
        retainedIsolationPaths: isolatedPaths,
      };
    }

    if (context.scenario === 'split-images') {
      const { prepareSplitImages, verifySplitImages } = await import('./native-split-images.mjs');
      const files = await prepareSplitImages(context);
      const phase = await runNativePhase(context, context.scenario, client => verifySplitImages(client, context, files));
      for (const file of files) assertBytesEqual(await readFile(file), Buffer.from(context.fixtureContent), 'original Markdown after split restore');
      context.manifest.status = 'passed';
      await persistManifest(context);
      return { status: 'passed', scenario: context.scenario, runDir: context.runDir, observations: phase.probe };
    }

    if (context.scenario === 'find-integrity' || context.scenario === 'workspace-profile') {
      const { runNativeFindIntegrity } = await import('./native-find-integrity.mjs');
      const damagedProfile = context.scenario === 'workspace-profile';
      const config = path.join(context.expectedAppConfigDir, 'config.json');
      const originalConfig = Buffer.from('{"recentFiles": [ "recover-me.md" ,');
      if (damagedProfile) {
        // The common launcher proved this unique profile did not exist.
        await mkdir(context.expectedAppConfigDir);
        await writeFile(config, originalConfig, { flag: 'wx' });
      }
      const phase = await runNativePhase(context, context.scenario, client => runNativeFindIntegrity(client, context));
      const bytes = await readFile(context.fixturePath);
      assertBytesEqual(bytes, Buffer.from(context.scenarioEvidence.expectedSaved, 'utf8'), 'saved fixture after reopening and closing');
      phase.diskAfterClose = describeBytes(bytes);
      if (damagedProfile) {
        const actual = await readFile(config);
        assertBytesEqual(actual, originalConfig, 'damaged config preserved across edits, save and exit');
        phase.originalConfigAfterClose = describeBytes(actual);
      }
      context.manifest.status = 'passed';
      await persistManifest(context);
      return { runDir: context.runDir, scenario: context.scenario, status: 'passed', steps: phase.probe.steps, diskAfterClose: phase.diskAfterClose, originalConfigAfterClose: phase.originalConfigAfterClose };
    }

    if (context.scenario === 'manual-ui') {
      const { runNativeManualUiProbe } = await import('./native-manual-ui-probe.mjs');
      const phase = await runNativePhase(context, 'manual-ui', client => runNativeManualUiProbe(client, context));
      phase.diskAfterClose = describeBytes(await readFile(context.fixturePath));
      context.manifest.status = phase.probe?.status === 'passed' ? 'passed' : 'failed';
      await persistManifest(context);
      return { runDir: context.runDir, scenario: context.scenario, status: context.manifest.status, phases: [phase] };
    }

    if (context.scenario === 'export-document') {
      const { runNativeExportProbe } = await import('./native-export-probe.mjs');
      const phase = await runNativePhase(context, 'export-document', client => runNativeExportProbe(client, context));
      const afterProbe = await readFile(context.fixturePath);
      assertBytesEqual(afterProbe, Buffer.from(context.fixtureContent, 'utf8'), 'export fixture unchanged');
      phase.diskAfterClose = describeBytes(afterProbe);
      context.manifest.status = phase.probe?.status === 'passed' ? 'passed' : 'failed';
      await persistManifest(context);
      return { runDir: context.runDir, scenario: context.scenario, status: context.manifest.status, phases: [phase] };
    }

    if (context.scenario === 'normal-document') {
      const { runNativeNormalDocumentProbe } = await import('./native-normal-document-probe.mjs');
      const phase = await runNativePhase(context, 'normal-document', client => runNativeNormalDocumentProbe(client, context));
      const afterProbe = await readFile(context.fixturePath);
      assertBytesEqual(afterProbe, Buffer.from(context.fixtureContent, 'utf8'), 'normal document original fixture unchanged');
      phase.diskAfterClose = describeBytes(afterProbe);
      context.manifest.status = phase.probe?.status === 'passed' ? 'passed' : 'failed';
      await persistManifest(context);
      return { runDir: context.runDir, scenario: context.scenario, status: context.manifest.status, phases: [phase] };
    }

    if (context.scenario === 'native-close-buffer') {
      const { runNativeCloseBufferProbe } = await import('./native-close-buffer-probe.mjs');
      const phase = await runNativePhase(context, 'native-close-buffer', client => runNativeCloseBufferProbe(client, context));
      const afterProbe = await readFile(context.fixturePath);
      assertBytesEqual(afterProbe, Buffer.from(context.fixtureContent, 'utf8'), 'close buffer fixture unchanged');
      phase.diskAfterClose = describeBytes(afterProbe);
      context.manifest.status = phase.probe?.status === 'passed' ? 'passed' : 'failed';
      await persistManifest(context);
      return { runDir: context.runDir, scenario: context.scenario, status: context.manifest.status, phases: [phase] };
    }

    if (context.scenario === "lm004-pending") {
      const phase = await runNativePhase(context, "lm004-pending", async (client) => {
        return await runLm004PendingProbe(client, context);
      });
      const afterProbe = await readFile(context.fixturePath);
      assertBytesEqual(afterProbe, Buffer.from(context.fixtureContent, "utf8"), "LM004 fixture after pending probe");
      phase.diskAfterClose = describeBytes(afterProbe);
      const pendingTextSafety = phase.probe?.pendingTextSafety || null;
      context.manifest.launch.recoveryPendingTextSafety = pendingTextSafety;
      await persistManifest(context);

      await assertPathsPresent([context.expectedAppConfigDir], "after LM004 config persistence");
      await assertPathsPresent(
        [context.expectedAppLocalDataDir, context.expectedWebviewProfileDir],
        "after LM004 WebView2 launch",
      );
      const stateArchive = await archiveIsolatedState(context);
      context.manifest.launch.stateArchive = stateArchive;
      context.manifest.launch.cleanupResult = {
        retained: isolatedPaths,
        note: "The random-identifier Tauri config, data, WebView2 profile, LM004 probe result, and untouched source fixture are retained for review.",
      };
      const pendingTextSafetyPassed = pendingTextSafety?.status === "preserved";
      context.manifest.status = pendingTextSafetyPassed ? "passed" : "failed";
      if (!pendingTextSafetyPassed) {
        context.manifest.failure = {
          name: "RecoveryPendingTextSafetyError",
          message: pendingTextSafety?.status === "gap-observed"
            ? "LM004: ordinary WYSIWYG save snapshot omitted a focused local NodeView input."
            : "LM004: ordinary WYSIWYG save snapshot could not prove focused local input preservation.",
        };
      }
      await persistManifest(context);
      const result = {
        runDir: context.runDir,
        identifier: context.identifier,
        scenario: context.scenario,
        fixturePath: context.fixturePath,
        status: context.manifest.status,
        phases: context.manifest.launch.phases.map((nativePhase) => ({
          name: nativePhase.name,
          status: nativePhase.status,
          pid: nativePhase.pid,
          cdpPort: nativePhase.cdpPort,
          vitePort: nativePhase.vitePort,
          probe: nativePhase.probe,
          diskAfterClose: nativePhase.diskAfterClose,
        })),
        stateArchive,
        untouchedFixture: describeBytes(afterProbe),
        retainedIsolationPaths: isolatedPaths,
      };
      if (!pendingTextSafetyPassed) {
        throw new NativeIsolationError(context.manifest.failure.message);
      }
      return result;
    }

    if (context.scenario === "recovery-bundle") {
      const phase = await runNativePhase(context, "recovery-bundle", async (client) => {
        return await runRecoveryBundleProbe(client, context);
      });
      const afterRecovery = await readFile(context.fixturePath);
      assertBytesEqual(afterRecovery, Buffer.from(context.fixtureContent, "utf8"), "recovery bundle fixture after probe");
      phase.diskAfterClose = describeBytes(afterRecovery);
      await persistManifest(context);

      // LM004 is a separate fresh native phase.  It opens the legal Markdown
      // fixture through the production file path and exercises each local
      // text NodeView while focused.  Keeping it in a new process prevents
      // the recovery fixture's intentionally unresolved/mismatch cases from
      // changing the ordinary-save result.
      const pendingPhase = await runNativePhase(context, "lm004-pending", async (client) => {
        return await runLm004PendingProbe(client, context);
      });
      const afterPending = await readFile(context.fixturePath);
      assertBytesEqual(afterPending, Buffer.from(context.fixtureContent, "utf8"), "LM004 fixture after pending probe");
      pendingPhase.diskAfterClose = describeBytes(afterPending);
      const pendingTextSafety = pendingPhase.probe?.pendingTextSafety || null;
      context.manifest.launch.recoveryPendingTextSafety = pendingTextSafety;
      await persistManifest(context);

      await assertPathsPresent([context.expectedAppConfigDir], "after recovery bundle config persistence");
      await assertPathsPresent(
        [context.expectedAppLocalDataDir, context.expectedWebviewProfileDir],
        "after recovery bundle WebView2 launch",
      );
      const stateArchive = await archiveIsolatedState(context);
      context.manifest.launch.stateArchive = stateArchive;
      context.manifest.launch.cleanupResult = {
        retained: isolatedPaths,
        note: "The random-identifier Tauri config, data, WebView2 profile, recovery and LM004 probe results, and untouched source fixture are retained for review.",
      };
      const pendingTextSafetyPassed = pendingTextSafety?.status === "preserved";
      context.manifest.status = pendingTextSafetyPassed ? "passed" : "failed";
      if (!pendingTextSafetyPassed) {
        context.manifest.failure = {
          name: "RecoveryPendingTextSafetyError",
          message: pendingTextSafety?.status === "gap-observed"
            ? "LM004: ordinary WYSIWYG save snapshot omitted focused FrontMatter or Footnotes input."
            : "LM004: ordinary WYSIWYG save snapshot could not prove focused FrontMatter and Footnotes input preservation.",
        };
      }
      await persistManifest(context);
      const result = {
        runDir: context.runDir,
        identifier: context.identifier,
        scenario: context.scenario,
        fixturePath: context.fixturePath,
        status: context.manifest.status,
        phases: context.manifest.launch.phases.map((nativePhase) => ({
          name: nativePhase.name,
          status: nativePhase.status,
          pid: nativePhase.pid,
          cdpPort: nativePhase.cdpPort,
          vitePort: nativePhase.vitePort,
          probe: nativePhase.probe,
          diskAfterClose: nativePhase.diskAfterClose,
        })),
        stateArchive,
        untouchedFixture: describeBytes(afterProbe),
        retainedIsolationPaths: isolatedPaths,
      };
      if (!pendingTextSafetyPassed) {
        throw new NativeIsolationError(context.manifest.failure.message);
      }
      return result;
    }

    const editedContent = `${context.fixtureContent}native QA edit ${context.runToken}\n`;
    const first = await runNativePhase(context, "save-close", async (client) => {
      return await runSaveCloseProbe(client, context, editedContent);
    });
    const afterFirst = await readFile(context.fixturePath);
    assertBytesEqual(afterFirst, Buffer.from(editedContent, "utf8"), "first native save");
    first.diskAfterClose = describeBytes(afterFirst);
    await persistManifest(context);

    await assertPathsPresent([context.expectedAppConfigDir], "after save and config persistence");
    await assertPathsPresent([context.expectedAppLocalDataDir, context.expectedWebviewProfileDir], "after first WebView2 launch");

    const second = await runNativePhase(context, "reopen", async (client) => {
      return await runReopenProbe(client, context, editedContent);
    });
    const afterSecond = await readFile(context.fixturePath);
    assertBytesEqual(afterSecond, Buffer.from(editedContent, "utf8"), "reopen verification");
    second.diskAfterClose = describeBytes(afterSecond);
    await persistManifest(context);

    const stateArchive = await archiveIsolatedState(context);
    context.manifest.launch.stateArchive = stateArchive;
    context.manifest.launch.cleanupResult = {
      retained: isolatedPaths,
      note: "The random-identifier Tauri config, data, and WebView2 profile are retained for evidence review.",
    };
    context.manifest.status = "passed";
    await persistManifest(context);
    return {
      runDir: context.runDir,
      identifier: context.identifier,
      fixturePath: context.fixturePath,
      status: context.manifest.status,
      phases: context.manifest.launch.phases.map((phase) => ({
        name: phase.name,
        status: phase.status,
        pid: phase.pid,
        cdpPort: phase.cdpPort,
        vitePort: phase.vitePort,
      })),
      stateArchive,
      retainedIsolationPaths: isolatedPaths,
    };
  } catch (error) {
    context.manifest.status = "failed";
    context.manifest.failure = serializeError(error);
    await persistManifest(context);
    throw error;
  }
}

async function runNativePhase(context, name, probe) {
  const vitePort = await findFreePort();
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: repositoryRoot,
    logLevel: "error",
    server: { host: "127.0.0.1", port: vitePort, strictPort: true },
  });
  try {
    await vite.listen();
    return await runNativeWindow(context, name, probe, vitePort);
  } finally {
    await vite.close();
  }
}

async function runNativeWindow(context, name, probe, vitePort) {
  const cdpPort = await findFreePort();
  if (vitePort === cdpPort) throw new NativeIsolationError("Vite and CDP ports unexpectedly matched.");
  const targetNonce = `${context.runToken}-${name}-${randomUUID().slice(0, 8)}`;
  await writeLaunchConfig(context.configPath, context.baseConfig, context.identifier, vitePort, targetNonce, true);

  const browserArguments = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
  ].join(" ");

  const phase = {
    name,
    status: "starting",
    startedAt: new Date().toISOString(),
    configPath: context.configPath,
    targetNonce,
    devUrl: `http://127.0.0.1:${vitePort}/?lightmarkQa=${encodeURIComponent(targetNonce)}`,
    vitePort,
    cdpPort,
    command: null,
    args: null,
    selectedEnvironment: {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
      LIGHTMARK_QA_RUN_DIR: context.runDir,
      LIGHTMARK_QA_IDENTIFIER: context.identifier,
      controlledUserDataDir: context.expectedAppLocalDataDir,
      controlledWebviewProfileDir: context.expectedWebviewProfileDir,
    },
    stdoutLog: path.join(context.logDir, `tauri-${name}.stdout.log`),
    stderrLog: path.join(context.logDir, `tauri-${name}.stderr.log`),
  };
  context.manifest.launch.cdpInvoked = true;
  context.manifest.launch.phases.push(phase);
  await persistManifest(context);

  const require = createRequire(import.meta.url);
  const cliPackagePath = require.resolve("@tauri-apps/cli/package.json", { paths: [repositoryRoot] });
  const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
  const cliBin = typeof cliPackage.bin === "string" ? cliPackage.bin : cliPackage.bin?.tauri;
  if (!cliBin) throw new NativeIsolationError("The installed Tauri CLI package has no tauri JavaScript entry point.");
  const cliEntry = path.resolve(path.dirname(cliPackagePath), cliBin);
  if (!isWithin(repositoryRoot, cliEntry) || !(await pathExists(cliEntry))) {
    throw new NativeIsolationError(`Tauri CLI entry was not found at the repository-local path: ${cliEntry}`);
  }
  const commandArgs = [cliEntry, "dev", "--config", context.configPath, "--no-watch"];
  const environment = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
    LIGHTMARK_QA_RUN_DIR: context.runDir,
    LIGHTMARK_QA_IDENTIFIER: context.identifier,
  };
  phase.command = process.execPath;
  phase.args = commandArgs;
  phase.tauriCliEntry = cliEntry;
  phase.tauriCliVersion = cliPackage.version || null;
  const state = spawnNativeProcess(process.execPath, commandArgs, environment, phase);
  let client;
  try {
    phase.status = "waiting-for-target";
    phase.pid = state.child.pid ?? null;
    await persistManifest(context);
    const target = await waitForCdpTarget(state, cdpPort, vitePort, targetNonce);
    phase.target = target.target;
    phase.targetList = target.pages;
    phase.version = target.version;
    phase.status = "target-verified";
    phase.loopback = await waitForLoopbackListener(
      cdpPort,
      context.expectedWebviewProfileDir,
      context.identifier,
      state.child.pid,
    );
    phase.status = "cdp-connecting";
    await persistManifest(context);
    client = await CdpClient.connect(target.target.webSocketDebuggerUrl);
    // Subscribe before the probe mutates the app so a Vue/Tiptap mount
    // exception is retained alongside the DOM progress when a phase fails.
    await client.call("Runtime.enable");
    await client.call("Log.enable");
    phase.status = "probe-running";
    await persistManifest(context);
    const probeResult = await probe(client);
    phase.probe = probeResult;
    phase.closeRequestedAt = new Date().toISOString();
    phase.status = "waiting-for-close";
    await persistManifest(context);
    const exitResult = await waitForExit(state, 30000);
    phase.exit = exitResult;
    if (exitResult.error || exitResult.exitCode !== 0) {
      throw new NativeIsolationError(
        `${name} Tauri process exited unsuccessfully: ${JSON.stringify(exitResult)}`,
      );
    }
    await waitForPortClosed(cdpPort, 10000);
    phase.status = probeResult?.status === 'failed' ? 'failed' : 'passed';
    phase.endedAt = new Date().toISOString();
    await persistManifest(context);
    return phase;
  } catch (error) {
    phase.status = "failed";
    phase.error = serializeError(error);
    phase.probeProgress = client ? await readProbeProgress(client) : null;
    phase.cdpEvents = client?.events?.slice(-120) || [];
    phase.stdoutTail = state.stdoutTail;
    phase.stderrTail = state.stderrTail;
    throw error;
  } finally {
    if (client) await client.close();
    if (state.child.exitCode == null && state.child.signalCode == null) {
      phase.cleanup = await terminateOwnedProcess(state);
    }
    await finishLogStream(state.stdoutStream);
    await finishLogStream(state.stderrStream);
    phase.pid = phase.pid ?? state.child.pid ?? null;
    phase.exit = phase.exit ?? state.exitResult ?? null;
    phase.endedAt = phase.endedAt ?? new Date().toISOString();
    await persistManifest(context);
  }
}

export function createMathProbeSessionPrelude(importExpression = "import(specifier)") {
  return `
    const runtime = await (async (specifier) => ${importExpression})('/src/editor/documentRuntime.ts');
    let session = null;
    const mathProbeWaitTimeoutMs = ${MATH_PROBE_WAIT_TIMEOUT_MS};
    const mathProbePollIntervalMs = ${MATH_PROBE_POLL_INTERVAL_MS};
  `;
}

export function createMathCurrentEditorPrelude() {
  return `
    const currentEditor = () => {
      const tab = store.getPaneTab('main');
      if (!tab) return null;
      const panes = [...document.querySelectorAll('.lm-editor-pane')];
      let roots;
      if (store.appStore.splitLayout.enabled) {
        if (store.appStore.splitLayout.activePaneId !== 'main') return null;
        const activePanes = panes.filter((pane) => pane.classList?.contains?.('active'));
        if (activePanes.length !== 1) return null;
        roots = activePanes;
      } else {
        const workspaces = [...document.querySelectorAll('main.lm-workspace')];
        if (workspaces.length !== 1) return null;
        roots = workspaces;
      }
      const shells = roots.flatMap((root) => [...root.querySelectorAll('.lm-editor-scroll')]);
      const matchingShells = shells.filter((candidate) =>
        candidate.isConnected && candidate.querySelectorAll('.ProseMirror').length === 1,
      );
      const settledShells = matchingShells.filter((candidate) => {
        const pageClasses = [...(candidate.closest('.editor-page')?.classList || [])];
        return !pageClasses.some((className) => /-leave-(active|from|to)$/.test(className));
      });
      const candidates = settledShells.length === 1 ? settledShells : matchingShells;
      if (candidates.length !== 1) return null;
      const shell = candidates[0];
      const proseMirror = shell.querySelector('.ProseMirror');
      if (!proseMirror || !proseMirror.isConnected) return null;
      return { tab, shell, proseMirror };
    };
  `;
}

export async function runMathSaveProbe(client, context) {
  const fixturePath = JSON.stringify(context.fixturePath);
  const expected = JSON.stringify(context.scenarioEvidence.expectedSavedContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  const result = await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expected = ${expected};
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    ${createMathProbeSessionPrelude()}
    ${createMathCurrentEditorPrelude()}
    const describeEditorDom = () => {
      const activePanes = [...document.querySelectorAll('.lm-editor-pane.active')];
      const shells = [...document.querySelectorAll('.lm-editor-scroll')];
      const mathNodes = [...document.querySelectorAll('.math-node, [data-type="inline-math"]')];
      const rect = (element) => {
        const value = element?.getBoundingClientRect?.();
        return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
      };
      return {
        activePaneCount: activePanes.length,
        workspaceCount: document.querySelectorAll('main.lm-workspace').length,
        activePanes: activePanes.map((pane) => ({ className: pane.className, attached: pane.isConnected, rect: rect(pane) })),
        shells: shells.map((shell) => ({
          className: shell.className,
          attached: shell.isConnected,
          rect: rect(shell),
          paneClassName: shell.closest('.lm-editor-pane')?.className || null,
          proseMirrorCount: shell.querySelectorAll('.ProseMirror').length,
          proseMirrorOuterHTML: shell.querySelector('.ProseMirror')?.outerHTML?.slice(0, 3000) || null,
        })),
        proseMirror: [...document.querySelectorAll('.ProseMirror')].map((editor) => ({
          attached: editor.isConnected,
          paneClassName: editor.closest('.lm-editor-pane')?.className || null,
          shellClassName: editor.closest('.lm-editor-scroll')?.className || null,
          outerHTML: editor.outerHTML.slice(0, 3000),
        })),
        mathNodes: mathNodes.map((node) => ({
          className: node.className,
          dataType: node.getAttribute('data-type'),
          attached: node.isConnected,
          text: node.textContent?.slice(0, 200) || '',
          ancestorPaneClassName: node.closest('.lm-editor-pane')?.className || null,
          ancestorShellClassName: node.closest('.lm-editor-scroll')?.className || null,
          outerHTML: node.outerHTML.slice(0, 1200),
        })),
      };
    };
    const setProgress = (stage) => {
      try {
        const tabNow = store.getPaneTab('main');
        const editor = currentEditor();
        const currentSource = editor?.proseMirror.querySelector('.math-inline-source-editor') || null;
        const token = session?.mutationToken?.() || null;
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          activeTabId: store.appStore.activeTabId || null,
          paneTabId: tabNow?.id || null,
          path: tabNow?.path || null,
          editorMode: tabNow?.editorMode || null,
          documentMode: tabNow?.documentMode || null,
          sessionAvailable: Boolean(session),
          sessionTabId: session?.tabId || session?.id || null,
          revision: session?.revision ?? null,
          mutationToken: token,
          pending: session?.hasPendingEdits?.() === true,
          pendingVersion: session?.pendingEditVersion?.() ?? null,
          source: currentSource?.textContent || null,
          sourceAttached: Boolean(currentSource?.isConnected && editor?.proseMirror.contains(currentSource)),
          proseMirrorText: editor?.proseMirror.textContent?.slice(0, 500) || null,
          proseMirrorHtml: editor?.proseMirror.innerHTML?.slice(0, 1200) || null,
          currentContent: store.appStore.currentContent?.slice(0, 500) || null,
          editorDom: describeEditorDom(),
        };
      } catch (error) {
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          progressError: String(error),
        };
      }
    };
    setProgress('math-save:begin');
    await store.setActivePane('main');
    setProgress('math-save:after-set-active-pane');
    setProgress('math-save:before-open');
    await store.openFile(fixturePath, { recordNavigation: false, paneId: 'main' });
    setProgress('math-save:after-open');
    await store.switchMode('wysiwyg');
    setProgress('math-save:after-switch-wysiwyg');
    const tab = store.getPaneTab('main');
    if (!tab || tab.path !== fixturePath) throw new Error('math fixture did not open in the active WYSIWYG pane');
    setProgress('math-save:before-wait-session');
    session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', mathProbeWaitTimeoutMs);
    setProgress('math-save:after-wait-session');
    const waitFor = async (label, predicate, timeoutMs = mathProbeWaitTimeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, mathProbePollIntervalMs));
      }
      throw new Error('timed out waiting for ' + label);
    };
    setProgress('math-save:before-wait-math-node');
    const mathNodeInCurrentEditor = () => {
      const editor = currentEditor();
      if (!editor) return null;
      return editor.proseMirror.querySelector('.math-node-inline');
    };
    const mathNode = await waitFor('current-pane inline math NodeView', mathNodeInCurrentEditor);
    setProgress('math-save:after-wait-math-node');
    let source = mathNode.querySelector('.math-inline-source-editor');
    if (!source) {
      mathNode.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1 }));
      source = await waitFor('current-pane inline math source editor', () =>
        currentEditor()?.proseMirror.querySelector('.math-inline-source-editor') || null);
    }
    setProgress('math-save:before-input');
    source.focus();
    const beforeInput = session.mutationToken?.();
    const pendingVersionBeforeInput = session.pendingEditVersion?.() ?? null;
    const sourceBefore = source.textContent || '';
    if (sourceBefore !== ${JSON.stringify(context.scenarioEvidence.initialFormula)}) {
      throw new Error('current-pane Math source did not start with the fixture formula: ' + JSON.stringify(sourceBefore));
    }
    if (document.activeElement !== source) throw new Error('Math source did not retain focus before ordinary save');
    const capturedReceipts = [];
    const originalFlush = session.flushPendingEdits?.bind(session);
    if (!originalFlush) throw new Error('WYSIWYG session has no production flushPendingEdits adapter');
    session.flushPendingEdits = async (...args) => {
      const receipt = await originalFlush(...args);
      if (receipt) capturedReceipts.push({ kind: 'ordinary-flush', receipt });
      return receipt;
    };
    source.textContent = ${JSON.stringify(context.scenarioEvidence.savedFormula)};
    source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '+1' }));
    const pendingBeforeSave = session.hasPendingEdits?.() === true;
    const inputSource = source.textContent || '';
    if (!pendingBeforeSave || inputSource !== ${JSON.stringify(context.scenarioEvidence.savedFormula)}) {
      throw new Error('real formula input did not remain pending before ordinary save');
    }
    if (document.activeElement !== source) throw new Error('Math source lost focus before ordinary saveCurrentFile');
    const beforeSave = session.mutationToken?.();
    const pendingVersionBeforeSave = session.pendingEditVersion?.() ?? null;
    setProgress('math-save:before-save');
    const saved = await store.saveCurrentFile();
    if (!saved) throw new Error('saveCurrentFile returned false for real WYSIWYG Math input');
    const after = session.mutationToken?.();
    const pendingAfterSave = session.hasPendingEdits?.() === true;
    const pendingVersionAfter = session.pendingEditVersion?.() ?? null;
    setProgress('math-save:after-save');
    const disk = await globalThis.__TAURI_INTERNALS__.invoke('read_text_file', { path: fixturePath });
    if (disk !== expected) throw new Error('real WYSIWYG Math save produced unexpected Markdown: ' + JSON.stringify({ disk, expected }));
    if (store.appStore.isDirty || store.getDirtyTabs().length > 0 || pendingAfterSave) {
      throw new Error('real WYSIWYG Math save remained dirty or pending');
    }
    const capturedReceipt = capturedReceipts.find(({ kind }) => kind === 'ordinary-flush')?.receipt || null;
    if (!beforeSave || !after || !capturedReceipt) throw new Error('production Math save did not expose an ordinary flush receipt');
    if (capturedReceipt.sessionIdentity !== session) throw new Error('Math receipt session identity changed');
    if (capturedReceipt.before.pendingInputVersion !== beforeSave.pendingInputVersion
      || capturedReceipt.after.pendingInputVersion !== beforeSave.pendingInputVersion) {
      throw new Error('authorized Math save changed the continuous input token');
    }
    if (capturedReceipt.after.documentGeneration <= capturedReceipt.before.documentGeneration) {
      throw new Error('authorized Math save did not record a PM document mutation');
    }
    const currentEditorAfterSave = currentEditor();
    if (!currentEditorAfterSave) throw new Error('the active pane editor was not present after real Math save');
    const sourceAfterSave = currentEditorAfterSave.proseMirror.querySelector('.math-inline-source-editor')?.textContent || '';
    if (sourceAfterSave && sourceAfterSave !== ${JSON.stringify(context.scenarioEvidence.savedFormula)}) {
      throw new Error('the current pane Math source changed unexpectedly after save: ' + JSON.stringify(sourceAfterSave));
    }
    const headingCountAfterSave = currentEditorAfterSave.proseMirror.querySelectorAll('h1').length;
    store.appStore.settings.general.launchBehavior = 'restoreLastSession';
    store.appStore.settings.general.restoreLastFile = true;
    await store.persistConfig();
    const result = {
      path: tab.path,
      sourceBefore,
      sourceAfterInput: inputSource,
      sourceAfterSave,
      content: store.appStore.currentContent,
      disk,
      dirty: store.appStore.isDirty,
      pendingBeforeSave,
      pendingAfterSave,
      pendingVersionBeforeInput,
      pendingVersionBeforeSave,
      pendingVersionAfter,
      pendingLifecycleAdvanced: pendingVersionBeforeInput != null && pendingVersionAfter != null && pendingVersionAfter > pendingVersionBeforeInput,
      beforeInputToken: beforeInput,
      beforeSaveToken: beforeSave,
      afterToken: after,
      receipt: {
        flushId: capturedReceipt.flushId,
        before: capturedReceipt.before,
        after: capturedReceipt.after,
        authorizedMutationCount: capturedReceipt.authorizedMutationCount,
      },
      receiptSources: capturedReceipts.map(({ kind, receipt }) => ({
        kind,
        flushId: receipt.flushId,
        before: receipt.before,
        after: receipt.after,
        authorizedMutationCount: receipt.authorizedMutationCount,
      })),
      receiptSource: 'ordinary-flush',
      headingVisibleAfterSave: headingCountAfterSave > 0,
      presentationPathVerified: false,
      presentationPathNote: 'The native probe records the resulting heading DOM, but does not claim that DOM presence alone proves the tagged presentation transaction path.',
      runtimePaths,
    };
    if (!result.headingVisibleAfterSave) throw new Error('the current pane heading was not visible during the real WYSIWYG save');
    const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw new Error('Tauri internal invoke bridge is unavailable');
    setProgress('math-save:before-close');
    await invoke('plugin:window|close', { label: 'main' });
    return result;
  })()`, MATH_PROBE_EVALUATE_TIMEOUT_MS);
  return { ...result, expectedBytes: Buffer.byteLength(context.scenarioEvidence.expectedSavedContent, "utf8") };
}

export async function runMathWindowDraftProbe(client, context) {
  const expectedDraft = JSON.stringify(context.scenarioEvidence.expectedDraftContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  return await client.evaluate(`(async () => {
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    ${createMathProbeSessionPrelude()}
    const draft = await import('/src/stores/draftStore.ts');
    ${createMathCurrentEditorPrelude()}
    const setProgress = (stage) => {
      try {
        const tabNow = store.getPaneTab('main');
        const editor = currentEditor();
        const currentSource = editor?.proseMirror.querySelector('.math-inline-source-editor') || null;
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          activeTabId: store.appStore.activeTabId || null,
          paneTabId: tabNow?.id || null,
          path: tabNow?.path || null,
          sessionAvailable: Boolean(session),
          revision: session?.revision ?? null,
          mutationToken: session?.mutationToken?.() || null,
          pending: session?.hasPendingEdits?.() === true,
          pendingVersion: session?.pendingEditVersion?.() ?? null,
          source: currentSource?.textContent || null,
          sourceAttached: Boolean(currentSource?.isConnected && editor?.proseMirror.contains(currentSource)),
          proseMirrorText: editor?.proseMirror.textContent?.slice(0, 500) || null,
          proseMirrorHtml: editor?.proseMirror.innerHTML?.slice(0, 1200) || null,
          currentContent: store.appStore.currentContent?.slice(0, 500) || null,
        };
      } catch (error) {
        globalThis.__LIGHTMARK_QA_PROGRESS = { stage, at: new Date().toISOString(), progressError: String(error) };
      }
    };
    setProgress('math-window-draft:begin');
    await store.setActivePane('main');
    setProgress('math-window-draft:after-set-active-pane');
    const tab = store.createUntitledTab(${JSON.stringify("Draft $d$")}, true, 'main');
    setProgress('math-window-draft:after-create-tab');
    await store.activateTab(tab.id);
    await store.switchMode('wysiwyg');
    setProgress('math-window-draft:before-wait-session');
    session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', mathProbeWaitTimeoutMs);
    setProgress('math-window-draft:after-wait-session');
    const waitFor = async (label, predicate, timeoutMs = mathProbeWaitTimeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, mathProbePollIntervalMs));
      }
      throw new Error('timed out waiting for ' + label);
    };
    setProgress('math-window-draft:before-wait-math-node');
    const mathNodeInCurrentEditor = () => currentEditor()?.proseMirror.querySelector('.math-node-inline') || null;
    const mathNode = await waitFor('draft current-pane inline math NodeView', mathNodeInCurrentEditor);
    let source = mathNode.querySelector('.math-inline-source-editor');
    if (!source) {
      mathNode.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1 }));
      source = await waitFor('draft current-pane inline math source editor', () =>
        currentEditor()?.proseMirror.querySelector('.math-inline-source-editor') || null);
    }
    const initialSource = source.textContent || '';
    if (initialSource !== ${JSON.stringify(context.scenarioEvidence.draftInitialFormula)}) {
      throw new Error('draft current-pane Math source did not start with the expected fixture formula: ' + JSON.stringify(initialSource));
    }
    source.focus();
    if (document.activeElement !== source) throw new Error('draft Math source did not retain focus before input');
    const events = [];
    const snapshot = (label) => {
      const editor = currentEditor();
      const currentSource = editor?.proseMirror.querySelector('.math-inline-source-editor') || null;
      const record = {
        label,
        at: new Date().toISOString(),
        source: currentSource?.textContent || '',
        sourceAttached: Boolean(currentSource?.isConnected && editor?.proseMirror.contains(currentSource)),
        activeElementIsSource: document.activeElement === currentSource,
        token: session.mutationToken?.() || null,
        pending: session.hasPendingEdits?.() === true,
        pendingVersion: session.pendingEditVersion?.() ?? null,
        tabContent: tab.content,
      };
      events.push(record);
      return record;
    };
    source.textContent = ${JSON.stringify(context.scenarioEvidence.draftFormula)};
    source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '+1' }));
    const beforeClose = snapshot('before-close-request');
    setProgress('math-window-draft:before-close');
    const pendingBefore = beforeClose.pending;
    const pendingVersionBefore = beforeClose.pendingVersion;
    if (!pendingBefore || beforeClose.source !== ${JSON.stringify(context.scenarioEvidence.draftFormula)}) {
      throw new Error('real draft Math input did not remain pending before close: ' + JSON.stringify(beforeClose));
    }
    const capturedReceipts = [];
    const originalFlush = session.flushPendingEdits?.bind(session);
    if (!originalFlush) throw new Error('draft WYSIWYG session has no production flush adapter');
    session.flushPendingEdits = async (...args) => {
      const receipt = await originalFlush(...args);
      if (receipt) {
        capturedReceipts.push({ kind: 'ordinary-flush', receipt });
      }
      return receipt;
    };
    const originalFinalize = session.finalizeClosePrompt?.bind(session);
    if (!originalFinalize) throw new Error('draft WYSIWYG session has no production finalizeClosePrompt adapter');
    session.finalizeClosePrompt = async (...args) => {
      const receipt = await originalFinalize(...args);
      if (receipt) capturedReceipts.push({ kind: 'close-finalize', receipt });
      return receipt;
    };
    const closePromise = globalThis.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' });
    const dialog = await waitFor('window close dialog', () => [...document.querySelectorAll('section[role="dialog"]')]
      .find((candidate) => [...candidate.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('不保存退出'))));
    setProgress('math-window-draft:dialog-visible');
    const afterDialog = snapshot('close-dialog-visible');
    const sourceAtDialog = afterDialog.source;
    const pendingAtDialog = afterDialog.pending;
    const buttons = [...dialog.querySelectorAll('button')].map((button) => ({ button, label: button.textContent?.trim() || '' }));
    const discard = buttons.find(({ label }) => label.includes('不保存退出'))?.button;
    if (!discard) throw new Error('window close dialog did not expose the 不保存退出 action: ' + JSON.stringify(buttons.map(({ label }) => label)));
    discard.click();
    snapshot('discard-selected');
    setProgress('math-window-draft:discard-selected');
    await closePromise;
    setProgress('math-window-draft:close-resolved');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterClose = {
      label: 'close-promise-resolved',
      at: new Date().toISOString(),
      receipts: capturedReceipts.length,
    };
    events.push(afterClose);
    const ordinaryFlushReceipts = capturedReceipts.filter(({ kind }) => kind === 'ordinary-flush');
    const closeFinalizeReceipts = capturedReceipts.filter(({ kind }) => kind === 'close-finalize');
    const tokensEqual = (left, right) => Boolean(left && right
      && left.documentGeneration === right.documentGeneration
      && left.pendingInputVersion === right.pendingInputVersion
      && left.revision === right.revision);
    const pendingFlushProof = Boolean(closeFinalizeReceipts.some(({ receipt }) =>
      receipt.sessionIdentity === session
      && tokensEqual(receipt.before, beforeClose.token)
      && tokensEqual(receipt.after, afterDialog.token)
      && Number(receipt.authorizedMutationCount || 0) > 0));
    return {
      tabId: tab.id,
      sourceBeforeDialog: beforeClose.source,
      sourceAtDialog,
      promptContent: tab.content,
      expectedDraft: ${expectedDraft},
      pendingBefore,
      pendingAtDialog,
      pendingVersionBefore,
      pendingVersionAtDialog: afterDialog.pendingVersion,
      beforeToken: beforeClose.token,
      afterDialogToken: afterDialog.token,
      receipts: capturedReceipts.map(({ kind, receipt }) => ({
        kind,
        flushId: receipt.flushId,
        before: receipt.before,
        after: receipt.after,
        authorizedMutationCount: receipt.authorizedMutationCount,
      })),
      ordinaryFlushReceiptCount: ordinaryFlushReceipts.length,
      closeFinalizeReceiptCount: closeFinalizeReceipts.length,
      receiptSources: capturedReceipts.map(({ kind }) => kind),
      closeFinalizeReceiptObserved: closeFinalizeReceipts.length > 0,
      closeFinalizeProof: pendingFlushProof,
      pendingFlushProof,
      events,
      note: pendingFlushProof
        ? 'the close path produced a receipt whose continuous input token matches the prompt version'
        : 'dialog focus/blur or another close step changed the Math buffer; this run records the events but does not count them as pending-flush proof',
      runtimePaths,
    };
  })()`, MATH_PROBE_EVALUATE_TIMEOUT_MS);
}

export async function runMathRecoveryProbe(client, context) {
  const expectedDraft = JSON.stringify(context.scenarioEvidence.expectedDraftContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  return await client.evaluate(`(async () => {
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    ${createMathProbeSessionPrelude()}
    const draft = await import('/src/stores/draftStore.ts');
    ${createMathCurrentEditorPrelude()}
    const setProgress = (stage, session = null) => {
      try {
        const tabNow = store.getPaneTab('main');
        const editor = currentEditor();
        const proseMirror = editor?.proseMirror || null;
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          activeTabId: store.appStore.activeTabId || null,
          paneTabId: tabNow?.id || null,
          path: tabNow?.path || null,
          sessionAvailable: Boolean(session),
          revision: session?.revision ?? null,
          mutationToken: session?.mutationToken?.() || null,
          pending: session?.hasPendingEdits?.() === true,
          pendingVersion: session?.pendingEditVersion?.() ?? null,
          proseMirrorAttached: Boolean(proseMirror?.isConnected),
          proseMirrorTabId: editor?.tab?.id || null,
        };
      } catch (error) {
        globalThis.__LIGHTMARK_QA_PROGRESS = { stage, at: new Date().toISOString(), progressError: String(error) };
      }
    };
    setProgress('math-recover:begin');
    const waitFor = async (label, predicate, timeoutMs = mathProbeWaitTimeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, mathProbePollIntervalMs));
      }
      throw new Error('timed out waiting for ' + label);
    };
    const dialog = await waitFor('startup recovery dialog', () => [...document.querySelectorAll('section[role="dialog"]')]
      .find((candidate) => [...candidate.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('恢复草稿'))));
    setProgress('math-recover:dialog-visible');
    const dialogLabel = dialog.getAttribute('aria-label') || '';
    if (!dialogLabel.includes('可恢复草稿')) throw new Error('unexpected startup dialog: ' + dialogLabel);
    const buttons = [...dialog.querySelectorAll('button')].map((button) => ({ button, label: button.textContent?.trim() || '' }));
    const restore = buttons.find(({ label }) => label.includes('恢复草稿'))?.button;
    if (!restore) throw new Error('startup recovery dialog did not expose 恢复草稿: ' + JSON.stringify(buttons.map(({ label }) => label)));
    restore.click();
    setProgress('math-recover:restore-selected');
    await waitFor('restored draft state', () => draft.draftStore.status === 'restored');
    setProgress('math-recover:restored-state');
    const tab = await waitFor('restored untitled tab', () => store.appStore.tabs.find((candidate) => candidate.kind === 'untitled' && candidate.content === ${expectedDraft}));
    if (!tab) throw new Error('restored untitled tab content did not match the pending Math draft');
    if (store.getPaneTab('main')?.id !== tab.id || store.appStore.splitLayout.activePaneId !== 'main') {
      throw new Error('restored draft was not bound to the active main pane tab');
    }
    session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', mathProbeWaitTimeoutMs);
    setProgress('math-recover:after-wait-session', session);
    const currentEditorAfterRestore = currentEditor();
    const currentProseMirror = currentEditorAfterRestore?.proseMirror || null;
    if (!currentProseMirror) throw new Error('restored draft current-pane ProseMirror DOM was not attached');
    if (currentEditorAfterRestore.tab.id !== tab.id) {
      throw new Error('restored draft ProseMirror DOM was not bound to the restored main-pane tab');
    }
    if (!tab.isDirty) throw new Error('restored recovery draft was unexpectedly clean');
    if (store.appStore.currentContent !== ${expectedDraft}) throw new Error('restored current content did not match the pending Math draft');
    const closePromise = globalThis.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' });
    setProgress('math-recover:before-close');
    const closeDialog = await waitFor('recovery close dialog', () => [...document.querySelectorAll('section[role="dialog"]')]
      .find((candidate) => [...candidate.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('不保存退出'))));
    setProgress('math-recover:close-dialog-visible', session);
    const buttonsAfterRestore = [...closeDialog.querySelectorAll('button')];
    const discard = buttonsAfterRestore.find((button) => (button.textContent || '').includes('不保存退出'));
    if (!discard) throw new Error('recovery close dialog did not expose 不保存退出');
    discard.click();
    setProgress('math-recover:discard-selected', session);
    await closePromise;
    setProgress('math-recover:close-resolved', session);
    return {
      tabId: tab.id,
      content: tab.content,
      currentContent: store.appStore.currentContent,
      dirty: tab.isDirty,
      mode: tab.editorMode,
      sessionMode: session.mode,
      draftStatus: draft.draftStore.status,
      runtimePaths,
    };
  })()`, MATH_PROBE_EVALUATE_TIMEOUT_MS);
}

/**
 * Run the recovery adapter only through a verified isolated native phase.
 * Keeping this guard next to the exported probe prevents a caller from
 * reusing the probe with an arbitrary browser page or a bare CDP port.
 */
export async function runRecoveryBundleProbe(client, context) {
  assertRecoveryProbeContext(client, context);
  const fixtureContent = JSON.stringify(context.fixtureContent);
  const fixturePath = JSON.stringify(context.fixturePath);
  const runtimePathCheck = createRuntimePathCheck(context);
  const sentinel = JSON.stringify(
    '<img src="x" onerror="globalThis.__lightmarkFootnoteImg = true"><svg onload="globalThis.__lightmarkFootnoteSvg = true"><script>globalThis.__lightmarkFootnoteScript = true</script></svg><b>footnote data</b>',
  );
  return await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expectedFixture = ${fixtureContent};
    const sentinel = ${sentinel};
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
    const { DOMParser: PMDOMParser } = await import('/node_modules/@tiptap/pm/model/index.ts');
    const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (label, predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await wait();
      }
      try {
        setProgress('recovery:timeout:' + label);
      } catch {}
      throw new Error('timed out waiting for ' + label);
    };
    // Tiptap's EditorContent moves the ProseMirror DOM into its own wrapper.
    // The Vue component carrying the editor prop is therefore attached to
    // the wrapper/shell, rather than to the moved ProseMirror element.
    // Locate the active shell with the same pane identity checks as the
    // verified math probes, then inspect only Vue's component instance on
    // those concrete Tiptap/WYSIWYG DOM anchors.
    const currentEditorDom = () => {
      const tab = store.getPaneTab('main');
      if (!tab) return null;
      const panes = [...document.querySelectorAll('.lm-editor-pane')];
      let roots;
      if (store.appStore.splitLayout.enabled) {
        if (store.appStore.splitLayout.activePaneId !== 'main') return null;
        const activePanes = panes.filter((pane) => pane.classList?.contains?.('active'));
        if (activePanes.length !== 1) return null;
        roots = activePanes;
      } else {
        const workspaces = [...document.querySelectorAll('main.lm-workspace')];
        if (workspaces.length !== 1) return null;
        roots = workspaces;
      }
      const shells = roots.flatMap((root) => [...root.querySelectorAll('.lm-editor-scroll')]);
      const matchingShells = shells.filter((candidate) =>
        candidate.isConnected && candidate.querySelectorAll('.ProseMirror').length === 1,
      );
      if (matchingShells.length !== 1) return null;
      const shell = matchingShells[0];
      const proseMirror = shell.querySelector('.ProseMirror');
      if (!proseMirror || !proseMirror.isConnected) return null;
      return { tab, shell, proseMirror };
    };
    const editorDomIsSettled = (dom) => {
      const pageClasses = [...(dom?.shell.closest('.editor-page')?.classList || [])];
      return Boolean(dom) && !pageClasses.some((className) => /-(enter|leave)-(active|from|to)$/.test(className));
    };
    const editorFromComponent = (component) => {
      const visited = new Set();
      while (component && !visited.has(component)) {
        visited.add(component);
        for (const holder of [component.props, component.vnode?.props, component.setupState, component.ctx, component.proxy]) {
          const candidate = holder?.editor;
          if (candidate?.view?.state?.doc) return candidate;
          if (candidate?.value?.view?.state?.doc) return candidate.value;
        }
        component = component.parent || null;
      }
      return null;
    };
    const componentForAnchor = (anchor) => {
      if (!anchor) return null;
      // Vue's dev runtime records the owning component on rendered DOM. The
      // second path is the vnode component used by the renderer itself; both
      // are read from the exact EditorContent/shell anchors above.
      return anchor.__vueParentComponent || anchor.__vnode?.component || null;
    };
    const editorCandidateSummary = () => {
      const dom = currentEditorDom();
      if (!dom) return { dom: null, anchors: [] };
      const anchors = [
        ['wysiwyg-shell', dom.shell],
        ['editor-content-wrapper', dom.proseMirror.parentElement],
        ['prosemirror-dom', dom.proseMirror],
      ];
      return {
        dom: {
          shellClassName: dom.shell.className,
          proseMirrorParentTag: dom.proseMirror.parentElement?.tagName || null,
          proseMirrorText: dom.proseMirror.textContent?.slice(0, 240) || '',
        },
        anchors: anchors.map(([name, anchor]) => {
          const component = componentForAnchor(anchor);
          const editor = editorFromComponent(component);
          return {
            name,
            tag: anchor?.tagName || null,
            hasVueParentComponent: Boolean(anchor?.__vueParentComponent),
            hasVNodeComponent: Boolean(anchor?.__vnode?.component),
            componentName: component?.type?.name || component?.type?.__name || null,
            componentHasEditorProp: Boolean(component?.props?.editor || component?.vnode?.props?.editor),
            editorFound: Boolean(editor),
          };
        }),
      };
    };
    const currentEditor = () => {
      const dom = currentEditorDom();
      if (!dom) return null;
      const anchors = [dom.shell, dom.proseMirror.parentElement, dom.proseMirror];
      for (const anchor of anchors) {
        const editor = editorFromComponent(componentForAnchor(anchor));
        if (editor && editor.options?.element === dom.proseMirror.parentElement) return editor;
      }
      return null;
    };
    let session = null;
    const setProgress = (stage) => {
      try {
        const dom = currentEditorDom();
        const tabNow = store.getPaneTab('main');
        const liveSession = tabNow ? runtime.documentSessionForTab(tabNow.id) : null;
        const current = currentEditor();
        const page = dom?.shell.closest('.editor-page');
        const sessionMatchesEditor = Boolean(liveSession?.editorIdentity && liveSession.editorIdentity === current);
        const candidateSummary = editorCandidateSummary();
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          activeTabId: store.appStore.activeTabId || null,
          paneTabId: tabNow?.id || null,
          path: tabNow?.path || null,
          editorMode: tabNow?.editorMode || null,
          documentMode: tabNow?.documentMode || null,
          sessionAvailable: Boolean(liveSession),
          sessionTabId: liveSession?.tabId || liveSession?.id || null,
          revision: liveSession?.revision ?? null,
          mutationToken: sessionMatchesEditor ? liveSession?.mutationToken?.() || null : null,
          pending: sessionMatchesEditor && liveSession?.hasPendingEdits?.() === true,
          sessionEditorIdentityMatches: sessionMatchesEditor,
          editorFound: Boolean(current),
          domFound: Boolean(dom),
          pageClassName: page?.className || null,
          candidateSummary,
        };
      } catch (error) {
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          progressError: String(error),
        };
      }
    };
    const currentProseMirror = () => currentEditor()?.view?.dom || currentEditorDom()?.proseMirror || document.querySelector('.ProseMirror');
    const equal = (actual, expected, label) => {
      if (actual !== expected) throw new Error(label + ': ' + JSON.stringify({ actual, expected }));
    };
    const equalJson = (actual, expected, label) => equal(JSON.stringify(actual), JSON.stringify(expected), label);
    const expectReject = async (operation, pattern, label) => {
      try {
        await operation();
      } catch (error) {
        if (!pattern.test(String(error))) throw new Error(label + ': unexpected error ' + String(error));
        return;
      }
      throw new Error(label + ': expected the operation to reject');
    };
    const switchTo = async (mode) => {
      await store.switchMode(mode);
      return await waitFor(mode + ' document session', () => {
        const tab = store.getPaneTab('main');
        const session = tab ? runtime.documentSessionForTab(tab.id) : null;
        return session?.mode === mode ? session : null;
      });
    };
    const recordPendingMathDebug = async (stage, candidate) => {
      try {
        const { capturePendingMathRecovery } = await import('/src/extensions/MathNodes.ts');
        const pendingMathDebug = capturePendingMathRecovery(candidate);
        const docMathPositions = [];
        candidate.state.doc.descendants((node, position) => {
          if (node.type.name === 'inlineMath' || node.type.name === 'blockMath') {
            docMathPositions.push({ type: node.type.name, position, attrs: { ...node.attrs } });
          }
        });
        setProgress(stage);
        globalThis.__LIGHTMARK_QA_PROGRESS.pendingMathDebug = {
          version: pendingMathDebug.version,
          entries: pendingMathDebug.entries.map((entry) => ({
            id: entry.id,
            state: entry.state,
            kind: entry.binding.kind,
            status: entry.binding.status,
            position: entry.binding.position,
            reason: entry.binding.reason || null,
          })),
          docMathPositions,
        };
      } catch (error) {
        setProgress(stage + '-failed');
        globalThis.__LIGHTMARK_QA_PROGRESS.pendingMathDebugError = String(error);
      }
    };
    const activateUntitled = async (content = '', dirty = false) => {
      const tab = store.createUntitledTab(content, dirty, 'main');
      await store.activateTab(tab.id);
      await switchTo('wysiwyg');
      setProgress('recovery:untitled-after-switch');
      const ready = await waitFor('untitled editor/session instance', () => {
        const activeTab = store.getPaneTab('main');
        const candidate = currentEditor();
        const liveSession = activeTab ? runtime.documentSessionForTab(activeTab.id) : null;
        const dom = currentEditorDom();
        const sessionEditor = liveSession?.editorIdentity;
        return activeTab?.id === tab.id
          && candidate
          && dom
          && editorDomIsSettled(dom)
          && candidate.options?.element === dom.proseMirror.parentElement
          && sessionEditor === candidate
          ? { editor: candidate, session: liveSession }
          : null;
      });
      const readyEditor = await waitFor('untitled editor document', () => {
        const activeTab = store.getPaneTab('main');
        const candidate = currentEditor();
        if (activeTab?.id !== tab.id || activeTab.content !== content || !candidate) return null;
        const doc = candidate.state?.doc;
        if (!doc) return null;
        if (content.length === 0) {
          return doc.childCount === 1
            && doc.firstChild?.type?.name === 'paragraph'
            && doc.firstChild.content.size === 0
            ? candidate
            : null;
        }
        return doc.textContent?.includes(content.trim()) ? candidate : null;
      });
      setProgress('recovery:untitled-editor-ready');
      await waitFor('untitled editor transition', () => editorDomIsSettled(currentEditorDom()) ? true : null);
      await waitFor('untitled ProseMirror DOM', () => currentProseMirror()?.isConnected ? currentProseMirror() : null);
      setProgress('recovery:untitled-dom-ready');
      return { tab, session: ready.session, editor: readyEditor };
    };

    setProgress('recovery:begin');
    if (store.appStore.splitLayout.enabled) await store.toggleSplitLayout();
    await store.setActivePane('main');
    setProgress('recovery:after-set-active-pane');
    await store.openFile(fixturePath, { recordNavigation: false, paneId: 'main' });
    setProgress('recovery:after-open');
    const opened = store.getPaneTab('main');
    if (!opened || opened.path !== fixturePath) throw new Error('recovery fixture did not open in the active pane');
    session = await switchTo('wysiwyg');
    setProgress('recovery:after-switch-wysiwyg');
    setProgress('recovery:before-initial-editor');
    let editor = await waitFor('initial editor instance', currentEditor);
    setProgress('recovery:initial-editor-ready');
    equal(store.getPaneTab('main')?.content, expectedFixture, 'recovery fixture source bytes are loaded');

    const parserHost = document.createElement('div');
    parserHost.innerHTML = '<section data-type="footnotes" data-markdown="">' + sentinel + '</section>';
    const parsedDoc = PMDOMParser.fromSchema(editor.schema).parse(parserHost);
    const parsedFootnotes = parsedDoc.firstChild;
    if (!parsedFootnotes || parsedFootnotes.type.name !== 'footnotes') throw new Error('PM DOMParser did not create a FootnotesNode');
    if (!String(parsedFootnotes.attrs.html || '').includes('lightmarkFootnote')) {
      throw new Error('FootnotesNode.parseHTML did not retain innerHTML as data');
    }

    const fixtureDoc = {
      type: 'doc',
      content: [
        { type: 'frontMatter', attrs: { yaml: 'title: accepted', editing: false } },
        { type: 'htmlBlock', attrs: { html: '<b>accepted html</b>', editing: false } },
        { type: 'footnotes', attrs: { markdown: '', html: parsedFootnotes.attrs.html, editing: false } },
        { type: 'tableOfContents', attrs: { editing: false } },
        { type: 'mermaidDiagram', attrs: { code: 'graph TD;A-->B', editing: false } },
        { type: 'paragraph', content: [
          { type: 'text', text: 'body ' },
          { type: 'inlineMath', attrs: { tex: 'x', delimiter: 'inline-dollar', raw: '$x$', originalTex: 'x', displayMode: false, editing: false } },
        ] },
        { type: 'blockMath', attrs: { tex: 'y', delimiter: 'display-dollar', raw: '$$y$$', originalTex: 'y', displayMode: true, editing: false } },
      ],
    };
    editor.commands.setContent(fixtureDoc, { emitUpdate: false });
    const proseMirror = await waitFor('all recovery NodeViews', () => {
      const root = currentProseMirror();
      if (!root) return null;
      const selectors = ['.front-matter-node', '.html-block-node', '.footnotes', '.toc-node', '.mermaid-node', '.math-node'];
      return selectors.every((selector) => root.querySelector(selector)) ? root : null;
    });
    const footnotesDom = proseMirror.querySelector('.footnotes');
    const renderedFootnotes = footnotesDom?.innerHTML || '';
    const activeExecutableNodes = footnotesDom
      ? footnotesDom.querySelectorAll('script,svg,[onerror],[onload],[onclick]').length
      : 0;
    if (!footnotesDom || activeExecutableNodes > 0) {
      throw new Error('Footnotes recovery display exposed executable DOM: ' + renderedFootnotes.slice(0, 500));
    }
    if (globalThis.__lightmarkFootnoteImg || globalThis.__lightmarkFootnoteSvg || globalThis.__lightmarkFootnoteScript) {
      throw new Error('Footnotes sentinel executed while rendering recovery data');
    }
    if (!renderedFootnotes.includes('raw-html-token') || !renderedFootnotes.includes('footnote data')) {
      throw new Error('Footnotes raw HTML was not retained as escaped display data');
    }

    footnotesDom.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const footnoteEditor = await waitFor('editable Footnotes NodeView', () => footnotesDom.querySelector('.footnotes-editor'));
    footnoteEditor.value = '[^a]: recovered draft';
    footnoteEditor.dispatchEvent(new Event('input', { bubbles: true }));
    await recordPendingMathDebug('recovery:before-capture', editor);
    const docBeforeCapture = editor.state.doc;
    const tokenBeforeCapture = session.mutationToken();
    const captured = await session.captureRecoveryBundle();
    const tokenAfterCapture = session.mutationToken();
    equalJson(tokenAfterCapture, tokenBeforeCapture, 'production recovery capture does not mutate the editor token');
    equal(editor.state.doc, docBeforeCapture, 'production recovery capture does not replace the PM document');
    const capturedJson = JSON.parse(captured);
    const capturedKinds = capturedJson.localState.buffers.map((buffer) => buffer.kind).sort();
    equalJson(capturedKinds, ['footnote', 'frontmatter', 'htmlBlock', 'math', 'math', 'mermaid', 'toc'].sort(), 'production capture registered every recovery NodeView');
    const capturedFootnote = capturedJson.localState.buffers.find((buffer) => buffer.kind === 'footnote');
    equal(capturedFootnote.status, 'editing', 'production capture records the Footnotes editing state');
    equal(capturedFootnote.payload.draft.markdown, '[^a]: recovered draft', 'production capture records the Footnotes draft');

    const restored = await activateUntitled('');
    setProgress('recovery:before-restore');
    globalThis.__LIGHTMARK_QA_PROGRESS.restoreTarget = {
      tabId: restored.tab.id,
      tabKind: restored.tab.kind,
      path: restored.tab.path,
      content: restored.tab.content,
      contentLength: restored.tab.content.length,
      dirty: restored.tab.isDirty,
      docChildCount: restored.editor.state.doc.childCount,
      docFirstType: restored.editor.state.doc.firstChild?.type?.name || null,
      docFirstContentSize: restored.editor.state.doc.firstChild?.content?.size ?? null,
      docText: restored.editor.state.doc.textContent?.slice(0, 240) || '',
      pageSettled: editorDomIsSettled(currentEditorDom()),
    };
    await restored.session.restoreRecoveryBundle(captured);
    const restoredPm = await waitFor('restored recovery ProseMirror DOM', currentProseMirror);
    const restoredFootnotes = await waitFor('restored Footnotes editor', () => restoredPm.querySelector('.footnotes-editor'));
    equal(restoredFootnotes.value, '[^a]: recovered draft', 'restore reattached the live Footnotes draft');
    await recordPendingMathDebug('recovery:before-recapture', restored.editor);
    const recaptured = await restored.session.captureRecoveryBundle();
    const recapturedJson = JSON.parse(recaptured);
    equalJson(
      recapturedJson.localState.buffers.map((buffer) => buffer.kind).sort(),
      capturedJson.localState.buffers.map((buffer) => buffer.kind).sort(),
      'capture after restore still includes all mounted local buffers',
    );
    const recapturedFootnote = recapturedJson.localState.buffers.find((buffer) => buffer.kind === 'footnote');
    equal(recapturedFootnote.payload.draft.markdown, '[^a]: recovered draft', 'restore→capture preserves local draft data');

    const nonEmpty = await activateUntitled('already present');
    await expectReject(
      () => nonEmpty.session.restoreRecoveryBundle(captured),
      /内容为空.*未命名会话|已有内容|编辑历史/,
      'restore refuses a non-empty untitled session',
    );
    const dirtyEmpty = await activateUntitled('');
    dirtyEmpty.tab.isDirty = true;
    await expectReject(
      () => dirtyEmpty.session.restoreRecoveryBundle(captured),
      /未发生编辑|编辑历史/,
      'restore refuses an emptied untitled session with prior edits',
    );

    const mismatch = await activateUntitled('');
    // This is a dedicated source/model mismatch fixture.  replaceMarkdown()
    // changes only the PM view; load the source projection explicitly so the
    // failure proves the recovery mapping fence rather than a probe setup
    // mistake.
    store.setPaneContent('main', 'abc', false, false);
    await mismatch.session.replaceMarkdown('abc');
    editor = await waitFor('mismatch editor instance', currentEditor);
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abcd' }] }] }, { emitUpdate: false });
    if (store.getPaneTab('main')?.content !== 'abc') throw new Error('mismatch fixture source projection changed unexpectedly');
    const mismatchBundle = await mismatch.session.captureRecoveryBundle();
    const mismatchTarget = await activateUntitled('');
    await mismatchTarget.session.restoreRecoveryBundle(mismatchBundle);
    await expectReject(
      () => mismatchTarget.session.snapshot('save'),
      /Recovery source mapping is unresolved|mapping.*unresolved/i,
      'snapshot refuses abc source overwrite when recovered PM model is abcd',
    );

    const overflow = await activateUntitled('');
    editor = await waitFor('overflow editor instance', currentEditor);
    const frontMatterNodes = Array.from({ length: 513 }, (_, index) => ({
      type: 'frontMatter',
      attrs: { yaml: 'title: ' + index, editing: false },
    }));
    editor.commands.setContent({ type: 'doc', content: frontMatterNodes }, { emitUpdate: false });
    await waitFor('513 mounted FrontMatter NodeViews', () => {
      const root = currentProseMirror();
      return root?.querySelectorAll('.front-matter-node').length === 513 ? root : null;
    }, 30000);
    await expectReject(
      () => overflow.session.captureRecoveryBundle(),
      /恢复捕获不完整|registry-limit|容量/,
      '513 trusted runtime NodeViews report an export completeness failure without constructor failure',
    );

    // LM004: ordinary save snapshots must account for local text controls that
    // have not blurred yet.  Keep each control focused while invoking the
    // production session snapshot; a missing draft is a data-loss regression.
    const pendingTextCases = [];
    const runPendingTextSnapshotCase = async ({ label, source, doc, nodeSelector, controlSelector, activateEvent, draft }) => {
      const pendingSession = overflow.session;
      store.setPaneContent('main', source, false, false);
      await pendingSession.replaceMarkdown(source);
      editor = await waitFor(label + ' editor instance', currentEditor);
      editor.commands.setContent(doc, { emitUpdate: false });
      const root = await waitFor(label + ' NodeView', () => {
        const candidate = currentProseMirror();
        return candidate?.querySelector(nodeSelector) ? candidate : null;
      });
      const nodeView = root.querySelector(nodeSelector);
      nodeView.dispatchEvent(new MouseEvent(activateEvent, { bubbles: true }));
      const control = await waitFor(label + ' local editor', () => nodeView.querySelector(controlSelector));
      control.focus();
      control.value = draft;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      const tab = store.getPaneTab('main');
      if (!tab) throw new Error(label + ' pending-text tab disappeared');
      store.markDocumentChanged(tab.id, pendingSession.revision);
      const focusedBeforeSnapshot = document.activeElement === control;
      const pendingBeforeSnapshot = pendingSession.hasPendingEdits?.() === true;
      let snapshot = null;
      let snapshotError = null;
      let runtimeSnapshot = null;
      let runtimeSnapshotError = null;
      try {
        runtimeSnapshot = await runtime.snapshotDocumentTab(tab.id, 'save');
      } catch (error) {
        runtimeSnapshotError = String(error);
      }
      const focusedAfterRuntimeSnapshot = document.activeElement === control;
      try {
        snapshot = await pendingSession.snapshot('save');
      } catch (error) {
        snapshotError = String(error);
      }
      const markdown = snapshot?.markdown ?? null;
      const runtimeMarkdown = runtimeSnapshot?.markdown ?? null;
      const focusedAfterSnapshot = document.activeElement === control;
      return {
        label,
        focusedBeforeSnapshot,
        focusedAfterRuntimeSnapshot,
        focusedAfterSnapshot,
        pendingBeforeSnapshot,
        localValueAfterSnapshot: control.value,
        markdown,
        markdownContainsDraft: typeof markdown === 'string' && markdown.includes(draft),
        runtimeMarkdown,
        runtimeMarkdownContainsDraft: typeof runtimeMarkdown === 'string' && runtimeMarkdown.includes(draft),
        sourceAfterSnapshot: store.getPaneTab('main')?.content ?? null,
        snapshotRevision: snapshot?.revision ?? null,
        snapshotError,
        runtimeSnapshotRevision: runtimeSnapshot?.revision ?? null,
        runtimeSnapshotError,
      };
    };
    const pendingFrontMatterDraft = 'title: pending frontmatter';
    pendingTextCases.push(await runPendingTextSnapshotCase({
      label: 'FrontMatter',
      source: '',
      doc: {
        type: 'doc',
        content: [{ type: 'frontMatter', attrs: { yaml: 'title: accepted', editing: false } }],
      },
      nodeSelector: '.front-matter-node',
      controlSelector: '.front-matter-editor',
      activateEvent: 'mousedown',
      draft: pendingFrontMatterDraft,
    }));
    const pendingFootnoteDraft = '[^a]: pending footnote';
    pendingTextCases.push(await runPendingTextSnapshotCase({
      label: 'Footnotes',
      source: '',
      doc: {
        type: 'doc',
        content: [{ type: 'footnotes', attrs: { markdown: '[^a]: accepted footnote', html: '', editing: false } }],
      },
      nodeSelector: '.footnotes',
      controlSelector: '.footnotes-editor',
      activateEvent: 'click',
      draft: pendingFootnoteDraft,
    }));
    const pendingTextLoss = pendingTextCases.filter((result) =>
      (result.runtimeSnapshotError == null && result.runtimeMarkdownContainsDraft === false)
      || (result.snapshotError == null && result.markdownContainsDraft === false),
    );
    const pendingTextSnapshotErrors = pendingTextCases.filter((result) =>
      result.runtimeSnapshotError != null || result.snapshotError != null,
    );
    const pendingTextSafety = {
      status: pendingTextLoss.length > 0
        ? 'gap-observed'
        : pendingTextSnapshotErrors.length > 0
          ? 'snapshot-error'
          : 'preserved',
      cases: pendingTextCases,
      focusedWithoutBlur: pendingTextCases.every((result) => result.focusedBeforeSnapshot
        && result.focusedAfterRuntimeSnapshot && result.focusedAfterSnapshot),
      snapshotIncludedEveryDraft: pendingTextCases.every((result) => result.runtimeMarkdownContainsDraft
        && result.markdownContainsDraft),
      note: pendingTextLoss.length > 0
        ? 'The production runtime snapshot omitted a still-focused local text draft; ordinary save is unsafe until a generic pending provider flushes these NodeViews.'
        : pendingTextSnapshotErrors.length > 0
          ? 'The production WYSIWYG session snapshot raised before focused local text preservation could be proved.'
          : 'Both focused local text drafts were present in the ordinary save snapshot without a blur.'
    };
    // Return to a clean untitled tab before closing the owned window.  This
    // does not blur or commit either control and keeps the test source-free.
    store.setPaneContent('main', '', false, false);

    await waitFor('Tauri bridge before recovery probe cleanup', () => typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function');
    // The recovery probe deliberately leaves focused local controls mounted
    // so their ordinary-save gap is observable.  Force-destroy only this
    // launcher-owned window after recording the result; the production close
    // path is exercised by its dedicated native scenario and is not claimed
    // by this cleanup step.
    const result = {
      status: pendingTextSafety.status === 'preserved' ? 'passed' : 'observed-lm004-gap',
      parser: { nodeType: parsedFootnotes.type.name, retainedInnerHtml: true },
      renderedFootnotes: renderedFootnotes.slice(0, 500),
      capturedBufferKinds: capturedKinds,
      restoredDraft: recapturedFootnote.payload.draft.markdown,
      nonEmptyUntitledRejected: true,
      dirtyEmptyUntitledRejected: true,
      sourceModelMismatchRejected: true,
      runtimeNodeViewOverflow: 513,
      pendingTextSafety,
      cleanupMethod: 'owned-window-destroy-after-probe',
      sourceFixture: expectedFixture,
      runtimePaths,
    };
    // Let CDP deliver the result before destroying the owned window.  The
    // launcher still waits for this process to exit and records the forced
    // cleanup separately from the production close path.
    setTimeout(() => {
      void globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' });
    }, 0);
    return result;
  })()` , 60000);
}

/**
 * Exercise ordinary WYSIWYG save snapshots against a real Markdown source
 * file.  This deliberately does not construct a PM document, set a pane
 * projection, or mark a tab dirty: the only input is the fixture opened by
 * appStore.openFile, followed by a focused NodeView input event.
 */
export async function runLm004PendingProbe(client, context) {
  assertRecoveryProbeContext(client, context, "lm004-pending");
  const fixtureContent = JSON.stringify(context.fixtureContent);
  const fixturePath = JSON.stringify(context.fixturePath);
  const runtimePathCheck = createRuntimePathCheck(context);
  return await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expectedFixture = ${fixtureContent};
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
    const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
    const progress = (stage, extra = {}) => {
      try {
        const dom = currentEditorDom();
        const tab = store.getPaneTab('main');
        const liveSession = tab ? runtime.documentSessionForTab(tab.id) : null;
        const current = currentEditor();
        const page = dom?.shell.closest('.editor-page');
        globalThis.__LIGHTMARK_QA_PROGRESS = {
          stage,
          at: new Date().toISOString(),
          activeTabId: store.appStore.activeTabId || null,
          paneTabId: tab?.id || null,
          path: tab?.path || null,
          sessionAvailable: Boolean(liveSession),
          sessionTabId: liveSession?.tabId || liveSession?.id || null,
          sessionEditorIdentityMatches: Boolean(liveSession?.editorIdentity && liveSession.editorIdentity === current),
          editorFound: Boolean(current),
          domFound: Boolean(dom),
          pageClassName: page?.className || null,
          pending: liveSession?.hasPendingEdits?.() === true,
          mutationToken: liveSession?.mutationToken?.() || null,
          ...extra,
        };
      } catch (error) {
        globalThis.__LIGHTMARK_QA_PROGRESS = { stage, at: new Date().toISOString(), progressError: String(error), ...extra };
      }
    };
    const currentEditorDom = () => {
      const tab = store.getPaneTab('main');
      if (!tab) return null;
      const panes = [...document.querySelectorAll('.lm-editor-pane')];
      let roots;
      if (store.appStore.splitLayout.enabled) {
        if (store.appStore.splitLayout.activePaneId !== 'main') return null;
        const activePanes = panes.filter((pane) => pane.classList?.contains?.('active'));
        if (activePanes.length !== 1) return null;
        roots = activePanes;
      } else {
        const workspaces = [...document.querySelectorAll('main.lm-workspace')];
        if (workspaces.length !== 1) return null;
        roots = workspaces;
      }
      const shells = roots.flatMap((root) => [...root.querySelectorAll('.lm-editor-scroll')]);
      const matchingShells = shells.filter((candidate) =>
        candidate.isConnected && candidate.querySelectorAll('.ProseMirror').length === 1,
      );
      const settledShells = matchingShells.filter((candidate) => {
        const classes = [...(candidate.closest('.editor-page')?.classList || [])];
        return !classes.some((className) => /-(enter|leave)-(active|from|to)$/.test(className));
      });
      const candidates = settledShells.length === 1 ? settledShells : matchingShells;
      if (candidates.length !== 1) return null;
      const shell = candidates[0];
      const proseMirror = shell.querySelector('.ProseMirror');
      if (!proseMirror || !proseMirror.isConnected) return null;
      return { tab, shell, proseMirror };
    };
    const editorFromComponent = (component) => {
      const visited = new Set();
      while (component && !visited.has(component)) {
        visited.add(component);
        for (const holder of [component.props, component.vnode?.props, component.setupState, component.ctx, component.proxy]) {
          const candidate = holder?.editor;
          if (candidate?.view?.state?.doc) return candidate;
          if (candidate?.value?.view?.state?.doc) return candidate.value;
        }
        component = component.parent || null;
      }
      return null;
    };
    const componentForAnchor = (anchor) => anchor?.__vueParentComponent || anchor?.__vnode?.component || null;
    const currentEditor = () => {
      const dom = currentEditorDom();
      if (!dom) return null;
      for (const anchor of [dom.shell, dom.proseMirror.parentElement, dom.proseMirror]) {
        const editor = editorFromComponent(componentForAnchor(anchor));
        if (editor && editor.options?.element === dom.proseMirror.parentElement) return editor;
      }
      return null;
    };
    const waitFor = async (label, predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await wait();
      }
      progress('lm004:timeout:' + label, {
        bodyText: document.body?.innerText?.slice(0, 1200) || '',
        bodyHtml: document.body?.innerHTML?.slice(0, 4000) || '',
        bodyHtmlTail: document.body?.innerHTML?.slice(-8000) || '',
        editorClassNames: [...document.querySelectorAll('[class]')]
          .map((element) => String(element.className || ''))
          .filter((value) => /editor|workspace|prose|page|pane/i.test(value))
          .slice(-80),
        prosemirrorCount: document.querySelectorAll('.ProseMirror').length,
        editorPaneCount: document.querySelectorAll('.lm-editor-pane').length,
      });
      throw new Error('timed out waiting for ' + label);
    };
    const equal = (actual, expected, label) => {
      if (actual !== expected) throw new Error(label + ': ' + JSON.stringify({ actual, expected }));
    };

    progress('lm004:begin');
    if (store.appStore.splitLayout.enabled) await store.toggleSplitLayout();
    await store.setActivePane('main');
    const openFixture = async (label) => {
      progress('lm004:' + label + ':before-open');
      await store.openFile(fixturePath, { recordNavigation: false, paneId: 'main' });
      const opened = store.getPaneTab('main');
      equal(opened?.path, fixturePath, 'LM004 fixture opened through production file path');
      equal(opened?.content, expectedFixture, 'LM004 fixture source content loaded without projection override');
      await store.switchMode('wysiwyg');
      const tabId = opened.id;
      const session = await waitFor(label + ':real WYSIWYG document session', () => {
        const candidate = runtime.documentSessionForTab(tabId);
        return candidate?.mode === 'wysiwyg' ? candidate : null;
      });
      const editor = await waitFor(label + ':real WYSIWYG editor identity', () => {
        const dom = currentEditorDom();
        const candidate = currentEditor();
        return dom && candidate && dom.tab.id === tabId && session.editorIdentity === candidate
          ? candidate
          : null;
      });
      const initialDom = await waitFor(label + ':real Markdown special NodeViews', () => {
        const dom = currentEditorDom();
        const root = dom?.proseMirror;
        if (!root) return null;
        const selectors = ['.front-matter-node', '.footnotes', '.toc-node', '.html-block-node'];
        return selectors.every((selector) => root.querySelector(selector)) ? root : null;
      });
      const initialNodeCounts = {
        frontmatter: initialDom.querySelectorAll('.front-matter-node').length,
        footnote: initialDom.querySelectorAll('.footnotes').length,
        toc: initialDom.querySelectorAll('.toc-node').length,
        htmlBlock: initialDom.querySelectorAll('.html-block-node').length,
      };
      if (Object.values(initialNodeCounts).some((count) => count !== 1)) {
        throw new Error('LM004 real Markdown fixture did not create exactly one of each target NodeView: ' + JSON.stringify(initialNodeCounts));
      }
      progress('lm004:' + label + ':source-nodeviews-ready', { initialNodeCounts, tabId });
      return { tabId, session, editor, initialNodeCounts };
    };
    const closeFixtureAfterCase = async (tabId) => {
      progress('lm004:close:before', { tabId });
      const closeSession = runtime.documentSessionForTab(tabId);
      const finalize = closeSession?.finalizeClosePrompt;
      if (finalize) closeSession.finalizeClosePrompt = async (...args) => {
        progress('lm004:close:finalize-before');
        const result = await finalize.apply(closeSession, args);
        progress('lm004:close:finalize-after');
        return result;
      };
      const closePromise = store.closeTab(tabId);
      const dialog = await waitFor('discard dialog after LM004 case', () => [...document.querySelectorAll('section[role="dialog"]')]
        .find((candidate) => [...candidate.querySelectorAll('button')]
          .some((button) => (button.textContent || '').includes('不保存'))));
      const discard = [...dialog.querySelectorAll('button')]
        .find((button) => (button.textContent || '').includes('不保存'));
      if (!discard) throw new Error('LM004 close dialog did not expose the 不保存 action');
      progress('lm004:close:dialog');
      discard.click();
      progress('lm004:close:discard');
      await closePromise;
      progress('lm004:close:resolved');
      await waitFor('LM004 fixture tab close', () => store.getPaneTab('main')?.id !== tabId);
    };
    let active = await openFixture('initial');

    const cases = [
      {
        label: 'FrontMatter',
        kind: 'frontmatter',
        nodeSelector: '.front-matter-node',
        controlSelector: '.front-matter-editor',
        activateEvent: 'mousedown',
        draft: 'title: pending frontmatter ${context.runToken}',
      },
      {
        label: 'Footnotes',
        kind: 'footnote',
        nodeSelector: '.footnotes',
        controlSelector: '.footnotes-editor',
        activateEvent: 'click',
        draft: '[^qa]: pending footnote ${context.runToken}',
      },
      {
        label: 'TOC',
        kind: 'toc',
        nodeSelector: '.toc-node',
        controlSelector: '.toc-node-editor',
        activateEvent: 'mousedown',
        draft: 'pending toc ${context.runToken}',
      },
      {
        label: 'HTML',
        kind: 'htmlBlock',
        nodeSelector: '.html-block-node',
        controlSelector: '.html-block-editor',
        activateEvent: 'mousedown',
        draft: '<div>pending html ${context.runToken}</div>',
      },
    ];
    let cumulativeExpected = expectedFixture;
    const expectedMarkdownForCase = (testCase) => {
      const replacements = {
        frontmatter: [
          '---\\ntitle: Recovery bundle fixture\\nqa: native\\n---',
          '---\\n' + testCase.draft + '\\n---',
        ],
        footnote: ['[^qa]: accepted footnote', testCase.draft],
        toc: ['[TOC]', testCase.draft],
        htmlBlock: ['<div data-lightmark-qa="html-block"><b>accepted html</b></div>', testCase.draft],
      };
      const replacement = replacements[testCase.kind];
      if (!replacement) return null;
      cumulativeExpected = cumulativeExpected.replace(replacement[0], replacement[1]);
      return cumulativeExpected;
    };
    const results = [];
    for (const [caseIndex, testCase] of cases.entries()) {
      progress('lm004:before-' + testCase.kind);
      const nodeView = await waitFor(testCase.label + ' NodeView', () => currentEditorDom()?.proseMirror?.querySelector(testCase.nodeSelector));
      nodeView.dispatchEvent(new MouseEvent(testCase.activateEvent, { bubbles: true }));
      const control = await waitFor(testCase.label + ' focused local editor', () => nodeView.querySelector(testCase.controlSelector));
      control.focus();
      control.value = testCase.draft;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      let blurCount = 0;
      control.addEventListener('blur', () => { blurCount += 1; });
      const focusedBeforeSnapshot = document.activeElement === control;
      const pendingBeforeSnapshot = active.session.hasPendingEdits?.() === true;
      const tokenBeforeSnapshot = active.session.mutationToken?.() || null;
      let runtimeSnapshot = null;
      let runtimeSnapshotError = null;
      try {
        runtimeSnapshot = await runtime.snapshotDocumentTab(active.tabId, 'save');
      } catch (error) {
        runtimeSnapshotError = String(error);
      }
      let secondSnapshot = null;
      let secondSnapshotError = null;
      try { secondSnapshot = await runtime.snapshotDocumentTab(active.tabId, 'save'); }
      catch (error) { secondSnapshotError = String(error); }
      const liveSession = runtime.documentSessionForTab(active.tabId);
      const runtimeMarkdown = runtimeSnapshot?.markdown ?? null;
      const sourceAfterSnapshot = store.getPaneTab('main')?.content ?? null;
      const expectedMarkdown = expectedMarkdownForCase(testCase);
      const result = {
        label: testCase.label,
        kind: testCase.kind,
        focusedBeforeSnapshot,
        blurCountDuringSnapshot: blurCount,
        pendingBeforeSnapshot,
        tokenBeforeSnapshot,
        sessionStillRegistered: liveSession === active.session,
        sessionEditorIdentityMatches: Boolean(liveSession?.editorIdentity && liveSession.editorIdentity === currentEditor()),
        runtimeSnapshotUsed: true,
        runtimeSnapshotError,
        runtimeSnapshotRevision: runtimeSnapshot?.revision ?? null,
        runtimeMarkdown: typeof runtimeMarkdown === 'string' ? runtimeMarkdown.slice(0, 4000) : null,
        runtimeMarkdownContainsDraft: typeof runtimeMarkdown === 'string' && runtimeMarkdown.includes(testCase.draft),
        runtimeMarkdownMatchesExpected: typeof runtimeMarkdown === 'string' && runtimeMarkdown === expectedMarkdown,
        sourceAfterSnapshot: typeof sourceAfterSnapshot === 'string' ? sourceAfterSnapshot.slice(0, 4000) : null,
        sourceContainsDraft: typeof sourceAfterSnapshot === 'string' && sourceAfterSnapshot.includes(testCase.draft),
        pendingAfterSnapshot: liveSession?.hasPendingEdits?.() === true,
        secondSnapshotError,
        secondSnapshotMatchesExpected: secondSnapshot?.markdown === expectedMarkdown,
        focusedAfterSnapshot: document.activeElement === control,
        dirtyAfterInput: store.getPaneTab('main')?.isDirty === true,
        localValueAfterSnapshot: control.value,
      };
      results.push(result);
      progress('lm004:after-' + testCase.kind, { result });
      if (!result.sessionStillRegistered) throw new Error(testCase.label + ' snapshot replaced the production session unexpectedly');
      // A production flush may remove the control and naturally emit blur as
      // it commits the local value.  The evidence that this test is about is
      // the focused input and pending state immediately before snapshot; no
      // synthetic blur, PM JSON, or dirty marker was used by the probe.
    }
    const failures = results.filter((result) =>
      !result.focusedBeforeSnapshot
      || !result.pendingBeforeSnapshot
      || result.runtimeSnapshotError != null
      || !result.runtimeMarkdownContainsDraft
      || !result.runtimeMarkdownMatchesExpected
      || result.pendingAfterSnapshot
      || result.secondSnapshotError != null
      || !result.secondSnapshotMatchesExpected
      || !result.dirtyAfterInput
      || (result.kind !== 'toc' && (!result.focusedAfterSnapshot || result.blurCountDuringSnapshot !== 0)),
    );
    const pendingTextSafety = {
      status: failures.length === 0 ? 'preserved' : 'gap-observed',
      sourceOpenedThroughProductionFilePath: true,
      manuallyMarkedDirty: false,
      replacedPmDocument: false,
      focusedWithoutSyntheticBlur: results.every((result) => result.focusedBeforeSnapshot),
      snapshotIncludedEveryDraft: failures.length === 0,
      cases: results,
      failures: failures.map((result) => ({
        label: result.label,
        runtimeSnapshotError: result.runtimeSnapshotError,
        focusedBeforeSnapshot: result.focusedBeforeSnapshot,
        pendingBeforeSnapshot: result.pendingBeforeSnapshot,
        runtimeMarkdownContainsDraft: result.runtimeMarkdownContainsDraft,
        runtimeMarkdownMatchesExpected: result.runtimeMarkdownMatchesExpected,
        sourceContainsDraft: result.sourceContainsDraft,
      })),
      note: failures.length === 0
        ? 'Each local editor was focused and changed through the real Markdown NodeView before production runtime.snapshotDocumentTab(save); every draft reached the exact expected Markdown snapshot without synthetic dirty or PM setup.'
        : 'A real Markdown NodeView local draft was not proven to reach the production runtime snapshot while focused.',
    };
    const historyBase = (await runtime.snapshotDocumentTab(active.tabId, 'save')).markdown;
    const { runFineSourceCases } = await import('/scripts/qa/fine-source-cases.ts');
    const fineSourceCases = runFineSourceCases(active.editor.state.schema);
    progress('lm004:fine-source', { fineSourceCases });
    let paragraphPos = null;
    active.editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text.startsWith('The source file must')) paragraphPos = pos;
    });
    if (paragraphPos == null) throw new Error('history paragraph not found');
    active.editor.commands.setTextSelection(paragraphPos + 4);
    active.editor.commands.insertContent('HISTORY ');
    const edited = await runtime.snapshotDocumentTab(active.tabId, 'save');
    equal(edited.markdown, historyBase.replace('The source', 'The HISTORY source'), 'WYS exact edit');
    await store.switchMode('source');
    await waitFor('history source session', () => runtime.documentSessionForTab(active.tabId)?.mode === 'source');
    await runtime.moveDocumentHistory(active.tabId, -1);
    equal((await runtime.snapshotDocumentTab(active.tabId, 'save')).markdown, historyBase, 'undo WYS input in Source');
    await runtime.moveDocumentHistory(active.tabId, 1);
    equal((await runtime.snapshotDocumentTab(active.tabId, 'save')).markdown, edited.markdown, 'redo WYS input in Source');
    const sourceSession = runtime.documentSessionForTab(active.tabId);
    const insertion = edited.markdown.indexOf('HISTORY ') + 'HISTORY '.length;
    await sourceSession.applySourcePatch({ from: insertion, to: insertion, expected: '', insert: 'SOURCE ' }, sourceSession.revision);
    const sourceEdited = await runtime.snapshotDocumentTab(active.tabId, 'save');
    equal(sourceEdited.markdown, edited.markdown.replace('HISTORY ', 'HISTORY SOURCE '), 'source local edit');
    await store.switchMode('wysiwyg');
    await waitFor('history WYS session', () => runtime.documentSessionForTab(active.tabId)?.mode === 'wysiwyg');
    await runtime.moveDocumentHistory(active.tabId, -1);
    equal((await runtime.snapshotDocumentTab(active.tabId, 'save')).markdown, edited.markdown, 'undo Source input in WYS');
    await runtime.moveDocumentHistory(active.tabId, 1);
    equal((await runtime.snapshotDocumentTab(active.tabId, 'save')).markdown, sourceEdited.markdown, 'redo Source input in WYS');
    await runtime.moveDocumentHistory(active.tabId, -1);
    await runtime.moveDocumentHistory(active.tabId, -1);
    equal((await runtime.snapshotDocumentTab(active.tabId, 'save')).markdown, historyBase, 'continuous undo restores original bytes');
    const historySafety = { status: 'passed', crossModeUndoRedo: true, sourceBytesRestored: true };
    progress('lm004:complete', { pendingTextSafety });
    await waitFor('Tauri bridge before LM004 probe cleanup', () => typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function');
    const result = {
      status: pendingTextSafety.status === 'preserved' ? 'passed' : 'observed-lm004-gap',
      pendingTextSafety,
      historySafety,
      fineSourceCases,
      cleanupMethod: 'owned-window-destroy-after-probe',
      sourceFixture: expectedFixture,
      runtimePaths,
    };
    setTimeout(() => {
      void globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' });
    }, 0);
    return result;
  })()`, 180000);
}

function assertRecoveryProbeContext(client, context, expectedPhaseName = "recovery-bundle") {
  const phases = context?.manifest?.launch?.phases;
  const phase = Array.isArray(phases) ? phases[phases.length - 1] : null;
  if (!context?.runToken || !context.identifier || !context.expectedWebviewProfileDir || !context.manifest?.isolation?.preexistingPathsChecked) {
    throw new NativeIsolationError("Recovery probe requires an isolated launcher run token, identifier, and verified profile.");
  }
  if (!phase || phase.name !== expectedPhaseName || !phase.targetNonce || !phase.vitePort || !phase.cdpPort || !phase.pid) {
    throw new NativeIsolationError("Recovery probe requires the current launcher recovery phase nonce, ports, and owned process.");
  }
  if (!phase.target || !isExpectedTarget(phase.target, phase.vitePort, phase.targetNonce, phase.cdpPort)) {
    throw new NativeIsolationError("Recovery probe refuses a CDP target without the current launcher nonce and expected page identity.");
  }
  if (!client || client.url !== phase.target.webSocketDebuggerUrl) {
    throw new NativeIsolationError("Recovery probe CDP client is not bound to the launcher's verified page target.");
  }
  const listener = phase.loopback?.listeners?.[0];
  const profile = listener?.process?.profileArgument;
  const normalizePath = (value) => String(value || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  if (!listener || normalizePath(profile) !== normalizePath(context.expectedWebviewProfileDir)) {
    throw new NativeIsolationError("Recovery probe refuses a CDP listener without the launcher's owned WebView2 profile.");
  }
  if (!Array.isArray(listener.process?.chain) || !listener.process.chain.some((entry) => Number(entry.ProcessId) === Number(phase.pid))) {
    throw new NativeIsolationError("Recovery probe refuses a CDP listener outside the launcher's process tree.");
  }
}

async function runSaveCloseProbe(client, context, editedContent) {
  const fixturePath = JSON.stringify(context.fixturePath);
  const expected = JSON.stringify(editedContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  const result = await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expected = ${expected};
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
    await store.setActivePane('main');
    await store.openFile(fixturePath, { recordNavigation: false, paneId: 'main' });
    const opened = store.getPaneTab('main');
    if (!opened || opened.path !== fixturePath) throw new Error('isolated fixture did not open in the active pane');
    await store.switchMode('source');
    const tab = store.getPaneTab('main');
    if (!tab) throw new Error('active fixture tab disappeared after entering source mode');
    const session = await runtime.waitForDocumentSession(tab.id, 'source');
    store.setContent(expected, true);
    await session.replaceMarkdown(expected);
    await session.flushPendingEdits?.();
    const saved = await store.saveCurrentFile();
    if (!saved) throw new Error('saveCurrentFile returned false for the isolated fixture');
    if (store.appStore.isDirty || store.getDirtyTabs().length > 0) {
      throw new Error('isolated fixture remained dirty after saveCurrentFile');
    }
    store.appStore.settings.general.launchBehavior = 'restoreLastSession';
    store.appStore.settings.general.restoreLastFile = true;
    await store.persistConfig();
    const active = store.getPaneTab('main');
    const result = {
      path: active?.path || '',
      content: store.appStore.currentContent,
      mode: store.appStore.editorMode,
      dirty: store.appStore.isDirty,
      runtimePaths,
    };
    if (result.path !== fixturePath || result.content !== expected || result.dirty) {
      throw new Error('isolated save state did not match the edited fixture');
    }
    const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw new Error('Tauri internal invoke bridge is unavailable');
    await invoke('plugin:window|close', { label: 'main' });
    return result;
  })()`);
  return { ...result, expectedBytes: Buffer.byteLength(editedContent, "utf8") };
}

async function runReopenProbe(client, context, editedContent) {
  const fixturePath = JSON.stringify(context.fixturePath);
  const expected = JSON.stringify(editedContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  const result = await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expected = ${expected};
    ${runtimePathCheck}
    const normalize = (value) => String(value || '').replaceAll('\\\\', '/').toLowerCase();
    const store = await import('/src/stores/appStore.ts');
    const startedAt = Date.now();
    let active;
    while (Date.now() - startedAt < 15000) {
      active = store.getPaneTab('main');
      if (active?.path && normalize(active.path) === normalize(fixturePath)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!active?.path || normalize(active.path) !== normalize(fixturePath)) {
      throw new Error('second isolated launch did not restore the fixture path');
    }
    const result = {
      path: active.path,
      content: store.appStore.currentContent,
      mode: store.appStore.editorMode,
      dirty: store.appStore.isDirty,
      runtimePaths,
    };
    if (result.content !== expected || result.dirty) {
      throw new Error('second isolated launch restored unexpected content or dirty state');
    }
    const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw new Error('Tauri internal invoke bridge is unavailable');
    await invoke('plugin:window|close', { label: 'main' });
    return result;
  })()`);
  return { ...result, expectedBytes: Buffer.byteLength(editedContent, "utf8") };
}

async function runHtmlSecurityProbe(client, context) {
  const fixturePath = JSON.stringify(context.fixturePath);
  const expectedSentinel = JSON.stringify(context.scenarioEvidence.sentinel);
  const expectedMaliciousSource = JSON.stringify(context.scenarioEvidence.maliciousSource);
  const expectedSafeSource = JSON.stringify(context.scenarioEvidence.safeSource);
  const runtimePathCheck = createRuntimePathCheck(context);
  return await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expectedSentinel = ${expectedSentinel};
    const expectedMaliciousSource = ${expectedMaliciousSource};
    const expectedSafeSource = ${expectedSafeSource};
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw new Error('Tauri internal invoke bridge is unavailable');
    const collectRenderState = () => {
      const container = document.querySelector('.large-source-preview');
      const hosts = container ? Array.from(container.querySelectorAll('article')) : [];
      const images = hosts.flatMap((renderHost) => Array.from(renderHost.querySelectorAll('img')));
      const safeImages = images.filter((image) => image.getAttribute('alt') === 'isolated-safe-image');
      const maliciousSourceImages = images.filter((image) => image.getAttribute('src') === expectedMaliciousSource);
      const textContent = hosts.map((renderHost) => renderHost.textContent || '').join('\\n');
      return { container, hosts, images, safeImages, maliciousSourceImages, textContent };
    };
    const waitForImageSettlement = (image, timeoutMs) => {
      const snapshot = (event) => ({
        event,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      });
      if (image.complete) return Promise.resolve(snapshot('complete'));
      return new Promise((resolve) => {
        let timer = null;
        let finished = false;
        const finish = (event) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          image.removeEventListener('load', onLoad);
          image.removeEventListener('error', onError);
          resolve(snapshot(event));
        };
        const onLoad = () => finish('load');
        const onError = () => finish('error');
        image.addEventListener('load', onLoad, { once: true });
        image.addEventListener('error', onError, { once: true });
        timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
      });
    };
    try {
      await store.setActivePane('main');
      await store.openFile(fixturePath, { recordNavigation: false, paneId: 'main' });
      const opened = store.getPaneTab('main');
      if (!opened || opened.path !== fixturePath) throw new Error('HTML security fixture did not open in the active pane');

      // Large documents now render only an explicit bounded source preview.
      // Exercise that production action instead of expecting the removed full renderer.
      const mountDeadline = Date.now() + 10000;
      while (!document.querySelector('[data-large-source-editor] .cm-content')?.textContent.includes('Large HTML security fixture')) {
        if (Date.now() > mountDeadline) throw new Error('HTML security source window did not load the fixture prefix');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const previewButton = [...document.querySelectorAll('.large-source-editor button, .large-source-shell button, button')].find(button => button.textContent?.trim() === '预览选区');
      if (!previewButton) throw new Error('Production bounded preview action missing');
      previewButton.click();

      const deadline = Date.now() + 10000;
      let tab = opened;
      let renderState = collectRenderState();
      let safeImage = null;
      let safeImageState = null;
      let observedSafeImage = null;
      while (Date.now() < deadline) {
        tab = store.getPaneTab('main');
        renderState = collectRenderState();
        safeImage = renderState.safeImages.find((image) => image.getAttribute('src') === expectedSafeSource) || null;
        if (safeImage && safeImage !== observedSafeImage) {
          observedSafeImage = safeImage;
          safeImageState = await waitForImageSettlement(
            safeImage,
            Math.min(1000, Math.max(0, deadline - Date.now())),
          );
        }
        const normalContentPresent = renderState.textContent.includes('Large HTML security fixture');
        const safeImageLoaded = Boolean(
          safeImageState
          && safeImageState.naturalWidth > 0
          && safeImageState.naturalHeight > 0,
        );
        if (tab?.documentMode === 'large' && renderState.hosts.length > 0 && safeImage && normalContentPresent && safeImageLoaded) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      renderState = collectRenderState();
      safeImage = renderState.safeImages.find((image) => image.getAttribute('src') === expectedSafeSource) || null;
      const normalContentPresent = renderState.textContent.includes('Large HTML security fixture');
      const safeImageLoaded = Boolean(
        safeImage
        && safeImage.complete
        && safeImage.naturalWidth > 0
        && safeImage.naturalHeight > 0,
      );
      if (!tab || tab.path !== fixturePath || tab.documentMode !== 'large') {
        throw new Error('HTML security fixture did not enter large document mode');
      }
      if (!renderState.container || renderState.hosts.length === 0 || !safeImage || !normalContentPresent || !safeImageLoaded) {
        throw new Error('HTML security fixture render readiness failed: ' + JSON.stringify({
          tabDocumentMode: tab.documentMode,
          largeRenderCount: renderState.hosts.length,
          safeImageCount: renderState.safeImages.length,
          safeImageState,
          safeImageSource: safeImage?.getAttribute('src') || null,
          normalContentPresent,
          hostText: renderState.hosts.map((renderHost) => (renderHost.textContent || '').slice(0, 240)),
        }));
      }

      const maliciousImage = renderState.images.find(
        (image) => image.getAttribute('src') === expectedMaliciousSource
          && image.getAttribute('data-type') === 'inline-math',
      ) || null;
      const maliciousSourceImages = renderState.maliciousSourceImages;
      const activeEventAttributes = renderState.hosts.reduce(
        (count, renderHost) => count + renderHost.querySelectorAll('[onerror], [onload], [onclick]').length,
        0,
      );
      const actualSentinel = maliciousSourceImages
        .map((image) => image.dataset.lightmarkQaSentinel || null)
        .find(Boolean) || null;
      const safeImageSettled = safeImageLoaded;
      if (maliciousImage || activeEventAttributes > 0 || actualSentinel || !normalContentPresent || !safeImageSettled) {
        throw new Error('HTML security fixture retained executable markup or failed the safe-image/content check');
      }
      return {
        path: tab.path,
        appDocumentMode: store.appStore.documentMode,
        tabDocumentMode: tab.documentMode,
        editorMode: store.appStore.editorMode,
        largeFile: {
          sizeBytes: tab.largeFile?.sizeBytes ?? null,
          totalLines: tab.largeFile?.totalLines ?? null,
        },
        renderedHost: {
          method: 'production-large-source-bounded-preview',
          className: renderState.container.className,
          largeRenderCount: renderState.hosts.length,
          imageOuterHTML: safeImage.outerHTML,
          imageSource: safeImage.getAttribute('src'),
          safeSource: expectedSafeSource,
          maliciousSource: expectedMaliciousSource,
          sourceIsExpectedDataUri: safeImage.getAttribute('src') === expectedSafeSource,
          safeImageSettled,
          safeImageNaturalWidth: safeImage.naturalWidth,
          safeImageNaturalHeight: safeImage.naturalHeight,
          normalContentPresent,
          maliciousImagePresent: Boolean(maliciousImage),
          maliciousSourceImageCount: maliciousSourceImages.length,
          activeEventAttributes,
          onerror: maliciousImage?.getAttribute('onerror') || null,
          sentinel: actualSentinel,
          scriptExecuted: actualSentinel === expectedSentinel,
        },
        runtimePaths,
      };
    } finally {
      await invoke('plugin:window|close', { label: 'main' });
    }
  })()`);
}

function createRuntimePathCheck(context) {
  const expectedPaths = JSON.stringify({
    config: context.expectedAppConfigDir,
    data: context.expectedAppDataDir,
    local: context.expectedAppLocalDataDir,
  });
  return `
    const pathApi = await import('/node_modules/@tauri-apps/api/path.js');
    const runtimePaths = {
      config: await pathApi.appConfigDir(),
      data: await pathApi.appDataDir(),
      local: await pathApi.appLocalDataDir(),
    };
    const expectedRuntimePaths = ${expectedPaths};
    const normalizeRuntimePath = (value) => String(value || '').replaceAll('\\\\', '/').replace(/\\/+$/, '').toLowerCase();
    for (const key of ['config', 'data', 'local']) {
      if (normalizeRuntimePath(runtimePaths[key]) !== normalizeRuntimePath(expectedRuntimePaths[key])) {
        throw new Error('Tauri runtime path mismatch for ' + key + ': expected ' + expectedRuntimePaths[key] + ', got ' + runtimePaths[key]);
      }
    }
  `;
}

function spawnNativeProcess(command, commandArgs, environment, phase) {
  const child = spawn(command, commandArgs, {
    cwd: repositoryRoot,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutStream = createWriteStream(phase.stdoutLog, { encoding: "utf8" });
  const stderrStream = createWriteStream(phase.stderrLog, { encoding: "utf8" });
  const state = {
    child,
    stdoutStream,
    stderrStream,
    stdoutTail: "",
    stderrTail: "",
    exitResult: null,
  };
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stdoutStream.write(text);
    state.stdoutTail = `${state.stdoutTail}${text}`.slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderrStream.write(text);
    state.stderrTail = `${state.stderrTail}${text}`.slice(-8000);
  });
  state.exitPromise = new Promise((resolve) => {
    child.once("error", (error) => {
      state.exitResult = { exitCode: null, signal: null, error: error.message };
      resolve(state.exitResult);
    });
    child.once("close", (exitCode, signal) => {
      state.exitResult = { exitCode, signal, error: null };
      resolve(state.exitResult);
    });
  });
  return state;
}

async function waitForCdpTarget(state, cdpPort, vitePort, targetNonce, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (state.exitResult) {
      throw new NativeIsolationError(`Tauri exited before the isolated target appeared: ${JSON.stringify(state.exitResult)}`);
    }
    try {
      const [version, pages] = await Promise.all([
        fetchJson(`http://127.0.0.1:${cdpPort}/json/version`),
        fetchJson(`http://127.0.0.1:${cdpPort}/json/list`),
      ]);
      const pageTargets = Array.isArray(pages) ? pages.filter((page) => page?.type === "page") : [];
      const nonBlank = pageTargets.filter((page) => !isBlankTargetUrl(page?.url));
      const matching = nonBlank.filter((page) => isExpectedTarget(page, vitePort, targetNonce, cdpPort));
      const unexpected = nonBlank.filter((page) => !isExpectedTarget(page, vitePort, targetNonce, cdpPort));
      if (unexpected.length > 0) {
        throw new NativeIsolationError(
          `Refusing to attach to an unexpected CDP page target: ${JSON.stringify(unexpected.map(summarizeTarget))}`,
        );
      }
      if (matching.length === 1) {
        return {
          version,
          pages: pages.map(summarizeTarget),
          target: matching[0],
        };
      }
    } catch (error) {
      if (error instanceof NativeIsolationError) throw error;
      lastError = error;
    }
    await sleep(150);
  }
  throw new NativeIsolationError(`Timed out waiting for the isolated CDP target: ${lastError || "no target"}`);
}

function isExpectedTarget(target, vitePort, targetNonce, cdpPort) {
  if (!target || target.type !== "page" || typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port === String(vitePort)
      && url.pathname === "/"
      && url.searchParams.get("lightmarkQa") === targetNonce
      && typeof target.webSocketDebuggerUrl === "string"
      && target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${cdpPort}/`);
  } catch {
    return false;
  }
}

function isBlankTargetUrl(value) {
  return value === "about:blank" || value === "" || value == null;
}

function summarizeTarget(target) {
  return {
    id: target?.id || null,
    type: target?.type || null,
    title: target?.title || null,
    url: target?.url || null,
    webSocketDebuggerUrl: target?.webSocketDebuggerUrl || null,
  };
}

async function waitForLoopbackListener(port, expectedProfile, identifier, rootPid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await inspectLoopbackListener(port, { expectedProfile, identifier, rootPid });
    last = snapshot;
    if (snapshot.listeners.length === 1) {
      const listener = snapshot.listeners[0];
      if (listener.localAddress !== "127.0.0.1") {
        throw new NativeIsolationError(`CDP listener is not IPv4 loopback-only: ${JSON.stringify(listener)}`);
      }
      if (!listener.process?.image?.toLowerCase().includes("msedgewebview2")) {
        throw new NativeIsolationError(`CDP listener is not a WebView2 process: ${JSON.stringify(listener)}`);
      }
      return snapshot;
    }
    if (snapshot.listeners.some((listener) => listener.localAddress !== "127.0.0.1")) {
      throw new NativeIsolationError(`Unexpected non-loopback CDP listener: ${JSON.stringify(snapshot.listeners)}`);
    }
    await sleep(150);
  }
  throw new NativeIsolationError(`Timed out waiting for a loopback-only CDP listener: ${JSON.stringify(last)}`);
}

async function inspectLoopbackListener(port, options = {}) {
  const result = await runCaptured("netstat.exe", ["-ano", "-p", "tcp"], { cwd: repositoryRoot });
  if (result.exitCode !== 0) {
    throw new NativeIsolationError(`netstat failed while verifying CDP isolation: ${result.stderr || result.error || result.exitCode}`);
  }
  const netstatLines = result.stdout.split(/\r?\n/u);
  const targetLines = netstatLines.filter((line) => parseNetstat(line).some((row) => row.localPort === port));
  const rows = parseNetstat(targetLines.join("\n")).filter((row) => row.localPort === port && row.state === "LISTENING");
  const listeners = [];
  for (const row of rows) {
    const task = await runCaptured("tasklist.exe", ["/FI", `PID eq ${row.pid}`, "/FO", "CSV", "/NH"], { cwd: repositoryRoot });
    if (task.exitCode !== 0) {
      throw new NativeIsolationError(`tasklist failed for the CDP listener PID ${row.pid}: ${task.stderr || task.error || task.exitCode}`);
    }
    const image = parseTaskImage(task.stdout);
    const process = options.expectedProfile
      ? await inspectProcessOwnership(row.pid, options.rootPid, options.expectedProfile, options.identifier)
      : { pid: row.pid, image, raw: task.stdout.trim() };
    listeners.push({ ...row, process: { ...process, image, raw: task.stdout.trim() } });
  }
  return { port, listeners, raw: targetLines.join("\n").trim() };
}

async function inspectProcessOwnership(listenerPid, rootPid, expectedProfile, identifier) {
  const script = [
    `$target = Get-CimInstance Win32_Process -Filter 'ProcessId = ${listenerPid}';`,
    "$chain = @();",
    "$seen = @{};",
    "for ($depth = 0; $target -and $depth -lt 32; $depth++) {",
    "if ($seen.ContainsKey([int]$target.ProcessId)) { throw 'process parent cycle detected' };",
    "$seen[[int]$target.ProcessId] = $true;",
    "$chain += [pscustomobject]@{ ProcessId = [int]$target.ProcessId; ParentProcessId = [int]$target.ParentProcessId; Name = [string]$target.Name; CommandLine = [string]$target.CommandLine };",
    "if ([int]$target.ProcessId -eq ${rootPid}) { break };",
    "if ([int]$target.ParentProcessId -eq 0) { break };",
    "$target = Get-CimInstance Win32_Process -Filter \"ProcessId = $($target.ParentProcessId)\";",
    "}",
    "$chain | ConvertTo-Json -Compress",
  ].join(" ");
  const result = await runCaptured(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { cwd: repositoryRoot },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new NativeIsolationError(
      `Unable to verify WebView2 process ownership for PID ${listenerPid}: ${result.stderr || result.error || result.exitCode}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new NativeIsolationError(`Unable to parse WebView2 process ownership for PID ${listenerPid}: ${error}`);
  }
  const chain = Array.isArray(parsed) ? parsed : [parsed];
  const commandLine = String(chain[0]?.CommandLine || "");
  const normalizedProfile = String(expectedProfile).replaceAll("\\", "/").toLowerCase();
  if (!String(chain[0]?.Name || "").toLowerCase().includes("msedgewebview2")) {
    throw new NativeIsolationError(`CDP listener PID ${listenerPid} is not msedgewebview2.exe: ${JSON.stringify(chain[0])}`);
  }
  const profileArgument = extractCommandLineArgument(commandLine, "user-data-dir");
  if (!profileArgument || profileArgument.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() !== normalizedProfile.replace(/\/+$/, "")) {
    throw new NativeIsolationError(
      `WebView2 command line does not bind --user-data-dir to the isolated profile ${expectedProfile}: ${JSON.stringify(chain[0])}`,
    );
  }
  if (!chain.some((entry) => Number(entry.ProcessId) === Number(rootPid))) {
    throw new NativeIsolationError(
      `CDP listener PID ${listenerPid} is not descended from launcher PID ${rootPid}: ${JSON.stringify(chain)}`,
    );
  }
  return { listenerPid, rootPid, chain, commandLine, profileArgument, identifier };
}

function extractCommandLineArgument(commandLine, name) {
  const pattern = new RegExp(`(?:^|\\s)--${name}=(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "i");
  const match = String(commandLine).match(pattern);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function parseNetstat(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5 || fields[0].toUpperCase() !== "TCP") continue;
    const match = fields[1].match(/^(.+):(\d+)$/u);
    if (!match) continue;
    rows.push({
      localAddress: match[1].replace(/^\[(.*)\]$/u, "$1"),
      localPort: Number(match[2]),
      foreignAddress: fields[2],
      state: fields[3].toUpperCase(),
      pid: Number(fields[4]),
    });
  }
  return rows;
}

function parseTaskImage(output) {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.trim().startsWith('"'));
  if (!line) return null;
  return line.slice(1, line.indexOf('"', 1));
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await inspectLoopbackListener(port);
    if (snapshot.listeners.length === 0) return;
    await sleep(150);
  }
  throw new NativeIsolationError(`CDP listener remained open after app shutdown: ${port}`);
}

async function terminateOwnedProcess(state) {
  const cleanup = { attempted: true, pid: state.child.pid ?? null, taskkill: null };
  if (state.child.exitCode != null || state.child.signalCode != null) return cleanup;
  if (state.child.pid == null) {
    cleanup.killError = "launcher child has no PID";
    return cleanup;
  }
  cleanup.taskkill = await runCaptured(
    "taskkill.exe",
    ["/PID", String(state.child.pid), "/T", "/F"],
    { cwd: repositoryRoot },
  );
  cleanup.exited = await waitForExit(state, 10000).catch((error) => ({
    exitCode: state.child.exitCode,
    signal: state.child.signalCode,
    error: error.message,
  }));
  return cleanup;
}

async function waitForExit(state, timeoutMs) {
  if (state.exitResult) return state.exitResult;
  let timer;
  try {
    return await Promise.race([
      state.exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`process exit timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finishLogStream(stream) {
  if (!stream || stream.closed) return;
  await new Promise((resolve) => stream.end(resolve));
}

async function writeLaunchConfig(configPath, baseConfig, identifier, vitePort, targetNonce, serverAlreadyRunning = false) {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.identifier = identifier;
  config.build = {
    ...config.build,
    devUrl: `http://127.0.0.1:${vitePort}/?lightmarkQa=${encodeURIComponent(targetNonce)}`,
    beforeDevCommand: serverAlreadyRunning ? null : {
      script: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${vitePort} --strictPort`,
      cwd: repositoryRoot,
      wait: false,
    },
  };
  if (Array.isArray(config.app?.windows)) {
    config.app.windows = config.app.windows.map((window, index) => (
      index === 0 ? { ...window, title: `LightMark QA ${targetNonce}` } : window
    ));
  }
  await writeJson(configPath, config);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  static async connect(url) {
    if (!url.startsWith("ws://127.0.0.1:")) {
      throw new NativeIsolationError(`Refusing a non-loopback CDP WebSocket URL: ${url}`);
    }
    const client = new CdpClient(url);
    try {
      await client.connect();
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }

  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (message.method) this.events.push({ method: message.method, params: message.params || null });
        if (this.events.length > 240) this.events.splice(0, this.events.length - 240);
        return;
      }
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timeout")), 10000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket connection failed: ${event.message || "unknown error"}`));
      }, { once: true });
    });
  }

  async call(method, params = {}, timeoutMs = 15000) {
    if (this.closed || !this.socket) throw new Error("CDP client is closed");
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return await result;
  }

  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result?.result?.value;
  }

  async close() {
    const socket = this.socket;
    if (!socket || socket.readyState === 3) {
      this.closed = true;
      const error = new Error("CDP client closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      return;
    }
    await new Promise((resolve) => {
      let timer = setTimeout(resolve, 1000);
      const finish = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve();
      };
      socket.addEventListener("close", finish, { once: true });
      try {
        socket.close();
      } catch {
        finish();
      }
    });
    this.closed = true;
    const error = new Error("CDP client closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function readProbeProgress(client) {
  try {
    return await client.evaluate("globalThis.__LIGHTMARK_QA_PROGRESS || null", 3000);
  } catch (error) {
    return { readError: serializeError(error) };
  }
}

function assertWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new NativeIsolationError(`Path escapes the evidence run directory: ${child}`);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative)
    && relative !== "."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function assertPathsAbsent(paths, phase) {
  const present = [];
  for (const target of paths) if (await pathExists(target)) present.push(target);
  if (present.length > 0) throw new NativeIsolationError(`Isolation paths already exist ${phase}: ${present.join(", ")}`);
}

async function assertPathsPresent(paths, phase) {
  const missing = [];
  for (const target of paths) if (!(await pathExists(target))) missing.push(target);
  if (missing.length > 0) throw new NativeIsolationError(`Expected isolation paths are missing ${phase}: ${missing.join(", ")}`);
}

async function archiveIsolatedState(context) {
  const sourcePath = path.join(context.expectedAppConfigDir, "config.json");
  const archivedPath = path.join(context.runDir, "output", "isolated-config.json");
  const content = await readFile(sourcePath);
  await writeFile(archivedPath, content);
  assertWithin(context.runDir, archivedPath);
  return {
    sourcePath,
    archivedPath,
    content: describeBytes(content),
    retainedIsolationPaths: uniquePaths([
      context.expectedAppConfigDir,
      context.expectedAppDataDir,
      context.expectedAppLocalDataDir,
    ]),
  };
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((target) => {
    const key = path.resolve(target).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertBytesEqual(actual, expected, label) {
  if (Buffer.compare(actual, expected) !== 0) {
    throw new NativeIsolationError(
      `${label} bytes differ: expected ${expected.length}, actual ${actual.length}`,
    );
  }
}

function describeBytes(value) {
  return {
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack || null : null,
  };
}

async function persistManifest(context) {
  await writeJson(path.join(context.runDir, "manifest.json"), context.manifest);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
