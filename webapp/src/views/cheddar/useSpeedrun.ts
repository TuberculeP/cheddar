import { onBeforeUnmount, ref, type ShallowRef } from "vue";
import { SPEEDRUN } from "@/cheddar/config";
import type { CheddarScene } from "@/cheddar/scene";

export type SpeedrunPhase = "off" | "countdown" | "running" | "done";

/** A finished run: total time and the time of each split, in ms. */
export interface SpeedrunTimes {
  total: number;
  splits: number[];
}

/** Personal best, per browser. Storage may be unavailable (private mode): then not kept. */
const BEST_KEY = "cheddar.speedrun.best";
/** Coverage costs ~1 ms to measure: a few times per second is plenty for splits. */
const MEASURE_EVERY_MS = 150;
const GO_FLASH_MS = 800;

/**
 * "Cover the screen" speedrun: start() clears the screen, counts down (throwing blocked),
 * then times the run until the screen coverage reaches SPEEDRUN.target, recording a split
 * at each SPEEDRUN.splits fraction. The timer is wall-clock time from the "go" signal.
 */
export function useSpeedrun(scene: ShallowRef<CheddarScene | undefined>) {
  const phase = ref<SpeedrunPhase>("off");
  /** Seconds left during the countdown. */
  const countdown = ref(0);
  const showGo = ref(false);
  const elapsed = ref(0);
  const splits = ref<(number | null)[]>(emptySplits());
  /** Coverage relative to the target, 0..1 (1 = finished). */
  const coverage = ref(0);
  const thrown = ref(0);
  const best = ref<SpeedrunTimes | null>(readBest());
  /** The best as it was when this run started: what the deltas compare against. */
  const comparison = ref<SpeedrunTimes | null>(null);
  const newRecord = ref(false);

  let startAt = 0;
  let lastMeasure = 0;
  let frame = 0;
  let timers: number[] = [];

  function start() {
    const s = scene.value;
    if (!s) return;
    stopTimers();
    s.unlockAudio();
    s.clear();
    s.setFiringEnabled(false);
    splits.value = emptySplits();
    elapsed.value = 0;
    coverage.value = 0;
    thrown.value = 0;
    newRecord.value = false;
    comparison.value = best.value;
    phase.value = "countdown";
    for (let i = 0; i < SPEEDRUN.countdown; i++) {
      timers.push(
        window.setTimeout(() => {
          countdown.value = SPEEDRUN.countdown - i;
          s.cue("tick");
        }, i * 1000),
      );
    }
    timers.push(window.setTimeout(go, SPEEDRUN.countdown * 1000));
  }

  function go() {
    const s = scene.value;
    if (!s) return;
    s.cue("go");
    s.setFiringEnabled(true);
    countdown.value = 0;
    showGo.value = true;
    timers.push(window.setTimeout(() => (showGo.value = false), GO_FLASH_MS));
    phase.value = "running";
    startAt = performance.now();
    lastMeasure = 0;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    const s = scene.value;
    if (phase.value !== "running" || !s) return;
    elapsed.value = Math.max(0, now - startAt);
    thrown.value = s.thrown;
    if (now - lastMeasure >= MEASURE_EVERY_MS) {
      lastMeasure = now;
      coverage.value = Math.min(1, s.measureCoverage() / SPEEDRUN.target);
      const next = [...splits.value];
      SPEEDRUN.splits.forEach((mark, i) => {
        if (next[i] === null && coverage.value >= mark) next[i] = elapsed.value;
      });
      splits.value = next;
      if (coverage.value >= 1) {
        finish();
        return;
      }
    }
    frame = requestAnimationFrame(tick);
  }

  function finish() {
    phase.value = "done";
    scene.value?.cue("finish");
    const run: SpeedrunTimes = {
      total: elapsed.value,
      splits: splits.value.map((t) => t ?? elapsed.value),
    };
    if (!best.value || run.total < best.value.total) {
      best.value = run;
      newRecord.value = true;
      writeBest(run);
    }
  }

  /** Leaves speedrun mode (the cheese stays where it is). */
  function close() {
    stopTimers();
    phase.value = "off";
    scene.value?.setFiringEnabled(true);
  }

  function stopTimers() {
    cancelAnimationFrame(frame);
    timers.forEach((t) => clearTimeout(t));
    timers = [];
    showGo.value = false;
    countdown.value = 0;
  }

  onBeforeUnmount(stopTimers);

  return {
    phase,
    countdown,
    showGo,
    elapsed,
    splits,
    coverage,
    thrown,
    best,
    comparison,
    newRecord,
    start,
    close,
  };
}

function emptySplits(): (number | null)[] {
  return SPEEDRUN.splits.map(() => null);
}

function readBest(): SpeedrunTimes | null {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SpeedrunTimes;
    // A best saved with another split list cannot be compared split by split.
    return typeof parsed.total === "number" &&
      Array.isArray(parsed.splits) &&
      parsed.splits.length === SPEEDRUN.splits.length
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeBest(run: SpeedrunTimes) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(run));
  } catch {
    // Not remembered, still shown for this visit.
  }
}
