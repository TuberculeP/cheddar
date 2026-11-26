/**
 * Procedural sound effects with the Web Audio API: no audio files, and every sound is
 * randomised a little so a burst of slices never sounds like one sample on repeat.
 *
 * Recipes (all built from filtered white noise and short oscillators):
 * - whoosh: band-pass noise sweeping down, plus a tiny pitched "flick" as the slice leaves.
 * - splat:  noise slap + low thump + a resonant band-pass sweeping up (the wet suction);
 *           on the monitor, a short hollow knock on the plastic.
 * - squish: the suction alone, small and high, as the edges of a slice flop on.
 * - peel:   sparse crackle (sticky fibres letting go) over a falling band-pass sweep.
 */
export class CheeseAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crackle: AudioBuffer | null = null;
  private muted = false;
  /** Start times of recent sounds, to cap how many play at once. */
  private recent: number[] = [];

  /** Creates or resumes the context. Call it from a user gesture (autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.2;
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : VOLUME;
      master.connect(compressor).connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.noise = whiteNoise(ctx, 1);
      this.crackle = crackleNoise(ctx, 0.5);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(
        muted ? 0 : VOLUME,
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  /** A slice leaves the hand. */
  whoosh(pan: number) {
    const ctx = this.ready(true);
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = this.panner(pan);
    const k = vary(0.15);

    const air = this.noiseSource(t, 0.3);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(3200 * k, t);
    band.frequency.exponentialRampToValueAtTime(650 * k, t + 0.24);
    air
      .connect(band)
      .connect(envelope(ctx, t, 0.05, 0.2, 0.22))
      .connect(out);

    const flick = ctx.createOscillator();
    flick.type = "triangle";
    flick.frequency.setValueAtTime(950 * k, t);
    flick.frequency.exponentialRampToValueAtTime(260 * k, t + 0.04);
    flick.connect(envelope(ctx, t, 0.002, 0.07, 0.05)).connect(out);
    flick.start(t);
    flick.stop(t + 0.08);
  }

  /** First impact of a slice. `strength` 0..1 from the impact speed. */
  splat(strength: number, pan: number, desk: boolean) {
    const ctx = this.ready(true);
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = this.panner(pan);
    const s = clamp(strength, 0, 1);
    const k = vary(0.12);

    const slap = this.noiseSource(t, 0.2);
    const slapFilter = ctx.createBiquadFilter();
    slapFilter.type = "bandpass";
    slapFilter.Q.value = 0.7;
    slapFilter.frequency.value = (desk ? 900 : 1700) * k;
    slap
      .connect(slapFilter)
      .connect(envelope(ctx, t, 0.002, 0.1 + 0.45 * s, 0.07 + 0.05 * s))
      .connect(out);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(170 * k, t);
    thump.frequency.exponentialRampToValueAtTime(50, t + 0.09);
    thump
      .connect(envelope(ctx, t, 0.003, 0.05 + (desk ? 0.55 : 0.3) * s, 0.12))
      .connect(out);
    thump.start(t);
    thump.stop(t + 0.2);

    if (!desk) {
      const knock = ctx.createOscillator();
      knock.type = "triangle";
      knock.frequency.value = 430 * k;
      knock.connect(envelope(ctx, t, 0.002, 0.06 * s, 0.05)).connect(out);
      knock.start(t);
      knock.stop(t + 0.1);
    }

    this.suction(t + 0.015, 0.04 + 0.18 * s, 350 * k, 1500 * k, 0.12, out);
  }

  /** Edges of an already landed slice sticking down. `amount` 0..1. */
  squish(amount: number, pan: number) {
    const ctx = this.ready(false);
    if (!ctx) return;
    const t = ctx.currentTime;
    const low = 450 + Math.random() * 450;
    this.suction(
      t,
      0.03 + 0.1 * clamp(amount, 0, 1),
      low,
      low * (1.8 + Math.random() * 0.8),
      0.05 + Math.random() * 0.05,
      this.panner(pan),
    );
  }

  /** Part of a slice coming off a surface. `amount` 0..1. */
  peel(amount: number, pan: number) {
    const ctx = this.ready(false);
    if (!ctx || !this.crackle) return;
    const t = ctx.currentTime;
    const out = this.panner(pan);
    const a = clamp(amount, 0, 1);
    const k = vary(0.2);

    const fibres = ctx.createBufferSource();
    fibres.buffer = this.crackle;
    fibres.playbackRate.value = k;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 2.5;
    band.frequency.setValueAtTime(2600 * k, t);
    band.frequency.exponentialRampToValueAtTime(900 * k, t + 0.28);
    fibres
      .connect(band)
      .connect(envelope(ctx, t, 0.02, 0.12 + 0.2 * a, 0.25))
      .connect(out);
    fibres.start(t, Math.random() * 0.2, 0.3);

    this.suction(t + 0.05, 0.03 + 0.06 * a, 1200 * k, 500 * k, 0.15, out);
  }

  /**
   * Speedrun signals, as plain synth tones: a short beep per countdown second, a higher
   * longer one at the start, and a rising arpeggio at the finish.
   */
  cue(kind: "tick" | "go" | "finish") {
    const ctx = this.ready(true);
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = this.panner(0);
    const notes =
      kind === "tick"
        ? [[880, 0, 0.12]]
        : kind === "go"
          ? [[1320, 0, 0.35]]
          : [
              [523, 0, 0.14],
              [659, 0.1, 0.14],
              [784, 0.2, 0.14],
              [1047, 0.3, 0.5],
            ];
    for (const [freq, delay, length] of notes) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 3000;
      osc
        .connect(lowpass)
        .connect(envelope(ctx, t + delay, 0.005, 0.12, length))
        .connect(out);
      osc.start(t + delay);
      osc.stop(t + delay + length + 0.05);
    }
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  /** The context if a sound may start now; caps simultaneous sounds (splats get priority). */
  private ready(priority: boolean): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== "running") return null;
    const now = ctx.currentTime;
    this.recent = this.recent.filter((t) => now - t < 0.1);
    if (this.recent.length >= (priority ? 14 : 6)) return null;
    this.recent.push(now);
    return ctx;
  }

  /** Resonant band-pass sweep over noise: the wet, sticky part of the sound. */
  private suction(
    t: number,
    peak: number,
    from: number,
    to: number,
    duration: number,
    out: AudioNode,
  ) {
    const ctx = this.ctx!;
    const src = this.noiseSource(t, duration + 0.05);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 8;
    band.frequency.setValueAtTime(from, t);
    band.frequency.exponentialRampToValueAtTime(to, t + duration);
    src
      .connect(band)
      .connect(envelope(ctx, t, 0.01, peak, duration))
      .connect(out);
  }

  private noiseSource(t: number, duration: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 0.5, duration);
    return src;
  }

  private panner(pan: number) {
    const ctx = this.ctx!;
    const node = ctx.createStereoPanner();
    node.pan.value = clamp(pan, -1, 1);
    node.connect(this.master!);
    return node;
  }
}

const VOLUME = 0.9;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Random factor around 1, e.g. vary(0.1) is in [0.9, 1.1]. */
function vary(amount: number) {
  return 1 + (Math.random() * 2 - 1) * amount;
}

/** Gain node with an exponential attack/decay envelope starting at t. */
function envelope(
  ctx: AudioContext,
  t: number,
  attack: number,
  peak: number,
  decay: number,
) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function whiteNoise(ctx: AudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Sparse decaying clicks: the sound of sticky fibres snapping one by one. */
function crackleNoise(ctx: AudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let level = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.random() < 0.0015) level = 0.4 + Math.random() * 0.6;
    level *= 0.993;
    data[i] = (Math.random() * 2 - 1) * level;
  }
  return buffer;
}
