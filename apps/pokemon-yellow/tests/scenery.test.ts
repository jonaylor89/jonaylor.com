import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sceneryFaces, type SceneryKind } from '../src/render/scenery';
import { AssetManifest } from '../src/render/manifest';
import { buildMapMesh } from '../src/render/MapMesh';
import { WorldMap } from '../src/world/WorldMap';
import { bundle, HAS_ROM } from './helpers';
import { c } from '../src/rom/constants';
import { buildSpriteProp } from '../src/render/spriteProp';
import { SpriteActor } from '../src/render/SpriteActor';
import { RENDER_BUDGET } from '../src/render/quality';
import { isOutsideMap } from '../src/world/movement';

const kinds: SceneryKind[] = ['tree', 'cutTree', 'grove', 'roof', 'wall', 'fence', 'sign', 'flowers', 'grass', 'ledge', 'pc', 'bookshelf', 'counter', 'bin', 'plant', 'rock', 'stump', 'cliff', 'table', 'stool', 'chair', 'bed', 'cabinet', 'tv', 'statue', 'gravestone', 'machine', 'ball'];
const samples = [0, 1, 2, 3].map((pixel) => ({ tile: 0, pixel }));

describe('low-poly scenery', () => {
  it('has deterministic, bounded, atlas-backed geometry for every model', () => {
    for (const kind of kinds) {
      const faces = sceneryFaces(kind, { samples });
      expect(faces.length).toBeGreaterThan(1);
      expect(faces.length).toBeLessThan(450);
      expect(faces).toEqual(sceneryFaces(kind, { samples }));
      for (const f of faces) {
        expect(f.shade).toBeGreaterThan(0);
        expect(f.shade).toBeLessThanOrEqual(1);
        expect(f.tile).toBeGreaterThanOrEqual(0);
        expect(f.tile).toBeLessThan(4);
        for (const [x, y, z] of f.corners) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
          expect(z).toBeGreaterThanOrEqual(0);
          expect(z).toBeLessThanOrEqual(1);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('gives bins a cylindrical body, a separate lid and outward-facing facets', () => {
    const faces = sceneryFaces('bin', { samples });
    const body = faces.filter((f) => f.pixel === 1 && f.corners.some((p) => p[1] === 0.6));
    const xs = new Set(body.flatMap((f) => f.corners.map((p) => p[0].toFixed(4))));
    expect(xs.size).toBeGreaterThan(6); // Not a textured cube.
    expect(Math.max(...faces.flatMap((f) => f.corners.map((p) => p[1])))).toBeCloseTo(0.86);
    for (const f of body) {
      const [a, b, c] = f.corners.map((p) => new THREE.Vector3(...p));
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      const radial = a.clone().add(b).add(c).divideScalar(3).sub(new THREE.Vector3(0.5, 0, 0.5));
      radial.y = 0;
      expect(normal.dot(radial)).toBeGreaterThanOrEqual(-1e-10);
    }
  });

  it('clips shared tree/table geometry into cells with matching canopy seams', () => {
    for (const kind of ['tree', 'table'] as const) {
      const left = sceneryFaces(kind, { samples, ground: false, part: [0, 0], span: [2, 2], seed: 18 });
      const right = sceneryFaces(kind, { samples, ground: false, part: [1, 0], span: [2, 2], seed: 18 });
      const seam = (faces: typeof left, x: number) => [...new Set(faces.flatMap((f) => f.corners)
        .filter((p) => Math.abs(p[0] - x) < 1e-8).map((p) => p.slice(1).map((v) => v.toFixed(6)).join(',')))].sort();
      expect(seam(left, 1)).toEqual(seam(right, 0));
      for (const f of [...left, ...right]) for (const [x, y, z] of f.corners) {
        expect([x, y, z].every(Number.isFinite)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1);
        expect(z).toBeGreaterThanOrEqual(0); expect(z).toBeLessThanOrEqual(1);
      }
    }
    expect(sceneryFaces('tree', { samples, compact: true }).length)
      .toBeLessThan(sceneryFaces('tree', { samples }).length / 3);
  });

  it('keeps still props world-aligned and disposes their palette-backed geometry', () => {
    for (const model of ['rock', 'ball'] as const) {
      const geo = buildSpriteProp(model, [17, 34, 51, 68]);
      expect(geo.getAttribute('position').count).toBe(geo.getAttribute('uv').count);
      expect(Array.from(geo.getAttribute('position').array).every(Number.isFinite)).toBe(true);
      expect(geo.boundingSphere!.radius).toBeGreaterThan(0.2);
      geo.dispose();
      const texture = new THREE.Texture();
      const actor = new SpriteActor(texture, { kind: 'billboard', frames: 1, walking: false, model, modelPixels: [17, 34, 51, 68] });
      const camera = new THREE.PerspectiveCamera(); camera.position.set(4, 6, 8);
      actor.setPosition(2, 3, 0.12); actor.faceCamera(camera);
      expect(actor.object.position.toArray()).toEqual([2.5, 0.12, 3.5]);
      expect(actor.object.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
      let disposed = false;
      (actor.object.children[0] as THREE.Mesh).geometry.addEventListener('dispose', () => { disposed = true; });
      actor.setVisible(false); expect(actor.object.visible).toBe(false);
      actor.dispose(); expect(disposed).toBe(true); texture.dispose();
    }
  });

  it('finds palette shades elsewhere in the tileset instead of turning missing colours white', () => {
    const ts = { id: 42, tilePixels: [...new Array(64).fill(0), ...new Array(64).fill(2), ...new Array(64).fill(3)] };
    const world = { widthSquares: 1, heightSquares: 1, data: { constName: 'TEST' },
      tilesetForBlock: () => ts, tileAt: () => 0, inBounds: () => true } as unknown as WorldMap;
    const manifest = { square: () => ({ kind: 'solid', height: 1, model: 'bin' }) } as unknown as AssetManifest;
    const texture = new THREE.Texture();
    const built = buildMapMesh(world, manifest, { texture,
      uv: (t) => [t / 3, 0, (t + 1) / 3, 1], drawTile() {}, recolor() {} }, { margin: 0 });
    const uv = built.mesh.geometry.getAttribute('uv');
    // The bin handle uses shade 3, which is only present in tile 2.
    expect(Array.from({ length: uv.count }, (_, i) => uv.getX(i)).some((u) => Math.abs(u - (2 / 3 + 0.5 / 24)) < 1e-6)).toBe(true);
    built.dispose(); texture.dispose();
  });

  it('rotates ledge slopes to the original facing and shares roof edge heights', () => {
    const south = sceneryFaces('ledge', { samples, facing: 0 });
    const west = sceneryFaces('ledge', { samples, facing: 8 });
    const east = sceneryFaces('ledge', { samples, facing: 12 });
    expect(west[1].corners[0]).toEqual([0, 0, 0]);
    expect(east[1].corners[0]).toEqual([1, 0, 1]);
    expect(south[1].corners[0]).toEqual([0, 0, 1]);
    const roof = sceneryFaces('roof', { samples, roof: [1.15, 1.475, 1.8] });
    expect(roof[0].corners[0][1]).toBe(roof[2].corners[3][1]);
  });
});

describe.skipIf(!HAS_ROM)('ROM scenery integration', () => {
  it('identifies the authored props without changing any gameplay passability', async () => {
    const b = await bundle(), m = new AssetManifest(b);
    const seen = new Set<SceneryKind>();
    for (const ts of b.tilesets) for (let tile = 0; tile < ts.tileCount; tile++) {
      const v = m.tile(ts.id, tile);
      if (v.model) seen.add(v.model);
    }
    const flowers = m.square(c('tileset', 'OVERWORLD'), [3, 3, 0x2c, 0x2c]);
    expect(flowers.model).toBe('flowers');
    seen.add(flowers.model!);
    expect([...seen].sort()).toEqual(kinds.filter((k) => !['chair', 'ball'].includes(k)).sort());
    expect(m.sprite(c('sprite', 'SPRITE_BOULDER')).model).toBe('rock');
    expect(m.sprite(c('sprite', 'SPRITE_POKE_BALL')).model).toBe('ball');
    expect(m.sprite(c('sprite', 'SPRITE_RED')).model).toBeUndefined();
    for (const id of ['SPRITE_BOULDER', 'SPRITE_POKE_BALL']) {
      const v = m.sprite(c('sprite', id)), sp = b.sprites.find((s) => s.id === c('sprite', id))!;
      for (const pixel of v.modelPixels!) expect(sp.pixels[pixel]).not.toBe(0);
    }
    const gym = new WorldMap(b, c('map', 'VERMILION_GYM'));
    let bins = 0;
    for (let y = 0; y < gym.heightSquares; y++) for (let x = 0; x < gym.widthSquares; x++)
      if (m.tile(gym.data.tileset, gym.collisionTile(x, y)).model === 'bin') bins++;
    expect(bins).toBe(16); // Fifteen puzzle bins plus the one behind Surge.
    const forest = new WorldMap(b, c('map', 'VIRIDIAN_FOREST'));
    let parts = 0;
    for (let y = 0; y < forest.heightSquares; y++) for (let x = 0; x < forest.widthSquares; x++) {
      const tiles = [forest.tileAt(x * 2, y * 2), forest.tileAt(x * 2 + 1, y * 2), forest.tileAt(x * 2, y * 2 + 1), forest.tileAt(x * 2 + 1, y * 2 + 1)];
      const v = m.square(forest.data.tileset, tiles);
      if (v.part) parts++;
      if (v.kind === 'solid') expect(v.model).toBeDefined(); // No tree/stump cubes left.
    }
    expect(parts).toBeGreaterThan(100);
    const pallet = new WorldMap(b, c('map', 'PALLET_TOWN'));
    for (const sign of pallet.data.signs) expect(m.tile(pallet.data.tileset, pallet.collisionTile(sign.x, sign.y)).model).toBe('sign');
    expect(m.tile(c('tileset', 'OVERWORLD'), 0x3a).model).toBe('tree');
    expect(m.tile(c('tileset', 'OVERWORLD'), b.tileTables.waterTile).model).toBeUndefined();
    expect(m.square(c('tileset', 'LAB'), [3, 3, 0, 0]).model).toBeUndefined();
    for (const name of ['PALLET_TOWN', 'ROUTE_1', 'REDS_HOUSE_1F', 'OAKS_LAB', 'VIRIDIAN_FOREST', 'VERMILION_GYM', 'SS_ANNE_KITCHEN', 'POKEMON_TOWER_3F']) {
      const world = new WorldMap(b, c('map', name));
      for (let y = 0; y < world.heightSquares; y++) for (let x = 0; x < world.widthSquares; x++) {
        expect(world.isSquarePassable(x, y)).toBe(world.tileset.passable.includes(world.collisionTile(x, y)));
      }
    }
  });

  it('bakes props into one disposable mesh per map, including foreign tilesets', async () => {
    const b = await bundle(), manifest = new AssetManifest(b);
    const texture = new THREE.Texture();
    let calls = 0;
    const atlas = { texture, uv(tile: number): [number, number, number, number] {
      expect(Number.isInteger(tile)).toBe(true);
      expect(tile).toBeGreaterThanOrEqual(0);
      calls++;
      return [0, 0, 1, 1];
    }, drawTile() {}, recolor() {} };
    for (const name of ['PALLET_TOWN', 'ROUTE_1', 'REDS_HOUSE_1F', 'OAKS_LAB', 'VIRIDIAN_POKECENTER', 'ROUTE_23', 'ROUTE_17', 'VIRIDIAN_FOREST', 'CELADON_CITY', 'VERMILION_GYM']) {
      const world = new WorldMap(b, c('map', name));
      const built = buildMapMesh(world, manifest, atlas, { margin: 8, flatBorder: !isOutsideMap(world) });
      const geo = built.mesh.geometry;
      const pos = geo.getAttribute('position');
      expect(Array.from(pos.array).every(Number.isFinite)).toBe(true);
      expect(geo.getAttribute('uv').count).toBe(pos.count);
      expect(geo.getAttribute('color').count).toBe(pos.count);
      expect(geo.index!.count).toBeGreaterThan(0);
      expect(geo.index!.count / 3, name).toBeLessThan(RENDER_BUDGET.triangles);
      expect(built.mesh.children).toHaveLength(0);
      expect(Array.isArray(built.mesh.material)).toBe(false);
      let disposed = false;
      geo.addEventListener('dispose', () => { disposed = true; });
      built.dispose();
      expect(disposed).toBe(true);
    }
    expect(calls).toBeGreaterThan(1000);
    texture.dispose();
  });

  it('keeps every ROM map under the whole-map geometry budget at desktop border distance', async () => {
    const b = await bundle(), manifest = new AssetManifest(b), texture = new THREE.Texture();
    const atlas = { texture, uv: (): [number, number, number, number] => [0, 0, 1, 1], drawTile() {}, recolor() {} };
    for (const map of Object.values(b.maps)) {
      const world = new WorldMap(b, map.id);
      const built = buildMapMesh(world, manifest, atlas, { margin: 8, flatBorder: !isOutsideMap(world) });
      expect(built.mesh.geometry.index!.count / 3, map.constName).toBeLessThan(RENDER_BUDGET.triangles);
      built.dispose();
    }
    texture.dispose();
  });
});
