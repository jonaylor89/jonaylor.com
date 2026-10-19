/**
 * PCs: ActivatePC and the PC main menu (engine/menus/pc.asm,
 * DisplayPCMainMenu), Bill's PC (engine/pokemon/bills_pc.asm, ChangeBox in
 * engine/menus/save.asm, PrintPCBox without a Game Boy Printer), the
 * player's item PC (engine/menus/players_pc.asm) and Prof. Oak's PC
 * (engine/menus/oaks_pc.asm).
 */
import { pkmnLeaguePC } from './hallOfFame';
import { printerJob } from './printer';
import type { Co, Engine } from '../engine/Engine';
import type { ScriptEnv } from '../engine/ScriptEnv';
import type { ItemSlot, PartyMon } from '../game/state';
import { addItem, BAG_CAPACITY, PC_ITEM_CAPACITY } from '../game/state';
import { c } from '../rom/constants';
import { PAD_A, PAD_B } from '../engine/pad';
import { encodePlain } from './TextPrinter';
import { handleMenuInput, LowSensitivity, restoreScreen, saveScreen, twoOptionMenu } from './menus';
import { chooseQuantity, displayListMenu, type ListEntry } from './listMenu';
import { statusScreen } from './statusScreen';
import { itemData, species } from '../game/pokemon';
import { calcStats } from '../game/pokemon';
import { calcLevelFromExperience } from '../battle/experience';
import { isStarterPikachu, modifyPikachuHappiness } from '../game/pikachu';
import { persistCheckpoint } from './startMenu';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';

const MONS_PER_BOX = 20;
const NUM_BOXES = 12;
/** wBoxNumString */
const W_BOX_NUM_STRING = 0xcd3d;
const BALL_TILE = 0x78;

/** PlaceString with `next` lines `spacing` rows apart; returns the x after the last line. */
const put = (e: Engine, x: number, y: number, s: string, spacing = 2): number => {
  let cy = y;
  let end = x;
  for (const line of s.split('{next}')) {
    const codes = encodePlain(line);
    codes.forEach((code, i) => e.screen.put(x + i, cy, code));
    end = x + codes.length;
    cy += spacing;
  }
  return end;
};

const isHM = (item: number) => item >= c('item', 'HM01') && item < c('item', 'TM01');

// ------------------------------------------------------------------ Pokécenter PC
/** TX_SCRIPT_POKECENTER_PC → ActivatePC */
export function* activatePC(env: ScriptEnv): Co<boolean> {
  const e = env.e;
  const buffer2 = saveScreen(e);
  e.hooks.playSound?.('turn_on_pc');
  yield* env.printText('TurnedOnPC1Text');
  yield* env.waitForSoundToFinish();
  restoreScreen(e, buffer2);
  yield* e.delayFrames(3);
  for (;;) {
    // PCMainMenu
    const menu = displayPCMainMenu(e, buffer2);
    const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: menu.length, current: 0, watchedKeys: PAD_A | PAD_B });
    const which = key & PAD_B ? 'logoff' : (menu[item] ?? 'logoff');
    if (which === 'logoff') break;
    yield* env.playSoundAndWait('enter_pc');
    if (which === 'bills') {
      yield* env.printText(env.checkEvent('EVENT_MET_BILL') ? 'AccessedBillsPCText' : 'AccessedSomeonesPCText');
      yield* billsPC(env, true, buffer2);
    } else if (which === 'players') {
      yield* env.printText('AccessedMyPCText');
      yield* playerPC(env, true, buffer2);
    } else if (which === 'oaks') {
      yield* oaksPC(env);
    } else {
      yield* leaguePC(env);
    }
    // ReloadMainMenu
    env.updateSprites();
  }
  // LogOff
  yield* env.playSoundAndWait('turn_off_pc');
  return false;
}

type PCEntry = 'bills' | 'players' | 'oaks' | 'league' | 'logoff';

/** DisplayPCMainMenu: returns the menu entries above LOG OFF. */
function displayPCMainMenu(e: Engine, buffer2: Int16Array): PCEntry[] {
  restoreScreen(e, buffer2);
  const s = e.state;
  const str = e.bundle.strings;
  const hof = (s.vars.wNumHoFTeams ?? 0) > 0;
  const dex = e.env.checkEvent('EVENT_GOT_POKEDEX');
  const entries: PCEntry[] = ['bills', 'players'];
  if (hof) entries.push('oaks', 'league');
  else if (dex) entries.push('oaks');
  e.screen.box(0, 0, entries.length * 2 + 2, 14);
  put(e, 2, 2, e.env.checkEvent('EVENT_MET_BILL') ? str.BillsPCText : str.SomeonesPCText);
  const nx = put(e, 2, 4, s.player.name);
  put(e, nx, 4, str.PlayersPCText);
  if (entries.includes('oaks')) put(e, 2, 6, str.OaksPCText);
  if (entries.includes('league')) put(e, 2, 8, str.PKMNLeaguePCText);
  put(e, 2, 2 + entries.length * 2, str.LogOffPCText);
  return entries;
}

/** TX_SCRIPT_BILLS_PC: Bill's PC used directly (the PC in Bill's house). */
export function* billsPCDirect(env: ScriptEnv): Co<boolean> {
  yield* billsPC(env, false, saveScreen(env.e));
  return false;
}

/** TX_SCRIPT_PLAYERS_PC: the item PC used directly (the PC in the player's room). */
export function* playerPCDirect(env: ScriptEnv): Co<boolean> {
  yield* playerPC(env, false, saveScreen(env.e));
  return false;
}

// ------------------------------------------------------------------ Bill's PC
function boxNumber(e: Engine): string {
  return String(e.state.currentBox + 1);
}

/** BillsPC_ */
function* billsPC(env: ScriptEnv, generic: boolean, buffer2: Int16Array): Co {
  const e = env.e;
  e.ram.noTextDelay = true;
  const savedScroll = e.ram.listScrollOffset;
  if (!generic) {
    e.hooks.playSound?.('turn_on_pc');
    yield* env.printText('SwitchOnText');
  }
  let parent = 0;
  for (;;) {
    // BillsPCMenu
    e.screen.setGlyphOverride(BALL_TILE, e.bundle.ui.pokeballs.pixels.slice(0, 64));
    restoreScreen(e, buffer2);
    e.screen.box(0, 12, 4, 18);
    e.screen.box(0, 0, 12, 12);
    env.updateSprites();
    put(e, 2, 2, e.bundle.strings.BillsPCMenuText);
    e.ram.listScrollOffset = 0;
    e.screen.box(9, 14, 2, 9);
    const n = boxNumber(e);
    put(e, 19 - n.length, 16, n);
    put(e, 10, 16, e.bundle.strings.BoxNoPCText);
    yield* e.delayFrames(3);
    const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: 5, current: parent, watchedKeys: PAD_A | PAD_B });
    if (key & PAD_B) break;
    e.screen.put(1, 2 + item * 2, 0xec);
    parent = item;
    if (item === 5) break;
    const box = () => e.state.boxes[e.state.currentBox] ?? [];
    const monList = function* (mons: PartyMon[]) {
      // DisplayMonListMenu
      const entries: ListEntry[] = mons.map((m) => ({ id: m.species, name: m.nickname, level: m.boxLevel }));
      const cursor = { item: e.ram.partySavedMenuItem, scroll: 0 };
      const r = yield* displayListMenu(e, { kind: 'pcmons', entries, cursor });
      e.ram.partySavedMenuItem = cursor.item;
      if (r) e.ram.nameBuffer = mons[r.index].nickname;
      return r;
    };
    if (item === 0) {
      // BillsPCWithdraw
      if (!box().length) {
        yield* env.printText('NoMonText');
        continue;
      }
      if (e.state.party.length >= 6) {
        yield* env.printText('CantTakeMonText');
        continue;
      }
      const r = yield* monList(box());
      if (!r) continue;
      if (!(yield* depositWithdrawMenu(e, false, box(), r.index))) continue;
      const mon = structuredClone(box()[r.index]);
      if (isStarterPikachu(e.state, mon)) yield* playPikachuCry(e, pikachuCry(35));
      else e.hooks.playCry?.(mon.species);
      withdraw(e, r.index);
      yield* env.waitForSoundToFinish();
      yield* env.printText('MonIsTakenOutText');
    } else if (item === 1) {
      // BillsPCDeposit
      if (e.state.party.length === 1) {
        yield* env.printText('CantDepositLastMonText');
        continue;
      }
      if (box().length >= MONS_PER_BOX) {
        yield* env.printText('BoxFullText');
        continue;
      }
      const r = yield* monList(e.state.party);
      if (!r) continue;
      const mon = e.state.party[r.index];
      const pikachu = isStarterPikachu(e.state, mon);
      if (pikachu && e.ram.pikachuOverworldStateFlags & 2) {
        yield* env.printText('SleepingPikachuText2');
        continue;
      }
      if (!(yield* depositWithdrawMenu(e, true, e.state.party, r.index))) continue;
      if (pikachu) yield* playPikachuCry(e, pikachuCry(28));
      else e.hooks.playCry?.(mon.species);
      const h = modifyPikachuHappiness(e.bundle, e.state, 'PIKAHAPPY_DEPOSITED', mon, e.state.party, e.ram.pikachuEmotionModifier);
      if (h) e.store.dispatch({ type: 'setPikachu', happiness: h.happiness, mood: h.mood }, { undoable: false });
      deposit(e, r.index);
      yield* env.waitForSoundToFinish();
      e.ram.mem.set(W_BOX_NUM_STRING, boxNumber(e));
      yield* env.printText('MonWasStoredText');
    } else if (item === 2) {
      // BillsPCRelease
      if (!box().length) {
        yield* env.printText('NoMonText');
        continue;
      }
      for (;;) {
        const r = yield* monList(box());
        if (!r) break;
        const mon = box()[r.index];
        if (isStarterPikachu(e.state, mon)) {
          yield* playPikachuCry(e, pikachuCry(40));
          yield* env.printText('PikachuUnhappyText');
          break;
        }
        yield* env.printText('OnceReleasedText');
        if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7)) !== 0) continue;
        const boxes = structuredClone(e.state.boxes);
        boxes[e.state.currentBox].splice(r.index, 1);
        e.store.dispatch({ type: 'setBoxes', boxes }, { undoable: false });
        e.hooks.playCry?.(mon.species);
        yield* env.waitForSoundToFinish();
        yield* env.printText('MonWasReleasedText');
        break;
      }
    } else if (item === 3) {
      yield* changeBox(env);
    } else if (item === 4) {
      yield* printPCBox(env, box().length);
    }
  }
  // ExitBillsPC
  if (!generic) yield* env.playSoundAndWait('turn_off_pc');
  restoreScreen(e, buffer2);
  e.screen.clearGlyphOverrides();
  e.ram.listScrollOffset = savedScroll;
  e.ram.noTextDelay = false;
}

/** MoveMon PARTY_TO_BOX + RemovePokemon (the box level byte takes the party level). */
function deposit(e: Engine, index: number): void {
  const party = structuredClone(e.state.party);
  const [mon] = party.splice(index, 1);
  mon.boxLevel = mon.level;
  const boxes = structuredClone(e.state.boxes);
  (boxes[e.state.currentBox] ??= []).push(mon);
  e.store.dispatch({ type: 'setBoxes', boxes }, { undoable: false });
  e.store.dispatch({ type: 'setParty', party }, { undoable: false });
}

/** MoveMon BOX_TO_PARTY: level from experience, stats recalculated with stat exp; HP is kept. */
function withdraw(e: Engine, index: number): void {
  const boxes = structuredClone(e.state.boxes);
  const [mon] = boxes[e.state.currentBox].splice(index, 1);
  const sp = species(e.bundle, mon.species);
  mon.level = calcLevelFromExperience(e.bundle, sp.growthRate, mon.exp);
  Object.assign(mon, calcStats(sp, mon.dvs, mon.statExp, mon.level, true));
  e.store.dispatch({ type: 'setBoxes', boxes }, { undoable: false });
  e.store.dispatch({ type: 'setParty', party: [...e.state.party, mon] }, { undoable: false });
}

/** DisplayDepositWithdrawMenu: true when DEPOSIT/WITHDRAW was chosen. */
function* depositWithdrawMenu(e: Engine, depositing: boolean, list: PartyMon[], which: number): Co<boolean> {
  const str = e.bundle.strings;
  e.screen.box(9, 10, 6, 9);
  put(e, 11, 12, depositing ? str.DepositPCText : str.WithdrawPCText);
  put(e, 11, 14, str.StatsCancelPCText);
  e.ram.partySavedMenuItem = 0;
  for (;;) {
    const [item, key] = yield* handleMenuInput(e, { topX: 10, topY: 12, maxItem: 2, current: 0, watchedKeys: PAD_A | PAD_B });
    if (key & PAD_B) return false;
    if (item === 0) return true;
    if (item === 2) return false;
    // .viewStats
    const buffer1 = saveScreen(e);
    yield* statusScreen(e, list, which, !depositing);
    restoreScreen(e, buffer1);
  }
}

/** ChangeBox: switching boxes saves the game. */
function* changeBox(env: ScriptEnv): Co {
  const e = env.e;
  yield* env.printText('WhenYouChangeBoxText');
  if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7)) !== 0) return;
  const boxes = structuredClone(e.state.boxes);
  while (boxes.length < NUM_BOXES) boxes.push([]);
  if (!env.getVar('flag:HAS_CHANGED_BOXES')) {
    // EmptyAllSRAMBoxes: every box but the one in WRAM starts empty
    for (let i = 0; i < NUM_BOXES; i++) if (i !== e.state.currentBox) boxes[i] = [];
  }
  // DisplayChangeBoxMenu
  e.screen.box(0, 0, 2, 9);
  yield* env.printText('ChooseABoxText');
  e.screen.box(11, 0, 12, 7);
  put(e, 13, 1, e.bundle.strings.BoxNames, 1);
  const n = boxNumber(e);
  put(e, 10 - n.length, 2, n);
  put(e, 1, 2, e.bundle.strings.BoxNoText);
  for (let i = 0; i < NUM_BOXES; i++) if (boxes[i]?.length) e.screen.put(18, 1 + i, BALL_TILE);
  const [item, key] = yield* handleMenuInput(e, {
    topX: 12,
    topY: 1,
    maxItem: 11,
    current: e.state.currentBox,
    watchedKeys: PAD_A | PAD_B,
    spacing: 1,
  });
  if (key & PAD_B) return;
  yield* env.playSoundWaitForCurrent('save');
  yield* env.waitForSoundToFinish();
  env.setVar('flag:HAS_CHANGED_BOXES', 1);
  e.store.dispatch({ type: 'setBoxes', boxes, currentBox: item }, { undoable: false });
  // SaveGameData
  yield* persistCheckpoint(e);
}

/**
 * PrintPCBox with no Game Boy Printer attached: the link check reads $FF, so
 * GBPrinter_CheckForErrors reports Printer Error 2 until B cancels.
 */
function* printPCBox(env: ScriptEnv, count: number): Co {
  const e = env.e;
  if (!count) {
    yield* env.printText('NoPokemonText');
    return;
  }
  const saved = saveScreen(e);
  yield* printerJob(e);
  restoreScreen(e, saved);
}

// ------------------------------------------------------------------ player's PC
/** PlayerPC */
function* playerPC(env: ScriptEnv, generic: boolean, buffer2: Int16Array): Co {
  const e = env.e;
  e.ram.bagSavedMenuItem = 0;
  if (!generic) {
    e.hooks.playSound?.('turn_on_pc');
    yield* env.printText('TurnedOnPC2Text');
  }
  let parent = 0;
  for (;;) {
    // PlayerPCMenu
    e.ram.noTextDelay = true;
    restoreScreen(e, buffer2);
    e.screen.box(0, 0, 8, 14);
    env.updateSprites();
    put(e, 2, 2, e.bundle.strings.PlayersPCMenuEntries);
    e.ram.listScrollOffset = 0;
    yield* env.printText('WhatDoYouWantText');
    const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: 3, current: parent, watchedKeys: PAD_A | PAD_B });
    if (key & PAD_B || item === 3) break;
    e.screen.put(1, 2 + item * 2, 0xec);
    parent = item;
    if (item === 1) yield* pcDeposit(env);
    else if (item === 0) yield* pcWithdraw(env);
    else yield* pcToss(env);
  }
  // ExitPlayerPC
  if (!generic) yield* env.playSoundAndWait('turn_off_pc');
  restoreScreen(e, buffer2);
  e.ram.listScrollOffset = 0;
  e.ram.bagSavedMenuItem = 0;
  e.ram.noTextDelay = false;
}

/** DisplayListMenuID on an item list with SELECT swapping written back. */
function* itemList(e: Engine, list: () => ItemSlot[], commit: (l: ItemSlot[]) => void) {
  const entries = list().map((s) => ({ id: s.item, qty: s.qty }));
  const cursor = { item: 0, scroll: e.ram.listScrollOffset };
  const r = yield* displayListMenu(e, {
    kind: 'items',
    entries,
    cursor,
    onSwap: (l) => commit(l.map((en) => ({ item: en.id, qty: en.qty ?? 0 }))),
  });
  e.ram.listScrollOffset = cursor.scroll;
  return r;
}

const setBag = (e: Engine, bag: ItemSlot[]) => e.store.dispatch({ type: 'setBag', bag }, { undoable: false });
const setPc = (e: Engine, items: ItemSlot[]) => e.store.dispatch({ type: 'setPcItems', items }, { undoable: false });

/** Moves `qty` of the slot at `index` of `from` into `to`; false when `to` has no room. */
function transfer(from: ItemSlot[], index: number, qty: number, to: ItemSlot[], cap: number): boolean {
  if (!addItem(to, from[index].item, qty, cap)) return false;
  from[index].qty -= qty;
  if (!from[index].qty) from.splice(index, 1);
  return true;
}

function* pcDeposit(env: ScriptEnv): Co {
  const e = env.e;
  e.ram.listScrollOffset = 0;
  if (!e.state.bag.length) {
    yield* env.printText('NothingToDepositText');
    return;
  }
  for (;;) {
    yield* env.printText('WhatToDepositText');
    const r = yield* itemList(e, () => e.state.bag, (l) => setBag(e, l));
    if (!r) return;
    let qty = 1;
    if (!itemData(e.bundle, r.entry.id).isKey) {
      yield* env.printText('DepositHowManyText');
      const q = yield* chooseQuantity(e, r.entry.qty ?? 1);
      if (q === undefined) continue;
      qty = q;
    }
    const bag = structuredClone(e.state.bag);
    const pc = structuredClone(e.state.pcItems);
    if (!transfer(bag, r.index, qty, pc, PC_ITEM_CAPACITY)) {
      yield* env.printText('NoRoomToStoreText');
      continue;
    }
    setBag(e, bag);
    setPc(e, pc);
    e.ram.nameBuffer = itemData(e.bundle, r.entry.id).name;
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('withdraw_deposit');
    yield* env.printText('ItemWasStoredText');
  }
}

function* pcWithdraw(env: ScriptEnv): Co {
  const e = env.e;
  e.ram.listScrollOffset = 0;
  if (!e.state.pcItems.length) {
    yield* env.printText('NothingStoredText');
    return;
  }
  for (;;) {
    yield* env.printText('WhatToWithdrawText');
    const r = yield* itemList(e, () => e.state.pcItems, (l) => setPc(e, l));
    if (!r) return;
    let qty = 1;
    if (!itemData(e.bundle, r.entry.id).isKey) {
      yield* env.printText('WithdrawHowManyText');
      const q = yield* chooseQuantity(e, r.entry.qty ?? 1);
      if (q === undefined) continue;
      qty = q;
    }
    const bag = structuredClone(e.state.bag);
    const pc = structuredClone(e.state.pcItems);
    if (!transfer(pc, r.index, qty, bag, BAG_CAPACITY)) {
      yield* env.printText('CantCarryMoreText');
      continue;
    }
    setBag(e, bag);
    setPc(e, pc);
    e.ram.nameBuffer = itemData(e.bundle, r.entry.id).name;
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('withdraw_deposit');
    yield* env.printText('WithdrewItemText');
  }
}

function* pcToss(env: ScriptEnv): Co {
  const e = env.e;
  e.ram.listScrollOffset = 0;
  if (!e.state.pcItems.length) {
    yield* env.printText('NothingStoredText');
    return;
  }
  for (;;) {
    yield* env.printText('WhatToTossText');
    const r = yield* itemList(e, () => e.state.pcItems, (l) => setPc(e, l));
    if (!r) return;
    let qty = 1;
    if (!itemData(e.bundle, r.entry.id).isKey && !isHM(r.entry.id)) {
      yield* env.printText('TossHowManyText');
      const q = yield* chooseQuantity(e, r.entry.qty ?? 1);
      if (q === undefined) continue;
      qty = q;
    }
    yield* tossItem(e, r.index, qty, () => e.state.pcItems, (l) => setPc(e, l));
  }
}

/** TossItem_ on the slot `index` of an item list. Returns whether the item was thrown away. */
export function* tossItem(e: Engine, index: number, qty: number, list: () => ItemSlot[], commit: (l: ItemSlot[]) => void): Co<boolean> {
  const item = list()[index].item;
  const data = itemData(e.bundle, item);
  if (isHM(item) || data.isKey) {
    yield* e.printText('TooImportantToTossText');
    return false;
  }
  e.ram.nameBuffer = data.name;
  yield* e.printText('IsItOKToTossItemText');
  if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7)) !== 0) return false;
  const l = structuredClone(list());
  l[index].qty -= qty;
  if (!l[index].qty) l.splice(index, 1);
  commit(l);
  e.ram.nameBuffer = data.name;
  yield* e.printText('ThrewAwayItemText');
  return true;
}

// ------------------------------------------------------------------ Oak's and the League PC
/** OpenOaksPC */
function* oaksPC(env: ScriptEnv): Co {
  const e = env.e;
  const buffer2 = saveScreen(e);
  yield* env.printText('AccessedOaksPCText');
  yield* env.printText('GetDexRatedText');
  if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7)) === 0) yield* env.displayDexRating();
  yield* env.printText('ClosedOaksPCText');
  restoreScreen(e, buffer2);
}

/** PKMNLeaguePC: listed once wNumHoFTeams > 0; it shows the Hall of Fame records. */
function* leaguePC(env: ScriptEnv): Co {
  yield* pkmnLeaguePC(env.e);
}
