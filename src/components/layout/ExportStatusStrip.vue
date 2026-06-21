<script setup lang="ts">
import { computed } from "vue";
import { appStore, clearExportStatus } from "../../stores/appStore";
import { getExportThemePalette } from "../../utils/exportTheme";

const visible = computed(() => appStore.exportStatus.status !== "idle");
const isRunning = computed(() => appStore.exportStatus.status === "running");
const statusClass = computed(() => `export-status-strip-${appStore.exportStatus.status}`);
const statusStyle = computed(() => {
  const palette = getExportThemePalette(appStore.activeTheme === "dark" ? "dark" : "light");
  return {
    "--export-status-bg": palette.statusBg,
    "--export-status-text": palette.statusText,
    "--export-status-muted": palette.statusMuted,
    "--export-status-muted-soft": palette.statusMutedSoft,
    "--export-status-border": palette.statusBorder,
    "--export-status-hover": palette.statusHover,
    "--export-status-running": palette.statusRunning,
    "--export-status-running-soft": palette.statusRunningSoft,
    "--export-status-success": palette.statusSuccess,
    "--export-status-success-soft": palette.statusSuccessSoft,
    "--export-status-error": palette.statusError,
    "--export-status-error-soft": palette.statusErrorSoft,
  };
});

function close() {
  if (isRunning.value) return;
  clearExportStatus();
}
</script>

<template>
  <Transition name="export-status">
    <div v-if="visible" class="export-status-strip" :class="statusClass" :style="statusStyle" role="status" aria-live="polite">
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
  border-bottom: 1px solid var(--export-status-border);
  background: var(--export-status-bg);
  color: var(--export-status-text);
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
  background: var(--export-status-muted);
  box-shadow: 0 0 0 3px var(--export-status-muted-soft);
}

.export-status-strip-running .export-status-dot {
  animation: export-status-pulse 960ms ease-in-out infinite;
  background: var(--export-status-running);
  box-shadow: 0 0 0 3px var(--export-status-running-soft);
}

.export-status-strip-success .export-status-dot {
  background: var(--export-status-success);
  box-shadow: 0 0 0 3px var(--export-status-success-soft);
}

.export-status-strip-error .export-status-dot {
  background: var(--export-status-error);
  box-shadow: 0 0 0 3px var(--export-status-error-soft);
}

.export-status-title {
  flex: 0 0 auto;
  font-weight: 650;
}

.export-status-format {
  flex: 0 0 auto;
  color: var(--export-status-muted);
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
  color: var(--export-status-error);
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
  background: var(--export-status-hover);
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
    linear-gradient(
      90deg,
      transparent,
      var(--export-status-running-soft),
      var(--export-status-running),
      var(--export-status-running-soft),
      transparent
    );
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
