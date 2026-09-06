const cdpPort = process.env.LIGHTMARK_CDP_PORT || "9333";
const pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
const page = pages.find((item) => /^http:\/\/(?:127\.0\.0\.1|localhost):1420\//.test(item.url));
if (!page) throw new Error("LightMark development page not found.");

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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const key = async (value) => {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: value, windowsVirtualKeyCode: value === "Backspace" ? 8 : value === "ArrowLeft" ? 37 : 39 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: value, windowsVirtualKeyCode: value === "Backspace" ? 8 : value === "ArrowLeft" ? 37 : 39 });
  await wait();
};

await evaluate(`(async () => {
  const store = await import('/src/stores/appStore.ts');
  const runtime = await import('/src/editor/documentRuntime.ts');
  if (store.appStore.splitLayout.enabled) await store.toggleSplitLayout();
  await store.setActivePane('main');
  await store.switchMode('source');
  const source = await runtime.waitForDocumentSession(store.getPaneTab('main').id, 'source');
  await source.replaceMarkdown('left **bold** right');
  await store.switchMode('wysiwyg');
  await runtime.waitForDocumentSession(store.getPaneTab('main').id, 'wysiwyg');
})()`);
await wait(500);

await evaluate(`(() => {
  const text = document.querySelector('.ProseMirror strong')?.firstChild;
  if (!text) throw new Error('bold fixture was not rendered');
  const range = document.createRange();
  range.setStart(text, 0); range.collapse(true);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  document.querySelector('.ProseMirror').focus();
})()`);
await key("ArrowRight");
const revealed = await evaluate(`(() => ({
  markers: [...document.querySelectorAll('.ProseMirror .md-live-marker')].map((node) => node.textContent),
  bold: document.querySelector('.ProseMirror strong')?.textContent,
  text: document.querySelector('.ProseMirror')?.textContent,
}))()`);
if (revealed.bold !== "bold" || revealed.markers.join("") !== "****") {
  throw new Error(`inline reveal failed: ${JSON.stringify(revealed)}`);
}

await evaluate(`(() => {
  const marker = document.querySelector('.ProseMirror .md-live-marker:not([contenteditable="false"])')?.firstChild;
  const range = document.createRange(); range.setStart(marker, 0); range.collapse(true);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
})()`);
await key("ArrowLeft");
const leftExit = await evaluate(`(() => ({
  editableMarkers: document.querySelectorAll('.ProseMirror .md-live-marker:not([contenteditable="false"])').length,
  bold: document.querySelector('.ProseMirror strong')?.textContent,
}))()`);
if (leftExit.editableMarkers !== 0 || leftExit.bold !== "bold") {
  throw new Error(`left boundary exit bounced: ${JSON.stringify(leftExit)}`);
}
await key("ArrowRight");
const reentered = await evaluate(`document.querySelectorAll('.ProseMirror .md-live-marker:not([contenteditable="false"])').length`);
if (reentered !== 2) throw new Error(`first ArrowRight did not expose editable markers: ${reentered}`);

await evaluate(`(() => {
  const marker = document.querySelector('.ProseMirror .md-live-marker:not([contenteditable="false"])')?.firstChild;
  const range = document.createRange(); range.setStart(marker, 1); range.collapse(true);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
})()`);
await key("Backspace");
const removed = await evaluate(`(() => ({
  markerCount: document.querySelectorAll('.ProseMirror .md-live-marker').length,
  boldCount: document.querySelectorAll('.ProseMirror strong').length,
  text: document.querySelector('.ProseMirror')?.textContent,
}))()`);
if (removed.markerCount || removed.boldCount || removed.text !== "left bold right") {
  throw new Error(`delimiter deletion failed: ${JSON.stringify(removed)}`);
}

await evaluate(`(async () => {
  const store = await import('/src/stores/appStore.ts');
  const runtime = await import('/src/editor/documentRuntime.ts');
  await store.switchMode('source');
  const source = await runtime.waitForDocumentSession(store.getPaneTab('main').id, 'source');
  await source.replaceMarkdown('# Title');
  await store.switchMode('wysiwyg');
  await runtime.waitForDocumentSession(store.getPaneTab('main').id, 'wysiwyg');
})()`);
await wait(500);
await evaluate(`(() => {
  const text = document.querySelector('.ProseMirror h1')?.firstChild;
  const range = document.createRange(); range.setStart(text, 0); range.collapse(true);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  document.querySelector('.ProseMirror').focus();
})()`);
await key("ArrowRight");
await evaluate(`(() => {
  const marker = document.querySelector('.ProseMirror h1 .md-live-marker')?.firstChild;
  if (!marker) throw new Error('heading marker was not revealed');
  const range = document.createRange(); range.setStart(marker, 0); range.collapse(true);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  document.execCommand('insertText', false, 'x');
})()`);
await wait();
const invalidHeading = await evaluate(`document.querySelector('.ProseMirror p')?.textContent`);
if (invalidHeading !== "x# Title") throw new Error(`heading invalidation failed: ${invalidHeading}`);
await key("Backspace");
const recoveredHeadingState = await evaluate(`(() => ({
  heading: (() => {
    const node = document.querySelector('.ProseMirror h1')?.cloneNode(true);
    node?.querySelectorAll('.md-live-marker,.lm-heading-fold-toggle').forEach((marker) => marker.remove());
    return node?.textContent;
  })(),
  paragraph: document.querySelector('.ProseMirror p')?.textContent,
  html: document.querySelector('.ProseMirror')?.innerHTML,
  selection: getSelection()?.anchorNode?.textContent + '@' + getSelection()?.anchorOffset,
}))()`);
const recoveredHeading = recoveredHeadingState.heading;
if (recoveredHeading !== "Title") throw new Error(`heading recovery failed: ${JSON.stringify(recoveredHeadingState)}`);

console.log(JSON.stringify({ revealed, leftExit, reentered, removed, invalidHeading, recoveredHeading }, null, 2));
ws.close();
