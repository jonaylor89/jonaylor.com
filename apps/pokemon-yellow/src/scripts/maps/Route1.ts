/** Ports of scripts/Route1.asm and Route1_2.asm */
import type { MapScript } from '../types';

export const Route1: MapScript = {
  map: 'ROUTE_1',
  *run(e) {
    e.enableAutoTextBoxDrawing();
  },
  texts: {
    *Route1Youngster1Text(e) {
      if (e.checkAndSetEvent('EVENT_GOT_POTION_SAMPLE')) {
        yield* e.printText('Route1PrintYoungster1Text.AlsoGotPokeballsText');
        return;
      }
      yield* e.printText('Route1PrintYoungster1Text.MartSampleText');
      if (e.giveItem('POTION', 1)) yield* e.printText('Route1PrintYoungster1Text.GotPotionText');
      else yield* e.printText('Route1PrintYoungster1Text.NoRoomText');
    },
    *Route1Youngster2Text(e) {
      yield* e.printText('Route1PrintYoungster2Text.text');
    },
    *Route1SignText(e) {
      yield* e.printText('Route1PrintSignText.text');
    },
  },
};
