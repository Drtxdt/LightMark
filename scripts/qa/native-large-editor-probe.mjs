import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Return a fixture description for the isolated-native launcher.  The caller
 * owns the directory and writes fixtureContent there; this module never
 * chooses or touches a user document.
 */
export function createNativeLargeEditorFixture(runToken = "run") {
  const safeToken = String(runToken).replace(/[^a-z0-9_-]/gi, "-");
  const mixedPrefix = [
    "alpha😀beta\r\n",
    "second line\r",
    "third line\n",
    "fourth line\r\n",
    "\r\n",
  ].join("");
  const chunks = [mixedPrefix, "# Later heading\n", "\n"];
  let index = 0;
  let byteLength = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, "utf8"), 0);
  while (byteLength < LARGE_FILE_THRESHOLD_BYTES + 256 * 1024) {
    const eol = index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n";
    const body = `body ${index} ${"x".repeat(180)}${eol}`;
    chunks.push(body);
    byteLength += Buffer.byteLength(body, "utf8");
    if (index % 6 === 5) {
      chunks.push(eol);
      byteLength += Buffer.byteLength(eol, "utf8");
    }
    index += 1;
  }
  const fixtureContent = chunks.join("");
  return {
    fileName: `native-large-editor-${safeToken}.md`,
    fixtureContent,
    evidence: {
      name: "large-editor",
      mixedPrefix,
      mixedPrefixAfterEmoji: mixedPrefix.replace("😀", "😁"),
      firstAckMarker: "[large-ack-v1]",
      secondAckMarker: "[large-ack-v2]",
      scrollMarker: "[large-scroll-pending]",
      expectedMinimumBytes: LARGE_FILE_THRESHOLD_BYTES + 256 * 1024,
      notes: "The runner uses the production LargeMarkdownEditor and appStore against an owned >5 MiB fixture. It never opens or writes a user note.",
    },
  };
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizedOffsetToRawOffset(value, offset) {
  const bounded = Math.max(0, Math.min(offset, normalizeLineEndings(value).length));
  let raw = 0;
  let normalized = 0;
  while (raw < value.length && normalized < bounded) {
    raw += value[raw] === "\r" && value[raw + 1] === "\n" ? 2 : 1;
    normalized += 1;
  }
  return raw;
}

/** Independently rebase one textarea block change onto the full raw fixture. */
function replaceNormalizedBlock(rawDocument, previousText, nextText) {
  const normalizedDocument = normalizeLineEndings(rawDocument);
  const previousComparable = normalizeLineEndings(previousText);
  const nextComparable = normalizeLineEndings(nextText);
  const blockStart = normalizedDocument.indexOf(previousComparable);
  assert.ok(blockStart >= 0, "the native probe oracle could not locate the captured block in the expected document");
  const blockEnd = blockStart + previousComparable.length;
  const rawBlockStart = normalizedOffsetToRawOffset(rawDocument, blockStart);
  const rawBlockEnd = normalizedOffsetToRawOffset(rawDocument, blockEnd);
  let prefix = 0;
  while (prefix < previousComparable.length
    && prefix < nextComparable.length
    && previousComparable[prefix] === nextComparable[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousComparable.length - prefix
    && suffix < nextComparable.length - prefix
    && previousComparable[previousComparable.length - suffix - 1]
      === nextComparable[nextComparable.length - suffix - 1]) suffix += 1;
  const rawBlock = rawDocument.slice(rawBlockStart, rawBlockEnd);
  const rawStart = rawBlockStart + normalizedOffsetToRawOffset(rawBlock, prefix);
  const rawEnd = rawBlockStart + normalizedOffsetToRawOffset(rawBlock, previousComparable.length - suffix);
  const replacement = nextComparable.slice(prefix, nextComparable.length - suffix);
  return `${rawDocument.slice(0, rawStart)}${replacement}${rawDocument.slice(rawEnd)}`;
}

function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Exercise the real LargeMarkdownEditor DOM/session path.  The caller must
 * provide the already verified owned CDP client and isolated launcher
 * context; this runner deliberately does not create a fake adapter or launch
 * a process of its own.
 */
export async function runNativeLargeEditorProbe(client, context) {
  assert.ok(client && typeof client.evaluate === "function", "an owned CDP client is required");
  assert.ok(context?.fixturePath, "the isolated large-editor fixture path is required");
  const expectedFixtureContent = context.fixtureContent ?? context.fixture?.fixtureContent;
  assert.equal(typeof expectedFixtureContent, "string", "the launcher must pass the owned fixtureContent for the full-file oracle");
  const fixturePath = JSON.stringify(context.fixturePath);
  const scenarioEvidence = context.scenarioEvidence ?? {};
  const mixedPrefix = JSON.stringify(scenarioEvidence.mixedPrefix ?? "");
  const mixedPrefixAfterEmoji = JSON.stringify(scenarioEvidence.mixedPrefixAfterEmoji ?? "");
  const firstAckMarker = JSON.stringify(scenarioEvidence.firstAckMarker ?? "[large-ack-v1]");
  const secondAckMarker = JSON.stringify(scenarioEvidence.secondAckMarker ?? "[large-ack-v2]");
  const scrollMarker = JSON.stringify(scenarioEvidence.scrollMarker ?? "[large-scroll-pending]");
  return await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const mixedPrefix = ${mixedPrefix};
    const mixedPrefixAfterEmoji = ${mixedPrefixAfterEmoji};
    const firstAckMarker = ${firstAckMarker};
    const secondAckMarker = ${secondAckMarker};
    const scrollMarker = ${scrollMarker};
    const expect = (condition, message, details) => {
      if (!condition) throw new Error(message + (details === undefined ? '' : ': ' + JSON.stringify(details)));
    };
    const internals = globalThis.__TAURI_INTERNALS__;
    expect(internals && typeof internals.invoke === 'function', 'Tauri internal invoke bridge is unavailable');
    const nativeInvoke = internals.invoke.bind(internals);
    const callNative = (command, args = {}) => nativeInvoke(command, args);
    const sha256Text = async (value) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const diskEvidence = async (label) => {
      const content = await callNative('read_text_file', { path: fixturePath });
      return {
        label,
        sha256: await sha256Text(content),
        codeUnits: content.length,
        byteLength: new TextEncoder().encode(content).byteLength,
      };
    };
    const waitFor = async (label, predicate, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const value = predicate();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('timed out waiting for ' + label + (lastError ? ': ' + String(lastError) : ''));
    };
    const progress = (stage, extra = {}) => {
      globalThis.__LIGHTMARK_QA_PROGRESS = {
        stage,
        at: new Date().toISOString(),
        ...extra,
      };
    };
    const activeLargeScroll = () => {
      const all = [...document.querySelectorAll('.large-doc-scroll')];
      return all.find((candidate) => candidate.closest('.lm-editor-pane')?.classList.contains('active')) || all[0] || null;
    };
    const firstArticle = () => activeLargeScroll()?.querySelector('article[data-line-start="0"]') || null;
    const textarea = () => activeLargeScroll()?.querySelector('textarea[data-large-editor-input]') || null;
    const state = () => {
      const tab = store.getPaneTab('main');
      const large = tab?.largeFile || null;
      return {
        tab,
        large,
        tabId: tab?.id || null,
        path: tab?.path || null,
        documentMode: tab?.documentMode || null,
        dirty: tab?.isDirty === true,
        revision: large?.revision ?? null,
        savedRevision: large?.savedRevision ?? null,
        pendingEditCount: large?.pendingEditCount ?? null,
        targetPath: large?.targetPath,
        originPath: large?.originPath,
      };
    };
    const setTextareaValue = async (value, data = null) => {
      const input = textarea();
      expect(input, 'large editor textarea is not mounted');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      expect(setter, 'textarea value setter is unavailable');
      setter.call(input, value);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return input;
    };
    const editFirstBlock = async () => {
      const article = await waitFor('first large block', firstArticle);
      article.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 4, clientY: 4 }));
      return await waitFor('large editor textarea', textarea);
    };
    const cleanState = (label) => {
      const current = state();
      expect(!current.dirty, label + ' left the large tab dirty', current);
      expect(current.pendingEditCount === 0, label + ' left remote pending edits', current);
      expect(current.revision === current.savedRevision, label + ' did not align saved revision', current);
      return current;
    };

    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
    progress('large-editor:before-open');
    const opened = await store.openFile(fixturePath, { recordNavigation: false, paneId: 'main' });
    expect(opened !== false, 'large fixture did not open');
    const tab = await waitFor('large tab projection', () => {
      const current = state();
      return current.documentMode === 'large' && current.path === fixturePath ? current.tab : null;
    });
    const session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', 30000);
    await waitFor('initial large block', firstArticle);
    const diskBefore = await callNative('read_text_file', { path: fixturePath });
    expect(typeof diskBefore === 'string' && diskBefore.startsWith(mixedPrefix), 'fixture did not preserve the mixed-EOL/emoji prefix');
    const diskBeforeEvidence = {
      label: 'before-edits',
      sha256: await sha256Text(diskBefore),
      codeUnits: diskBefore.length,
      byteLength: new TextEncoder().encode(diskBefore).byteLength,
    };
    progress('large-editor:opened', {
      tabId: tab.id,
      sessionId: tab.largeFile?.sessionId || null,
      revision: tab.largeFile?.revision ?? null,
      totalLines: tab.largeFile?.totalLines ?? null,
      sizeBytes: tab.largeFile?.sizeBytes ?? null,
    });

    let input = await editFirstBlock();
    const initialValue = input.value;
    expect(initialValue.includes('😀'), 'the first large block did not expose the emoji fixture');
    const emojiValue = initialValue.replace('😀', '😁');
    await setTextareaValue(emojiValue, '😁');
    expect(session.hasPendingEdits?.() === true, 'unblurred emoji input was not pending before save');
    expect(document.activeElement === textarea(), 'large textarea lost focus before ordinary save');
    progress('large-editor:before-first-save', { value: emojiValue.slice(0, 240), token: session.mutationToken?.() || null });
    expect(await store.saveCurrentFile(), 'ordinary save did not commit the unblurred large textarea');
    const diskAfterEmoji = await callNative('read_text_file', { path: fixturePath });
    const diskAfterEmojiEvidence = {
      label: 'after-emoji-save',
      sha256: await sha256Text(diskAfterEmoji),
      codeUnits: diskAfterEmoji.length,
      byteLength: new TextEncoder().encode(diskAfterEmoji).byteLength,
    };
    expect(diskAfterEmoji.startsWith(mixedPrefixAfterEmoji), 'ordinary large save changed untouched mixed-EOL bytes', {
      expected: mixedPrefixAfterEmoji,
      actual: diskAfterEmoji.slice(0, mixedPrefixAfterEmoji.length),
    });
    cleanState('ordinary unblurred save');

    // Hold the first real apply_file_edits IPC call, type again while its ACK
    // is in flight, then release it.  The production flush must reject that
    // stale prompt version while retaining the newer textarea value; the next
    // save constructs a fresh diff from the acknowledged base.
    let applyStartedResolve;
    let releaseApply = () => {};
    let applyHeld = false;
    const applyStarted = new Promise((resolve) => { applyStartedResolve = resolve; });
    const applyReleased = new Promise((resolve) => { releaseApply = resolve; });
    const originalInternalsInvoke = internals.invoke;
    internals.invoke = async (command, args = {}) => {
      if (applyHeld && command === 'apply_file_edits') {
        applyHeld = false;
        applyStartedResolve();
        await applyReleased;
      }
      return await originalInternalsInvoke.call(internals, command, args);
    };
    let raceEvidence = null;
    try {
      input = await editFirstBlock();
      const firstRaceBaseValue = input.value;
      const firstRaceValue = firstRaceBaseValue + ' ' + firstAckMarker;
      const secondRaceValue = firstRaceValue + '\n' + secondAckMarker;
      applyHeld = true;
      await setTextareaValue(firstRaceValue, firstAckMarker);
      // Attach the rejection handler at promise creation.  If a timeout or
      // DOM failure occurs before the IPC gate is released, the expected
      // stale-save rejection must still be observed by this runner.
      const firstSave = store.saveCurrentFile().then(
        (value) => ({ ok: true, value, error: null }),
        (error) => ({ ok: false, value: null, error: String(error) }),
      );
      await waitFor('first apply ACK gate', () => applyHeld === false);
      await setTextareaValue(secondRaceValue, secondAckMarker);
      releaseApply();
      const firstResult = await firstSave;
      expect(firstResult.ok === false, 'save unexpectedly accepted input typed during its apply ACK', firstResult);
      expect(textarea()?.value === secondRaceValue, 'new textarea input was lost after the first apply ACK', {
        expected: secondRaceValue,
        actual: textarea()?.value,
      });
      expect(session.hasPendingEdits?.() === true, 'new input was not pending after the stale save rejection');
      const diskAfterFirstRace = await callNative('read_text_file', { path: fixturePath });
      const diskAfterFirstRaceEvidence = {
        label: 'after-first-ack-save',
        sha256: await sha256Text(diskAfterFirstRace),
        codeUnits: diskAfterFirstRace.length,
        byteLength: new TextEncoder().encode(diskAfterFirstRace).byteLength,
      };
      progress('large-editor:after-ack-with-new-input', {
        firstResult,
        value: textarea()?.value?.slice(0, 260) || null,
        token: session.mutationToken?.() || null,
      });
      expect(await store.saveCurrentFile(), 'second save did not commit the retained newer input');
      const diskAfterSecond = await callNative('read_text_file', { path: fixturePath });
      const diskAfterSecondEvidence = {
        label: 'after-second-save',
        sha256: await sha256Text(diskAfterSecond),
        codeUnits: diskAfterSecond.length,
        byteLength: new TextEncoder().encode(diskAfterSecond).byteLength,
      };
      expect(diskAfterSecond.includes(firstAckMarker) && diskAfterSecond.includes(secondAckMarker), 'second save lost one of the consecutive edit markers');
      cleanState('second consecutive save');
      raceEvidence = {
        firstRaceBaseValue,
        firstRaceValue,
        secondRaceValue,
        diskAfterFirstRaceEvidence,
        diskAfterSecondEvidence,
      };
    } finally {
      releaseApply();
      internals.invoke = originalInternalsInvoke;
    }

    // Keep a pending buffer while its block leaves the virtualized window.
    // Returning to the first window must remount the textarea with the exact
    // input buffer rather than silently dropping it with the unloaded block.
    input = await editFirstBlock();
    const scrollBaseValue = input.value;
    const scrollValue = scrollBaseValue + ' ' + scrollMarker;
    await setTextareaValue(scrollValue, scrollMarker);
    const scroll = activeLargeScroll();
    expect(scroll, 'large editor scroll container is unavailable');
    scroll.scrollTop = Math.max(1, scroll.scrollHeight - scroll.clientHeight, 99999999);
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    await waitFor('a distant virtualized large block', () => {
      const lines = [...(activeLargeScroll()?.querySelectorAll('article[data-line-start]') || [])]
        .map((item) => Number(item.getAttribute('data-line-start')))
        .filter(Number.isFinite);
      return lines.some((line) => line > 500);
    });
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    const restoredInput = await waitFor('the buffered first block after virtualized scroll', textarea);
    expect(restoredInput.value === scrollValue, 'scrolling the block out of view lost the pending textarea buffer', {
      expected: scrollValue,
      actual: restoredInput.value,
    });
    progress('large-editor:buffer-restored-after-scroll', { value: restoredInput.value.slice(0, 260) });
    expect(await store.saveCurrentFile(), 'save after virtualized buffer restoration failed');
    cleanState('virtualized buffer restoration save');
    const finalDisk = await callNative('read_text_file', { path: fixturePath });
    const finalDiskEvidence = {
      label: 'after-scroll-save',
      sha256: await sha256Text(finalDisk),
      codeUnits: finalDisk.length,
      byteLength: new TextEncoder().encode(finalDisk).byteLength,
    };
    expect(finalDisk.includes(scrollMarker), 'the restored virtualized buffer was not persisted');
    progress('large-editor:passed', {
      tabId: state().tabId,
      revision: state().revision,
      savedRevision: state().savedRevision,
      diskPrefix: finalDisk.slice(0, mixedPrefixAfterEmoji.length),
      sessionToken: session.mutationToken?.() || null,
    });
    return {
      path: fixturePath,
      tabId: state().tabId,
      sessionId: tab.largeFile?.sessionId || null,
      mixedEolPrefixPreserved: finalDisk.startsWith(mixedPrefixAfterEmoji),
      consecutiveAckMarkers: {
        first: finalDisk.includes(firstAckMarker),
        second: finalDisk.includes(secondAckMarker),
      },
      scrollBufferPreserved: finalDisk.includes(scrollMarker),
      dirty: state().dirty,
      revision: state().revision,
      savedRevision: state().savedRevision,
      pendingEditCount: state().pendingEditCount,
      token: session.mutationToken?.() || null,
      oracleInputs: {
        initialValue,
        firstRaceBaseValue: raceEvidence?.firstRaceBaseValue || null,
        firstRaceValue: raceEvidence?.firstRaceValue || null,
        secondRaceValue: raceEvidence?.secondRaceValue || null,
        scrollBaseValue,
        scrollValue,
      },
      diskEvidence: {
        before: diskBeforeEvidence,
        afterEmoji: diskAfterEmojiEvidence,
        afterFirstRace: raceEvidence?.diskAfterFirstRaceEvidence || null,
        afterSecond: raceEvidence?.diskAfterSecondEvidence || null,
        afterScroll: finalDiskEvidence,
      },
      note: 'This result covers the real LargeMarkdownEditor/appStore path against an owned large fixture. Window-close draft recovery is exposed by the separate draft/recovery runners below.',
    };
  })()`, 180000);

  const inputs = result.oracleInputs;
  const evidence = result.diskEvidence;
  assert.ok(inputs && evidence, "the native large probe did not return full-file oracle evidence");
  let expected = expectedFixtureContent;
  assert.equal(evidence.before?.sha256, sha256Utf8(expected), "the native large fixture changed before the first edit");
  assert.equal(evidence.before?.byteLength, Buffer.byteLength(expected, "utf8"), "the native large fixture byte length changed before the first edit");
  const verifyStage = (stage, expectedText) => {
    const actual = evidence[stage];
    assert.ok(actual, `the native large probe did not return ${stage} evidence`);
    assert.equal(actual.sha256, sha256Utf8(expectedText), `${stage} full-file SHA-256 differs from the independent expected document`);
    assert.equal(actual.byteLength, Buffer.byteLength(expectedText, "utf8"), `${stage} full-file byte length differs from the independent expected document`);
  };
  expected = expected.replace("😀", "😁");
  verifyStage("afterEmoji", expected);
  expected = replaceNormalizedBlock(expected, inputs.firstRaceBaseValue, inputs.firstRaceValue);
  verifyStage("afterFirstRace", expected);
  expected = replaceNormalizedBlock(expected, inputs.firstRaceValue, inputs.secondRaceValue);
  verifyStage("afterSecond", expected);
  expected = replaceNormalizedBlock(expected, inputs.secondRaceValue, inputs.scrollValue);
  verifyStage("afterScroll", expected);
  return {
    ...result,
    oracle: {
      verified: true,
      expectedByteLength: Buffer.byteLength(expected, "utf8"),
      expectedSha256: sha256Utf8(expected),
    },
  };
}

/**
 * Run the close-request half of the owned large-draft scenario.  It leaves
 * the isolated app after selecting “不保存退出”; the next launcher phase can
 * call runNativeLargeEditorRecoveryProbe against the same profile.
 */
export async function runNativeLargeEditorDraftCloseProbe(client, context) {
  assert.ok(client && typeof client.evaluate === "function", "an owned CDP client is required");
  assert.ok(context?.fixturePath, "the isolated large-editor fixture path is required");
  const expectedFixtureContent = context.fixtureContent ?? context.fixture?.fixtureContent;
  assert.equal(typeof expectedFixtureContent, "string", "the launcher must pass the owned fixtureContent for draft full-file verification");
  const fixturePath = JSON.stringify(context.fixturePath);
  const marker = JSON.stringify(context.scenarioEvidence?.scrollMarker ?? "[large-draft-pending]");
  const result = await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const marker = ${marker};
    const expect = (condition, message, details) => {
      if (!condition) throw new Error(message + (details === undefined ? '' : ': ' + JSON.stringify(details)));
    };
    const internals = globalThis.__TAURI_INTERNALS__;
    expect(internals && typeof internals.invoke === 'function', 'Tauri internal invoke bridge is unavailable');
    const callNative = internals.invoke.bind(internals);
    const sha256Text = async (value) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const evidenceFor = async (label, content) => ({
      label,
      sha256: await sha256Text(content),
      codeUnits: content.length,
      byteLength: new TextEncoder().encode(content).byteLength,
    });
    const readDiskEvidence = async (label) => evidenceFor(label, await callNative('read_text_file', { path: fixturePath }));
    const waitFor = async (label, predicate, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('timed out waiting for ' + label);
    };
    const store = await import('/src/stores/appStore.ts');
    const runtime = await import('/src/editor/documentRuntime.ts');
    const tab = await waitFor('large tab before draft close', () => {
      const value = store.getPaneTab('main');
      return value?.documentMode === 'large' && value.path === fixturePath ? value : null;
    });
    const session = await runtime.waitForDocumentSession(tab.id, 'wysiwyg', 30000);
    const sourceDiskBefore = await readDiskEvidence('before-window-discard');
    const scroll = await waitFor('large editor scroll before draft close', () => document.querySelector('.large-doc-scroll'));
    const article = await waitFor('large editor first block before draft close', () => scroll.querySelector('article[data-line-start="0"]'));
    article.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 4, clientY: 4 }));
    const input = await waitFor('large editor textarea before draft close', () => scroll.querySelector('textarea[data-large-editor-input]'));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    expect(setter, 'textarea value setter is unavailable');
    const draftBaseValue = input.value;
    const draftEditedValue = draftBaseValue + ' ' + marker;
    setter.call(input, draftEditedValue);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: marker }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.hasPendingEdits?.() === true, 'large draft close fixture input was not pending');

    // The window close flow destroys the page after the draft write. Observe
    // the native receipts while the page is still alive so this probe never
    // races a post-close list_drafts call. Re-open the owned immutable
    // snapshot through the production command and hash every returned line.
    const originalInternalsInvoke = internals.invoke;
    let draftWriteEvidence = null;
    let recoveryEvidence = null;
    let sourceDiskAfterDraft = null;
    internals.invoke = async (command, args = {}) => {
      if (command === 'write_draft') {
        const writeResult = await originalInternalsInvoke.call(internals, command, args);
        const record = args?.record;
        const snapshot = record?.largeSnapshot;
        expect(snapshot?.snapshotId, 'large draft write did not carry an owned snapshot reference', { record, writeResult });
        draftWriteEvidence = {
          id: record.id,
          snapshotId: snapshot.snapshotId,
          outcome: writeResult?.outcome ?? null,
          diskWritten: writeResult?.diskWritten ?? null,
        };
        const opened = await originalInternalsInvoke.call(internals, 'open_large_file_draft', {
          snapshotId: snapshot.snapshotId,
        });
        const recovered = await originalInternalsInvoke.call(internals, 'read_file_chunk', {
          sessionId: opened.session.sessionId,
          startLine: 0,
          lineCount: opened.session.totalLines,
          expectedRevision: opened.session.revision,
          coordinateSpace: opened.session.coordinateSpace,
        });
        recoveryEvidence = await evidenceFor('draft-snapshot-full-payload', recovered.text);
        expect(recovered.startLine === 0 && recovered.endLine === recovered.totalLines,
          'draft snapshot verification did not read the complete owned payload', recovered);
        await originalInternalsInvoke.call(internals, 'close_large_file', {
          sessionId: opened.session.sessionId,
          expectedRevision: opened.session.revision,
          coordinateSpace: opened.session.coordinateSpace,
          disposition: 'discard',
        });
        sourceDiskAfterDraft = await readDiskEvidence('after-window-discard-draft-write');
        return writeResult;
      }
      return await originalInternalsInvoke.call(internals, command, args);
    };
    const closePromise = callNative('plugin:window|close', { label: 'main' });
    const dialog = await waitFor('window close dialog for large draft', () => [...document.querySelectorAll('section[role="dialog"]')]
      .find((candidate) => [...candidate.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('不保存退出'))));
    const buttons = [...dialog.querySelectorAll('button')].map((button) => ({ button, label: button.textContent?.trim() || '' }));
    const discard = buttons.find(({ label }) => label.includes('不保存退出'))?.button;
    expect(discard, 'window close dialog did not expose 不保存退出', buttons.map(({ label }) => label));
    discard.click();
    await closePromise;
    return {
      sourceDiskBefore,
      sourceDiskAfterDraft,
      draftBaseValue,
      draftEditedValue,
      draftWriteEvidence,
      recoveryEvidence,
      marker,
      note: 'The app selected window discard; the probe observed the write receipt and verified the complete owned snapshot before the page closed, avoiding a post-close list_drafts race.',
    };
  })()`, 180000);
  const expectedDraft = replaceNormalizedBlock(expectedFixtureContent, result.draftBaseValue, result.draftEditedValue);
  assert.ok(result.draftWriteEvidence?.snapshotId, "window discard did not expose the committed large snapshot write");
  assert.equal(result.draftWriteEvidence.outcome, "committed", "large draft write did not commit");
  assert.equal(result.draftWriteEvidence.diskWritten, "yes", "large draft write did not confirm disk persistence");
  assert.equal(result.sourceDiskBefore?.sha256, sha256Utf8(expectedFixtureContent), "source file changed before the window discard");
  assert.equal(result.sourceDiskAfterDraft?.sha256, sha256Utf8(expectedFixtureContent), "source file changed during the no-save window discard");
  assert.equal(result.sourceDiskAfterDraft?.byteLength, Buffer.byteLength(expectedFixtureContent, "utf8"), "source file byte length changed during the no-save window discard");
  assert.equal(result.recoveryEvidence?.sha256, sha256Utf8(expectedDraft), "large draft snapshot content differs from the independently expected edited document");
  assert.equal(result.recoveryEvidence?.byteLength, Buffer.byteLength(expectedDraft, "utf8"), "large draft snapshot byte length differs from the independently expected edited document");
  return {
    ...result,
    draftOracle: {
      sha256: sha256Utf8(expectedDraft),
      codeUnits: expectedDraft.length,
      byteLength: Buffer.byteLength(expectedDraft, "utf8"),
    },
  };
}

/**
 * Run after the close phase against the same isolated profile.  Recovery must
 * open a new untitled large session with targetPath null and retain the source
 * path only as provenance.
 */
export async function runNativeLargeEditorRecoveryProbe(client, context) {
  assert.ok(client && typeof client.evaluate === "function", "an owned CDP client is required");
  assert.ok(context?.fixturePath, "the isolated large-editor fixture path is required");
  const expectedDraftOracle = context.expectedDraftOracle ?? context.draftOracle;
  assert.ok(expectedDraftOracle?.sha256 && Number.isInteger(expectedDraftOracle?.byteLength),
    "the launcher must pass the close-phase draftOracle for full recovery verification");
  const fixturePath = JSON.stringify(context.fixturePath);
  const expectedSha256 = JSON.stringify(expectedDraftOracle.sha256);
  const expectedByteLength = JSON.stringify(expectedDraftOracle.byteLength);
  const result = await client.evaluate(`(async () => {
    const fixturePath = ${fixturePath};
    const expect = (condition, message, details) => {
      if (!condition) throw new Error(message + (details === undefined ? '' : ': ' + JSON.stringify(details)));
    };
    const internals = globalThis.__TAURI_INTERNALS__;
    expect(internals && typeof internals.invoke === 'function', 'Tauri internal invoke bridge is unavailable');
    const callNative = internals.invoke.bind(internals);
    const sha256Text = async (value) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const waitFor = async (label, predicate, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('timed out waiting for ' + label);
    };
    const store = await import('/src/stores/appStore.ts');
    const draft = await import('/src/stores/draftStore.ts');
    const dialog = await waitFor('large draft recovery dialog', () => [...document.querySelectorAll('section[role="dialog"]')]
      .find((candidate) => [...candidate.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('恢复草稿'))));
    const buttons = [...dialog.querySelectorAll('button')].map((button) => ({ button, label: button.textContent?.trim() || '' }));
    const restore = buttons.find(({ label }) => label.includes('恢复草稿'))?.button;
    expect(restore, 'startup recovery dialog did not expose 恢复草稿', buttons.map(({ label }) => label));
    // Observe the recoverable record before the window is touched. The close
    // phase already verifies the write receipt; this read is deliberately
    // before restore/close so it cannot race page destruction.
    const listingBeforeRestore = await callNative('list_drafts');
    const visibleRecord = listingBeforeRestore?.records?.find((record) => record.kind === 'large' && record.largeSnapshot);
    expect(visibleRecord, 'startup recovery listing did not expose the owned large draft record', listingBeforeRestore);
    restore.click();
    const tab = await waitFor('recovered large untitled tab', () => {
      const value = store.getPaneTab('main');
      return value?.documentMode === 'large' && value.largeFile?.recoveryDraftId ? value : null;
    });
    expect(tab.path === '', 'recovered large tab unexpectedly retained a writable source path', tab.path);
    expect(tab.largeFile?.targetPath === null, 'recovered large session targetPath must be null', tab.largeFile?.targetPath);
    expect(tab.largeFile?.originPath === fixturePath, 'recovered large session lost source provenance', tab.largeFile?.originPath);
    expect(store.appStore.isDirty === true && tab.isDirty === true, 'recovered large tab was not marked dirty until SaveAs');
    await waitFor('recovered large editor DOM', () => document.querySelector('.large-doc-scroll'));
    const recoveredChunk = await callNative('read_file_chunk', {
      sessionId: tab.largeFile.sessionId,
      startLine: 0,
      lineCount: tab.largeFile.totalLines,
      expectedRevision: tab.largeFile.revision,
      coordinateSpace: tab.largeFile.coordinateSpace,
    });
    expect(recoveredChunk.startLine === 0 && recoveredChunk.endLine === recoveredChunk.totalLines,
      'recovery verification did not read the complete recovered view', recoveredChunk);
    const recoveryEvidence = {
      sha256: await sha256Text(recoveredChunk.text),
      codeUnits: recoveredChunk.text.length,
      byteLength: new TextEncoder().encode(recoveredChunk.text).byteLength,
      totalLines: recoveredChunk.totalLines,
    };
    expect(recoveryEvidence.sha256 === ${expectedSha256}, 'recovered large view content differs from the close-phase owned snapshot', recoveryEvidence);
    expect(recoveryEvidence.byteLength === ${expectedByteLength}, 'recovered large view byte length differs from the close-phase owned snapshot', recoveryEvidence);
    const result = {
      status: draft.draftStore.status,
      tabId: tab.id,
      path: tab.path,
      targetPath: tab.largeFile?.targetPath,
      originPath: tab.largeFile?.originPath,
      recoveryDraftId: tab.largeFile?.recoveryDraftId,
      dirty: tab.isDirty,
      draftVisible: true,
      draftRecordId: visibleRecord.id,
      recoveryEvidence,
      note: 'The restored view is a new untitled target; the original path is provenance only and requires SaveAs.',
    };
    // End the owned phase while preserving the recovery record for review.
    const closePromise = callNative('plugin:window|close', { label: 'main' });
    const closeDialog = await waitFor('recovery close dialog', () => [...document.querySelectorAll('section[role="dialog"]')]
      .find((candidate) => [...candidate.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('不保存退出'))));
    const discard = [...closeDialog.querySelectorAll('button')]
      .find((button) => (button.textContent || '').includes('不保存退出'));
    expect(discard, 'recovery close dialog did not expose 不保存退出');
    discard.click();
    await closePromise;
    return result;
  })()`, 180000);
  return {
    ...result,
    oracle: {
      verified: true,
      expectedSha256: expectedDraftOracle.sha256,
      expectedByteLength: expectedDraftOracle.byteLength,
    },
  };
}
