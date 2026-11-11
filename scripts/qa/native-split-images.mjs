import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function prepareSplitImages(context) {
  assert.ok(context.manifest.isolation.preexistingPathsChecked);
  const left = context.fixturePath;
  const rightDir = path.join(path.dirname(left), '另一文件夹');
  await mkdir(rightDir);
  const right = path.join(rightDir, '右侧笔记.md');
  const movedDir = path.join(path.dirname(left), '重新定位');
  await mkdir(movedDir);
  const moved = path.join(movedDir, '已移动.md');
  await writeFile(right, context.fixtureContent, { flag: 'wx' });
  await writeFile(moved, context.fixtureContent, { flag: 'wx' });
  for (const [doc, width] of [[left, 13], [right, 29], [moved, 37]]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="11"><rect width="100%" height="100%" fill="teal"/></svg>`;
    await writeFile(path.join(path.dirname(doc), 'cover.svg'), svg, { flag: 'wx' });
  }
  await mkdir(context.expectedAppConfigDir);
  await writeFile(path.join(context.expectedAppConfigDir, 'config.json'), JSON.stringify({
    settings: { general: { launchBehavior: 'restoreLastSession' } },
    session: {
      openTabs: [left, right].map((file, index) => ({ path: file, kind: 'normal', editorMode: 'wysiwyg', lastActiveAt: index + 1 })),
      activeTabKey: right,
      splitLayout: { enabled: true, activePaneId: 'secondary', mainTabKeys: [left], secondaryTabKeys: [right],
        mainActiveTabKey: left, secondaryActiveTabKey: right, ratio: 0.5 },
    },
  }), { flag: 'wx' });
  return [left, right, moved];
}

async function inspectPanes(files, expectedConfig) {
  const store = await import('/src/stores/appStore.ts');
  const runtime = await import('/src/editor/documentRuntime.ts');
  const { appConfigDir } = await import('/node_modules/@tauri-apps/api/path.js');
  const normalize = value => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (normalize(await appConfigDir()) !== normalize(expectedConfig)) throw Error('Unexpected native profile');
  await store.loadConfig();
  const panes = ['main', 'secondary'];
  const inspect = () => panes.map(pane => {
    const tab = store.getPaneTab(pane);
    const editor = tab && runtime.documentSessionForTab(tab.id)?.editorIdentity;
    const image = editor?.view?.dom?.querySelector('.typora-image-node img');
    return { path: tab?.path, src: image?.getAttribute('src'), width: image?.naturalWidth, dirty: tab?.isDirty };
  });
  const deadline = Date.now() + 20000;
  let observed = inspect();
  while (Date.now() < deadline && !observed.every((pane, i) => pane.path === files[i] && pane.width)) {
    await new Promise(resolve => setTimeout(resolve, 50));
    observed = inspect();
  }
  const active = store.appStore.splitLayout.activePaneId;
  const snapshots = [];
  for (const pane of panes) {
    const tab = store.getPaneTab(pane);
    if (tab) snapshots.push((await runtime.snapshotDocumentTab(tab.id, 'save')).markdown);
  }
  await Promise.all(document.getAnimations().filter(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().iterations)).map(a => a.finished.catch(() => {})));
  if (!await store.setActivePane('main')) throw Error('Activating main failed: ' + store.appStore.statusMessage);
  const activeTab = store.getPaneTab('main');
  const beforeMove = { dirty: activeTab.isDirty, markdown: (await runtime.snapshotDocumentTab(activeTab.id, 'save')).markdown };
  if (!await store.rebindCurrentFileToCandidate(files[2], activeTab.id)) throw Error('Relocating the main pane failed: ' + JSON.stringify({
    beforeMove, active: store.appStore.activeTabId, path: store.appStore.currentFilePath, tabs: store.appStore.tabs.map(t => t.path), status: store.appStore.statusMessage,
  }));
  const later = Date.now() + 12000;
  let relocated = inspect();
  while (Date.now() < later && (relocated[0].path !== files[2] || relocated[0].width !== 37)) {
    await new Promise(resolve => setTimeout(resolve, 50));
    relocated = inspect();
  }
  const { invoke } = await import('/node_modules/@tauri-apps/api/core.js');
  const embedded = await invoke('read_export_resource', { markdownPath: files[2], source: 'cover.svg' });
  const reboundTab = store.getPaneTab('main');
  const snapshot = async () => (await runtime.snapshotDocumentTab(reboundTab.id, 'save')).markdown;
  const relocatedMarkdown = await snapshot();
  const editor = runtime.documentSessionForTab(reboundTab.id).editorIdentity;
  if (!editor.commands.insertContentAt(editor.state.doc.content.size - 1, '尾注')) throw Error('Typing after the image failed');
  const editedMarkdown = await snapshot();
  if (!await runtime.moveDocumentHistory(reboundTab.id, -1)) throw Error('Undo after relocation failed');
  const afterUndo = await snapshot();
  return { active, observed, snapshots, beforeMove, relocated, relocatedMarkdown, editedMarkdown, afterUndo,
    embeddedSvg: new TextDecoder().decode(Uint8Array.from(embedded.bytes)) };
}

export async function verifySplitImages(client, context, files) {
  const phase = context.manifest.launch.phases.at(-1);
  assert.ok(phase.pid && phase.loopback);
  assert.equal(client.url, phase.target.webSocketDebuggerUrl);
  assert.equal(new URL(phase.target.url).searchParams.get('lightmarkQa'), phase.targetNonce);
  // WebView2 can advertise the destination URL while CDP still exposes the
  // initial about:blank execution context.
  const deadline = Date.now() + 30000;
  for (;;) {
    const page = await client.evaluate("({ href: location.href, title: document.title, mounted: Boolean(document.querySelector('#app')?.childElementCount), text: document.body?.innerText?.slice(0, 220) })", 5000);
    if (page.href === phase.target.url && page.mounted) break;
    if (Date.now() >= deadline) {
      const frame = (await client.call('Page.getFrameTree')).frameTree.frame;
      throw Error('The isolated app page did not mount: ' + JSON.stringify({ page, url: frame.url, unreachable: frame.unreachableUrl }));
    }
    await delay(100);
  }
  const result = await client.evaluate(`(${inspectPanes.toString()})(${JSON.stringify(files)},${JSON.stringify(context.expectedAppConfigDir)})`, 45000);
  assert.equal(result.active, 'secondary');
  assert.deepEqual(result.observed.map(p => p.path), files.slice(0, 2));
  assert.deepEqual(result.observed.map(p => p.width), context.scenarioEvidence.expectedWidths, JSON.stringify(result.observed));
  assert.deepEqual(result.snapshots, [context.fixtureContent, context.fixtureContent]);
  assert.ok(result.observed.every(p => !p.dirty));
  assert.deepEqual(result.relocated.map(p => p.path), [files[2], files[1]]);
  assert.deepEqual(result.relocated.map(p => p.width), [37, 29]);
  assert.deepEqual(result.beforeMove, { dirty: false, markdown: context.fixtureContent });
  assert.ok(result.relocated.every(p => !p.dirty), JSON.stringify(result.relocated));
  assert.equal(result.relocatedMarkdown, context.fixtureContent);
  assert.equal(result.editedMarkdown, '![封面](cover.svg)\n\n尾注');
  assert.equal(result.afterUndo, context.fixtureContent);
  assert.match(result.embeddedSvg, /width="37"/);
  await client.evaluate("setTimeout(() => globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }), 100); true", 5000);
  return { status: 'passed', ...result };
}
