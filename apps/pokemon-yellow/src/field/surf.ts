/**
 * Surfing: ItemUseSurfboard (engine/items/item_effects.asm), the START menu's
 * Surf (engine/menus/start_sub_menus.asm .surf + IsSurfingAllowed in
 * engine/overworld/field_move_messages.asm), IsNextTileShoreOrWater and the
 * shore rule of CollisionCheckOnWater (home/overworld.asm).
 */
import type { Co, Engine } from '../engine/Engine';
import type { ItemContext } from '../items/useItem';
import type { PartyMon } from '../game/state';
import { c } from '../rom/constants';
import { useItem, print, itemUseFailed } from '../items/useItem';
import { tilePairBlocked } from '../world/movement';
import { PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP } from '../engine/pad';

/** The lower-left tile of the square in front of the player (GetTileAndCoordsInFrontOfPlayer). */
export function tileInFrontOfPlayer(e: Engine): number {
  const [fx, fy] = e.frontOfPlayer();
  return e.world.collisionTile(fx, fy);
}

/** IsNextTileShoreOrWater: a water tileset and the tile ahead is water (or shore). */
export function isNextTileShoreOrWater(e: Engine): boolean {
  const tt = e.bundle.tileTables;
  const ts = e.world.data.tileset;
  if (!tt.waterTilesets.includes(ts)) return false;
  const tile = tileInFrontOfPlayer(e);
  const noShore = ['SHIP_PORT', 'GYM', 'DOJO'].some((n) => c('tileset', n) === ts);
  return noShore ? tile === tt.waterTile : tt.shoreTiles.includes(tile);
}

/** CheckForTilePairCollisions with TilePairCollisionsWater for the square ahead. */
function waterPairBlocked(e: Engine): boolean {
  const p = e.state.player;
  return tilePairBlocked(e.world, e.world.collisionTile(p.x, p.y), tileInFrontOfPlayer(e), true);
}

/** .makePlayerMoveForward: one simulated press in the facing direction. */
function makePlayerMoveForward(e: Engine): void {
  const pad = { up: PAD_UP, down: PAD_DOWN, left: PAD_LEFT, right: PAD_RIGHT }[e.state.player.facing];
  e.ram.simulatedJoypad = [pad];
  e.ram.overrideSimulatedMask = 0;
  e.ram.simulatedIndex = 1;
}

/** ItemUseSurfboard */
export function* itemUseSurfboard(x: ItemContext): Co {
  const e = x.e;
  if (e.state.player.mode !== 'surf') {
    if (!isNextTileShoreOrWater(e) || waterPairBlocked(e)) return yield* itemUseFailed(x, '_NoSurfingHereText');
    makePlayerMoveForward(e);
    e.ram.scriptedMovementState = true;
    e.store.dispatch({ type: 'setMode', mode: 'surf' }, { undoable: false });
    e.playDefaultMusic();
    return yield* print(x, '_SurfingGotOnText');
  }
  // .tryToStopSurfing
  const [fx, fy] = e.frontOfPlayer();
  if (e.spriteInFront(fx, fy) || waterPairBlocked(e) || !e.world.isSquarePassable(fx, fy)) {
    return yield* print(x, '_SurfingNoPlaceToGetOffText');
  }
  makePlayerMoveForward(e);
  stopSurfing(e);
  e.ram.scriptedMovementState = true;
  e.ram.joyIgnore = 0xff;
  e.updateSprites();
}

/** Back to walking: Pikachu reappears behind the player (wPikachuSpawnState 3, overworld flag 5). */
export function stopSurfing(e: Engine): void {
  e.pikachu.spawnState = 3;
  e.ram.pikachuOverworldStateFlags |= 1 << 5;
  e.store.dispatch({ type: 'setMode', mode: 'walk' }, { undoable: false });
  e.env.setVar('wd472', 0);
  e.playDefaultMusic();
}

/** IsSurfingAllowed: not while forced onto the bike, nor at Seafoam B4F's stairs before the boulders. */
function* isSurfingAllowed(e: Engine): Co<boolean> {
  if (e.ram.alwaysOnBike) {
    yield* e.printText('CyclingIsFunText');
    return false;
  }
  if (e.world.data.id !== c('map', 'SEAFOAM_ISLANDS_B4F')) return true;
  if (e.event('EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE') && e.event('EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE')) return true;
  const p = e.state.player;
  if (p.x !== 7 || p.y !== 11) return true;
  yield* e.printText('CurrentTooFastText');
  return false;
}

/** START menu → POKéMON → SURF */
export function* surfFieldMove(e: Engine, party: PartyMon[], which: number): Co<'close' | 'back'> {
  if (!(yield* isSurfingAllowed(e))) return 'back';
  // wd472: 2 = the starter Pikachu surfs, 1 = another mon (Seel sprite)
  e.env.setVar('wd472', party[which].species === c('pokemon', 'STARTER_PIKACHU') ? 2 : 1);
  const item = c('item', 'SURFBOARD');
  if (!(yield* useItem(e, item, { pseudo: item }))) {
    e.env.setVar('wd472', 0);
    return 'back';
  }
  return 'close';
}

export function registerSurf(e: Engine): void {
  e.fieldItems.SURFBOARD = itemUseSurfboard;
  e.fieldMoves.SURF = surfFieldMove;
}
