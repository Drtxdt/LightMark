// This entry is injected only by the isolated desktop test server.
import * as store from '/src/stores/appStore.ts';
import { documentSessionForTab } from '/src/editor/documentRuntime.ts';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appConfigDir } from '@tauri-apps/api/path';

async function waitFor(read) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Editor or document image did not mount');
}

async function run(fixture) {
  if (!(await appConfigDir()).includes(fixture.profile)) throw Error('Unexpected native profile');
  await store.loadConfig();
  await waitFor(() => store.getPaneTab('main'));
  await store.openFile(fixture.left, { paneId: 'main' });
  if (!store.appStore.splitLayout.enabled) await store.toggleSplitLayout();
  const right = fixture.reopen ? fixture.copy : fixture.right;
  await store.openFile(right, { paneId: 'secondary' });
  const observed = [];
  for (const [pane, path, width, suffix] of [['main', fixture.left, 13, '左'], ['secondary', right, 29, '右']]) {
    await store.setActivePane(pane);
    await store.switchMode('wysiwyg', pane);
    const editor = await waitFor(() => {
      const tab = store.getPaneTab(pane);
      if (tab?.path !== path) return;
      const ed = documentSessionForTab(tab.id)?.editorIdentity;
      return ed?.view?.dom?.querySelector('img')?.naturalWidth === width && ed;
    });
    if (fixture.reopen) {
      if (!editor.state.doc.textContent.includes('底稿' + suffix)) throw Error('Reopened text mismatch: ' + path);
    } else {
      if (!editor.commands.insertContentAt(editor.state.doc.content.size - 1, suffix)) throw Error('Insert failed');
      const saved = pane === 'main' ? await store.saveCurrentFile() : await store.saveCurrentFileAs(async () => fixture.copy);
      if (!saved) throw Error(store.appStore.statusMessage || 'Save failed');
    }
    observed.push({ pane, width, path: store.getPaneTab(pane).path });
  }
  return observed;
}

const fixture = await (await fetch('/__dual_fixture')).json();
try {
  const observed = await run(fixture);
  await fetch('/__dual_result/' + fixture.token, { method: 'POST', body: JSON.stringify({ observed }) });
} catch (error) {
  await fetch('/__dual_result/' + fixture.token, { method: 'POST', body: JSON.stringify({ error: String(error.stack || error) }) });
} finally {
  await getCurrentWindow().destroy();
}
