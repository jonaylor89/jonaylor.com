import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildShoreField, installWater, WaterMotion, waterPaletteUV, WATER_LEVEL } from '../src/render/water';
import { buildMapMesh, installCutaway } from '../src/render/MapMesh';
import { AssetManifest } from '../src/render/manifest';
import { WorldMap } from '../src/world/WorldMap';
import type { TilesetData } from '../src/data/schema';
import { bundle, HAS_ROM } from './helpers';
import { c } from '../src/rom/constants';

const atlas = (texture = new THREE.Texture()) => ({
  texture, uv: (t: number): [number, number, number, number] => [t / 32, 0, (t + 1) / 32, 1],
  drawTile() {}, recolor() {},
});
const paletteTileset = () => {
  const pixels = new Array(24 * 64).fill(1);
  pixels[0] = 0; pixels[2 * 64] = 2; pixels[5 * 64 + 9] = 3;
  pixels[0x14 * 64] = 3; // Never use this animated sample.
  return { id: 0, tileCount: 24, tilePixels: pixels } as TilesetData;
};

describe('continuous diorama water', () => {
  it('measures real shore distance at half-tile edges and rounded corners', () => {
    const coast = buildShoreField([-2, -2, 4, 4], (x) => x >= 0);
    expect(coast(0, 0)).toBe(0);
    expect(coast(0.25, 0.5)).toBe(0.25);
    expect(coast(1.25, 0.75)).toBe(1.25);
    expect(coast(3, 1)).toBe(2);
    const corner = buildShoreField([-2, -2, 4, 4], (x, z) => x >= 0 || z >= 0);
    expect(corner(0.25, 0.25)).toBeCloseTo(Math.hypot(0.25, 0.25));
    const channel = buildShoreField([0, 0, 2, 2], (x) => x === 0);
    expect(channel(0.25, 1)).toBe(0.25); // A narrow stream still has a non-foam centre.
  });

  it('does not invent shorelines at map mesh, skip or cropped-region boundaries', () => {
    const ocean = buildShoreField([0, 0, 1, 1], () => true);
    expect(ocean(0, 0)).toBe(2); expect(ocean(1, 1)).toBe(2);
    const waterAt = (x: number, z: number) => x >= 0 && z >= 0;
    const full = buildShoreField([0, 0, 8, 8], waterAt);
    const cropped = buildShoreField([1, 0, 3, 3], waterAt);
    for (let z = 0; z <= 3; z += 0.25) for (let x = 1; x <= 3; x += 0.25)
      expect(cropped(x, z)).toBe(full(x, z));
  });

  it('uses simulation time, freezes reduced motion and preserves phase through map shifts', () => {
    const motion = new WaterMotion();
    motion.advance(59.73, false); expect(motion.time.value).toBeCloseTo(1);
    motion.advance(600, true); motion.advance(NaN, false); motion.advance(-10, false);
    expect(motion.time.value).toBeCloseTo(1);
    const before = new THREE.Vector2(8, 10).add(motion.origin.value);
    motion.relocate({ dx: -6, dy: 20 });
    const after = new THREE.Vector2(2, 30).add(motion.origin.value);
    expect(after.toArray()).toEqual(before.toArray());
    motion.relocate(); expect(motion.origin.value.toArray()).toEqual([0, 0]);
    expect(motion.time.value).toBeCloseTo(1);
  });

  it('samples stable palette pixels and chains after cutaway without extra passes', () => {
    const ts = paletteTileset(), a = atlas(), motion = new WaterMotion();
    const uv = waterPaletteUV(ts, a, 3);
    expect(uv.x).toBeCloseTo(5 / 32 + 1.5 / (8 * 32));
    expect(uv.y).toBeCloseTo(1 - 1.5 / 8);
    const material = new THREE.MeshBasicMaterial({ map: a.texture, vertexColors: true });
    installCutaway(material); installWater(material, ts, a, motion);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader } as Parameters<typeof material.onBeforeCompile>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vWaterInfo = waterInfo');
    expect(shader.vertexShader).toContain('transformed.y += waveLift');
    expect(shader.fragmentShader).toContain('vWorldPos.y > 0.2');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix(waterColor');
    expect(shader.fragmentShader).toContain('#include <fog_fragment>');
    expect(shader.uniforms.uWaterTime).toBe(motion.time);
    expect(shader.uniforms.uWaterOrigin).toBe(motion.origin);
    // Recolouring the atlas is sufficient for filters/fades: no fixed RGB water palette.
    expect(shader.fragmentShader).toContain('waterTone(uWaterMid)');
    expect(shader.fragmentShader).toContain('vec3 waterTone(vec2 uv) { return texture2D(map, uv).rgb; }');
    expect(material.transparent).toBe(false);
    material.dispose(); a.texture.dispose();
  });
});

describe.skipIf(!HAS_ROM)('ROM water integration', () => {
  it('recognizes mixed shoreline graphics without changing their collision identity', async () => {
    const b = await bundle(), manifest = new AssetManifest(b), ts = c('tileset', 'OVERWORLD');
    const shore = manifest.square(ts, [0x32, 0x14, 0x32, 0x14]);
    expect(shore.kind).toBe(manifest.tile(ts, 0x32).kind);
    expect(shore.height).toBe(0); // Not a waist-high cube with water on its side.
    expect(shore.waterTile).toBe(b.tileTables.waterTile);
    expect(manifest.square(c('tileset', 'REDS_HOUSE_1'), [0x14, 0x14, 0x14, 0x14]).waterTile).toBeUndefined();
  });

  it('bakes only water surfaces with finite seamless shore attributes and no extra meshes', async () => {
    const b = await bundle(), manifest = new AssetManifest(b), a = atlas(), motion = new WaterMotion();
    for (const name of ['PALLET_TOWN', 'CERULEAN_GYM', 'ROUTE_21', 'SEAFOAM_ISLANDS_B4F', 'REDS_HOUSE_1F']) {
      const world = new WorldMap(b, c('map', name));
      const built = buildMapMesh(world, manifest, a, { margin: 0, waterMotion: motion });
      const positions = built.mesh.geometry.getAttribute('position');
      const info = built.mesh.geometry.getAttribute('waterInfo');
      if (name === 'REDS_HOUSE_1F') expect(info).toBeUndefined();
      else {
        expect(info.count).toBe(positions.count);
        let water = 0;
        const seams = new Map<string, number>();
        for (let i = 0; i < info.count; i++) {
          expect(Number.isFinite(info.getY(i))).toBe(true);
          if (!info.getX(i)) continue;
          water++;
          expect(positions.getY(i)).toBeCloseTo(WATER_LEVEL);
          expect(info.getY(i)).toBeGreaterThanOrEqual(0); expect(info.getY(i)).toBeLessThanOrEqual(2);
          const key = `${positions.getX(i)},${positions.getZ(i)}`;
          const previous = seams.get(key);
          if (previous !== undefined) expect(info.getY(i)).toBe(previous);
          seams.set(key, info.getY(i));
        }
        expect(water).toBeGreaterThan(0);
      }
      expect(built.mesh.children).toHaveLength(0);
      expect(Array.isArray(built.mesh.material)).toBe(false);
      built.dispose();
    }
    a.texture.dispose();
  });
});
