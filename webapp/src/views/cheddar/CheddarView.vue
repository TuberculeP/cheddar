<template>
  <!-- `dark`: the scene is dark, so the theme's dark tokens keep the discreet controls legible. -->
  <div
    class="dark fixed inset-0 z-10 bg-background select-none"
    @dragover.prevent
    @drop.prevent="onDrop"
  >
    <!-- The visible title is drawn on the 3D screen; this one is for screen readers. -->
    <h1 class="sr-only">{{ t("cheddar.screenTitle") }}</h1>
    <div ref="host" class="absolute inset-0" />

    <div class="absolute top-3 right-3 flex gap-1">
      <Button
        v-for="action in actions"
        :key="action.key"
        variant="ghost"
        size="icon"
        class="size-9 text-muted-foreground/60 hover:bg-transparent hover:text-foreground focus-visible:text-foreground"
        :disabled="action.disabled"
        :aria-label="action.label"
        :title="action.label"
        :aria-pressed="action.pressed"
        @click="action.run"
      >
        <component :is="action.icon" class="size-4" />
      </Button>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        class="hidden"
        @change="onFileChange"
      />
    </div>

    <SpeedrunPanel
      v-if="speedrun.phase.value !== 'off'"
      :title="t('cheddar.screenTitle')"
      :phase="speedrun.phase.value"
      :countdown="speedrun.countdown.value"
      :show-go="speedrun.showGo.value"
      :elapsed="speedrun.elapsed.value"
      :splits="speedrun.splits.value"
      :comparison="speedrun.comparison.value"
      :best="speedrun.best.value"
      :coverage="speedrun.coverage.value"
      :thrown="speedrun.thrown.value"
      :new-record="speedrun.newRecord.value"
      @restart="speedrun.start"
      @close="speedrun.close"
    />

    <p
      v-if="error"
      role="alert"
      class="pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[calc(100%-2rem)] text-center text-sm text-muted-foreground"
    >
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { Eraser, ImageUp, Timer, Volume2, VolumeX } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import type { CheddarScene } from "@/cheddar/scene";
import SpeedrunPanel from "./SpeedrunPanel.vue";
import { useSpeedrun } from "./useSpeedrun";

const { t } = useI18n();

const host = ref<HTMLDivElement>();
const fileInput = ref<HTMLInputElement>();
const scene = shallowRef<CheddarScene>();
const ready = ref(false);
const count = ref(0);
const error = ref("");
let unmounted = false;

const speedrun = useSpeedrun(scene);
/** Clearing mid-run would reset the coverage under the timer: restart instead. */
const racing = computed(
  () =>
    speedrun.phase.value === "countdown" || speedrun.phase.value === "running",
);

/** The mute choice is a per-browser convenience: storage may be unavailable (private mode). */
const MUTE_KEY = "cheddar.muted";
const muted = ref(readMuted());

const actions = computed(() => [
  {
    key: "image",
    icon: ImageUp,
    label: t("cheddar.pickImage"),
    disabled: !ready.value,
    pressed: undefined,
    run: pickFile,
  },
  {
    key: "clear",
    icon: Eraser,
    label: t("cheddar.clear"),
    disabled: !ready.value || count.value === 0 || racing.value,
    pressed: undefined,
    run: clear,
  },
  {
    key: "speedrun",
    icon: Timer,
    label: t("cheddar.speedrun.start"),
    disabled: !ready.value,
    pressed: undefined,
    run: speedrun.start,
  },
  {
    key: "sound",
    icon: muted.value ? VolumeX : Volume2,
    label: muted.value ? t("cheddar.unmute") : t("cheddar.mute"),
    disabled: false,
    pressed: muted.value,
    run: toggleMute,
  },
]);

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function toggleMute() {
  muted.value = !muted.value;
  scene.value?.setMuted(muted.value);
  try {
    localStorage.setItem(MUTE_KEY, muted.value ? "1" : "0");
  } catch {
    // Not remembered, still applied.
  }
}

const previousTitle = document.title;

onMounted(async () => {
  document.title = t("cheddar.screenTitle");
  if (!host.value) return;
  try {
    // three.js is heavy: load it only on this page.
    const { CheddarScene } = await import("@/cheddar/scene");
    const created = await CheddarScene.create(host.value, {
      screenTitle: t("cheddar.screenTitle"),
      onCountChange: (n) => (count.value = n),
    });
    if (unmounted) {
      created.dispose();
      return;
    }
    created.setMuted(muted.value);
    scene.value = created;
    ready.value = true;
  } catch (e) {
    error.value =
      e instanceof Error && e.name === "GraphicsUnavailableError"
        ? t("cheddar.errorNoGpu")
        : t("cheddar.errorInit", {
            message: e instanceof Error ? e.message : String(e),
          });
  }
});

onBeforeUnmount(() => {
  unmounted = true;
  document.title = previousTitle;
  scene.value?.dispose();
});

function pickFile() {
  fileInput.value?.click();
}

async function showImage(file: File | undefined) {
  if (!file || !scene.value) return;
  error.value = "";
  try {
    await scene.value.setScreenImage(file);
  } catch {
    error.value = t("cheddar.errorImage");
  }
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  showImage(input.files?.[0]);
  input.value = "";
}

function onDrop(e: DragEvent) {
  showImage(e.dataTransfer?.files[0]);
}

function clear() {
  scene.value?.clear();
}
</script>
