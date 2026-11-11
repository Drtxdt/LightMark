import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
  lstat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createWp10BoundaryFixture,
  readWp10BoundaryManifest,
} from "./wp10-desktop-content-boundary-fixtures.mjs";
import {
  captureRepositoryEvidence,
  captureWorkspaceHashes,
  repositoryRoot,
  runCaptured,
  writeJson,
} from "./evidence.mjs";

const EXPECTED_ORIGIN = "http://tauri.localhost";
const PROBE_MODE = "wp10-desktop-content-boundary";
const BRIDGE_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const FORBIDDEN_NORMAL_MARKERS = [
  "__LIGHTMARK_PERF_BRIDGE__",
  "performanceQaBridge",
  "desktopContentBoundaryQaBridge",
  "__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__",
  "VITE_LIGHTMARK_QA_PROBE_MODE",
  "VITE_LIGHTMARK_PERF_CONFIG_JSON",
];
const NATIVE_BUILD_INPUT_PREFIXES = [
  "src-tauri/",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];

export class BoundaryLauncherError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "BoundaryLauncherError";
    this.details = details;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertWithin(parent, candidate, label = "path") {
  if (!isWithin(parent, candidate)) throw new BoundaryLauncherError(`${label} escapes the owned root: ${candidate}`);
  return candidate;
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

async function assertNoSymlinks(root) {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new BoundaryLauncherError(`Owned boundary root is a symlink: ${root}`);
  if (!rootStat.isDirectory()) throw new BoundaryLauncherError(`Owned boundary root is not a directory: ${root}`);
  async function visit(current) {
    for (const name of await readdir(current)) {
      const candidate = path.join(current, name);
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new BoundaryLauncherError(`Owned boundary tree contains a symlink: ${candidate}`);
      if (stat.isDirectory()) await visit(candidate);
    }
  }
  await visit(root);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    throw new BoundaryLauncherError(`cannot resolve Windows known-folder roots: ${result.stderr || result.error || result.exitCode}`);
  }
  const [roaming, local] = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!roaming || !local || !path.isAbsolute(roaming) || !path.isAbsolute(local)) {
    throw new BoundaryLauncherError(`Windows known-folder API returned invalid roots: ${JSON.stringify(result.stdout)}`);
  }
  return { roaming: path.resolve(roaming), local: path.resolve(local), source: "PowerShell Environment.GetFolderPath" };
}

function expectedRuntimePaths(identifier, roots) {
  return {
    config: path.join(roots.roaming, identifier),
    data: path.join(roots.roaming, identifier),
    local: path.join(roots.local, identifier),
  };
}

function cleanFrontendEnvironment(extra = {}) {
  const {
    VITE_LIGHTMARK_PERF_QA: _perfQa,
    VITE_LIGHTMARK_QA_PROBE_MODE: _probeMode,
    VITE_LIGHTMARK_PERF_CONFIG_JSON: _configJson,
    ...inherited
  } = process.env;
  return { ...inherited, ...extra };
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
  const state = { child, stdout, stderr, stdoutTail: "", stderrTail: "", exitResult: null };
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

async function terminateCommandTree(state) {
  if (!state || state.exitResult || !state.child?.pid) return null;
  const kill = await runCaptured("taskkill.exe", ["/PID", String(state.child.pid), "/T", "/F"], { cwd: repositoryRoot });
  const exit = await waitForExit(state, 5_000).catch((error) => ({ exitCode: null, signal: null, error: error.message }));
  return { requested: true, pid: state.child.pid, taskkill: { exitCode: kill.exitCode, stderr: kill.stderr, error: kill.error }, exit };
}

async function waitForExit(state, timeoutMs = 30_000) {
  if (state.exitResult) return state.exitResult;
  let timer;
  try {
    return await Promise.race([
      state.exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BoundaryLauncherError(`process exit timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
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

function isExpectedTarget(target, port) {
  if (!target || target.type !== "page" || typeof target.url !== "string" || typeof target.webSocketDebuggerUrl !== "string") return false;
  try {
    const url = new URL(target.url);
    return url.origin === EXPECTED_ORIGIN
      && ["/", "/index.html"].includes(url.pathname)
      && target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`);
  } catch {
    return false;
  }
}

async function waitForTarget(state, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (state.exitResult) throw new BoundaryLauncherError(`owned process exited before CDP target: ${JSON.stringify(state.exitResult)}`);
    try {
      const pages = await fetchJson(`http://127.0.0.1:${state.cdpPort}/json/list`);
      const nonBlank = (Array.isArray(pages) ? pages : []).filter((page) => page?.type === "page" && page.url && page.url !== "about:blank");
      const unexpected = nonBlank.filter((page) => !isExpectedTarget(page, state.cdpPort));
      if (unexpected.length > 0) throw new BoundaryLauncherError(`unexpected CDP page target: ${JSON.stringify(unexpected)}`);
      const matching = nonBlank.filter((page) => isExpectedTarget(page, state.cdpPort));
      if (matching.length === 1) return matching[0];
    } catch (error) {
      if (error instanceof BoundaryLauncherError) throw error;
      lastError = error;
    }
    await sleep(150);
  }
  throw new BoundaryLauncherError(`timed out waiting for owned boundary CDP target: ${String(lastError || "no target")}`);
}

class CdpClient {
  static async connect(url) {
    if (!url.startsWith("ws://127.0.0.1:")) throw new BoundaryLauncherError(`refusing non-loopback CDP URL: ${url}`);
    const client = new CdpClient(url);
    await client.connect();
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
      try { message = JSON.parse(event.data); } catch { return; }
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
      const timer = setTimeout(() => reject(new BoundaryLauncherError("CDP WebSocket connection timed out")), 10_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new BoundaryLauncherError("CDP WebSocket connection failed")); }, { once: true });
    });
  }

  async call(method, params = {}, timeoutMs = 30_000) {
    if (this.closed || !this.socket) throw new BoundaryLauncherError("CDP client is closed");
    const id = ++this.nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BoundaryLauncherError(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return await response;
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result?.exceptionDetails) throw new BoundaryLauncherError(`boundary bridge evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result?.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.close(); } catch { /* best effort */ }
    for (const pending of this.pending.values()) pending.reject(new BoundaryLauncherError("CDP client closed"));
    this.pending.clear();
  }
}

function bridgeExpression(method) {
  const allowed = new Set(["ready", "run", "shutdown"]);
  if (!allowed.has(method)) throw new BoundaryLauncherError(`unsupported boundary bridge method: ${method}`);
  return `(async () => { const bridge = globalThis.__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__; if (!bridge) throw new Error('WP10 boundary bridge unavailable'); return await bridge[${JSON.stringify(method)}](); })()`;
}

async function waitForBridge(client, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate("Boolean(globalThis.__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__?.bridgeEnabled === true)")) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new BoundaryLauncherError(`timed out waiting for WP10 boundary bridge: ${String(lastError || "bridge unavailable")}`);
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const values = new Set(["--output"]);
  const booleans = new Set(["--launch", "--build-qa", "--smoke"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--") || (!values.has(argument) && !booleans.has(argument))) {
      throw new BoundaryLauncherError(`unknown boundary launcher argument: ${argument}`);
    }
    if (values.has(argument)) {
      index += 1;
      if (!args[index] || args[index].startsWith("--")) throw new BoundaryLauncherError(`${argument} requires a value.`);
    }
  }
  const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : undefined;
  const smoke = args.includes("--smoke");
  const launch = args.includes("--launch") || smoke;
  const buildQa = args.includes("--build-qa");
  if (launch && !buildQa) throw new BoundaryLauncherError("--launch/--smoke requires --build-qa; external executables are never accepted.");
  return { output, launch, buildQa, smoke };
}

async function prepareContext(options) {
  const parent = path.resolve(options.output || os.tmpdir());
  await mkdir(parent, { recursive: true });
  const runDir = await mkdtemp(path.join(parent, "lightmark-wp10-boundary-"));
  const dirs = {
    fixtures: path.join(runDir, "fixtures"),
    output: path.join(runDir, "output"),
    config: path.join(runDir, "config"),
    logs: path.join(runDir, "logs"),
    profiles: path.join(runDir, "profiles"),
    builds: path.join(runDir, "builds"),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  await assertNoSymlinks(runDir);
  const runToken = safeToken("wp10");
  const identifier = `com.lightmark.qa.${runToken.replace(/[^a-z0-9]/giu, "").toLowerCase()}`;
  const roots = await hostRuntimeRoots();
  const runtimePaths = expectedRuntimePaths(identifier, roots);
  const preexisting = Object.fromEntries(await Promise.all(
    Object.entries(runtimePaths).map(async ([key, candidate]) => [key, await pathExists(candidate)]),
  ));
  if (Object.values(preexisting).some(Boolean)) throw new BoundaryLauncherError(`unique Tauri app paths already exist: ${JSON.stringify(preexisting)}`);
  const fixture = await createWp10BoundaryFixture(dirs.fixtures);
  const loaded = await readWp10BoundaryManifest(dirs.fixtures);
  const outputPath = path.join(dirs.output, "boundary-export.html");
  const config = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    nonce: `${runToken}-${randomUUID()}`,
    expectedOrigin: EXPECTED_ORIGIN,
    profileToken: safeToken("profile"),
    processToken: safeToken("process"),
    probeMode: PROBE_MODE,
    fixtureRoot: fixture.root,
    documentPath: loaded.manifest.document.path,
    documentSha256: loaded.manifest.document.sha256,
    outputRoot: dirs.output,
    outputPath,
    resources: loaded.manifest.resources.map((resource) => ({
      id: resource.id,
      source: resource.source,
      path: resource.path,
      role: resource.role === "forbidden-neighbor" ? "forbidden-neighbor" : "allowed",
      sha256: resource.sha256,
      bytes: resource.bytes,
      expectedMime: resource.expectedMime,
      ...(resource.sentinel ? { sentinel: resource.sentinel } : {}),
    })),
  };
  const bridgeConfigPath = path.join(dirs.config, "wp10-boundary-bridge.json");
  await writeJson(bridgeConfigPath, config);
  const repository = await captureRepositoryEvidence(repositoryRoot, runDir);
  const context = {
    options,
    runDir,
    dirs,
    runToken,
    identifier,
    runtimeRoots: roots,
    expectedRuntimePaths: runtimePaths,
    preexistingRuntimePaths: preexisting,
    fixture,
    manifest: loaded.manifest,
    config,
    bridgeConfigPath,
    repository,
    repositoryAfterFrontendBuild: null,
    nativeBuildInputsBefore: null,
    nativeBuildInputsAfter: null,
    events: [],
    processOwnership: [],
    runtimePathChecks: [],
    report: null,
    executable: null,
    build: null,
    artifactCheck: null,
    frontendArtifactsReady: null,
    state: null,
  };
  await writeJson(path.join(runDir, "launcher-manifest.json"), {
    schemaVersion: 1,
    kind: "lightmark-wp10-desktop-content-boundary",
    status: "prepared",
    createdAt: new Date().toISOString(),
    runDir,
    identifier,
    configPath: bridgeConfigPath,
    fixtureManifest: path.join(dirs.fixtures, "wp10-desktop-content-boundary.manifest.json"),
    isolation: {
      ownedRunDirectory: true,
      expectedRuntimePaths: runtimePaths,
      preexistingAtRunStart: preexisting,
      runtimePathSource: "PowerShell Environment.GetFolderPath(ApplicationData/LocalApplicationData)",
      sharedAcrossWebviewProfiles: true,
      startupSemantics: "not a startup benchmark; one owned export process",
      cdp: "not-launched",
    },
    repository,
  });
  return context;
}

async function writeTauriConfig(context, qaDist) {
  const base = JSON.parse(await readFile(path.join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  if (base.app?.windows?.some((window) => window?.dataDirectory != null)) {
    throw new BoundaryLauncherError("Base Tauri config overrides dataDirectory; refusing to infer isolated app paths.");
  }
  const configPath = path.join(context.dirs.config, "tauri.wp10.qa.json");
  const frontendRelative = path.relative(path.dirname(configPath), qaDist).replaceAll("\\", "/");
  const config = {
    ...base,
    identifier: context.identifier,
    build: {
      ...base.build,
      beforeBuildCommand: "",
      frontendDist: frontendRelative,
    },
    bundle: { ...base.bundle, active: false },
    app: {
      ...base.app,
      windows: (base.app?.windows || []).map((window, index) => index === 0
        ? { ...window, title: `LightMark WP10 boundary ${context.runToken}` }
        : window),
    },
  };
  await writeJson(configPath, config);
  return configPath;
}

async function runCommand(context, command, args, env, label, timeoutMs = 20 * 60_000) {
  const state = spawnLogged(command, args, {
    cwd: repositoryRoot,
    env,
    stdoutPath: path.join(context.dirs.logs, `${label}.stdout.log`),
    stderrPath: path.join(context.dirs.logs, `${label}.stderr.log`),
  });
  let result;
  try {
    result = await waitForExit(state, timeoutMs);
  } catch (error) {
    const termination = await terminateCommandTree(state);
    throw new BoundaryLauncherError(`${label} timed out after ${timeoutMs}ms; owned process tree was terminated.`, {
      cause: error.message,
      termination,
      stdoutTail: state.stdoutTail,
      stderrTail: state.stderrTail,
    });
  } finally {
    await Promise.all([finishLogStream(state.stdout), finishLogStream(state.stderr)]);
  }
  if (result.exitCode !== 0) throw new BoundaryLauncherError(`${label} failed: ${JSON.stringify(result)}`, { stdoutTail: state.stdoutTail, stderrTail: state.stderrTail });
  return { result, stdoutPath: path.join(context.dirs.logs, `${label}.stdout.log`), stderrPath: path.join(context.dirs.logs, `${label}.stderr.log`) };
}

async function hashDirectory(root) {
  await assertNoSymlinks(root);
  const files = [];
  async function visit(current) {
    for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
      const candidate = path.join(current, name);
      const stat = await lstat(candidate);
      if (stat.isDirectory()) await visit(candidate);
      else if (stat.isFile()) {
        const bytes = await readFile(candidate);
        files.push({ path: path.relative(root, candidate).replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: sha256(bytes), content: bytes });
      } else throw new BoundaryLauncherError(`artifact path is not a regular file: ${candidate}`);
    }
  }
  await visit(root);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update(Buffer.from([0]));
    digest.update(file.content);
  }
  return {
    root,
    files: files.map(({ content: _content, ...file }) => file),
    sha256: digest.digest("hex"),
    markers: (marker) => files.filter((file) => file.content.toString("utf8").includes(marker)).map((file) => file.path),
  };
}

export async function checkBoundaryArtifacts({ normalDist, qaDist }) {
  const normal = await hashDirectory(path.resolve(normalDist));
  const qa = await hashDirectory(path.resolve(qaDist));
  const forbiddenMarkers = FORBIDDEN_NORMAL_MARKERS.flatMap((marker) => normal.markers(marker).map((file) => ({ marker, file })));
  const qaMarker = qa.markers("__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__");
  return {
    passed: forbiddenMarkers.length === 0 && qaMarker.length > 0,
    normal,
    qa,
    forbiddenMarkers,
    qaMarker,
  };
}

function selectWorkspaceFiles(snapshot, prefixes) {
  return {
    ...snapshot,
    files: (snapshot?.files || []).filter((file) => prefixes.some((prefix) => file.path === prefix || file.path.startsWith(prefix))),
  };
}

function compareWorkspaceHashes(before, after, prefixes = null) {
  const beforeSnapshot = prefixes ? selectWorkspaceFiles(before, prefixes) : before;
  const afterSnapshot = prefixes ? selectWorkspaceFiles(after, prefixes) : after;
  const beforeFiles = new Map((beforeSnapshot?.files || []).map((file) => [file.path, file.sha256]));
  const afterFiles = new Map((afterSnapshot?.files || []).map((file) => [file.path, file.sha256]));
  const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  const changedPaths = [...paths].filter((filePath) => beforeFiles.get(filePath) !== afterFiles.get(filePath)).sort();
  const comparable = beforeFiles.size > 0 && afterFiles.size > 0
    && ![...(beforeSnapshot?.files || []), ...(afterSnapshot?.files || [])].some((file) => file.error);
  return { comparable, unchanged: comparable && changedPaths.length === 0, changedPaths };
}

async function buildArtifacts(context) {
  const normalDist = path.join(context.dirs.builds, "normal-dist");
  const qaDist = path.join(context.dirs.builds, "qa-dist");
  await Promise.all([mkdir(normalDist, { recursive: true }), mkdir(qaDist, { recursive: true })]);
  const normalEnv = cleanFrontendEnvironment({ NODE_ENV: "production" });
  await runCommand(context, process.execPath, [path.join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", normalDist], normalEnv, "normal-vite-build");
  const qaEnv = cleanFrontendEnvironment({
    NODE_ENV: "production",
    VITE_LIGHTMARK_PERF_QA: "1",
    VITE_LIGHTMARK_QA_PROBE_MODE: PROBE_MODE,
    VITE_LIGHTMARK_PERF_CONFIG_JSON: JSON.stringify(context.config),
  });
  await runCommand(context, process.execPath, [path.join(repositoryRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", qaDist], qaEnv, "qa-vite-build");
  context.artifactCheck = await checkBoundaryArtifacts({ normalDist, qaDist });
  if (!context.artifactCheck.passed) throw new BoundaryLauncherError("WP10 normal/QA artifact boundary failed before native launch.", context.artifactCheck);
  const frontendSourceAfter = await captureWorkspaceHashes(repositoryRoot);
  context.repositoryAfterFrontendBuild = {
    capturedAt: new Date().toISOString(),
    workspace: frontendSourceAfter,
    comparison: compareWorkspaceHashes(context.repository.workspace, frontendSourceAfter),
  };
  if (!context.repositoryAfterFrontendBuild.comparison.comparable) {
    throw new BoundaryLauncherError("WP10 frontend source hash capture was incomplete before or after Vite.", context.repositoryAfterFrontendBuild.comparison);
  }
  if (!context.repositoryAfterFrontendBuild.comparison.unchanged) {
    throw new BoundaryLauncherError("WP10 source workspace changed during the normal/QA frontend pack.", context.repositoryAfterFrontendBuild.comparison);
  }
  context.frontendArtifactsReady = {
    generatedAt: new Date().toISOString(),
    normalDist,
    qaDist,
    normalSha256: context.artifactCheck.normal.sha256,
    qaSha256: context.artifactCheck.qa.sha256,
    sourceWorkspaceBefore: context.repository.workspace,
    sourceWorkspaceAfter: frontendSourceAfter,
  };
  await writeJson(path.join(context.dirs.output, "frontend-artifacts-ready.json"), context.frontendArtifactsReady);
  const configPath = await writeTauriConfig(context, qaDist);
  const targetDir = path.join(context.dirs.builds, "target");
  const buildEnv = cleanFrontendEnvironment({
    NODE_ENV: "production",
    VITE_LIGHTMARK_PERF_QA: "1",
    VITE_LIGHTMARK_QA_PROBE_MODE: PROBE_MODE,
    VITE_LIGHTMARK_PERF_CONFIG_JSON: JSON.stringify(context.config),
    CARGO_TARGET_DIR: targetDir,
  });
  const nativeWorkspaceBefore = await captureWorkspaceHashes(repositoryRoot);
  context.nativeBuildInputsBefore = {
    capturedAt: new Date().toISOString(),
    prefixes: NATIVE_BUILD_INPUT_PREFIXES,
    workspace: selectWorkspaceFiles(nativeWorkspaceBefore, NATIVE_BUILD_INPUT_PREFIXES),
  };
  const require = createRequire(import.meta.url);
  const cliPackagePath = require.resolve("@tauri-apps/cli/package.json", { paths: [repositoryRoot] });
  const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
  const cliBin = typeof cliPackage.bin === "string" ? cliPackage.bin : cliPackage.bin?.tauri;
  if (!cliBin) throw new BoundaryLauncherError("installed Tauri CLI has no executable entry");
  const cliEntry = path.resolve(path.dirname(cliPackagePath), cliBin);
  assertWithin(repositoryRoot, cliEntry, "Tauri CLI entry");
  const build = await runCommand(
    context,
    process.execPath,
    [cliEntry, "build", "--no-bundle", "--config", configPath],
    buildEnv,
    "tauri-qa-build",
  );
  await assertNoSymlinks(context.dirs.builds);
  const artifactAfterPackage = await checkBoundaryArtifacts({ normalDist, qaDist });
  const artifactsStable = artifactAfterPackage.normal.sha256 === context.artifactCheck.normal.sha256
    && artifactAfterPackage.qa.sha256 === context.artifactCheck.qa.sha256;
  context.artifactCheck.afterPackage = {
    normalSha256: artifactAfterPackage.normal.sha256,
    qaSha256: artifactAfterPackage.qa.sha256,
    stable: artifactsStable,
  };
  if (!artifactsStable) {
    throw new BoundaryLauncherError("WP10 frontend artifact changed while the owned Tauri package was built.", context.artifactCheck.afterPackage);
  }
  const executable = path.join(targetDir, "release", "lightmark.exe");
  const executableInfo = await lstat(executable);
  if (executableInfo.isSymbolicLink() || !executableInfo.isFile()) throw new BoundaryLauncherError(`owned QA executable is not a regular file: ${executable}`);
  const executableReal = await realpath(executable);
  assertWithin(context.runDir, executableReal, "QA executable");
  context.executable = executableReal;
  const nativeWorkspaceAfter = await captureWorkspaceHashes(repositoryRoot);
  context.nativeBuildInputsAfter = {
    capturedAt: new Date().toISOString(),
    prefixes: NATIVE_BUILD_INPUT_PREFIXES,
    workspace: selectWorkspaceFiles(nativeWorkspaceAfter, NATIVE_BUILD_INPUT_PREFIXES),
    comparison: compareWorkspaceHashes(nativeWorkspaceBefore, nativeWorkspaceAfter, NATIVE_BUILD_INPUT_PREFIXES),
  };
  if (!context.nativeBuildInputsAfter.comparison.comparable) {
    throw new BoundaryLauncherError("WP10 native build input hash capture was incomplete before or after the owned build.", context.nativeBuildInputsAfter.comparison);
  }
  if (!context.nativeBuildInputsAfter.comparison.unchanged) {
    throw new BoundaryLauncherError("WP10 native build input changed during the owned Tauri build.", context.nativeBuildInputsAfter.comparison);
  }
  context.build = {
    environment: "release",
    measurementKind: "wp10-boundary-native",
    identifier: context.identifier,
    executable: { path: executableReal, bytes: executableInfo.size, sha256: sha256(await readFile(executableReal)) },
    frontend: {
      normal: context.artifactCheck.normal,
      qa: context.artifactCheck.qa,
    },
    config: { path: configPath, sha256: sha256(await readFile(configPath)) },
    cliVersion: cliPackage.version || null,
    logs: build,
  };
}

async function inspectOwnedProcess(context, state) {
  const netstat = await runCaptured("netstat.exe", ["-ano", "-p", "tcp"], { cwd: repositoryRoot });
  if (netstat.exitCode !== 0) throw new BoundaryLauncherError(`netstat failed: ${netstat.stderr || netstat.error || netstat.exitCode}`);
  const listeners = netstat.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).filter((fields) => (
    fields.length >= 5 && fields[0].toUpperCase() === "TCP" && fields[1].endsWith(`:${state.cdpPort}`)
      && fields[3].toUpperCase() === "LISTENING"
  ));
  if (listeners.length > 1) throw new BoundaryLauncherError(`multiple boundary CDP listeners found for port ${state.cdpPort}: ${JSON.stringify(listeners)}`);
  const listener = listeners[0];
  if (!listener) return { verified: false, reason: "owned listener not visible yet" };
  if (!listener[1].startsWith("127.0.0.1:")) throw new BoundaryLauncherError(`boundary CDP listener is not loopback-only: ${listener[1]}`);
  const listenerPid = Number(listener[4]);
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${listenerPid}';`,
    "$chain = @();",
    "for ($i = 0; $p -and $i -lt 32; $i++) {",
    "$chain += [pscustomobject]@{ProcessId=[int]$p.ProcessId;ParentProcessId=[int]$p.ParentProcessId;Name=[string]$p.Name;CommandLine=[string]$p.CommandLine;ExecutablePath=[string]$p.ExecutablePath};",
    "if ([int]$p.ParentProcessId -eq 0) { break };",
    "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = $($p.ParentProcessId)\";",
    "}",
    "$chain | ConvertTo-Json -Compress",
  ].join(" ");
  const tree = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: repositoryRoot });
  if (tree.exitCode !== 0 || !tree.stdout.trim()) throw new BoundaryLauncherError(`cannot inspect owned boundary process tree: ${tree.stderr || tree.error || tree.exitCode}`);
  const chainValue = JSON.parse(tree.stdout.trim());
  const chain = Array.isArray(chainValue) ? chainValue : [chainValue];
  const root = chain.find((entry) => Number(entry.ProcessId) === Number(state.child.pid));
  const leaf = chain[0];
  if (!root || !String(leaf?.Name || "").toLowerCase().includes("msedgewebview2")) {
    throw new BoundaryLauncherError(`boundary listener is outside owned Tauri/WebView process: ${JSON.stringify(chain)}`);
  }
  const commandLine = String(leaf.CommandLine || "");
  const profileMatch = commandLine.match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/iu);
  const actualProfile = profileMatch?.[1] || profileMatch?.[2] || profileMatch?.[3] || null;
  if (!actualProfile || normalizePath(actualProfile) !== normalizePath(state.profilePath)) throw new BoundaryLauncherError(`WebView profile mismatch: expected ${state.profilePath}, got ${actualProfile || "missing"}`);
  return { verified: true, listenerPid, chain, profilePath: state.profilePath, executable: context.executable };
}

async function waitForOwnedProcess(context, state) {
  const deadline = Date.now() + 15_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspectOwnedProcess(context, state);
    if (last.verified) return last;
    await sleep(150);
  }
  throw new BoundaryLauncherError(`timed out waiting for owned WP10 listener: ${JSON.stringify(last)}`);
}

function startOwnedProcess(context) {
  const profilePath = path.join(context.dirs.profiles, "boundary");
  assertWithin(context.runDir, profilePath, "WebView2 profile");
  const cdpPortPromise = allocatePort();
  return cdpPortPromise.then(async (cdpPort) => {
    await mkdir(profilePath, { recursive: true });
    await assertNoSymlinks(profilePath);
    const profileReal = await realpath(profilePath);
    const browserArgs = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir="${profileReal}"`,
    ].join(" ");
    const state = spawnLogged(context.executable, [], {
      cwd: repositoryRoot,
      env: cleanFrontendEnvironment({
        WEBVIEW2_USER_DATA_FOLDER: profileReal,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
        LIGHTMARK_WP10_RUN_DIR: context.runDir,
        LIGHTMARK_WP10_NONCE: context.config.nonce,
        LIGHTMARK_WP10_PROCESS_TOKEN: context.config.processToken,
        LIGHTMARK_WP10_PROFILE_TOKEN: context.config.profileToken,
      }),
      stdoutPath: path.join(context.dirs.logs, "boundary-native.stdout.log"),
      stderrPath: path.join(context.dirs.logs, "boundary-native.stderr.log"),
    });
    state.cdpPort = cdpPort;
    state.profilePath = profileReal;
    state.startedAt = monotonicMs();
    context.state = state;
    context.events.push({ kind: "process-start", pid: state.child.pid ?? null, cdpPort, profilePath: profileReal, startedAt: state.startedAt });
    return state;
  });
}

async function stopOwnedProcess(context, state, client) {
  let shutdown = null;
  if (client && !client.closed) shutdown = await client.evaluate(bridgeExpression("shutdown")).catch((error) => ({ error: error.message }));
  await client?.close();
  let exit = null;
  try {
    exit = await waitForExit(state, 30_000);
  } catch (error) {
    const kill = state.child.pid
      ? await runCaptured("taskkill.exe", ["/PID", String(state.child.pid), "/T", "/F"], { cwd: repositoryRoot })
      : null;
    exit = { error: error.message, taskkill: kill ? { exitCode: kill.exitCode, stderr: kill.stderr } : null };
  }
  await Promise.all([finishLogStream(state.stdout), finishLogStream(state.stderr)]);
  const portClosed = await waitForPortClosed(state.cdpPort);
  context.events.push({ kind: "process-stop", shutdown, exit, portClosed, stoppedAt: monotonicMs() });
  return { shutdown, exit, portClosed };
}

async function waitForPortClosed(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/list`);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

async function inspectExportedHtml(context, result) {
  const outputPath = context.config.outputPath;
  const productExportReturned = result?.exportInvocation?.method === "production-exportCurrentDocument"
    && result?.exportInvocation?.returned === true;
  if (!productExportReturned) throw new BoundaryLauncherError(`product export invocation record is missing: ${JSON.stringify(result)}`);
  if (normalizePath(result?.outputPath) !== normalizePath(outputPath)) throw new BoundaryLauncherError(`product export returned an unexpected output path: ${JSON.stringify(result)}`);
  if (normalizePath(result?.sourcePath) !== normalizePath(context.config.documentPath)
    || result?.sourceSha256 !== context.config.documentSha256) {
    throw new BoundaryLauncherError(`product export returned an unexpected source identity: ${JSON.stringify(result)}`);
  }
  assertWithin(context.runDir, outputPath, "export output");
  const output = await readFile(outputPath, "utf8");
  const resources = [];
  for (const resource of context.config.resources) {
    const sourceBytes = await readFile(resource.path);
    const payload = Buffer.from(sourceBytes).toString("base64");
    const dataUrl = `data:${resource.expectedMime};base64,${payload}`;
    const occurrences = countOccurrences(output, dataUrl);
    resources.push({
      id: resource.id,
      role: resource.role,
      source: resource.source,
      path: resource.path,
      sourceBytes: sourceBytes.byteLength,
      sourceSha256: sha256(sourceBytes),
      expectedMime: resource.expectedMime,
      dataUrlOccurrences: occurrences,
      bytesInlined: productExportReturned && occurrences > 0,
      sentinelObserved: resource.sentinel ? output.includes(resource.sentinel) : false,
      imageSignature: sourceBytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    });
    const observation = resources[resources.length - 1];
    if (observation.sourceBytes !== resource.bytes || observation.sourceSha256 !== resource.sha256) {
      throw new BoundaryLauncherError(`WP10 fixture resource changed during export: ${resource.id}`, observation);
    }
  }
  const positiveControls = resources.filter((resource) => resource.role === "allowed");
  const forbiddenObservations = resources.filter((resource) => resource.role === "forbidden-neighbor");
  const sourceBytes = await readFile(context.config.documentPath);
  const sourceUnchanged = sha256(sourceBytes) === context.config.documentSha256;
  if (!sourceUnchanged) throw new BoundaryLauncherError("WP10 fixture source changed during export; output classification is invalid.");
  return {
    outputPath,
    outputBytes: Buffer.byteLength(output, "utf8"),
    outputSha256: sha256(Buffer.from(output, "utf8")),
    productExportReturned,
    resourceObservationMethod: "exact-output-data-url-byte-correlation",
    sourceUnchanged,
    resources,
    positiveControlsPassed: positiveControls.every((resource) => resource.bytesInlined),
    forbiddenBytesObservedInOutput: forbiddenObservations.some((resource) => resource.bytesInlined),
    forbiddenObservations,
    finding: forbiddenObservations.some((resource) => resource.bytesInlined)
      ? "production export output contains exact bytes from the fixture's neighboring test resource; extension-derived MIME labeling is observable (fixture role only)"
      : "production export output did not contain the neighboring fixture resource bytes in this run",
  };
}

async function executeNative(context) {
  const state = await startOwnedProcess(context);
  let client = null;
  try {
    const target = await waitForTarget(state);
    const ownership = await waitForOwnedProcess(context, state);
    context.processOwnership.push(ownership);
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await waitForBridge(client);
    const ready = await client.evaluate(bridgeExpression("ready"));
    if (!ready || ready.schemaVersion !== BRIDGE_SCHEMA_VERSION || ready.bridgeEnabled !== true
      || ready.probeMode !== PROBE_MODE || ready.nonce !== context.config.nonce
      || ready.actualOrigin !== EXPECTED_ORIGIN || ready.expectedOrigin !== EXPECTED_ORIGIN
      || ready.profileToken !== context.config.profileToken || ready.processToken !== context.config.processToken
      || ready.editorReady !== true) {
      throw new BoundaryLauncherError(`WP10 boundary bridge identity/readiness mismatch: ${JSON.stringify(ready)}`);
    }
    const expectedPaths = context.expectedRuntimePaths;
    const actualPaths = ready.runtimePaths || {};
    const pathChecks = {};
    for (const key of ["config", "data", "local"]) {
      pathChecks[key] = {
        expected: expectedPaths[key],
        actual: actualPaths[key] || null,
        verified: normalizePath(actualPaths[key]) === normalizePath(expectedPaths[key]),
      };
      if (!pathChecks[key].verified) throw new BoundaryLauncherError(`Tauri path API mismatch for ${key}: ${JSON.stringify(pathChecks[key])}`);
    }
    context.runtimePathChecks.push({ verified: true, expected: expectedPaths, actual: actualPaths, preexisting: context.preexistingRuntimePaths });
    context.events.push({ kind: "process-ready", ready, target, ownership, runtimePaths: pathChecks, readyAt: monotonicMs() });
    const result = await client.evaluate(bridgeExpression("run"));
    context.events.push({ kind: "export-complete", result, observedAt: monotonicMs() });
    await stopOwnedProcess(context, state, client);
    client = null;
    return await inspectExportedHtml(context, result);
  } finally {
    if (client || !state.exitResult) await stopOwnedProcess(context, state, client).catch((error) => context.events.push({ kind: "cleanup-failure", error: error.message }));
  }
}

async function finalize(context, failure = null) {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: failure ? "failed" : context.nativeObservation ? "observed" : "prepared-not-launched",
    judgment: context.nativeObservation?.forbiddenBytesObservedInOutput
      ? "positive-boundary-observation-requires-product-owner-review"
      : "no-positive-boundary-observation",
    productPath: "owned native WebView -> production exportCurrentDocument -> export_document; resource inlining is classified from exact output bytes",
    finding: context.nativeObservation?.finding || null,
    failure,
    repositoryBeforeBuild: context.repository,
    repositoryAfterFrontendBuild: context.repositoryAfterFrontendBuild,
    nativeBuildInputsBefore: context.nativeBuildInputsBefore,
    nativeBuildInputsAfter: context.nativeBuildInputsAfter,
    frontendArtifactsReady: context.frontendArtifactsReady,
    build: context.build,
    artifacts: context.artifactCheck,
    isolation: {
      runDir: context.runDir,
      identifier: context.identifier,
      runtimeRoots: context.runtimeRoots,
      expectedRuntimePaths: context.expectedRuntimePaths,
      preexistingRuntimePaths: context.preexistingRuntimePaths,
      runtimePathChecks: context.runtimePathChecks,
      processOwnership: context.processOwnership,
      noArbitraryExecutable: true,
      noArbitraryCdpTarget: true,
    },
    fixture: {
      manifestPath: path.join(context.dirs.fixtures, "wp10-desktop-content-boundary.manifest.json"),
      fixtureId: context.manifest.fixtureId,
      resources: context.config.resources,
    },
    observation: context.nativeObservation,
    events: context.events,
    limitations: [
      "A filesystem-only prepare result is not product evidence.",
      "The bridge does not synthesize a read_export_resource invocation claim; resource evidence is the returned export record plus exact output-byte correlation.",
      "A positive export observation demonstrates the current path, not a complete IPC or asset-scope policy audit.",
      "No product permission or asset-scope change is applied by this probe.",
    ],
  };
  context.report = report;
  await writeJson(path.join(context.dirs.output, "wp10-boundary-report.json"), report);
  const launcherManifestPath = path.join(context.runDir, "launcher-manifest.json");
  const current = JSON.parse(await readFile(launcherManifestPath, "utf8"));
  await writeJson(launcherManifestPath, {
    ...current,
    status: report.status,
    completedAt: new Date().toISOString(),
    report: path.relative(context.runDir, path.join(context.dirs.output, "wp10-boundary-report.json")).replaceAll("\\", "/"),
    finding: report.finding,
    isolation: report.isolation,
  });
  return report;
}

export async function runWp10BoundaryLauncher(options) {
  if (process.platform !== "win32") throw new BoundaryLauncherError("WP10 boundary launcher requires Windows WebView2.");
  const context = await prepareContext(options);
  try {
    if (options.buildQa) await buildArtifacts(context);
    if (options.launch) context.nativeObservation = await executeNative(context);
    const report = await finalize(context);
    return { runDir: context.runDir, reportPath: path.join(context.dirs.output, "wp10-boundary-report.json"), status: report.status, finding: report.finding };
  } catch (error) {
    const report = await finalize(context, {
      name: error?.name || "Error",
      message: error?.message || String(error),
      details: error?.details || null,
    });
    return { runDir: context.runDir, reportPath: path.join(context.dirs.output, "wp10-boundary-report.json"), status: report.status, finding: report.finding, failure: report.failure };
  }
}

function printHelp() {
  console.log([
    "Owned Windows WP10 desktop-content boundary launcher",
    "",
    "Prepare fixture/evidence directory:",
    "  node scripts/qa/wp10-desktop-content-boundary-launcher.mjs --output DIR",
    "Build a fresh normal + QA frontend and owned QA executable:",
    "  node scripts/qa/wp10-desktop-content-boundary-launcher.mjs --build-qa --output DIR",
    "Run the one-shot owned native export probe:",
    "  node scripts/qa/wp10-desktop-content-boundary-launcher.mjs --launch --build-qa --output DIR",
    "  node scripts/qa/wp10-desktop-content-boundary-launcher.mjs --smoke --build-qa --output DIR",
    "--launch/--smoke never accepts --executable or an existing CDP target.",
  ].join("\n"));
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) printHelp();
    else {
      const result = await runWp10BoundaryLauncher(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "failed") process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ name: error?.name || "Error", message: error?.message || String(error), details: error?.details || null }, null, 2));
    process.exitCode = 1;
  }
}
