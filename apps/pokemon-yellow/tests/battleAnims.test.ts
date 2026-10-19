/** Battle animations (MoveAnimator): every animation runs on both sides. */
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { newGameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import { Battle } from '../src/battle/Battle';
import type { Co } from '../src/engine/Engine';

function run(co: Co, max = 20000): number {
  for (let i = 0; i < max; i++) if (co.next().done) return i;
  throw new Error('animation did not finish');
}

describe.skipIf(!HAS_ROM)('battle animations', () => {
  async function setup() {
    const b0 = await bundle();
    const state = newGameState(b0, 0x1234);
    state.party = [makePartyMon(b0, { species: c('pokemon', 'PIKACHU'), level: 20, dvs: 0xffff, otId: state.player.id, otName: state.player.name })];
    state.player.map = c('map', 'ROUTE_1');
    const h = new Harness(b0, state);
    h.run(5);
    const b = new Battle(h.engine, { kind: 'wild', species: c('pokemon', 'PIDGEY'), level: 5, battleType: 0 });
    b.whichPokemon = 0;
    b.loadBattleMonFromParty();
    b.enemySpecies2 = c('pokemon', 'PIDGEY');
    b.curEnemyLevel = 5;
    b.loadEnemyMonData();
    b.ui.enter();
    b.ui.setEnemyPic(b0.pics.front[c('pokemon', 'PIDGEY')]);
    b.ui.setPlayerBackPic(b0.pics.back[c('pokemon', 'PIKACHU')]);
    return { b0, h, b };
  }

  it('plays every attack animation for both sides and cleans up', async () => {
    const { b0, h, b } = await setup();
    const n = c('move', 'NUM_ATTACK_ANIMS');
    expect(b0.battleAnims.attacks.length).toBe(n);
    let objectsSeen = 0;
    for (let id = 1; id <= n; id++) {
      for (const turn of [0, 1]) {
        b.whoseTurn = turn;
        b.anim.setAnimationPalette();
        const co = b.anim.playAnimation(id);
        for (let i = 0; ; i++) {
          if (i > 20000) throw new Error(`animation ${id} did not finish`);
          if (co.next().done) break;
          if (h.engine.screen.objects.length) objectsSeen++;
        }
        // restore the pics an animation hid or changed
        b.ui.setEnemyPic(b0.pics.front[c('pokemon', 'PIDGEY')]);
        b.ui.setPlayerBackPic(b0.pics.back[c('pokemon', 'PIKACHU')]);
        h.engine.screen.setShadeMap(undefined);
      }
    }
    expect(objectsSeen).toBeGreaterThan(1000);
  });

  it("Pound draws its star frame block over the enemy", async () => {
    const { b0, h, b } = await setup();
    b.whoseTurn = 0;
    b.anim.setAnimationPalette();
    const co = b.anim.playAnimation(c('move', 'POUND'));
    co.next();
    co.next();
    // FrameBlock01 (nine tiles) at BASECOORD_0F
    const objs = h.engine.screen.objects;
    expect(objs.length).toBe(b0.battleAnims.frameBlocks[1].length);
    expect(Math.min(...objs.map((o) => o.x))).toBeGreaterThanOrEqual(80);
    run(co);
    expect(h.engine.screen.objects.length).toBe(0);
  });

  it('Tackle moves the pic one tile toward the foe and back', async () => {
    const { h, b } = await setup();
    b.whoseTurn = 0;
    const s = h.engine.screen;
    const before = s.get(1, 5);
    const co = b.anim.playAnimation(c('move', 'TACKLE'));
    let moved = false;
    for (let i = 0; i < 2000; i++) {
      if (co.next().done) break;
      if (s.get(2, 5) === before && s.get(1, 5) !== before) moved = true;
    }
    expect(moved).toBe(true);
    expect(s.get(1, 5)).toBe(before);
  });

  it('the Poké Ball toss: shakes and the caught mon stays hidden', async () => {
    const { h, b } = await setup();
    b.whoseTurn = 0;
    b.anim.pokeBallAnimData = 0x43; // four animations, three shakes
    b.anim.curItem = c('item', 'POKE_BALL');
    const frames = run(b.anim.tossBall(0x43, c('item', 'POKE_BALL')));
    expect(frames).toBeGreaterThan(150);
    // HIDEPIC_ANIM ran: the enemy pic area is blank
    expect(h.engine.screen.get(15, 3)).toBe(0x7f);
  });
});
