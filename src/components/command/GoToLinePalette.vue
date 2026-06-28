<script setup lang="ts">
import { ref } from "vue";
import { appStore, closeGoToLine, recordNavigationLocation } from "../../stores/appStore";

const value = ref("");

function submit() {
  const line = Number.parseInt(value.value.trim(), 10);
  if (!Number.isFinite(line) || line < 1) {
    appStore.statusMessage = "请输入有效的行号";
    return;
  }
  if (appStore.documentMode === "normal" && appStore.editorMode !== "source") {
    appStore.statusMessage = "请切换到源码模式后使用行跳转";
    closeGoToLine();
    return;
  }
  recordNavigationLocation();
  window.dispatchEvent(new CustomEvent("lightmark:jump-line", { detail: Math.max(0, line - 1) }));
  closeGoToLine();
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-ink-900/20 p-20" @click.self="closeGoToLine">
    <form
      class="mx-auto max-w-sm overflow-hidden rounded-md border border-paper-200 bg-paper-50 shadow-[0_18px_50px_rgba(31,30,27,0.12)] dark:border-paper-800 dark:bg-paper-900"
      @submit.prevent="submit"
    >
      <input
        v-model="value"
        autofocus
        inputmode="numeric"
        pattern="[0-9]*"
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="前往行号"
        @keydown.esc="closeGoToLine"
      />
      <div class="px-4 py-3 text-xs text-ink-500 dark:text-ink-400">
        输入行号后按 Enter
      </div>
    </form>
  </div>
</template>
