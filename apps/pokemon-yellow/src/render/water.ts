/** Palette-aware diorama water. A fragment effect in the map's existing batch:
 * no reflection targets, transparent sorting, extra textures or draw calls.
 */
import * as THREE from 'three';
import type { TilesetData } from '../data/schema';
import type { TileAtlas } from './textures';

export const WATER_LEVEL = -0.18;
const DEPTH_RANGE = 2;

/** Simulation-driven time: pauses with the game, freezes under reduced motion.
 * The origin keeps wave phase continuous when connected maps change coordinates.
 */
export class WaterMotion {
  readonly time = { value: 0 };
  readonly origin = { value: new THREE.Vector2() };

  advance(frames: number, reducedMotion: boolean): void {
    if (!reducedMotion && Number.isFinite(frames) && frames > 0) this.time.value += frames / 59.73;
  }

  relocate(shift?: { dx: number; dy: number }): void {
    if (shift) this.origin.value.sub(new THREE.Vector2(shift.dx, shift.dy));
    else this.origin.value.set(0, 0);
  }
}

/** Distance to the actual 8px shoreline, independent of render regions/skips.
 * Sample a padded occupancy mask once; neighbouring cells share exact depths.
 * Empty space beyond the requested region is never invented as a coastline.
 */
export function buildShoreField(
  bounds: [number, number, number, number],
  waterAt: (tx: number, ty: number) => boolean,
): (x: number, z: number) => number {
  const pad = DEPTH_RANGE * 2 + 1;
  const x0 = bounds[0] * 2 - pad, z0 = bounds[1] * 2 - pad;
  const width = (bounds[2] - bounds[0]) * 2 + pad * 2 + 1;
  const height = (bounds[3] - bounds[1]) * 2 + pad * 2 + 1;
  const water = new Uint8Array(width * height);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++)
    water[z * width + x] = waterAt(x + x0, z + z0) ? 1 : 0;
  const cache = new Map<string, number>();
  return (x, z) => {
    const key = `${x},${z}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let distance = DEPTH_RANGE;
    for (let ty = Math.floor((z - DEPTH_RANGE) * 2); ty <= Math.floor((z + DEPTH_RANGE) * 2); ty++)
      for (let tx = Math.floor((x - DEPTH_RANGE) * 2); tx <= Math.floor((x + DEPTH_RANGE) * 2); tx++) {
        const i = tx - x0, j = ty - z0;
        if (i < 0 || j < 0 || i >= width || j >= height || water[j * width + i]) continue;
        const dx = Math.max(tx / 2 - x, 0, x - (tx + 1) / 2);
        const dz = Math.max(ty / 2 - z, 0, z - (ty + 1) / 2);
        distance = Math.min(distance, Math.hypot(dx, dz));
      }
    cache.set(key, distance);
    return distance;
  };
}

/** UVs of stable ROM palette pixels. Never sample the shifting water/flower
 * illustration: animations must not change a uniform's intended colour.
 */
export function waterPaletteUV(ts: TilesetData, atlas: TileAtlas, shade: number): THREE.Vector2 {
  for (let tile = 0; tile < ts.tileCount; tile++) {
    if (tile === 0x14 || tile === 0x03) continue;
    const pixel = ts.tilePixels.slice(tile * 64, tile * 64 + 64).indexOf(shade);
    if (pixel < 0) continue;
    const [u0, v0, u1, v1] = atlas.uv(tile);
    return new THREE.Vector2(u0 + (u1 - u0) * ((pixel % 8) + 0.5) / 8,
      v1 - (v1 - v0) * (Math.floor(pixel / 8) + 0.5) / 8);
  }
  const [u0, v0, u1, v1] = atlas.uv(0);
  return new THREE.Vector2((u0 + u1) / 2, (v0 + v1) / 2);
}

/** Chain after installCutaway, whose vWorldPos includes connected-map offsets
 * and sliding cutscene meshes. Palette samples come from the recoloured atlas,
 * so full black/white fades and all colour filters work without special cases.
 */
export function installWater(
  material: THREE.MeshBasicMaterial,
  ts: TilesetData,
  atlas: TileAtlas,
  motion: WaterMotion,
): void {
  const previous = material.onBeforeCompile;
  const uniforms = {
    uWaterTime: motion.time,
    uWaterOrigin: motion.origin,
    uWaterLight: { value: waterPaletteUV(ts, atlas, 0) },
    uWaterMid: { value: waterPaletteUV(ts, atlas, 2) },
    uWaterDark: { value: waterPaletteUV(ts, atlas, 3) },
  };
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 waterInfo;
        varying vec2 vWaterInfo;
        uniform float uWaterTime;
        uniform vec2 uWaterOrigin;
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWaterInfo = waterInfo;
        if (waterInfo.x > 0.5) {
          vec2 wp = (modelMatrix * vec4(transformed, 1.0)).xz + uWaterOrigin;
          float waveLift = sin(wp.x * 1.7 + wp.y * 1.1 - uWaterTime * 0.7) * 0.012
            + sin(wp.y * 2.3 - wp.x * 0.6 + uWaterTime * 0.5) * 0.007;
          transformed.y += waveLift * smoothstep(0.0, 0.3, waterInfo.y);
        }
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vWaterInfo;
        uniform float uWaterTime;
        uniform vec2 uWaterOrigin;
        uniform vec2 uWaterLight;
        uniform vec2 uWaterMid;
        uniform vec2 uWaterDark;
      `)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vWaterInfo.x > 0.5) {
          vec2 p = vWorldPos.xz + uWaterOrigin;
          float t = uWaterTime;
          float shore = max(0.0, vWaterInfo.y);
          vec3 lightWater = texture2D(map, uWaterLight).rgb;
          vec3 midWater = texture2D(map, uWaterMid).rgb;
          vec3 darkWater = texture2D(map, uWaterDark).rgb;

          // Broad, slow depth bands beneath finer wind-driven wavelets.
          float swell = 0.5 + 0.5 * sin(p.x * 0.63 + p.y * 0.41 + t * 0.38);
          float depth = smoothstep(0.02, 1.8, shore);
          vec3 shallow = mix(lightWater, midWater, 0.65);
          vec3 deep = mix(midWater, darkWater, 0.16 + swell * 0.06);
          vec3 waterColor = mix(shallow, deep, depth);

          float bend = sin(p.x * 0.71 - p.y * 0.33 + t * 0.23);
          float wave = 0.5 + 0.5 * sin(p.x * 3.1 + p.y * 6.3 - t * 1.15 + bend * 1.5);
          float broken = smoothstep(0.15, 0.9, 0.5 + 0.5 * sin(p.x * 1.8 - p.y * 1.2 + t * 0.42));
          float ripple = pow(wave, 14.0) * broken;
          waterColor = mix(waterColor, lightWater, ripple * 0.24);

          // A restrained sky sheen, rather than an expensive reflection pass.
          float grazing = 1.0 - clamp(normalize(cameraPosition - vWorldPos).y, 0.0, 1.0);
          waterColor = mix(waterColor, lightWater, 0.035 + pow(grazing, 3.0) * 0.22);

          // Thin, gently breathing foam stays attached to genuine shorelines.
          float edge = 0.055 + 0.018 * sin(p.x * 5.0 + p.y * 4.0 + t * 0.85);
          float foam = 1.0 - smoothstep(edge, edge + 0.045, shore);
          float wash = (1.0 - smoothstep(0.08, 0.32, shore)) * (0.06 + 0.04 * sin(shore * 22.0 - t * 0.8));
          diffuseColor.rgb = mix(waterColor, lightWater, clamp(foam * 0.86 + wash, 0.0, 1.0));
        }
      `);
  };
  material.customProgramCacheKey = () => 'diorama-water-v1';
}
