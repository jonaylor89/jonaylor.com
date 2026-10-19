import { describe, expect, it } from 'vitest';
import { battlePaletteIds, BATTLE_PALETTE_BLOCKS, healthBarColor, monsterPalette } from '../src/battle/palettes';
import { paletteColors } from '../src/render/palette';
import { BattleStage } from '../src/render/BattleStage';
import { Battle } from '../src/battle/Battle';
import { c } from '../src/rom/constants';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { makePartyMon } from '../src/game/pokemon';
import { newGameState } from '../src/game/state';

it('GetHealthBarColor uses the original 27/10-pixel thresholds', () => {
  expect([48, 27, 26, 10, 9, 0].map(healthBarColor)).toEqual([0, 0, 1, 1, 2, 2]);
});

describe.skipIf(!HAS_ROM)('battle palettes and 3D stage', () => {
  async function setup() {
    const b = await bundle(), state = newGameState(b, 7);
    const charmander = c('pokemon', 'CHARMANDER'), squirtle = c('pokemon', 'SQUIRTLE');
    state.player.map = c('map', 'ROUTE_1');
    state.party = [makePartyMon(b, { species: charmander, level: 20, dvs: 0xffff, otId: state.player.id, otName: state.player.name })];
    const h = new Harness(b, state);
    h.engine.loadMapData();
    const layouts: number[][] = [];
    h.engine.hooks.paletteLayout = (pals, blocks) => {
      layouts.push(pals);
      h.engine.screen.setPaletteLayout(pals.map((p) => paletteColors(b, p)), blocks);
    };
    const battle = new Battle(h.engine, { kind: 'wild', species: squirtle, level: 5, battleType: 0 });
    battle.whichPokemon = 0;
    battle.loadBattleMonFromParty();
    battle.enemySpecies2 = squirtle;
    battle.curEnemyLevel = 5;
    battle.loadEnemyMonData();
    battle.ui.enter();
    battle.setBattlePalette();
    battle.ui.setEnemyPic(b.pics.front[squirtle]);
    battle.ui.setPlayerBackPic(b.pics.back[charmander]);
    return { b, h, battle, layouts, charmander, squirtle };
  }

  it('implements PAL_SET/ATTR_BLK for both mons, HP bars, and the message box', async () => {
    const { b, h, battle, layouts, charmander, squirtle } = await setup();
    const pals = battlePaletteIds(b, charmander, squirtle, 0, 0);
    expect(layouts.at(-1)).toEqual(pals);
    const s = h.engine.screen;
    expect(s.paletteAt(1, 5)).toBe(2);
    expect(s.paletteAt(12, 0)).toBe(3);
    expect(s.paletteAt(2, 2)).toBe(1);
    expect(s.paletteAt(10, 9)).toBe(0);
    expect(s.paletteAt(1, 14)).toBe(2);
    expect(s.colorAt(1, 5, 1)).toEqual(paletteColors(b, pals[2])[1]);
    expect(s.colorAt(12, 0, 1)).toEqual(paletteColors(b, pals[3])[1]);
    battle.player.mon.maxHp = 48;
    battle.player.mon.hp = 9;
    battle.drawPlayerHUDAndHPBar();
    expect(layouts.at(-1)![0]).toBe(c('palette', 'PAL_REDBAR'));
    battle.enemy.mon.maxHp = 48;
    battle.enemy.mon.hp = 26;
    battle.drawEnemyHUDAndHPBar();
    expect(layouts.at(-1)![1]).toBe(c('palette', 'PAL_YELLOWBAR'));
    expect(BATTLE_PALETTE_BLOCKS).toHaveLength(5);
  });

  it('ChangeMonPic reapplies the original party palette through Transform, not the copied species', async () => {
    const { b, battle, layouts, charmander, squirtle } = await setup();
    const before = layouts.length;
    battle.whoseTurn = 0;
    const co = battle.anim.playAnimation(c('move', 'TRANSFORM'));
    let frames = 0;
    while (!co.next().done) if (++frames > 10000) throw new Error('Transform did not finish');
    expect(layouts.length).toBeGreaterThan(before);
    expect(layouts.at(-1)![2]).toBe(monsterPalette(b, charmander));
    expect(layouts.at(-1)![3]).toBe(monsterPalette(b, squirtle));
    battle.player.mon.species = squirtle; // battle stats can be transformed too
    battle.setBattlePalette();
    expect(layouts.at(-1)![2]).toBe(monsterPalette(b, charmander));
  });

  it('updates HP palettes only after the bar animation and restores them after menus', async () => {
    const { battle, layouts, h } = await setup();
    battle.player.mon.maxHp = 48;
    battle.player.mon.hp = 9;
    const co = battle.updateHPBar(0, 48);
    co.next();
    expect(layouts.at(-1)![0]).toBe(c('palette', 'PAL_GREENBAR'));
    while (!co.next().done) { /* pixel animation */ }
    expect(layouts.at(-1)![0]).toBe(c('palette', 'PAL_REDBAR'));
    battle.saveScreen1();
    h.engine.screen.setPalette([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    battle.loadScreen1();
    expect(h.engine.screen.paletteAt(12, 0)).toBe(3);
  });

  it('billboards mirror the current pic tiles, fades, blank/fainted areas, and reduced motion', async () => {
    const { battle, h } = await setup();
    const stage = new BattleStage();
    try {
      stage.update(h.engine.screen, 0);
      expect(stage.actors.every((a) => a.visible)).toBe(true);
      const texture = stage.actors[0].material.map!;
      const version = texture.version;
      stage.update(h.engine.screen, 0);
      expect(texture.version).toBe(version);
      const oldPixels = Array.from(texture.image.data);
      h.engine.screen.setFadeMap([3, 3, 3, 3]);
      stage.update(h.engine.screen, 1);
      expect(Array.from(texture.image.data)).not.toEqual(oldPixels);
      stage.animation(c('move', 'TACKLE'), 0, 10);
      stage.update(h.engine.screen, 22);
      expect(stage.actors[0].position.x).toBeGreaterThan(-3);
      stage.update(h.engine.screen, 22, true);
      expect(stage.actors[0].position.x).toBe(-3);
      battle.ui.clearArea(1, 5, 7, 7);
      stage.update(h.engine.screen, 23);
      expect(stage.actors[0].visible).toBe(false);
      expect(stage.actors[1].visible).toBe(true);
    } finally { stage.dispose(); }
    expect(stage.scene.children).toHaveLength(0);
  });

  it('objects and BG use the same SGB cell colours, but only BG uses BGP flashes', async () => {
    const { h } = await setup();
    const s = h.engine.screen;
    const normal = s.colorAt(12, 0, 3, false);
    s.setShadeMap([0, 0, 0, 0]);
    expect(s.colorAt(12, 0, 3, false)).toEqual(normal);
    expect(s.colorAt(12, 0, 3, true)).toEqual(s.colorAt(12, 0, 0, false));
  });
});
