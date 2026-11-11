import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const appDialog = await readFile(new URL("src/components/dialog/AppDialog.vue", root), "utf8");
const overlayFocus = await readFile(new URL("src/composables/useOverlayFocus.ts", root), "utf8");
assert.match(appDialog, /import \{ handleDialogBackdropKeydown \} from "\.\/dialogKeyboard"/);
assert.match(appDialog, /@keydown="handleBackdropKeydown"/);
assert.doesNotMatch(appDialog, /@keydown\.enter\.prevent\.stop/);
assert.match(overlayFocus, /event\.key === "Escape" && !event\.isComposing/);

const helperSource = await readFile(new URL("src/components/dialog/dialogKeyboard.ts", root), "utf8");
const overlaySource = await readFile(new URL("src/composables/useOverlayFocus.ts", root), "utf8");
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const compiledOverlay = ts.transpileModule(overlaySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
// The generated useOverlayFocus module imports Vue through Node's normal
// package resolution. Keep it below this checkout's installed dependencies.
const tempRoot = await mkdtemp(fileURLToPath(new URL("node_modules/.lightmark-app-dialog-keyboard-", root)));
const helperPath = path.join(tempRoot, "dialogKeyboard.mjs");
const overlayPath = path.join(tempRoot, "useOverlayFocus.mjs");
await writeFile(helperPath, compiled, "utf8");
await writeFile(overlayPath, compiledOverlay, "utf8");

class MiniNode {
  constructor(parent = null) {
    this.parent = parent;
    this.listeners = [];
    this.ownerDocument = parent?.ownerDocument || { activeElement: null };
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener });
  }

  contains(node) {
    for (let current = node; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function dispatchKeydown(target, key, isComposing = false) {
  let defaultPrevented = false;
  let propagationStopped = false;
  const event = {
    key,
    isComposing,
    target,
    preventDefault() { defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; },
  };
  const path = [];
  for (let node = target; node; node = node.parent) path.push(node);
  for (const node of path) {
    for (const { type, listener } of node.listeners) {
      if (type === "keydown") listener(event);
    }
    if (propagationStopped) break;
  }
  return { defaultPrevented, propagationStopped };
}

try {
  const { handleDialogBackdropKeydown } = await import(pathToFileURL(helperPath).href);
  const { handleOverlayTabKeydown, isTopmostOverlay } = await import(pathToFileURL(overlayPath).href);
  const backdrop = new MiniNode();
  const panel = new MiniNode(backdrop);
  const applyButton = new MiniNode(panel);
  const cancelButton = new MiniNode(panel);
  const input = new MiniNode(panel);
  const content = new MiniNode(panel);
  const closed = [];
  const activated = [];
  backdrop.addEventListener("keydown", (event) => handleDialogBackdropKeydown(
    event,
    backdrop,
    panel,
    "apply",
    (id) => closed.push(id),
  ));
  applyButton.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.isComposing) activated.push("apply");
  });
  cancelButton.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.isComposing) activated.push("cancel");
  });

  let result = dispatchKeydown(applyButton, "Enter");
  assert.deepEqual(activated, ["apply"], "focused apply button must receive native Enter activation");
  assert.deepEqual(closed, [], "focused apply button must not be replaced by the backdrop default");
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(cancelButton, " ");
  assert.deepEqual(activated, ["apply", "cancel"], "focused cancel button must receive native Space activation");
  assert.deepEqual(closed, []);
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(cancelButton, "Enter");
  assert.deepEqual(activated, ["apply", "cancel", "cancel"], "focused cancel button must receive native Enter activation");
  assert.deepEqual(closed, [], "focused cancel Enter must not resolve the default action");
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(input, "Enter");
  assert.deepEqual(closed, [], "an input target must not be resolved by the backdrop handler");
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(content, "Enter");
  assert.deepEqual(closed, [], "an editor/content target must not be resolved by the backdrop handler");
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(panel, "Enter");
  assert.deepEqual(closed, ["apply"], "non-interactive panel focus keeps default Enter behavior");
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.propagationStopped, true);

  result = dispatchKeydown(panel, "Enter", true);
  assert.deepEqual(closed, ["apply"], "IME Enter must not resolve the dialog");
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(cancelButton, "Enter", true);
  assert.deepEqual(activated, ["apply", "cancel", "cancel"], "IME Enter must not activate a focused button");
  assert.deepEqual(closed, ["apply"]);
  assert.equal(result.defaultPrevented, false);

  result = dispatchKeydown(backdrop, "Escape");
  assert.deepEqual(closed, ["apply"], "Escape remains owned by the overlay focus controller");
  assert.equal(result.defaultPrevented, false);

  const overlay = new MiniNode();
  const overlayPanel = new MiniNode(overlay);
  const first = new MiniNode(overlayPanel);
  const nested = new MiniNode(first);
  const last = new MiniNode(overlayPanel);
  const outside = new MiniNode();
  const focusables = [first, last];
  const overlayEvent = (shiftKey = false) => ({
    key: "Tab",
    shiftKey,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });

  overlayPanel.focus();
  let tabEvent = overlayEvent(true);
  handleOverlayTabKeydown(tabEvent, overlayPanel, focusables, overlayPanel.ownerDocument.activeElement);
  assert.equal(tabEvent.defaultPrevented, true, "initial panel Shift+Tab must stay inside the overlay");
  assert.equal(overlayPanel.ownerDocument.activeElement, last, "initial panel Shift+Tab must wrap to the last control");

  overlayPanel.focus();
  tabEvent = overlayEvent(false);
  handleOverlayTabKeydown(tabEvent, overlayPanel, focusables, overlayPanel.ownerDocument.activeElement);
  assert.equal(tabEvent.defaultPrevented, true, "initial panel Tab must stay inside the overlay");
  assert.equal(overlayPanel.ownerDocument.activeElement, first, "initial panel Tab must focus the first control");

  outside.focus();
  tabEvent = overlayEvent(true);
  handleOverlayTabKeydown(tabEvent, overlayPanel, focusables, outside.ownerDocument.activeElement);
  assert.equal(tabEvent.defaultPrevented, true, "focus outside the overlay must be pulled into the trap");
  assert.equal(overlayPanel.ownerDocument.activeElement, last);

  first.focus();
  tabEvent = overlayEvent(true);
  handleOverlayTabKeydown(tabEvent, overlayPanel, focusables, first.ownerDocument.activeElement);
  assert.equal(overlayPanel.ownerDocument.activeElement, last, "first control Shift+Tab must wrap to the last control");

  last.focus();
  tabEvent = overlayEvent(false);
  handleOverlayTabKeydown(tabEvent, overlayPanel, focusables, last.ownerDocument.activeElement);
  assert.equal(overlayPanel.ownerDocument.activeElement, first, "last control Tab must wrap to the first control");

  nested.focus();
  tabEvent = overlayEvent(false);
  handleOverlayTabKeydown(tabEvent, overlayPanel, focusables, nested.ownerDocument.activeElement);
  assert.equal(tabEvent.defaultPrevented, false, "a nested control that is inside the panel is not a boundary");

  overlayPanel.focus();
  tabEvent = overlayEvent(false);
  handleOverlayTabKeydown(tabEvent, overlayPanel, [], overlayPanel.ownerDocument.activeElement);
  assert.equal(tabEvent.defaultPrevented, true, "zero-focusable overlay must retain Tab on its panel");
  assert.equal(overlayPanel.ownerDocument.activeElement, overlayPanel);

  const lowerBackdrop = new MiniNode();
  const topBackdrop = new MiniNode();
  assert.equal(isTopmostOverlay(topBackdrop, [lowerBackdrop, topBackdrop]), true, "topmost overlay receives keyboard ownership");
  assert.equal(isTopmostOverlay(lowerBackdrop, [lowerBackdrop, topBackdrop]), false, "nested lower overlay cannot trap the topmost dialog");
  assert.equal(isTopmostOverlay(topBackdrop, [topBackdrop]), true, "single overlay is topmost");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("AppDialog keyboard event-path checks passed (MiniNode propagation model; browser native activation is not claimed).");
