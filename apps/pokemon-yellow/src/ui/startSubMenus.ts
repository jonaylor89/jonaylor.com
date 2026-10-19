/**
 * START menu sub-screens from engine/menus/start_sub_menus.asm:
 * StartMenu_Pokemon (party menu, field-move menu from
 * DisplayFieldMoveMonMenu, STATS, SWITCH) and StartMenu_Item (bag list,
 * USE/TOSS, TossItem_). Each returns 'close' when the START menu should
 * close (an item or move took the player somewhere) or 'back' to redisplay it.
 */
import { withoutTextAsm } from '../rom/text';
import { setStrengthActive } from '../field/strength';
import type { Co, Engine } from '../engine/Engine';
import type { PartyMon } from '../game/state';
import { c } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { PAD_A, PAD_B } from '../engine/pad';
import { encodePlain } from './TextPrinter';
import { handleMenuInput, restoreScreen, saveScreen } from './menus';
import { tossItem } from './pc';
import { goBackToPartyMenu, partyMenu, switchPartyMon } from './partyMenu';
import { statusScreen } from './statusScreen';
import { bagEntries, chooseQuantity, displayListMenu, entriesToBag } from './listMenu';
import { useItem } from '../items/useItem';
import { itemData } from '../game/pokemon';

type Result = 'close' | 'back';

const put = (e: Engine, x: number, y: number, s: string) => {
  let cy = y;
  for (const line of s.split('{next}')) {
    encodePlain(line).forEach((code, i) => e.screen.put(x + i, cy, code));
    cy += 2;
  }
};

function* printWith(e: Engine, label: string, mem: Record<string, string | number> = {}): Co {
  const byAddr = new Map<number, string | number>();
  for (const [k, v] of Object.entries(mem)) byAddr.set(ramSym(k), v);
  const ops = withoutTextAsm(e.bundle.texts[label]!);
  yield* e.printOps(ops, { ram: (l, a) => (a !== undefined && byAddr.has(a) ? byAddr.get(a) : e.ramValue(l, a)) });
}

// ------------------------------------------------------------------ POKéMON
/** StartMenu_Pokemon */
export function* startMenuPokemon(e: Engine): Co<Result> {
  if (!e.state.party.length) return 'back';
  const saved = saveScreen(e);
  let party = structuredClone(e.state.party);
  const commit = () => e.store.dispatch({ type: 'setParty', party }, { undoable: false });
  let chosen = yield* partyMenu(e, { party, mode: 'normal' });
  let swapFrom = 0;
  for (;;) {
    if (chosen === undefined) {
      // .exitMenu
      commit();
      e.screen.clearGlyphOverrides();
      restoreScreen(e, saved);
      return 'back';
    }
    if (swapFrom) {
      // SwitchPartyMon
      if (chosen !== swapFrom - 1) {
        switchPartyMon(party, swapFrom - 1, chosen);
        commit();
        // SwitchPartyMon_ClearGfx for both rows: blank the row, then SFX_SWAP after the last sound
        for (const row of [swapFrom - 1, chosen]) {
          for (let x = 0; x < 20; x++) for (let y = row * 2; y < row * 2 + 2; y++) e.screen.put(x, y, 0x7f);
          yield* e.waitForSoundToFinish();
          e.hooks.playSound?.('SFX_SWAP');
        }
      }
      swapFrom = 0;
      commit();
      chosen = yield* goBackToPartyMenu(e, { party, mode: 'normal' });
      continue;
    }
    const which = chosen;
    const pm = party[which];
    const choice = yield* fieldMoveMonMenu(e, pm);
    if (choice === 'b') {
      chosen = yield* goBackToPartyMenu(e, { party, mode: 'normal' });
      continue;
    }
    if (choice === 'cancel') {
      chosen = undefined;
      continue;
    }
    if (choice === 'switch') {
      if (party.length < 2) {
        chosen = yield* goBackToPartyMenu(e, { party, mode: 'normal' });
        continue;
      }
      swapFrom = which + 1;
      chosen = yield* goBackToPartyMenu(e, { party, mode: 'swap', swapFrom });
      continue;
    }
    if (choice === 'stats') {
      e.screen.setObjects([]);
      yield* statusScreen(e, party, which);
      chosen = yield* partyMenu(e, { party, mode: 'normal' });
      continue;
    }
    // a field move
    commit();
    const r = yield* outOfBattleMove(e, party, which, choice);
    party = structuredClone(e.state.party);
    if (r === 'close') {
      e.screen.clearGlyphOverrides();
      restoreScreen(e, saved);
      return 'close';
    }
    chosen = yield* goBackToPartyMenu(e, { party, mode: 'normal' });
  }
}

type FieldChoice = 'stats' | 'switch' | 'cancel' | 'b' | number;

/** DisplayFieldMoveMonMenu + the menu input of StartMenu_Pokemon. Returns a move id for field moves. */
function* fieldMoveMonMenu(e: Engine, pm: PartyMon): Co<FieldChoice> {
  const saved = saveScreen(e);
  const table = e.bundle.battle.fieldMoves;
  const fields: { move: number; name: string; x: number }[] = [];
  let left = 12;
  for (const m of pm.moves) {
    if (!m) break;
    const f = table.find((t) => t.move === m);
    if (!f) continue;
    fields.push(f);
    if (f.x < left) left = f.x;
  }
  const s = e.screen;
  let topX: number;
  let topY: number;
  if (!fields.length) {
    s.box(11, 11, 5, 7);
    put(e, 13, 12, e.bundle.strings.PokemonMenuEntries);
    topX = 12;
    topY = 12;
  } else {
    const h = 5 + fields.length * 2;
    const boxY = 11 - fields.length * 2;
    s.box(left - 1, boxY, h, 18 - (left - 1));
    fields.forEach((f, i) => put(e, left + 1, 12 - fields.length * 2 + i * 2, f.name));
    put(e, left + 1, 12, e.bundle.strings.PokemonMenuEntries);
    topX = left;
    topY = 12 - fields.length * 2;
  }
  const max = fields.length + 2;
  const [item, key] = yield* handleMenuInput(e, { topX, topY, maxItem: max, current: 0, watchedKeys: PAD_A | PAD_B });
  restoreScreen(e, saved);
  if (key & PAD_B) return 'b';
  if (item === max) return 'cancel';
  if (item === max - 1) return 'switch';
  if (item === max - 2) return 'stats';
  return fields[item].move;
}

/** .choseOutOfBattleMove */
function* outOfBattleMove(e: Engine, party: PartyMon[], which: number, move: number): Co<Result> {
  const pm = party[which];
  const badges = e.state.badges;
  const has = (i: number) => (badges >> i) & 1;
  const nick = { wNameBuffer: pm.nickname };
  const newBadge = function* () {
    yield* printWith(e, '_NewBadgeRequiredText');
    return 'back' as Result;
  };
  const outside = () => e.world.data.tileset === 0 || e.world.data.tileset === c('tileset', 'PLATEAU');
  const M = (n: string) => c('move', n);
  if (move === M('CUT') || move === M('FLY') || move === M('SURF')) {
    const need = move === M('CUT') ? 1 : move === M('FLY') ? 2 : 4;
    if (!has(need)) return yield* newBadge();
    const h = e.fieldMoves[move === M('CUT') ? 'CUT' : move === M('FLY') ? 'FLY' : 'SURF'];
    if (!h) {
      e.hooks.unported?.(`field move ${e.bundle.moves[move - 1].name}`);
      return 'back';
    }
    return yield* h(e, party, which);
  }
  if (move === M('STRENGTH')) {
    if (!has(3)) return yield* newBadge();
    // PrintStrengthText
    setStrengthActive(e, true);
    yield* printWith(e, '_UsedStrengthText', nick);
    e.hooks.playCry?.(pm.species);
    yield* e.waitForSoundToFinish();
    yield* e.delayFrames(3);
    yield* printWith(e, '_CanMoveBouldersText', nick);
    return 'close';
  }
  if (move === M('FLASH')) {
    if (!has(0)) return yield* newBadge();
    e.ram.mapPalOffset = 0;
    yield* printWith(e, '_FlashLightsAreaText');
    return 'close';
  }
  if (move === M('DIG')) {
    const r = yield* useItem(e, c('item', 'ESCAPE_ROPE'), { pseudo: c('item', 'ESCAPE_ROPE') });
    return r ? 'close' : 'back';
  }
  if (move === M('TELEPORT')) {
    if (!outside()) {
      yield* printWith(e, '_CannotUseTeleportNowText', nick);
      return 'back';
    }
    yield* printWith(e, '_WarpToLastPokemonCenterText', nick);
    e.ram.flyWarp = true;
    e.ram.escapeWarp = true;
    e.ram.noBattles = false;
    yield* e.delayFrames(60);
    return 'close';
  }
  if (move === M('SOFTBOILED')) {
    if (pm.hp < Math.floor(pm.maxHp / 5)) {
      yield* printWith(e, '_NotHealthyEnoughText');
      return 'back';
    }
    e.ram.softboiledUser = which;
    yield* useItem(e, c('item', 'POTION'), { pseudo: c('item', 'POTION') });
    return 'back';
  }
  return 'back';
}

// ------------------------------------------------------------------ ITEM
/** StartMenu_Item */
export function* startMenuItem(e: Engine): Co<Result> {
  const saved = saveScreen(e);
  for (;;) {
    // ItemMenuLoop
    const bag = structuredClone(e.state.bag);
    const list = bagEntries(bag);
    const cursor = { item: e.ram.bagSavedMenuItem, scroll: e.ram.listScrollOffset };
    const chosen = yield* displayListMenu(e, {
      kind: 'items',
      entries: list,
      cursor,
      onSwap: (l) => e.store.dispatch({ type: 'setBag', bag: entriesToBag(l) }, { undoable: false }),
    });
    e.ram.bagSavedMenuItem = cursor.item;
    e.ram.listScrollOffset = cursor.scroll;
    if (!chosen) {
      restoreScreen(e, saved);
      return 'back';
    }
    const item = chosen.entry.id;
    for (const y of [4, 6, 8, 10]) e.screen.put(5, y, 0x7f);
    e.screen.put(5, 4 + cursor.item * 2, 0xec);
    let use = true;
    if (item !== c('item', 'BICYCLE')) {
      e.screen.box(13, 10, 3, 5);
      put(e, 15, 11, e.bundle.strings.UseTossText);
      const [sel, key] = yield* handleMenuInput(e, { topX: 14, topY: 11, maxItem: 1, current: 0, watchedKeys: PAD_A | PAD_B });
      e.screen.put(14, 11 + sel * 2, 0xec);
      if (key & PAD_B) {
        restoreScreen(e, saved);
        continue;
      }
      use = sel === 0;
    } else if (e.ram.alwaysOnBike) {
      yield* printWith(e, '_CannotGetOffHereText');
      restoreScreen(e, saved);
      continue;
    }
    if (!use) {
      yield* tossFromBag(e, chosen.index, item, chosen.entry.qty ?? 1);
      restoreScreen(e, saved);
      continue;
    }
    const closeMenu = item === c('item', 'BICYCLE') || e.bundle.battle.usableCloseMenu.includes(item);
    const partyMenuItem = item >= c('item', 'HM01') || e.bundle.battle.usableParty.includes(item);
    const r = yield* useItem(e, item);
    if (closeMenu) {
      if (!r) {
        restoreScreen(e, saved);
        continue;
      }
      if (e.ram.flyWarp) e.screen.clear();
      restoreScreen(e, saved);
      return 'close';
    }
    e.screen.clearGlyphOverrides();
    restoreScreen(e, saved);
    if (partyMenuItem && r !== 2) continue;
  }
}

/** .tossItem: quantity (skipped for key items and HMs), then TossItem_ on the chosen slot. */
function* tossFromBag(e: Engine, index: number, item: number, have: number): Co {
  let qty = 1;
  if (!itemData(e.bundle, item).isKey && !(item >= c('item', 'HM01') && item < c('item', 'TM01'))) {
    const q = yield* chooseQuantity(e, have);
    if (q === undefined) return;
    qty = q;
  }
  yield* tossItem(e, index, qty, () => e.state.bag, (bag) => e.store.dispatch({ type: 'setBag', bag }, { undoable: false }));
}
