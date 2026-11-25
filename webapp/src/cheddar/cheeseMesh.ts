import { BufferAttribute, BufferGeometry, Mesh } from "three/webgpu";
import { SLICE } from "./config";
import { createCheeseMaterial } from "./materials";
import { P, type CheeseSim } from "./sim";

const N = SLICE.grid;
/** Rendered half thickness, a bit thinner than the simulated one so stacked layers never touch. */
const HALF = (SLICE.thickness / 2) * 0.85;
/** Vertices per slice: top sheet then bottom sheet, the rim reuses their border. */
const V = 2 * P;

/**
 * Every slice in one geometry, so the whole cheese is one draw call. Each slot owns a fixed
 * block of vertices; dead slots are collapsed to the origin (degenerate triangles).
 * Only the slices the simulation marked dirty are rebuilt and uploaded.
 */
export class CheeseMesh {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly material = createCheeseMaterial();
  private readonly position: BufferAttribute;
  private readonly normal: BufferAttribute;
  private readonly seed: BufferAttribute;
  private readonly indicesPerSlice: number;

  constructor(maxSlices: number) {
    this.position = new BufferAttribute(new Float32Array(maxSlices * V * 3), 3);
    this.normal = new BufferAttribute(new Float32Array(maxSlices * V * 3), 3);
    this.seed = new BufferAttribute(new Float32Array(maxSlices * V), 1);
    const uvs = new Float32Array(maxSlices * V * 2);
    for (let s = 0; s < maxSlices; s++) {
      for (let v = 0; v < V; v++) {
        const i = v % P;
        uvs[(s * V + v) * 2] = (i % N) / (N - 1);
        uvs[(s * V + v) * 2 + 1] = Math.floor(i / N) / (N - 1);
      }
    }

    const local = sliceIndices();
    this.indicesPerSlice = local.length;
    const index = new Uint32Array(maxSlices * local.length);
    for (let s = 0; s < maxSlices; s++) {
      for (let k = 0; k < local.length; k++) {
        index[s * local.length + k] = s * V + local[k];
      }
    }

    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("normal", this.normal);
    this.geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    this.geometry.setAttribute("aSeed", this.seed);
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Slices fly everywhere: skip culling rather than recomputing bounds every frame.
    this.mesh.frustumCulled = false;
  }

  /** Copies the dirty slices from the simulation into the GPU buffers. */
  sync(sim: CheeseSim) {
    let lo = Infinity;
    let hi = -1;
    for (let s = 0; s < sim.highWater; s++) {
      if (!sim.dirty[s]) continue;
      sim.dirty[s] = 0;
      if (sim.alive[s]) this.writeSlice(sim, s);
      else this.collapseSlice(s);
      lo = Math.min(lo, s);
      hi = s;
    }
    this.geometry.setDrawRange(0, sim.highWater * this.indicesPerSlice);
    if (hi < 0) return;
    for (const [attr, size] of [
      [this.position, 3],
      [this.normal, 3],
      [this.seed, 1],
    ] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * V * size, (hi - lo + 1) * V * size);
      attr.needsUpdate = true;
    }
  }

  clear() {
    (this.position.array as Float32Array).fill(0);
    this.position.clearUpdateRanges();
    this.position.needsUpdate = true;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }

  private writeSlice(sim: CheeseSim, s: number) {
    const src = sim.pos;
    const pos = this.position.array as Float32Array;
    const nor = this.normal.array as Float32Array;
    const seed = this.seed.array as Float32Array;
    const base = s * P;
    const out = s * V;
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const i = row * N + col;
        // Central differences across the grid give a smooth surface normal.
        const l = (base + row * N + Math.max(col - 1, 0)) * 3;
        const r = (base + row * N + Math.min(col + 1, N - 1)) * 3;
        const d = (base + Math.max(row - 1, 0) * N + col) * 3;
        const u = (base + Math.min(row + 1, N - 1) * N + col) * 3;
        const ax = src[r] - src[l];
        const ay = src[r + 1] - src[l + 1];
        const az = src[r + 2] - src[l + 2];
        const bx = src[u] - src[d];
        const by = src[u + 1] - src[d + 1];
        const bz = src[u + 2] - src[d + 2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        const p3 = (base + i) * 3;
        const top = (out + i) * 3;
        const bottom = (out + P + i) * 3;
        pos[top] = src[p3] + nx * HALF;
        pos[top + 1] = src[p3 + 1] + ny * HALF;
        pos[top + 2] = src[p3 + 2] + nz * HALF;
        pos[bottom] = src[p3] - nx * HALF;
        pos[bottom + 1] = src[p3 + 1] - ny * HALF;
        pos[bottom + 2] = src[p3 + 2] - nz * HALF;
        nor[top] = nx;
        nor[top + 1] = ny;
        nor[top + 2] = nz;
        nor[bottom] = -nx;
        nor[bottom + 1] = -ny;
        nor[bottom + 2] = -nz;
      }
    }
    seed.fill(sim.seed[s], out, out + V);
  }

  private collapseSlice(s: number) {
    (this.position.array as Float32Array).fill(0, s * V * 3, (s + 1) * V * 3);
  }
}

/** Triangles of one slice: top sheet, bottom sheet, and the rim joining their borders. */
function sliceIndices(): number[] {
  const idx: number[] = [];
  for (let row = 0; row < N - 1; row++) {
    for (let col = 0; col < N - 1; col++) {
      const a = row * N + col;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
      idx.push(P + a, P + d, P + b, P + a, P + c, P + d);
    }
  }
  const ring: number[] = [];
  for (let col = 0; col < N - 1; col++) ring.push(col);
  for (let row = 0; row < N - 1; row++) ring.push(row * N + N - 1);
  for (let col = N - 1; col > 0; col--) ring.push((N - 1) * N + col);
  for (let row = N - 1; row > 0; row--) ring.push(row * N);
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    idx.push(a, b, P + b, a, P + b, P + a);
  }
  return idx;
}
