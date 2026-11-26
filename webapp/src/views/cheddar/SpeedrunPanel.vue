<template>
  <!-- Countdown and "go" flash, centred over the scene -->
  <div
    v-if="countdown > 0 || showGo"
    class="sr-overlay"
    role="status"
    aria-live="assertive"
  >
    <span class="sr-big">{{
      countdown > 0 ? countdown : t("cheddar.speedrun.go")
    }}</span>
  </div>

  <!-- Splits panel in the style of desktop speedrun timers. Clicks go through to the scene,
       except on its two buttons. -->
  <section class="speedrun" :aria-label="t('cheddar.speedrun.start')">
    <header class="sr-header">
      <p class="sr-game">{{ title }}</p>
      <p class="sr-category">{{ t("cheddar.speedrun.category") }}</p>
    </header>

    <ol class="sr-splits">
      <li
        v-for="(mark, i) in SPEEDRUN.splits"
        :key="mark"
        :class="{ 'sr-current': i === currentSplit }"
      >
        <span class="sr-name">{{ percent(mark) }}</span>
        <span class="sr-delta" :class="deltaClass(i)">{{ deltaText(i) }}</span>
        <span class="sr-time" :class="{ 'sr-dim': splits[i] === null }">
          {{ splitText(i) }}
        </span>
      </li>
    </ol>

    <div class="sr-timer" :class="timerClass" aria-hidden="true">
      <span>{{ clock.main }}</span
      ><span class="sr-fraction">{{ clock.fraction }}</span>
    </div>

    <dl class="sr-stats">
      <div>
        <dt>{{ t("cheddar.speedrun.slices") }}</dt>
        <dd>{{ thrown }}</dd>
      </div>
      <div>
        <dt>{{ t("cheddar.speedrun.coverage") }}</dt>
        <dd>{{ percent(coverage, 1) }}</dd>
      </div>
      <div>
        <dt>{{ t("cheddar.speedrun.best") }}</dt>
        <dd :class="{ 'sr-record': newRecord }">
          {{ best ? formatTime(best.total) : "-" }}
        </dd>
      </div>
    </dl>
    <p v-if="newRecord" class="sr-record sr-banner">
      {{ t("cheddar.speedrun.newRecord") }}
    </p>

    <footer class="sr-footer">
      <button
        type="button"
        :aria-label="t('cheddar.speedrun.restart')"
        :title="t('cheddar.speedrun.restart')"
        @click="emit('restart')"
      >
        <RotateCcw class="size-3.5" />
      </button>
      <button
        type="button"
        :aria-label="t('cheddar.speedrun.close')"
        :title="t('cheddar.speedrun.close')"
        @click="emit('close')"
      >
        <X class="size-3.5" />
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RotateCcw, X } from "lucide-vue-next";
import { SPEEDRUN } from "@/cheddar/config";
import type { SpeedrunPhase, SpeedrunTimes } from "./useSpeedrun";

const props = defineProps<{
  title: string;
  phase: SpeedrunPhase;
  countdown: number;
  showGo: boolean;
  elapsed: number;
  splits: (number | null)[];
  comparison: SpeedrunTimes | null;
  best: SpeedrunTimes | null;
  coverage: number;
  thrown: number;
  newRecord: boolean;
}>();
const emit = defineEmits<{ restart: []; close: [] }>();
const { t, locale } = useI18n();

/** The split being run: first one without a time, none once finished. */
const currentSplit = computed(() =>
  props.phase === "running" ? props.splits.findIndex((s) => s === null) : -1,
);

const clock = computed(() => splitClock(props.elapsed));

const timerClass = computed(() => {
  if (props.phase === "countdown") return "sr-idle";
  const cmp = props.comparison;
  // Behind the best's total: red, as speedrun timers do. Otherwise green.
  return cmp && props.elapsed > cmp.total ? "sr-behind" : "sr-ahead";
});

function percent(value: number, decimals = 0) {
  return new Intl.NumberFormat(locale.value, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function splitText(i: number) {
  const time = props.splits[i];
  if (time !== null) return formatTime(time);
  // Future splits show the best's times, like a comparison column.
  const reference = props.comparison?.splits[i];
  return reference !== undefined ? formatTime(reference) : "-";
}

function delta(i: number) {
  const time = props.splits[i];
  const reference = props.comparison?.splits[i];
  return time === null || reference === undefined ? null : time - reference;
}

function deltaText(i: number) {
  const d = delta(i);
  if (d === null) return "";
  const sign = d < 0 ? "−" : "+";
  return sign + formatTime(Math.abs(d), 1);
}

function deltaClass(i: number) {
  const d = delta(i);
  return d === null ? "" : d <= 0 ? "sr-ahead-text" : "sr-behind-text";
}

/** 12.34 under a minute, 1:02.34 above (speedrun timer convention). */
function formatTime(ms: number, decimals = 2) {
  const { main, fraction } = splitClock(ms, decimals);
  return main + fraction;
}

function splitClock(ms: number, decimals = 2) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const fraction = Math.floor((ms % 1000) / 10 ** (3 - decimals))
    .toString()
    .padStart(decimals, "0");
  const main =
    minutes > 0
      ? `${minutes}:${seconds.toString().padStart(2, "0")}`
      : `${seconds}`;
  return { main, fraction: `.${fraction}` };
}
</script>

<style scoped>
/* Self-contained look of desktop speedrun timers, deliberately outside the app theme:
   black panel, green timer when ahead, red when behind, blue bar on the current split. */
.speedrun,
.sr-overlay {
  --sr-bg-top: #1c1c1c;
  --sr-bg-bottom: #050505;
  --sr-line: #2b2b2b;
  --sr-text: #f4f4f4;
  --sr-dim: #8a8a8a;
  --sr-green-top: #7dffa3;
  --sr-green-bottom: #00b832;
  --sr-green: #29d65a;
  --sr-red-top: #ff8c7a;
  --sr-red-bottom: #cc1200;
  --sr-red: #e5402a;
  --sr-idle-top: #ffffff;
  --sr-idle-bottom: #9a9a9a;
  --sr-current-left: #1f4fb8;
  --sr-current-right: #12306f;
  --sr-gold: #f5c542;
}

.speedrun {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  width: min(16rem, calc(100% - 1.5rem));
  pointer-events: none;
  color: var(--sr-text);
  background: linear-gradient(var(--sr-bg-top), var(--sr-bg-bottom));
  border: 1px solid var(--sr-line);
  font-variant-numeric: tabular-nums;
  font-size: 0.8125rem;
  line-height: 1.35;
  user-select: none;
}
/* Phones: the top-right toolbar leaves no room beside it, so the panel goes to the bottom. */
@media (max-width: 30rem) {
  .speedrun {
    top: auto;
    bottom: 0.75rem;
  }
}

.sr-header {
  padding: 0.4rem 0.6rem;
  text-align: center;
  border-bottom: 1px solid var(--sr-line);
}
.sr-game {
  font-weight: 600;
}
.sr-category {
  color: var(--sr-dim);
}

.sr-splits {
  border-bottom: 1px solid var(--sr-line);
}
.sr-splits li {
  display: grid;
  grid-template-columns: 1fr auto 4.5rem;
  gap: 0.5rem;
  padding: 0.2rem 0.6rem;
}
.sr-splits li + li {
  border-top: 1px solid var(--sr-line);
}
.sr-current {
  background: linear-gradient(
    90deg,
    var(--sr-current-left),
    var(--sr-current-right)
  );
}
.sr-time {
  text-align: right;
}
.sr-dim {
  color: var(--sr-dim);
}
.sr-ahead-text {
  color: var(--sr-green);
}
.sr-behind-text {
  color: var(--sr-red);
}

.sr-timer {
  padding: 0.1rem 0.6rem 0.2rem;
  text-align: right;
  font-size: 2.6rem;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  filter: drop-shadow(0 2px 2px rgb(0 0 0 / 0.8));
}
.sr-timer span {
  background: linear-gradient(var(--sr-top), var(--sr-bottom));
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}
.sr-fraction {
  font-size: 0.65em;
}
.sr-ahead {
  --sr-top: var(--sr-green-top);
  --sr-bottom: var(--sr-green-bottom);
}
.sr-behind {
  --sr-top: var(--sr-red-top);
  --sr-bottom: var(--sr-red-bottom);
}
.sr-idle {
  --sr-top: var(--sr-idle-top);
  --sr-bottom: var(--sr-idle-bottom);
}

.sr-stats {
  border-top: 1px solid var(--sr-line);
  padding: 0.25rem 0.6rem;
}
.sr-stats div {
  display: flex;
  justify-content: space-between;
}
.sr-stats dt {
  color: var(--sr-dim);
}
.sr-record {
  color: var(--sr-gold);
}
.sr-banner {
  padding: 0 0.6rem 0.3rem;
  text-align: center;
  font-weight: 600;
}

.sr-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.25rem;
  padding: 0.2rem 0.4rem;
  border-top: 1px solid var(--sr-line);
}
.sr-footer button {
  pointer-events: auto;
  padding: 0.25rem;
  color: var(--sr-dim);
  border-radius: 0.25rem;
}
.sr-footer button:hover,
.sr-footer button:focus-visible {
  color: var(--sr-text);
}

.sr-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.sr-big {
  font-size: clamp(4rem, 18vmin, 10rem);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(var(--sr-green-top), var(--sr-green-bottom));
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  filter: drop-shadow(0 4px 6px rgb(0 0 0 / 0.85));
}
</style>
