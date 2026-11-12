import * as store from '/src/stores/appStore.ts';
import { qaDraftReceipts, draftStore } from '/src/stores/draftStore.ts';
import { dialogStore } from '/src/stores/dialogStore.ts';
import { documentSessionForTab } from '/src/editor/documentRuntime.ts';
import { appDataDir, join } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';

const fixture = await (await fetch('/__draft_fixture')).json();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, description) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(50);
  }
  throw Error(description + ': ' + JSON.stringify({ status: store.appStore.statusMessage, draft: draftStore.message, receipts: [...qaDraftReceipts.keys()] }));
}
async function writeFive() {
  await store.loadConfig();
  await waitFor(() => store.getPaneTab('main'), 'initial tab');
  for (const file of fixture.files) await store.openFile(file);
  const named = fixture.files.map(file => store.appStore.tabs.find(t => t.path === file).id);
  const untitled = [];
  for (let i = 0; i < 3; i++) {
    const tab = await store.createUntitledTabAfterFlush();
    if (!tab) throw Error('Could not create draft');
    untitled.push(tab.id);
    await waitFor(() => documentSessionForTab(tab.id)?.editorIdentity, 'new editor');
  }
  for (const [i, id] of [...untitled, ...named].entries()) {
    await store.activateTab(id);
    const ed = await waitFor(() => store.appStore.activeTabId === id && documentSessionForTab(id)?.editorIdentity, 'activate ' + id);
    const suffix = i < 3 ? fixture.contents[i] : '修订';
    if (!ed.commands.insertContentAt(ed.state.doc.content.size - 1, suffix)) throw Error('Typing failed');
  }
  await waitFor(() => fixture.contents.every(text => [...qaDraftReceipts.values()].some(v => v.record.content === text)), 'five committed drafts');
  return { draftDir: await join(await appDataDir(), 'drafts'), receipts: [...qaDraftReceipts.values()].map(({ record, receipt }) =>
    ({ id: record.id, content: record.content, outcome: receipt.outcome, diskWritten: receipt.diskWritten })) };
}
async function recover() {
  const count = fixture.corrupt ? 4 : 5;
  for (let i = 0; i < count; i++) {
    const prompt = await waitFor(() => dialogStore.active?.title === '发现可恢复草稿' && dialogStore.active.message.startsWith('第 ' + (i+1) + ' / ' + count) && dialogStore.active, 'startup recovery prompt ' + i);
    const button = await waitFor(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === '恢复草稿'), 'restore button');
    button.click();
    await waitFor(() => dialogStore.active !== prompt, 'dialog completion');
  }
  await waitFor(() => draftStore.pendingRecovery.length === 0, 'all recovered');
  const tabs = store.appStore.tabs.filter(t => t.isDirty).map(t => ({ id: t.id, dirty: t.isDirty, path: t.path, content: t.content }));
  return { tabs, issue: draftStore.recoveryIssues };
}
let data;
try {
  if (!(await appDataDir()).includes('com.lightmark.profile.' + fixture.profile)) throw Error('Unexpected profile');
  data = await (fixture.reopen ? recover() : writeFive());
} catch (error) { data = { error: String(error) + '\n' + (error.stack || '') }; }
await fetch('/__draft_result/' + fixture.token, { method: 'POST', body: JSON.stringify(data) });
if (fixture.reopen || data.error) await getCurrentWindow().destroy();
