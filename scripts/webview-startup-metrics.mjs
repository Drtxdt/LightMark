import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const output = process.argv[2];
const requestedMode = process.env.LIGHTMARK_STARTUP_MODE;
const cdpPort = process.env.LIGHTMARK_CDP_PORT || "9333";
const pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
const page = pages.find((item) => item.type === "page" && /(?:tauri\.localhost|localhost:1420|127\.0\.0\.1:1420)/.test(item.url));
if (!page) throw new Error("LightMark WebView2 page not found.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const callbacks = pending.get(message.id);
  if (!callbacks) return;
  pending.delete(message.id);
  message.error ? callbacks.reject(new Error(message.error.message)) : callbacks.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const nextId = ++id;
  pending.set(nextId, { resolve, reject });
  socket.send(JSON.stringify({ id: nextId, method, params }));
});

if (requestedMode === "source" || requestedMode === "wysiwyg") {
  const ariaLabel = requestedMode === "source" ? "源代码" : "编辑";
  await call("Runtime.evaluate", {
    expression: `(async () => {
      const button = document.querySelector('button[aria-label="${ariaLabel}"]');
      if (!button) throw new Error('Editor mode button not found: ${ariaLabel}');
      if (!button.classList.contains('active')) button.click();
      const started = performance.now();
      while (!window.__LIGHTMARK_STARTUP_METRICS__?.${requestedMode}) {
        if (performance.now() - started > 10000) throw new Error('Editor startup metric timed out: ${requestedMode}');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
}

const result = await call("Runtime.evaluate", {
  expression: `(() => {
    const resources = performance.getEntriesByType('resource').filter((entry) => /\\.m?js(?:\\?|$)/i.test(entry.name)).map((entry) => ({
      name: entry.name,
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
      startTime: entry.startTime,
      responseEnd: entry.responseEnd,
    }));
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      capturedAt: new Date().toISOString(),
      url: location.href,
      stages: window.__LIGHTMARK_STARTUP_METRICS__ || {},
      totals: {
        transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        encodedBytes: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        decodedBytes: resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        jsResources: resources.length,
        domContentLoaded: navigation?.domContentLoadedEventEnd || 0,
        loadEventEnd: navigation?.loadEventEnd || 0,
      },
      resources,
    };
  })()`,
  returnByValue: true,
});
if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
const report = result.result.value;
const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "startup-baseline.json");
if (fs.existsSync(baselinePath)) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const allowance = (value) => Math.max(baseline.allowance.minimumBytes, value * baseline.allowance.percent / 100);
  const comparisons = [];
  const compare = (name, actual, expected) => {
    if (actual == null || expected == null) return;
    const limit = Math.round(expected + allowance(expected));
    comparisons.push({ name, actual, baseline: expected, limit, passed: actual <= limit });
  };
  compare("shell", report.stages.shell?.jsBytes, baseline.rawJsBytes.shell);
  compare("wysiwygReady", report.stages.wysiwyg?.jsBytes, baseline.rawJsBytes.wysiwygReady);
  compare("sourceReadyAfterModeLoad", report.stages.source?.jsBytes, baseline.rawJsBytes.sourceReadyAfterModeLoad);
  if (report.stages.source) compare("sourceWorkerSettledAfterModeLoad", report.totals.transferBytes, baseline.rawJsBytes.sourceWorkerSettledAfterModeLoad);
  report.baselineComparison = comparisons;
  if (process.env.LIGHTMARK_STARTUP_ENFORCE === "1" && comparisons.some((item) => !item.passed)) {
    throw new Error(`Startup JS baseline exceeded: ${comparisons.filter((item) => !item.passed).map((item) => item.name).join(", ")}`);
  }
}
socket.close();
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
