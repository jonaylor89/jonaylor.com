/**
 * Poké Marts: DisplayPokemartDialogue (home/text_script.asm) and
 * DisplayPokemartDialogue_ (engine/events/pokemart.asm), with the
 * MONEY_BOX and BUY_SELL_QUIT_MENU text boxes (engine/menus/text_box.asm).
 */
import type { Co, Engine } from '../engine/Engine';
import type { ScriptEnv } from '../engine/ScriptEnv';
import { c } from '../rom/constants';
import { PAD_A, PAD_B } from '../engine/pad';
import { encodePlain, formatBCD } from './TextPrinter';
import { handleMenuInput, restoreScreen, saveScreen, twoOptionMenu } from './menus';
import { bagEntries, chooseQuantity, displayListMenu, entriesToBag } from './listMenu';
import { itemData } from '../game/pokemon';
import { StateError } from '../game/state';

/** hMoney / hItemPrice, read by the price texts. */
const H_MONEY = 0xff9f;

/** PlaceString: `{next}` moves down two rows. */
export const placeString = (e: Engine, x: number, y: number, s: string) => {
  let cy = y;
  for (const line of s.split('{next}')) {
    encodePlain(line).forEach((code, i) => e.screen.put(x + i, cy, code));
    cy += 2;
  }
};

/** DisplayMoneyBox */
export function displayMoneyBox(e: Engine): void {
  e.screen.box(11, 0, 1, 7);
  placeString(e, 13, 0, e.bundle.strings.MoneyText);
  e.screen.fill(13, 1, 6, 1, 0x7f);
  placeString(e, 12, 1, formatBCD(e.state.money, 3 | 0x80 | 0x20));
}

/** DoBuySellQuitMenu: 0 buy, 1 sell, 2 quit (B also quits). */
function* buySellQuitMenu(e: Engine): Co<number> {
  e.screen.box(0, 0, 5, 9);
  placeString(e, 2, 1, e.bundle.strings.BuySellQuitText);
  const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 1, maxItem: 2, current: 0, watchedKeys: PAD_A | PAD_B });
  e.screen.put(1, 1 + item * 2, 0xec); // PlaceUnfilledArrowMenuCursor
  return key & PAD_B ? 2 : item;
}

const isHM = (item: number) => item >= c('item', 'HM01') && item < c('item', 'TM01');

/** The TX_SCRIPT_MART handler. */
export function* pokemart(env: ScriptEnv, stock: number[]): Co<boolean> {
  const e = env.e;
  yield* env.printText('PokemartGreetingText');
  const savedScroll = e.ram.listScrollOffset;
  env.updateSprites();
  e.ram.boughtOrSoldItemInMart = false;
  let saved = saveScreen(e);
  const anythingElse = function* () {
    // .returnToMainPokemartMenu
    restoreScreen(e, saved);
    displayMoneyBox(e);
    yield* env.printText('PokemartAnythingElseText');
  };
  for (;;) {
    // .loop
    e.ram.listScrollOffset = 0;
    displayMoneyBox(e);
    const choice = yield* buySellQuitMenu(e);
    if (choice === 2) break;
    if (choice === 1) {
      // .sellMenu
      if (!e.state.bag.length) {
        yield* env.printText('PokemartItemBagEmptyText');
        saved = saveScreen(e);
        yield* anythingElse();
        continue;
      }
      yield* env.printText('PokemonSellingGreetingText');
      saved = saveScreen(e);
      let unsellable = false;
      for (;;) {
        // .sellMenuLoop
        restoreScreen(e, saved);
        displayMoneyBox(e);
        const list = bagEntries(structuredClone(e.state.bag));
        const cursor = { item: 0, scroll: e.ram.listScrollOffset };
        const chosen = yield* displayListMenu(e, {
          kind: 'items',
          entries: list,
          cursor,
          onSwap: (l) => e.store.dispatch({ type: 'setBag', bag: entriesToBag(l) }, { undoable: false }),
        });
        e.ram.listScrollOffset = cursor.scroll;
        if (!chosen) break;
        const item = chosen.entry.id;
        const data = itemData(e.bundle, item);
        if (data.isKey || isHM(item)) {
          unsellable = true;
          break;
        }
        const qty = yield* chooseQuantity(e, chosen.entry.qty ?? 1, data.price, true);
        if (qty === undefined) continue;
        const total = Math.floor((data.price * qty) / 2);
        e.ram.mem.set(H_MONEY, total);
        yield* env.printText('PokemartTellSellPriceText');
        if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7)) !== 0) continue;
        e.ram.boughtOrSoldItemInMart = true;
        // AddAmountSoldToMoney, then RemoveItemFromInventory on the chosen slot
        e.store.dispatch({ type: 'addMoney', amount: total }, { undoable: false });
        const bag = structuredClone(e.state.bag);
        bag[chosen.index].qty -= qty;
        if (!bag[chosen.index].qty) bag.splice(chosen.index, 1);
        e.store.dispatch({ type: 'setBag', bag }, { undoable: false });
        displayMoneyBox(e);
        yield* env.playSoundWaitForCurrent('purchase');
        yield* env.waitForSoundToFinish();
      }
      if (unsellable) yield* env.printText('PokemartUnsellableItemText');
      yield* anythingElse();
      continue;
    }
    // .buyMenu
    yield* env.printText('PokemartBuyingGreetingText');
    saved = saveScreen(e);
    const entries = stock.map((id) => ({ id }));
    let failText: string | undefined;
    for (;;) {
      // .buyMenuLoop
      restoreScreen(e, saved);
      displayMoneyBox(e);
      const cursor = { item: 0, scroll: e.ram.listScrollOffset };
      const chosen = yield* displayListMenu(e, { kind: 'priced', entries, cursor });
      e.ram.listScrollOffset = cursor.scroll;
      if (!chosen) break;
      const item = chosen.entry.id;
      const data = itemData(e.bundle, item);
      const qty = yield* chooseQuantity(e, 99, data.price);
      if (qty === undefined) continue;
      const total = data.price * qty;
      e.ram.mem.set(H_MONEY, total);
      e.ram.nameBuffer = data.name; // CopyToStringBuffer
      yield* env.printText('PokemartTellBuyPriceText');
      if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7)) !== 0) continue;
      if (e.state.money < total) {
        failText = 'PokemartNotEnoughMoneyText';
        break;
      }
      try {
        e.store.dispatch({ type: 'giveItem', item, qty }, { undoable: false });
      } catch (err) {
        if (!(err instanceof StateError)) throw err;
        failText = 'PokemartItemBagFullText';
        break;
      }
      e.store.dispatch({ type: 'addMoney', amount: -total }, { undoable: false });
      e.ram.boughtOrSoldItemInMart = true;
      displayMoneyBox(e);
      yield* env.playSoundWaitForCurrent('purchase');
      yield* env.waitForSoundToFinish();
      yield* env.printText('PokemartBoughtItemText');
    }
    if (failText) yield* env.printText(failText);
    yield* anythingElse();
  }
  // .done
  yield* env.printText('PokemartThankYouText');
  env.updateSprites();
  e.ram.listScrollOffset = savedScroll;
  return true;
}

/** VendingMachineMenu (engine/events/vending_machine.asm). */
export function* vendingMachine(env: ScriptEnv): Co<boolean> {
  const e = env.e;
  yield* env.printText('VendingMachineText1');
  displayMoneyBox(e);
  e.ram.noTextDelay = true;
  e.screen.box(0, 3, 8, 12);
  env.updateSprites();
  placeString(e, 2, 5, e.bundle.strings.DrinkText);
  placeString(e, 9, 6, e.bundle.strings.DrinkPriceText);
  e.ram.noTextDelay = false;
  const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 5, maxItem: 3, current: 0, watchedKeys: PAD_A | PAD_B });
  if (key & PAD_B || item === 3) {
    yield* env.printText('VendingMachineText7');
    return true;
  }
  // HasEnoughMoney is checked against ¥200 whatever the drink costs
  if (e.state.money < 200) {
    yield* env.printText('VendingMachineText4');
    return true;
  }
  const v = e.bundle.hidden.vendingPrices[item];
  try {
    e.store.dispatch({ type: 'giveItem', item: v.item, qty: 1 }, { undoable: false });
  } catch (err) {
    if (!(err instanceof StateError)) throw err;
    yield* env.printText('VendingMachineText6');
    return true;
  }
  for (let i = 0; i < 60; i++) {
    yield* e.delayFrames(2);
    e.hooks.playSound?.('push_boulder');
  }
  yield* env.printText('VendingMachineText5');
  // SubBCDPredef: an underflow leaves ¥0
  e.store.dispatch({ type: 'addMoney', amount: -v.price }, { undoable: false });
  displayMoneyBox(e);
  return true;
}
