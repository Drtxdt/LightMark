# Windows production release acceptance

Preparation is not acceptance. The Node preparation/build commands never install or launch. The ordinary production default identifier remains `com.lightmark.desktop`. Its Windows KnownFolder paths must not be redirected merely by changing `APPDATA`.

## Official configuration profiles

The production executable supports `LightMark.exe --profile work-1` (also `--profile=work-1`) and `LIGHTMARK_PROFILE=work-1`. CLI takes precedence over the environment. Names must be 1–48 lowercase ASCII letters, digits or hyphens, starting with a letter or digit; duplicate CLI flags, missing values and invalid names fail before creating an app. No argument/environment preserves the existing default profile. Named profiles use `com.lightmark.profile.<name>` and intentionally persist between launches of that name. This is a documented application feature, not a QA JavaScript bridge.

The same production executable hash can therefore use separate settings, drafts, large-file snapshots, workspace index and WebView storage. The implementation changes `Context::config_mut().identifier` before Tauri Builder/plugin initialization. Locked Tauri 2.11.2 `path/desktop.rs` uses that runtime identifier for app config/data/local data; `manager/webview.rs` uses it for the default Windows WebView data directory. Existing backend configuration/draft/index/large-file code uses those app path APIs. Explicit custom CLI export config paths remain explicit caller choices. To pass the same profile to a separately launched `lightmark-cli`/headless app process, set `LIGHTMARK_PROFILE` in that command's environment.

## Current read-only inventory

The 2026-10-24 inventory found no LightMark uninstall registration or shortcut, but an existing profile at `C:\Users\dell\AppData\Roaming\com.lightmark.desktop`. `WindowsSandbox.exe` was absent. The official named profile makes a guarded owned installation in this session possible. The runner still refuses existing installations, manufacturer/startup registrations, shortcuts or LightMark processes and hashes the existing default profile before and after. Sandbox remains an optional alternative; the scripts never enable system features or create Windows users.

## Executable steps

1. Read-only inventory and source evidence:

   ```powershell
   node scripts/qa/windows-release-acceptance.mjs --inspect-only
   ```

2. When all source changes and tests are finished, freeze the workspace and explicitly build:

   ```powershell
   node scripts/qa/windows-release-acceptance.mjs --build
   ```

   This creates a fresh owned run under `.cache/windows-release-acceptance/`. It runs type checking, normal Vite production build and static closure budgets with inherited QA/WebView environment removed, and Tauri release NSIS build. It keeps the production default identity and window title. The generated build config changes build output paths, skips the duplicate before-build command, selects NSIS, and clears `externalBin`: Tauri automatically bundles the additional Cargo CLI binary. The generated NSIS script must contain exactly one CLI destination pointing at the final owned Cargo binary. The ordinary frontend must contain none of the known performance/content-boundary QA bridge markers. Source file hashes are compared before and after the build; any source change rejects artifact provenance.

   `manifest.json` binds the source tree, production frontend tree hash, release executable hash, CLI sidecar hash, NSIS hash and build-config hash. Build success produces `artifacts-built-acceptance-prepared`, never a native acceptance pass. Syntax and negative unit checks do not establish installation or GUI acceptance; use the actual run's report.

   Tauri CLI 2.11.2 temporarily patches the executable's unique `__TAURI_BUNDLE_TYPE_VAR_UNK` marker to `NSS` while generating NSIS, then restores the standalone file. The manifest records the standalone hash separately. The payload and installed-executable lock use a copied executable with exactly those three bytes changed; every other byte participates in its full SHA-256. Missing/duplicate UNK markers and other CLI versions fail closed. The installed main executable and installed CLI must both match their complete locked hashes.

   A reviewed packaging-only correction may reuse a previously frozen build with `--build --reuse-built-run EXISTING_RUN --output NEW_RUN`. This validates all source hashes except the explicit reviewed QA safety-file allowlist, verifies the original standalone and frontend hashes, copies them with the final Cargo CLI into a fresh owned target, and executes `tauri bundle` without compilation. It retains original build/source provenance and new packaging provenance separately. This mode never installs or launches, and cannot accept a production source/configuration change.

3. Choose the guarded owned installation, after closing all existing LightMark windows, and substitute the actual new run directory:

   ```powershell
   $releaseRun = 'E:\my_code\LightMark\.cache\windows-release-acceptance\lightmark-production-release-EXAMPLE'
   Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"$releaseRun\payload\windows-release-sandbox.ps1",'-OwnedHostInstall','-RunDirectory',$releaseRun)
   ```

   It validates the owned build manifest, artifact hashes, fresh installation directory and fresh official profile. It refuses reparse points, existing uninstall/manufacturer/startup registrations, shortcuts or running LightMark processes. It installs to `results/owned-install-work/Installed` using `/S /NS /D=<owned-path>` (the `/D` argument is last), omits `/R`, then starts the exact installed production executable with its fresh `--profile release-...` name. Both CLI and environment select that name. Existing default profile content is hashed, not modified; checkpoints compare it with the baseline. Browser process ancestry and `--user-data-dir` are checked against the named profile.

   This policy is pinned to the reviewed [Tauri CLI 2.11.2 NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi): `/NS` suppresses new shortcuts; a silent install starts the app only with `/R`; application-data deletion belongs to the uninstaller's confirmation checkbox. Silent uninstall skips that checkbox. Other CLI versions, custom NSIS hooks/templates and file associations require review before the owned-host path is used.

   Alternatively, with Windows Sandbox enabled, open `LightMark-acceptance.wsb`. It maps only `payload` read-only and `results` writable. Without `-OwnedHostInstall`, the supervisor refuses any account except Sandbox's `WDAGUtilityAccount`. Its installation is discarded with the disposable OS.

   WebView2 availability, NSIS runtime bootstrap downloads, installer prompts and signing/SmartScreen behavior are real acceptance conditions. Networking remains available for the default WebView2 bootstrap if needed. Do not substitute a development/QA binary when a production step fails.

4. Use the actual production GUI. `results/sandbox-report.json` gives the actual fixture/payload paths in its instructions (Sandbox paths are `C:\LightMarkAcceptance\fixtures` and `C:\LightMarkPayload`; owned-host paths are inside the run). Open `release-loop.md`, select Source mode, replace its contents through real editing with `expected-saved.md`, and save. Send a unique command to the host run's writable `results/command.json`:

   ```json
   {"id":"saved-1","action":"checkpoint"}
   ```

   Inspect `command-result.json` and `sandbox-report.json`. `exactSavedBytes` must be true; screenshots must show the expected text. Close the real app through its UI, then send `{"id":"reopen-1","action":"relaunch"}` and reopen the file through the GUI. Confirm the visible content again.

5. Create an unsaved tab through the GUI, enter `DRAFT_RECOVERY_RELEASE_SENTINEL`, wait for the real autosave, then checkpoint. A persisted draft must contain the marker. Send `{"id":"crash-1","action":"crash-relaunch"}` to stop only the recorded executable/path/hash-bound app process, retaining the disposable profile. Restore the draft through the real recovery UI; capture the recovered text and save it as a second owned file. This tests an actual release restart, not a hand-written backend draft.

6. Finish with an explicit receipt. Each requirement needs `status:"passed"` and concrete `evidence` (checkpoint/screenshot/path/hash). The runner also requires an exact saved-byte checkpoint and an observed persisted draft marker before accepting a pass:

   - `installed-executable-hash`
   - `real-save-exact-bytes`
   - `close-reopen-visible-content`
   - `draft-created-before-crash`
   - `draft-restored-after-relaunch`
   - `normal-release-no-qa-bridge`

   Example shape:

   ```json
   {"id":"final-1","action":"finish","status":"passed","evidence":[{"requirement":"installed-executable-hash","status":"passed","evidence":"sandbox-report installedExecutableHash matches release-lock"}]}
   ```

   This incomplete example cannot pass; supply all six actual observations. A failed or unexecuted step stays failed/incomplete. In owned-host mode a manual pass remains `manual-ui-passed-awaiting-uninstall`. Close the real app through its UI and send `{"id":"remove-1","action":"uninstall"}`. Only the locked owned uninstaller is invoked, and only when recorded registrations remain unchanged. Newly created installer metadata is removed only if it still matches the recorded values; preexisting keys are never deleted. Registry/shortcut state must match the baseline, and the real default profile must remain byte-identical. Only then can the overall owned-host result pass. The named acceptance profile and owned evidence files are retained for inspection. In Sandbox mode, close the Sandbox after exporting results; its OS state is discarded.

## Existing probes and their limits

- `isolated-native-evidence.mjs` ordinary-document, recovery-bundle, math-draft and HTML-security scenarios use a unique QA identifier and a Vite development origin. They can reuse owned fixture content, expected raw-byte assertions, close/reopen ordering, draft marker checks and recovery cases. Their browser-side `/src/...` dynamic imports and instrumentation are unavailable in a normal embedded release and must not be copied into its frontend.
- `native-manual-ui-probe.mjs` provides useful short-evaluation/mailbox patterns, but its formal snapshot calls import development modules. The production release workflow instead uses actual UI save plus filesystem hashes and independent screenshots.
- `performance-release-launcher.mjs` builds a distinct release QA bridge binary. Its timings and isolated runtime checks are valuable, but that binary is not an ordinary production installer acceptance substitute.
- Content-security behavior remains separately covered by the existing HTML-security native scenario; the release UI may additionally open the same malicious-markup fixtures. An installation pass does not imply HTML-security or IME acceptance.

## Evidence and remaining risks

The host inventory is read-only and avoids dumping real profile contents. A compile-time identifier change would alter the tested artifact. The official runtime named profile instead uses the same executable hash, with isolated persistence paths verified at runtime. The guarded host workflow tests a clean temporary installation and uninstallation; upgrades or interaction with existing installations require a separate disposable OS snapshot and separate evidence.

The frontend-marker gate and stable source/artifact hashes establish which ordinary frontend was built and which executable was installed. They do not prove visual rendering, IME composition, draft recovery, or installer success. These remain explicit actual-GUI observations. After any production source change, repeat the build and relevant acceptance against new hashes.
