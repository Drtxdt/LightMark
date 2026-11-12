// This entry is injected only by the isolated desktop test server.
import * as store from '/src/stores/appStore.ts';
import { documentSessionForTab } from '/src/editor/documentRuntime.ts';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appConfigDir } from '@tauri-apps/api/path';

async function waitFor(read, diagnostic = () => store.appStore.statusMessage) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Editor or document image did not mount: ' + JSON.stringify(diagnostic()));
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
    await store.switchMode('wysiwyg', pane);
    const editor = await waitFor(() => {
      const tab = store.getPaneTab(pane);
      if (tab?.path !== path) return;
      const ed = documentSessionForTab(tab.id)?.editorIdentity;
      return ed?.view?.dom?.querySelector('img')?.naturalWidth === width && ed;
    }, () => ({ pane, path, actual: store.getPaneTab(pane)?.path, status: store.appStore.statusMessage,
      images: Array.from(document.images, img => [img.src, img.naturalWidth]) }));
    editor.view.focus();
    if (!await store.setActivePane(pane) || store.appStore.currentFilePath !== path) {
      throw Error('Could not activate ' + path + ': ' + store.appStore.statusMessage);
    }
    if (fixture.reopen) {
      if (!editor.state.doc.textContent.includes('底稿' + suffix)) throw Error('Reopened text mismatch: ' + path);
    } else {
      if (!editor.commands.insertContentAt(editor.state.doc.content.size - 1, suffix)) throw Error('Insert failed');
      if (store.appStore.currentFilePath !== path) throw Error('Active document changed before save');
      const owner = store.getPaneTab(pane).id;
      if (pane === 'secondary' && await store.saveCurrentFileAs(async () => fixture.occupied, owner)) throw Error('Overwrote an existing file');
      const saved = pane === 'main' ? await store.saveCurrentFile() : await store.saveCurrentFileAs(async () => fixture.copy, owner);
      if (!saved) throw Error(store.appStore.statusMessage || 'Save failed');
    }
    observed.push({ pane, width, path: store.getPaneTab(pane).path });
  }
  if (fixture.caseFiles.length) {
    const owners = [];
    for (const [index, pane] of ['main', 'secondary'].entries()) {
      const path = fixture.caseFiles[index];
      await store.openFile(path, { paneId: pane });
      const editor = await waitFor(() => {
        const tab = store.getPaneTab(pane);
        return tab?.path === path && documentSessionForTab(tab.id)?.editorIdentity;
      });
      owners.push(store.getPaneTab(pane).id);
      if (!await store.setActivePane(pane) || store.appStore.currentFilePath !== path) throw Error('Case-sensitive pane activation failed');
      const expected = path.split('/').pop() + (fixture.reopen ? '改' : '');
      if (editor.state.doc.textContent !== expected) throw Error('Case-sensitive note mismatch: ' + path);
      if (!fixture.reopen) {
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, '改');
        if (!await store.saveCurrentFile()) throw Error('Case-sensitive save failed: ' + path);
      }
    }
    if (owners[0] === owners[1] || store.getPaneTab('main').path !== fixture.caseFiles[0]) throw Error('Case-sensitive document identities collided');
  }
  return observed;
}

const fixture = await (await fetch('/__dual_fixture')).json();
try {
  const observed = await run(fixture);
  await fetch('/__dual_result/' + fixture.token, { method: 'POST', body: JSON.stringify({ observed }) });
} catch (error) {
  await fetch('/__dual_result/' + fixture.token, { method: 'POST', body: JSON.stringify({ error: String(error) + '\n' + (error.stack || '') }) });
} finally {
  await getCurrentWindow().destroy();
}
