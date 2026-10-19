/** Port of scripts/BluesHouse.asm */
import type { MapScript } from '../types';

export const BluesHouse: MapScript = {
  map: 'BLUES_HOUSE',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    // `xor a; call CallFunctionInTable`: the table index is always 0 (BluesHouseDefaultScript).
    e.setEvent('EVENT_ENTERED_BLUES_HOUSE');
    e.curScript = e.s('SCRIPT_BLUESHOUSE_NOOP');
  },
  texts: {
    *BluesHouseDaisySittingText(e) {
      if (e.checkEvent('EVENT_GOT_TOWN_MAP')) {
        yield* e.printText('BluesHouseDaisyUseMapText');
      } else if (e.checkEvent('EVENT_GOT_POKEDEX')) {
        yield* e.printText('BluesHouseDaisyOfferMapText');
        if (!e.giveItem('TOWN_MAP', 1)) {
          yield* e.printText('BluesHouseDaisyBagFullText');
          return;
        }
        e.hideObject('TOGGLE_TOWN_MAP');
        yield* e.printText('GotMapText');
        e.setEvent('EVENT_GOT_TOWN_MAP');
      } else {
        yield* e.printText('BluesHouseDaisyRivalAtLabText');
      }
    },
  },
};
