import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { CheeseMesh } from "./cheeseMesh";
import {
  DESK,
  LAUNCH,
  MAX_SLICES,
  PHYS,
  SCREEN_CENTER_Y,
  WALL_Z,
} from "./config";
import { createDeskMaterial, createWallMaterial } from "./materials";
import { Monitor } from "./monitor";
import { CheeseSim, type SimEvent } from "./sim";
import { CheeseAudio } from "./audio";

/** Fixed simulation step: the solver's stiffness depends on it, so it never varies. */
const STEP = 1 / 60;
/** Area the camera must always show (monitor plus some desk), in metres. */
const FRAME = { width: 0.8, height: 0.62 };
const CAMERA_TARGET = new Vector3(0, SCREEN_CENTER_Y - 0.03, 0);
const CAMERA_DIRECTION = new Vector3(0, 0.13, 1).normalize();

export interface CheddarSceneOptions {
  /** Shown on the screen until an image is chosen; it is the page's visible title. */
  screenTitle: string;
  onCountChange: (count: number) => void;
}

/**
 * Owns the renderer, the scene and the loop. The Vue view only creates it, forwards the
 * buttons (image, clear) and disposes it.
 */
export class CheddarScene {
  /** Which backend WebGPURenderer picked: WebGPU, or its WebGL 2 fallback. */
  readonly backend: "WebGPU" | "WebGL 2";
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 0.05, 10);
  private readonly sim = new CheeseSim();
  private readonly cheese = new CheeseMesh(MAX_SLICES);
  private readonly monitor: Monitor;
  private readonly audio = new CheeseAudio();
  /** Time (s) of each slot's last peel sound. */
  private readonly lastPeel = new Float64Array(MAX_SLICES).fill(-Infinity);
  private readonly disposables: { dispose(): void }[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new Raycaster();
  private readonly aimPlane = new Plane(new Vector3(0, 0, 1), 0);
  private readonly pointer = new Vector2();
  private firing = false;
  private firingEnabled = true;
  private fireTimer = 0;
  private lastTime = -1;
  private accumulator = 0;
  private lastCount = -1;

  static async create(host: HTMLElement, options: CheddarSceneOptions) {
    const renderer = new WebGPURenderer({ antialias: true });
    await renderer.init();
    return new CheddarScene(host, renderer, options);
  }

  private constructor(
    private readonly host: HTMLElement,
    private readonly renderer: WebGPURenderer,
    private readonly options: CheddarSceneOptions,
  ) {
    const backend = renderer.backend as { isWebGPUBackend?: boolean };
    this.backend = backend.isWebGPUBackend ? "WebGPU" : "WebGL 2";

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);

    this.scene.background = new Color(0x161519);
    this.monitor = new Monitor(options.screenTitle);
    this.scene.add(this.monitor.group, this.cheese.mesh);
    this.addRoom();
    this.addLights();

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    renderer.setAnimationLoop(this.frame);
  }

  setScreenImage(file: Blob) {
    return this.monitor.setImage(file);
  }

  clear() {
    this.sim.clear();
    this.cheese.clear();
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted);
  }

  /** Blocks throwing (speedrun countdown). A burst in progress stops. */
  setFiringEnabled(enabled: boolean) {
    this.firingEnabled = enabled;
    if (!enabled) this.firing = false;
  }

  /** Slices thrown since the last clear(). */
  get thrown() {
    return this.sim.thrown;
  }

  /** Screen coverage, 0..1 (see CheeseSim.screenCoverage: not for every frame). */
  measureCoverage() {
    return this.sim.screenCoverage();
  }

  /** Call from a click handler: browsers only start audio inside a user gesture. */
  unlockAudio() {
    this.audio.unlock();
  }

  /** Speedrun signals: countdown tick, start, finish. */
  cue(kind: "tick" | "go" | "finish") {
    this.audio.cue(kind);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.resizeObserver.disconnect();
    this.audio.dispose();
    this.cheese.dispose();
    this.monitor.dispose();
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  private addRoom() {
    const deskGeometry = new BoxGeometry(
      DESK.halfWidth * 2,
      DESK.thickness,
      DESK.zFront - DESK.zBack,
    );
    const deskMaterial = createDeskMaterial();
    const desk = new Mesh(deskGeometry, deskMaterial);
    desk.position.set(
      0,
      DESK.y - DESK.thickness / 2,
      (DESK.zFront + DESK.zBack) / 2,
    );
    desk.receiveShadow = true;

    const wallGeometry = new PlaneGeometry(4, 3);
    const wallMaterial = createWallMaterial();
    const wall = new Mesh(wallGeometry, wallMaterial);
    wall.position.set(0, 1.2, WALL_Z);
    wall.receiveShadow = true;

    this.scene.add(desk, wall);
    this.disposables.push(
      deskGeometry,
      deskMaterial,
      wallGeometry,
      wallMaterial,
    );
  }

  private addLights() {
    this.scene.add(new HemisphereLight(0xdfe6ff, 0x3a2a1e, 1.1));
    const sun = new DirectionalLight(0xfff1dc, 2.6);
    sun.position.set(-0.7, 1.5, 1.2);
    sun.target.position.copy(CAMERA_TARGET);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.002;
    const cam = sun.shadow.camera;
    cam.left = -0.9;
    cam.right = 0.9;
    cam.top = 0.8;
    cam.bottom = -0.5;
    cam.near = 0.5;
    cam.far = 4;
    this.scene.add(sun, sun.target);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const tan = Math.tan(MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(
      FRAME.height / 2 / tan,
      FRAME.width / 2 / (tan * aspect),
    );
    this.camera.aspect = aspect;
    this.camera.position
      .copy(CAMERA_TARGET)
      .addScaledVector(CAMERA_DIRECTION, dist);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
  }

  private readonly frame = (timeMs: number) => {
    const now = timeMs / 1000;
    const dt = this.lastTime < 0 ? 0 : Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;

    if (this.firing) {
      this.fireTimer -= dt;
      while (this.fireTimer <= 0) {
        this.fire();
        this.fireTimer += LAUNCH.burstInterval;
      }
    }

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= STEP && steps < 3) {
      this.sim.step(STEP);
      this.accumulator -= STEP;
      steps++;
    }
    // Too slow to keep up: drop the backlog rather than spiral.
    if (steps === 3) this.accumulator = 0;

    for (const event of this.sim.events) this.playEvent(event);
    this.sim.events.length = 0;

    this.cheese.sync(this.sim);
    if (this.sim.aliveCount !== this.lastCount) {
      this.lastCount = this.sim.aliveCount;
      this.options.onCountChange(this.lastCount);
    }
    this.renderer.render(this.scene, this.camera);
  };

  /** Throws one slice from just below the viewer towards the point under the pointer. */
  private fire() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const target = new Vector3();
    if (!this.raycaster.ray.intersectPlane(this.aimPlane, target)) return;

    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const forward = this.camera.getWorldDirection(new Vector3());
    const origin = this.camera.position
      .clone()
      .addScaledVector(forward, 0.25)
      .addScaledVector(up, -0.2)
      .addScaledVector(right, MathUtils.randFloatSpread(0.24));

    // Ballistic aim: straight line to the target, plus what gravity takes away in flight.
    const delta = target.sub(origin);
    const flight = delta.length() / LAUNCH.speed;
    const velocity = delta.divideScalar(flight);
    velocity.y += 0.5 * PHYS.gravity * flight;

    // Facing the screen, random roll, some tilt; spin around its own normal, some tumble.
    const rotation = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      Math.random() * Math.PI * 2,
    );
    const tiltAxis = new Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      0,
    ).normalize();
    rotation.premultiply(
      new Quaternion().setFromAxisAngle(tiltAxis, Math.random() * LAUNCH.tilt),
    );
    const normal = new Vector3(0, 0, 1).applyQuaternion(rotation);
    const omega = new Vector3(
      MathUtils.randFloatSpread(2 * LAUNCH.tumble),
      MathUtils.randFloatSpread(2 * LAUNCH.tumble),
      0,
    ).addScaledVector(normal, MathUtils.randFloatSpread(2 * LAUNCH.spin));

    this.audio.whoosh(this.panOf(origin.x));
    this.sim.spawn(
      [origin.x, origin.y, origin.z],
      [velocity.x, velocity.y, velocity.z],
      [rotation.x, rotation.y, rotation.z, rotation.w],
      [omega.x, omega.y, omega.z],
      Math.random() * 100,
    );
  }

  /**
   * Simulation event -> sound. First contact, and a fallen slice's first touch of the desk,
   * splat (scaled by impact speed, so a slice sliding off gently just plops).
   * Everything else that sticks squishes (louder when fast): an impact crumples the slice,
   * bits peel and re-stick, and those must not all sound like new splats. Peels need enough
   * particles at once and are throttled per slice, or a crumpling slice crackles non-stop.
   */
  private playEvent(e: SimEvent) {
    const pan = this.panOf(e.x);
    if (e.kind === "peel") {
      if (e.count < 6 || this.lastTime - this.lastPeel[e.slot] < 0.6) return;
      this.lastPeel[e.slot] = this.lastTime;
      this.audio.peel(e.count / 40, pan);
    } else if (e.first) {
      this.audio.splat(e.speed / LAUNCH.speed, pan, e.desk);
    } else if (e.count >= 3) {
      this.audio.squish(e.count / 30 + e.speed / 10, pan);
    }
  }

  /** Stereo position from a world x: the monitor spans about [-0.8, 0.8]. */
  private panOf(x: number) {
    return Math.max(-1, Math.min(1, x / 0.35)) * 0.8;
  }

  private setPointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    // Browsers only allow audio to start inside a user gesture.
    this.audio.unlock();
    if (!this.firingEnabled) return;
    this.setPointer(e);
    this.firing = true;
    this.fire();
    this.fireTimer = LAUNCH.burstInterval;
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    this.setPointer(e);
  };

  private readonly onPointerUp = () => {
    this.firing = false;
  };
}
