<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

type ThemeValue = "light" | "dark";

const props = withDefaults(
  defineProps<{
    modelValue: ThemeValue;
    label?: string;
    disabled?: boolean;
    size?: "sm" | "md" | "lg" | number;
    duration?: number;
  }>(),
  {
    label: "切换浅色和深色模式",
    disabled: false,
    size: "md",
    duration: 520,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: ThemeValue];
  change: [payload: { mode: ThemeValue; source: "click" | "keyboard" | "programmatic" }];
}>();

const isDark = ref(props.modelValue === "dark");
const prefersReducedMotion = ref(false);
let motionMedia: MediaQueryList | null = null;
let removeMotionListener = () => {};

const width = computed(() => {
  if (typeof props.size === "number") return props.size;
  return props.size === "sm" ? 78 : props.size === "lg" ? 126 : 96;
});
const height = computed(() => Math.round((width.value * 70) / 180));
const motionOff = computed(() => prefersReducedMotion.value);
const rootStyle = computed(() => ({
  "--lm-theme-toggle-width": `${width.value}px`,
  "--lm-theme-toggle-height": `${height.value}px`,
  "--lm-theme-toggle-duration": `${motionOff.value ? 0 : props.duration}ms`,
  "--lm-theme-toggle-scale": `${width.value / 180}px`,
}));

watch(
  () => props.modelValue,
  (value) => {
    isDark.value = value === "dark";
  },
);

function commit(nextDark: boolean, source: "click" | "keyboard" | "programmatic") {
  if (props.disabled) return;
  const nextMode: ThemeValue = nextDark ? "dark" : "light";
  if (nextMode === props.modelValue) return;
  isDark.value = nextDark;
  emit("update:modelValue", nextMode);
  emit("change", { mode: nextMode, source });
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  commit(!isDark.value, "keyboard");
}

function starClass(index: number) {
  if (index <= 2) return "big";
  if (index <= 5) return "medium";
  return "small";
}

onMounted(() => {
  if (typeof window === "undefined" || !window.matchMedia) return;
  motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
  prefersReducedMotion.value = motionMedia.matches;
  const handleMotionChange = (event: MediaQueryListEvent) => {
    prefersReducedMotion.value = event.matches;
  };
  motionMedia.addEventListener?.("change", handleMotionChange);
  removeMotionListener = () => motionMedia?.removeEventListener?.("change", handleMotionChange);
});

onBeforeUnmount(() => {
  removeMotionListener();
});
</script>

<template>
  <button
    class="lm-theme-toggle"
    :class="{ 'is-dark': isDark, 'motion-off': motionOff }"
    :style="rootStyle"
    type="button"
    role="switch"
    :aria-checked="isDark"
    :aria-label="label"
    :title="isDark ? '切换到浅色模式' : '切换到深色模式'"
    :disabled="disabled"
    @click="commit(!isDark, 'click')"
    @keydown="onKeydown"
  >
    <span class="daytime-background glow-a" aria-hidden="true"></span>
    <span class="daytime-background glow-b" aria-hidden="true"></span>
    <span class="daytime-background glow-c" aria-hidden="true"></span>

    <span class="stars" aria-hidden="true">
      <span v-for="index in 11" :key="index" class="star" :class="starClass(index)">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </span>
    </span>

    <span class="cloud cloud-solid" aria-hidden="true">
      <i v-for="index in 6" :key="index"></i>
    </span>
    <span class="cloud cloud-light" aria-hidden="true">
      <i v-for="index in 6" :key="index"></i>
    </span>

    <span class="main-button" aria-hidden="true">
      <i class="moon moon-a"></i>
      <i class="moon moon-b"></i>
      <i class="moon moon-c"></i>
    </span>
  </button>
</template>

<style scoped>
.lm-theme-toggle {
  --lm-toggle-focus: rgba(120, 113, 108, 0.36);
  position: relative;
  inline-size: var(--lm-theme-toggle-width);
  block-size: var(--lm-theme-toggle-height);
  flex: 0 0 auto;
  overflow: hidden;
  border: 0;
  border-radius: 999px;
  background-color: rgba(70, 133, 192, 1);
  box-shadow:
    inset 0 0 calc(5 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.5),
    0 calc(4 * var(--lm-theme-toggle-scale)) calc(11 * var(--lm-theme-toggle-scale)) rgba(31, 30, 27, 0.16);
  cursor: pointer;
  transition:
    background-color var(--lm-theme-toggle-duration) ease,
    box-shadow var(--lm-theme-toggle-duration) ease,
    opacity 160ms ease;
  transition-timing-function: cubic-bezier(0, 0.5, 1, 1);
}

.lm-theme-toggle:hover {
  box-shadow:
    inset 0 0 calc(5 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.52),
    0 calc(5 * var(--lm-theme-toggle-scale)) calc(13 * var(--lm-theme-toggle-scale)) rgba(31, 30, 27, 0.2);
}

.lm-theme-toggle:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 3px var(--lm-toggle-focus),
    0 7px 18px rgba(31, 30, 27, 0.16);
}

.lm-theme-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.56;
}

.lm-theme-toggle.is-dark {
  --lm-toggle-focus: rgba(201, 166, 109, 0.36);
  background-color: rgba(25, 30, 50, 1);
  box-shadow:
    inset 0 0 calc(5 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.55),
    0 calc(5 * var(--lm-theme-toggle-scale)) calc(13 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.26);
}

.daytime-background {
  position: absolute;
  z-index: 1;
  border-radius: 999px;
  opacity: 1;
  transition:
    opacity var(--lm-theme-toggle-duration) ease,
    transform var(--lm-theme-toggle-duration) cubic-bezier(0.25, 0.9, 0.2, 1);
}

.glow-a {
  top: calc(-20 * var(--lm-theme-toggle-scale));
  left: calc(-20 * var(--lm-theme-toggle-scale));
  inline-size: calc(110 * var(--lm-theme-toggle-scale));
  block-size: calc(110 * var(--lm-theme-toggle-scale));
  background-color: rgba(255, 255, 255, 0.2);
}

.glow-b {
  top: calc(-32.5 * var(--lm-theme-toggle-scale));
  left: calc(-17.5 * var(--lm-theme-toggle-scale));
  inline-size: calc(135 * var(--lm-theme-toggle-scale));
  block-size: calc(135 * var(--lm-theme-toggle-scale));
  background-color: rgba(255, 255, 255, 0.1);
}

.glow-c {
  top: calc(-45 * var(--lm-theme-toggle-scale));
  left: calc(-15 * var(--lm-theme-toggle-scale));
  inline-size: calc(160 * var(--lm-theme-toggle-scale));
  block-size: calc(160 * var(--lm-theme-toggle-scale));
  background-color: rgba(255, 255, 255, 0.05);
}

.lm-theme-toggle.is-dark .glow-a {
  transform: translateX(calc(110 * var(--lm-theme-toggle-scale)));
}

.lm-theme-toggle.is-dark .glow-b {
  transform: translateX(calc(80 * var(--lm-theme-toggle-scale)));
}

.lm-theme-toggle.is-dark .glow-c {
  transform: translateX(calc(50 * var(--lm-theme-toggle-scale)));
}

.main-button {
  position: absolute;
  z-index: 4;
  top: calc(7.5 * var(--lm-theme-toggle-scale));
  left: calc(7.5 * var(--lm-theme-toggle-scale));
  inline-size: calc(55 * var(--lm-theme-toggle-scale));
  block-size: calc(55 * var(--lm-theme-toggle-scale));
  border-radius: 999px;
  background-color: rgba(255, 195, 35, 1);
  box-shadow:
    calc(3 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) calc(5 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.5),
    inset calc(-3 * var(--lm-theme-toggle-scale)) calc(-5 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) calc(-3 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.5),
    inset calc(4 * var(--lm-theme-toggle-scale)) calc(5 * var(--lm-theme-toggle-scale)) calc(2 * var(--lm-theme-toggle-scale)) calc(-2 * var(--lm-theme-toggle-scale)) rgba(255, 230, 80, 1);
  transform: translateX(0);
  transition:
    transform 1s cubic-bezier(0.56, 1.35, 0.52, 1),
    background-color 1s ease,
    box-shadow var(--lm-theme-toggle-duration) ease;
}

.lm-theme-toggle:not(.is-dark):hover .main-button {
  transform: translateX(calc(10 * var(--lm-theme-toggle-scale)));
}

.lm-theme-toggle.is-dark .main-button {
  background-color: rgba(195, 200, 210, 1);
  box-shadow:
    calc(3 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) calc(5 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.5),
    inset calc(-3 * var(--lm-theme-toggle-scale)) calc(-5 * var(--lm-theme-toggle-scale)) calc(3 * var(--lm-theme-toggle-scale)) calc(-3 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.5),
    inset calc(4 * var(--lm-theme-toggle-scale)) calc(5 * var(--lm-theme-toggle-scale)) calc(2 * var(--lm-theme-toggle-scale)) calc(-2 * var(--lm-theme-toggle-scale)) rgba(255, 255, 210, 1);
  transform: translateX(calc(110 * var(--lm-theme-toggle-scale)));
}

.lm-theme-toggle.is-dark:hover .main-button {
  transform: translateX(calc(100 * var(--lm-theme-toggle-scale)));
}

.moon {
  position: absolute;
  border-radius: 999px;
  background-color: rgba(150, 160, 180, 1);
  box-shadow: inset 0 0 calc(1 * var(--lm-theme-toggle-scale)) calc(1 * var(--lm-theme-toggle-scale)) rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.5s ease;
}

.lm-theme-toggle.is-dark .moon {
  opacity: 1;
}

.moon-a {
  top: calc(7.5 * var(--lm-theme-toggle-scale));
  left: calc(25 * var(--lm-theme-toggle-scale));
  width: calc(12.5 * var(--lm-theme-toggle-scale));
  height: calc(12.5 * var(--lm-theme-toggle-scale));
}

.moon-b {
  top: calc(20 * var(--lm-theme-toggle-scale));
  left: calc(7.5 * var(--lm-theme-toggle-scale));
  width: calc(20 * var(--lm-theme-toggle-scale));
  height: calc(20 * var(--lm-theme-toggle-scale));
}

.moon-c {
  top: calc(32.5 * var(--lm-theme-toggle-scale));
  left: calc(32.5 * var(--lm-theme-toggle-scale));
  width: calc(12.5 * var(--lm-theme-toggle-scale));
  height: calc(12.5 * var(--lm-theme-toggle-scale));
}

.cloud,
.cloud i {
  position: absolute;
  border-radius: 999px;
}

.cloud {
  z-index: 3;
  inset: 0;
  transform: translateY(calc(10 * var(--lm-theme-toggle-scale)));
  transition:
    opacity var(--lm-theme-toggle-duration) ease,
    transform 1s cubic-bezier(0.56, 1.35, 0.52, 1);
}

.cloud-light {
  z-index: 2;
  right: 0;
  bottom: calc(25 * var(--lm-theme-toggle-scale));
  opacity: 0.5;
}

.cloud i {
  display: block;
  background-color: #fff;
  animation: lm-cloud-float 6s ease-in-out infinite alternate;
}

.cloud-light i {
  background-color: #d9f0ff;
}

.cloud i:nth-child(6n + 1) {
  right: calc(-20 * var(--lm-theme-toggle-scale));
  bottom: calc(10 * var(--lm-theme-toggle-scale));
  width: calc(50 * var(--lm-theme-toggle-scale));
  height: calc(50 * var(--lm-theme-toggle-scale));
  animation-delay: -0.6s;
}

.cloud i:nth-child(6n + 2) {
  right: calc(-10 * var(--lm-theme-toggle-scale));
  bottom: calc(-25 * var(--lm-theme-toggle-scale));
  width: calc(60 * var(--lm-theme-toggle-scale));
  height: calc(60 * var(--lm-theme-toggle-scale));
  animation-delay: -1.3s;
}

.cloud i:nth-child(6n + 3) {
  right: calc(20 * var(--lm-theme-toggle-scale));
  bottom: calc(-40 * var(--lm-theme-toggle-scale));
  width: calc(60 * var(--lm-theme-toggle-scale));
  height: calc(60 * var(--lm-theme-toggle-scale));
  animation-delay: -2s;
}

.cloud i:nth-child(6n + 4) {
  right: calc(50 * var(--lm-theme-toggle-scale));
  bottom: calc(-35 * var(--lm-theme-toggle-scale));
  width: calc(60 * var(--lm-theme-toggle-scale));
  height: calc(60 * var(--lm-theme-toggle-scale));
  animation-delay: -2.6s;
}

.cloud i:nth-child(6n + 5) {
  right: calc(75 * var(--lm-theme-toggle-scale));
  bottom: calc(-60 * var(--lm-theme-toggle-scale));
  width: calc(75 * var(--lm-theme-toggle-scale));
  height: calc(75 * var(--lm-theme-toggle-scale));
  animation-delay: -3.1s;
}

.cloud i:nth-child(6n + 6) {
  right: calc(110 * var(--lm-theme-toggle-scale));
  bottom: calc(-50 * var(--lm-theme-toggle-scale));
  width: calc(60 * var(--lm-theme-toggle-scale));
  height: calc(60 * var(--lm-theme-toggle-scale));
  animation-delay: -3.8s;
}

.lm-theme-toggle.is-dark .cloud {
  opacity: 0;
  transform: translateY(calc(80 * var(--lm-theme-toggle-scale)));
}

@keyframes lm-cloud-float {
  from {
    transform: translate(calc(-2 * var(--lm-theme-toggle-scale)), calc(1 * var(--lm-theme-toggle-scale)));
  }
  to {
    transform: translate(calc(2 * var(--lm-theme-toggle-scale)), calc(-2 * var(--lm-theme-toggle-scale)));
  }
}

.stars {
  position: absolute;
  z-index: 3;
  inset: 0;
  opacity: 0;
  transform: translateY(calc(-70 * var(--lm-theme-toggle-scale)));
  transition:
    opacity var(--lm-theme-toggle-duration) ease,
    transform 1s cubic-bezier(0.56, 1.35, 0.52, 1);
}

.lm-theme-toggle.is-dark .stars {
  opacity: 1;
  transform: translateY(0);
}

.big {
  --star-size: calc(7.5 * var(--lm-theme-toggle-scale));
}

.medium {
  --star-size: calc(5 * var(--lm-theme-toggle-scale));
}

.small {
  --star-size: calc(3 * var(--lm-theme-toggle-scale));
}

.star {
  position: absolute;
  width: calc(2 * var(--star-size));
  height: calc(2 * var(--star-size));
  animation: lm-star-twinkle 3s linear infinite alternate;
  transform-origin: center;
}

.star:nth-child(1) {
  top: calc(10 * var(--lm-theme-toggle-scale));
  left: calc(40 * var(--lm-theme-toggle-scale));
  animation-duration: 3.5s;
  animation-delay: -1.2s;
}

.star:nth-child(2) {
  top: calc(20 * var(--lm-theme-toggle-scale));
  left: calc(95 * var(--lm-theme-toggle-scale));
  animation-duration: 4.1s;
  animation-delay: -2s;
}

.star:nth-child(3) {
  top: calc(20 * var(--lm-theme-toggle-scale));
  left: calc(20 * var(--lm-theme-toggle-scale));
  animation-duration: 4.9s;
  animation-delay: -3.1s;
}

.star:nth-child(4) {
  top: calc(35 * var(--lm-theme-toggle-scale));
  left: calc(50 * var(--lm-theme-toggle-scale));
  animation-duration: 5.3s;
  animation-delay: -1.7s;
}

.star:nth-child(5) {
  top: calc(50 * var(--lm-theme-toggle-scale));
  left: calc(80 * var(--lm-theme-toggle-scale));
  animation-duration: 3s;
  animation-delay: -2.4s;
}

.star:nth-child(6) {
  top: calc(50 * var(--lm-theme-toggle-scale));
  left: calc(20 * var(--lm-theme-toggle-scale));
  animation-duration: 2.2s;
  animation-delay: -0.8s;
}

.star:nth-child(7) {
  top: calc(40 * var(--lm-theme-toggle-scale));
  left: calc(27.5 * var(--lm-theme-toggle-scale));
  animation-duration: 3.8s;
  animation-delay: -2.9s;
}

.star:nth-child(8) {
  top: calc(55 * var(--lm-theme-toggle-scale));
  left: calc(45 * var(--lm-theme-toggle-scale));
  animation-duration: 4.5s;
  animation-delay: -1.4s;
}

.star:nth-child(9) {
  top: calc(20 * var(--lm-theme-toggle-scale));
  left: calc(75 * var(--lm-theme-toggle-scale));
  animation-duration: 3.2s;
  animation-delay: -2.1s;
}

.star:nth-child(10) {
  top: calc(32.5 * var(--lm-theme-toggle-scale));
  left: calc(67.5 * var(--lm-theme-toggle-scale));
  animation-duration: 4.2s;
  animation-delay: -3.4s;
}

.star:nth-child(11) {
  top: calc(40 * var(--lm-theme-toggle-scale));
  left: calc(95 * var(--lm-theme-toggle-scale));
  animation-duration: 5s;
  animation-delay: -1s;
}

.star i {
  float: left;
  width: var(--star-size);
  height: var(--star-size);
}

.star i:nth-child(1) {
  --star-pos: left 0;
}

.star i:nth-child(2) {
  --star-pos: right 0;
}

.star i:nth-child(3) {
  --star-pos: 0 bottom;
}

.star i:nth-child(4) {
  --star-pos: right bottom;
}

.star i {
  background-image: radial-gradient(circle var(--star-size) at var(--star-pos), transparent var(--star-size), #fff);
}

.lm-theme-toggle.motion-off .star,
.lm-theme-toggle.motion-off .cloud i {
  animation: none;
}

@keyframes lm-star-twinkle {
  0%,
  20% {
    transform: scale(0);
  }
  20%,
  100% {
    transform: scale(1);
  }
}
</style>
