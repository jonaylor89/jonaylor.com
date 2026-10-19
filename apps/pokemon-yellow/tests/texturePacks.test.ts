import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { isWorldLook, ORIGINAL_LOOK, TEXTURE_PACKS, texturePack, WORLD_LOOKS } from '../src/render/themes';
import { floorMaterial, MAT, MATERIAL_COUNT, MATERIAL_NAMES, quadMaterial, solidMaterial } from '../src/render/themes/materials';
import { DEFAULT_RAMPS, DEFAULT_SURFACE, fadeAmount, hexToRgb, PackRuntime, resolvedLantern, resolvedLight } from '../src/render/themes/runtime';
import { installTexturePack } from '../src/render/themes/shader';
import { installWater, WaterMotion } from '../src/render/water';
import { buildMapMesh, installCutaway } from '../src/render/MapMesh';
import { FADE_PALS_BGP } from '../src/render/palette';
import { AssetManifest } from '../src/render/manifest';
import { WorldMap } from '../src/world/WorldMap';
import type { TilesetData } from '../src/data/schema';
import { bundle, HAS_ROM } from './helpers';
import { c } from '../src/rom/constants';

const hex = /^#[0-9a-f]{6}$/i;

describe('texture pack registry', () => {
  it('lists the original look first, then every pack once', () => {
    expect(WORLD_LOOKS[0].id).toBe(ORIGINAL_LOOK);
    expect(new Set(WORLD_LOOKS.map((l) => l.id)).size).toBe(WORLD_LOOKS.length);
    expect(texturePack(ORIGINAL_LOOK)).toBeUndefined();
    expect(isWorldLook('remastered')).toBe(true);
    expect(isWorldLook('nope')).toBe(false);
  });

  it.each(TEXTURE_PACKS.map((p) => [p.id, p] as const))('%s is well formed', (_, pack) => {
    expect(pack.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(pack.label).toBe(pack.label.toUpperCase());
    expect(pack.description.length).toBeGreaterThan(10);
    expect(pack.description.length).toBeLessThan(110);
    for (const [name, ramp] of Object.entries(pack.ramps)) {
      expect(MATERIAL_NAMES, name).toContain(name);
      expect(ramp, name).toHaveLength(4);
      for (const color of ramp!) expect(color, name).toMatch(hex);
    }
    for (const [name, s] of Object.entries(pack.surface ?? {})) {
      expect(MATERIAL_NAMES, name).toContain(name);
      if (s?.alt) expect(MATERIAL_NAMES).toContain(s.alt);
      for (const v of [s?.pattern, s?.tint, s?.glow]) if (v !== undefined) expect(v >= 0 && v <= 1, name).toBe(true);
    }
    for (const setting of ['outdoor', 'indoor', 'cave'] as const) {
      const l = resolvedLight(pack, setting);
      for (const color of [l.sun, l.skyAmbient, l.groundAmbient]) expect(color).toMatch(hex);
      expect(Math.hypot(...l.sunDir)).toBeGreaterThan(0.1);
      expect(l.sunDir[1]).toBeGreaterThan(0); // the sun is above the horizon
    }
    for (const color of [pack.sky.zenith, pack.sky.horizon, pack.sky.cloudColor, pack.indoorVoid]) expect(color).toMatch(hex);
    if (pack.weather) {
      expect(pack.weather.density).toBeGreaterThan(0);
      expect(pack.weather.density).toBeLessThanOrEqual(150);
    }
    for (const r of [pack.sprites?.player, pack.sprites?.pikachu, ...(pack.sprites?.people ?? [])]) if (r) for (const color of r) expect(color).toMatch(hex);
    if (pack.glsl) expect(pack.glsl).toContain('void packSurface(');
  });
});

describe('materials', () => {
  it('classifies floors, walls and props by tileset and model', () => {
    expect(floorMaterial('OVERWORLD')).toBe(MAT.GROUND);
    expect(floorMaterial('CAVERN')).toBe(MAT.CAVE_FLOOR);
    expect(floorMaterial('REDS_HOUSE_1')).toBe(MAT.FLOOR_WOOD);
    expect(floorMaterial('POKECENTER')).toBe(MAT.FLOOR_TILE);
    expect(solidMaterial('OVERWORLD')).toBe(MAT.FACADE);
    expect(solidMaterial('MART')).toBe(MAT.INDOOR_WALL);
    expect(solidMaterial('PLATEAU')).toBe(MAT.STONE);
    expect(quadMaterial('OVERWORLD', { model: 'tree' })).toBe(MAT.FOLIAGE);
    expect(quadMaterial('OVERWORLD', { model: 'tree', role: 'ground' })).toBe(MAT.GROUND);
    expect(quadMaterial('OVERWORLD', { model: 'grass', role: 'ground' })).toBe(MAT.TALL_GRASS);
    expect(quadMaterial('OVERWORLD', { model: 'tree', role: 'shadow' })).toBe(MAT.SHADOW);
    expect(quadMaterial('OVERWORLD', { kind: 'floor', water: true })).toBe(MAT.WATER);
    // A shoreline square's non-water tiles are edging, never the water material.
    expect(quadMaterial('OVERWORLD', { kind: 'water' })).toBe(MAT.ROCK);
    expect(quadMaterial('GYM', { kind: 'water' })).toBe(MAT.STONE);
    expect(quadMaterial('OVERWORLD', { kind: 'solid', shore: true })).toBe(MAT.ROCK);
    expect(Object.keys(DEFAULT_RAMPS)).toHaveLength(MATERIAL_COUNT);
    expect(Object.keys(DEFAULT_SURFACE)).toHaveLength(MATERIAL_COUNT);
  });
});

describe('pack fades and lights', () => {
  it('turns FadePal remaps into a fade toward black or white', () => {
    expect(fadeAmount(FADE_PALS_BGP[3])).toBe(0); // FadePal4: normal
    expect(fadeAmount(FADE_PALS_BGP[0])).toBe(1); // all black
    expect(fadeAmount(FADE_PALS_BGP[7])).toBe(-1); // all white
    expect(fadeAmount(FADE_PALS_BGP[1])).toBeGreaterThan(fadeAmount(FADE_PALS_BGP[2]));
    expect(fadeAmount([3, 2, 1, 0])).toBe(0); // the poison flash inverts shades, it does not fade
  });

  it('dims caves and gives them a lantern', () => {
    const pack = texturePack('remastered')!;
    expect(resolvedLight(pack, 'cave').ambientStrength).toBeLessThan(resolvedLight(pack, 'indoor').ambientStrength);
    expect(resolvedLantern(pack, 'outdoor')).toBeUndefined();
    expect(resolvedLantern(pack, 'cave')?.radius).toBeGreaterThan(0);
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0]);
  });
});

describe('pack shader composition', () => {
  it('chains after cutaway and water, declaring water tones before the water shader needs them', () => {
    const pack = new PackRuntime(texturePack('remastered')!, true);
    const tex = new THREE.Texture();
    const atlas = { texture: tex, uv: (t: number): [number, number, number, number] => [t / 32, 0, (t + 1) / 32, 1], drawTile() {}, recolor() {} };
    const ts = { id: 0, tileCount: 24, tilePixels: new Array(24 * 64).fill(1) } as TilesetData;
    const material = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });
    installCutaway(material); installWater(material, ts, atlas, new WaterMotion());
    installTexturePack(material, pack.uniforms, undefined, pack.cacheKey(true));
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader } as Parameters<typeof material.onBeforeCompile>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const f = shader.fragmentShader;
    expect(f.indexOf('#define THEMED 1')).toBeLessThan(f.indexOf('#ifndef THEMED'));
    expect(f).toContain('vec4 themeTexel = diffuseColor;');
    expect(f.indexOf('vec4 themeTexel')).toBeLessThan(f.indexOf('if (vWaterInfo.x > 0.5)'));
    expect(f).toContain('diffuseColor.rgb = lit;');
    expect(shader.vertexShader).toContain('vThemeMat = themeMaterial;');
    expect(shader.uniforms.uRamps).toBe(pack.uniforms.uRamps);
    expect(material.customProgramCacheKey()).toContain('remastered');
    material.dispose(); tex.dispose(); pack.dispose();
  });
});

describe.skipIf(!HAS_ROM)('pack map geometry', () => {
  it('tags every vertex with a material, unit normal and contact shadow', async () => {
    const b = await bundle();
    const manifest = new AssetManifest(b);
    const pack = new PackRuntime(texturePack('remastered')!, true);
    const world = new WorldMap(b, c('map', 'PALLET_TOWN'));
    const tex = new THREE.Texture();
    const atlas = { texture: tex, uv: (t: number): [number, number, number, number] => [(t % 16) / 16, 0, (t % 16 + 1) / 16, 1], drawTile() {}, recolor() {} };
    const built = buildMapMesh(world, manifest, atlas, { pack });
    const geo = built.mesh.geometry;
    const count = geo.getAttribute('position').count;
    const mats = geo.getAttribute('themeMaterial'), normals = geo.getAttribute('themeNormal'), ao = geo.getAttribute('themeAO');
    expect(mats.count).toBe(count);
    expect(normals.count).toBe(count);
    expect(ao.count).toBe(count);
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      seen.add(mats.getX(i));
      expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 3);
      expect(ao.getX(i)).toBeGreaterThan(0.4);
      expect(ao.getX(i)).toBeLessThanOrEqual(1);
    }
    for (const m of [MAT.GROUND, MAT.FOLIAGE, MAT.ROOF, MAT.FACADE, MAT.WOOD, MAT.TALL_GRASS]) expect(seen, `material ${m}`).toContain(m);
    // The original look builds the same geometry without pack attributes.
    const plain = buildMapMesh(world, manifest, atlas, {});
    expect(plain.mesh.geometry.getAttribute('position').count).toBe(count);
    expect(plain.mesh.geometry.getAttribute('themeMaterial')).toBeUndefined();
    built.dispose(); plain.dispose(); tex.dispose(); pack.dispose();
  });
});
