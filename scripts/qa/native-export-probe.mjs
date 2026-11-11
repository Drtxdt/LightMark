import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Uses only the isolated launcher's verified WebView and owned fixture directory. */
export async function runNativeExportProbe(client, context) {
  const phase = context?.manifest?.launch?.phases?.at(-1);
  assert.ok(context.runToken && context.identifier && context.manifest.isolation?.preexistingPathsChecked);
  assert.equal(client.url, phase?.target?.webSocketDebuggerUrl);
  assert.ok(phase.targetNonce && phase.pid && phase.loopback);
  const url = new URL(phase.target.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.searchParams.get('lightmarkQa'), phase.targetNonce);
  const directory = path.dirname(context.fixturePath);
  const sourcePath = path.join(directory, 'native-export-owned.md');
  const imagePath = path.join(directory, 'native-export-image.svg');
  await writeFile(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#36618b"/></svg>');
  const paragraphs = Array.from({ length: 100 }, (_, index) => `长页段落 ${index + 1}：中文分页与连续内容，LOCAL_EXPORT_PARAGRAPH_${index + 1}。`).join('\n\n');
  const source = '# 中文导出验收\n\n固定版本 EXPORT_CAPTURE_A\n\n行内公式 $x^2+1$。\n\n| 名称 | 数值 |\n| :--- | ---: |\n| 中文 | 123 |\n\n![本地图片](native-export-image.svg)\n\n```js\nconst literal = "**code**";\n```\n\n' + paragraphs + '\n\n结束 EXPORT_END\n';
  await writeFile(sourcePath, source, 'utf8');
  const name = '__LIGHTMARK_NATIVE_EXPORT_QA';
  await client.evaluate(`(() => {
    const q = globalThis.${name} = { operations: {} };
    q.operations.initialize = { state: 'running' };
    (async () => {
      q.store = await import('/src/stores/appStore.ts');
      q.runtime = await import('/src/editor/documentRuntime.ts');
      q.exports = await import('/src/utils/export.ts');
      q.paths = await import('/node_modules/@tauri-apps/api/path.js');
      const actual = { config: await q.paths.appConfigDir(), data: await q.paths.appDataDir(), local: await q.paths.appLocalDataDir() };
      const expected = ${JSON.stringify({ config: context.expectedAppConfigDir, data: context.expectedAppDataDir, local: context.expectedAppLocalDataDir })};
      const normalize = value => { let text = String(value).replaceAll(String.fromCharCode(92), '/').toLowerCase(); while (text.endsWith('/')) text = text.slice(0, -1); return text; };
      for (const key of Object.keys(expected)) if (normalize(actual[key]) !== normalize(expected[key])) throw new Error('Export isolation mismatch: ' + key);
      await q.store.openFile(${JSON.stringify(sourcePath)}, { paneId: 'main', recordNavigation: false });
      q.settings = { ...q.store.appStore.settings.export, htmlTheme: 'light', openFileAfterExport: false, openFolderAfterExport: false };
      return { actual, tabId: q.store.getPaneTab('main')?.id };
    })().then(value => q.operations.initialize = { state: 'fulfilled', value }, error => q.operations.initialize = { state: 'rejected', error: String(error?.stack || error) });
    return true;
  })()`, 5000);
  const read = body => client.evaluate(`(() => { const q = globalThis.${name}; ${body} })()`, 5000);
  const wait = async label => {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      const result = await read(`return q.operations[${JSON.stringify(label)}];`);
      if (result?.state === 'rejected') throw new Error(`${label}: ${result.error}`);
      if (result?.state === 'fulfilled') return { ...result, elapsedMs: Date.now() - started };
      await delay(75);
    }
    throw new Error(`Native export ${label} timed out`);
  };
  const initialized = await wait('initialize');
  const cases = [];
  for (const target of ['html', 'pdf', 'png']) {
    const outputPath = path.join(directory, `native-export-result.${target}`);
    await read(`q.operations[${JSON.stringify(target)}] = { state: 'running' };
      q.exports.exportCurrentDocument({ target: ${JSON.stringify(target)}, currentPath: ${JSON.stringify(sourcePath)}, markdown: ${JSON.stringify(source)}, settings: q.settings, outputPath: ${JSON.stringify(outputPath)}, overwrite: false }).then(
        value => q.operations[${JSON.stringify(target)}] = { state: 'fulfilled', value },
        error => q.operations[${JSON.stringify(target)}] = { state: 'rejected', error: String(error?.stack || error) }); return true;`);
    const operation = await wait(target);
    const bytes = await readFile(outputPath);
    assert.ok(bytes.length > 100, `${target} must contain an actual exported document`);
    if (target === 'html') {
      const html = bytes.toString('utf8');
      for (const marker of ['中文导出验收', 'EXPORT_CAPTURE_A', 'EXPORT_END', 'katex', '<table', 'data:image/svg+xml']) assert.ok(html.includes(marker), `HTML missing ${marker}`);
      assert.ok(!/<img\b[^>]*\bsrc=["']file:/i.test(html), 'local image must be self contained');
    } else if (target === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    else assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    cases.push({ target, outputPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), operation, passed: true });
  }
  assert.equal(await readFile(sourcePath, 'utf8'), source, 'export never modifies its input');
  await client.evaluate(`(() => { setTimeout(() => { void globalThis.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }); }, 100); return { cleanupScheduled: true }; })()`, 5000);
  return { status: 'passed', initialized, cases, renderingReview: 'Output signatures/content verified; PDF and PNG require separate rendered visual inspection.' };
}
