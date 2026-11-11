import { appConfigDir, appDataDir, appLocalDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  appStore,
  getPaneContent,
  getPaneDocumentMode,
  getPaneEditorMode,
  getPaneTab,
  openFile,
  setActivePane,
} from "./stores/appStore";
import { documentSessionForPane, type DocumentSessionAdapter } from "./editor/documentRuntime";
import { exportCurrentDocument } from "./utils/export";

const BRIDGE_SCHEMA_VERSION = 1;
const PROBE_MODE = "wp10-desktop-content-boundary";
const FIXTURE_ID = "wp10-export-resource-boundary";
const DEFAULT_TIMEOUT_MS = 15_000;

interface BoundaryResource {
  id: string;
  source: string;
  path: string;
  role: "allowed" | "forbidden-neighbor";
  sha256: string;
  bytes: number;
  expectedMime: string;
  sentinel?: string;
}

interface BoundaryConfig {
  schemaVersion: number;
  nonce: string;
  expectedOrigin: string;
  profileToken: string;
  processToken: string;
  probeMode: string;
  fixtureRoot: string;
  documentPath: string;
  documentSha256: string;
  outputRoot: string;
  outputPath: string;
  resources: BoundaryResource[];
}

interface ActiveBoundaryFixture {
  tabId: string;
  session: DocumentSessionAdapter;
  baselineText: string;
}

interface BoundaryQaBridge {
  readonly schemaVersion: number;
  readonly bridgeEnabled: true;
  ready(): Promise<Record<string, unknown>>;
  run(): Promise<Record<string, unknown>>;
  shutdown(): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    __LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__?: BoundaryQaBridge;
  }
}

function envValue(name: string) {
  return (import.meta.env as ImportMetaEnv & Record<string, string | undefined>)[name];
}

function normalizedPath(value: string) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function isOwnedPath(root: string, candidate: string) {
  const parent = normalizedPath(root);
  const child = normalizedPath(candidate);
  return child === parent || child.startsWith(`${parent}/`);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`WP10 desktop boundary QA configuration is missing ${field}.`);
  }
  return value;
}

function parseConfig(): BoundaryConfig {
  const raw = envValue("VITE_LIGHTMARK_PERF_CONFIG_JSON");
  if (!raw) throw new Error("WP10 desktop boundary QA configuration is missing.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`WP10 desktop boundary QA configuration is not JSON: ${String(error)}`);
  }
  if (!value || typeof value !== "object") throw new Error("WP10 desktop boundary QA configuration is not an object.");
  const config = value as Partial<BoundaryConfig>;
  if (config.schemaVersion !== BRIDGE_SCHEMA_VERSION || config.probeMode !== PROBE_MODE) {
    throw new Error("Unsupported WP10 desktop boundary QA schema or probe mode.");
  }
  const fixtureRoot = requiredString(config.fixtureRoot, "fixtureRoot");
  const documentPath = requiredString(config.documentPath, "documentPath");
  const documentSha256 = requiredString(config.documentSha256, "documentSha256");
  const outputRoot = requiredString(config.outputRoot, "outputRoot");
  const outputPath = requiredString(config.outputPath, "outputPath");
  requiredString(config.nonce, "nonce");
  requiredString(config.expectedOrigin, "expectedOrigin");
  requiredString(config.profileToken, "profileToken");
  requiredString(config.processToken, "processToken");
  if (!/^[a-f0-9]{64}$/iu.test(documentSha256)) {
    throw new Error("WP10 boundary document hash is invalid.");
  }
  if (!isOwnedPath(fixtureRoot, documentPath)) {
    throw new Error("WP10 boundary document escapes the fixture root.");
  }
  if (!isOwnedPath(outputRoot, outputPath)) {
    throw new Error("WP10 boundary output escapes the owned output root.");
  }
  if (!Array.isArray(config.resources) || config.resources.length !== 4) {
    throw new Error("WP10 boundary resource catalog must contain the four fixed resources.");
  }
  const resources = config.resources.map((rawResource) => {
    if (!rawResource || typeof rawResource !== "object") throw new Error("Invalid WP10 boundary resource entry.");
    const resource = rawResource as Partial<BoundaryResource>;
    const id = resource.id;
    const source = resource.source;
    const resourcePath = resource.path;
    const role = resource.role;
    const expectedMime = resource.expectedMime;
    const resourceSha256 = resource.sha256;
    const bytes = resource.bytes;
    if (typeof id !== "string" || typeof source !== "string" || typeof resourcePath !== "string"
      || (resource.role !== "allowed" && resource.role !== "forbidden-neighbor")
      || typeof expectedMime !== "string" || typeof resourceSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(resourceSha256)
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Invalid WP10 boundary resource entry: ${String(resource.id)}`);
    }
    if (!isOwnedPath(fixtureRoot, resourcePath)) {
      throw new Error(`WP10 boundary resource escapes the fixture root: ${id}`);
    }
    return {
      ...resource,
      id,
      source,
      path: resourcePath,
      role: role as BoundaryResource["role"],
      expectedMime,
      sha256: resourceSha256,
      bytes,
    } as BoundaryResource;
  });
  const ids = resources.map((resource) => resource.id);
  if (new Set(ids).size !== ids.length
    || JSON.stringify(ids) !== JSON.stringify([
      "allowed-same-directory",
      "allowed-parent-directory",
      "forbidden-pseudo-image",
      "forbidden-text-resource",
    ])) {
    throw new Error("WP10 boundary resource catalog identity mismatch.");
  }
  return { ...config, resources } as BoundaryConfig;
}

function assertOrigin(config: BoundaryConfig) {
  const actual = typeof globalThis.location !== "undefined" ? globalThis.location.origin : "unknown";
  if (actual !== config.expectedOrigin) throw new Error(`WP10 boundary origin mismatch: expected ${config.expectedOrigin}, got ${actual}`);
}

async function waitFor<T>(label: string, predicate: () => T | null | false) {
  const deadline = performance.now() + DEFAULT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
  throw new Error(`WP10 boundary ${label} timed out.`);
}

async function digestText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readRuntimePaths() {
  const [config, data, local] = await Promise.all([
    appConfigDir(),
    appDataDir(),
    appLocalDataDir(),
  ]);
  return { config, data, local };
}

async function openBoundaryFixture(config: BoundaryConfig): Promise<ActiveBoundaryFixture> {
  await setActivePane("main");
  await openFile(config.documentPath, { recordNavigation: false, paneId: "main" });
  const tab = await waitFor("fixture tab", () => {
    const current = getPaneTab("main");
    return current && normalizedPath(current.path) === normalizedPath(config.documentPath) ? current : null;
  });
  if (getPaneDocumentMode("main") !== "normal") throw new Error("WP10 boundary fixture unexpectedly opened in large mode.");
  const editorMode = getPaneEditorMode("main");
  const session = await waitFor("document session", () => {
    const current = documentSessionForPane("main");
    return current && current.tabId === tab.id && current.mode === editorMode ? current : null;
  });
  const baselineText = getPaneContent("main");
  const baselineSha256 = await digestText(baselineText);
  if (baselineSha256 !== config.documentSha256) {
    throw new Error(`WP10 boundary fixture content changed before export: expected ${config.documentSha256}, got ${baselineSha256}`);
  }
  return { tabId: tab.id, session, baselineText };
}

function assertActive(config: BoundaryConfig, active: ActiveBoundaryFixture | null) {
  if (!active) throw new Error("WP10 boundary fixture is not active.");
  if (appStore.splitLayout.activePaneId !== "main") throw new Error("WP10 boundary requires the main pane to remain active.");
  const tab = getPaneTab("main");
  if (!tab || tab.id !== active.tabId || normalizedPath(tab.path) !== normalizedPath(config.documentPath)
    || getPaneDocumentMode("main") !== "normal") {
    throw new Error("WP10 boundary active tab/path/document mode changed before the operation.");
  }
  const session = documentSessionForPane("main");
  if (session !== active.session || session.tabId !== active.tabId || session.mode !== getPaneEditorMode("main")) {
    throw new Error("WP10 boundary document session changed before the operation.");
  }
  return tab;
}

function resourceSummary(config: BoundaryConfig) {
  return config.resources.map((resource) => ({
    id: resource.id,
    source: resource.source,
    role: resource.role,
    expectedMime: resource.expectedMime,
    sha256: resource.sha256,
    bytes: resource.bytes,
    sentinel: resource.sentinel || null,
  }));
}

function createBridge(config: BoundaryConfig): BoundaryQaBridge {
  let active: ActiveBoundaryFixture | null = null;
  let completed = false;
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    bridgeEnabled: true,
    async ready() {
      assertOrigin(config);
      const runtimePaths = await readRuntimePaths();
      active = await openBoundaryFixture(config);
      return {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        bridgeEnabled: true,
        nonce: config.nonce,
        expectedOrigin: config.expectedOrigin,
        actualOrigin: location.origin,
        profileToken: config.profileToken,
        processToken: config.processToken,
        probeMode: config.probeMode,
        fixtureId: FIXTURE_ID,
        editorReady: true,
        editorReadySignal: "owned normal document session",
        tabId: active.tabId,
        runtimePaths,
        resources: resourceSummary(config),
      };
    },
    async run() {
      assertOrigin(config);
      if (completed) throw new Error("WP10 boundary export has already completed.");
      const tab = assertActive(config, active);
      if (!active) throw new Error("WP10 boundary active fixture disappeared.");
      if (tab.isDirty) throw new Error("WP10 boundary fixture was dirty before export.");
      const markdown = getPaneContent("main");
      const markdownSha256 = await digestText(markdown);
      if (markdownSha256 !== config.documentSha256) throw new Error("WP10 boundary source changed before export.");
      const result = await exportCurrentDocument({
        target: "html",
        currentPath: config.documentPath,
        markdown,
        settings: appStore.settings.export,
        outputPath: config.outputPath,
        overwrite: false,
      });
      completed = true;
      return {
        fixtureId: FIXTURE_ID,
        result,
        outputPath: config.outputPath,
        sourcePath: config.documentPath,
        sourceSha256: markdownSha256,
        resources: resourceSummary(config),
        exportInvocation: {
          method: "production-exportCurrentDocument",
          returned: true,
          outputPath: config.outputPath,
        },
        resourceObservation: {
          status: "pending-launcher-output-correlation",
          method: "exact-output-bytes-and-hash",
          productCommandCall: "not separately instrumented by this bridge",
        },
      };
    },
    async shutdown() {
      assertOrigin(config);
      if (active) assertActive(config, active);
      active = null;
      window.setTimeout(() => { void getCurrentWindow().close(); }, 0);
      return { scheduled: true, processToken: config.processToken, method: "owned-current-window-close" };
    },
  };
}

export function installDesktopContentBoundaryQaBridge() {
  if (window.__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__) throw new Error("WP10 boundary QA bridge is already installed.");
  const config = parseConfig();
  assertOrigin(config);
  const bridge = createBridge(config);
  window.__LIGHTMARK_DESKTOP_BOUNDARY_QA_BRIDGE__ = bridge;
  return bridge;
}
