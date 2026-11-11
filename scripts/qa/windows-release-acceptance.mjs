import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, lstat, readFile, copyFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRepositoryEvidence, captureWorkspaceHashes, createEvidenceDirectory, repositoryRoot, runCaptured, writeJson } from './evidence.mjs';

export const FORBIDDEN_RELEASE_MARKERS = ['__LIGHTMARK_PERF_BRIDGE__', 'performanceQaBridge', 'desktopContentBoundaryQaBridge', 'VITE_LIGHTMARK_PERF_CONFIG_JSON', 'VITE_LIGHTMARK_QA_PROBE_MODE'];
const REQUIREMENTS = ['installed-executable-hash', 'real-save-exact-bytes', 'close-reopen-visible-content', 'draft-created-before-crash', 'draft-restored-after-relaunch', 'normal-release-no-qa-bridge'];
const REPACKAGE_SAFETY_PATHS = ['scripts/qa/windows-release-acceptance.mjs', 'scripts/check-windows-release-acceptance.mjs', 'scripts/qa/windows-release-sandbox.ps1', 'scripts/qa/WINDOWS_RELEASE_ACCEPTANCE.md', 'scripts/qa/isolated-native-evidence.mjs'];
export function expectedNsisExecutable(bytes, cliVersion) {
  if (cliVersion !== '2.11.2') throw new Error('NSIS executable derivation requires the pinned Tauri CLI 2.11.2');
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), position = bytes.indexOf(marker);
  if (position < 0 || bytes.indexOf(marker, position + 1) >= 0) throw new Error('Expected a unique Tauri UNK bundle type marker');
  const offset = position + marker.length - 3;
  const patched = Buffer.from(bytes);
  patched.write('NSS', offset, 3, 'ascii');
  return patched;
}
export function assertRepackageSources(previous, current) {
  const allowed = new Set(REPACKAGE_SAFETY_PATHS);
  if (!previous?.length || !current?.length) throw new Error('Source changed: missing source evidence');
  const before = new Map(previous.map(record => [record.path, record])), after = new Map(current.map(record => [record.path, record]));
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (allowed.has(name)) continue;
    if (!before.get(name)?.sha256 || before.get(name)?.sha256 !== after.get(name)?.sha256) throw new Error(`Source changed outside reviewed packaging safety files: ${name}`);
  }
}
export function inspectNsisInputPaths(source, executable, sidecar) {
  const main = [...source.matchAll(/^\s*!define MAINBINARYSRCPATH "([^"]+)"/gm)];
  const sidecars = [...source.matchAll(/^\s*File(?:\s+\/a)?\s+"\/oname=lightmark-cli\.exe"\s+"([^"]+)"/gm)];
  const canonical = value => value.replaceAll('/', '\\').toLowerCase();
  if (main.length !== 1 || canonical(main[0][1]) !== canonical(executable)) throw new Error('NSIS main executable input does not match the owned target');
  if (sidecars.length !== 1 || canonical(sidecars[0][1]) !== canonical(sidecar)) throw new Error('NSIS must contain exactly one owned Cargo sidecar destination');
  return { mainExecutable: main[0][1], sidecar: sidecars[0][1], sidecarOccurrences: sidecars.length };
}
export function cleanReleaseEnvironment(environment, target) {
  const result = { ...environment };
  for (const name of Object.keys(result)) if (/^(?:VITE_LIGHTMARK_.*QA|VITE_LIGHTMARK_PERF_|LIGHTMARK_(?:QA|PERF)_|WEBVIEW2_)/i.test(name) || ['TAURI_CONFIG', 'LIGHTMARK_PROFILE', 'CARGO_TARGET_DIR'].includes(name.toUpperCase())) delete result[name];
  // Windows environment keys are case-insensitive; remove aliases before forcing the owned target.
  result.CARGO_TARGET_DIR = target;
  return result;
}
export async function inspectReleaseTree(root) {
  const records = [], forbidden = [], hash = createHash('sha256');
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = path.join(directory, name), stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Artifact symlink refused: ${absolute}`);
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) {
        const bytes = await readFile(absolute), relative = path.relative(root, absolute).replaceAll('\\', '/');
        const digest = createHash('sha256').update(bytes).digest('hex');
        records.push({ path: relative, bytes: bytes.length, sha256: digest });
        hash.update(relative).update('\0').update(bytes);
        for (const marker of FORBIDDEN_RELEASE_MARKERS) if (bytes.includes(Buffer.from(marker))) forbidden.push({ path: relative, marker });
      }
    }
  }
  const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Release dist must be a real directory');
  await visit(root);
  return { sha256: hash.digest('hex'), files: records, forbidden, passed: records.length > 0 && forbidden.length === 0 };
}
export const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function sandboxConfiguration(payload, results) {
  return `<Configuration><VGpu>Enable</VGpu><Networking>Default</Networking><ClipboardRedirection>Enable</ClipboardRedirection><MappedFolders><MappedFolder><HostFolder>${xml(payload)}</HostFolder><SandboxFolder>C:\\LightMarkPayload</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xml(results)}</HostFolder><SandboxFolder>C:\\LightMarkResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\LightMarkPayload\\windows-release-sandbox.ps1</Command></LogonCommand></Configuration>\n`;
}
async function fileRecord(file) { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected ordinary artifact file: ${file}`); const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
function sourceIdentity(repository) { return createHash('sha256').update(JSON.stringify(repository.workspace?.files ?? repository.files ?? [])).digest('hex'); }
export async function detectHostInstallations() {
  if (process.platform !== 'win32') return { platform: process.platform, unavailable: 'Windows inventory only', mutations: false };
  const expression = `$ErrorActionPreference='Stop'; $roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); $apps=@(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'LightMark' } | Select-Object DisplayName,DisplayVersion,InstallLocation,PSPath); $dirs=@([Environment]::GetFolderPath('ApplicationData'),[Environment]::GetFolderPath('LocalApplicationData')); $profiles=@($dirs | ForEach-Object { $p=Join-Path $_ 'com.lightmark.desktop'; if(Test-Path -LiteralPath $p){ Get-Item -LiteralPath $p | Select-Object FullName,LastWriteTime } }); $links=@(@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*LightMark*.lnk' -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,LastWriteTime }); [pscustomobject]@{installations=$apps;profiles=$profiles;shortcuts=$links;sandboxExecutable=(Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\\WindowsSandbox.exe'));mutations=$false} | ConvertTo-Json -Depth 5 -Compress`;
  const result = await runCaptured('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expression]);
  if (result.exitCode !== 0) return { mutations: false, error: result.stderr, exitCode: result.exitCode };
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
async function command(context, name, executable, args, env) {
  console.log(JSON.stringify({ kind: 'production-release-build-step', name, startedAt: new Date().toISOString() }));
  const start = new Date().toISOString(), result = await runCapturedWithEnvironment(executable, args, env);
  await writeFile(path.join(context.runDir, `${name}.stdout.log`), result.stdout);
  await writeFile(path.join(context.runDir, `${name}.stderr.log`), result.stderr);
  context.manifest.commands.push({ name, executable, args, startedAt: start, endedAt: new Date().toISOString(), exitCode: result.exitCode });
  await writeJson(path.join(context.runDir, 'manifest.json'), context.manifest);
  if (result.exitCode !== 0) throw new Error(`${name} failed; inspect owned logs`);
}
async function runCapturedWithEnvironment(executable, args, env) {
  const { spawn } = await import('node:child_process');
  return new Promise(resolve => { const child = spawn(executable, args, { cwd: repositoryRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data); child.on('error', error => resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error}` })); child.on('close', exitCode => resolve({ exitCode, stdout, stderr })); });
}
export async function prepareWindowsReleaseAcceptance({ output, build = false, reuseBuiltRun } = {}) {
  if (reuseBuiltRun && !build) throw new Error('--reuse-built-run requires --build and performs only repackaging');
  const previous = reuseBuiltRun ? JSON.parse(await readFile(path.join(path.resolve(reuseBuiltRun), 'manifest.json'), 'utf8')) : null;
  if (previous && (previous.kind !== 'windows-production-release-acceptance' || previous.status !== 'artifacts-built-acceptance-prepared' || !previous.artifacts?.sourceStableDuringBuild || previous.runDir !== path.resolve(reuseBuiltRun))) throw new Error('Repackage requires a stable completed production build manifest');
  const parent = path.join(repositoryRoot, '.cache', 'windows-release-acceptance'); await mkdir(parent, { recursive: true });
  const runDir = output ? await createEvidenceDirectory('lightmark-production-release-', output) : await mkdtemp(path.join(parent, 'lightmark-production-release-'));
  const repository = await captureRepositoryEvidence(repositoryRoot, runDir);
  const manifest = { schemaVersion: 1, kind: 'windows-production-release-acceptance', status: 'prepared-only', startedAt: new Date().toISOString(), runDir, sourceIdentity: sourceIdentity(repository), repository, hostInventory: await detectHostInstallations(), commands: [], requirements: REQUIREMENTS, nativeAcceptance: 'not-run', installerExecutedOnHost: false };
  const context = { runDir, manifest }; await writeJson(path.join(runDir, 'manifest.json'), manifest);
  if (!build) return { runDir, status: manifest.status, hostInventory: manifest.hostInventory, next: 'Run with --build only when source is frozen; it builds ordinary production artifacts and prepares guarded owned-install and optional Sandbox acceptance without launching either.' };
  if (process.platform !== 'win32') throw new Error('Windows release build requires Windows');
  const target = path.join(runDir, 'target'), dist = path.join(runDir, 'production-dist'), payload = path.join(runDir, 'payload'), results = path.join(runDir, 'results');
  await Promise.all([mkdir(target), mkdir(payload), mkdir(results)]);
  const env = cleanReleaseEnvironment(process.env, target);
  if (previous) {
    assertRepackageSources(previous.repository.workspace.files, repository.workspace.files);
    const originalStandalone = previous.artifacts.standaloneExecutable ?? previous.artifacts.executable;
    const actualStandalone = await fileRecord(originalStandalone.path);
    if (actualStandalone.sha256 !== originalStandalone.sha256) throw new Error('Original standalone executable changed');
    const originalDist = path.join(previous.runDir, 'production-dist'), originalFrontend = await inspectReleaseTree(originalDist);
    if (!originalFrontend.passed || originalFrontend.sha256 !== previous.artifacts.frontend.sha256) throw new Error('Original frontend changed');
    const originalSidecar = await fileRecord(path.join(path.dirname(originalStandalone.path), 'lightmark-cli.exe'));
    const originalNsis = await fileRecord(path.join(previous.runDir, 'target/release/nsis/x64/installer.nsi'));
    await mkdir(path.join(target, 'release'));
    await copyFile(originalStandalone.path, path.join(target, 'release/lightmark.exe'));
    await copyFile(originalSidecar.path, path.join(target, 'release/lightmark-cli.exe'));
    await cp(originalDist, dist, { recursive: true, errorOnExist: true, force: false });
    manifest.repackagedFrom = { runDir: previous.runDir, sourceIdentity: previous.sourceIdentity, standaloneExecutable: actualStandalone, cargoSidecar: originalSidecar, generatedNsis: originalNsis, frontendHash: originalFrontend.sha256, allowedSourceChanges: REPACKAGE_SAFETY_PATHS, compileExecuted: false };
  } else {
    await command(context, 'typecheck', process.execPath, [path.join(repositoryRoot, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit'], env);
    await command(context, 'production-frontend', process.execPath, [path.join(repositoryRoot, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist], env);
    await command(context, 'production-bundle-budget', process.execPath, [path.join(repositoryRoot, 'scripts/check-bundle-budget.mjs'), '--dist', dist, '--json'], env);
  }
  const frontend = await inspectReleaseTree(dist); if (!frontend.passed) throw new Error('Ordinary production frontend contains QA bridge markers or is empty');
  const base = JSON.parse(await readFile(path.join(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (base.identifier !== 'com.lightmark.desktop' || base.productName !== 'LightMark') throw new Error('Production identity unexpectedly changed');
  if (base.bundle?.fileAssociations?.length || base.bundle?.windows?.nsis?.installerHooks || base.bundle?.windows?.nsis?.template) throw new Error('Owned host-install policy requires a separate review for NSIS hooks, custom templates or file associations');
  const configPath = path.join(runDir, 'tauri.production.acceptance.json');
  // Tauri already includes the additional Cargo binary. externalBin would emit
  // a duplicate destination, silently overwritten by that automatically bundled binary.
  await writeJson(configPath, { ...base, build: { ...base.build, beforeBuildCommand: null, frontendDist: path.relative(path.join(repositoryRoot, 'src-tauri'), dist).replaceAll('\\', '/') }, bundle: { ...base.bundle, active: true, targets: ['nsis'], externalBin: [] } });
  const require = createRequire(import.meta.url), cliPackagePath = require.resolve('@tauri-apps/cli/package.json');
  const cliPackage = JSON.parse(await readFile(cliPackagePath, 'utf8')), cliBin = typeof cliPackage.bin === 'string' ? cliPackage.bin : cliPackage.bin.tauri;
  if (cliPackage.version !== '2.11.2') throw new Error('Re-review packaging policy before using a different Tauri CLI');
  await command(context, 'production-release-nsis', process.execPath, [path.resolve(path.dirname(cliPackagePath), cliBin), previous ? 'bundle' : 'build', '--bundles', 'nsis', '--config', configPath], env);
  const exe = path.join(target, 'release/lightmark.exe'), nsisDirectory = path.join(target, 'release/bundle/nsis');
  const installers = (await readdir(nsisDirectory)).filter(name => name.endsWith('.exe')); if (installers.length !== 1) throw new Error('Expected exactly one NSIS installer');
  const installer = path.join(nsisDirectory, installers[0]);
  const nsisScript = path.join(target, 'release/nsis/x64/installer.nsi');
  const nsisInputs = inspectNsisInputPaths(await readFile(nsisScript, 'utf8'), exe, path.join(target, 'release/lightmark-cli.exe'));
  const current = await captureWorkspaceHashes(repositoryRoot); if (sourceIdentity(current) !== manifest.sourceIdentity) throw new Error('Source changed during build; artifact provenance is rejected');
  const standaloneExecutable = await fileRecord(exe);
  await writeFile(path.join(payload, 'lightmark.exe'), expectedNsisExecutable(await readFile(exe), cliPackage.version));
  manifest.artifacts = { frontend, standaloneExecutable, executable: await fileRecord(path.join(payload, 'lightmark.exe')), installer: await fileRecord(installer), sidecar: await fileRecord(path.join(target, 'release/lightmark-cli.exe')), productionIdentifier: base.identifier, buildConfig: await fileRecord(configPath), nsisScript: await fileRecord(nsisScript), nsisInputs, sourceStableDuringBuild: true, installedExecutableDerivation: { toolchain: 'tauri-cli-2.11.2', uniqueMarker: '__TAURI_BUNDLE_TYPE_VAR_UNK', from: 'UNK', to: 'NSS', changedBytes: 3 } };
  await copyFile(installer, path.join(payload, 'LightMark-setup.exe'));
  await copyFile(fileURLToPath(new URL('./windows-release-sandbox.ps1', import.meta.url)), path.join(payload, 'windows-release-sandbox.ps1'));
  await writeFile(path.join(payload, 'release-loop.md'), '# Windows release acceptance\r\n\r\nInitial fixture.\r\n', 'utf8');
  await writeFile(path.join(payload, 'expected-saved.md'), '# Windows release acceptance\r\n\r\nWINDOWS_SAVED_中文\r\n\r\n`**literal**` and $x^2$\r\n', 'utf8');
  const profileName = `release-${createHash('sha256').update(runDir).digest('hex').slice(0, 16)}`;
  await writeJson(path.join(payload, 'release-lock.json'), { sourceIdentity: manifest.sourceIdentity, executable: manifest.artifacts.executable, standaloneExecutable: manifest.artifacts.standaloneExecutable, installedExecutableDerivation: manifest.artifacts.installedExecutableDerivation, sidecar: manifest.artifacts.sidecar, installer: manifest.artifacts.installer, frontendHash: frontend.sha256, requirements: REQUIREMENTS, profileName, profileIdentifier: `com.lightmark.profile.${profileName}`, cliVersion: cliPackage.version, installerPolicy: 'tauri-cli-2.11.2-default-nsis-silent-no-shortcuts-no-autorun', preparedOnly: true });
  await writeFile(path.join(runDir, 'LightMark-acceptance.wsb'), sandboxConfiguration(payload, results));
  manifest.status = 'artifacts-built-acceptance-prepared'; manifest.profile = { name: profileName, identifier: `com.lightmark.profile.${profileName}` }; manifest.sandbox = { config: path.join(runDir, 'LightMark-acceptance.wsb'), payload, results, launched: false }; manifest.ownedHostInstall = { runner: path.join(payload, 'windows-release-sandbox.ps1'), runDirectory: runDir, requiredSwitch: '-OwnedHostInstall', launched: false }; manifest.endedAt = new Date().toISOString();
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  return { runDir, status: manifest.status, sandbox: manifest.sandbox, ownedHostInstall: manifest.ownedHostInstall, artifacts: manifest.artifacts, nativeAcceptance: 'not-run' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), index = args.indexOf('--output'), reuseIndex = args.indexOf('--reuse-built-run');
  if (args.some(arg => !['--build', '--inspect-only', '--output', '--reuse-built-run'].includes(arg) && (index < 0 || arg !== args[index + 1]) && (reuseIndex < 0 || arg !== args[reuseIndex + 1]))) throw new Error('Usage: node scripts/qa/windows-release-acceptance.mjs [--inspect-only|--build] [--output NEW_DIRECTORY] [--reuse-built-run EXISTING_BUILT_DIRECTORY]');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('--output requires a new directory');
  if (reuseIndex >= 0 && (!args[reuseIndex + 1] || args[reuseIndex + 1].startsWith('--'))) throw new Error('--reuse-built-run requires an existing built directory');
  prepareWindowsReleaseAcceptance({ output: index >= 0 ? args[index + 1] : undefined, build: args.includes('--build'), reuseBuiltRun: reuseIndex >= 0 ? args[reuseIndex + 1] : undefined }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
