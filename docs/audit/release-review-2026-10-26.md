# Windows release runner review · 2026-10-26

This review precedes the final production freeze. It does not claim an installer, production WebView, or real GUI acceptance pass. Remaining real IME work is skipped at the user's request.

## Verified source and checks

- The official profile parser keeps the default identity when no selector is given, validates bounded ASCII names, rejects duplicate/missing/unsafe CLI selectors, honors the argument terminator, and gives CLI precedence over the environment. All 12 profile tests passed. `lib.rs` selects the runtime identifier before Builder/plugin initialization.
- Final default parallel `cargo test --manifest-path src-tauri/Cargo.toml` passed: library **123 passed, 0 failed, 1 ignored**; main, CLI and doc test suites had zero tests and passed. TEMP/TMP pointed at the owned `.cache/plan-native-tests` directory. Log: `.cache/plan-native-tests/cargo-test-2026-10-26-final-isolated.log`. The ignored case is the explicit physical 50/100/500MiB matrix, executed separately below.
- `node scripts/check-windows-release-acceptance.mjs` passed. It now also runs the PowerShell runner's syntax check and extracted cleanup function against in-memory stand-ins. No installer or registry mutation occurs in that check.
- Reviewed the pinned [Tauri CLI 2.11.2 NSIS source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi). Its quoted installation/uninstaller registry paths agree with the runner. Silent application data deletion is guarded by the unchecked confirmation state. This remains specific to the pinned template.

## Corrected ownership defect

The previous metadata cleanup could remove a preexisting empty `Software\LightMark` parent key after deleting the newly created product key. Its baseline recorded product keys but omitted parent existence. The inventory now records parent existence and only removes a parent absent from the baseline and still empty. The final inventory comparison includes those parent paths.

The PowerShell regression test extracts only `Remove-OwnedMetadataParent` through the parser AST; it never executes the supervisor. Cases cover an old empty parent, a new empty parent, a parent with another product, and a parent with a foreign value. The regression was first observed failing for the missing guarded function, then passed after the fix.

Windows environment keys are case-insensitive. Lowercase aliases for `TAURI_CONFIG`, `LIGHTMARK_PROFILE`, `WEBVIEW2_*`, QA/performance variables and `CARGO_TARGET_DIR` previously survived the case-sensitive build environment filter. The filter now removes aliases before forcing the owned Cargo output path. A mixed-case regression failed before the fix and passed afterwards.

Malformed Windows UTF-16 in a joined `--profile=<value>` argument previously made `to_str()` fail and silently ignored the selector, permitting a default-profile fallback. It now fails closed before application creation, whether an environment profile exists or not. A standalone Windows `OsString::from_wide` regression reproduced the fallback before the guard and passed afterwards; the same regression is in the normal library suite.

## Latest physical backend evidence

The explicit physical matrix passed for 50MiB short lines, 100MiB single line, and 500MiB single line. The 500MiB case also grew to 500MiB+1, reopened read-only, and restored the original content through undo/save/reopen. The three cumulative functional case durations were 87,659ms / 102,824ms / 470,570ms in an unoptimized debug test binary. They are not release performance results. The complete test took 661.20s; sampled process peak working set was 539,770,880 bytes, including mmap residency.

Manifest, binary hash, all Rust source hashes, logs, and source stability check are retained in `.cache/plan-native-tests/backend-debug-resume-2026-10-26/manifest.json`. Source hashes were stable throughout this run. Afterwards only the profile production guard and test-only large-file changes described here were made; the large-file production implementation remained unchanged.

The final full parallel suite exposed interference between independent job tests sharing the production-wide four-job quota. One failed starting its search while four other test jobs were running. A test-only mutex now sequences those registry-using cases while other unit tests remain parallel; the production limit is unchanged. The full suite then passed, and a targeted `--test-threads=32` run passed 6 job tests with the physical matrix ignored. Both the failure and fixed logs remain in `.cache/plan-native-tests`.

## Save fingerprint review

The ordinary store must use `targetFingerprint` as its installed disk baseline: transaction `outputFingerprint` describes a separately copied recovery artifact whose mtime may differ. No other production frontend consumer of `outputFingerprint` was found. Large-file saves use a different local `output_fingerprint`, captured from the writable temporary file before it is renamed into the native replacement; it is not the independent recovery copy. Added assertions in the two-save large-file rebase test compare the reported disk fingerprint, including mtime, with a fresh fingerprint of the actual installed target. Both passed. No speculative large-save production change was made.

## Remaining acceptance boundary

The final artifact build and production install/save/reopen/draft crash recovery/uninstall loop are still required. The runner prepares those observations and enforces hash/profile evidence; its unit checks cannot establish them. Runtime named-profile paths, including WebView's actual `--user-data-dir`, must be checked using that installed executable.

The restricted command token could not query `Win32_Process` through CIM during a read-only check. The actual supervisor must retain its CIM ancestry check and run through an authorized host execution path that supports it; inability to gather this evidence is not a profile isolation pass.

The large-file backend matrix does not substitute for release GUI checks at 5MiB−1/5MiB/5MiB+1; input while ACK is pending; cross-window selection/navigation; clipboard export; preview; draft restoration; or 100%/125%/150% Windows scaling. Release performance needs its own fixed-artifact distributions, long tasks, memory, and correctness observations. Historical physical backend timings were cumulative and are not per-command latency percentiles.
