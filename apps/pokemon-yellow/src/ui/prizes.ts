/**
 * The Game Corner prize room (engine/events/prize_menu.asm CeladonPrizeMenu):
 * three windows (two of Pokémon, one of TMs), prices in coins, Pokémon prizes
 * at PrizeMonLevelDictionary's levels.
 */
import type { Co } from '../engine/Engine';
import type { ScriptEnv } from '../engine/ScriptEnv';
import { c } from '../rom/constants';
import { PAD_A, PAD_B } from '../engine/pad';
import { handleMenuInput } from './menus';
import { encodePlain, formatBCD } from './TextPrinter';

function put(env: ScriptEnv, x: number, y: number, s: string): void {
  encodePlain(s).forEach((code, i) => env.e.screen.put(x + i, y, code));
}

/** PrintPrizePrice: the coin box */
function printCoins(env: ScriptEnv): void {
  env.e.screen.box(11, 0, 1, 7);
  env.updateSprites();
  put(env, 12, 0, env.e.bundle.strings['PrintPrizePrice.CoinString']);
  put(env, 13, 1, '      ');
  put(env, 13, 1, formatBCD(env.e.state.coins, 2 | 0x80));
}

export function* celadonPrizeMenu(env: ScriptEnv): Co<boolean> {
  const e = env.e;
  if (!env.isItemInBag('COIN_CASE')) {
    yield* env.printText('RequireCoinCaseText');
    return false;
  }
  e.ram.noTextDelay = true;
  yield* env.printText('ExchangeCoinsForPrizesText');
  printCoins(env);
  // GetPrizeMenuId: which of the three vendors (hTextID)
  const window = e.ram.spriteIndex - c('text_id', 'TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1');
  const menu = e.bundle.misc.prizes[window];
  const isTM = window === 2;
  const nameOf = (id: number) => (isTM ? (e.bundle.items.find((i) => i.id === id)?.name ?? '?') : (e.bundle.species[id]?.name ?? '?'));
  e.screen.box(0, 2, 8, 16);
  menu.entries.forEach((id, i) => put(env, 2, 4 + i * 2, nameOf(id)));
  put(env, 2, 10, e.bundle.strings.NoThanksText);
  menu.costs.forEach((cost, i) => put(env, 13, 5 + i * 2, formatBCD(cost, 2 | 0x80)));
  env.updateSprites();
  yield* env.printText('WhichPrizeText');
  const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 4, maxItem: 3, current: 0, watchedKeys: PAD_A | PAD_B });
  if (!(key & PAD_B) && item !== 3) yield* handlePrizeChoice(env, menu, item, isTM, nameOf);
  e.ram.noTextDelay = false;
  return false;
}

/** HandlePrizeChoice */
function* handlePrizeChoice(env: ScriptEnv, menu: { entries: number[]; costs: number[] }, which: number, isTM: boolean, nameOf: (id: number) => string): Co {
  const e = env.e;
  const prize = menu.entries[which];
  e.ram.nameBuffer = nameOf(prize);
  yield* env.printText('SoYouWantPrizeText');
  if (!(yield* env.yesNoChoice())) return yield* env.printText('OhFineThenText');
  const cost = menu.costs[which];
  if (e.state.coins < cost) return yield* env.printText('SorryNeedMoreCoinsText');
  if (isTM) {
    const name = e.bundle.items.find((i) => i.id === prize)?.constName ?? '';
    if (!env.giveItem(name)) return yield* env.printText('PrizeRoomBagIsFullText');
  } else {
    const before = e.state.party.length;
    const given = yield* env.givePokemon(prize, e.bundle.misc.prizeMonLevels[prize]);
    // if the mon went to the box (or nowhere), wait after the message
    if (e.state.party.length === before) yield* e.waitForTextScrollButtonPress();
    if (!given) return;
  }
  e.store.dispatch({ type: 'addCoins', amount: -cost }, { undoable: false });
  printCoins(env);
}
