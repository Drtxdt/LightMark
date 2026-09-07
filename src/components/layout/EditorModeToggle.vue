<script setup lang="ts">
import type { EditorMode } from "../../types";
import UiIcon from "../ui/UiIcon.vue";

const props = defineProps<{
  modelValue: EditorMode;
  sourceDisabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [mode: EditorMode];
}>();

function setMode(mode: EditorMode) {
  if (mode === "source" && props.sourceDisabled) return;
  if (mode === props.modelValue) return;
  emit("update:modelValue", mode);
}

function toggleMode() {
  setMode(props.modelValue === "source" ? "wysiwyg" : "source");
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setMode("wysiwyg");
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    setMode("source");
    return;
  }
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    toggleMode();
  }
}
</script>

<template>
  <div
    class="editor-mode-toggle"
    :class="{ 'is-source': modelValue === 'source', 'source-disabled': sourceDisabled }"
    role="switch"
    :aria-checked="modelValue === 'source'"
    aria-label="切换编辑和源代码模式"
    tabindex="0"
    @keydown="handleKeydown"
  >
    <span class="editor-mode-toggle-slider" aria-hidden="true">
      <span class="page-line line-a"></span>
      <span class="page-line line-b"></span>
      <span class="page-fold"></span>
    </span>
    <button
      type="button"
      class="editor-mode-toggle-option"
      :class="{ active: modelValue === 'wysiwyg' }"
      title="编辑"
      aria-label="编辑"
      @click="setMode('wysiwyg')"
    >
      <UiIcon name="pen-line" :size="17" />
    </button>
    <button
      type="button"
      class="editor-mode-toggle-option"
      :class="{ active: modelValue === 'source' }"
      :disabled="sourceDisabled"
      title="源代码"
      aria-label="源代码"
      @click="setMode('source')"
    >
      <UiIcon name="code-xml" :size="17" />
    </button>
  </div>
</template>

<style scoped>
.editor-mode-toggle {
  --toggle-width: 92px;
  --toggle-height: 30px;
  --toggle-padding: 3px;
  --toggle-track: var(--lm-surface-soft);
  --toggle-border: var(--lm-border);
  --toggle-ink: var(--lm-ink);
  --toggle-muted: var(--lm-ink-muted);
  --toggle-paper: linear-gradient(145deg, var(--lm-surface-raised) 0%, var(--lm-surface-soft) 76%);
  --toggle-paper-shadow: var(--lm-shadow-sm);
  position: relative;
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  inline-size: var(--toggle-width);
  block-size: var(--toggle-height);
  padding: var(--toggle-padding);
  overflow: hidden;
  border: 1px solid var(--toggle-border);
  border-radius: 999px;
  background:
    radial-gradient(circle at 24% 0%, color-mix(in srgb, var(--lm-surface) 82%, transparent), transparent 42%),
    var(--toggle-track);
  box-shadow:
    inset 0 1px 2px color-mix(in srgb, var(--lm-ink) 14%, transparent),
    var(--lm-shadow-sm);
  color: var(--toggle-muted);
  isolation: isolate;
}

.editor-mode-toggle:focus-visible {
  outline: 2px solid var(--lm-accent);
  outline-offset: 2px;
  box-shadow:
    inset 0 1px 2px color-mix(in srgb, var(--lm-ink) 14%, transparent),
    0 0 0 4px var(--lm-focus);
}

.editor-mode-toggle-slider {
  position: absolute;
  inset-block: var(--toggle-padding);
  inset-inline-start: var(--toggle-padding);
  inline-size: calc((var(--toggle-width) - var(--toggle-padding) * 2) / 2);
  border: 1px solid var(--lm-border);
  border-radius: 999px;
  background: var(--toggle-paper);
  box-shadow: var(--toggle-paper-shadow);
  transform: translateX(0);
  transition:
    transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 260ms ease,
    background-color 260ms ease;
  z-index: 0;
}

.editor-mode-toggle.is-source .editor-mode-toggle-slider {
  transform: translateX(calc(var(--toggle-width) / 2 - var(--toggle-padding)));
}

.page-line,
.page-fold {
  position: absolute;
  pointer-events: none;
}

.page-line {
  left: 16px;
  width: 20px;
  height: 1px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lm-accent) 24%, transparent);
}

.line-a {
  top: 9px;
}

.line-b {
  top: 14px;
  width: 28px;
}

.page-fold {
  right: 8px;
  top: 6px;
  width: 8px;
  height: 8px;
  border-radius: 0 5px 0 5px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--lm-surface) 92%, transparent),
    color-mix(in srgb, var(--lm-border) 72%, transparent)
  );
  box-shadow: -1px 1px 2px color-mix(in srgb, var(--lm-ink) 12%, transparent);
}

.editor-mode-toggle-option {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  height: 100%;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition:
    color 180ms ease,
    opacity 180ms ease;
}

.editor-mode-toggle-option.active {
  color: var(--toggle-ink);
  font-weight: 600;
}

.editor-mode-toggle-option:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.editor-mode-toggle.source-disabled {
  --toggle-track: color-mix(in srgb, var(--lm-surface-soft) 62%, transparent);
}

:global(.dark) .editor-mode-toggle,
.editor-mode-toggle-dark {
  --toggle-track: color-mix(in srgb, var(--lm-surface-soft) 88%, var(--lm-surface));
  --toggle-border: var(--lm-border-strong);
  --toggle-ink: var(--lm-ink);
  --toggle-muted: var(--lm-ink-muted);
  --toggle-paper: linear-gradient(145deg, var(--lm-surface-raised) 0%, var(--lm-surface) 78%);
  --toggle-paper-shadow: var(--lm-shadow-sm);
  background:
    radial-gradient(circle at 24% 0%, color-mix(in srgb, var(--lm-surface) 26%, transparent), transparent 42%),
    var(--toggle-track);
  box-shadow:
    inset 0 1px 2px color-mix(in srgb, var(--lm-ink) 22%, transparent),
    var(--lm-shadow-sm);
}

:global(.dark) .editor-mode-toggle-slider,
.editor-mode-toggle-dark .editor-mode-toggle-slider {
  border-color: var(--lm-border-strong);
}

:global(.dark) .page-line,
.editor-mode-toggle-dark .page-line {
  background: color-mix(in srgb, var(--lm-accent) 30%, transparent);
}

:global(.dark) .page-fold,
.editor-mode-toggle-dark .page-fold {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--lm-surface-raised) 82%, transparent),
    color-mix(in srgb, var(--lm-surface) 84%, var(--lm-border))
  );
  box-shadow: -1px 1px 2px color-mix(in srgb, var(--lm-ink) 24%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .editor-mode-toggle-slider,
  .editor-mode-toggle-option {
    transition-duration: 0ms;
  }
}
</style>
