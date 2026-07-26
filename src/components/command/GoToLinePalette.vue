<script setup lang="ts">
import { ref } from "vue";
import { appStore, closeGoToLine, recordNavigationLocation } from "../../stores/appStore";
import { useOverlayFocus } from "../../composables/useOverlayFocus";

const value = ref("");
const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
useOverlayFocus({ backdrop, panel, initialFocus: input, close: closeGoToLine });

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
  <div ref="backdrop" class="lm-modal-backdrop fixed inset-0 z-50 p-20" @click.self="closeGoToLine">
    <form
      ref="panel"
      tabindex="-1"
      class="lm-palette-panel mx-auto max-w-sm overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="前往指定行"
      @submit.prevent="submit"
    >
      <input
        ref="input"
        v-model="value"
        inputmode="numeric"
        pattern="[0-9]*"
        class="w-full border-b border-paper-200 bg-transparent px-4 py-3 text-base text-ink-900 outline-none placeholder:text-ink-500 dark:border-paper-800 dark:text-ink-100 dark:placeholder:text-ink-300"
        placeholder="前往行号"
      />
      <div class="px-4 py-3 text-xs text-ink-500 dark:text-ink-400">
        输入行号后按 Enter
      </div>
    </form>
  </div>
</template>
