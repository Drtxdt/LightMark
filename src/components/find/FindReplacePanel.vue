<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  closeFindPanel,
  findReplaceStore,
  refreshFind,
  runFindCommand,
} from "../../stores/findReplaceStore";

const queryInput = ref<HTMLInputElement | null>(null);
let refreshTimer = 0;

watch(
  () => [
    findReplaceStore.query,
    findReplaceStore.caseSensitive,
    findReplaceStore.wholeWord,
    findReplaceStore.regex,
  ],
  () => {
    findReplaceStore.currentIndex = -1;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshFind, 120);
  },
);

onMounted(() => {
  window.addEventListener("lightmark:find-focus", focusQuery);
  void nextTick(focusQuery);
});

onBeforeUnmount(() => {
  window.clearTimeout(refreshTimer);
  window.removeEventListener("lightmark:find-focus", focusQuery);
});

function focusQuery() {
  queryInput.value?.focus();
  queryInput.value?.select();
}

function onQueryKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    runFindCommand(event.shiftKey ? "previous" : "next");
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeFindPanel();
  }
}

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeFindPanel();
  }
}
</script>

<template>
  <section class="find-panel" aria-label="查找与替换" @keydown="onPanelKeydown">
    <div class="find-fields">
      <label class="find-input-wrap">
        <span class="find-label">查找</span>
        <input
          ref="queryInput"
          v-model="findReplaceStore.query"
          class="find-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="查找内容"
          @keydown="onQueryKeydown"
        />
      </label>
      <label class="find-input-wrap replace">
        <span class="find-label">替换</span>
        <input
          v-model="findReplaceStore.replaceText"
          class="find-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="替换为"
        />
      </label>
    </div>

    <div class="find-actions">
      <span class="find-count" :class="{ error: Boolean(findReplaceStore.error) }">
        {{ findReplaceStore.error || (findReplaceStore.total > 0 ? `${findReplaceStore.currentIndex + 1}/${findReplaceStore.total}` : "0/0") }}
      </span>
      <button class="find-button" type="button" title="上一个 Shift+Enter" @click="runFindCommand('previous')">上一个</button>
      <button class="find-button" type="button" title="下一个 Enter" @click="runFindCommand('next')">下一个</button>
      <button class="find-button" type="button" @click="runFindCommand('replaceCurrent')">替换</button>
      <button class="find-button" type="button" @click="runFindCommand('replaceAll')">全部替换</button>
      <span class="find-split"></span>
      <button class="find-toggle" type="button" :class="{ active: findReplaceStore.caseSensitive }" @click="findReplaceStore.caseSensitive = !findReplaceStore.caseSensitive">
        Aa
      </button>
      <button class="find-toggle" type="button" :class="{ active: findReplaceStore.wholeWord }" @click="findReplaceStore.wholeWord = !findReplaceStore.wholeWord">
        W
      </button>
      <button class="find-toggle mono" type="button" :class="{ active: findReplaceStore.regex }" @click="findReplaceStore.regex = !findReplaceStore.regex">
        .*
      </button>
      <button class="find-close" type="button" title="关闭 Esc" aria-label="关闭查找替换" @click="closeFindPanel"></button>
    </div>
  </section>
</template>

<style scoped>
.find-panel {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid rgb(231 225 215 / 86%);
  background: rgb(250 248 243 / 94%);
  padding: 6px 12px;
}

.find-fields {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  gap: 8px;
}

.find-input-wrap {
  display: flex;
  min-width: 180px;
  flex: 0 1 280px;
  align-items: center;
  gap: 7px;
  border: 1px solid rgb(219 213 202 / 82%);
  border-radius: 8px;
  background: rgb(255 255 255 / 70%);
  padding: 4px 8px;
}

.find-input-wrap.replace {
  flex-basis: 240px;
}

.find-label {
  flex: 0 0 auto;
  color: #8b8377;
  font-size: 12px;
}

.find-input {
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  background: transparent;
  color: #332f29;
  font: 13px/1.4 var(--lm-editor-font-family);
  outline: none;
}

.find-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.find-count {
  min-width: 52px;
  color: #756f66;
  font: 12px/1 "JetBrains Mono", ui-monospace, monospace;
  text-align: right;
}

.find-count.error {
  min-width: 140px;
  color: #b42318;
}

.find-button,
.find-toggle,
.find-close {
  height: 26px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #625b51;
  cursor: pointer;
  font-size: 12px;
}

.find-button {
  padding: 0 9px;
}

.find-toggle {
  min-width: 28px;
  padding: 0 6px;
  font-weight: 600;
}

.find-toggle.mono {
  font-family: "JetBrains Mono", ui-monospace, monospace;
}

.find-button:hover,
.find-toggle:hover,
.find-close:hover,
.find-toggle.active {
  border-color: rgb(211 204 192 / 72%);
  background: rgb(120 113 108 / 12%);
  color: #2f2b25;
}

.find-split {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: rgb(213 207 196 / 82%);
}

.find-close {
  position: relative;
  width: 26px;
}

.find-close::before,
.find-close::after {
  position: absolute;
  left: 12px;
  top: 6px;
  width: 1.5px;
  height: 13px;
  background: currentColor;
  content: "";
}

.find-close::before {
  transform: rotate(45deg);
}

.find-close::after {
  transform: rotate(-45deg);
}

:global(.dark) .find-panel {
  border-bottom-color: rgb(41 37 34 / 92%);
  background: rgb(24 22 20 / 96%);
}

:global(.dark) .find-input-wrap {
  border-color: rgb(76 70 62 / 70%);
  background: rgb(32 29 26 / 76%);
}

:global(.dark) .find-label,
:global(.dark) .find-count {
  color: #aaa196;
}

:global(.dark) .find-count.error {
  color: #ffb4ab;
}

:global(.dark) .find-input {
  color: #f2eee6;
}

:global(.dark) .find-button,
:global(.dark) .find-toggle,
:global(.dark) .find-close {
  color: #b9b3a8;
}

:global(.dark) .find-button:hover,
:global(.dark) .find-toggle:hover,
:global(.dark) .find-close:hover,
:global(.dark) .find-toggle.active {
  border-color: rgb(76 70 62 / 86%);
  background: rgb(255 255 255 / 8%);
  color: #f2eee6;
}
</style>
