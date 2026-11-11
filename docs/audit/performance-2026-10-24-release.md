# Windows performance release preparation — 2026-10-24

Status: measurement tooling implemented and behavior checks pass. The current bundle numbers are a **candidate build**, not final release performance acceptance. Real release sampling is still required; fixture/report unit tests are synthetic gate tests and provide no UI latency evidence.

## Candidate production bundle

`node node_modules/vite/bin/vite.js build` passed (22.82s). Static JavaScript dependency closure, unique files, each file gzip compressed independently:

| Closure | gzip KiB | Budget KiB |
|---|---:|---:|
| Shell | 203.9 | 210 |
| Shell + Source | 319.0 | 330 |
| Shell + WYS | 594.5 | 650 |

Machine-readable file sizes and SHA-256: `.cache/performance-stage-bundle-budget.json`; manifest SHA-256 `5d2661c8bf4fb5b7382bf48c74120d36b040707873b4e6b7586dd4e237aff943`. This candidate predates subsequent ordinary-editor fixes. Rerun on final frozen source. CSS and dynamic imports are explicitly outside this JS static-closure metric.

## Sampling contract

Eight fixtures: ordinary writing; dedicated large Source; formula-, table-, image-dense; long lines; exactly 50,000 Source payload lines; exactly 50,000 WYS payload paragraphs. Generated wrapper lines/blocks are additional and separately reported. Fixture byte, UTF-16, line and syntax metrics plus hashes are recorded in the fixture manifest. Exact 5MiB−1/5MiB/5MiB+1 boundary fixtures remain separate.

The 50k fixtures sample head Enter, head Backspace and one atomic transaction editing two distant ranges. Dense fixtures retain separate groups. The multi-range command uses owned CM `EditorView.findFromDOM` or the owned WYS session's editor identity. It dispatches through the editor's real callbacks/history; it does not replace JSON or bypass application callbacks.

Separate metrics:

- Synchronous multi-range command, model computation and remaining synchronous dispatch (which can include DOM/listeners). These are command timings, never painting latency.
- Browser-local captured input/key event → synchronous documentRuntime revision publication.
- Event → MutationObserver callback in the owned editable root.
- Event → rAF opportunity, scheduled from the model/DOM callbacks without waiting for a host completion RPC.
- First sample of each round: compositor screenshot readback plus browser clock RPC upper bound, including transport/PNG overhead. It does not verify physical display presentation; physical presentation remains unobserved/null.
- Host CDP input round trip, reported separately from browser clocks.
- PerformanceObserver long tasks, or explicit unsupported/missing status; JS heap before each round and after reset; owned app plus descendant process working set/private bytes after each fixture. Shared working-set pages may be counted more than once. No forced GC.

Reports retain P50/P95/max, sample/missing counts and failed sample IDs/reasons for each phase within each fixture/mode/operation group. Missing data is never filled from another phase. Physical-presentation latency stays missing. Formula UI commit and real clipboard paste are explicitly unsupported by this harness and require their separate owned UI phase.

Correctness runs outside measured intervals. Normal mode compares immutable roots after reset, native bookmark bounds, sentinels and disk hashes; nonempty history performs undo/redo and compares exact source plus bookmark. Large scroll mode compares bounded backend/window text, scalar-safe logical bookmarks, 4KiB head/tail sentinels, unchanged revision/pending state and the launcher disk hash. This large scroll measurement does not claim large editing history coverage; the dedicated native large-source probe supplies that behavior evidence.

## Reproduction

From `E:\my_code\LightMark` in PowerShell, with no concurrent native QA window:

```powershell
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node scripts/check-performance-measurement.mjs
node scripts/check-performance.mjs
node node_modules/vite/bin/vite.js build
node scripts/check-bundle-budget.mjs --json > .cache/performance-final-bundle-budget.json
node scripts/qa/performance-release-launcher.mjs --launch --build-qa --normal-dist E:\my_code\LightMark\dist --output E:\my_code\LightMark\.cache\performance-release-smoke --smoke
```

Smoke is one startup sample per stage, one round and one operation per group; it must remain statistically ineligible. After resolving any smoke failures, run the same command with a new output directory and remove `--smoke` for ten cold-profile / ten warm-restart startup samples and three rounds of 100 operations per interaction group. Startup cold means a new app process/profile, not a flushed Windows disk cache. The launcher creates its own random identifier, paths, target directory, release executable and loopback CDP port; it verifies process/profile ownership and normal-build bridge absence. A full Rust release build may take several minutes.

Each run retains repository evidence, full working-tree evidence hash, fixture manifest, compiled front-end/executable hashes, isolated config, raw NDJSON samples, report, events, failure samples and cleanup evidence. Final source must remain stable through build and sampling, and resulting report gates must pass before claiming release acceptance.

## Checks executed

- TypeScript check passed after the QA changes.
- `check-performance-measurement.mjs` passed: eight fixtures, exact 50k payload counts, UTF-8 boundary sizes, raw-sample hash, stage separation, missing presentation, failure retention and report gates. Its 2,420 samples are synthetic.
- Static performance architecture check passed; explicitly performs no UI timing.
- Candidate production build and all three bundle closure budgets passed as above.
- Launcher preparation passed without starting a native process: `.cache/performance-candidate-prepare/lightmark-performance-release-7FXZvP`; preparation source evidence SHA-256 `a3b1c2e76fa9b52fcad82cee590b725804a0f37637640bbce915cdf4e1764a8a`. It correctly reports zero samples and ineligible status.
- QA Vite production build passed (31.68s). Artifact isolation check passed: normal tree `687ddf95bb2a8ffe539e03d14ac0fe6bf081b2c86d3e24e2b03814b5182d6404` contains no QA bridge markers; candidate QA tree `c6051398c09e62346d0e7d2933c1c0ad7679e254bdc623744f2a5286ad56cb3e` contains the required bridge. Evidence `.cache/performance-candidate-artifact-check.json`. Subsequent QA cleanup edits and ordinary-editor work require rebuilding before native measurement.

Not yet established by these checks: release P50/P95 input latency, physical Windows presentation time, retained memory after many native open/close cycles, actual Windows IME, or final-source complete desktop acceptance.

## Native candidate attempts

Failed attempts are retained under `.cache/performance-release-smoke`:

- `wrSEvv`, `AlDJN1`: Windows Tauri before-build command quoting failed. Fixed by spawning Vite with argv before Tauri; no UI samples.
- `5HZVZt`: Rust release build passed in 3m08s; Windows absolute `frontendDist` was interpreted as a file URL directory page and strict origin verification rejected it. Fixed to a path relative to `src-tauri`.
- `gfpYpH`: embedded frontend built; strict profile check rejected the standard `EBWebView` child. Fixed to accept only the exact owned profile root or this fixed child; unrelated directories remain rejected.
- `WSJcns`: real cold-profile startup 2689.8ms and warm restart 2380.9ms (one sample each, no statistical eligibility). Interactive setup then exposed a production WYS→Source error, `源码与文档片段数量不一致，已保留原始内容。`, in `markdownPositionMap/historySource` for the ordinary-writing HTML-comment/list/code fixture. This failure remains evidence; it is not counted as successful interaction. Owned processes exited and ports closed. This candidate may overlap an independent export probe and cannot be used as a comparative performance baseline.

Subsequent performance fixture opens choose the fixture's first supported editor directly via the isolated in-memory default (restored immediately after opening). Open/editor sampling does not require an unmeasured mode conversion first; separate conversion correctness remains outstanding. Individual fixture failures are now retained and later fixtures continue. Repeated builds may set `LIGHTMARK_PERF_CARGO_CACHE` to a prior compiler target **inside the explicit output root**; symlink checks apply, Tauri rebuilds the new frontend/config, and the resulting executable is copied and hashed in the new owned run. This reuses compiler cache, never an external unbuilt executable.

`qE9rvs` found a probe race while checking a reused profile: WebView2 asynchronously deleted a `.tmp` child between enumeration and `lstat`. Inspection now tolerates only disappeared children; the owned root and existing symlinks remain checked.

`XEWhvo` completed with **15 raw records, 14 correctness checks, invalid verdict**. It retains two successful startup records and real interaction records from all six ordinary/dense/large categories, Source 50k and the first WYS 50k Enter. Selected single samples (no distribution or comparison claim): Source multi-range synchronous command 121.4ms (model 89.8ms, remaining dispatch 31.6ms); WYS 50k opening 10.708s; WYS Enter to rAF opportunity 1014.2ms. WYS derived counters for that Enter show 2 recomputed blocks, 96 index visits, 2 block visits, zero materialized block arrays. Subsequent `verify` failed with CDP timeouts; later reset/verify also timed out. The owned renderer reached 207.17 CPU seconds and 3,311,575,040 bytes working set / 3,116,875,776 private bytes during this failure. The process exited via owned harness cleanup before an independently identity-checked cleanup attempt, which correctly refused to kill a missing/reused PID.

The failure is narrowed to verification after the successful input (snapshot / history validation), not initial mount. The first dirty production snapshot unnecessarily DOM-serialized and HTML-converted all 50,000 immutable blocks. An aligned baseline now supplies unchanged block source by node identity, including the separate preserved-document history serializer. Generated footnote pseudo-blocks retain the compatibility serializer; fallback values trim terminal EOL while original identity anchors still emit exact bytes. `check-snapshot-preserved.mjs` executes the production cache with 50,000 blocks and counts the actual serialization/conversion callbacks: first dirty save 1 block; head split cumulative 2; subsequent source checkpoint/export stays 2. Production native snapshot diagnostics are still required to verify the actual DOM factory counts and eliminate any remaining post-snapshot cost.

Additional probe fixes: fixture sentinel IDs now use uppercase consistently with the assertion regex (the old lowercase markers made every sentinel comparison false); Source Enter injection now includes a character event after keyDown, matching the browser insertion path; browser console phase events are persisted immediately to host NDJSON for snapshot, root comparison, undo, redo and reset. After the first renderer timeout later RPCs fail fast and preserve owned process memory, rather than multiplying 15-second waits. QA owned WYS probes separately measure model application, `view.updateState`, key handler duration and remaining handler work, restoring original method descriptors afterward.

Source multi-range outline proposal was initially held unapplied in `.cache/source-multi-range/integration.patch`. Its test executes the current production aggregate-range scanner (50,002 actual line reads for two distant edits), versus the proposed persistent Text local updates (338 reads for two distant edits; 595 for three). A 150-step mixed fence/heading randomized sequence matches full rebuilds. It was subsequently reviewed and integrated after the UI freeze; native remeasurement remains outstanding (see handoff below). It does not establish native input latency improvement by itself.

New builds can hold `LIGHTMARK_PERF_LAUNCH_GATE` at a file within the explicit output root. The launcher builds and waits until that file is removed, preventing native sampling from overlapping normal/export/manual validation. Candidate `U7xI4W` was initially compiled and held behind this gate; its subsequent sampling result is recorded below.

## Safe stop and handoff — 2026-10-25

Work stopped at the user's request to preserve remaining usage allowance. No new implementation, build or sampling is running. A final CIM check found **no owned performance LightMark application, release-performance Node launcher or auxiliary owned CDP inspection process**. The gated launcher and auxiliary inspection sessions both returned completed exit results. Existing files and evidence are retained; nothing was reset or committed.

The prior paragraph describes the earlier gate state. The gate was subsequently released with authorization and `U7xI4W` sampled, then exited through fail-fast cleanup. Its host phase journal proves:

- WYS 50k first dirty formal snapshot completed in **254.3ms**, with actual production DOM serialization count **2** and reused blocks **50,002**, zero compatibility oracle passes.
- Its undo took **3.175s**, reset replacement **6.816s**; verification after reset then exceeded the **15-second** CDP RPC timeout. The default CDP timeout is 15 seconds, not 120 seconds; previous wording and intermediate messages using 120 seconds were incorrect. Repeated timeouts caused the earlier long aggregate delay.
- After-reset verification started `verify-snapshot-start` but never reached its completion phase. The owned process memory receipt at failure totals 3,233,869,824 bytes working set and 3,046,227,968 private bytes across app/WebView children (shared working-set pages may be counted twice). The renderer component accounts for roughly 2.17GB working set / 2.19GB private bytes.
- Read-only diagnosis: `captureExactWysiwygPosition` still calls `docPosToMarkdownOffset` → `serializeDocRangeToMarkdown` twice. Reset's `setContent` can move selection to the end, making this optional position capture serialize the whole 50k prefix. This is the next suspected production hotspot; no optimization was implemented after the stop request. The existing `historySourceBookmark` block-local mapper is a possible replacement, but unmapped/empty-paragraph selection behavior needs an explicit design and regression coverage. Snapshot publication must not silently guess positions or lose input.

The Source multi-range proposal **was applied after UI validation released its freeze**. Production files: `src/editor/sourceOutlineChanges.ts`, the Source outline StateField integration, and QA actual `outlineLineReads`/`outlineChangedRanges` reporting. Official test `scripts/check-source-outline-multi-range.mjs` passed (current aggregate scanner 50,002 reads versus 338/595 localized reads, 150 mixed-state random updates); the prior 300 deterministic Source outline tests and TypeScript passed. Counts are associated with the actual published CodeMirror Text root. This Source optimization has **not been measured in a rebuilt native candidate**; `U7xI4W` predates it.

Remaining acceptance includes the after-reset position/snapshot hotspot, WYS 50k input/view/listener timing (latest QA owned `applyTransaction`/`view.updateState`/key-handler probes require rebuilding), undo/reset cost, rebuilt Source multi-range sampling, ten startup samples and 3×100 interactions, retained native memory cycles, and a final fixed-source release build/complete matrix. No stable release performance verdict or final acceptance is claimed. Full native release sampling must be coordinated with normal/export/manual tests and source hashes frozen for the run.



## Resumed bookmark hotspot fix — 2026-10-26

Production snapshot position capture now maps the canonical selection through `historySourceBookmark` and reuses the already captured exact source baseline. It no longer creates a DOM/Turndown serialization of the entire prefix for either endpoint. The block-local mapper parses only the selected top-level blocks. Unsupported source/model alignment keeps the last proven source offsets while updating the live PM bookmark; optional position persistence cannot reject an otherwise valid snapshot. Async capture checks the original view state/destroyed state, and snapshot publication rechecks session/revision after awaiting mapping.

`node scripts/check-wys-exact-position.mjs` first failed on the former prefix serialization call, then passed against a real 50,000-paragraph PM document. It covers EOF and backwards range coordinates, observes actual Markdown parser inputs bounded to the selected 15-character blocks (no whole-document reparse), an empty paragraph, unproven alignment, and a newer selection arriving during async mapping. TypeScript and the related rich/complex/code-span position maps, mode bookmark, immutable history, source preservation, first-dirty snapshot, recovery footnotes and static performance architecture checks passed. These tests prove mapping behavior and bounded parser work; native latency/memory acceptance remains separate.

A private production frontend `.cache/performance-20261026/normal-dist` built in 44.69s and passed the three JS closure budgets. Diagnostic smoke candidate `qj25bo` is being rebuilt behind a native launch gate while ordinary-document and large-source native acceptance use the desktop. A subsequent Rust-only profile argument fix may require a final-source rebuild before full performance acceptance.
