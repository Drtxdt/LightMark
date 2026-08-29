import fs from "node:fs";
import path from "node:path";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("Usage: node scripts/webview-performance-qa.mjs <output-dir>");
fs.mkdirSync(outputDir, { recursive: true });
const sampleCount = Math.max(1, Number(process.env.LIGHTMARK_PERF_SAMPLES || 200));
const roundCount = Math.max(1, Number(process.env.LIGHTMARK_PERF_ROUNDS || 3));
const fixtureBytes = Math.max(1024, Number(process.env.LIGHTMARK_PERF_FIXTURE_BYTES || 1024 * 1024));

const prose = Array.from({ length: 32 }, (_, index) => `混合 Markdown 性能正文 ${index}，包含中文、ASCII、标点与 [[Wiki Link]]。`).join(" ");
const unit = [
  "# 性能夹具", "", `${prose} **bold** $x^2$`, "", "- item", "- [ ] task", "",
  "| a | b |", "| - | - |", "| 1 | 2 |", "", "```ts", "const x = 1", "```", "",
  "$$", "E = mc^2", "$$", "", "",
].join("\n");
let fixture = "";
for (let group = 0; Buffer.byteLength(fixture, "utf8") < fixtureBytes; group += 1) {
  fixture += `${unit}${group % 100 === 0 ? "```mermaid\ngraph TD; A-->B\n```\n\n" : ""}`;
}
const oracleFixtures = [
  "# 标题\n\n段落 **bold** 与 ![image](asset.png)\n",
  "- first\n- second\n\nfollowing\n",
  "1. ordered\n2. next\n\n- bullet\n\nfollowing\n",
  "> quote one\n>\n> quote two\n\nfollowing\n",
  "| a | b |\n| --- | :---: |\n| 1 | 2 |\n\nfollowing\n",
  "```ts\nconst value = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n",
  "inline $x+1$ and escaped \\$\n\n$$\nE=mc^2\n$$\n",
  "<section data-kind=\"raw\">\nraw html\n</section>\n\nfollowing\n",
  "paragraph[^note]\n\n[^note]: footnote body\n",
  "first\n\n\n\nsecond\n",
];

const cdpPort = process.env.LIGHTMARK_CDP_PORT || "9333";
const pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
const page = pages.find((item) => /^(?:http:\/\/(?:127\.0\.0\.1|localhost):1420\/|https?:\/\/tauri\.localhost\/|tauri:\/\/localhost\/)/.test(item.url));
if (!page) throw new Error("LightMark Edge page not found.");
const isDevPage = /^http:\/\/(?:127\.0\.0\.1|localhost):1420\//.test(page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const callbacks = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) callbacks.reject(new Error(message.error.message));
  else callbacks.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const nextId = ++id;
  pending.set(nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description || ""}`);
  }
  return result.result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });
await wait(800);

await evaluate(`(async () => {
  let session;
  let tabId = '';
  localStorage.setItem('lightmark:verify-wysiwyg-snapshot', '1');
  if (${JSON.stringify(isDevPage)}) {
    const store = await import('/src/stores/appStore.ts');
    if (store.appStore.splitLayout.enabled) await store.toggleSplitLayout();
    await store.setActivePane('main');
    store.appStore.settings.editor.focusMode = false;
    store.appStore.settings.editor.typewriterMode = false;
    window.dispatchEvent(new CustomEvent('lightmark:writing-modes-changed'));
    await store.switchMode('source');
    const runtime = await import('/src/editor/documentRuntime.ts');
    const tab = store.getPaneTab('main');
    tab.path = '';
    tab.fileSnapshot = undefined;
    store.appStore.currentFilePath = '';
    session = await runtime.waitForDocumentSession(tab.id, 'source');
    tabId = tab.id;
  } else {
    const qa = window.__LIGHTMARK_PERFORMANCE_QA__;
    if (!qa?.prepare) throw new Error('This release build does not contain the opt-in performance QA bridge');
    tabId = await qa.prepare('source');
    session = await qa.waitForMode('source');
  }
  await session.replaceMarkdown(${JSON.stringify(fixture)});
  window.__lmPerfObserver?.disconnect();
  window.__lmPerf = { longTasks: [] };
  window.__lmPerfObserver = new PerformanceObserver((list) => {
    for (const item of list.getEntries()) window.__lmPerf.longTasks.push({ start: item.startTime, duration: item.duration });
  });
  window.__lmPerfObserver.observe({ type: 'longtask' });
  return { tabId, revision: session.revision };
})()`);
await wait(1000);

const sourceReport = await evaluate(`(async () => {
  let session;
  if (${JSON.stringify(isDevPage)}) {
    const runtime = await import('/src/editor/documentRuntime.ts');
    const store = await import('/src/stores/appStore.ts');
    session = runtime.documentSessionForTab(store.getPaneTab('main').id);
  } else {
    session = window.__LIGHTMARK_PERFORMANCE_QA__.session('main');
  }
  const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const taskQueue = [];
  const taskChannel = new MessageChannel();
  taskChannel.port1.onmessage = () => taskQueue.shift()?.();
  const yieldInput = () => new Promise((resolve) => { taskQueue.push(resolve); taskChannel.port2.postMessage(0); });
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const run = async (name, offset) => {
    session.navigate({ offset });
    await raf(); await raf();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const content = document.querySelector('.cm-content');
    content.focus();
    const inputStarted = performance.now();
    const samples = [];
    for (let index = 0; index < ${sampleCount}; index += 1) {
      const started = performance.now();
      if (!document.execCommand('insertText', false, index % 2 ? 'x' : '测')) throw new Error('CodeMirror insertText failed');
      samples.push(performance.now() - started);
      await yieldInput();
    }
    for (let index = 0; index < ${sampleCount}; index += 1) {
      const started = performance.now();
      if (!document.execCommand('delete', false)) throw new Error('CodeMirror delete failed');
      samples.push(performance.now() - started);
      await yieldInput();
    }
    await raf();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const inputEnded = performance.now();
    const longTasks = window.__lmPerf.longTasks.filter((item) => item.duration > 50 && item.start >= inputStarted && item.start < inputEnded);
    return { name, count: samples.length, p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99), max: Math.max(...samples), longTasks };
  };
  const length = (await session.snapshot('externalDiff')).markdown.length;
  await run('warmup-middle', Math.floor(length / 2));
  await run('warmup-tail', length);
  const rounds = [];
  for (let round = 1; round <= ${roundCount}; round += 1) {
    rounds.push({ round, middle: await run('middle', Math.floor(length / 2)), tail: await run('tail', length) });
  }
  const derived = session.derivedState();
  return { mode: 'source', length, rounds, derived: { ...derived, outline: undefined, outlineItems: derived.outline?.length || 0 } };
})()`);
fs.writeFileSync(path.join(outputDir, "webview-performance-source-partial.json"), JSON.stringify(sourceReport, null, 2));

await evaluate(`(async () => {
  if (${JSON.stringify(isDevPage)}) {
    const store = await import('/src/stores/appStore.ts');
    await store.switchMode('wysiwyg');
  } else {
    const qa = window.__LIGHTMARK_PERFORMANCE_QA__;
    await qa.prepare('wysiwyg');
    await qa.waitForMode('wysiwyg');
  }
  return true;
})()`);
await wait(2500);

const wysiwygReport = await evaluate(`(async () => {
  let session;
  if (${JSON.stringify(isDevPage)}) {
    const runtime = await import('/src/editor/documentRuntime.ts');
    const store = await import('/src/stores/appStore.ts');
    session = runtime.documentSessionForTab(store.getPaneTab('main').id);
  } else {
    session = window.__LIGHTMARK_PERFORMANCE_QA__.session('main');
  }
  const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const taskQueue = [];
  const taskChannel = new MessageChannel();
  taskChannel.port1.onmessage = () => taskQueue.shift()?.();
  const yieldInput = () => new Promise((resolve) => { taskQueue.push(resolve); taskChannel.port2.postMessage(0); });
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const placeCaret = (fraction) => {
    const editor = document.querySelector('.ProseMirror');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, { acceptNode: (node) => {
      if (!node.nodeValue?.length) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('[contenteditable="false"],pre,.math-node,.mermaid-node')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    } });
    const nodes = [];
    let total = 0;
    while (walker.nextNode()) { nodes.push(walker.currentNode); total += walker.currentNode.nodeValue.length; }
    let target = Math.floor(total * fraction);
    let node = nodes.at(-1), offset = node?.nodeValue.length || 0;
    for (const candidate of nodes) {
      if (target <= candidate.nodeValue.length) { node = candidate; offset = target; break; }
      target -= candidate.nodeValue.length;
    }
    editor.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.setStart(node, Math.min(offset, node.nodeValue.length));
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    node.parentElement?.scrollIntoView({ block: 'center' });
  };
  const run = async (name, fraction) => {
    placeCaret(fraction);
    await raf(); await raf();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const inputStarted = performance.now();
    const samples = [];
    for (let index = 0; index < ${sampleCount}; index += 1) {
      const started = performance.now();
      if (!document.execCommand('insertText', false, index % 2 ? 'x' : '测')) throw new Error('ProseMirror insertText failed');
      samples.push(performance.now() - started);
      await yieldInput();
    }
    for (let index = 0; index < ${sampleCount}; index += 1) {
      const started = performance.now();
      if (!document.execCommand('delete', false)) throw new Error('ProseMirror delete failed');
      samples.push(performance.now() - started);
      await yieldInput();
    }
    await raf();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const inputEnded = performance.now();
    const longTasks = window.__lmPerf.longTasks.filter((item) => item.duration > 50 && item.start >= inputStarted && item.start < inputEnded);
    return { name, count: samples.length, p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99), max: Math.max(...samples), longTasks };
  };
  const rounds = [];
  await run('warmup-middle', .5);
  await run('warmup-tail', 1);
  for (let round = 1; round <= ${roundCount}; round += 1) {
    rounds.push({ round, middle: await run('middle', .5), tail: await run('tail', 1) });
  }
  const verifiedSnapshot = await session.snapshot('externalDiff');
  const derived = session.derivedState();
  const cacheBeforeEdit = session.derivedState().snapshotDiagnostics;
  document.querySelector('.ProseMirror')?.focus();
  const editableText = Array.from(document.querySelectorAll('.ProseMirror p'))
    .flatMap((element) => Array.from(element.childNodes))
    .find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.length);
  if (!editableText) throw new Error('No editable WYSIWYG text block found for cache reuse check');
  const editRange = document.createRange();
  editRange.setStart(editableText, Math.min(1, editableText.nodeValue.length));
  editRange.collapse(true);
  const editSelection = getSelection();
  editSelection.removeAllRanges();
  editSelection.addRange(editRange);
  if (!document.execCommand('insertText', false, '增')) throw new Error('WYSIWYG cache reuse insertion failed');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await session.snapshot('externalDiff');
  const cacheAfterEdit = session.derivedState().snapshotDiagnostics;
  const cacheReuse = {
    serializedDelta: (cacheAfterEdit?.serializedBlocks || 0) - (cacheBeforeEdit?.serializedBlocks || 0),
    reusedDelta: (cacheAfterEdit?.reusedBlocks || 0) - (cacheBeforeEdit?.reusedBlocks || 0),
    diagnostics: cacheAfterEdit,
  };
  if (cacheReuse.serializedDelta > 3 || cacheReuse.reusedDelta < 1 || cacheAfterEdit?.compatibility !== 'compatible') {
    throw new Error('WYSIWYG localized edit did not reuse immutable blocks: ' + JSON.stringify(cacheReuse));
  }
  const oracleCases = [];
  for (const [index, markdown] of ${JSON.stringify(oracleFixtures)}.entries()) {
    await session.replaceMarkdown(markdown);
    const snapshot = await session.snapshot('externalDiff');
    const diagnostics = session.derivedState().snapshotDiagnostics;
    oracleCases.push({ index, markdownLength: markdown.length, snapshotLength: snapshot.markdown.length, diagnostics });
    if (diagnostics?.compatibility !== 'compatible') {
      throw new Error('WYSIWYG oracle fixture ' + index + ' failed: ' + JSON.stringify(diagnostics));
    }
  }
  const startup = Object.fromEntries(Object.entries(window.__LIGHTMARK_STARTUP_METRICS__ || {}).map(([stage, metric]) => [stage, {
    readyAt: metric.readyAt,
    jsBytes: metric.jsBytes,
    resourceCount: metric.resources.length,
  }]));
  localStorage.removeItem('lightmark:verify-wysiwyg-snapshot');
  return {
    mode: 'wysiwyg',
    rounds,
    verifiedSnapshotLength: verifiedSnapshot.markdown.length,
    cacheReuse,
    oracleCases,
    derived: { ...derived, outline: undefined, outlineItems: derived.outline?.length || 0 },
    startup,
  };
})()`);

const screenshot = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
fs.writeFileSync(path.join(outputDir, "webview-performance-1200x780.png"), Buffer.from(screenshot.data, "base64"));
const report = {
  generatedAt: new Date().toISOString(),
  configuration: { environment: isDevPage ? "dev" : "release", samplesPerOperation: sampleCount, rounds: roundCount },
  fixture: { utf8Bytes: Buffer.byteLength(fixture, "utf8"), utf16Length: fixture.length },
  source: sourceReport,
  wysiwyg: wysiwygReport,
  semanticChecks: {
    outlineParity: sourceReport.derived.outlineItems === wysiwygReport.derived.outlineItems,
    wysiwygSnapshotOracleParity: wysiwygReport.derived.snapshotDiagnostics?.compatibility === "compatible",
  },
};
const p95Failures = [report.source, report.wysiwyg].flatMap((modeReport) =>
  modeReport.rounds.flatMap((round) => [round.middle, round.tail]
    .filter((sample) => sample.p95 > 16)
    .map((sample) => `${modeReport.mode} round ${round.round} ${sample.name}: P95=${sample.p95.toFixed(2)}ms`)),
);
fs.writeFileSync(path.join(outputDir, "webview-performance-report.json"), JSON.stringify(report, null, 2));
if (!report.semanticChecks.outlineParity) {
  throw new Error(`Fixture outline parity failed: source=${sourceReport.derived.outlineItems}, wysiwyg=${wysiwygReport.derived.outlineItems}`);
}
if (!report.semanticChecks.wysiwygSnapshotOracleParity) {
  throw new Error(`WYSIWYG block snapshot did not match the full converter oracle: ${JSON.stringify(wysiwygReport.derived.snapshotDiagnostics)}`);
}
if (p95Failures.length > 0) throw new Error(`WebView2 P95 gate failed:\n${p95Failures.join("\n")}`);
ws.close();
console.log(JSON.stringify(report, null, 2));
