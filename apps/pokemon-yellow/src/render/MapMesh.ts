/**
 * Builds the 3D mesh for a map: every 8x8 tile becomes a textured quad on top
 * of its 16x16 square, and squares are extruded to their manifest height,
 * with side walls textured by the square's edge tiles. Geometry is merged
 * into one BufferGeometry per map (one draw call).
 */
import * as THREE from 'three';
import type { WorldMap } from '../world/WorldMap';
import type { AssetManifest, TileVisual } from './manifest';
import type { TileAtlas } from './textures';
import { sceneryFaces } from './scenery';
import { buildShoreField, installWater, WaterMotion, WATER_LEVEL } from './water';
import { quadMaterial, MAT } from './themes/materials';
import { installTexturePack } from './themes/shader';
import type { PackRuntime } from './themes/runtime';

/** Squares of scenery drawn around the map (connected maps / border blocks). */
export const VIEW_MARGIN = 8;

const SHADE = { top: 1, south: 0.86, east: 0.74, west: 0.74, north: 0.62 };

/** A stable 0-1 id for one prop (texture packs vary each tree's colour by it). */
export function propVariant(seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export interface BuiltMap {
  mesh: THREE.Mesh;
  /** Surface height at a square (for placing actors). */
  heightAt(sx: number, sy: number): number;
  dispose(): void;
}

export interface MapMeshOptions {
  margin?: number;
  /** Squares to leave out (drawn by another mesh). */
  skip?: (sx: number, sy: number) => boolean;
  /** Restrict to a rectangle of squares [x0, y0, x1, y1). */
  region?: [number, number, number, number];
  /** Indoor maps: squares outside the map are flat void instead of extruded border blocks. */
  flatBorder?: boolean;
  /** Shared across this view's main, connected and cutscene map batches. */
  waterMotion?: WaterMotion;
  /** Texture pack: adds material/normal/contact-shadow attributes and the pack shader. */
  pack?: PackRuntime;
}

/** Shared uniforms for the camera-to-player cutaway. */
export const cutawayUniforms = {
  uFocus: { value: new THREE.Vector3() },
  uCamPos: { value: new THREE.Vector3() },
  uCutRadius: { value: 1.6 },
};

export function buildMapMesh(world: WorldMap, manifest: AssetManifest, atlas: TileAtlas, opts: MapMeshOptions = {}): BuiltMap {
  const margin = opts.margin ?? VIEW_MARGIN;
  const VOID: TileVisual = { kind: 'floor', height: 0 };
  const [x0, y0, x1, y1] = opts.region ?? [-margin, -margin, world.widthSquares + margin, world.heightSquares + margin];
  const w = x1 - x0;
  const h = y1 - y0;
  const skipped = (sx: number, sy: number) => opts.skip?.(sx, sy) ?? false;

  const visuals: TileVisual[] = new Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const sx = x0 + i;
      const sy = y0 + j;
      visuals[j * w + i] =
        (opts.flatBorder && !world.inBounds(sx, sy)) || skipped(sx, sy)
          ? VOID
          : manifest.square(world.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2)).id, [
              world.tileAt(sx * 2, sy * 2), world.tileAt(sx * 2 + 1, sy * 2),
              world.tileAt(sx * 2, sy * 2 + 1), world.tileAt(sx * 2 + 1, sy * 2 + 1),
            ]);
    }
  const vis = (sx: number, sy: number): TileVisual | undefined => {
    const i = sx - x0;
    const j = sy - y0;
    if (i < 0 || j < 0 || i >= w || j >= h) return undefined;
    return visuals[j * w + i];
  };

  // A long route is rendered as one batch, including offscreen scenery. Keep
  // its rounded tree silhouettes but reduce facets rather than multiplying the
  // old whole-map triangle budget by ten. Count a multi-cell tree only once.
  const estimatedTriangles = visuals.reduce((n, v) => {
    const cost = v.model === 'tree' || v.model === 'grove' ? 260
      : v.model === 'rock' ? 125 : v.model === 'flowers' ? 110 : v.model ? 65 : 12;
    return n + cost / ((v.span?.[0] ?? 1) * (v.span?.[1] ?? 1));
  }, 0);
  const compactNaturalProps = estimatedTriangles > 140000;

  const hasWater = visuals.some((v) => v.waterTile !== undefined);
  const shoreAt = hasWater ? buildShoreField([x0, y0, x1, y1], (tx, ty) => {
    // Read real tiles outside this mesh's region too. A skip/region boundary
    // between connected batches is not a beach.
    if (opts.flatBorder && !world.inBounds(Math.floor(tx / 2), Math.floor(ty / 2))) return true;
    const ts = world.tilesetForBlock(Math.floor(tx / 4), Math.floor(ty / 4));
    return manifest.tile(ts.id, world.tileAt(tx, ty)).kind === 'water';
  }) : undefined;

  // Connected roof patches share a ridge and eaves, even across block boundaries.
  const roofs = new Map<number, [number, number]>();
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const start = j * w + i;
    if (visuals[start].model !== 'roof' || roofs.has(start)) continue;
    const pending = [start], group = new Set([start]);
    let north = j, south = j + 1;
    for (let k = 0; k < pending.length; k++) {
      const n = pending[k], x = n % w, y = Math.floor(n / w);
      north = Math.min(north, y); south = Math.max(south, y + 1);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const next = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || group.has(next) || visuals[next].model !== 'roof') continue;
        group.add(next); pending.push(next);
      }
    }
    for (const n of group) roofs.set(n, [north + y0, south + y0]);
  }

  // Palette samples are cached per tileset. A prop must still find a dark
  // colour when its own square happens to contain only two ROM shades.
  const paletteSamples = new Map<number, { tile: number; pixel: number }[]>();
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const waterInfo: number[] = [];
  const pack = opts.pack;
  const materials: number[] = [];
  const normals: number[] = [];
  const occlusion: number[] = [];
  const variants: number[] = [];
  // Baked contact shadow: ground beside raised squares, and the feet of walls/props.
  const aoAt = (x: number, y: number, z: number) => {
    if (y < 0.2) {
      let raised = 0;
      for (const dx of [-0.01, 0.01]) for (const dz of [-0.01, 0.01]) {
        const n = vis(Math.floor(x + dx), Math.floor(z + dz));
        if (n && n.height >= 0.5) raised++;
      }
      return 1 - 0.13 * raised;
    }
    return 0.72 + 0.28 * Math.min(1, Math.max(0, (y - 0.2) / 0.8));
  };

  // Quad with corners a,b,c,d (counter-clockwise when seen from outside) and tile UVs.
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    tile: number,
    shade: number,
    vFrom = 0,
    vTo = 1,
    pixel?: number,
    water = false,
    material: number = MAT.GENERIC,
    variant = 0.5,
  ) => {
    const [u0, v0, u1, v1] = atlas.uv(tile);
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    const vb = v0 + (v1 - v0) * vFrom;
    const vt = v0 + (v1 - v0) * vTo;
    if (pixel === undefined) uv.push(u0, vb, u1, vb, u1, vt, u0, vt);
    else {
      const u = u0 + (u1 - u0) * ((pixel % 8) + 0.5) / 8;
      const v = v1 - (v1 - v0) * (Math.floor(pixel / 8) + 0.5) / 8;
      for (let k = 0; k < 4; k++) uv.push(u, v);
    }
    for (let k = 0; k < 4; k++) col.push(shade, shade, shade);
    if (hasWater) for (const p of [a, b, c, d]) waterInfo.push(water ? 1 : 0, water ? shoreAt!(p[0], p[2]) : 0);
    if (pack) {
      // Flat face normal; triangles are stored as quads with a repeated corner.
      const nrm = (p: number[], q: number[], r: number[]) => {
        const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
        const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
        return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      };
      let n = nrm(a, b, c);
      if (Math.hypot(n[0], n[1], n[2]) < 1e-10) n = nrm(a, c, d);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      for (const p of [a, b, c, d]) {
        normals.push(n[0] / len, n[1] / len, n[2] / len);
        materials.push(material);
        occlusion.push(aoAt(p[0], p[1], p[2]));
        variants.push(variant);
      }
    }
    const area = (p: number[], q: number[], r: number[]) => {
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    // The scenery format also represents triangles as quads with a repeated
    // corner. Don't submit a second, zero-area triangle for every leaf/tip.
    if (area(a, b, c) > 1e-10) idx.push(base, base + 1, base + 2);
    if (area(a, c, d) > 1e-10) idx.push(base, base + 2, base + 3);
  };

  for (let sy = y0; sy < y0 + h; sy++) {
    for (let sx = x0; sx < x0 + w; sx++) {
      const v = vis(sx, sy)!;
      const top = v.height;
      if (opts.flatBorder && !world.inBounds(sx, sy)) continue; // void around indoor maps
      if (skipped(sx, sy)) continue; // drawn by the connected map's own mesh
      if (v.model) {
        const tiles = [world.tileAt(sx * 2, sy * 2), world.tileAt(sx * 2 + 1, sy * 2), world.tileAt(sx * 2, sy * 2 + 1), world.tileAt(sx * 2 + 1, sy * 2 + 1)];
        const ts = world.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2));
        let palette = paletteSamples.get(ts.id);
        if (!palette) {
          palette = Array.from({ length: 4 }, (_, color) => {
            const p = ts.tilePixels.indexOf(color);
            return { tile: Math.floor(Math.max(0, p) / 64), pixel: Math.max(0, p) % 64 };
          });
          paletteSamples.set(ts.id, palette);
        }
        const samples = Array.from({ length: 4 }, (_, color) => {
          for (let t = 0; t < 4; t++) {
            const pixel = ts.tilePixels.slice(tiles[t] * 64, tiles[t] * 64 + 64).indexOf(color);
            if (pixel >= 0) return { tile: t, pixel };
          }
          const sample = palette![color];
          tiles.push(sample.tile);
          return { tile: tiles.length - 1, pixel: sample.pixel };
        });
        let floor: number[] | undefined;
        for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
          if (vis(sx + dx, sy + dy)?.kind !== 'floor') continue;
          const fx = sx + dx, fy = sy + dy;
          if (world.tilesetForBlock(Math.floor(fx / 2), Math.floor(fy / 2)).id !== ts.id) continue;
          const start = tiles.length;
          tiles.push(world.tileAt(fx * 2, fy * 2), world.tileAt(fx * 2 + 1, fy * 2), world.tileAt(fx * 2, fy * 2 + 1), world.tileAt(fx * 2 + 1, fy * 2 + 1));
          floor = [start, start + 1, start + 2, start + 3];
          break;
        }
        const patch = roofs.get((sy - y0) * w + sx - x0);
        const roofY = (z: number) => patch ? 1.15 + Math.min(z - patch[0], patch[1] - z) * 0.65 : 1.15;
        const seed = Math.imul(sx - (v.part?.[0] ?? 0), 73856093) ^ Math.imul(sy - (v.part?.[1] ?? 0), 19349663);
        const faces = sceneryFaces(v.model, {
          samples, facing: v.ledgeFacing, tiles: tiles.slice(0, 4), floor,
          part: v.part, span: v.span, rise: v.rise, compact: compactNaturalProps, seed,
          joined: [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => vis(sx + dx, sy + dy)?.model === v.model),
          roof: patch ? [roofY(sy), roofY(sy + 0.5), roofY(sy + 1)] : undefined,
        });
        const variant = propVariant(seed);
        for (const f of faces) {
          const corners = f.corners.map(([x, y, z]) => [x + sx, y, z + sy] as [number, number, number]);
          const material = pack ? quadMaterial(ts.name, { model: v.model, role: f.role }) : MAT.GENERIC;
          quad(corners[0], corners[1], corners[2], corners[3], tiles[f.tile], f.shade, 0, 1, f.pixel, false, material, f.role ? 0.5 : variant);
        }
        continue;
      }
      // top: four tiles, each 0.5 x 0.5; world x = sx, world z = sy (south is +z)
      const squareSet = pack ? world.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2)) : undefined;
      const shore = !!pack && v.kind === 'solid' && [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dx, dy]) => vis(sx + dx, sy + dy)?.waterTile !== undefined);
      for (let ty = 0; ty < 2; ty++)
        for (let tx = 0; tx < 2; tx++) {
          const tile = world.tileAt(sx * 2 + tx, sy * 2 + ty);
          const xa = sx + tx * 0.5;
          const za = sy + ty * 0.5;
          const water = tile === v.waterTile;
          // Only shore tiles need a centre vertex for a smooth depth gradient.
          // Offshore ripples are fragment-shaded, so oceans remain cheap quads.
          const divisions = water && Math.min(shoreAt!(xa, za), shoreAt!(xa + 0.5, za), shoreAt!(xa, za + 0.5), shoreAt!(xa + 0.5, za + 0.5)) < 0.6 ? 2 : 1;
          const size = 0.5 / divisions, y = water ? WATER_LEVEL : top;
          const material = squareSet ? quadMaterial(squareSet.name, { kind: v.kind, water, shore }) : MAT.GENERIC;
          for (let j = 0; j < divisions; j++) for (let i = 0; i < divisions; i++) {
            const x = xa + i * size, z = za + j * size;
            quad([x, y, z + size], [x + size, y, z + size], [x + size, y, z], [x, y, z], tile, SHADE.top, 0, 1, undefined, water, material);
          }
        }
      // side walls toward lower neighbours
      const sides: [number, number, keyof typeof SHADE][] = [
        [0, 1, 'south'],
        [0, -1, 'north'],
        [1, 0, 'east'],
        [-1, 0, 'west'],
      ];
      for (const [dx, dy, side] of sides) {
        const n = vis(sx + dx, sy + dy);
        const bottom = n ? n.height : Math.min(0, top);
        if (bottom >= top) continue;
        const span = top - bottom;
        for (let k = 0; k < 2; k++) {
          let tile: number;
          let a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number];
          if (side === 'south') {
            tile = world.tileAt(sx * 2 + k, sy * 2 + 1);
            const xa = sx + k * 0.5;
            const z = sy + 1;
            a = [xa, bottom, z]; b = [xa + 0.5, bottom, z]; c = [xa + 0.5, top, z]; d = [xa, top, z];
          } else if (side === 'north') {
            tile = world.tileAt(sx * 2 + 1 - k, sy * 2);
            const xa = sx + 1 - k * 0.5;
            const z = sy;
            a = [xa, bottom, z]; b = [xa - 0.5, bottom, z]; c = [xa - 0.5, top, z]; d = [xa, top, z];
          } else if (side === 'east') {
            tile = world.tileAt(sx * 2 + 1, sy * 2 + 1 - k);
            const x = sx + 1;
            const za = sy + 1 - k * 0.5;
            a = [x, bottom, za]; b = [x, bottom, za - 0.5]; c = [x, top, za - 0.5]; d = [x, top, za];
          } else {
            tile = world.tileAt(sx * 2, sy * 2 + k);
            const x = sx;
            const za = sy + k * 0.5;
            a = [x, bottom, za]; b = [x, bottom, za + 0.5]; c = [x, top, za + 0.5]; d = [x, top, za];
          }
          // Tall walls repeat the edge tile texture once per world unit.
          const reps = Math.max(1, Math.round(span / 0.5));
          for (let r = 0; r < reps; r++) {
            const y1 = bottom + (span * r) / reps;
            const y2 = bottom + (span * (r + 1)) / reps;
            quad([a[0], y1, a[2]], [b[0], y1, b[2]], [c[0], y2, c[2]], [d[0], y2, d[2]], tile, SHADE[side], 0, 1, undefined, false,
              squareSet ? quadMaterial(squareSet.name, { kind: v.kind, shore }) : MAT.GENERIC);
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  if (hasWater) geo.setAttribute('waterInfo', new THREE.Float32BufferAttribute(waterInfo, 2));
  if (pack) {
    geo.setAttribute('themeMaterial', new THREE.Float32BufferAttribute(materials, 1));
    geo.setAttribute('themeNormal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('themeAO', new THREE.Float32BufferAttribute(occlusion, 1));
    geo.setAttribute('themeVariant', new THREE.Float32BufferAttribute(variants, 1));
  }
  geo.computeBoundingSphere();
  if (hasWater) geo.boundingSphere!.radius += 0.02; // Shader wave displacement is at most 0.019.
  const mat = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true });
  installCutaway(mat);
  if (hasWater) installWater(mat, world.tileset, atlas, opts.waterMotion ?? new WaterMotion());
  if (pack) installTexturePack(mat, pack.uniforms, pack.pack.glsl, pack.cacheKey(hasWater));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `map:${world.data.constName}`;
  return {
    mesh,
    heightAt: (sx, sy) => vis(sx, sy)?.height ?? 0,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * Dithered cutaway: raised geometry between the camera and the player is
 * stippled out so the player is never hidden behind buildings or walls.
 */
export function installCutaway(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cutawayUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;
        uniform vec3 uFocus;
        uniform vec3 uCamPos;
        uniform float uCutRadius;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (vWorldPos.y > 0.2 && vWorldPos.z > uFocus.z + 0.05) {
          vec3 seg = uCamPos - uFocus;
          float t = clamp(dot(vWorldPos - uFocus, seg) / dot(seg, seg), 0.0, 1.0);
          float d = length(vWorldPos - (uFocus + seg * t));
          if (d < uCutRadius) {
            vec2 p = floor(gl_FragCoord.xy);
            if (mod(p.x + p.y, 2.0) < 1.0 || d < uCutRadius * 0.6) discard;
          }
        }`,
      );
  };
}
