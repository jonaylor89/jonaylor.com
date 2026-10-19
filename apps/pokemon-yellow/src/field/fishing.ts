/**
 * Fishing: ItemUseOldRod/GoodRod/SuperRod, FishingInit and RodResponse
 * (engine/items/item_effects.asm), ReadSuperRodData (engine/items/super_rod.asm)
 * and FishingAnim (engine/overworld/player_animations.asm).
 */
import type { Co, Engine } from '../engine/Engine';
import type { ItemContext } from '../items/useItem';
import { itemUseNotTime, print } from '../items/useItem';
import { isNextTileShoreOrWater } from './surf';

/** wRodResponse */
const NO_BITE = 0;
const BITE = 1;
const NOTHING_HERE = 2;

/** FishingInit: false when the player can't fish here (not facing water, or surfing). */
function* fishingInit(x: ItemContext): Co<boolean> {
  const e = x.e;
  if (!isNextTileShoreOrWater(e) || e.state.player.mode === 'surf') return false;
  e.updateSprites();
  yield* print(x, '_ItemUseText001', '<low>', '_ItemUseText002');
  e.env.playSound('heal_ailment');
  e.ram.pikachuEmotionModifier = 2;
  e.store.dispatch({ type: 'setPikachu', mood: 0x81 }, { undoable: false });
  yield* e.delayFrames(80);
  return true;
}

/** ItemUseOldRod / ItemUseGoodRod / ItemUseSuperRod */
function rod(kind: 'old' | 'good' | 'super') {
  return function* (x: ItemContext): Co {
    const e = x.e;
    if (!(yield* fishingInit(x))) return yield* itemUseNotTime(x);
    const wild = e.bundle.wild;
    let response = NO_BITE;
    let mon: { species: number; level: number } | undefined;
    if (kind === 'old') {
      response = BITE;
      mon = wild.oldRod;
    } else if (kind === 'good') {
      // .RandomLoop: bit 0 → no bite; else bits 1-2 pick one of the two mons (retry on 2-3)
      for (;;) {
        const r = e.random();
        if (r & 1) {
          response = NO_BITE;
          break;
        }
        const i = (r >> 1) & 3;
        if (i >= 2) continue;
        response = BITE;
        mon = wild.goodRod[i];
        break;
      }
    } else {
      const slots = wild.superRod[e.world.data.id];
      if (!slots) response = NOTHING_HERE;
      else {
        // GenerateRandomFishingEncounter, before the 50% bite roll
        const r = e.random();
        mon = slots[r < 0x66 ? 0 : r < 0xb2 ? 1 : r < 0xe5 ? 2 : 3];
        response = e.random() & 1 ? BITE : NO_BITE;
      }
    }
    if (response === BITE && mon) {
      e.ram.fishingBattle = true; // wMoveMissed
      e.ram.curEnemyLevel = mon.level;
      e.ram.curOpponent = mon.species;
    }
    // DoNotGenerateFishingEncounter: FishingAnim with wWalkBikeSurfState cleared
    yield* fishingAnim(e, response);
  };
}

/** FishingAnim: the fishing pose and rod, then "No nibble", "nothing here" or the shake and "!" */
export function* fishingAnim(e: Engine, response: number): Co {
  yield* e.delayFrames(10);
  e.ram.ledgeOrFishing = true;
  e.ram.fishing = { rod: true, shake: 0 };
  yield* e.delayFrames(100);
  let text = '_NoNibbleText';
  if (response === NOTHING_HERE) text = '_NothingHereText';
  else if (response === BITE) {
    for (let i = 0; i < 10; i++) {
      e.ram.fishing.shake ^= 1;
      yield* e.delayFrames(3);
    }
    // the rod is hidden under the "!" bubble when facing up
    if (e.state.player.facing === 'up') e.ram.fishing.rod = false;
    yield* e.env.emotionBubble(0, 'EXCLAMATION_BUBBLE');
    e.ram.fishing.rod = true;
    text = '_ItsABiteText';
  }
  yield* e.printText(text);
  e.ram.ledgeOrFishing = false;
  e.ram.fishing = undefined;
}

export function registerFishing(e: Engine): void {
  e.fieldItems.OLD_ROD = rod('old');
  e.fieldItems.GOOD_ROD = rod('good');
  e.fieldItems.SUPER_ROD = rod('super');
}

/** The rod sprite's offset from the player square per facing (FishingRodOAM). */
export const ROD_OFFSET: Record<string, [number, number, number]> = {
  down: [0, 0.5, 0],
  up: [0, 0, 1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

