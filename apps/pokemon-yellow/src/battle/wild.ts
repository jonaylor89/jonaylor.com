/**
 * TryDoWildEncounter (engine/battle/wild_encounters.asm): decides on the
 * step that just finished whether a wild Pokémon appears, using the
 * per-frame hRandomAdd/hRandomSub, the map's grass/water rates and slot
 * table, and Repel.
 */
import type { Co, Engine } from '../engine/Engine';
import { c } from '../rom/constants';
import { standingOnDoorOrWarpTile } from '../world/movement';

const WATER_TILE = 0x14;

/** Returns {species, level} if a wild battle starts (wCurOpponent / wCurEnemyLevel). */
export function* tryDoWildEncounter(e: Engine): Co<{ species: number; level: number } | undefined> {
  const r = e.ram;
  if (r.npcMovementScriptTable) return undefined;
  if (r.standingOnDoor || r.exitingDoor || r.standingOnWarp || r.ledgeOrFishing) return undefined;
  const p = e.state.player;
  const w = e.world;
  if (standingOnDoorOrWarpTile(w, p.x, p.y)) return undefined;
  // IsPlayerJustOutsideMap
  if (p.y === w.heightSquares || p.x === w.widthSquares) return undefined;
  if (r.repelRemainingSteps) {
    r.repelRemainingSteps--;
    if (!r.repelRemainingSteps) {
      // DisplayTextID(TEXT_REPEL_WORE_OFF)
      yield* e.printText('_RepelWoreOffText');
      yield* e.waitForTextScrollButtonPress();
      e.closeTextDisplay();
      return undefined;
    }
  }
  // the bottom-left tile of the square the player stands on
  const tile = w.collisionTile(p.x, p.y);
  const map = w.data.id;
  const grass = e.bundle.wild.grass[map];
  const water = e.bundle.wild.water[map];
  const grassTile = e.bundle.tilesets[w.data.tileset].grassTile;
  let rate: number | undefined;
  let table = grass;
  if (tile === grassTile && grassTile !== 0xff) rate = grass?.rate ?? 0;
  else if (tile === WATER_TILE) {
    rate = water?.rate ?? 0;
    table = water;
  } else if (map >= c('map', 'FIRST_INDOOR_MAP') && w.data.tileset !== c('tileset', 'FOREST')) rate = grass?.rate ?? 0;
  if (rate === undefined) return undefined;
  if (e.rng.hRandomAdd >= rate) return undefined;
  const sub = e.rng.hRandomSub;
  const chances = e.bundle.wild.slotChances;
  let slot = 0;
  while (slot < chances.length - 1 && chances[slot] < sub) slot++;
  const mon = table?.slots[slot];
  if (!mon) return undefined;
  if (r.repelRemainingSteps && mon.level < e.state.party[0].level) return undefined;
  return { species: mon.species, level: mon.level };
}
