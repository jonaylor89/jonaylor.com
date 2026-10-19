/**
 * The Cable Club rooms (scripts/TradeCenter.asm, Colosseum.asm). They are only
 * entered over a link; with no link partner hSerialConnectionStatus is never
 * USING_INTERNAL_CLOCK, so the opponent stands on the left facing right.
 */
import type { MapScript } from '../types';

const linkRoom = (map: string, opponent: string): MapScript => ({
  map,
  *run(e) {
    e.enableAutoTextBoxDrawing();
    const internalClock = false; // hSerialConnectionStatus == USING_INTERNAL_CLOCK
    e.setSpriteFacing(opponent, internalClock ? 'left' : 'right');
    // BIT_INIT_TRADE_CENTER_FACING: the first run places the opponent
    if (e.e.ram.initTradeCenterFacing) return;
    e.e.ram.initTradeCenterFacing = true;
    e.setSpriteMapPosition(opponent, 6, 4); // wSprite01StateData2MapY/X = 8, 10 (+4 offset)
    e.setSpriteFacing(opponent, 'left');
    if (internalClock) return;
    e.setSpriteMapPosition(opponent, 3, 4);
    e.setSpriteFacing(opponent, 'right');
  },
});

export const TradeCenter = linkRoom('TRADE_CENTER', 'TRADECENTER_OPPONENT');
export const Colosseum = linkRoom('COLOSSEUM', 'COLOSSEUM_OPPONENT');
