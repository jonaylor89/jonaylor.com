/**
 * Battle menus from engine/battle/core.asm: DisplayBattleMenu (FIGHT / PKMN /
 * ITEM / RUN and the Safari Zone menu), BagWasSelected/UseBagItem,
 * PartyMenuOrRockOrRun (SWITCH / STATS / CANCEL), MoveSelectionMenu,
 * SelectMenuItem (with SELECT move swapping), PrintMenuItem and the Mimic menu.
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { c } from '../rom/constants';
import { PAD_A, PAD_B, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_SELECT, PAD_UP } from '../engine/pad';
import { encodePlain } from '../ui/TextPrinter';
import { eraseMenuCursor, handleMenuInput } from '../ui/menus';
import { bagEntries, displayListMenu, entriesToBag } from '../ui/listMenu';
import { itemData } from '../game/pokemon';
import { M, PP_MASK, S1, S2, S3 } from './state';
import { useItem } from '../items/useItem';
import { statusScreen } from '../ui/statusScreen';

const put = (b: Battle, x: number, y: number, s: string) => {
  let cy = y;
  for (const line of s.split('{next}')) {
    encodePlain(line.replace(/\{pkmn\}/g, '<PK><MN>').replace(/\{poke\}/g, 'POKé')).forEach((code, i) => b.e.screen.put(x + i, cy, code));
    cy += 2;
  }
};

const BT = (n: string) => c('battle', n);

/** DisplayBattleMenu: returns true (carry) if the player ran or caught the mon. */
export function* battleMenu(b: Battle): Co<boolean> {
  for (;;) {
    b.loadScreen1();
    if (!b.battleType) {
      b.drawHUDsAndHPBars();
      yield* b.printEmptyString();
      b.saveScreen1();
    }
    const safari = b.battleType === BT('BATTLE_TYPE_SAFARI');
    const str = b.bundle.strings;
    if (safari) {
      b.e.screen.box(0, 12, 4, 18);
      put(b, 2, 14, str.SafariZoneBattleMenuText);
    } else {
      b.e.screen.box(8, 12, 4, 10);
      put(b, 10, 14, str.BattleMenuText);
    }
    let choice: number;
    if (b.battleType === BT('BATTLE_TYPE_OLD_MAN') || b.battleType === BT('BATTLE_TYPE_PIKACHU')) {
      // .doSimulatedMenuInput: the cursor moves to ITEM by itself (the player's name is swapped temporarily)
      b.simulatedTrainerName = b.battleType === BT('BATTLE_TYPE_OLD_MAN') ? str['DisplayBattleMenu.oldManName'] : str['DisplayBattleMenu.profOakName'];
      b.e.screen.put(9, 14, 0xed);
      yield* b.delay(20);
      b.e.screen.put(9, 14, 0x7f);
      b.e.screen.put(9, 16, 0xed);
      yield* b.delay(20);
      b.e.screen.put(9, 16, 0xec);
      choice = 2;
    } else {
      choice = yield* handleBattleMenuInput(b, safari);
      if (b.battleType === BT('BATTLE_TYPE_RUN')) {
        if (choice === 3) {
          const r = yield* runWasSelected(b);
          if (r === 'menu') continue;
          return r;
        }
        yield* b.print('_RunAwayText');
        continue;
      }
      b.battleAndStartSavedMenuItem = choice;
      // the ITEM and PKMN entries swapped places in the English menu
      if (!safari) {
        if (choice === 1) choice = 2;
        else if (choice === 2) choice = 1;
      }
    }
    if (choice === 0) {
      if (safari) {
        const r = yield* useBagItem(b, c('item', 'SAFARI_BALL'));
        if (r === 'again') continue;
        return r === 'caught';
      }
      // FIGHT
      b.numRunAttempts = 0;
      b.loadScreen1();
      return false;
    }
    if (choice === 2) {
      // ITEM (or BAIT)
      b.saveScreen2();
      if (safari) {
        const r = yield* useBagItem(b, c('item', 'SAFARI_BAIT'));
        if (r === 'again') continue;
        return r === 'caught';
      }
      const r = yield* bagWasSelected(b);
      if (r === 'menu') continue;
      return r === 'caught';
    }
    if (choice === 1) {
      // PKMN (or ROCK)
      b.saveScreen2();
      if (safari) {
        const r = yield* useBagItem(b, c('item', 'SAFARI_ROCK'));
        if (r === 'again') continue;
        return r === 'caught';
      }
      const r = yield* partyMenuWasSelected(b);
      if (r === 'menu') continue;
      return false;
    }
    // RUN
    const ran = yield* runWasSelected(b);
    if (ran === 'menu') continue;
    return ran;
  }
}

/** .handleBattleMenuInput: two columns of two items each. */
function* handleBattleMenuInput(b: Battle, safari: boolean): Co<number> {
  let cur = b.battleAndStartSavedMenuItem;
  let right = cur >= 2;
  if (right) cur -= 2;
  for (;;) {
    const s = b.e.screen;
    if (right) {
      for (const y of [14, 16]) s.put(safari ? 1 : 9, y, 0x7f);
      if (safari) put(b, 7, 14, String(b.numSafariBalls).padStart(2, ' '));
      const [item, key] = yield* handleMenuInput(b.e, {
        topX: safari ? 0xd : 0xf,
        topY: 0xe,
        maxItem: 1,
        current: cur,
        watchedKeys: PAD_LEFT | PAD_A,
      });
      cur = item;
      if (key & PAD_LEFT) {
        right = false;
        continue;
      }
      s.put(safari ? 0xd : 0xf, 14 + item * 2, 0xec);
      return item + 2;
    }
    for (const y of [14, 16]) s.put(safari ? 13 : 15, y, 0x7f);
    if (safari) put(b, 7, 14, String(b.numSafariBalls).padStart(2, ' '));
    const [item, key] = yield* handleMenuInput(b.e, {
      topX: safari ? 1 : 9,
      topY: 0xe,
      maxItem: 1,
      current: cur,
      watchedKeys: PAD_RIGHT | PAD_A,
    });
    cur = item;
    if (key & PAD_RIGHT) {
      right = true;
      continue;
    }
    s.put(safari ? 1 : 9, 14 + item * 2, 0xec);
    return item;
  }
}

/** BattleMenu_RunWasSelected: true = escaped, false = turn used, 'menu' = back to the menu. */
function* runWasSelected(b: Battle): Co<boolean | 'menu'> {
  b.loadScreen1();
  b.currentMenuItem = 3;
  const ran = yield* b.tryRunningFromBattle(b.player.mon.spd, b.enemy.mon.spd);
  b.forcePlayerToChooseMon = 0;
  if (ran) return true;
  if (b.actionResult) return false;
  return 'menu';
}

/** BagWasSelected → DisplayBagMenu → UseBagItem. */
function* bagWasSelected(b: Battle): Co<'menu' | 'used' | 'caught'> {
  for (;;) {
    b.loadScreen1();
    if (!b.battleType) b.drawHUDsAndHPBars();
    const simulated = b.battleType === BT('BATTLE_TYPE_OLD_MAN') || b.battleType === BT('BATTLE_TYPE_PIKACHU');
    const list = simulated ? [{ id: c('item', 'POKE_BALL'), qty: 1 }] : bagEntries(b.bag);
    const cursor = { item: b.bagSavedMenuItem, scroll: b.e.ram.listScrollOffset ?? 0 };
    const chosen = yield* displayListMenu(b.e, {
      kind: 'items',
      entries: list,
      cursor,
      simulated,
      onSwap: (l) => (b.bag = entriesToBag(l)),
    });
    b.bagSavedMenuItem = cursor.item;
    b.e.ram.listScrollOffset = cursor.scroll;
    b.menuItemToSwap = 0;
    if (!chosen) return 'menu';
    const r = yield* useBagItem(b, chosen.entry.id);
    if (r === 'again') continue;
    return r;
  }
}

/**
 * UseBagItem: 'again' = item not used (back to the bag), 'used' = turn
 * taken, 'caught' = the battle ends after a capture.
 */
export function* useBagItem(b: Battle, item: number): Co<'again' | 'used' | 'caught'> {
  b.setMem('wNameBuffer', itemData(b.bundle, item).name);
  b.setMem('wStringBuffer', itemData(b.bundle, item).name);
  yield* useItem(b.e, item, { battle: b });
  b.ui.reloadHudTiles();
  b.ui.clearSprites();
  b.currentMenuItem = 0;
  const safari = b.battleType === BT('BATTLE_TYPE_SAFARI');
  if (!safari) {
    if (!b.actionResult) return 'again';
    if (b.player.s1 & S1.USING_TRAPPING_MOVE) {
      b.player.numAttacksLeft = (b.player.numAttacksLeft - 1) & 0xff;
      if (!b.player.numAttacksLeft) b.player.s1 &= ~S1.USING_TRAPPING_MOVE;
    }
  }
  if (b.capturedMonSpecies) {
    b.capturedMonSpecies = 0;
    b.battleResult = 2;
    b.caught = true;
    return 'caught';
  }
  if (!safari) {
    b.loadScreen1();
    b.drawHUDsAndHPBars();
    yield* b.delay(3);
  }
  return 'used';
}

/** PartyMenuOrRockOrRun → .partyMenuWasSelected */
function* partyMenuWasSelected(b: Battle): Co<'menu' | 'switched'> {
  b.loadScreen1();
  b.menuItemToSwap = 0;
  for (;;) {
    const chosen = yield* b.displayPartyMenu('normal');
    if (chosen === undefined) {
      // .quitPartyMenu
      b.ui.clearSprites();
      b.ui.reloadHudTiles();
      b.loadScreen2();
      return 'menu';
    }
    b.whichPokemon = chosen;
    // SWITCH / STATS / CANCEL
    for (;;) {
      const s = b.e.screen;
      s.box(11, 11, 5, 7);
      put(b, 13, 12, b.bundle.strings.SwitchStatsCancelText);
      const [item, key] = yield* handleMenuInput(b.e, { topX: 0xc, topY: 0xc, maxItem: 2, current: 0, watchedKeys: PAD_B | PAD_A });
      if (key & PAD_B) break; // .partyMonDeselected
      s.put(0xc, 0xc + item * 2, 0xec);
      if (item === 2) {
        b.ui.clearSprites();
        b.ui.reloadHudTiles();
        b.loadScreen2();
        return 'menu';
      }
      if (item === 1) {
        // STATS
        b.ui.clearSprites();
        yield* statusScreen(b.e, b.party, chosen);
        b.ui.reloadHudTiles();
        break; // back to the party menu
      }
      // SWITCH
      if (chosen === b.playerMonNumber) {
        yield* b.print('_AlreadyOutText');
        break;
      }
      if (yield* b.hasMonFainted()) break;
      b.actionResult = 1;
      b.ui.clearSprites();
      b.ui.reloadHudTiles();
      b.loadScreen1();
      yield* b.switchPlayerMon();
      return 'switched';
    }
  }
}

// ------------------------------------------------------------ moves
/**
 * MoveSelectionMenu (regular battle menu): returns true if a move was
 * chosen (wPlayerSelectedMove set), false if the player backed out.
 */
export function* moveSelectionMenu(b: Battle): Co<boolean> {
  const p = b.player;
  for (;;) {
    if (!(yield* anyMoveToSelect(b))) return true;
    const s = b.e.screen;
    s.box(4, 12, 4, 14);
    s.put(4, 12, 0x7a);
    s.put(10, 12, 0x7e);
    writeMoves(b, p.mon.moves, 6, 13);
    const numMoves = p.mon.moves.filter((m) => m).length;
    b.maxMenuItem = numMoves; // wNumMovesMinusOne + 1 with items counted from 1
    let cur = p.moveListIndex + 1;
    for (;;) {
      printMenuItem(b, cur);
      if (b.menuItemToSwap) s.put(5, 13 + b.menuItemToSwap - 1, 0xec);
      const [item, key] = yield* moveMenuInput(b, cur, numMoves);
      cur = item;
      if (key & PAD_UP && item === 0) {
        // SelectMenuItem_CursorUp: wrap to the last move
        eraseMenuCursor(b.e);
        cur = numMoves;
        continue;
      }
      if (key & PAD_DOWN && item === numMoves + 1) {
        eraseMenuCursor(b.e);
        cur = 1;
        continue;
      }
      if (key & (PAD_UP | PAD_DOWN)) continue;
      if (key & PAD_SELECT) {
        if (yield* swapMovesInMenu(b, cur)) break;
        continue;
      }
      b.menuItemToSwap = 0;
      b.currentMenuItem = cur - 1;
      if (key & PAD_B) return false;
      p.moveListIndex = cur - 1;
      const i = cur - 1;
      if (!(p.mon.pp[i] & PP_MASK)) {
        yield* b.print('_MoveNoPPText');
        b.loadScreen1();
        break;
      }
      if (((p.disabledMove >> 4) & 0xf) - 1 === i) {
        yield* b.print('_MoveDisabledText');
        b.loadScreen1();
        break;
      }
      p.selectedMove = p.mon.moves[i];
      return true;
    }
  }
}

/** HandleMenuInput for the move list (items 1..n at rows 13..), returning out-of-range items for wrapping. */
function* moveMenuInput(b: Battle, cur: number, numMoves: number): Co<[number, number]> {
  const [item, key] = yield* handleMenuInput(b.e, {
    topX: 5,
    topY: 12,
    maxItem: numMoves + 1,
    current: cur,
    spacing: 1,
    watchedKeys: PAD_UP | PAD_DOWN | PAD_A | PAD_B | PAD_SELECT,
  });
  return [item, key];
}

/** FormatMovesString + the move-list PlaceString (single-spaced). */
function writeMoves(b: Battle, moves: number[], x: number, y: number): void {
  for (let i = 0; i < 4; i++) {
    const m = moves[i];
    put(b, x, y + i, m ? b.bundle.moves[m - 1].name : '-');
  }
}

/** AnyMoveToSelect: false (Z) if only Struggle is possible (prints "no moves left"). */
function* anyMoveToSelect(b: Battle): Co<boolean> {
  const p = b.player;
  p.selectedMove = M.STRUGGLE;
  let any = 0;
  const disabled = (p.disabledMove >> 4) & 0xf;
  for (let i = 0; i < 4; i++) {
    if (disabled && i === disabled - 1) continue;
    any |= p.mon.pp[i];
  }
  if (any & PP_MASK) return true;
  yield* b.print('_NoMovesLeftText');
  yield* b.delay(60);
  return false;
}

/** PrintMenuItem: the TYPE/PP box at (0,8). */
function printMenuItem(b: Battle, cur: number): void {
  const s = b.e.screen;
  const p = b.player;
  s.box(0, 8, 3, 9);
  const i = cur - 1;
  if (i < 0 || i > 3) return;
  const disabled = (p.disabledMove >> 4) & 0xf;
  if (disabled && disabled === cur) {
    put(b, 1, 10, b.bundle.strings.DisabledText);
    return;
  }
  const move = p.mon.moves[i];
  p.selectedMove = move;
  if (!move) return;
  const pp = p.mon.pp[i] & PP_MASK;
  const maxPP = getMaxPP(b, i);
  put(b, 1, 9, b.bundle.strings.TypeText);
  s.put(7, 11, 0xf3);
  s.put(5, 9, 0xf3);
  put(b, 5, 11, String(pp).padStart(2, ' '));
  put(b, 8, 11, String(maxPP).padStart(2, ' '));
  const md = b.bundle.moves[move - 1];
  put(b, 2, 10, b.bundle.types.names[md.type] ?? '');
}

/** GetMaxPP for the battle mon (base PP plus PP Ups; 5 per move when transformed). */
function getMaxPP(b: Battle, i: number): number {
  const p = b.player;
  const move = p.mon.moves[i];
  const base = b.bundle.moves[move - 1].pp;
  if (p.s3 & S3.TRANSFORMED) return 5;
  const ups = p.mon.pp[i] >> 6;
  return base + Math.min(Math.floor(base / 5), 7) * ups;
}

/** SwapMovesInMenu: returns true to redraw the menu. */
function* swapMovesInMenu(b: Battle, cur: number): Co<boolean> {
  const p = b.player;
  if (p.s3 & S3.TRANSFORMED) return true;
  if (!b.menuItemToSwap) {
    b.menuItemToSwap = cur;
    yield;
    return true;
  }
  const a = b.menuItemToSwap - 1;
  const c2 = cur - 1;
  const swap = (arr: number[]) => ([arr[a], arr[c2]] = [arr[c2], arr[a]]);
  swap(p.mon.moves);
  swap(p.mon.pp);
  const dis = (p.disabledMove >> 4) & 0xf;
  if (dis === cur) p.disabledMove = (b.menuItemToSwap << 4) | (p.disabledMove & 0xf);
  else if (dis === b.menuItemToSwap) p.disabledMove = (cur << 4) | (p.disabledMove & 0xf);
  const pm = b.party[b.playerMonNumber];
  swap(pm.moves);
  swap(pm.pp);
  b.menuItemToSwap = 0;
  return true;
}

/** MoveSelectionMenu with wMoveMenuType = 1 (Mimic): pick one of the enemy's moves. */
export function* mimicMoveMenu(b: Battle): Co<number> {
  const s = b.e.screen;
  const en = b.enemy;
  s.box(0, 7, 4, 14);
  writeMoves(b, en.mon.moves, 2, 8);
  const num = en.mon.moves.filter((m) => m).length;
  put(b, 1, 14, b.bundle.strings.WhichTechniqueString);
  let cur = 1;
  for (;;) {
    const [item, key] = yield* handleMenuInput(b.e, {
      topX: 1,
      topY: 7,
      maxItem: num + 1,
      current: cur,
      spacing: 1,
      watchedKeys: PAD_UP | PAD_DOWN | PAD_A,
    });
    cur = item;
    if (key & PAD_UP && item === 0) {
      eraseMenuCursor(b.e);
      cur = num;
    } else if (key & PAD_DOWN && item === num + 1) {
      eraseMenuCursor(b.e);
      cur = 1;
    }
    else if (key & PAD_A) {
      b.currentMenuItem = cur - 1;
      return cur - 1;
    }
  }
}

export { S2 };
