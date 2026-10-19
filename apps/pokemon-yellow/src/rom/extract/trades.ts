/** In-game trades (data/events/trades.asm and engine/events/in_game_trades.asm). */
import type { Rom } from '../Rom';
import type { GameBundle } from '../../data/schema';
import type { TextCollector } from './texts';
import { c, sym, symBank, toOffset } from '../symbols';
import { decodeString, labelFor } from '../text';
import { decode2bpp } from './util';

export function extractTrades(rom: Rom, texts: TextCollector): GameBundle['trades'] {
  const n = c('script', 'NUM_NPC_TRADES');
  const size = 3 + 11; // give, get, dialog set, nickname (NAME_LENGTH)
  const base = sym('TradeMons');
  const mons = Array.from({ length: n }, (_, i) => {
    const p = base + i * size;
    return { give: rom.u8(p), get: rom.u8(p + 1), dialog: rom.u8(p + 2), nick: decodeString(rom, p + 3, 11) };
  });
  const bank = symBank('InGameTradeTextPointers');
  const sets: string[][] = [];
  for (let d = 0; d < 3; d++) {
    const table = toOffset(bank, rom.u16(sym('InGameTradeTextPointers') + d * 2));
    const labels: string[] = [];
    for (let t = 0; t < 5; t++) {
      const at = toOffset(bank, rom.u16(table + t * 2));
      const label = labelFor(at);
      texts.add(label, at);
      labels.push(label);
    }
    sets.push(labels);
  }
  for (const l of ['TradedForText', 'ConnectCableText']) texts.add(l);
  // InternalClockTradeAnim (engine/movie/trade.asm): its texts and graphics
  for (const l of ['TradeWentToText', 'TradeForText', 'TradeSendsText', 'TradeWavesFarewellText', 'TradeTransferredText', 'TradeTakeCareText', 'TradeWillTradeText', 'TradeforText'])
    texts.add(l);
  const span = (from: string, to: string) => rom.slice(sym(from), sym(to) - sym(from));
  const anim = {
    gfx: decode2bpp(span('TradingAnimationGraphics', 'TradingAnimationGraphicsEnd')),
    gfx2: decode2bpp(span('TradingAnimationGraphics2', 'TradingAnimationGraphics2End')),
    gameBoy: [...rom.slice(sym('GameBoyTiles'), 6 * 8)],
    linkCable: [...rom.slice(sym('LinkCableTiles'), 12 * 3)],
  };
  // OaksAideScript (engine/events/oaks_aide.asm), also an event routine with its own texts
  for (const l of ['OaksAideHiText', 'OaksAideUhOhText', 'OaksAideComeBackText', 'OaksAideHereYouGoText', 'OaksAideGotItemText', 'OaksAideNoRoomText']) texts.add(l);
  return { mons, texts: sets, otName: decodeString(rom, sym('InGameTrade_TrainerString'), 11), anim };
}
