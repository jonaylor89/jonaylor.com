/**
 * Battle engine: damage formula, crits, accuracy, type matchups, random
 * factor, stat stages and the Gen 1 quirks, plus end-to-end wild battles and
 * a capture on the real engine.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { newGameState, type GameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import type { GameBundle } from '../src/data/schema';
import type { Co } from '../src/engine/Engine';
import { Battle } from '../src/battle/Battle';
import {
  adjustDamageForMoveType,
  applyBadgeStatBoosts,
  calculateDamage,
  criticalHitTest,
  getDamageVarsForPlayerAttack,
  moveHitTest,
  randomizeDamage,
} from '../src/battle/moves';
import { jumpMoveEffect } from '../src/battle/effects';
import { useBagItem } from '../src/battle/menus';
import { S2, E } from '../src/battle/state';

const P = (n: string) => c('pokemon', n);
const M = (n: string) => c('move', n);
const T = (n: string) => c('type', n);

/** Run a coroutine to the end, pressing `button` on alternate frames. */
function drive<R>(h: Harness, co: Co<R>, button: 'a' | 'b' = 'a', max = 200000): R {
  for (let i = 0; i < max; i++) {
    const held = new Set<'a' | 'b'>(i % 4 < 2 ? [button] : []);
    h.engine.input = { held, pressed: i % 4 === 0 ? new Set([button]) : new Set() } as never;
    const r = co.next();
    if (r.done) return r.value as R;
  }
  throw new Error('coroutine did not finish');
}

describe.skipIf(!HAS_ROM)('battle engine', () => {
  let b0: GameBundle;
  beforeAll(async () => {
    b0 = await bundle();
  });

  it('preserves party HP/status when a scripted battle never sends out a player mon', () => {
    for (const kind of ['BATTLE_TYPE_OLD_MAN', 'BATTLE_TYPE_PIKACHU', 'BATTLE_TYPE_SAFARI']) {
      const state = newGameState(b0, 0x1234);
      const mon = makePartyMon(b0, { species: P('PIKACHU'), level: 12, dvs: 0xffff, otId: state.player.id, otName: state.player.name });
      mon.hp = 17; mon.status = 8; mon.boxLevel = 7;
      state.party = [mon];
      const h = new Harness(b0, state);
      const b = new Battle(h.engine, { kind: 'wild', species: P('RATTATA'), level: 5, battleType: c('battle', kind) });
      expect(b.player.mon.species).toBe(0);
      b.commit();
      expect(h.store.state.party).toEqual([mon]);
    }
  });

  it('awards the two-byte BCD base times the final enemy level, not 100× the prize', () => {
    const h = new Harness(b0, newGameState(b0, 7));
    const b = new Battle(h.engine, { kind: 'trainer', trainerClass: c('trainer', 'BROCK'), trainerNo: 1, battleType: 0 });
    b.trainerClass = c('trainer', 'BROCK'); b.trainerNo = 1;
    b.getTrainerInformation(); b.readTrainer();
    expect(b.trainerBaseMoney).toBe(99);
    expect(b.amountMoneyWon).toBe(1188); // Onix L12 × ¥99
  });

  function setup(player: [string, number], enemy: [string, number], rolls: number[] = [], st?: GameState) {
    const state = st ?? newGameState(b0, 0x1234);
    state.party = [makePartyMon(b0, { species: P(player[0]), level: player[1], dvs: 0xffff, otId: state.player.id, otName: state.player.name })];
    state.player.map = c('map', 'ROUTE_1');
    const h = new Harness(b0, state);
    h.run(5);
    const b = new Battle(h.engine, { kind: 'wild', species: P(enemy[0]), level: enemy[1], battleType: 0 });
    const queue = [0, 0, ...rolls]; // LoadEnemyMonData rolls the DVs first
    b.random = () => {
      const v = queue.shift();
      if (v === undefined) throw new Error('out of random rolls');
      return v;
    };
    b.whichPokemon = 0;
    b.loadBattleMonFromParty();
    b.enemySpecies2 = P(enemy[0]);
    b.curEnemyLevel = enemy[1];
    b.loadEnemyMonData();
    b.whoseTurn = 0;
    return { h, b, queue };
  }

  function setMove(b: Battle, power: number, type: number, effect = 0, num = M('TACKLE')) {
    b.att.move = { num, effect, power, type, accuracy: 255, maxPP: 35 };
    b.att.selectedMove = num;
  }

  function damage(b: Battle, h: Harness): number {
    getDamageVarsForPlayerAttack(b);
    drive(h, calculateDamage(b, true));
    return b.damage;
  }

  it('applies the damage formula: ((2L/5+2)·P·A/D)/50 capped at 997, +2', () => {
    const { b, h } = setup(['PIKACHU', 50], ['RATTATA', 5]);
    setMove(b, 100, T('NORMAL'));
    b.player.mon.atk = 100;
    b.enemy.mon.def = 100;
    expect(damage(b, h)).toBe(46);
    // stats over 255 are both divided by 4 (only the low byte of the result is used)
    b.player.mon.atk = 400;
    b.enemy.mon.def = 400;
    expect(damage(b, h)).toBe(46);
    // the cap
    b.player.mon.atk = 255;
    b.enemy.mon.def = 1;
    setMove(b, 255, T('NORMAL'));
    expect(damage(b, h)).toBe(999);
  });

  it('applies STAB, then each type matchup in table order; immunity misses', () => {
    const { b } = setup(['PIKACHU', 20], ['PIDGEY', 20]);
    setMove(b, 40, T('ELECTRIC'));
    b.damage = 20;
    b.damageMultipliers = 10;
    adjustDamageForMoveType(b);
    expect(b.damage).toBe(60); // ×1.5 STAB, ×2 vs Flying
    expect(b.damageMultipliers & 0x80).toBeTruthy();
    b.enemy.mon.types = [T('GROUND'), T('GROUND')];
    b.damage = 20;
    b.damageMultipliers = 10;
    b.moveMissed = 0;
    adjustDamageForMoveType(b);
    expect(b.damage).toBe(0);
    expect(b.moveMissed).toBe(1);
  });

  it('randomizes damage by r/255 with r in 217-255 (rotated random byte)', () => {
    const { b } = setup(['PIKACHU', 20], ['PIDGEY', 20], [0x00, 0xb3]);
    b.damage = 100;
    randomizeDamage(b);
    expect(b.damage).toBe(85); // 0 is rejected, 0xb3 rotates to 217
  });

  it('crits use base Speed/2, ×8 for high-crit moves, and Focus Energy quarters the rate', () => {
    // Pikachu: base Speed 90 → threshold 45 for normal moves
    const rot = (v: number) => ((v >> 3) | (v << 5)) & 0xff; // inverse of rlc ×3
    const { b } = setup(['PIKACHU', 20], ['PIDGEY', 20], [rot(44), rot(45)]);
    setMove(b, 40, T('NORMAL'));
    criticalHitTest(b);
    expect(b.criticalHitOrOHKO).toBe(1);
    criticalHitTest(b);
    expect(b.criticalHitOrOHKO).toBe(0);
    const { b: b2 } = setup(['PIKACHU', 20], ['PIDGEY', 20], [rot(22), rot(21)]);
    setMove(b2, 40, T('NORMAL'));
    b2.player.s2 |= S2.GETTING_PUMPED;
    criticalHitTest(b2);
    expect(b2.criticalHitOrOHKO).toBe(0); // 45/2/2 = 11
    const { b: b3 } = setup(['PIKACHU', 20], ['PIDGEY', 20], [rot(254)]);
    setMove(b3, 70, T('NORMAL'), 0, M('SLASH'));
    criticalHitTest(b3);
    expect(b3.criticalHitOrOHKO).toBe(1); // capped at 255
  });

  it('can miss a 100% move when the random byte is 255', () => {
    const { b } = setup(['PIKACHU', 20], ['PIDGEY', 20], [254, 255]);
    setMove(b, 40, T('NORMAL'));
    moveHitTest(b);
    expect(b.moveMissed).toBe(0);
    b.att.move.accuracy = 255;
    moveHitTest(b);
    expect(b.moveMissed).toBe(1);
  });

  it('Swift never misses and Dream Eater misses an awake target', () => {
    const { b } = setup(['PIKACHU', 20], ['PIDGEY', 20], [255]);
    setMove(b, 60, T('NORMAL'), E.SWIFT_EFFECT, M('SWIFT'));
    b.enemy.s1 = 1 << c('battle', 'INVULNERABLE');
    moveHitTest(b);
    expect(b.moveMissed).toBe(0);
    b.enemy.s1 = 0;
    setMove(b, 100, T('PSYCHIC_TYPE'), E.DREAM_EATER_EFFECT, M('DREAM_EATER'));
    moveHitTest(b);
    expect(b.moveMissed).toBe(1);
  });

  it('badge boosts add 1/8 and are reapplied by every stat-raising move', () => {
    const st = newGameState(b0, 1);
    st.badges = 1; // Boulder Badge → Attack
    const { b, h } = setup(['PIKACHU', 50], ['PIDGEY', 5], [], st);
    const base = b.player.unmod.atk;
    expect(b.player.mon.atk).toBe(base + (base >> 3));
    // Growth (Special +1) reapplies the Attack boost on top of the boosted value
    setMove(b, 0, T('NORMAL'), E.SPECIAL_UP1_EFFECT, M('GROWTH'));
    drive(h, jumpMoveEffect(b));
    const once = base + (base >> 3);
    expect(b.player.mon.atk).toBe(once + (once >> 3));
    applyBadgeStatBoosts(b);
  });

  it('Recover fails when max HP − HP is 255 (only the low bytes are compared)', () => {
    const { b, h } = setup(['CHANSEY', 60], ['PIDGEY', 5]);
    b.player.mon.maxHp = 300;
    b.player.mon.hp = 45;
    setMove(b, 0, T('NORMAL'), E.HEAL_EFFECT, M('SOFTBOILED'));
    drive(h, jumpMoveEffect(b));
    expect(b.player.mon.hp).toBe(45);
    b.player.mon.hp = 46;
    drive(h, jumpMoveEffect(b));
    expect(b.player.mon.hp).toBe(196);
  });

  it('runs from wild battles with the speed formula (+30 per attempt)', () => {
    const { b, h } = setup(['PIKACHU', 5], ['PIDGEY', 5], [65, 64]);
    // 50·32 / (100/4) = 64
    expect(drive(h, b.tryRunningFromBattle(50, 100))).toBe(false);
    expect(drive(h, b.tryRunningFromBattle(50, 100))).toBe(true);
    expect(b.numRunAttempts).toBe(2);
  });

  it('catches a wild Pokémon with a Master Ball and adds it to the party', () => {
    const st = newGameState(b0, 0x77);
    st.bag = [{ item: c('item', 'MASTER_BALL'), qty: 1 }];
    const { b, h } = setup(['PIKACHU', 5], ['PIDGEY', 3], [0x80], st);
    b.ui.enter();
    b.saveScreen1();
    const r = drive(h, useBagItem(b, c('item', 'MASTER_BALL')), 'b');
    expect(r).toBe('caught');
    expect(b.party.length).toBe(2);
    expect(b.party[1]).toMatchObject({ species: P('PIDGEY'), level: 3, nickname: 'PIDGEY', otId: st.player.id });
    expect(b.bag.length).toBe(0);
  });

  it('plays a whole wild battle on Route 1 and gains experience', () => {
    const st = newGameState(b0, 0x3141);
    st.player.map = c('map', 'ROUTE_1');
    st.player.x = 10;
    st.player.y = 6;
    st.party = [makePartyMon(b0, { species: P('CHARMANDER'), level: 20, dvs: 0xffff, otId: st.player.id, otName: st.player.name })];
    const exp0 = st.party[0].exp;
    const h = new Harness(b0, st);
    h.run(10);
    let battles = 0;
    for (let i = 0; i < 4000 && battles === 0; i++) {
      h.step([Math.floor(i / 20) % 2 ? 'up' : 'down']);
      if (h.inBattle) {
        battles++;
        h.finishBattle();
      }
    }
    expect(battles).toBe(1);
    expect(h.store.state.party[0].exp).toBeGreaterThan(exp0);
    expect(h.mapName).toBe('ROUTE_1');
    expect(h.engine.screen.get(0, 0)).not.toBe(0x7f); // back in the overworld
  });
});
