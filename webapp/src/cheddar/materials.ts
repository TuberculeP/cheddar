import {
  DoubleSide,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  color,
  float,
  min,
  mix,
  mx_noise_float,
  positionWorld,
  smoothstep,
  uv,
  vec3,
} from "three/tsl";

/**
 * Cheddar in TSL: orange with soft blotches, a slightly darker and drier rim, tiny pale
 * crystals, and an oily sheen (clearcoat + sheen). `aSeed` (one value per slice) shifts
 * the noise so no two slices look alike.
 */
export function createCheeseMaterial() {
  const material = new MeshPhysicalNodeMaterial({ side: DoubleSide });
  const seed = attribute("aSeed", "float");
  const st = uv();

  const blotch = mx_noise_float(vec3(st.mul(5), seed.mul(13)))
    .mul(0.5)
    .add(0.5);
  const crystals = smoothstep(
    0.6,
    0.75,
    mx_noise_float(vec3(st.mul(70), seed.mul(7))),
  );
  // Distance to the slice border in UV space: 0 on the rim, 0.5 in the middle.
  const border = min(min(st.x, st.x.oneMinus()), min(st.y, st.y.oneMinus()));
  const inner = smoothstep(0, 0.06, border);

  const body = mix(color(0xd8741a), color(0xf4a334), blotch);
  const withRim = mix(color(0xa9560f), body, inner.mul(0.4).add(0.6));
  material.colorNode = withRim.add(crystals.mul(0.07));
  material.roughnessNode = mix(float(0.6), float(0.32), blotch);
  material.clearcoat = 0.2;
  material.clearcoatRoughness = 0.4;
  material.sheen = 0.5;
  material.sheenRoughness = 0.6;
  material.sheenColor.setHex(0xffc56b);
  return material;
}

/** Desk top: two browns streaked along x by stretched noise. */
export function createDeskMaterial() {
  const material = new MeshStandardNodeMaterial();
  const grain = mx_noise_float(
    vec3(positionWorld.x.mul(2.5), positionWorld.z.mul(45), 0),
  )
    .mul(0.5)
    .add(0.5);
  const fine = mx_noise_float(
    vec3(positionWorld.x.mul(30), positionWorld.z.mul(300), 3),
  ).mul(0.04);
  material.colorNode = mix(color(0x5a3a22), color(0x7b5333), grain).add(fine);
  material.roughnessNode = mix(float(0.75), float(0.55), grain);
  return material;
}

export function createWallMaterial() {
  return new MeshStandardNodeMaterial({ color: 0x2b2a2e, roughness: 0.95 });
}

export function createPlasticMaterial(hex: number, roughness: number) {
  return new MeshStandardNodeMaterial({ color: hex, roughness });
}
