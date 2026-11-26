// All dimensions are in metres, all times in seconds. Real-world sizes: a 24" monitor and a
// standard 8.8 cm cheddar slice, so the cheese covers the screen at a believable rate.

export const SCREEN = { width: 0.53, height: 0.3 };
export const BEZEL = { side: 0.015, top: 0.015, bottom: 0.028, depth: 0.035 };
/** Height of the monitor's lower edge above the desk. */
export const MONITOR_LIFT = 0.13;

export const MONITOR = {
  x0: -SCREEN.width / 2 - BEZEL.side,
  x1: SCREEN.width / 2 + BEZEL.side,
  y0: MONITOR_LIFT,
  y1: MONITOR_LIFT + BEZEL.bottom + SCREEN.height + BEZEL.top,
  z0: -BEZEL.depth,
  z1: 0,
};
export const SCREEN_CENTER_Y = MONITOR_LIFT + BEZEL.bottom + SCREEN.height / 2;

export const STAND = {
  neck: {
    x0: -0.03,
    x1: 0.03,
    y0: 0,
    y1: MONITOR_LIFT,
    z0: -0.075,
    z1: -0.045,
  },
  base: { x0: -0.12, x1: 0.12, y0: 0, y1: 0.012, z0: -0.16, z1: 0.05 },
};

export const DESK = {
  y: 0,
  halfWidth: 1.4,
  zFront: 0.65,
  zBack: -0.5,
  thickness: 0.03,
};
export const WALL_Z = -0.5;

export const SLICE = {
  size: 0.088,
  /** Particles per side. Cost grows with grid^2. */
  grid: 12,
  thickness: 0.0025,
  density: 1100,
};

export const PHYS = {
  substeps: 8,
  gravity: 9.81,
  /** Exponential velocity decay per second (air drag). */
  airDrag: 0.35,
  stretchStiffness: 1,
  shearStiffness: 0.6,
  bendStiffness: 0.12,
  /** Bend/shear rest lengths follow the current shape when strained beyond yield: folds stay. */
  plasticity: 2.5,
  plasticYield: 0.03,
  /** Stretch beyond this strain becomes permanent, up to maxStretch times the rest length. */
  stretchYield: 0.06,
  maxStretch: 1.3,
  /** Adhesion, in newtons per particle. A particle weighs ~1.5e-3 N. */
  peelForce: 0.007,
  slideForce: 0.004,
  /** Creep speed (m/s) per newton above slideForce, and its cap. */
  creepRate: 4,
  maxCreep: 0.4,
  /** Time constant of the force low-pass filter: impacts must not rip the slice off. */
  forceSmoothing: 0.08,
  /** A peeled particle cannot stick again for this long (avoids peel/stick flicker). */
  restickDelay: 0.5,
  friction: 0.5,
  sleepSpeed: 0.004,
  sleepTime: 0.6,
  /** Hard cap on how long a slice may stay awake, to bound the CPU cost. */
  maxAwakeTime: 25,
};

export const LAUNCH = {
  speed: 5.5,
  burstInterval: 0.085,
  /** Max spin around the slice normal and max tumble, rad/s. */
  spin: 8,
  tumble: 3,
  /** Max tilt away from facing the screen, radians. */
  tilt: 0.5,
};

export const MAX_SLICES = 600;

export const SPEEDRUN = {
  /** Coverage sampling grid over the screen (not the bezel). */
  cell: 0.005,
  /**
   * Fraction of grid points that counts as "fully covered". Exactly 1 would mean hunting
   * a 2 mm gap between two slices; the UI shows coverage relative to this target.
   */
  target: 0.995,
  /** Cheese masks the screen when it lies at most this far in front of it (stacks, flaps). */
  maskDepth: 0.05,
  /** Intermediate splits, as fractions of the target. The last split is the finish. */
  splits: [0.25, 0.5, 0.75, 1],
  countdown: 3,
};
/** Heightfield cell size: smaller is smoother stacking, more memory. */
export const HEIGHTFIELD_CELL = 0.004;
