import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const base = path.join(tmpdir(), 'LightMark-dual-save');
await mkdir(base, { recursive: true });
const root = await realpath(await mkdtemp(path.join(base, 'run-')));
const token = randomUUID();
const profile = 'qa-' + token.slice(0, 8);
const dirs = ['左栏', '右栏'].map(name => path.join(root, name));
const [left, right] = dirs.map(dir => path.join(dir, '笔记.md'));
const copy = path.join(dirs[1], '副本.md');
const original = '![封面](cover.svg)\n\n底稿';
for (const [i, dir] of dirs.entries()) {
  await mkdir(dir);
  await writeFile(path.join(dir, '笔记.md'), original);
  await writeFile(path.join(dir, 'cover.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${i ? 29 : 13}" height="10"/>`);
}
let reopen = false, result;
const server = await createServer({
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'dual-save-window-test',
    transformIndexHtml() { return [{ tag: 'script', attrs: { type: 'module', src: '/scripts/qa/dual-save-window.mjs' }, injectTo: 'body' }]; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/' || req.url.startsWith('/__dual_')) console.log(req.method, req.url.split(token)[0]);
        if (req.url === '/__dual_fixture') {
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ left, right, copy, profile, token, reopen }));
        } else if (req.url === '/__dual_result/' + token && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          result = JSON.parse(body);
          console.log(result);
          res.end('ok');
        } else next();
      });
    },
  }],
});
async function exec(command, args, env, timeout) {
  console.log('Launching', command, args);
  const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${command}: ${code ?? signal}`)));
    });
  } finally { clearTimeout(timer); }
}
try {
  await server.listen();
  const devUrl = 'http://127.0.0.1:' + server.httpServer.address().port;
  console.log('Testing desktop at', devUrl);
  const env = { ...process.env, TAURI_CONFIG: JSON.stringify({ build: { devUrl } }) };
  await exec('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'lightmark'], env, 1200000);
  const exe = path.resolve(process.env.CARGO_TARGET_DIR ?? 'src-tauri/target', 'debug', process.platform === 'win32' ? 'lightmark.exe' : 'lightmark');
  for (const phase of ['edit', 'reopen']) {
    reopen = phase === 'reopen';
    result = null;
    await exec(exe, ['--profile', profile], env, 120000);
    assert.ok(result && !result.error, result?.error ?? 'Window exited without receipt');
    assert.deepEqual(result.observed.map(row => row.path), [left, copy]);
    for (const [file, text] of [[left, original + '左'], [copy, original + '右'], [right, original]]) {
      assert.deepEqual(await readFile(file), Buffer.from(text));
    }
    console.log(JSON.stringify({ phase, ...result, diskBytesVerified: true }));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server.httpServer.closeAllConnections();
  await server.close();
}
