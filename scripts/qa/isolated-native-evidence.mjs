import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
const supportedScenarios = new Set(["smoke", "html-security", "math-receipt"]);
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
  const cdpPort = await findFreePort();
  if (vitePort === cdpPort) throw new NativeIsolationError("Vite and CDP ports unexpectedly matched.");
  const targetNonce = `${context.runToken}-${name}-${randomUUID().slice(0, 8)}`;
  await writeLaunchConfig(context.configPath, context.baseConfig, context.identifier, vitePort, targetNonce);

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
    phase.status = "passed";
    phase.endedAt = new Date().toISOString();
    await persistManifest(context);
    return phase;
  } catch (error) {
    phase.status = "failed";
    phase.error = serializeError(error);
    phase.probeProgress = client ? await readProbeProgress(client) : null;
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

function createMathCurrentEditorPrelude() {
  return `
    const currentEditor = () => {
      const tab = store.getPaneTab('main');
      if (!tab) return null;
      let roots;
      if (store.appStore.splitLayout.enabled) {
        if (store.appStore.splitLayout.activePaneId !== 'main') return null;
        const activePanes = [...document.querySelectorAll('.lm-editor-pane.active')];
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
  `;
}

async function runMathSaveProbe(client, context) {
  const fixturePath = JSON.stringify(context.fixturePath);
  const expected = JSON.stringify(context.scenarioEvidence.expectedSavedContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  const result = await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expected = ${expected};
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
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
    session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', 15000);
    setProgress('math-save:after-wait-session');
    const waitFor = async (label, predicate, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
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
    let capturedReceipt = null;
    const originalFlush = session.flushPendingEdits?.bind(session);
    if (!originalFlush) throw new Error('WYSIWYG session has no production flushPendingEdits adapter');
    session.flushPendingEdits = async (...args) => {
      const receipt = await originalFlush(...args);
      capturedReceipt = receipt || null;
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
    if (!beforeSave || !after || !capturedReceipt) throw new Error('production Math save did not expose a flush receipt');
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
  })()`, 60000);
  return { ...result, expectedBytes: Buffer.byteLength(context.scenarioEvidence.expectedSavedContent, "utf8") };
}

async function runMathWindowDraftProbe(client, context) {
  const expectedDraft = JSON.stringify(context.scenarioEvidence.expectedDraftContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  return await client.evaluate(`(async () => {
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
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
    session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', 15000);
    setProgress('math-window-draft:after-wait-session');
    const waitFor = async (label, predicate, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
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
        capturedReceipts.push(receipt);
      }
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
    const pendingFlushProof = Boolean(capturedReceipts.some((receipt) =>
      receipt.before?.pendingInputVersion === beforeClose.token?.pendingInputVersion
      && receipt.after?.pendingInputVersion === beforeClose.token?.pendingInputVersion
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
      receipts: capturedReceipts.map((receipt) => ({
        flushId: receipt.flushId,
        before: receipt.before,
        after: receipt.after,
        authorizedMutationCount: receipt.authorizedMutationCount,
      })),
      pendingFlushProof,
      events,
      note: pendingFlushProof
        ? 'the close path produced a receipt whose continuous input token matches the prompt version'
        : 'dialog focus/blur or another close step changed the Math buffer; this run records the events but does not count them as pending-flush proof',
      runtimePaths,
    };
  })()`, 60000);
}

async function runMathRecoveryProbe(client, context) {
  const expectedDraft = JSON.stringify(context.scenarioEvidence.expectedDraftContent);
  const runtimePathCheck = createRuntimePathCheck(context);
  return await client.evaluate(`(async () => {
    ${runtimePathCheck}
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
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
    const waitFor = async (label, predicate, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
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
    const session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', 15000);
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
  })()`, 60000);
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
      const container = document.querySelector('.large-doc-scroll');
      const hosts = container ? Array.from(container.querySelectorAll('.large-doc-render')) : [];
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

async function writeLaunchConfig(configPath, baseConfig, identifier, vitePort, targetNonce) {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.identifier = identifier;
  config.build = {
    ...config.build,
    devUrl: `http://127.0.0.1:${vitePort}/?lightmarkQa=${encodeURIComponent(targetNonce)}`,
    beforeDevCommand: {
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
      if (!pending) return;
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

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
