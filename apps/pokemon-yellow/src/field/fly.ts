/**
 * Fly and the Town Map item: the START menu's .fly (engine/menus/start_sub_menus.asm)
 * with CheckIfInOutsideMap and ChooseFlyDestination, and ItemUseTownMap.
 */
import type { Engine } from '../engine/Engine';
import { isOutsideMap } from '../world/movement';
import { chooseFlyDestination, displayTownMap } from '../ui/townMap';
import { itemUseNotTime } from '../items/useItem';

export function registerFly(e: Engine): void {
  e.townMap = displayTownMap;
  e.fieldItems.TOWN_MAP = function* (x) {
    if (x.battle) return yield* itemUseNotTime(x);
    yield* displayTownMap(x.e);
  };
  e.fieldMoves.FLY = function* (e, party, which) {
    if (!isOutsideMap(e.world)) {
      e.ram.nameBuffer = party[which].nickname;
      yield* e.printText('_CannotFlyHereText');
      return 'back';
    }
    return (yield* chooseFlyDestination(e)) ? 'close' : 'back';
  };
}
