# Cheddar

> Toy page at `/` (public): click to throw cheddar slices at a monitor showing the user's image. three.js WebGPURenderer + TSL materials, CPU position-based dynamics.

## Architecture

```
cheddar/
  config.ts       -> every dimension (metres) and tuning constant: start here to change feel
  sim.ts          -> CheeseSim: all slices in flat typed arrays (struct of arrays), PBD solver,
                     adhesion (pin + measured pull -> peel or creep), sleeping, heightfield writes
  world.ts        -> CheeseWorld: static colliders (monitor, stand, desk, wall) + 2 heightfields
  heightfield.ts  -> Heightfield: cheese thickness on a surface, per-cell owner to skip self-collision
  cheeseMesh.ts   -> CheeseMesh: one BufferGeometry for every slot, uploads dirty slices only
  materials.ts    -> TSL node materials (cheese, desk, wall, plastic)
  audio.ts        -> CheeseAudio: procedural Web Audio sound effects (whoosh, splat, squish, peel)
  monitor.ts      -> Monitor: body, stand, screen canvas texture, screen glow light
  scene.ts        -> CheddarScene: renderer, camera framing, lights, pointer firing, fixed-step loop
views/cheddar/
  CheddarView.vue   -> minimal overlay (discreet icon buttons, errors only), lazy-imports scene.ts
                       (three.js stays out of the main bundle). The page title is the placeholder
                       drawn on the 3D screen (+ sr-only h1, document.title).
  useSpeedrun.ts    -> "cover the screen" run: countdown, timer, splits, personal best (localStorage)
  SpeedrunPanel.vue -> splits panel + countdown overlay, desktop-speedrun-timer look (own scoped
                       colour variables, outside the app theme on purpose)
```

`sim.ts`, `world.ts`, `heightfield.ts` and `config.ts` import nothing from three: they run under plain Node (handy for headless physics checks with `tsx`) and map onto TSL compute buffers if the solver moves to the GPU.

## API

```typescript
CheddarScene.create(host: HTMLElement, { screenTitle, onCountChange(n) }): Promise<CheddarScene>
  // rejects with GraphicsUnavailableError (name checked by the view) if neither WebGPU nor WebGL 2 works
scene.backend: "WebGPU" | "WebGL 2"
scene.setScreenImage(file: Blob): Promise<void>   // rejects if not a decodable image
scene.setMuted(muted: boolean): void
scene.setFiringEnabled(enabled: boolean): void   // speedrun countdown
scene.thrown: number                             // slices thrown since clear()
scene.measureCoverage(): number                  // 0..1, ~1 ms: a few times per second
scene.unlockAudio(): void                        // from a click handler
scene.cue(kind: "tick" | "go" | "finish"): void
scene.clear(): void
scene.dispose(): void

sim.spawn(origin: Vec3, velocity: Vec3, rotation: Quat, omega: Vec3, seed: number)
sim.step(dt)   // dt must be 1/60: spawn() derives the initial Verlet velocity from it
sim.events: SimEvent[]   // { kind: "stick" | "peel", slot, count, speed, x, desk, first }, consumer empties it
```

## Add a sound

1. A recipe method in `audio.ts` (filtered noise + short oscillators, randomised with `vary()`), starting with `this.ready(priority)`.
2. If it reacts to physics, emit or reuse a `SimEvent` in `sim.ts` (one per slice per step, never per particle).
3. Map it in `CheddarScene.playEvent`, with a threshold or a per-slot throttle.

## Add a surface the cheese sticks to

1. Box: add it to `config.ts`, test it in `CheeseWorld.collide` with `boxContact`, draw it in `monitor.ts` or `scene.ts`.
2. To stack cheese on it, give it a `Heightfield` and extend `CheeseSim.writeHeightfields` (pick it by contact normal and position).

## Gotchas

- Import from `three/webgpu` and `three/tsl` only, never `three`: node materials need the WebGPU build. Both builds share `three.core.js`, so addons from `three/addons` still work.
- Slices never collide with each other directly. Stacking goes through the heightfields, written only by quads whose 4 corners are stuck; slices in flight pass through each other.
- A slice must only see cheese thrown before it (heightfield owners are spawn serials, kept as a 3-level stack per cell). Seeing newer cheese makes slices landing together leapfrog into a tower; seeing its own makes it peel itself off once covered.
- Sharp steps in the heightfield peel slices: `sample()` interpolates bilinearly, and stretch constraints yield plastically (`stretchYield`, `maxStretch`). Check bursts after touching either, or `peelForce` / `forceSmoothing`: a headless burst of 36 slices should leave nearly all of them on the screen.
- Audio: the `AudioContext` is created on the first pointerdown (`unlock()`), browsers refuse to start sound otherwise. Impacts crumple a slice (bits peel and re-stick), so only `first` stick events splat; everything else squishes, and peels are throttled per slot.
- The solver's stiffness depends on the step: keep `STEP` (scene.ts) and `PHYS.substeps` fixed, retune `PHYS` after changing either.
- Sleep is decided on real displacement only (free particles and creeping anchors). A creep blocked by a collider must not keep a slice awake, or it costs CPU forever.
- Helmet's default CSP blocks `blob:` images, so `Monitor.setImage` draws an `ImageBitmap` into a canvas instead of loading an object URL. An iframe cannot become a WebGL texture: the planned URL mode needs `CSS3DRenderer` under a transparent canvas.
- LibreWolf gates WebGL per site (`librewolf.webgl.prompt`, granted from an address-bar icon; console: "Blocked ... from creating WebGL context but prompting the user") and lacks WebGPU, even with `webgl.disabled = false`: `WebGPURenderer.init()` then dies inside three.js ("this.gl is null"). `create()` probes both APIs first so the view can show how to re-enable WebGL. The view matches the error by `name`, not `instanceof`, because `scene.ts` is lazy-imported.
- `resize()` caps the pixel ratio so the drawing buffer stays under the GPU's max size (`maxDrawingSize`). LibreWolf's fingerprinting protection reports WebGL 2 minimum limits (2048 px): past them every render target fails silently, sound keeps playing and the canvas is black. The "WebGL context was lost" log at startup is the `create()` probe releasing its test context.
- Rendered thickness is 85% of the simulated one so stacked layers never z-fight.
- Screen coverage is what the camera sees, not what touches the glass: every quad within `SPEEDRUN.maskDepth` in front of the screen is projected onto it (slices on other slices, bridges over holes, flaps). Only slices with a stuck particle count, so cheese flying or falling past the last hole cannot end a run. "Covered" is `SPEEDRUN.target` (99.5%), and the UI shows coverage relative to it.
