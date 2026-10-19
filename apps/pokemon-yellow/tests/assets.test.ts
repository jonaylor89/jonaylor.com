import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { AssetManifest, MissingAssetError } from '../src/render/manifest';
import { tokenize } from '../src/ui/TextPrinter';
import { walkTextOps } from '../src/rom/text';
import { WorldMap } from '../src/world/WorldMap';

describe.skipIf(!HAS_ROM)('asset manifest', () => {
  it('has a 3D representation for every tile used by every map', async () => {
    const b = await bundle();
    const m = new AssetManifest(b);
    for (const map of Object.values(b.maps)) {
      const w = new WorldMap(b, map.id);
      for (let sy = -8; sy < w.heightSquares + 8; sy++)
        for (let sx = -8; sx < w.widthSquares + 8; sx++) {
          const owner = w.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2));
          expect(() => m.tile(owner.id, w.collisionTile(sx, sy))).not.toThrow();
        }
    }
  });

  it('has a representation for every object sprite and fails loudly otherwise', async () => {
    const b = await bundle();
    const m = new AssetManifest(b);
    for (const map of Object.values(b.maps)) for (const o of map.objects) expect(m.sprite(o.sprite).frames).toBeGreaterThan(0);
    expect(() => m.sprite(0xee)).toThrow(MissingAssetError);
    expect(() => m.tile(0, 0xfe)).toThrow(MissingAssetError);
  });

  it('classifies key Pallet Town / Route 1 tiles', async () => {
    const b = await bundle();
    const m = new AssetManifest(b);
    const ow = 0;
    expect(m.tile(ow, b.tileTables.waterTile).kind).toBe('water');
    expect(m.tile(ow, b.tilesets[ow].grassTile).kind).toBe('grass');
    expect(m.tile(ow, 0x36).kind).toBe('ledge');
    expect(m.tile(ow, 0x1b).kind).toBe('door');
  });
});

describe.skipIf(!HAS_ROM)('text rendering', () => {
  it('every extracted text tokenizes into printable glyphs and known controls', async () => {
    const b = await bundle();
    const known = new Set(['next', 'line', 'para', 'cont', '_cont', 'scroll', 'page', 'done', 'prompt', 'dexend', 'player', 'rival', 'target', 'user', 'null', 'poke', 'pc', 'tm', 'trainer', 'rocket', 'sixdots', 'pkmn']);
    for (const [label, ops] of Object.entries(b.texts))
      for (const op of walkTextOps(ops))
        if (op.t === 'text')
          for (const tok of tokenize(op.v)) if ('ctl' in tok) expect(known.has(tok.ctl), `${label}: {${tok.ctl}}`).toBe(true);
  });
});
