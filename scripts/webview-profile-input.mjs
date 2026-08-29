import fs from "node:fs";

const output = process.argv[2] || "webview-input-profile.json";
const inputCount = Math.max(1, Number(process.env.LIGHTMARK_PROFILE_INPUTS || 1));
const editorSelector = process.env.LIGHTMARK_PROFILE_MODE === "source" ? ".cm-content" : ".ProseMirror";
const cdpPort = process.env.LIGHTMARK_CDP_PORT || "9333";
const pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
const page = pages.find((item) => /^http:\/\/(?:127\.0\.0\.1|localhost):1420\//.test(item.url));
if (!page) throw new Error("LightMark Edge page not found.");
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
  message.error ? callbacks.reject(new Error(message.error.message)) : callbacks.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const nextId = ++id;
  pending.set(nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId, method, params }));
});

if (editorSelector === ".cm-content") {
  await call("Runtime.evaluate", {
    expression: `import('/src/stores/appStore.ts').then((store) => store.switchMode('source'))`,
    awaitPromise: true,
    returnByValue: true,
  });
}

await call("Profiler.enable");
await call("Profiler.setSamplingInterval", { interval: 100 });
await call("Profiler.start");
await call("Runtime.evaluate", {
  expression: `(async () => {
    const editor = document.querySelector(${JSON.stringify(editorSelector)});
    if (!editor) throw new Error('Editor target not found: ${editorSelector}');
    editor.focus();
    const channel = new MessageChannel();
    const pending = [];
    channel.port1.onmessage = () => pending.shift()?.();
    const yieldInput = () => new Promise((resolve) => { pending.push(resolve); channel.port2.postMessage(0); });
    for (let index = 0; index < ${inputCount}; index += 1) {
      if (!document.execCommand('insertText', false, index % 2 ? 'x' : '测')) throw new Error('insertText failed');
      await yieldInput();
    }
    return true;
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
await new Promise((resolve) => setTimeout(resolve, inputCount === 1 ? 6500 : 1200));
const { profile } = await call("Profiler.stop");
fs.writeFileSync(output, JSON.stringify(profile));

const byNode = new Map(profile.nodes.map((node) => [node.id, { node, samples: 0, micros: 0 }]));
const parentById = new Map();
for (const node of profile.nodes) {
  for (const childId of node.children || []) parentById.set(childId, node.id);
}
const formatFrame = (node) => ({
  function: node.callFrame.functionName || "(anonymous)",
  url: node.callFrame.url,
  line: node.callFrame.lineNumber + 1,
});
const stackFor = (node) => {
  const stack = [formatFrame(node)];
  let parentId = parentById.get(node.id);
  while (parentId && stack.length < 16) {
    const parent = byNode.get(parentId)?.node;
    if (!parent) break;
    stack.unshift(formatFrame(parent));
    parentId = parentById.get(parentId);
  }
  return stack;
};
for (let index = 0; index < (profile.samples?.length || 0); index += 1) {
  const item = byNode.get(profile.samples[index]);
  if (!item) continue;
  item.samples += 1;
  item.micros += profile.timeDeltas?.[index] || 0;
}
const summary = [...byNode.values()]
  .filter((item) => item.samples)
  .sort((left, right) => right.micros - left.micros)
  .slice(0, 35)
  .map(({ node, samples, micros }) => ({
    ...formatFrame(node),
    samples,
    milliseconds: Math.round(micros / 100) / 10,
  }));
const converterStacks = [...byNode.values()]
  .filter(({ node, samples }) => samples && /serializeDocRangeToMarkdown|editorHtmlToMarkdown|trimTrailingNewlines/.test(node.callFrame.functionName))
  .sort((left, right) => right.micros - left.micros)
  .slice(0, 8)
  .map(({ node, micros }) => ({ milliseconds: Math.round(micros / 100) / 10, stack: stackFor(node) }));
ws.close();
console.log(JSON.stringify({ summary, converterStacks }, null, 2));
