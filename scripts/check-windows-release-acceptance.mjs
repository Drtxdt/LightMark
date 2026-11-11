import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanReleaseEnvironment, inspectReleaseTree, sandboxConfiguration, FORBIDDEN_RELEASE_MARKERS, expectedNsisExecutable, assertRepackageSources, inspectNsisInputPaths } from './qa/windows-release-acceptance.mjs';
const standalone = Buffer.from('prefix__TAURI_BUNDLE_TYPE_VAR_UNKsuffix');
assert.equal(expectedNsisExecutable(standalone, '2.11.2').toString(), 'prefix__TAURI_BUNDLE_TYPE_VAR_NSSsuffix');
assert.equal(standalone.toString(), 'prefix__TAURI_BUNDLE_TYPE_VAR_UNKsuffix', 'standalone bytes must remain immutable');
assert.throws(() => expectedNsisExecutable(standalone, '2.11.3'), /pinned/);
assert.throws(() => expectedNsisExecutable(Buffer.from('no marker'), '2.11.2'), /unique/);
assert.throws(() => expectedNsisExecutable(Buffer.concat([standalone, standalone]), '2.11.2'), /unique/);
assert.throws(() => expectedNsisExecutable(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'), '2.11.2'), /UNK/);
assert.ok(expectedNsisExecutable(Buffer.concat([Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'), standalone]), '2.11.2').includes(Buffer.from('prefix__TAURI_BUNDLE_TYPE_VAR_NSSsuffix')), 'an existing NSS comparison constant is not the mutable unique UNK marker');
const sourceRecords = [{path:'src/main.ts',sha256:'same'}, {path:'scripts/qa/windows-release-acceptance.mjs',sha256:'old'}];
assert.doesNotThrow(() => assertRepackageSources(sourceRecords, [{...sourceRecords[0]}, {...sourceRecords[1],sha256:'new'}]));
assert.throws(() => assertRepackageSources(sourceRecords, [{...sourceRecords[0],sha256:'changed'}, sourceRecords[1]]), /Source changed/);
assert.throws(() => assertRepackageSources(sourceRecords, sourceRecords.slice(1)), /Source changed/);
assert.throws(() => assertRepackageSources(sourceRecords, [...sourceRecords,{path:'src/untracked.ts',sha256:'new'}]), /Source changed/);
const nsisInputs = '!define MAINBINARYSRCPATH "C:\\owned\\lightmark.exe"\nFile /a "/oname=lightmark-cli.exe" "C:\\owned\\lightmark-cli.exe"\n';
assert.equal(inspectNsisInputPaths(nsisInputs, 'C:\\owned\\lightmark.exe', 'C:\\owned\\lightmark-cli.exe').sidecarOccurrences, 1);
assert.throws(() => inspectNsisInputPaths(nsisInputs + 'File /a "/oname=lightmark-cli.exe" "C:\\foreign\\lightmark-cli.exe"\n', 'C:\\owned\\lightmark.exe', 'C:\\owned\\lightmark-cli.exe'), /exactly one/);
assert.throws(() => inspectNsisInputPaths(nsisInputs, 'C:\\foreign\\lightmark.exe', 'C:\\owned\\lightmark-cli.exe'), /main executable/);
const clean = cleanReleaseEnvironment({ PATH:'kept', TAURI_CONFIG:'unsafe override', WEBVIEW2_USER_DATA_FOLDER:'real profile', VITE_LIGHTMARK_PERF_QA:'1', VITE_LIGHTMARK_PERF_CONFIG_JSON:'{}', VITE_LIGHTMARK_QA_PROBE_MODE:'content-boundary', LIGHTMARK_QA_RUN_DIR:'old', LIGHTMARK_PERF_NONCE:'old', CARGO_TARGET_DIR:'old' }, 'owned-target');
assert.deepEqual(clean, { PATH:'kept', CARGO_TARGET_DIR:'owned-target' });
assert.deepEqual(cleanReleaseEnvironment({ Path:'kept', tauri_config:'unsafe', lightmark_profile:'real', webview2_user_data_folder:'real', vite_lightmark_perf_qa:'1', cargo_target_dir:'inherited' }, 'owned-target'), { Path:'kept', CARGO_TARGET_DIR:'owned-target' });
const owned = await mkdtemp(path.join(process.cwd(), 'node_modules', '.lightmark-production-acceptance-'));
try {
  const dist=path.join(owned,'dist'); await mkdir(dist); await writeFile(path.join(dist,'index.html'), '<div id="app"></div>'); await writeFile(path.join(dist,'app.js'), 'production();');
  const first=await inspectReleaseTree(dist), second=await inspectReleaseTree(dist);
  assert.equal(first.passed,true); assert.equal(first.sha256,second.sha256);
  await writeFile(path.join(dist,'app.js'), FORBIDDEN_RELEASE_MARKERS[0]);
  const rejected=await inspectReleaseTree(dist); assert.equal(rejected.passed,false); assert.equal(rejected.forbidden[0].marker,FORBIDDEN_RELEASE_MARKERS[0]);
  const config=sandboxConfiguration('C:\\owned & read-only','C:\\owned-results');
  assert.match(config,/owned &amp; read-only/); assert.equal((config.match(/<ReadOnly>true<\/ReadOnly>/g)||[]).length,1); assert.equal((config.match(/<ReadOnly>false<\/ReadOnly>/g)||[]).length,1);
  assert.match(config,/-WindowStyle Hidden/); assert.doesNotMatch(config,/LightMark-setup\.exe/,'host config launches only the guarded Sandbox runner');
  const runner=await readFile(new URL('./qa/windows-release-sandbox.ps1',import.meta.url),'utf8');
  assert.ok(runner.indexOf("[Environment]::UserName -ne 'WDAGUtilityAccount'") < runner.indexOf('Start-Process -FilePath (Join-Path $payloadRoot'));
  assert.match(runner,/Installed executable does not match the locked production release hash/);
  assert.match(runner,/Installed Cargo sidecar does not match the locked production hash/);
  assert.match(runner,/Assert-OwnedProcess; Stop-Process -Id \$process.Id/);
  assert.match(runner,/Acceptance lacks required exact-save\/draft\/manual evidence/);
  assert.match(runner,/manualAcceptance='not-run'/);
  assert.match(runner,/Use the Open File button to open/);
  assert.doesNotMatch(runner,/Ctrl\+O:/,'acceptance instructions must use the available Open File control');
  if (process.platform === 'win32') {
    const regression = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts/qa/check-windows-release-runner.ps1')], { encoding: 'utf8', windowsHide: true });
    assert.equal(regression.status, 0, regression.stderr || regression.stdout || regression.error?.message);
  }
} finally {
  const root=path.resolve(process.cwd(),'node_modules'); assert.ok(path.resolve(owned).startsWith(root+path.sep)); await rm(owned,{recursive:true,force:true});
}
console.log('Windows release preparation checks passed (normal artifact gate, environment stripping, Sandbox isolation, explicit evidence receipts; no installer/build/GUI was run).');
