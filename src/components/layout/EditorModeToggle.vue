<script setup lang="ts">
import type { EditorMode } from "../../types";

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
      <span class="mode-icon mode-icon-edit" aria-hidden="true">
        <i></i>
      </span>
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
      <span class="mode-icon mode-icon-source" aria-hidden="true">
        <i></i>
      </span>
    </button>
  </div>
</template>

<style scoped>
.editor-mode-toggle {
  --toggle-width: 92px;
  --toggle-height: 30px;
  --toggle-padding: 3px;
  --toggle-track: rgba(245, 243, 238, 0.92);
  --toggle-border: rgba(213, 207, 196, 0.82);
  --toggle-ink: #5f594f;
  --toggle-muted: #8c8579;
  --toggle-paper: linear-gradient(145deg, #ffffff 0%, #f7f3ea 76%);
  --toggle-paper-shadow:
    0 5px 14px rgba(74, 63, 48, 0.13),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
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
    radial-gradient(circle at 24% 0%, rgba(255, 255, 255, 0.8), transparent 42%),
    var(--toggle-track);
  box-shadow:
    inset 0 1px 2px rgba(74, 63, 48, 0.08),
    0 1px 2px rgba(74, 63, 48, 0.05);
  color: var(--toggle-muted);
  isolation: isolate;
}

.editor-mode-toggle:focus-visible {
  outline: none;
  box-shadow:
    inset 0 1px 2px rgba(74, 63, 48, 0.08),
    0 0 0 3px rgba(143, 107, 61, 0.22);
}

.editor-mode-toggle-slider {
  position: absolute;
  inset-block: var(--toggle-padding);
  inset-inline-start: var(--toggle-padding);
  inline-size: calc((var(--toggle-width) - var(--toggle-padding) * 2) / 2);
  border: 1px solid rgba(213, 207, 196, 0.68);
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
  background: rgba(143, 107, 61, 0.2);
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
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.92), rgba(228, 220, 207, 0.72));
  box-shadow: -1px 1px 2px rgba(74, 63, 48, 0.1);
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

.mode-icon {
  position: relative;
  display: block;
  width: 18px;
  height: 18px;
  color: currentColor;
}

.mode-icon::before,
.mode-icon::after,
.mode-icon i,
.mode-icon i::before,
.mode-icon i::after {
  content: "";
  position: absolute;
  box-sizing: border-box;
}

.mode-icon-edit::before {
  left: 3px;
  top: 2px;
  width: 11px;
  height: 14px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  background: linear-gradient(135deg, currentColor 0 12%, transparent 12%);
  opacity: 0.92;
}

.mode-icon-edit::after {
  right: 2px;
  top: 2px;
  width: 5px;
  height: 5px;
  border-radius: 0 2px 0 2px;
  border-left: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  background: rgba(255, 255, 255, 0.28);
}

.mode-icon-edit i {
  left: 6px;
  top: 7px;
  width: 7px;
  height: 1.5px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 4px 0 currentColor;
  opacity: 0.72;
}

.mode-icon-source::before,
.mode-icon-source::after {
  top: 5px;
  width: 6px;
  height: 6px;
  border-color: currentColor;
  border-style: solid;
  opacity: 0.9;
}

.mode-icon-source::before {
  left: 2px;
  border-width: 0 0 1.6px 1.6px;
  transform: rotate(45deg);
}

.mode-icon-source::after {
  right: 2px;
  border-width: 1.6px 1.6px 0 0;
  transform: rotate(45deg);
}

.mode-icon-source i {
  left: 8px;
  top: 3px;
  width: 1.6px;
  height: 12px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.72;
  transform: rotate(16deg);
}

.editor-mode-toggle-option:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.editor-mode-toggle.source-disabled {
  --toggle-track: rgba(245, 243, 238, 0.62);
}

:global(.dark) .editor-mode-toggle {
  --toggle-track: rgba(38, 36, 33, 0.86);
  --toggle-border: rgba(89, 84, 76, 0.78);
  --toggle-ink: #f1eadf;
  --toggle-muted: #aaa196;
  --toggle-paper: linear-gradient(145deg, #36322d 0%, #26231f 78%);
  --toggle-paper-shadow:
    0 6px 14px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  background:
    radial-gradient(circle at 24% 0%, rgba(255, 255, 255, 0.08), transparent 42%),
    var(--toggle-track);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.32),
    0 1px 2px rgba(0, 0, 0, 0.18);
}

:global(.dark) .editor-mode-toggle-slider {
  border-color: rgba(111, 103, 92, 0.7);
}

:global(.dark) .page-line {
  background: rgba(201, 166, 109, 0.24);
}

:global(.dark) .page-fold {
  background: linear-gradient(135deg, rgba(75, 68, 59, 0.95), rgba(35, 31, 27, 0.9));
  box-shadow: -1px 1px 2px rgba(0, 0, 0, 0.28);
}

@media (prefers-reduced-motion: reduce) {
  .editor-mode-toggle-slider,
  .editor-mode-toggle-option {
    transition-duration: 0ms;
  }
}
</style>
