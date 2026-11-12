import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

export function draftRecoveryHarness(root) {
  let fixture, notify;
  const token = randomUUID();
  const plugin = {
    name: 'native-draft-recovery-test',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: '/scripts/qa/draft-recovery-window.mjs' }, injectTo: 'body' }];
    },
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/stores/draftStore.ts')) return;
      const marker = 'lastCheckpoint.set(context.tab, version);';
      assert.ok(code.includes(marker));
      return code.replace(marker, marker + ' qaDraftReceipts.set(record.id, {record, receipt: writeReceipt});')
        + '\nexport const qaDraftReceipts = new Map();';
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.url === '/__draft_fixture') return res.end(JSON.stringify({ ...fixture, token }));
        if (req.url !== '/__draft_result/' + token || req.method !== 'POST') return next();
        let body = '';
        for await (const chunk of req) body += chunk;
        res.end('ok');
        notify(JSON.parse(body));
      });
    },
  };

  async function launch(exe, env, onReceipt) {
    const report = new Promise(resolve => { notify = resolve; });
    const child = spawn(exe, ['--profile', fixture.profile], { env, stdio: 'inherit', windowsHide: true });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try {
      const data = await Promise.race([report, exited.then(exit => { throw Error('Exited before receipt: ' + JSON.stringify(exit)); })]);
      assert.ok(!data.error, data.error);
      await onReceipt(data);
      if (!fixture.reopen) assert.ok(child.kill('SIGKILL'));
      const exit = await exited;
      if (fixture.reopen) assert.equal(exit.code, 0);
      else assert.ok(exit.signal === 'SIGKILL' || (process.platform === 'win32' && exit.code !== 0));
      return data;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  async function run(exe, env) {
    for (const corrupt of [false, true]) {
      const profile = 'qa-' + randomUUID().slice(0, 12);
      const files = [1, 2].map(i => path.join(root, profile + '-笔记' + i + '.md'));
      const originals = ['磁盘一', '磁盘二'];
      const contents = ['第一份未命名稿', '第二份未命名稿', '第三份未命名稿', '磁盘一修订', '磁盘二修订'];
      for (const [i, file] of files.entries()) await writeFile(file, originals[i], { flag: 'wx' });
      const appData = process.platform === 'win32' ? process.env.APPDATA : path.join(homedir(), 'Library', 'Application Support');
      const draftDir = path.join(appData, 'com.lightmark.profile.' + profile, 'drafts');
      fixture = { profile, files, contents, corrupt, reopen: false };
      let damaged;
      await launch(exe, env, async data => {
        assert.equal(path.resolve(data.draftDir), draftDir);
        assert.deepEqual(data.receipts.map(item => item.content).sort(), [...contents].sort());
        for (const receipt of data.receipts) {
          assert.equal(receipt.outcome, 'committed');
          assert.equal(receipt.diskWritten, 'yes');
          assert.match(receipt.id, /^[a-z0-9-]+$/i);
          const file = path.join(draftDir, receipt.id + '.json');
          assert.equal(JSON.parse(await readFile(file, 'utf8')).content, receipt.content);
          if (receipt.content === contents[1]) damaged = file;
        }
        await writeFile(files[0], '外部程序的新版本');
      });
      if (corrupt) await writeFile(damaged, '{invalid json');
      fixture.reopen = true;
      const expected = contents.filter((_, i) => !corrupt || i !== 1);
      const recovered = await launch(exe, env, async data => {
        assert.deepEqual(data.tabs.map(t => t.content).sort(), [...expected].sort());
        assert.ok(data.tabs.every(t => !t.path && t.dirty));
        assert.equal(new Set(data.tabs.map(t => t.id)).size, expected.length);
        assert.equal(data.issue.includes('draft-parse-failed'), corrupt);
        assert.deepEqual(await readFile(files[0]), Buffer.from('外部程序的新版本'));
        assert.deepEqual(await readFile(files[1]), Buffer.from(originals[1]));
        if (corrupt) assert.equal(await readFile(damaged, 'utf8'), '{invalid json');
      });
      console.log(JSON.stringify({ profile, corrupt, committedBeforeKill: 5, recovered: recovered.tabs.length, originalBytesVerified: true }));
    }
  }
  return { plugin, run };
}
