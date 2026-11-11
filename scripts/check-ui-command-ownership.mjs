import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

function scriptOf(file) {
  return fs.readFileSync(file, 'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1]
    ?? fs.readFileSync(file, 'utf8');
}
function functionOf(file, name) {
  const source = scriptOf(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `${file} must contain ${name}`);
  return ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

for (const [name, action] of [['QuickOpenPalette', 'handleEnter'], ['FormulaJumpPalette', 'jumpSelected']]) {
  const moved = [], entered = [];
  const context = vm.createContext({ moveSelection: value => moved.push(value), [action]: value => entered.push(value) });
  vm.runInContext(functionOf(`src/components/command/${name}.vue`, 'handleNavigationKey'), context);
  const key = (value, composing = false, keyCode = 0) => {
    let prevented = false;
    const event = { key: value, isComposing: composing, keyCode, preventDefault() { prevented = true; } };
    context.handleNavigationKey(event);
    return prevented;
  };
  assert.equal(key('Enter', true), false);
  assert.equal(key('ArrowDown', false, 229), false);
  assert.equal(key('ArrowUp', true), false);
  assert.equal(key('a'), false);
  assert.equal(key('ArrowDown'), true);
  assert.equal(key('ArrowUp'), true);
  assert.equal(key('Enter'), true);
  assert.deepEqual(moved, [1, -1]);
  assert.equal(entered.length, 1);
}

const layout = scriptOf('src/components/layout/AppLayout.vue');
const sidebar = layout.match(/const sidebarVisible = computed\(\(\) => \{([\s\S]*?)\n\}\);/);
assert.ok(sidebar);
const sidebarContext = vm.createContext({ appStore: { settings: { appearance: {} }, distractionFreeMode: false, currentWorkspace: '' } });
vm.runInContext(`function visible() { ${sidebar[1]} }`, sidebarContext);
const appearance = sidebarContext.appStore.settings.appearance;
appearance.sidebarPreference = 'auto';
assert.equal(sidebarContext.visible(), false);
sidebarContext.appStore.currentWorkspace = 'E:/notes';
assert.equal(sidebarContext.visible(), true);
appearance.sidebarPreference = 'hidden';
assert.equal(sidebarContext.visible(), false);
appearance.sidebarPreference = 'shown';
sidebarContext.appStore.currentWorkspace = '';
assert.equal(sidebarContext.visible(), true);
sidebarContext.appStore.distractionFreeMode = true;
assert.equal(sidebarContext.visible(), false);

const calls = [];
let resumeCompression;
const appStore = { currentFilePath: 'E:/A/a.md', documentMode: 'normal', settings: { image: {
  assetFolder: 'assets-a', ensureDotSlash: true, escapePath: true, useRelativePath: true,
} } };
const exports = {};
const context = vm.createContext({
  exports, Uint8Array, Date,
  require(name) {
    if (name === '@tauri-apps/api/core') return { isTauri: () => false, invoke: async (command, payload) => { calls.push({ command, payload }); return 'assets-a/a b.png'; } };
    if (name === '../stores/appStore') return { appStore, refreshFileTree: async () => {} };
    if (name === './imageCompression') return { processPastedImage: async file => {
      await new Promise(resolve => { resumeCompression = resolve; });
      return { file, originalBytes: 3, outputBytes: 3, compressed: false };
    } };
    throw new Error(`Unexpected dependency ${name}`);
  },
});
const compiled = ts.transpileModule(fs.readFileSync('src/utils/imageAssets.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
vm.runInContext(compiled, context);
const file = { name: 'a b.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
const pending = exports.saveImagesAsMarkdown([file], { source: 'clipboard' });
appStore.currentFilePath = 'E:/B/b.md';
appStore.settings.image.assetFolder = 'assets-b';
appStore.settings.image.ensureDotSlash = false;
appStore.settings.image.escapePath = false;
resumeCompression();
assert.equal(await pending, '![a b](./assets-a/a%20b.png)');
assert.equal(calls[0].payload.markdownPath, 'E:/A/a.md');
assert.equal(calls[0].payload.assetFolder, 'assets-a');
const target = exports.captureImageAssetTarget();
assert.equal(Object.isFrozen(target), true);
assert.equal(Object.isFrozen(target.settings), true);
appStore.currentFilePath = 'E:/C/c.md';
await exports.imagePathsAsMarkdown(['E:/photo.png'], target);
assert.equal(calls[1].payload.markdownPath, 'E:/B/b.md');

// Use Turndown's existing DOM implementation to exercise the production
// renderer with a different document active in the other pane.
const requireHere = createRequire(import.meta.url);
const dom = createRequire(requireHere.resolve('turndown'))('@mixmark-io/domino').createWindow('');
Object.assign(context, { document: dom.document, Node: dom.Node, HTMLImageElement: dom.HTMLImageElement });
const markup = '<p><img src="cover.svg" alt="cover"></p>';
for (const [owner, expected] of [['E:/A/a.md', 'E:/A/cover.svg'], ['E:/B/b.md', 'E:/B/cover.svg'], ['', 'cover.svg']]) {
  const template = dom.document.createElement('template');
  template.innerHTML = exports.resolveRenderedImageSources(markup, owner);
  const img = template.content.querySelector('img');
  assert.equal(img.getAttribute('src'), expected);
  assert.equal(exports.markdownImageSourceFromElement(img), 'cover.svg');
}

// The overflow menu executes the component's production keyboard handler.
const menuButtons = Array.from({ length: 4 }, () => ({ focus() { menuContext.document.activeElement = this; } }));
let closed = false;
const menuContext = vm.createContext({
  overflowPanel: { value: { querySelectorAll: () => menuButtons } },
  document: { activeElement: menuButtons[0] }, closeOverflow: () => { closed = true; },
});
vm.runInContext(functionOf('src/components/layout/Toolbar.vue', 'handleOverflowKeys'), menuContext);
function menuKey(key, isComposing = false) {
  let prevented = false;
  menuContext.handleOverflowKeys({ key, isComposing, preventDefault() { prevented = true; } });
  return prevented;
}
assert.equal(menuKey('ArrowUp'), true);
assert.equal(menuContext.document.activeElement, menuButtons[3]);
menuKey('Home');
assert.equal(menuContext.document.activeElement, menuButtons[0]);
menuKey('End');
assert.equal(menuContext.document.activeElement, menuButtons[3]);
menuKey('ArrowDown');
assert.equal(menuContext.document.activeElement, menuButtons[0]);
assert.equal(menuKey('Escape', true), false);
assert.equal(closed, false);
assert.equal(menuKey('Escape'), true);
assert.equal(closed, true);

const failures = { value: new Map() };
const failureContext = vm.createContext({ failures });
vm.runInContext(functionOf('src/components/layout/SaveFailureNotice.vue', 'recordFailure'), failureContext);
vm.runInContext(functionOf('src/components/layout/SaveFailureNotice.vue', 'recordSuccess'), failureContext);
failureContext.recordFailure({ detail: { tabId: 'background-A', message: 'disk full A' } });
failureContext.recordFailure({ detail: { tabId: 'active-B', message: 'readonly B' } });
assert.equal(failures.value.get('background-A'), 'disk full A');
failureContext.recordSuccess({ detail: { tabId: 'active-B' } });
assert.equal(failures.value.has('active-B'), false);
assert.equal(failures.value.get('background-A'), 'disk full A');

let shortcutListener;
const shortcutExports = {};
const shortcutContext = vm.createContext({ exports: shortcutExports, navigator: { platform: 'Win32' }, window: {
  addEventListener: (_, listener) => { shortcutListener = listener; }, removeEventListener() {},
} });
vm.runInContext(ts.transpileModule(fs.readFileSync('src/utils/shortcuts.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, shortcutContext);
let invoked = 0;
shortcutExports.bindShortcut('Mod+f', () => { invoked++; });
const shortcutEvent = { key: 'f', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false,
  preventDefault() {}, target: { closest: () => ({}) } };
shortcutListener(shortcutEvent);
assert.equal(invoked, 0, 'settings editable fields retain their own shortcuts');
shortcutListener({ ...shortcutEvent, target: { closest: () => null } });
assert.equal(invoked, 1);
shortcutListener({ ...shortcutEvent, target: null, defaultPrevented: true });
assert.equal(invoked, 1, 'handled editor shortcuts must not run twice');
console.log('UI command ownership: navigation IME guards, sidebar policy, async image target passed.');
