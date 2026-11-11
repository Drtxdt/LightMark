import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Executed in the owned dev window. Input, buttons, document history, save
// and reopen all use the production application; only the fixture is synthetic.
async function exercise({ fixturePath, expectedConfig, original, expected, roots }) {
  const result = globalThis.__lightmarkFindRun;
  const assertThat = (ok, label) => { if (!ok) throw new Error(label); };
  const until = async (label, test) => {
    const deadline = Date.now() + 15000;
    do { if (test()) return; await new Promise(resolve => setTimeout(resolve, 35)); } while (Date.now() < deadline);
    throw new Error('timed out: ' + label);
  };
  const app = await import('/src/stores/appStore.ts');
  const runtime = await import('/src/editor/documentRuntime.ts');
  const find = await import('/src/stores/findReplaceStore.ts');
  const { appConfigDir } = await import('/node_modules/@tauri-apps/api/path.js');
  const normalize = value => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  assertThat(normalize(await appConfigDir()) === normalize(expectedConfig), 'wrong native profile');
  if (!roots) await app.loadConfig();
  else {
    let failed = false;
    try { await app.loadConfig(); } catch { failed = true; }
    assertThat(failed && app.appStore.configPersistenceMessage, 'damaged config is visible');
    for (const name of ['A', 'B', 'A']) {
      await app.openWorkspace(roots[name]);
      await until('native index ' + name, () => app.appStore.workspaceIndexReady && app.appStore.fileTree.some(f => f.name === name + '.md'));
      assertThat(app.appStore.wikiIndex.root === roots[name], 'unexpected index root');
      result.steps.push({ workspace: name, files: app.appStore.fileTree.map(f => f.name), indexGeneration: app.appStore.workspaceIndexGeneration });
    }
    result.watchReady = true;
    await until('real Windows file watcher', () => app.appStore.fileTree.some(f => f.name === 'watched.md'));
    assertThat(!app.appStore.fileTree.some(f => f.name === 'B.md'), 'stale workspace tree');
    result.steps.push({ activeWatcher: 'A', observed: 'watched.md', configWritesPaused: true });
  }
  const open = async () => {
    await app.openFile(fixturePath, { paneId: 'main', recordNavigation: false });
    const tab = app.getPaneTab('main');
    assertThat(tab?.path === fixturePath, 'wrong open tab');
    await app.switchMode('wysiwyg');
    await until('mounted formula', () => runtime.documentSessionForTab(tab.id)?.editorIdentity?.view?.dom?.querySelector('.katex'));
    return tab.id;
  };
  let tabId = await open();
  const snapshot = async (label, wanted) => {
    const receipt = await runtime.snapshotDocumentTab(tabId, 'save');
    const count = runtime.documentSessionForTab(tabId).editorIdentity.view.dom.querySelectorAll('.katex').length;
    result.steps.push({ label, markdown: receipt.markdown, formulas: count });
    assertThat(receipt.markdown === wanted && count === 1, label + ': ' + JSON.stringify(receipt.markdown) + ', formulas=' + count);
  };
  const setInput = (selector, value) => {
    const input = document.querySelector('.find-panel ' + selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setQuery = async (value, expectedCount) => {
    const sequence = find.findReplaceStore.sequence;
    setInput('input[type=search]', value);
    await until('panel scanned ' + value, () => find.findReplaceStore.sequence > sequence && !find.findReplaceStore.busy);
    const actual = document.querySelector('.find-count').textContent.trim();
    assertThat(find.findReplaceStore.total === expectedCount && actual === (expectedCount ? '1/1' : '0/0'), value + ' count: ' + actual);
    result.steps.push({ query: value, count: actual });
  };
  const click = label => {
    const button = [...document.querySelectorAll('.find-button')].find(el => el.textContent.trim() === label);
    assertThat(button, 'missing button: ' + label);
    button.click();
  };
  const display = () => runtime.documentSessionForTab(tabId).editorIdentity.state.doc.textContent;
  await snapshot('opened', original);
  find.openFindPanel();
  await until('visible panel', () => document.querySelector('.find-panel input'));
  setInput('input[type=text]', 'Z');
  await setQuery('LR', 0);
  click('全部替换');
  await snapshot('replace across formula is a no-op', original);
  await setQuery('R', 1);
  click('替换');
  await until('right neighbor replaced', () => display().includes('Z'));
  const neighbor = 'L$x$Z\n\nAİBC!\n';
  await snapshot('replace next to formula', neighbor);
  assertThat(await runtime.moveDocumentHistory(tabId, -1), 'undo returned false');
  await snapshot('undo', original);
  assertThat(await runtime.moveDocumentHistory(tabId, 1), 'redo returned false');
  await snapshot('redo', neighbor);
  await setQuery('b', 1);
  setInput('input[type=text]', 'Q');
  click('全部替换');
  await until('Unicode replacement', () => display().includes('Q'));
  await snapshot('replace all after Unicode character', expected);
  assertThat(await runtime.moveDocumentHistory(tabId, -1), 'Unicode undo returned false');
  await snapshot('Unicode undo', neighbor);
  assertThat(await runtime.moveDocumentHistory(tabId, 1), 'Unicode redo returned false');
  await snapshot('Unicode redo', expected);
  find.closeFindPanel();
  assertThat(await app.saveCurrentFile(), 'production save returned false');
  await app.closeTab(tabId);
  assertThat(!app.appStore.tabs.some(tab => tab.id === tabId), 'tab did not close');
  tabId = await open();
  await snapshot('reopened from disk', expected);
}

export async function runNativeFindIntegrity(client, context) {
  const phase = context.manifest.launch.phases.at(-1);
  assert.ok(context.manifest.isolation.preexistingPathsChecked && phase.loopback && phase.pid);
  assert.equal(phase.target.webSocketDebuggerUrl, client.url);
  assert.equal(new URL(phase.target.url).searchParams.get('lightmarkQa'), phase.targetNonce);
  const input = { fixturePath: context.fixturePath, expectedConfig: context.expectedAppConfigDir,
    original: context.fixtureContent, expected: context.scenarioEvidence.expectedSaved };
  if (context.scenario === 'workspace-profile') {
    input.roots = {};
    for (const name of ['A', 'B']) {
      const root = path.join(path.dirname(context.fixturePath), name);
      await mkdir(root);
      await writeFile(path.join(root, name + '.md'), '# ' + name, { flag: 'wx' });
      input.roots[name] = root;
    }
  }
  await client.evaluate(`(() => { const result = globalThis.__lightmarkFindRun = { steps: [] };
    (${exercise.toString()})(${JSON.stringify(input)}).then(() => result.done = true, err => result.error = String(err.stack || err));
    return true; })()`, 5000);
  const deadline = Date.now() + 120000;
  let wroteFixture = false;
  while (Date.now() < deadline) {
    const result = await client.evaluate('globalThis.__lightmarkFindRun', 5000);
    if (result?.error) throw new Error(JSON.stringify(result));
    if (result?.watchReady && !wroteFixture) {
      await writeFile(path.join(input.roots.A, 'watched.md'), '# 监听测试', { flag: 'wx' });
      wroteFixture = true;
    }
    if (result?.done) {
      await client.evaluate("setTimeout(() => globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }), 100); true", 5000);
      return { status: 'passed', steps: result.steps };
    }
    await delay(150);
  }
  throw new Error('Native find integrity scenario timed out.');
}
