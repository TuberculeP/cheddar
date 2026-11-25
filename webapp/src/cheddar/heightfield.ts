/**
 * Cheese thickness laid on a flat surface, on a regular (u, v) grid.
 *
 * Slices do not collide with each other directly (too costly with hundreds of them): a slice
 * that has stuck writes its top into this grid, and later slices collide with "surface + height".
 *
 * A slice must only see cheese thrown before it: never its own, never a newer slice's.
 * - Seeing a newer slice: two slices landing together in a burst push each other on top,
 *   again and again, into an ever-growing tower.
 * - Seeing its own cheese: once a newer slice covers it, its still-free edge particles get
 *   lifted by its own layer, pull on its stuck ones and the whole slice peels off.
 *
 * Owners are spawn serials, which only grow. Each cell keeps a small stack sorted by owner:
 * the newest writer (h0, o0), the one before (h1, o1), and the height of everything older
 * (h2). Deeper interleavings fall back to the nearest level, which is rare: by the time two
 * newer slices cover a spot, the older one has long settled there.
 */
export class Heightfield {
  readonly nu: number;
  readonly nv: number;
  private readonly h0: Float32Array;
  private readonly h1: Float32Array;
  private readonly h2: Float32Array;
  private readonly o0: Int32Array;
  private readonly o1: Int32Array;

  constructor(
    readonly u0: number,
    readonly u1: number,
    readonly v0: number,
    readonly v1: number,
    readonly cell: number,
  ) {
    this.nu = Math.ceil((u1 - u0) / cell);
    this.nv = Math.ceil((v1 - v0) / cell);
    const n = this.nu * this.nv;
    this.h0 = new Float32Array(n);
    this.h1 = new Float32Array(n);
    this.h2 = new Float32Array(n);
    this.o0 = new Int32Array(n).fill(-1);
    this.o1 = new Int32Array(n).fill(-1);
  }

  /**
   * Height at (u, v) of the cheese older than slice `owner`, bilinearly interpolated between
   * cell centres (0 outside the grid). Interpolation turns the edge of a pile into a ramp:
   * a sharp cliff forces a slice draped across it to over-stretch, which peels it off.
   */
  sample(u: number, v: number, owner: number): number {
    const fu = (u - this.u0) / this.cell - 0.5;
    const fv = (v - this.v0) / this.cell - 0.5;
    const iu = Math.floor(fu);
    const iv = Math.floor(fv);
    const tu = fu - iu;
    const tv = fv - iv;
    const a = this.cellHeight(iu, iv, owner);
    const b = this.cellHeight(iu + 1, iv, owner);
    const c = this.cellHeight(iu, iv + 1, owner);
    const d = this.cellHeight(iu + 1, iv + 1, owner);
    return (a * (1 - tu) + b * tu) * (1 - tv) + (c * (1 - tu) + d * tu) * tv;
  }

  /** Raises every cell of the quad's bounding box to `top`, at slice `owner`'s level. */
  writeQuad(
    us: ArrayLike<number>,
    vs: ArrayLike<number>,
    top: number,
    owner: number,
  ) {
    const uMin = Math.min(us[0], us[1], us[2], us[3]);
    const uMax = Math.max(us[0], us[1], us[2], us[3]);
    const vMin = Math.min(vs[0], vs[1], vs[2], vs[3]);
    const vMax = Math.max(vs[0], vs[1], vs[2], vs[3]);
    const iu0 = Math.max(0, Math.floor((uMin - this.u0) / this.cell));
    const iu1 = Math.min(this.nu - 1, Math.floor((uMax - this.u0) / this.cell));
    const iv0 = Math.max(0, Math.floor((vMin - this.v0) / this.cell));
    const iv1 = Math.min(this.nv - 1, Math.floor((vMax - this.v0) / this.cell));
    for (let iv = iv0; iv <= iv1; iv++) {
      for (let iu = iu0; iu <= iu1; iu++) {
        this.writeCell(iv * this.nu + iu, top, owner);
      }
    }
  }

  clear() {
    this.h0.fill(0);
    this.h1.fill(0);
    this.h2.fill(0);
    this.o0.fill(-1);
    this.o1.fill(-1);
  }

  private cellHeight(iu: number, iv: number, owner: number) {
    if (iu < 0 || iv < 0 || iu >= this.nu || iv >= this.nv) return 0;
    const i = iv * this.nu + iu;
    if (this.o0[i] < owner) return this.h0[i];
    if (this.o1[i] < owner) return this.h1[i];
    return this.h2[i];
  }

  /** Inserts `top` at `owner`'s place in the cell's stack; every level above rises too. */
  private writeCell(i: number, top: number, owner: number) {
    const { h0, h1, h2, o0, o1 } = this;
    if (owner > o0[i]) {
      // Newest writer: push the stack down.
      h2[i] = h1[i];
      h1[i] = h0[i];
      o1[i] = o0[i];
      o0[i] = owner;
    } else if (owner < o0[i] && owner > o1[i]) {
      // Between the two tracked writers: becomes the second level.
      h2[i] = h1[i];
      o1[i] = owner;
      if (top > h1[i]) h1[i] = top;
    } else if (owner < o1[i]) {
      // Older than both: merged into the base.
      if (top > h2[i]) h2[i] = top;
      if (top > h1[i]) h1[i] = top;
    } else if (owner === o1[i]) {
      if (top > h1[i]) h1[i] = top;
    }
    if (top > h0[i]) h0[i] = top;
  }
}
