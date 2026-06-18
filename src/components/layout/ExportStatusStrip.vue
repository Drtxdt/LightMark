<script setup lang="ts">
import { computed } from "vue";
import { appStore, clearExportStatus } from "../../stores/appStore";

const visible = computed(() => appStore.exportStatus.status !== "idle");
const isRunning = computed(() => appStore.exportStatus.status === "running");
const statusClass = computed(() => `export-status-strip-${appStore.exportStatus.status}`);

function close() {
  if (isRunning.value) return;
  clearExportStatus();
}
</script>

<template>
  <Transition name="export-status">
    <div v-if="visible" class="export-status-strip" :class="statusClass" role="status" aria-live="polite">
      <div v-if="isRunning" class="export-status-progress" aria-hidden="true"></div>
      <div class="export-status-inner">
        <span class="export-status-dot" aria-hidden="true"></span>
        <span class="export-status-title">{{ appStore.exportStatus.message }}</span>
        <span v-if="appStore.exportStatus.targetLabel" class="export-status-format">
          {{ appStore.exportStatus.targetLabel }}
        </span>
        <span v-if="appStore.exportStatus.path" class="export-status-path" :title="appStore.exportStatus.path">
          {{ appStore.exportStatus.path }}
        </span>
        <span v-else-if="appStore.exportStatus.error" class="export-status-error" :title="appStore.exportStatus.error">
          {{ appStore.exportStatus.error }}
        </span>
        <button
          v-if="!isRunning"
          class="export-status-close"
          type="button"
          title="关闭"
          aria-label="关闭导出状态"
          @click="close"
        >
          <span aria-hidden="true"></span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.export-status-strip {
  position: relative;
  min-height: 34px;
  overflow: hidden;
  border-bottom: 1px solid rgb(220 214 203 / 76%);
  background: rgb(250 248 244 / 94%);
  color: #5f574c;
}

.export-status-inner {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  font-size: 12px;
}

.export-status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #9a8f80;
  box-shadow: 0 0 0 3px rgb(154 143 128 / 14%);
}

.export-status-strip-running .export-status-dot {
  animation: export-status-pulse 960ms ease-in-out infinite;
  background: #8a6d3b;
}

.export-status-strip-success .export-status-dot {
  background: #4f7f58;
  box-shadow: 0 0 0 3px rgb(79 127 88 / 14%);
}

.export-status-strip-error .export-status-dot {
  background: #b45a4f;
  box-shadow: 0 0 0 3px rgb(180 90 79 / 14%);
}

.export-status-title {
  flex: 0 0 auto;
  font-weight: 650;
}

.export-status-format {
  flex: 0 0 auto;
  color: #8a8176;
}

.export-status-path,
.export-status-error {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.export-status-error {
  color: #8f423a;
}

.export-status-close {
  position: relative;
  display: grid;
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.export-status-close:hover,
.export-status-close:focus-visible {
  background: rgb(120 113 108 / 12%);
  outline: none;
}

.export-status-close span::before,
.export-status-close span::after {
  position: absolute;
  top: 10px;
  left: 6px;
  width: 10px;
  height: 1.5px;
  border-radius: 999px;
  background: currentColor;
  content: "";
}

.export-status-close span::before {
  transform: rotate(45deg);
}

.export-status-close span::after {
  transform: rotate(-45deg);
}

.export-status-progress {
  position: absolute;
  inset: auto 0 0;
  height: 2px;
  background:
    linear-gradient(90deg, transparent, rgb(138 109 59 / 0), rgb(138 109 59 / 58%), rgb(138 109 59 / 0), transparent);
  animation: export-status-sweep 1.4s ease-in-out infinite;
}

.export-status-enter-active,
.export-status-leave-active {
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}

.export-status-enter-from,
.export-status-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

:global(.dark) .export-status-strip {
  border-bottom-color: rgb(70 65 58 / 86%);
  background: rgb(29 27 24 / 96%);
  color: #cfc7b9;
}

:global(.dark) .export-status-format {
  color: #9d9487;
}

:global(.dark) .export-status-error {
  color: #e0a095;
}

:global(.dark) .export-status-close:hover,
:global(.dark) .export-status-close:focus-visible {
  background: rgb(231 225 215 / 10%);
}

@keyframes export-status-sweep {
  0% {
    transform: translateX(-80%);
  }
  100% {
    transform: translateX(80%);
  }
}

@keyframes export-status-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .export-status-progress,
  .export-status-strip-running .export-status-dot {
    animation: none;
  }
}
</style>
