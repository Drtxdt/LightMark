import { createWriteStream, appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  lstat,
  readdir,
  copyFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createPerformanceFixtures,
  PERFORMANCE_FIXTURE_IDS,
  MIN_INTERACTIVE_ROUNDS,
  MIN_OPERATIONS_PER_ROUND,
} from "./performance-fixtures.mjs";
import {
  buildPerformanceReport,
  collectMachineMetadata,
  hashFile,
  writePerformanceResult,
} from "./performance-report.mjs";
import { checkPerformanceArtifacts } from "./check-performance-build.mjs";
import {
  captureRepositoryEvidence,
  repositoryRoot,
  runCaptured,
  writeJson,
} from "./evidence.mjs";

const EXPECTED_ORIGIN = "http://tauri.localhost";
const BRIDGE_SCHEMA_VERSION = 1;
const PROBE_MODE = "release-qa-bridge";
const DEFAULT_LARGE_DOCUMENT_BYTES = 6 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const STARTUP_SAMPLE_COUNT = 10;
const INTERACTIVE_ROUNDS = MIN_INTERACTIVE_ROUNDS;
const OPERATIONS_PER_ROUND = MIN_OPERATIONS_PER_ROUND;
const FIXED_INPUT_TEXT = " QA🙂";
const FORBIDDEN_WEBVIEW_ENVIRONMENT = [
  "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
  "WEBVIEW2_USER_DATA_FOLDER",
  "WEBVIEW2_USER_DATA_DIR",
  "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
  "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
];
const BRIDGE_METHODS = new Set([
  "ready",
  "supports",
  "open",
  "mode",
  "reset",
  "prepareOperation",
  "completeOperation",
  "verify",
  "memory",
  "shutdown",
]);
const MODES = new Set(["source", "wysiwyg"]);
const LOCATIONS = new Set(["head", "middle", "tail"]);
const OPERATIONS = new Set(["insert-text", "insert-newline", "multi-range-edit", "delete-backward", "paste-text", "formula-commit", "scroll"]);
const FIXTURE_PLAN = Object.freeze([
  { fixtureId: "normal-writing", mode: "source", operation: "insert-text", location: "middle" },
  { fixtureId: "large-document", mode: "source", operation: "scroll", location: "middle" },
  { fixtureId: "formula-dense", mode: "wysiwyg", operation: "insert-text", location: "middle" },
  { fixtureId: "formula-dense", mode: "wysiwyg", operation: "formula-commit", location: "head" },
  { fixtureId: "table-dense", mode: "wysiwyg", operation: "insert-text", location: "middle" },
  { fixtureId: "image-dense", mode: "wysiwyg", operation: "scroll", location: "middle" },
  { fixtureId: "long-lines", mode: "source", operation: "insert-text", location: "middle" },
  ...["source", "wysiwyg"].flatMap(mode => [
    { fixtureId: mode === "source" ? "source-50000-lines" : "wys-50000-paragraphs", mode, operation: "insert-newline", location: "head" },
    { fixtureId: mode === "source" ? "source-50000-lines" : "wys-50000-paragraphs", mode, operation: "delete-backward", location: "head" },
    { fixtureId: mode === "source" ? "source-50000-lines" : "wys-50000-paragraphs", mode, operation: "multi-range-edit", location: "head" },
  ]),
]);

function operationMethod(operation) {
  if (operation === "multi-range-edit") return "qa-owned-editor.transaction";
  if (operation === "scroll") return "owned-editor.scrollTop";
  if (operation === "insert-newline" || operation === "delete-backward" || operation === "formula-commit") return "cdp.Input.dispatchKeyEvent";
  return "cdp.Input.insertText";
}

export class PerformanceLauncherError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "PerformanceLauncherError";
    this.details = details;
  }
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizePath(value) {
  return path.resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertWithin(parent, candidate, label = "path") {
  if (!isWithin(parent, candidate)) throw new PerformanceLauncherError(`${label} escapes the owned root: ${candidate}`);
  return candidate;
}

async function assertNoSymlinks(root) {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new PerformanceLauncherError(`Owned root is a symlink: ${root}`);
  if (!rootStat.isDirectory()) throw new PerformanceLauncherError(`Owned root is not a directory: ${root}`);
  async function visit(current) {
    for (const name of await readdir(current)) {
      const child = path.join(current, name);
      let childStat;
      try { childStat = await lstat(child); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (childStat.isSymbolicLink()) throw new PerformanceLauncherError(`Owned fixture tree contains a symlink: ${child}`);
      if (childStat.isDirectory()) {
        try { await visit(child); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
  }
  await visit(root);
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertOwnedRealpath(root, candidate, label = "fixture") {
  const rootReal = await realpath(root);
  const candidateLexical = assertWithin(rootReal, candidate, label);
  const candidateReal = await realpath(candidateLexical);
  if (!isWithin(rootReal, candidateReal) || normalizePath(candidateReal) === normalizePath(rootReal)) {
    throw new PerformanceLauncherError(`${label} realpath escapes the owned root: ${candidate}`);
  }
  return candidateReal;
}

function safeToken(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

async function hostRuntimeRoots() {
  const script = [
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
  ].join("; ");
  const result = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: repositoryRoot });
  if (result.exitCode !== 0) {
    throw new PerformanceLauncherError(`Cannot resolve Windows known-folder roots: ${result.stderr || result.error || result.exitCode}`);
  }
  const [roaming, local] = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!roaming || !local || !path.isAbsolute(roaming) || !path.isAbsolute(local)) {
    throw new PerformanceLauncherError(`Windows known-folder API returned invalid roots: ${JSON.stringify(result.stdout)}`);
  }
  return {
    roaming: path.resolve(roaming),
    local: path.resolve(local),
    source: "PowerShell Environment.GetFolderPath(ApplicationData/LocalApplicationData)",
  };
}

function expectedRuntimePathsForHost(identifier, roots) {
  return {
    config: path.join(roots.roaming, identifier),
    data: path.join(roots.roaming, identifier),
    local: path.join(roots.local, identifier),
  };
}

async function createRunDirectory(requestedOutput) {
  const parent = requestedOutput ? path.resolve(requestedOutput) : os.tmpdir();
  await mkdir(parent, { recursive: true });
  return await mkdtemp(path.join(parent, "lightmark-performance-release-"));
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new PerformanceLauncherError(`${name} requires a value.`);
  return value;
}

function positiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PerformanceLauncherError(`${label} must be a positive integer.`);
  return parsed;
}

export function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }
  const valueFlags = new Set([
    "--output",
    "--executable",
    "--normal-dist",
    "--qa-dist",
    "--expected-origin",
    "--large-document-bytes",
    "--rounds",
    "--operations",
    "--startup-samples",
  ]);
  const booleanFlags = new Set(["--smoke", "--formula-stress", "--launch", "--build-qa"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new PerformanceLauncherError(`Unexpected launcher argument: ${argument}`);
    if (!valueFlags.has(argument) && !booleanFlags.has(argument)) {
      throw new PerformanceLauncherError(`Unknown launcher argument: ${argument}`);
    }
    if (valueFlags.has(argument)) index += 1;
  }
  const output = argumentValue(args, "--output");
  const executable = argumentValue(args, "--executable");
  const normalDist = argumentValue(args, "--normal-dist");
  const qaDist = argumentValue(args, "--qa-dist");
  const expectedOrigin = argumentValue(args, "--expected-origin") || EXPECTED_ORIGIN;
  const largeDocumentBytes = positiveInteger(argumentValue(args, "--large-document-bytes"), DEFAULT_LARGE_DOCUMENT_BYTES, "--large-document-bytes");
  const rounds = positiveInteger(argumentValue(args, "--rounds"), INTERACTIVE_ROUNDS, "--rounds");
  const operations = positiveInteger(argumentValue(args, "--operations"), OPERATIONS_PER_ROUND, "--operations");
  const startupSamples = positiveInteger(argumentValue(args, "--startup-samples"), STARTUP_SAMPLE_COUNT, "--startup-samples");
  const smoke = args.includes("--smoke");
  const formulaStress = args.includes("--formula-stress");
  if (formulaStress && smoke) throw new PerformanceLauncherError("--formula-stress runs 3×100 diagnostic operations and cannot be combined with --smoke.");
  if (formulaStress && (rounds !== INTERACTIVE_ROUNDS || operations !== OPERATIONS_PER_ROUND)) throw new PerformanceLauncherError("--formula-stress requires the unchanged 3×100 workload.");
  const launch = args.includes("--launch");
  const buildQa = args.includes("--build-qa");
  if (executable) {
    throw new PerformanceLauncherError("External --executable is disabled; launch only accepts the executable produced by this run's --build-qa.");
  }
  if (smoke) {
    return {
      output,
      executable,
      normalDist,
      qaDist,
      expectedOrigin,
      largeDocumentBytes,
      rounds: 1,
      operations: 1,
      startupSamples: 1,
      smoke,
      launch,
      buildQa,
    };
  }
  return {
    output,
    executable,
    normalDist,
    qaDist,
    expectedOrigin,
    largeDocumentBytes,
    rounds,
    operations,
    startupSamples,
    smoke,
    formulaStress,
    launch,
    buildQa,
  };
}

function assertExpectedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new PerformanceLauncherError(`Invalid expected release origin: ${String(error)}`);
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "tauri.localhost" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new PerformanceLauncherError("The performance launcher only accepts the fixed tauri.localhost release origin.");
  }
  return parsed.origin;
}

function assertInheritedEnvironmentClean() {
  const inherited = FORBIDDEN_WEBVIEW_ENVIRONMENT.filter((name) => Object.hasOwn(process.env, name));
  if (inherited.length > 0) {
    throw new PerformanceLauncherError(`Refusing inherited WebView2 overrides: ${inherited.join(", ")}`);
  }
}

function hashWorkspaceEvidence(evidence) {
  const manifest = evidence.workspace?.files?.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })) || [];
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function resolveOwnedExecutable(root, value) {
  if (!value) return null;
  const lexical = path.resolve(value);
  assertWithin(root, lexical, "QA executable");
  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new PerformanceLauncherError(`QA executable is a symlink: ${lexical}`);
  if (!info.isFile()) throw new PerformanceLauncherError(`Performance executable is not a file: ${lexical}`);
  const resolved = await realpath(lexical);
  if (!isWithin(root, resolved)) throw new PerformanceLauncherError(`QA executable realpath escapes the owned root: ${resolved}`);
  if (!resolved.toLowerCase().endsWith(".exe")) throw new PerformanceLauncherError(`Performance executable must be a Windows .exe: ${resolved}`);
  return resolved;
}

async function resolveOptionalDirectory(value, label) {
  if (!value) return null;
  const resolved = path.resolve(value);
  const info = await lstat(resolved);
  if (!info.isDirectory()) throw new PerformanceLauncherError(`${label} is not a directory: ${resolved}`);
  await assertNoSymlinks(resolved);
  return await realpath(resolved);
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null,
    details: error?.details || null,
  };
}

async function prepareContext(options) {
  const expectedOrigin = assertExpectedOrigin(options.expectedOrigin);
  const runDir = await createRunDirectory(options.output);
  const dirs = {
    run: runDir,
    config: path.join(runDir, "config"),
    fixtures: path.join(runDir, "fixtures"),
    output: path.join(runDir, "output"),
    logs: path.join(runDir, "logs"),
    profiles: path.join(runDir, "profiles"),
    builds: path.join(runDir, "builds"),
  };
  await Promise.all(Object.values(dirs).map((directory) => mkdir(directory, { recursive: true })));
  await assertNoSymlinks(runDir);

  const runToken = safeToken("perf");
  const identifier = `com.lightmark.qa.${runToken.replace(/[^a-z0-9]/giu, "").toLowerCase()}`;
  const nonce = `${runToken}-${randomUUID()}`;
  const profileToken = safeToken("profile");
  const processToken = safeToken("process");
  const runtimeRoots = await hostRuntimeRoots();
  const expectedRuntimePaths = expectedRuntimePathsForHost(identifier, runtimeRoots);
  const runtimePathEntries = await Promise.all(
    Object.entries(expectedRuntimePaths).map(async ([key, candidate]) => [key, await pathExists(candidate)]),
  );
  const preexistingRuntimePaths = Object.fromEntries(runtimePathEntries);
  if (Object.values(preexistingRuntimePaths).some(Boolean)) {
    throw new PerformanceLauncherError(
      `Unique Tauri application-data path was already present before this run: ${JSON.stringify(preexistingRuntimePaths)}`,
    );
  }
  const fixtureSet = await createPerformanceFixtures(dirs.fixtures, {
    largeDocumentBytes: options.largeDocumentBytes,
    includeThresholdFixtures: true,
  });
  await assertNoSymlinks(fixtureSet.root);
  const fixtureRoot = await realpath(fixtureSet.root);
  const catalog = {};
  for (const fixture of fixtureSet.manifest.fixtures) {
    const fixturePath = await assertOwnedRealpath(fixtureRoot, path.join(fixtureRoot, fixture.relativePath), fixture.id);
    catalog[fixture.id] = { ...fixture, path: fixturePath };
  }
  if (Object.keys(catalog).length !== PERFORMANCE_FIXTURE_IDS.length
    || PERFORMANCE_FIXTURE_IDS.some((fixtureId) => !catalog[fixtureId])) {
    throw new PerformanceLauncherError("The owned fixture catalog does not contain exactly the required loads.");
  }
  for (const asset of fixtureSet.manifest.assets) {
    await assertOwnedRealpath(fixtureRoot, path.join(fixtureRoot, asset.relativePath), `asset ${asset.id}`);
  }
  for (const threshold of fixtureSet.manifest.thresholds) {
    await assertOwnedRealpath(fixtureRoot, path.join(fixtureRoot, threshold.relativePath), threshold.id);
  }
  const manifestBytes = await readFile(fixtureSet.manifestPath);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  const bridgeConfig = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    nonce,
    expectedOrigin,
    fixtureRoot,
    profileToken,
    processToken,
    probeMode: PROBE_MODE,
    fixtures: catalog,
  };
  const bridgeConfigPath = path.join(dirs.config, "performance-bridge.json");
  await writeJson(bridgeConfigPath, bridgeConfig);
  const repository = await captureRepositoryEvidence(repositoryRoot, runDir);
  const context = {
    options,
    runDir,
    dirs,
    runToken,
    identifier,
    nonce,
    profileToken,
    processToken,
    expectedOrigin,
    runtimeRoots,
    expectedRuntimePaths,
    preexistingRuntimePaths,
    bridgeConfig,
    bridgeConfigPath,
    fixtureSet,
    fixtureRoot,
    manifestHash,
    repository,
    executable: null,
    artifactCheck: null,
    buildId: `prepared-${runToken}`,
    samples: [],
    correctnessChecks: [],
    events: [],
    processOwnership: [],
    runtimePathChecks: [],
    bridgeReady: null,
    machine: null,
    failure: null,
  };
  await writeJson(path.join(runDir, "launcher-manifest.json"), {
    schemaVersion: 1,
    kind: "lightmark-release-performance",
    status: "prepared",
    createdAt: new Date().toISOString(),
    runDir,
    identifier,
    nonce,
    expectedOrigin,
    fixtureRoot,
    fixtureManifest: {
      path: path.relative(runDir, fixtureSet.manifestPath).replaceAll("\\", "/"),
      sha256: manifestHash,
      schemaVersion: fixtureSet.manifest.schemaVersion,
    },
    bridgeConfig: path.relative(runDir, bridgeConfigPath).replaceAll("\\", "/"),
    buildId: context.buildId,
    options,
    repository,
    isolation: {
      ownedRunDirectory: true,
      profileRoot: path.relative(runDir, dirs.profiles).replaceAll("\\", "/"),
      processOwnership: "not-launched",
      cdpBinding: "not-launched",
      runtimePaths: {
        source: runtimeRoots.source,
        roots: runtimeRoots,
        expected: expectedRuntimePaths,
        preexistingAtRunStart: preexistingRuntimePaths,
        sharedAcrossWebviewProfiles: true,
        startupSemantics: "cold/warm labels apply only to the WebView2 profile; Tauri config/data roots are shared by identifier",
      },
    },
  });
  return context;
}

async function writeQaTauriConfig(context, qaDist) {
  const basePath = path.join(repositoryRoot, "src-tauri", "tauri.conf.json");
  const base = JSON.parse(await readFile(basePath, "utf8"));
  const configPath = path.join(context.dirs.config, "tauri.performance.qa.json");
  const config = {
    ...base,
    identifier: context.identifier,
    build: {
      ...base.build,
      // Build Vite with spawn argv below. Passing quoted paths through the
      // Tauri Windows command parser preserved literal quotes in argv.
      beforeBuildCommand: null,
      frontendDist: path.relative(path.join(repositoryRoot, "src-tauri"), qaDist).replaceAll("\\", "/"),
    },
    bundle: { ...base.bundle, active: false },
  };
  if (Array.isArray(config.app?.windows)) {
    config.app.windows = config.app.windows.map((window, index) => (
      index === 0 ? { ...window, title: `LightMark performance QA ${context.runToken}` } : window
    ));
  }
  await writeJson(configPath, config);
  return configPath;
}

function spawnLogged(command, args, { cwd = repositoryRoot, env = process.env, stdoutPath, stderrPath } = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createWriteStream(stdoutPath, { encoding: "utf8" });
  const stderr = createWriteStream(stderrPath, { encoding: "utf8" });
  const state = {
    child,
    stdout,
    stderr,
    stdoutTail: "",
    stderrTail: "",
    exitResult: null,
  };
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stdout.write(text);
    state.stdoutTail = `${state.stdoutTail}${text}`.slice(-12_000);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr.write(text);
    state.stderrTail = `${state.stderrTail}${text}`.slice(-12_000);
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

async function finishLogStream(stream) {
  if (!stream || stream.closed) return;
  await new Promise((resolve) => stream.end(resolve));
}

async function waitForExit(state, timeoutMs = 30_000) {
  if (state.exitResult) return state.exitResult;
  let timer;
  try {
    return await Promise.race([
      state.exitPromise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`process exit timeout after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function allocatePort() {
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
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
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

function isExpectedTarget(target, expectedOrigin, port) {
  if (!target || target.type !== "page" || typeof target.url !== "string" || typeof target.webSocketDebuggerUrl !== "string") return false;
  try {
    const url = new URL(target.url);
    return url.origin === expectedOrigin
      && ["/", "/index.html"].includes(url.pathname)
      && target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`);
  } catch {
    return false;
  }
}

function isBlankTarget(target) {
  return target?.url == null || target.url === "" || target.url === "about:blank";
}

async function waitForCdpTarget(state, port, expectedOrigin, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (state.exitResult) throw new PerformanceLauncherError(`Owned release process exited before CDP target: ${JSON.stringify(state.exitResult)}`);
    try {
      const [version, pages] = await Promise.all([
        fetchJson(`http://127.0.0.1:${port}/json/version`),
        fetchJson(`http://127.0.0.1:${port}/json/list`),
      ]);
      const pageTargets = Array.isArray(pages) ? pages.filter((page) => page?.type === "page") : [];
      const nonBlank = pageTargets.filter((page) => !isBlankTarget(page));
      const unexpected = nonBlank.filter((page) => !isExpectedTarget(page, expectedOrigin, port));
      if (unexpected.length > 0) {
        throw new PerformanceLauncherError(`Refusing unexpected CDP page target: ${JSON.stringify(unexpected.map(summarizeTarget))}`);
      }
      const matching = nonBlank.filter((page) => isExpectedTarget(page, expectedOrigin, port));
      if (matching.length === 1) return { version, pages: pages.map(summarizeTarget), target: matching[0] };
    } catch (error) {
      if (error instanceof PerformanceLauncherError) throw error;
      lastError = error;
    }
    await sleep(150);
  }
  throw new PerformanceLauncherError(`Timed out waiting for the owned release CDP target: ${String(lastError || "no target")}`);
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
      state: fields[3].toUpperCase(),
      pid: Number(fields[4]),
    });
  }
  return rows;
}

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function inspectProcessTree(rootPid) {
  const script = [
    `$target = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(rootPid)}';`,
    "$chain = @();",
    "$seen = @{};",
    "for ($depth = 0; $target -and $depth -lt 32; $depth++) {",
    "if ($seen.ContainsKey([int]$target.ProcessId)) { throw 'process parent cycle detected' };",
    "$seen[[int]$target.ProcessId] = $true;",
    "$chain += [pscustomobject]@{ ProcessId = [int]$target.ProcessId; ParentProcessId = [int]$target.ParentProcessId; Name = [string]$target.Name; CommandLine = [string]$target.CommandLine; ExecutablePath = [string]$target.ExecutablePath };",
    "if ([int]$target.ParentProcessId -eq 0) { break };",
    "$target = Get-CimInstance Win32_Process -Filter \"ProcessId = $($target.ParentProcessId)\";",
    "}",
    "$chain | ConvertTo-Json -Compress",
  ].join(" ");
  const result = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: repositoryRoot });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new PerformanceLauncherError(`Unable to inspect owned process tree: ${result.stderr || result.error || result.exitCode}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new PerformanceLauncherError(`Unable to parse owned process tree: ${String(error)}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function ownedProcessMemory(rootPid) {
  // Sampling is outside operation intervals and restricted to the process
  // created by this run and descendants; unrelated WebViews are excluded.
  const script = [
    `$rootPidForQa = ${Number(rootPid)};`,
    "$rowsForQa = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId);",
    "$idsForQa = [System.Collections.Generic.HashSet[int]]::new(); [void]$idsForQa.Add($rootPidForQa);",
    "do { $changedForQa = $false; foreach ($rowForQa in $rowsForQa) { if ($idsForQa.Contains([int]$rowForQa.ParentProcessId) -and $idsForQa.Add([int]$rowForQa.ProcessId)) { $changedForQa = $true } } } while ($changedForQa);",
    "$memoryForQa = @(foreach ($idForQa in $idsForQa) { $processForQa = Get-Process -Id $idForQa -ErrorAction SilentlyContinue; if ($processForQa) { [pscustomobject]@{ pid = $idForQa; workingSetBytes = [long]$processForQa.WorkingSet64; privateBytes = [long]$processForQa.PrivateMemorySize64 } } });",
    "$memoryForQa | ConvertTo-Json -Compress",
  ].join(" ");
  const result = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: repositoryRoot });
  if (result.exitCode !== 0) return { status: "unobserved", reason: result.stderr || result.error || String(result.exitCode) };
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    if (!processes.some(process => process.pid === Number(rootPid))) return { status: "unobserved", reason: "owned root exited" };
    return { status: "observed", rootPid, processes, workingSetBytes: processes.reduce((sum, process) => sum + process.workingSetBytes, 0), privateBytes: processes.reduce((sum, process) => sum + process.privateBytes, 0), note: "working sets may share pages; private bytes are separate from JS heap" };
  } catch (error) { return { status: "unobserved", reason: String(error) }; }
}

function extractUserDataDir(commandLine) {
  const match = String(commandLine).match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/iu);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

async function inspectOwnedListener(port, state, profilePath, executablePath) {
  const result = await runCaptured("netstat.exe", ["-ano", "-p", "tcp"], { cwd: repositoryRoot });
  if (result.exitCode !== 0) throw new PerformanceLauncherError(`netstat failed: ${result.stderr || result.error || result.exitCode}`);
  const listeners = parseNetstat(result.stdout).filter((row) => row.localPort === port && row.state === "LISTENING");
  if (listeners.length !== 1) return { port, listeners, verified: false };
  const listener = listeners[0];
  if (listener.localAddress !== "127.0.0.1") throw new PerformanceLauncherError(`CDP listener is not loopback-only: ${JSON.stringify(listener)}`);
  const chain = await inspectProcessTree(listener.pid);
  const root = chain.find((entry) => Number(entry.ProcessId) === Number(state.child.pid));
  const webview = chain[0];
  if (!root) throw new PerformanceLauncherError(`CDP listener PID ${listener.pid} is outside owned process ${state.child.pid}`);
  if (!String(webview?.Name || "").toLowerCase().includes("msedgewebview2")) {
    throw new PerformanceLauncherError(`CDP listener is not WebView2: ${JSON.stringify(webview)}`);
  }
  const actualProfile = extractUserDataDir(webview.CommandLine);
  const allowedProfiles = [profilePath, path.join(profilePath, "EBWebView")].map(normalizePath);
  if (!actualProfile || !allowedProfiles.includes(normalizePath(actualProfile))) {
    throw new PerformanceLauncherError(`WebView2 profile mismatch: expected ${profilePath}, got ${actualProfile || "missing"}`);
  }
  if (root.ExecutablePath && normalizePath(root.ExecutablePath) !== normalizePath(executablePath)) {
    throw new PerformanceLauncherError(`Release process executable mismatch: expected ${executablePath}, got ${root.ExecutablePath}`);
  }
  return { port, listeners, listener, chain, verified: true, profilePath, actualProfile, executablePath };
}

async function waitForOwnedListener(port, state, profilePath, executablePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspectOwnedListener(port, state, profilePath, executablePath);
    if (last.verified) return last;
    await sleep(150);
  }
  throw new PerformanceLauncherError(`Timed out waiting for an owned loopback CDP listener: ${JSON.stringify(last)}`);
}

async function waitForPortClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      return true;
    }
    await sleep(150);
  }
  throw new PerformanceLauncherError(`Owned CDP listener remained open: ${port}`);
}

async function runBuildCommand(context, configPath, qaDist) {
  const target = process.env.LIGHTMARK_PERF_CARGO_CACHE ? path.resolve(process.env.LIGHTMARK_PERF_CARGO_CACHE) : path.join(context.dirs.builds, "target");
  assertWithin(path.resolve(context.options.output), target, "QA compiler cache");
  await mkdir(target, { recursive: true });
  await assertNoSymlinks(target);
  const env = {
    ...process.env,
    VITE_LIGHTMARK_PERF_QA: "1",
    VITE_LIGHTMARK_PERF_CONFIG_JSON: JSON.stringify(context.bridgeConfig),
    CARGO_TARGET_DIR: target,
  };
  const stdoutPath = path.join(context.dirs.logs, "qa-build.stdout.log");
  const stderrPath = path.join(context.dirs.logs, "qa-build.stderr.log");
  const frontendState = spawnLogged(process.execPath, [path.join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", qaDist], {
    cwd: repositoryRoot, env,
    stdoutPath: path.join(context.dirs.logs, "qa-frontend.stdout.log"),
    stderrPath: path.join(context.dirs.logs, "qa-frontend.stderr.log"),
  });
  const frontendResult = await waitForExit(frontendState, 5 * 60_000);
  await Promise.all([finishLogStream(frontendState.stdout), finishLogStream(frontendState.stderr)]);
  if (frontendResult.exitCode !== 0) throw new PerformanceLauncherError("QA frontend build failed", { result: frontendResult, stderrTail: frontendState.stderrTail });
  const require = createRequire(import.meta.url);
  const cliPackagePath = require.resolve("@tauri-apps/cli/package.json", { paths: [repositoryRoot] });
  const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
  const cliBin = typeof cliPackage.bin === "string" ? cliPackage.bin : cliPackage.bin?.tauri;
  if (!cliBin) throw new PerformanceLauncherError("Installed Tauri CLI has no executable entry.");
  const cliEntry = path.resolve(path.dirname(cliPackagePath), cliBin);
  assertWithin(repositoryRoot, cliEntry, "Tauri CLI entry");
  const state = spawnLogged(process.execPath, [cliEntry, "build", "--no-bundle", "--config", configPath], {
    cwd: repositoryRoot,
    env,
    stdoutPath,
    stderrPath,
  });
  const result = await waitForExit(state, 20 * 60_000);
  await Promise.all([finishLogStream(state.stdout), finishLogStream(state.stderr)]);
  if (result.exitCode !== 0) {
    throw new PerformanceLauncherError(`QA release build failed: ${JSON.stringify(result)}`, {
      stdoutTail: state.stdoutTail,
      stderrTail: state.stderrTail,
    });
  }
  const ownedExecutable = path.join(context.dirs.builds, "target", "release", "lightmark.exe");
  const compiledExecutable = path.join(target, "release", "lightmark.exe");
  if (normalizePath(ownedExecutable) !== normalizePath(compiledExecutable)) {
    await mkdir(path.dirname(ownedExecutable), { recursive: true });
    await copyFile(compiledExecutable, ownedExecutable);
  }
  await assertNoSymlinks(qaDist);
  return { result, stdoutPath, stderrPath, cliEntry, cliVersion: cliPackage.version || null };
}

async function prepareBuildAndArtifacts(context) {
  const { options } = context;
  let qaDist = null;
  if (options.qaDist) {
    const requestedQaDist = path.resolve(options.qaDist);
    if (options.buildQa) assertWithin(context.runDir, requestedQaDist, "qaDist");
    try {
      qaDist = await resolveOptionalDirectory(requestedQaDist, "qaDist");
    } catch (error) {
      if (!options.buildQa || error?.code !== "ENOENT") throw error;
      await mkdir(requestedQaDist, { recursive: true });
      await assertNoSymlinks(requestedQaDist);
      qaDist = await realpath(requestedQaDist);
    }
  } else if (options.buildQa) {
    qaDist = path.join(context.dirs.builds, "qa-dist");
  }
  if (options.buildQa) {
    if (!qaDist) throw new PerformanceLauncherError("QA build requires an owned qaDist.");
    await mkdir(qaDist, { recursive: true });
    await assertWithin(context.runDir, qaDist, "qaDist");
    const configPath = await writeQaTauriConfig(context, qaDist);
    context.qaBuildConfigPath = configPath;
    await runBuildCommand(context, configPath, qaDist);
    await assertNoSymlinks(context.dirs.builds);
  }
  context.executable = await resolveOwnedExecutable(
    context.runDir,
    options.buildQa ? path.join(context.dirs.builds, "target", "release", "lightmark.exe") : null,
  );
  if (options.launch && !options.normalDist) throw new PerformanceLauncherError("--launch requires --normal-dist so the normal artifact bridge-absence check runs first.");
  if (options.launch && !options.buildQa) throw new PerformanceLauncherError("--launch requires --build-qa; an external executable cannot be attached.");
  if (qaDist && options.normalDist) {
    context.artifactCheck = await checkPerformanceArtifacts({ normalDist: options.normalDist, qaDist });
    if (options.launch && !context.artifactCheck.passed) {
      throw new PerformanceLauncherError("Normal/QA artifact gate failed before native launch.", context.artifactCheck);
    }
  }
  const executableHash = context.executable ? await hashFile(context.executable) : null;
  const frontendSha = context.artifactCheck?.qa?.sha256 || null;
  const sourceIdentity = context.repository.head || context.runToken;
  context.buildId = `release-${sourceIdentity.slice(0, 12)}-${(executableHash?.sha256 || context.manifestHash).slice(0, 16)}`;
  context.build = {
    environment: "release",
    measurementKind: "release-pre-sampled",
    buildId: context.buildId,
    head: context.repository.head,
    workingTreeSha256: hashWorkspaceEvidence(context.repository),
    frontendSha256: frontendSha,
    executableSha256: executableHash?.sha256 || null,
    configSha256: (await hashFile(context.qaBuildConfigPath || context.bridgeConfigPath)).sha256,
    executable: executableHash,
    frontend: context.artifactCheck?.qa || null,
    normalFrontend: context.artifactCheck?.normal || null,
    config: { path: context.qaBuildConfigPath || context.bridgeConfigPath },
    qaBridge: true,
    compiler: {
      qaFlag: "VITE_LIGHTMARK_PERF_QA=1",
      probeMode: PROBE_MODE,
    },
  };
}

function pageExpressionForBridge(method, args) {
  if (!BRIDGE_METHODS.has(method)) throw new PerformanceLauncherError(`Launcher attempted an unapproved bridge method: ${method}`);
  if (!Array.isArray(args)) throw new PerformanceLauncherError("Bridge arguments must be an array.");
  const encodedArguments = args.map((value) => JSON.stringify(value)).join(",");
  return `(async () => { const bridge = globalThis.__LIGHTMARK_PERF_BRIDGE__; if (!bridge) throw new Error('performance bridge unavailable'); return await bridge[${JSON.stringify(method)}](${encodedArguments}); })()`;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  static async connect(url) {
    if (!url.startsWith("ws://127.0.0.1:")) throw new PerformanceLauncherError(`Refusing non-loopback CDP URL: ${url}`);
    const client = new CdpClient(url);
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
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
      if (!message.id) { this.onEvent?.(message); return; }
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
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timeout")), 10_000);
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

  async call(method, params = {}, timeoutMs = 15_000) {
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

  async evaluate(expression, timeoutMs = 15_000) {
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
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      const finish = () => {
        clearTimeout(timer);
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
  }
}

async function bridgeCall(client, method, args = []) {
  if (client.rendererUnresponsive) throw new Error("Renderer unavailable after an earlier CDP timeout; remaining calls refused.");
  client.journal?.({ kind: "bridge-start", method, args, hostAt: monotonicMs() });
  try {
    // These checks run outside every measured interval and can include two
    // complete 50k view restorations after reset. Their aggregate duration is
    // not evidence that an input RPC or the renderer has stopped responding.
    const timeoutMs = method === 'verify' || method === 'reset' ? DEFAULT_TIMEOUT_MS : 15_000;
    const value = await client.evaluate(pageExpressionForBridge(method, args), timeoutMs);
    client.journal?.({ kind: "bridge-done", method, args, hostAt: monotonicMs() });
    return value;
  } catch (error) {
    client.journal?.({ kind: "bridge-failed", method, args, hostAt: monotonicMs(), error: serializeError(error) });
    if (/CDP command timeout/u.test(String(error))) client.rendererUnresponsive = true;
    throw error;
  }
}

async function readPageViewport(client) {
  return await client.evaluate("({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })");
}

function assertBridgeReady(context, ready) {
  if (!ready || ready.schemaVersion !== BRIDGE_SCHEMA_VERSION || ready.bridgeEnabled !== true) {
    throw new PerformanceLauncherError(`Invalid performance bridge ready response: ${JSON.stringify(ready)}`);
  }
  if (ready.editorReady !== true || typeof ready.editorReadySignal !== "string") {
    throw new PerformanceLauncherError(`Performance bridge did not prove an editable root before ready: ${JSON.stringify(ready)}`);
  }
  if (ready.nonce !== context.nonce || ready.actualOrigin !== context.expectedOrigin || ready.expectedOrigin !== context.expectedOrigin) {
    throw new PerformanceLauncherError(`Performance bridge nonce/origin mismatch: ${JSON.stringify(ready)}`);
  }
  if (ready.profileToken !== context.profileToken || ready.processToken !== context.processToken || ready.probeMode !== PROBE_MODE) {
    throw new PerformanceLauncherError(`Performance bridge profile/process binding mismatch: ${JSON.stringify(ready)}`);
  }
  const expectedIds = [...PERFORMANCE_FIXTURE_IDS].sort();
  const actualIds = Array.isArray(ready.fixtureIds) ? [...ready.fixtureIds].sort() : [];
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new PerformanceLauncherError(`Performance bridge fixture catalog mismatch: ${JSON.stringify(ready.fixtureIds)}`);
  }
  return ready;
}

function normalizeRuntimePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function assertRuntimePaths(context, state, runtimePaths) {
  if (!runtimePaths || typeof runtimePaths !== "object") {
    throw new PerformanceLauncherError("Performance bridge did not return Tauri path API evidence.");
  }
  const expected = state.expectedRuntimePaths;
  const actual = {};
  for (const key of ["config", "data", "local"]) {
    if (typeof runtimePaths[key] !== "string" || runtimePaths[key].trim().length === 0) {
      throw new PerformanceLauncherError(`Performance bridge path API value is missing: ${key}`);
    }
    actual[key] = runtimePaths[key];
    if (normalizeRuntimePath(runtimePaths[key]) !== normalizeRuntimePath(expected[key])) {
      throw new PerformanceLauncherError(
        `Tauri runtime path mismatch for ${key}: expected ${expected[key]}, got ${runtimePaths[key]}`,
      );
    }
    const expectedRoot = key === "local" ? context.runtimeRoots.local : context.runtimeRoots.roaming;
    assertWithin(expectedRoot, expected[key], `Tauri ${key} directory`);
  }
  return {
    verified: true,
    expected,
    actual,
    preexisting: state.preexistingRuntimePaths,
  };
}

function makeProcessEnvironment(context, profilePath, cdpPort) {
  const browserArguments = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir="${profilePath}"`,
  ].join(" ");
  return {
    ...process.env,
    // Keep the host application-data roots unchanged. Tauri's path API is
    // checked against the host roots and unique identifier after launch;
    // WebView2 receives a separate owned profile below.
    WEBVIEW2_USER_DATA_FOLDER: profilePath,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
    LIGHTMARK_PERF_RUN_DIR: context.runDir,
    LIGHTMARK_PERF_NONCE: context.nonce,
    LIGHTMARK_PERF_PROCESS_TOKEN: context.processToken,
    LIGHTMARK_PERF_PROFILE_TOKEN: context.profileToken,
  };
}

async function startOwnedProcess(context, label, profilePath, { allowExistingRuntimePaths = false } = {}) {
  if (!context.executable) throw new PerformanceLauncherError("A release executable is required for native measurement.");
  if (!isWithin(context.runDir, profilePath)) throw new PerformanceLauncherError(`Profile escapes the owned run: ${profilePath}`);
  const profilePreexisting = await pathExists(profilePath);
  if (profilePreexisting) await assertNoSymlinks(profilePath);
  await mkdir(profilePath, { recursive: true });
  await assertWithin(context.runDir, profilePath, "WebView2 profile");
  await assertNoSymlinks(profilePath);
  const profileReal = await realpath(profilePath);
  const expectedRuntimePaths = context.expectedRuntimePaths;
  const runtimePathEntries = await Promise.all(
    Object.entries(expectedRuntimePaths).map(async ([key, candidate]) => [key, await pathExists(candidate)]),
  );
  const resolvedPreexistingRuntimePaths = Object.fromEntries(runtimePathEntries);
  if (context.runtimePathChecks.length === 0 && Object.values(resolvedPreexistingRuntimePaths).some(Boolean)) {
    throw new PerformanceLauncherError(
      `Tauri runtime directory appeared before the first owned process: ${JSON.stringify(resolvedPreexistingRuntimePaths)}`,
    );
  }
  const cdpPort = await allocatePort();
  const state = spawnLogged(context.executable, [], {
    cwd: repositoryRoot,
    env: makeProcessEnvironment(context, profileReal, cdpPort),
    stdoutPath: path.join(context.dirs.logs, `${label}.stdout.log`),
    stderrPath: path.join(context.dirs.logs, `${label}.stderr.log`),
  });
  state.label = label;
  state.profilePath = profileReal;
  state.profilePreexisting = profilePreexisting;
  state.expectedRuntimePaths = expectedRuntimePaths;
  state.preexistingRuntimePaths = resolvedPreexistingRuntimePaths;
  state.allowExistingRuntimePaths = allowExistingRuntimePaths;
  state.cdpPort = cdpPort;
  state.startedAt = monotonicMs();
  state.ownership = null;
  state.target = null;
  state.client = null;
  context.events.push({
    kind: "process-start",
    label,
    pid: state.child.pid ?? null,
    cdpPort,
    profilePath: path.relative(context.runDir, profileReal).replaceAll("\\", "/"),
    profilePreexisting,
    expectedRuntimePaths,
    preexistingRuntimePaths: resolvedPreexistingRuntimePaths,
    allowExistingRuntimePaths,
    startedAt: state.startedAt,
  });
  return state;
}

async function connectOwnedProcess(context, state) {
  if (!state.child.pid) throw new PerformanceLauncherError(`Owned process has no PID: ${state.label}`);
  state.target = await waitForCdpTarget(state, state.cdpPort, context.expectedOrigin);
  state.ownership = await waitForOwnedListener(state.cdpPort, state, state.profilePath, context.executable);
  context.processOwnership.push(state.ownership);
  state.client = await CdpClient.connect(state.target.target.webSocketDebuggerUrl);
  state.client.journal = event => appendFileSync(path.join(context.dirs.logs, `${state.label}-phases.ndjson`), `${JSON.stringify(event)}\n`);
  state.client.onEvent = message => {
    if (message.method !== "Runtime.consoleAPICalled") return;
    const args = message.params?.args || [];
    if (args[0]?.value !== "__LIGHTMARK_PERF_PHASE__") return;
    let phase;
    try { phase = JSON.parse(args[1]?.value); } catch { return; }
    state.client.journal({ kind: "browser-phase", ...phase, hostAt: monotonicMs() });
  };
  await state.client.call("Runtime.enable", {});
  const ready = assertBridgeReady(context, await bridgeCall(state.client, "ready"));
  const runtimePaths = assertRuntimePaths(context, state, ready.runtimePaths);
  state.runtimePaths = runtimePaths;
  context.runtimePathChecks.push({ label: state.label, ...runtimePaths });
  context.bridgeReady = ready;
  context.events.push({
    kind: "process-ready",
    label: state.label,
    pid: state.child.pid,
    cdpPort: state.cdpPort,
    target: summarizeTarget(state.target.target),
    pageTargets: state.target.pages,
    ready,
    readyAt: monotonicMs(),
  });
  return state;
}

async function stopOwnedProcess(context, state, reason = "launcher-stop") {
  if (!state) return null;
  let shutdown = null;
  if (state.client && !state.client.closed) {
    try {
      shutdown = await bridgeCall(state.client, "shutdown");
    } catch (error) {
      shutdown = { error: serializeError(error) };
    }
  }
  await state.client?.close();
  let exit = null;
  try {
    exit = await waitForExit(state, 30_000);
  } catch (error) {
    if (state.child.pid) {
      const kill = await runCaptured("taskkill.exe", ["/PID", String(state.child.pid), "/T", "/F"], { cwd: repositoryRoot });
      exit = { timeout: serializeError(error), taskkill: { exitCode: kill.exitCode, stderr: kill.stderr, error: kill.error } };
      exit.afterTaskkill = await waitForExit(state, 10_000).catch((waitError) => ({ error: serializeError(waitError) }));
    } else {
      exit = { error: serializeError(error) };
    }
  }
  const portClose = await waitForPortClosed(state.cdpPort).then(() => ({ closed: true })).catch((error) => ({ closed: false, error: serializeError(error) }));
  await Promise.all([finishLogStream(state.stdout), finishLogStream(state.stderr)]);
  const result = { label: state.label, pid: state.child.pid ?? null, reason, shutdown, exit, portClose };
  context.events.push({ kind: "process-stop", ...result, stoppedAt: monotonicMs() });
  return result;
}

function failureSample(context, plan, round, index, reason, sampleId = undefined) {
  return {
    kind: "interactive",
    fixtureId: plan.fixtureId,
    mode: plan.mode,
    operation: plan.operation,
    location: plan.location,
    measurementStage: plan.operation === "scroll" ? "scroll-to-raf-opportunity" : "input-to-raf-opportunity",
    round,
    index,
    sampleId: sampleId || `launcher-failed-${context.runToken}-${plan.fixtureId}-${round}-${index}`,
    status: "failed",
    failureReason: reason,
    method: plan.operation === "scroll" ? "owned-editor.scrollTop" : "cdp.Input.insertText",
    buildId: context.buildId,
    probeMode: PROBE_MODE,
    timingMetric: plan.operation === "scroll" ? "scroll-event-to-raf-opportunity" : "dispatch-to-raf-opportunity",
  };
}

async function oneInteractiveOperation(context, client, plan, round, index, { warmup = false } = {}) {
  const uniqueSuffix = `${context.runToken}-${plan.fixtureId}-${round}-${index}-${warmup ? "warmup" : "sample"}`;
  let prepared = null;
  let completion = null;
  let inputError = null;
  let inputCallDurationMs = null;
  try {
    prepared = await bridgeCall(client, "prepareOperation", [plan.fixtureId, plan.operation, plan.location]);
    if (prepared?.supported === false) {
      return failureSample(context, plan, round, index, prepared.reason || "operation is not supported", prepared.sampleId || `unsupported-${uniqueSuffix}`);
    }
    if (!prepared?.supported || typeof prepared.sampleId !== "string") {
      return failureSample(context, plan, round, index, "bridge did not acknowledge the prepared operation", `invalid-prepare-${uniqueSuffix}`);
    }
    const inputCallStartedAt = monotonicMs();
    try {
      if (plan.operation === "insert-text") {
        await client.call("Input.insertText", { text: FIXED_INPUT_TEXT }, 15_000);
      } else if (plan.operation === "delete-backward" || plan.operation === "insert-newline" || plan.operation === "formula-commit") {
        const formulaCommit = plan.operation === "formula-commit";
        const newline = plan.operation === "insert-newline" || formulaCommit;
        await client.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: newline ? "Enter" : "Backspace",
          code: newline ? "Enter" : "Backspace",
          windowsVirtualKeyCode: newline ? 13 : 8,
          nativeVirtualKeyCode: newline ? 13 : 8,
          modifiers: formulaCommit ? 2 : 0,
        }, 15_000);
        if (newline && plan.mode === "source") {
          await client.call("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, 15_000);
        }
        await client.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: newline ? "Enter" : "Backspace",
          code: newline ? "Enter" : "Backspace",
          windowsVirtualKeyCode: newline ? 13 : 8,
          nativeVirtualKeyCode: newline ? 13 : 8,
          modifiers: formulaCommit ? 2 : 0,
        }, 15_000);
      }
    } catch (error) {
      inputError = error;
    }
    inputCallDurationMs = monotonicMs() - inputCallStartedAt;
    try {
      completion = await bridgeCall(client, "completeOperation", [plan.fixtureId, plan.operation, plan.location]);
    } catch (error) {
      inputError = inputError || error;
    }
  } catch (error) {
    inputError = error;
    // If preparation succeeded, complete once more so the bridge can remove
    // its observer even when the CDP input command failed.
    if (prepared?.supported && !completion) {
      completion = await bridgeCall(client, "completeOperation", [plan.fixtureId, plan.operation, plan.location]).catch(() => null);
    }
  }
  if (inputError && !completion) return failureSample(context, plan, round, index, serializeError(inputError).message, prepared?.sampleId || `failed-${uniqueSuffix}`);
  let compositorObservation = null;
  // One readback per round avoids retaining hundreds of screenshots. This is
  // an observable compositor response, with IPC/PNG overhead, not physical
  // display latency or a substitute for the browser-local rAF measurement.
  if (!warmup && index === 0 && completion?.status === "ok") {
    const captureStarted = monotonicMs();
    try {
      const screenshot = await client.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 15_000);
      const clock = await client.call("Runtime.evaluate", { expression: "performance.now()", returnByValue: true }, 15_000);
      const bytes = Buffer.from(screenshot.data, "base64");
      compositorObservation = { status: "observed", browserObservedAt: clock.result?.value ?? null, hostRoundTripMs: monotonicMs() - captureStarted, pngBytes: bytes.byteLength, pngSha256: createHash("sha256").update(bytes).digest("hex"), note: "screenshot compositor readback plus clock RPC upper bound; physical presentation remains unobserved" };
    } catch (error) { compositorObservation = { status: "unobserved", reason: serializeError(error).message }; }
  }
  const sample = {
    ...(completion || {}),
    kind: "interactive",
    fixtureId: plan.fixtureId,
    mode: plan.mode,
    operation: plan.operation,
    location: plan.location,
    round,
    index,
    sampleId: completion?.sampleId || prepared?.sampleId || `missing-${uniqueSuffix}`,
    status: inputError ? "failed" : completion?.status || "failed",
    failureReason: inputError ? serializeError(inputError).message : completion?.failureReason,
    method: completion?.method || prepared?.method || (plan.operation === "scroll" ? "owned-editor.scrollTop" : "cdp.Input.insertText"),
    buildId: context.buildId,
    probeMode: PROBE_MODE,
    timingMetric: completion?.timingMetric || prepared?.timingMetric
      || (plan.operation === "scroll" ? "scroll-event-to-raf-opportunity" : "dispatch-to-raf-opportunity"),
    launcherInputCallDurationMs: inputCallDurationMs,
    launcherInputCallObservation: "host CDP round-trip duration; includes transport and is not synchronous editor command time",
    compositorObservation,
  };
  if (warmup) return sample;
  return sample;
}

function textSentinels(value) {
  return value.match(/LM_PERF_SENTINEL_(?:BEFORE|AFTER)_[A-Z0-9_]+_KEEP/gu) || [];
}

async function compareFixtureBytes(context, fixtureId) {
  const fixture = context.fixtureSet.manifest.fixtures.find((item) => item.id === fixtureId);
  if (!fixture) throw new PerformanceLauncherError(`Missing fixture manifest entry: ${fixtureId}`);
  const fixturePath = context.bridgeConfig.fixtures[fixtureId].path;
  const bytes = await readFile(fixturePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");
  return {
    sha256,
    expectedSha256: fixture.sha256,
    bytesCompared: sha256 === fixture.sha256,
    sentinelCompared: textSentinels(text).length === 2,
    bytes: bytes.byteLength,
  };
}

async function measureFixture(context, client, plan, rounds, operations, samples, correctnessChecks) {
  const openStartedAt = monotonicMs();
  const opened = await bridgeCall(client, "open", [plan.fixtureId]);
  const openedAt = monotonicMs();
  const mode = await bridgeCall(client, "mode", [plan.fixtureId, plan.mode]);
  const modeAt = monotonicMs();
  context.events.push({
    kind: "fixture-ready",
    fixtureId: plan.fixtureId,
    relativePath: opened.relativePath,
    documentMode: opened.documentMode,
    editorMode: mode.mode,
    openDurationMs: openedAt - openStartedAt,
    modeDurationMs: modeAt - openedAt,
    open: opened,
    mode,
  });

  const support = await bridgeCall(client, "supports", [plan.fixtureId, plan.operation]);
  if (!support?.supported) {
    throw new PerformanceLauncherError(`Required performance operation is unsupported for ${plan.fixtureId}: ${support?.reason || "unknown"}`);
  }

  for (let round = 1; round <= rounds; round += 1) {
    context.events.push({ kind: "memory", fixtureId: plan.fixtureId, mode: plan.mode, operation: plan.operation, round, phase: "before-round", memory: await bridgeCall(client, "memory", [plan.fixtureId]), observedAt: monotonicMs() });
    const roundSamples = [];
    for (let index = 0; index < operations; index += 1) {
      // Reposition outside the measured interval so repeated scroll samples
      // still produce a real scroll event without counting the warm-up.
      if (plan.operation === "scroll") {
        await oneInteractiveOperation(context, client, { ...plan, location: "tail" }, round, index, { warmup: true }).catch((error) => {
          context.events.push({ kind: "scroll-warmup-failure", fixtureId: plan.fixtureId, round, index, error: serializeError(error) });
        });
      }
      const sample = await oneInteractiveOperation(context, client, plan, round, index);
      roundSamples.push(sample);
      samples.push(sample);
      if (sample.status !== "ok") break;
    }
    const beforeReset = await bridgeCall(client, "verify", [plan.fixtureId]).catch((error) => ({ error: serializeError(error) }));
    const beforeResetDisk = await compareFixtureBytes(context, plan.fixtureId);
    const reset = await bridgeCall(client, "reset", [plan.fixtureId]).catch((error) => ({ error: serializeError(error) }));
    const afterReset = await bridgeCall(client, "verify", [plan.fixtureId]).catch((error) => ({ error: serializeError(error) }));
    const afterResetDisk = await compareFixtureBytes(context, plan.fixtureId);
    const allOperationsObserved = roundSamples.length === operations
      && roundSamples.every((sample) => sample.status === "ok");
    const checks = {
      fixtureId: plan.fixtureId,
      round,
      operation: `${plan.operation}-roundtrip`,
      location: plan.location,
      measurementStage: plan.operation === "scroll" ? "scroll-to-raf-opportunity" : "input-to-raf-opportunity",
      method: operationMethod(plan.operation),
      buildId: context.buildId,
      probeMode: PROBE_MODE,
      status: "failed",
      passed: false,
      operationApplied: allOperationsObserved,
      bytesCompared: beforeResetDisk.bytesCompared === true && afterResetDisk.bytesCompared === true
        && (afterReset.bytesCompared === true || plan.operation === "scroll"),
      syntaxCompared: afterReset.syntaxCompared === true,
      selectionCompared: afterReset.selectionCompared === true,
      historyCompared: beforeReset.historyCompared === true && afterReset.historyCompared === true,
      sentinelCompared: beforeResetDisk.sentinelCompared === true
        && afterResetDisk.sentinelCompared === true
        && afterReset.sentinelCompared === true,
      focusObserved: afterReset.focusObserved === true,
      beforeReset,
      reset,
      afterReset,
      beforeResetDisk,
      afterResetDisk,
      reason: [
        !allOperationsObserved ? "one or more operations failed" : "",
        afterReset.syntaxCompared !== true ? "syntax oracle unavailable" : "",
        afterReset.selectionCompared !== true ? "logical selection oracle unavailable" : "",
        afterReset.historyCompared !== true ? "undo/redo oracle unavailable" : "",
      ].filter(Boolean).join("; "),
    };
    checks.passed = ["operationApplied", "bytesCompared", "syntaxCompared", "selectionCompared", "historyCompared", "sentinelCompared", "focusObserved"].every(field => checks[field] === true);
    checks.status = checks.passed ? "passed" : "failed";
    correctnessChecks.push(checks);
    context.events.push({ kind: "memory", fixtureId: plan.fixtureId, mode: plan.mode, operation: plan.operation, round, phase: "after-reset", memory: await bridgeCall(client, "memory", [plan.fixtureId]), observedAt: monotonicMs() });
    if (!allOperationsObserved) throw new PerformanceLauncherError(`Operation failed for ${plan.fixtureId}/${plan.operation}; remaining required samples are missing, see raw failure and correctness evidence.`);
  }
}

async function measureInteractive(context, state, rounds, operations) {
  const viewport = await readPageViewport(state.client).catch(() => null);
  const focus = await state.client.evaluate("({hasFocus:document.hasFocus(),visibilityState:document.visibilityState})").catch(() => null);
  const power = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$batteriesForQa = @(Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining); [pscustomobject]@{ batteries = $batteriesForQa; scheme = [string](powercfg /getactivescheme) } | ConvertTo-Json -Compress"], { cwd: repositoryRoot }).catch(() => null);
  context.machine = collectMachineMetadata({
    viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
    devicePixelRatio: viewport?.devicePixelRatio ?? null,
    webview2: state.target?.version?.Browser || "unknown",
    rust: context.repository.tools?.rustc?.version || "unknown",
    powerState: power?.exitCode === 0 ? power.stdout.trim() || "unknown" : "unknown",
    foreground: focus ? JSON.stringify({ ...focus, observation: "owned document focus and visibility; OS foreground handle unobserved" }) : "unknown",
  });
  const plans = context.options.formulaStress ? FIXTURE_PLAN.filter(plan => plan.operation === "formula-commit") : FIXTURE_PLAN;
  for (const plan of plans) {
    try {
      await measureFixture(context, state.client, plan, rounds, operations, context.samples, context.correctnessChecks);
    } catch (error) {
      const reason = serializeError(error).message;
      context.events.push({ kind: "fixture-failure", ...plan, error: serializeError(error) });
      const sample = failureSample(context, plan, 1, 0, reason, `fixture-failed-${plan.fixtureId}-${plan.operation}-${context.runToken}`);
      context.samples.push(sample);
      context.correctnessChecks.push({ fixtureId: plan.fixtureId, round: 1, operation: `${plan.operation}-roundtrip`, location: plan.location, measurementStage: plan.operation === "scroll" ? "scroll-to-raf-opportunity" : "input-to-raf-opportunity", method: operationMethod(plan.operation), buildId: context.buildId, probeMode: PROBE_MODE, status: "failed", passed: false, reason });
      if (state.client.rendererUnresponsive) {
        context.events.push({ kind: "unresponsive-renderer-memory", ...plan, processMemory: await ownedProcessMemory(state.child.pid), observedAt: monotonicMs() });
        throw error;
      }
    }
    context.events.push({ kind: "memory", fixtureId: plan.fixtureId, mode: plan.mode, phase: "after-fixture", processMemory: await ownedProcessMemory(state.child.pid), observedAt: monotonicMs() });
  }
  const memory = await bridgeCall(state.client, "memory", [plans.at(-1).fixtureId]).catch((error) => ({ error: serializeError(error) }));
  context.events.push({ kind: "memory", memory, observedAt: monotonicMs() });
}

async function measureStartupStage(context, stage, sampleCount, profileFactory) {
  for (let index = 0; index < sampleCount; index += 1) {
    const profilePath = await profileFactory(index);
    const state = await startOwnedProcess(
      context,
      `startup-${stage}-${index}`,
      profilePath,
      { allowExistingRuntimePaths: stage === "warm-restart" },
    );
    const requestedAt = state.startedAt;
    try {
      await connectOwnedProcess(context, state);
      const readyAt = monotonicMs();
      context.samples.push({
        kind: "startup",
        startupStage: stage,
        measurementStage: "process-start-to-editor-ready",
        status: "ok",
        durationMs: Math.max(0, readyAt - requestedAt),
        index,
        sampleId: `startup-${stage}-${index}-${context.runToken}`,
        method: "owned-release-process-to-editor-ready",
        buildId: context.buildId,
        probeMode: PROBE_MODE,
        timingMetric: "process-start-to-editor-ready",
        editorReady: state.client ? context.bridgeReady?.editorReady === true : false,
        timings: {
          requestedAt,
          bridgeReadyAt: readyAt,
          editorReadyAt: readyAt,
        },
        ownership: state.ownership,
      });
    } catch (error) {
      context.samples.push({
        kind: "startup",
        startupStage: stage,
        measurementStage: "process-start-to-editor-ready",
        status: "failed",
        failureReason: serializeError(error).message,
        index,
        sampleId: `startup-failed-${stage}-${index}-${context.runToken}`,
        method: "owned-release-process-to-editor-ready",
        buildId: context.buildId,
        probeMode: PROBE_MODE,
        timingMetric: "process-start-to-editor-ready",
      });
      throw error;
    } finally {
      await stopOwnedProcess(context, state, `startup-${stage}`);
    }
  }
}

async function seedWarmProfile(context, profilePath) {
  const state = await startOwnedProcess(context, "warm-restart-seed", profilePath);
  try {
    await connectOwnedProcess(context, state);
    context.events.push({
      kind: "warm-profile-seed",
      pid: state.child.pid ?? null,
      profilePath: path.relative(context.runDir, state.profilePath).replaceAll("\\", "/"),
      excludedFromStartupSamples: true,
    });
  } finally {
    const stopped = await stopOwnedProcess(context, state, "warm-profile-seed");
    if (!stopped?.portClose?.closed) throw new PerformanceLauncherError("Warm profile seed CDP port did not close.");
  }
}

function expectedInteractiveGroups(context) {
  return FIXTURE_PLAN.map((plan) => ({
    fixtureId: plan.fixtureId,
    mode: plan.mode,
    operation: plan.operation,
    location: plan.location,
    measurementStage: plan.operation === "scroll" ? "scroll-to-raf-opportunity" : "input-to-raf-opportunity",
    method: operationMethod(plan.operation),
    buildId: context.buildId,
    probeMode: PROBE_MODE,
    timingMetric: plan.operation === "scroll" ? "scroll-event-to-raf-opportunity" : "dispatch-to-raf-opportunity",
  }));
}

function expectedCorrectnessKeys(context, rounds) {
  return FIXTURE_PLAN.flatMap((plan) => Array.from({ length: rounds }, (_, index) => ({
    fixtureId: plan.fixtureId,
    round: index + 1,
    operation: `${plan.operation}-roundtrip`,
    location: plan.location,
    measurementStage: plan.operation === "scroll" ? "scroll-to-raf-opportunity" : "input-to-raf-opportunity",
    method: operationMethod(plan.operation),
    buildId: context.buildId,
    probeMode: PROBE_MODE,
  })));
}

function bridgeEvidence(context) {
  const ready = context.bridgeReady;
  const ownershipVerified = context.processOwnership.length > 0
    && context.processOwnership.every((entry) => entry.verified === true);
  const runtimePathsVerified = context.runtimePathChecks.length > 0
    && context.runtimePathChecks.every((entry) => entry.verified === true);
  return {
    version: BRIDGE_SCHEMA_VERSION,
    nonceBound: Boolean(ready && ready.nonce === context.nonce && ready.actualOrigin === context.expectedOrigin),
    ownedProcess: ownershipVerified,
    ownedProfile: ownershipVerified,
    runtimePathsVerified,
    nonce: ready?.nonce || context.nonce,
    expectedOrigin: ready?.expectedOrigin || context.expectedOrigin,
    actualOrigin: ready?.actualOrigin || null,
    profileToken: ready?.profileToken || context.profileToken,
    processToken: ready?.processToken || context.processToken,
    probeMode: ready?.probeMode || PROBE_MODE,
    ownershipCount: context.processOwnership.length,
    ownership: context.processOwnership,
    runtimePathChecks: context.runtimePathChecks,
    presentationBoundary: "not-observed",
  };
}

function fallbackBuild(context) {
  return context.build || {
    environment: "release",
    measurementKind: "release-pre-sampled",
    buildId: context.buildId,
    head: context.repository.head,
    workingTreeSha256: hashWorkspaceEvidence(context.repository),
    frontendSha256: null,
    executableSha256: null,
    configSha256: null,
    qaBridge: true,
    compiler: { qaFlag: "VITE_LIGHTMARK_PERF_QA=1", probeMode: PROBE_MODE },
  };
}

async function finalizeContext(context, operationalError = null) {
  if (operationalError) context.failure = serializeError(operationalError);
  const machine = context.machine || collectMachineMetadata({
    viewport: null,
    devicePixelRatio: null,
    webview2: "unknown",
    rust: context.repository.tools?.rustc?.version || "unknown",
    powerState: "unknown",
    foreground: "unknown",
  });
  const manifestPath = path.relative(context.runDir, context.fixtureSet.manifestPath).replaceAll("\\", "/");
  const report = buildPerformanceReport({
    build: fallbackBuild(context),
    machine,
    fixtureManifest: {
      ...context.fixtureSet.manifest,
      path: manifestPath,
      sha256: context.manifestHash,
    },
    bridge: bridgeEvidence(context),
    samples: context.samples,
    correctnessChecks: context.correctnessChecks,
    memorySamples: context.events.filter(event => event.kind === "memory"),
    expectedFixtureIds: PERFORMANCE_FIXTURE_IDS,
    expectedInteractiveGroups: expectedInteractiveGroups(context),
    expectedCorrectnessKeys: expectedCorrectnessKeys(context, context.options.rounds),
    requireStartup: true,
    diagnosticOnly: context.options.formulaStress === true,
  });
  if (context.options.formulaStress) report.diagnosticScope = {
    kind: "formula-stress-only",
    completeReleaseMatrix: false,
    note: "Only formula 3×100 and its history oracles ran. Required full-matrix sampling and startup gates remain unchanged and ineligible.",
  };
  const result = await writePerformanceResult(context.dirs.output, report, context.samples);
  await writeJson(path.join(context.dirs.output, "performance-events.json"), {
    schemaVersion: 1,
    timingBoundary: {
      physicalPresentation: "not-observed",
      raf: "opportunity only",
      correctness: "outside timing intervals",
    },
    events: context.events,
    correctnessChecks: context.correctnessChecks,
    artifactCheck: context.artifactCheck,
    failure: context.failure,
  });
  const launcherManifestPath = path.join(context.runDir, "launcher-manifest.json");
  const currentManifest = JSON.parse(await readFile(launcherManifestPath, "utf8"));
  await writeJson(launcherManifestPath, {
    ...currentManifest,
    status: operationalError ? "failed" : "completed-invalid-until-gates-pass",
    completedAt: new Date().toISOString(),
    failure: context.failure,
    output: {
      report: path.relative(context.runDir, result.reportPath).replaceAll("\\", "/"),
      rawSamples: path.relative(context.runDir, result.rawPath).replaceAll("\\", "/"),
      events: path.relative(context.runDir, path.join(context.dirs.output, "performance-events.json")).replaceAll("\\", "/"),
    },
    build: fallbackBuild(context),
    bridge: bridgeEvidence(context),
    sampleCount: context.samples.length,
    correctnessCount: context.correctnessChecks.length,
  });
  return { report, reportPath: result.reportPath, rawPath: result.rawPath };
}

async function runLauncher(options) {
  if (process.platform !== "win32") throw new PerformanceLauncherError("The release performance launcher requires Windows WebView2.");
  assertInheritedEnvironmentClean();
  const context = await prepareContext(options);
  let operationalError = null;
  try {
    await prepareBuildAndArtifacts(context);
    if (!options.launch) return await finalizeContext(context);
    if (!context.executable) throw new PerformanceLauncherError("--launch requires the executable produced by this run's --build-qa.");
    if (process.env.LIGHTMARK_PERF_LAUNCH_GATE) {
      const gate = path.resolve(process.env.LIGHTMARK_PERF_LAUNCH_GATE);
      assertWithin(path.resolve(options.output), gate, "native sampling launch gate");
      context.events.push({ kind: "launch-gate-wait", gate, observedAt: monotonicMs() });
      while (await pathExists(gate)) await sleep(250);
      context.events.push({ kind: "launch-gate-released", observedAt: monotonicMs() });
    }

    if (!options.formulaStress) {
    await measureStartupStage(
      context,
      "cold-new-profile",
      options.startupSamples,
      async (index) => path.join(context.dirs.profiles, `cold-new-profile-${index}`),
    );
    const warmProfile = path.join(context.dirs.profiles, "warm-restart");
    await seedWarmProfile(context, warmProfile);
    await measureStartupStage(context, "warm-restart", options.startupSamples, async () => warmProfile);
    }

    const interactiveProfile = path.join(context.dirs.profiles, "interactive");
    const state = await startOwnedProcess(context, "interactive", interactiveProfile);
    try {
      await connectOwnedProcess(context, state);
      await measureInteractive(context, state, options.rounds, options.operations);
    } finally {
      const stopped = await stopOwnedProcess(context, state, "interactive-complete");
      if (!stopped?.portClose?.closed) {
        throw new PerformanceLauncherError("Interactive owned CDP port did not close; see performance-events.json.");
      }
    }
  } catch (error) {
    operationalError = error;
    context.events.push({ kind: "launcher-failure", error: serializeError(error), failedAt: monotonicMs() });
  }
  const finalized = await finalizeContext(context, operationalError);
  return {
    runDir: context.runDir,
    reportPath: finalized.reportPath,
    rawPath: finalized.rawPath,
    status: operationalError ? "failed" : finalized.report.verdict.validForPerformanceComparison ? "eligible" : "completed-invalid-until-gates-pass",
    sampleCount: context.samples.length,
    correctnessCount: context.correctnessChecks.length,
    verdict: finalized.report.verdict,
    failure: context.failure,
  };
}

export async function runReleasePerformanceLauncher(options) {
  return await runLauncher(options);
}

function printHelp() {
  console.log([
    "Owned Windows release performance launcher",
    "",
    "Preparation (default):",
    "  node scripts/qa/performance-release-launcher.mjs --output DIR [--qa-dist DIR] [--normal-dist DIR]",
    "Launch smoke/full measurement:",
    "  node scripts/qa/performance-release-launcher.mjs --launch --build-qa --normal-dist DIR --output DIR",
    "Build QA release first (requires a serial native build window):",
    "  node scripts/qa/performance-release-launcher.mjs --launch --build-qa --normal-dist DIR --output DIR",
    "Use --smoke for one startup sample, one round and one operation; its report remains ineligible.",
    "Use --formula-stress for diagnostic-only formula 3×100 and history checks, without startup samples; full release gates remain unchanged and ineligible.",
  ].join("\n"));
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const result = await runLauncher(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "failed") process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify(serializeError(error), null, 2));
    process.exitCode = 1;
  }
}
