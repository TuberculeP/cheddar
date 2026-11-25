import {
  DESK,
  HEIGHTFIELD_CELL,
  MONITOR,
  SLICE,
  STAND,
  WALL_Z,
} from "./config";
import { Heightfield } from "./heightfield";

/** Result of a collision query, reused to avoid allocations in the hot loop. */
export interface Contact {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** Half the slice thickness: particles sit on the slice's mid-surface. */
const R = SLICE.thickness / 2;

/**
 * Static colliders (monitor, stand, desk, wall) plus the two cheese heightfields:
 * one on the monitor's front face (offset along +z), one on the desk (offset along +y).
 * Pure TypeScript, no three.js, so the simulation can later move to a compute shader.
 */
export class CheeseWorld {
  readonly front = new Heightfield(
    MONITOR.x0,
    MONITOR.x1,
    MONITOR.y0,
    MONITOR.y1,
    HEIGHTFIELD_CELL,
  );
  readonly desk = new Heightfield(-0.8, 0.8, -0.35, 0.6, HEIGHTFIELD_CELL);

  /**
   * Pushes (x, y, z) out of every collider it penetrates. Returns true on contact;
   * `out` then holds the corrected position and the normal of the last surface touched.
   */
  collide(
    x: number,
    y: number,
    z: number,
    owner: number,
    out: Contact,
  ): boolean {
    let hit = false;
    out.x = x;
    out.y = y;
    out.z = z;

    if (out.z < WALL_Z + R && out.y > DESK.y) {
      out.z = WALL_Z + R;
      setNormal(out, 0, 0, 1);
      hit = true;
    }

    const frontZ = MONITOR.z1 + this.front.sample(out.x, out.y, owner);
    if (boxContact(MONITOR, frontZ, out)) hit = true;
    if (boxContact(STAND.neck, STAND.neck.z1, out)) hit = true;
    if (boxContact(STAND.base, STAND.base.z1, out)) hit = true;

    if (
      Math.abs(out.x) <= DESK.halfWidth &&
      out.z >= DESK.zBack &&
      out.z <= DESK.zFront
    ) {
      const top = DESK.y + this.desk.sample(out.x, out.z, owner);
      if (out.y < top + R && out.y > DESK.y - 0.06) {
        out.y = top + R;
        setNormal(out, 0, 1, 0);
        hit = true;
      }
    }
    return hit;
  }

  clear() {
    this.front.clear();
    this.desk.clear();
  }
}

function setNormal(c: Contact, nx: number, ny: number, nz: number) {
  c.nx = nx;
  c.ny = ny;
  c.nz = nz;
}

/** Pushes `c` out of the box along the axis of least penetration. */
function boxContact(b: Box, frontZ: number, c: Contact): boolean {
  if (
    c.x < b.x0 - R ||
    c.x > b.x1 + R ||
    c.y < b.y0 - R ||
    c.y > b.y1 + R ||
    c.z < b.z0 - R ||
    c.z > frontZ + R
  ) {
    return false;
  }
  const front = frontZ + R - c.z;
  const back = c.z - (b.z0 - R);
  const top = b.y1 + R - c.y;
  const bottom = c.y - (b.y0 - R);
  const right = b.x1 + R - c.x;
  const left = c.x - (b.x0 - R);
  const min = Math.min(front, back, top, bottom, right, left);
  if (min === front) {
    c.z = frontZ + R;
    setNormal(c, 0, 0, 1);
  } else if (min === top) {
    c.y = b.y1 + R;
    setNormal(c, 0, 1, 0);
  } else if (min === right) {
    c.x = b.x1 + R;
    setNormal(c, 1, 0, 0);
  } else if (min === left) {
    c.x = b.x0 - R;
    setNormal(c, -1, 0, 0);
  } else if (min === bottom) {
    c.y = b.y0 - R;
    setNormal(c, 0, -1, 0);
  } else {
    c.z = b.z0 - R;
    setNormal(c, 0, 0, -1);
  }
  return true;
}
