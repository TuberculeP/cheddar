import {
  DESK,
  MAX_SLICES,
  PHYS,
  SCREEN,
  SCREEN_CENTER_Y,
  SLICE,
  SPEEDRUN,
} from "./config";
import { CheeseWorld, type Contact } from "./world";

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/**
 * What happened to one slice during one step, for sound effects. At most one event of each
 * kind per slice per step: a slice hitting the screen gives one big "stick", then a few
 * small ones as its edges flop on.
 */
export interface SimEvent {
  kind: "stick" | "peel";
  /** Slot of the slice, so the consumer can throttle per slice. */
  slot: number;
  /** Particles that stuck / came off during the step (out of P). */
  count: number;
  /** Fastest impact speed along the surface normal, m/s (0 for "peel"). */
  speed: number;
  /** Mean x of those particles, for stereo panning. */
  x: number;
  /** Landed on the desk rather than on the monitor or the wall. */
  desk: boolean;
  /** First touch of this slice, or its first touch of the desk: worth a splat. */
  first: boolean;
}

const N = SLICE.grid;
/** Particles per slice. */
export const P = N * N;
/** Quads per slice. */
const Q = (N - 1) * (N - 1);
const R = SLICE.thickness / 2;
/** How deep a creeping anchor probes for the surface: half a slice plus two layers. */
const PROBE = R + 2 * SLICE.thickness;

/** Constraint kinds, each with its own stiffness. */
const STRETCH = 0;
const SHEAR = 1;
const BEND = 2;

/**
 * Cheese slices as particle grids, solved with position-based dynamics (Verlet integration,
 * one Gauss-Seidel pass per substep).
 *
 * All slices live in flat typed arrays indexed by slot (struct of arrays), so this file maps
 * almost one to one onto GPU storage buffers if it ever moves to a TSL compute shader.
 *
 * Adhesion: a particle that touches a surface is pinned to an anchor. The pull of its
 * neighbours on the pin is measured (reaction of the constraints, low-pass filtered):
 * a pull away from the surface peels it, a pull along the surface makes the anchor creep.
 */
export class CheeseSim {
  readonly world = new CheeseWorld();
  readonly maxSlices = MAX_SLICES;
  readonly particleMass =
    (SLICE.density * SLICE.size * SLICE.size * SLICE.thickness) / P;

  // Per particle (index = slot * P + i)
  readonly pos = new Float32Array(MAX_SLICES * P * 3);
  private readonly prev = new Float32Array(MAX_SLICES * P * 3);
  private readonly anchor = new Float32Array(MAX_SLICES * P * 3);
  private readonly normal = new Float32Array(MAX_SLICES * P * 3);
  private readonly force = new Float32Array(MAX_SLICES * P * 3);
  private readonly cooldown = new Float32Array(MAX_SLICES * P);
  private readonly stuck = new Uint8Array(MAX_SLICES * P);

  // Per slice
  readonly alive = new Uint8Array(MAX_SLICES);
  private readonly awake = new Uint8Array(MAX_SLICES);
  private readonly stillTime = new Float32Array(MAX_SLICES);
  private readonly awakeTime = new Float32Array(MAX_SLICES);
  /** Unique id per spawn (slots are recycled, heightfield owners must not be). */
  private readonly serial = new Int32Array(MAX_SLICES);
  readonly seed = new Float32Array(MAX_SLICES);
  /** Set when a slice moved; the renderer clears it after uploading the slice. */
  readonly dirty = new Uint8Array(MAX_SLICES);
  private readonly quadDone = new Uint8Array(MAX_SLICES * Q);
  /** Bit 1: the slice has touched something. Bit 2: it has touched the desk. */
  private readonly landed = new Uint8Array(MAX_SLICES);

  // Constraint topology, shared by every slice; rest lengths are per slice (plasticity).
  private readonly ca: Uint16Array;
  private readonly cb: Uint16Array;
  private readonly kind: Uint8Array;
  private readonly rest0: Float32Array;
  private readonly rest: Float32Array;
  private readonly cCount: number;

  private readonly pull = new Float32Array(P * 3);
  private readonly contact: Contact = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
  private readonly quadU = new Float32Array(4);
  private readonly quadV = new Float32Array(4);
  private nextSlot = 0;
  private nextSerial = 0;
  /** Highest slot ever used + 1, for the renderer's draw range. */
  highWater = 0;
  aliveCount = 0;
  awakeCount = 0;
  /** Filled by step(); the consumer empties it (events.length = 0) after reading. */
  readonly events: SimEvent[] = [];
  /** Slices spawned since the last clear(). */
  thrown = 0;

  // Screen coverage sampling grid (see screenCoverage)
  private readonly coverX0 = -SCREEN.width / 2;
  private readonly coverY0 = SCREEN_CENTER_Y - SCREEN.height / 2;
  private readonly coverNx = Math.round(SCREEN.width / SPEEDRUN.cell);
  private readonly coverNy = Math.round(SCREEN.height / SPEEDRUN.cell);
  private readonly coverMask = new Uint8Array(this.coverNx * this.coverNy);

  constructor() {
    const a: number[] = [];
    const b: number[] = [];
    const k: number[] = [];
    const r: number[] = [];
    const s = SLICE.size / (N - 1);
    const add = (i: number, j: number, kindOf: number, len: number) => {
      a.push(i);
      b.push(j);
      k.push(kindOf);
      r.push(len);
    };
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const i = row * N + col;
        if (col + 1 < N) add(i, i + 1, STRETCH, s);
        if (row + 1 < N) add(i, i + N, STRETCH, s);
        if (col + 1 < N && row + 1 < N) {
          add(i, i + N + 1, SHEAR, s * Math.SQRT2);
          add(i + 1, i + N, SHEAR, s * Math.SQRT2);
        }
        if (col + 2 < N) add(i, i + 2, BEND, 2 * s);
        if (row + 2 < N) add(i, i + 2 * N, BEND, 2 * s);
      }
    }
    this.ca = Uint16Array.from(a);
    this.cb = Uint16Array.from(b);
    this.kind = Uint8Array.from(k);
    this.rest0 = Float32Array.from(r);
    this.cCount = a.length;
    this.rest = new Float32Array(MAX_SLICES * this.cCount);
  }

  /**
   * Throws a new slice. `rotation` orients the flat slice (built in the local XY plane),
   * `omega` is its angular velocity. When every slot is used, the oldest slice is recycled.
   */
  spawn(
    origin: Vec3,
    velocity: Vec3,
    rotation: Quat,
    omega: Vec3,
    seed: number,
  ) {
    const slot = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % MAX_SLICES;
    this.thrown++;
    if (!this.alive[slot]) this.aliveCount++;
    if (!this.awake[slot]) this.awakeCount++;
    this.alive[slot] = 1;
    this.awake[slot] = 1;
    this.stillTime[slot] = 0;
    this.awakeTime[slot] = 0;
    this.serial[slot] = this.nextSerial++;
    this.seed[slot] = seed;
    this.landed[slot] = 0;
    this.dirty[slot] = 1;
    this.highWater = Math.max(this.highWater, slot + 1);
    this.quadDone.fill(0, slot * Q, (slot + 1) * Q);
    this.rest.set(this.rest0, slot * this.cCount);

    const h = 1 / 60 / PHYS.substeps;
    const half = SLICE.size / 2;
    for (let i = 0; i < P; i++) {
      const lx = ((i % N) / (N - 1)) * SLICE.size - half;
      const ly = (Math.floor(i / N) / (N - 1)) * SLICE.size - half;
      const [rx, ry, rz] = rotate(rotation, lx, ly, 0);
      // velocity of the point = linear + omega x r
      const vx = velocity[0] + omega[1] * rz - omega[2] * ry;
      const vy = velocity[1] + omega[2] * rx - omega[0] * rz;
      const vz = velocity[2] + omega[0] * ry - omega[1] * rx;
      const p = slot * P + i;
      const p3 = p * 3;
      this.pos[p3] = origin[0] + rx;
      this.pos[p3 + 1] = origin[1] + ry;
      this.pos[p3 + 2] = origin[2] + rz;
      this.prev[p3] = this.pos[p3] - vx * h;
      this.prev[p3 + 1] = this.pos[p3 + 1] - vy * h;
      this.prev[p3 + 2] = this.pos[p3 + 2] - vz * h;
      this.stuck[p] = 0;
      this.cooldown[p] = 0;
      this.force[p3] = this.force[p3 + 1] = this.force[p3 + 2] = 0;
    }
  }

  /** Advances every awake slice by `dt` seconds. */
  step(dt: number) {
    for (let s = 0; s < this.highWater; s++) {
      if (this.alive[s] && this.awake[s]) this.stepSlice(s, dt);
    }
  }

  /** Removes every slice. The renderer must drop its geometry too (CheeseMesh.clear). */
  clear() {
    this.alive.fill(0);
    this.awake.fill(0);
    this.dirty.fill(0);
    this.aliveCount = 0;
    this.awakeCount = 0;
    this.nextSlot = 0;
    this.highWater = 0;
    this.thrown = 0;
    this.events.length = 0;
    this.world.clear();
  }

  private stepSlice(s: number, dt: number) {
    const pos = this.pos;
    const prev = this.prev;
    const anchor = this.anchor;
    const normal = this.normal;
    const force = this.force;
    const stuck = this.stuck;
    const pull = this.pull;
    const c = this.contact;
    const owner = this.serial[s];
    const base = s * P;
    const rb = s * this.cCount;
    const h = dt / PHYS.substeps;
    const damp = Math.exp(-PHYS.airDrag * h);
    const gStep = PHYS.gravity * h * h;
    const m = this.particleMass;
    const toForce = m / (h * h);
    const smooth = 1 - Math.exp(-h / PHYS.forceSmoothing);
    const plastic = PHYS.plasticity * h;
    const stiffness = [
      PHYS.stretchStiffness,
      PHYS.shearStiffness,
      PHYS.bendStiffness,
    ];
    /** Largest squared displacement of a particle or anchor in one substep. */
    let moved2 = 0;
    // Sound event tallies for this step
    let stuckNow = 0;
    let stuckX = 0;
    let stuckDesk = 0;
    let impact = 0;
    let peeled = 0;
    let peelX = 0;

    for (let sub = 0; sub < PHYS.substeps; sub++) {
      // 1. Integrate free particles
      for (let i = 0; i < P; i++) {
        const p = base + i;
        if (stuck[p]) continue;
        const p3 = p * 3;
        const vx = (pos[p3] - prev[p3]) * damp;
        const vy = (pos[p3 + 1] - prev[p3 + 1]) * damp;
        const vz = (pos[p3 + 2] - prev[p3 + 2]) * damp;
        prev[p3] = pos[p3];
        prev[p3 + 1] = pos[p3 + 1];
        prev[p3 + 2] = pos[p3 + 2];
        pos[p3] += vx;
        pos[p3 + 1] += vy - gStep;
        pos[p3 + 2] += vz;
        this.cooldown[p] -= h;
      }

      // 2. Constraints. Pinned particles have zero inverse mass; the correction their
      //    neighbour receives is the reaction the pin has to hold.
      pull.fill(0);
      for (let k = 0; k < this.cCount; k++) {
        const i = this.ca[k];
        const j = this.cb[k];
        const pi = base + i;
        const pj = base + j;
        const wi = stuck[pi] ? 0 : 1;
        const wj = stuck[pj] ? 0 : 1;
        if (wi + wj === 0) continue;
        const i3 = pi * 3;
        const j3 = pj * 3;
        const dx = pos[j3] - pos[i3];
        const dy = pos[j3 + 1] - pos[i3 + 1];
        const dz = pos[j3 + 2] - pos[i3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const kind = this.kind[k];
        const err = len - this.rest[rb + k];
        const f = (stiffness[kind] * err) / ((wi + wj) * len);
        const cx = dx * f;
        const cy = dy * f;
        const cz = dz * f;
        if (wi) {
          pos[i3] += cx;
          pos[i3 + 1] += cy;
          pos[i3 + 2] += cz;
        } else {
          pull[i * 3] += cx;
          pull[i * 3 + 1] += cy;
          pull[i * 3 + 2] += cz;
        }
        if (wj) {
          pos[j3] -= cx;
          pos[j3 + 1] -= cy;
          pos[j3 + 2] -= cz;
        } else {
          pull[j * 3] -= cx;
          pull[j * 3 + 1] -= cy;
          pull[j * 3 + 2] -= cz;
        }
        const r0 = this.rest0[k];
        const restK = this.rest[rb + k];
        const dev = len - restK;
        if (kind === STRETCH) {
          // Cheese stretches and thins rather than holding a step at full tension:
          // without this, a slice draped over the edge of a pile peels itself off.
          if (dev > PHYS.stretchYield * r0) {
            this.rest[rb + k] = Math.min(
              r0 * PHYS.maxStretch,
              restK + dev * plastic,
            );
          }
        } else if (Math.abs(dev) > PHYS.plasticYield * r0) {
          const r = restK + dev * plastic;
          this.rest[rb + k] = Math.min(r0, Math.max(0.05 * r0, r));
        }
      }

      // 3. Collisions, adhesion, peeling and creep
      for (let i = 0; i < P; i++) {
        const p = base + i;
        const p3 = p * 3;
        if (stuck[p]) {
          const fx = pull[i * 3] * toForce;
          const fy = pull[i * 3 + 1] * toForce - m * PHYS.gravity;
          const fz = pull[i * 3 + 2] * toForce;
          force[p3] += (fx - force[p3]) * smooth;
          force[p3 + 1] += (fy - force[p3 + 1]) * smooth;
          force[p3 + 2] += (fz - force[p3 + 2]) * smooth;
          const nx = normal[p3];
          const ny = normal[p3 + 1];
          const nz = normal[p3 + 2];
          const fn = force[p3] * nx + force[p3 + 1] * ny + force[p3 + 2] * nz;
          if (fn > PHYS.peelForce) {
            this.unstick(p);
            peeled++;
            peelX += pos[p3];
            continue;
          }
          const tx = force[p3] - fn * nx;
          const ty = force[p3 + 1] - fn * ny;
          const tz = force[p3 + 2] - fn * nz;
          const ft = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (ft > PHYS.slideForce) {
            const speed = Math.min(
              (ft - PHYS.slideForce) * PHYS.creepRate,
              PHYS.maxCreep,
            );
            const d = (speed * h) / ft;
            // Probe inside the surface, then let the colliders put it back on top: the anchor
            // follows the surface, and leaves it past an edge. The probe must reach deeper than
            // a couple of cheese layers, or creeping off the edge of an older slice (a step
            // down) finds nothing and peels the whole slice.
            const hit = this.world.collide(
              anchor[p3] + tx * d - nx * PROBE,
              anchor[p3 + 1] + ty * d - ny * PROBE,
              anchor[p3 + 2] + tz * d - nz * PROBE,
              owner,
              c,
            );
            if (!hit || c.nx * nx + c.ny * ny + c.nz * nz < 0.5) {
              this.unstick(p);
              peeled++;
              peelX += pos[p3];
              continue;
            }
            // Only real motion keeps the slice awake: a creep blocked by a collider does not.
            const mx = c.x - anchor[p3];
            const my = c.y - anchor[p3 + 1];
            const mz = c.z - anchor[p3 + 2];
            moved2 = Math.max(moved2, mx * mx + my * my + mz * mz);
            anchor[p3] = c.x;
            anchor[p3 + 1] = c.y;
            anchor[p3 + 2] = c.z;
          }
          pos[p3] = prev[p3] = anchor[p3];
          pos[p3 + 1] = prev[p3 + 1] = anchor[p3 + 1];
          pos[p3 + 2] = prev[p3 + 2] = anchor[p3 + 2];
          continue;
        }

        if (this.world.collide(pos[p3], pos[p3 + 1], pos[p3 + 2], owner, c)) {
          // Speed into the surface, measured before the contact rewrites the position.
          const into =
            -(
              (pos[p3] - prev[p3]) * c.nx +
              (pos[p3 + 1] - prev[p3 + 1]) * c.ny +
              (pos[p3 + 2] - prev[p3 + 2]) * c.nz
            ) / h;
          pos[p3] = c.x;
          pos[p3 + 1] = c.y;
          pos[p3 + 2] = c.z;
          if (this.cooldown[p] <= 0) {
            stuckNow++;
            stuckX += c.x;
            if (c.ny > 0.9 && c.y < DESK.y + 0.05) stuckDesk++;
            impact = Math.max(impact, into);
            stuck[p] = 1;
            anchor[p3] = prev[p3] = c.x;
            anchor[p3 + 1] = prev[p3 + 1] = c.y;
            anchor[p3 + 2] = prev[p3 + 2] = c.z;
            normal[p3] = c.nx;
            normal[p3 + 1] = c.ny;
            normal[p3 + 2] = c.nz;
            force[p3] = force[p3 + 1] = force[p3 + 2] = 0;
          } else {
            // Sliding contact: drop the inward velocity, brake the tangential one.
            const vx = pos[p3] - prev[p3];
            const vy = pos[p3 + 1] - prev[p3 + 1];
            const vz = pos[p3 + 2] - prev[p3 + 2];
            const vn = vx * c.nx + vy * c.ny + vz * c.nz;
            const keep = 1 - PHYS.friction;
            const tvx = (vx - vn * c.nx) * keep;
            const tvy = (vy - vn * c.ny) * keep;
            const tvz = (vz - vn * c.nz) * keep;
            const out = Math.max(vn, 0);
            prev[p3] = pos[p3] - tvx - out * c.nx;
            prev[p3 + 1] = pos[p3 + 1] - tvy - out * c.ny;
            prev[p3 + 2] = pos[p3 + 2] - tvz - out * c.nz;
          }
        }

        if (sub === PHYS.substeps - 1) {
          const vx = pos[p3] - prev[p3];
          const vy = pos[p3 + 1] - prev[p3 + 1];
          const vz = pos[p3 + 2] - prev[p3 + 2];
          moved2 = Math.max(moved2, vx * vx + vy * vy + vz * vz);
        }
      }
    }

    this.dirty[s] = 1;
    this.writeHeightfields(s);

    if (stuckNow > 0) {
      const desk = stuckDesk * 2 > stuckNow;
      const bit = desk ? 2 : 1;
      this.events.push({
        kind: "stick",
        slot: s,
        count: stuckNow,
        speed: impact,
        x: stuckX / stuckNow,
        desk,
        first: (this.landed[s] & bit) === 0,
      });
      this.landed[s] |= 1 | (desk ? 2 : 0);
    }
    if (peeled > 0) {
      this.events.push({
        kind: "peel",
        slot: s,
        count: peeled,
        speed: 0,
        x: peelX / peeled,
        desk: false,
        first: false,
      });
    }

    // Fell off the desk: gone.
    if (pos[(base + (P >> 1)) * 3 + 1] < DESK.y - 1.5) {
      this.alive[s] = 0;
      this.awake[s] = 0;
      this.aliveCount--;
      this.awakeCount--;
      return;
    }

    // Sleep once still for a while; a sleeping slice costs nothing.
    const speed = Math.sqrt(moved2) / h;
    this.awakeTime[s] += dt;
    if (speed < PHYS.sleepSpeed) this.stillTime[s] += dt;
    else this.stillTime[s] = 0;
    if (
      this.stillTime[s] > PHYS.sleepTime ||
      this.awakeTime[s] > PHYS.maxAwakeTime
    ) {
      this.awake[s] = 0;
      this.awakeCount--;
    }
  }

  /**
   * Fraction of the screen (bezel excluded) hidden by cheese, from 0 to 1, as the camera
   * sees it: every quad lying in front of the screen (within SPEEDRUN.maskDepth) is projected
   * onto the screen plane, whether it touches the glass, sits on other slices, bridges a hole
   * or hangs as a flap. A flap seen edge-on projects to almost nothing, a flat bridge masks
   * its whole area. Only slices attached somewhere count (at least one stuck particle):
   * a slice flying or falling past the last hole must not end a speedrun.
   *
   * Recomputed from scratch on each call, so cheese that slid off frees its area again.
   * Cost: a few hundred thousand point tests with the screen full, so call it a few times
   * per second, not every frame.
   */
  screenCoverage(): number {
    const mask = this.coverMask;
    const nx = this.coverNx;
    const ny = this.coverNy;
    const cell = SPEEDRUN.cell;
    const pos = this.pos;
    mask.fill(0);
    let covered = 0;
    for (let s = 0; s < this.highWater; s++) {
      if (!this.alive[s]) continue;
      const base = s * P;
      if (this.stuck.subarray(base, base + P).indexOf(1) < 0) continue;
      for (let row = 0; row < N - 1; row++) {
        for (let col = 0; col < N - 1; col++) {
          const a = base + row * N + col;
          const b = a + 1;
          const c = a + N;
          const d = c + 1;
          if (!this.inFront(a) || !this.inFront(b)) continue;
          if (!this.inFront(c) || !this.inFront(d)) continue;
          const ax = pos[a * 3];
          const ay = pos[a * 3 + 1];
          const bx = pos[b * 3];
          const by = pos[b * 3 + 1];
          const cx = pos[c * 3];
          const cy = pos[c * 3 + 1];
          const dx = pos[d * 3];
          const dy = pos[d * 3 + 1];
          // Grid points (cell centres) inside the quad's bounding box
          const u0 = (Math.min(ax, bx, cx, dx) - this.coverX0) / cell - 0.5;
          const u1 = (Math.max(ax, bx, cx, dx) - this.coverX0) / cell - 0.5;
          const v0 = (Math.min(ay, by, cy, dy) - this.coverY0) / cell - 0.5;
          const v1 = (Math.max(ay, by, cy, dy) - this.coverY0) / cell - 0.5;
          const i0 = Math.max(0, Math.ceil(u0));
          const i1 = Math.min(nx - 1, Math.floor(u1));
          const j0 = Math.max(0, Math.ceil(v0));
          const j1 = Math.min(ny - 1, Math.floor(v1));
          for (let j = j0; j <= j1; j++) {
            const py = this.coverY0 + (j + 0.5) * cell;
            for (let i = i0; i <= i1; i++) {
              const k = j * nx + i;
              if (mask[k]) continue;
              const px = this.coverX0 + (i + 0.5) * cell;
              // Same split as the rendered quad: triangles (a, b, d) and (a, d, c).
              if (
                inTriangle(px, py, ax, ay, bx, by, dx, dy) ||
                inTriangle(px, py, ax, ay, dx, dy, cx, cy)
              ) {
                mask[k] = 1;
                covered++;
              }
            }
          }
        }
      }
    }
    return covered / (nx * ny);
  }

  /** In the slab just in front of the monitor's front face. */
  private inFront(p: number) {
    const z = this.pos[p * 3 + 2];
    return z >= 0 && z <= SPEEDRUN.maskDepth;
  }

  private unstick(p: number) {
    const p3 = p * 3;
    this.stuck[p] = 0;
    this.cooldown[p] = PHYS.restickDelay;
    this.prev[p3] = this.pos[p3];
    this.prev[p3 + 1] = this.pos[p3 + 1];
    this.prev[p3 + 2] = this.pos[p3 + 2];
  }

  /** Quads whose four corners are stuck on the screen or the desk become a layer there. */
  private writeHeightfields(s: number) {
    const base = s * P;
    const owner = this.serial[s];
    const u = this.quadU;
    const v = this.quadV;
    for (let row = 0; row < N - 1; row++) {
      for (let col = 0; col < N - 1; col++) {
        const q = s * Q + row * (N - 1) + col;
        if (this.quadDone[q]) continue;
        const a = base + row * N + col;
        const corners = [a, a + 1, a + N, a + N + 1];
        if (!corners.every((p) => this.stuck[p])) continue;
        const onFront = corners.every((p) => this.normal[p * 3 + 2] > 0.9);
        const onDesk = corners.every(
          (p) =>
            this.normal[p * 3 + 1] > 0.9 && this.pos[p * 3 + 1] < DESK.y + 0.05,
        );
        if (!onFront && !onDesk) continue;
        let top = -Infinity;
        corners.forEach((p, n) => {
          const p3 = p * 3;
          u[n] = this.pos[p3];
          v[n] = onFront ? this.pos[p3 + 1] : this.pos[p3 + 2];
          top = Math.max(top, onFront ? this.pos[p3 + 2] : this.pos[p3 + 1]);
        });
        if (onFront) this.world.front.writeQuad(u, v, top + R, owner);
        else this.world.desk.writeQuad(u, v, top + R - DESK.y, owner);
        this.quadDone[q] = 1;
      }
    }
  }
}

/** Point-in-triangle test in 2D, either winding. */
function inTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Rotates (x, y, z) by the unit quaternion q. */
function rotate(q: Quat, x: number, y: number, z: number): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}
