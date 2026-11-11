// Run after a production frontend build and an embedded Tauri release build.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanReleaseEnvironment } from './windows-release-acceptance.mjs';

assert.equal(process.platform, 'win32', 'requires Windows, WebView2, Edge/Chrome, and Pandoc');
const binDir = path.resolve(process.argv[2] ?? 'src-tauri/target/release');
const app = path.join(binDir, 'lightmark.exe'), cli = path.join(binDir, 'lightmark-cli.exe');
const base = path.resolve('.cache/cli-export-integrity');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'run-')), temp = path.join(root, 'temp');
await mkdir(temp);
const profile = 'export-' + randomUUID();
const env = { ...cleanReleaseEnvironment(process.env, path.join(root, 'unused-target')),
  LIGHTMARK_PROFILE: profile, LIGHTMARK_APP_BINARY: app, TMP: temp, TEMP: temp };
const input = path.join(root, '原稿 draft.md'), alias = path.join(root, 'alias.html');
const original = Buffer.from('# LightMark 原稿\r\n\r\n你好，留住公式 $x$。\r\n\r\nEXPORT-END-123\r\n');
await writeFile(input, original, { flag: 'wx' });
await link(input, alias);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { status: 'running', profile, source: hash(original),
  app: hash(await readFile(app)), cli: hash(await readFile(cli)), cases: [] };
const persist = () => writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
const run = promisify(execFile);
async function check(label, args, expectedCode, message, document = input) {
  let code = 0, output;
  try { output = await run(cli, ['export', document, ...args, '--json'], { env, windowsHide: true, timeout: 180000 }); }
  catch (e) { code = e.code; output = e; }
  const combined = String(output.stdout) + String(output.stderr);
  const bytesUnchanged = (await readFile(input)).equals(original) && (await readFile(alias)).equals(original);
  manifest.cases.push({ label, code, bytesUnchanged });
  await persist();
  assert.equal(code, expectedCode, label + ': ' + combined);
  if (message) assert.match(combined, message);
  assert.ok(bytesUnchanged, 'original bytes changed: ' + label);
  return manifest.cases.at(-1);
}
try {
  for (const [label, candidate] of [['same spelling', input], ['verbatim Windows path', path.toNamespacedPath(input)], ['hard link', alias]]) {
    await check(label, ['-f', 'html', '-o', candidate, '--force'], 2, /源 Markdown/);
  }
  await check('default markdown target', ['-f', 'markdown-spec', '--force'], 2, /源 Markdown/);
  for (const format of ['html', 'pdf', 'png', 'docx']) {
    const output = path.join(root, '正式导出.' + format);
    if (format === 'html') {
      await writeFile(output, 'previous export', { flag: 'wx' });
      await check('existing without force', ['-f', format, '-o', output], 2, /已存在/);
      assert.equal(await readFile(output, 'utf8'), 'previous export');
    }
    const entry = await check('render ' + format, ['-f', format, '-o', output, ...(format === 'html' ? ['--force'] : [])], 0);
    const bytes = await readFile(output);
    if (format === 'html') { assert.match(bytes.toString(), /EXPORT-END-123/); assert.match(bytes.toString(), /你好/); }
    if (format === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    if (format === 'png') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    if (format === 'docx') assert.ok(bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) && bytes.includes(Buffer.from('word/document.xml')));
    entry.output = { bytes: bytes.length, sha256: hash(bytes) };
  }
  const good = path.join(root, '正式导出.html'), keep = await readFile(good);
  const badWriter = path.join(root, 'unsupported-writer.json');
  await writeFile(badWriter, JSON.stringify({ settings: { export: { customPandocFormat: 'lightmark-no-such-writer' } } }), { flag: 'wx' });
  const failed = await check('renderer failure keeps previous export', ['-f', 'custom-pandoc', '-o', good, '--force', '--config', badWriter], 5, /Pandoc 导出失败/);
  assert.ok((await readFile(good)).equals(keep), 'failed renderer replaced an existing export');
  failed.previousOutputUnchanged = true;
  const notes = path.join(root, 'notes'), shared = path.join(root, 'shared');
  await mkdir(notes);
  await mkdir(shared);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8"/></svg>';
  await writeFile(path.join(shared, '封 面.svg'), svg, { flag: 'wx' });
  const article = path.join(notes, '插图.md');
  const markdown = '![封面](../shared/封%20面.svg)\n';
  await writeFile(article, markdown, { flag: 'wx' });
  const args = ['-f', 'html', '-o', good, '--force'];
  await check('unapproved shared image preserves previous output', args, 5, /图片位于文档目录外/, article);
  assert.ok((await readFile(good)).equals(keep));
  await check('explicit resource root embeds the selected image', [...args, '--resource-root', shared], 0, undefined, article);
  assert.ok((await readFile(good, 'utf8')).includes('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')));
  assert.equal(await readFile(article, 'utf8'), markdown);
  await writeFile(path.join(notes, 'attachment.png'), 'not image data', { flag: 'wx' });
  const local = path.join(notes, '本地.md');
  await writeFile(local, '![附件](attachment.png)\n', { flag: 'wx' });
  await check('invalid local image is rejected', args, 5, /不是支持的图片格式/, local);
  const badConfig = path.join(root, 'unreadable-settings.json');
  await writeFile(badConfig, '{', { flag: 'wx' });
  await check('invalid startup config returns a CLI error', [...args, '--config', badConfig], 5, /无法解析配置/);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.lightmark-export-')), 'staged output survived completion');
  manifest.status = 'passed';
} catch (error) { manifest.status = 'failed'; manifest.error = String(error); throw error; }
finally { await persist(); console.log(JSON.stringify({ root, status: manifest.status, cases: manifest.cases.length })); }
