/**
 * UseItem (engine/items/item_effects.asm): every entry of ItemUsePtrTable.
 * Works in battle (on the battle's working party/bag) and in the field (on
 * copies committed to the store afterwards). wActionResultOrTookBattleTurn
 * is returned and, in battle, written to `battle.actionResult`.
 */
import { withoutTextAsm } from '../rom/text';
import type { Co, Engine } from '../engine/Engine';
import type { ItemSlot, PartyMon } from '../game/state';
import type { TextOp } from '../data/schema';
import type { Battle } from '../battle/Battle';
import { c } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { calcExperience, calcStats, itemData, movePP, species } from '../game/pokemon';
import { getBit } from '../game/state';
import { showPokedexMenu } from '../ui/pokedex';
import { partyMenu, goBackToPartyMenu, redrawPartyMenu, canLearnTM, canUseStone } from '../ui/partyMenu';
import { twoOptionMenu, handleMenuInput, namingScreen } from '../ui/menus';
import { encodePlain } from '../ui/TextPrinter';
import { learnMove, learnMoveFromLevelUp, evolutionAfterBattle, isHM } from '../game/evolution';
import { isStarterPikachu, modifyPikachuHappiness } from '../game/pikachu';
import { showPokedexData } from '../ui/pokedex';
import { BattleUI } from '../battle/BattleUI';
import { PAD_A, PAD_B } from '../engine/pad';
import { MOD_STATS, PP_MASK, S2, S3, ST } from '../battle/state';
import { statModifierUpEffect } from '../battle/effects';
import { moveAnimation } from '../battle/animation';
import { WILD_BATTLE } from '../battle/Battle';
import { printStatsBox } from '../battle/experience';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';

const I = (n: string) => c('item', n);

export interface ItemContext {
  e: Engine;
  battle?: Battle;
  party: PartyMon[];
  bag: ItemSlot[];
  item: number;
  /** wActionResultOrTookBattleTurn: 1 used, 0 failed, 2 not used (no turn). */
  result: number;
  mem: Map<number, string | number>;
  /** wPseudoItemID (Softboiled / Dig use the item code without an item). */
  pseudo?: number;
}

export interface UseItemOptions {
  battle?: Battle;
  pseudo?: number;
}

/** UseItem_: returns wActionResultOrTookBattleTurn. */
export function* useItem(e: Engine, item: number, o: UseItemOptions = {}): Co<number> {
  const b = o.battle;
  const ctx: ItemContext = {
    e,
    battle: b,
    party: b ? b.party : structuredClone(e.state.party),
    bag: b ? b.bag : structuredClone(e.state.bag),
    item,
    result: 1,
    mem: b ? b.mem : new Map(),
    pseudo: o.pseudo,
  };
  setMem(ctx, 'wStringBuffer', itemData(e.bundle, item).name);
  setMem(ctx, 'wNameBuffer', itemData(e.bundle, item).name);
  const handler = item >= I('HM01') ? itemUseTMHM : (HANDLERS[item] ?? unusableItem);
  yield* handler(ctx);
  if (b) b.actionResult = ctx.result;
  else commitField(ctx);
  return ctx.result;
}

/** Outside battle the party and bag edits go straight to the game state. */
function commitField(x: ItemContext): void {
  if (x.battle) return;
  x.e.store.dispatch({ type: 'setParty', party: x.party }, { undoable: false });
  x.e.store.dispatch({ type: 'setBag', bag: x.bag }, { undoable: false });
}

type Handler = (x: ItemContext) => Co;

// ------------------------------------------------------------------ helpers
function setMem(x: ItemContext, name: string, v: string | number): void {
  x.mem.set(ramSym(name), v);
}

function ops(e: Engine, labels: string[]): TextOp[] {
  return labels.flatMap((l): TextOp[] => {
    if (l === '<low>') return [{ t: 'low' }];
    if (l === '<promptbutton>') return [{ t: 'promptbutton' }];
    const t = e.bundle.texts[l];
    if (!t) throw new Error(`text ${l} missing from bundle`);
    return withoutTextAsm(t);
  });
}

export function* print(x: ItemContext, ...labels: string[]): Co {
  const e = x.e;
  if (x.battle) {
    yield* e.printOps(ops(e, labels), x.battle.textContext());
    return;
  }
  yield* e.printOps(ops(e, labels), {
    ram: (label, addr) => (addr !== undefined && x.mem.has(addr) ? x.mem.get(addr) : e.ramValue(label, addr)),
  });
}

function inBattle(x: ItemContext): number {
  return x.battle?.isInBattle ?? 0;
}

/** RemoveItemFromInventory (one of the item). */
function removeUsedItem(x: ItemContext): void {
  const i = x.bag.findIndex((s) => s.item === x.item);
  if (i < 0) return;
  x.bag[i].qty--;
  if (!x.bag[i].qty) x.bag.splice(i, 1);
}

export function* itemUseFailed(x: ItemContext, label: string): Co {
  x.result = 0;
  yield* print(x, label);
}
export const itemUseNotTime = (x: ItemContext) => itemUseFailed(x, '_ItemUseNotTimeText');
const itemUseNoEffect = (x: ItemContext) => itemUseFailed(x, '_ItemUseNoEffectText');
const unusableItem: Handler = (x) => itemUseNotTime(x);

/** PrintItemUseTextAndRemoveItem */
function* printItemUseTextAndRemoveItem(x: ItemContext): Co {
  yield* print(x, '_ItemUseText001', '<low>', '_ItemUseText002');
  x.e.hooks.playSound?.('SFX_HEAL_AILMENT');
  yield* x.e.waitForTextScrollButtonPress();
  removeUsedItem(x);
}

function happiness(x: ItemContext, event: string, mon: PartyMon | undefined): void {
  const r = modifyPikachuHappiness(x.e.bundle, x.e.state, event, mon, x.party, x.e.ram.pikachuEmotionModifier);
  if (r) x.e.store.dispatch({ type: 'setPikachu', happiness: r.happiness, mood: r.mood }, { undoable: false });
}

function setPikachuMood(x: ItemContext, modifier: number, mood: number): void {
  x.e.ram.pikachuEmotionModifier = modifier;
  x.e.store.dispatch({ type: 'setPikachu', mood }, { undoable: false });
}

// ------------------------------------------------------------------ balls
/** ItemUseBall */
function* itemUseBall(x: ItemContext): Co {
  const e = x.e;
  const b = x.battle;
  if (!b) return yield* itemUseNotTime(x);
  if (b.isInBattle !== WILD_BATTLE) return yield* throwBallAtTrainerMon(x);
  const BT = (n: string) => c('battle', n);
  const scripted = b.battleType === BT('BATTLE_TYPE_OLD_MAN') || b.battleType === BT('BATTLE_TYPE_PIKACHU');
  if (!scripted && x.party.length >= 6 && (e.state.boxes[e.state.currentBox]?.length ?? 0) >= 20) {
    return yield* itemUseFailed(x, '_BoxFullCannotThrowBallText');
  }
  b.capturedMonSpecies = 0;
  if (b.battleType === BT('BATTLE_TYPE_SAFARI')) b.numSafariBalls = (b.numSafariBalls - 1) & 0xff;
  let anim = 0x43; // captured
  b.loadScreen1();
  yield* print(x, '_ItemUseText001', '<low>', '_ItemUseText002');
  let captured = false;
  const en = b.enemy.mon;
  if (b.isGhostBattle()) anim = 0x10;
  else if (scripted) {
    if (b.battleType === BT('BATTLE_TYPE_OLD_MAN')) {
      b.capturedMonSpecies = 1;
      if (getBit(e.state.eventFlags, c('event', 'EVENT_INITIAL_CATCH_TRAINING'))) anim = 0x63;
      else captured = true;
    } else captured = true;
  } else if (e.world.data.id === c('map', 'POKEMON_TOWER_6F') && b.enemySpecies2 === c('pokemon', 'RESTLESS_SOUL')) anim = 0x10;
  else {
    const r = yield* catchCalc(x, en.catchRate);
    if (r === 'captured') captured = true;
    else anim = r;
  }
  if (captured) anim = 0x43;
  if (scripted) b.simulatedTrainerName = undefined; // the player's name is copied back from wGrassRate
  yield* b.delay(20);
  b.whoseTurn = 0;
  b.damageMultipliers = 0;
  // TOSS_ANIM through MoveAnimation: TossBallAnimation with wPokeBallAnimData and wCurItem
  b.anim.pokeBallAnimData = anim;
  b.anim.curItem = x.item;
  yield* moveAnimation(b, c('move', 'TOSS_ANIM'), 0);
  const msgs: Record<number, string> = {
    0x10: '_ItemUseBallText00',
    0x20: '_ItemUseBallText01',
    0x61: '_ItemUseBallText02',
    0x62: '_ItemUseBallText03',
    0x63: '_ItemUseBallText04',
  };
  if (msgs[anim]) {
    yield* print(x, msgs[anim]);
    b.ui.clearSprites();
    return yield* ballDone(x);
  }
  // caught: reload the enemy's data as its original species (Ditto if transformed), keeping HP and status
  const hp = en.hp;
  const status = en.status;
  if (b.enemy.s3 & S3.TRANSFORMED) b.enemySpecies2 = c('pokemon', 'DITTO');
  else {
    b.enemy.s3 |= S3.TRANSFORMED;
    b.transformedEnemyMonOriginalDVs = en.dvs;
  }
  b.curEnemyLevel = en.level;
  b.loadEnemyMonData();
  en.hp = hp;
  en.status = status;
  b.capturedMonSpecies = en.species;
  if (scripted) {
    yield* print(x, '_ItemUseBallText05', '<promptbutton>');
    e.hooks.playSound?.('SFX_CAUGHT_MON');
    b.ui.clearSprites();
    return yield* ballDone(x);
  }
  e.hooks.playSound?.('SFX_CAUGHT_MON');
  yield* print(x, '_ItemUseBallText05', '<promptbutton>');
  const sp = species(e.bundle, en.species);
  const owned = getBit(e.state.pokedex.owned, sp.dex - 1);
  e.store.dispatch({ type: 'setPokedex', dex: sp.dex, owned: true }, { undoable: false });
  if (!owned) {
    e.hooks.playSound?.('SFX_DEX_PAGE_ADDED');
    yield* print(x, '_ItemUseBallText06', '<promptbutton>');
    b.ui.clearSprites();
    yield* showPokedexData(e, en.species);
    b.ui.reloadHudTiles();
  }
  setPikachuMood(x, 1, 0x85);
  if (x.party.length < 6) {
    b.ui.clearSprites();
    yield* b.printEmptyString();
    const mon = caughtMon(x, false);
    mon.nickname = yield* askName(x, en.species);
    x.party.push(mon);
  } else {
    b.ui.clearSprites();
    const mon = caughtMon(x, true);
    mon.nickname = yield* askName(x, en.species);
    e.store.dispatch({ type: 'addBoxMon', mon }, { undoable: false });
    setMem(x, 'wBoxMon1Nick', mon.nickname);
    yield* print(x, getBit(e.state.eventFlags, c('event', 'EVENT_MET_BILL')) ? '_ItemUseBallText07' : '_ItemUseBallText08');
  }
  yield* ballDone(x);
}

function* ballDone(x: ItemContext): Co {
  // the scripted battles don't use up the ball
  if (x.battle?.battleType) return;
  removeUsedItem(x);
}

/** The capture formula. Returns 'captured' or the wPokeBallAnimData value for a failed throw. */
// eslint-disable-next-line require-yield
function* catchCalc(x: ItemContext, catchRate: number): Co<'captured' | number> {
  const b = x.battle!;
  const en = b.enemy.mon;
  const item = x.item;
  let r1: number;
  for (;;) {
    r1 = b.random();
    if (item === I('MASTER_BALL')) return 'captured';
    if (item === I('POKE_BALL')) break;
    if (r1 > 200) continue;
    if (item === I('GREAT_BALL')) break;
    if (r1 > 150) continue;
    break;
  }
  if (en.status) {
    const sub = en.status & (ST.FRZ | ST.SLP_MASK) ? 25 : 12;
    if (r1 < sub) return 'captured';
    r1 -= sub;
  }
  let q = Math.floor((en.maxHp * 255) / (item === I('GREAT_BALL') ? 8 : 12));
  const div = (en.hp >> 2) & 0xff || 1;
  q = Math.floor(q / div);
  const xValue = q > 0xff ? 0xff : q;
  if (catchRate >= r1) {
    if (q > 0xff) return 'captured';
    const r2 = b.random();
    if (xValue >= r2) return 'captured';
  }
  // .failedToCapture: work out the number of shakes
  const ballDiv = item === I('POKE_BALL') ? 255 : item === I('GREAT_BALL') ? 200 : 150;
  const z = Math.floor((catchRate * 100) / ballDiv);
  if (z > 0xff) return 0x63;
  let w = Math.floor((z * xValue) / 255) & 0xff;
  if (en.status) w = (w + (en.status & (ST.FRZ | ST.SLP_MASK) ? 10 : 5)) & 0xff;
  if (w < 10) return 0x20;
  if (w < 30) return 0x61;
  if (w < 70) return 0x62;
  return 0x63;
}

/** _AddPartyMon (in-battle capture) / SendNewMonToBox. */
function caughtMon(x: ItemContext, box: boolean): PartyMon {
  const e = x.e;
  const b = x.battle!;
  const en = b.enemy.mon;
  const sp = species(e.bundle, en.species);
  const moves = box ? [...en.moves] : moveSet(e, en.species, en.level);
  const pp = box ? [...en.pp] : moves.map((m) => movePP(e.bundle, m));
  const stats = box ? calcStats(sp, en.dvs, { hp: 0, atk: 0, def: 0, spd: 0, spc: 0 }, en.level, false) : { maxHp: en.maxHp, atk: en.atk, def: en.def, spd: en.spd, spc: en.spc };
  let catchRate = box ? en.catchRate : sp.catchRate;
  if (en.species === c('pokemon', 'KADABRA')) catchRate = c('item', 'TWISTEDSPOON_GSC');
  return {
    species: en.species,
    hp: en.hp,
    boxLevel: box ? en.level : 0,
    status: en.status,
    types: [...sp.types] as [number, number],
    catchRate,
    moves: moves as [number, number, number, number],
    otId: e.state.player.id,
    exp: calcExperience(e.bundle, sp.growthRate, b.curEnemyLevel),
    statExp: { hp: 0, atk: 0, def: 0, spd: 0, spc: 0 },
    dvs: en.dvs,
    pp: pp as [number, number, number, number],
    level: en.level,
    ...stats,
    nickname: sp.name,
    otName: e.state.player.name,
  };
}

function moveSet(e: Engine, sp: number, level: number): number[] {
  const s = species(e.bundle, sp);
  const moves = [0, 0, 0, 0];
  s.level1Moves.forEach((m, i) => (moves[i] = m));
  for (const { level: lv, move } of s.learnset) {
    if (level < lv) break;
    if (moves.includes(move)) continue;
    const empty = moves.indexOf(0);
    if (empty >= 0) moves[empty] = move;
    else {
      moves.shift();
      moves.push(move);
    }
  }
  return moves;
}

/** AskName (engine/menus/naming_screen.asm): returns the nickname (the species name if declined). */
export function* askName(x: ItemContext, sp: number): Co<string> {
  const e = x.e;
  const name = species(e.bundle, sp).name;
  const saved = e.screen.cells.slice();
  if (inBattle(x) === WILD_BATTLE) x.battle!.ui.clearArea(0, 0, 4, 11);
  setMem(x, 'wNameBuffer', name);
  yield* print(x, '_DoYouWantToNicknameText');
  const choice = yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7);
  if (choice !== 0) return name;
  const entered = yield* namingScreen(e, 'mon', name);
  e.screen.cells.set(saved);
  e.screen.markDirty();
  if (x.battle) x.battle.ui.reloadHudTiles();
  return entered || name;
}

function* throwBallAtTrainerMon(x: ItemContext): Co {
  const b = x.battle!;
  b.loadScreen1();
  yield* b.delay(3);
  yield* moveAnimation(b, c('move', 'TOSS_ANIM'), 0);
  yield* print(x, '_ThrowBallAtTrainerMonText1');
  yield* print(x, '_ThrowBallAtTrainerMonText2');
  removeUsedItem(x);
}

// ------------------------------------------------------------------ medicine
/** Party menu for using an item: returns the chosen index or undefined. */
function* chooseMon(x: ItemContext, mode: 'item' | 'stone' | 'tm', extra: { stone?: number; tmMove?: number } = {}): Co<number | undefined> {
  const r = yield* partyMenu(x.e, { party: x.party, mode, battle: x.battle, ...extra });
  return r;
}

/** ItemUseMedicine (potions, status heals, revives, drinks, Full Restore) and ItemUseVitamin. */
function* itemUseMedicine(x: ItemContext): Co {
  const e = x.e;
  if (!x.party.length) {
    x.result = 2;
    return yield* print(x, '_DontHavePokemonText');
  }
  const which = yield* chooseMon(x, 'item');
  if (which === undefined) return yield* canceled(x);
  const pm = x.party[which];
  if (x.item <= I('CALCIUM')) happiness(x, 'PIKAHAPPY_USEDITEM', pm);
  const it = x.item;
  if (it >= I('HP_UP') && it <= I('RARE_CANDY')) return yield* useVitamin(x, which);
  if (it === I('FULL_HEAL') || (it >= I('ANTIDOTE') && it <= I('PARLYZ_HEAL'))) return yield* cureStatus(x, which, it);
  return yield* healHP(x, which);
}

function* canceled(x: ItemContext): Co {
  x.result = 0;
  yield* reloadAfterMenu(x);
}

function* reloadAfterMenu(x: ItemContext): Co {
  if (x.battle) {
    x.battle.ui.reloadHudTiles();
    x.battle.loadScreen1();
  } else x.e.screen.clear();
  yield;
}

const CURES: [string, string, number][] = [
  ['ANTIDOTE', '_AntidoteText', ST.PSN],
  ['BURN_HEAL', '_BurnHealText', ST.BRN],
  ['ICE_HEAL', '_IceHealText', ST.FRZ],
  ['AWAKENING', '_AwakeningText', ST.SLP_MASK],
  ['PARLYZ_HEAL', '_ParlyzHealText', ST.PAR],
];

/** .cureStatusAilment */
function* cureStatus(x: ItemContext, which: number, it: number): Co {
  const pm = x.party[which];
  const entry = CURES.find(([n]) => I(n) === it);
  const mask = entry ? entry[2] : 0xff;
  const msg = entry ? entry[1] : '_FullHealText';
  if (!(pm.status & mask)) {
    yield* itemUseNoEffect(x);
    return yield* reloadAfterMenu(x);
  }
  pm.status = 0;
  const b = x.battle;
  if (b && which === b.playerMonNumber) {
    b.player.mon.status = 0;
    b.player.s3 &= ~S3.BADLY_POISONED;
    // the party stats are copied over the battle stats (stat stages and badge boosts are lost)
    for (const k of ['maxHp', 'atk', 'def', 'spd', 'spc'] as const) b.player.mon[k] = pm[k];
    b.player.mon.level = pm.level;
  }
  yield* doneHealing(x, which, msg, false);
}

/** .healHP */
function* healHP(x: ItemContext, which: number): Co {
  const e = x.e;
  const pm = x.party[which];
  const it = x.item;
  const revive = it === I('REVIVE') || it === I('MAX_REVIVE');
  const b = x.battle;
  if (!pm.hp) {
    if (!revive) {
      yield* itemUseNoEffect(x);
      return yield* reloadAfterMenu(x);
    }
    if (b && (b.partyFoughtCurrentEnemyFlags >> which) & 1) b.partyGainExpFlags |= 1 << which;
  } else if (revive) {
    yield* itemUseNoEffect(x);
    return yield* reloadAfterMenu(x);
  }
  if (pm.hp === pm.maxHp) {
    if (it !== I('FULL_RESTORE') || !pm.status) {
      yield* itemUseNoEffect(x);
      return yield* reloadAfterMenu(x);
    }
    return yield* cureStatus(x, which, I('FULL_HEAL'));
  }
  e.ram.lowHealthAlarm = 0;
  const old = pm.hp;
  if (it === I('REVIVE')) pm.hp = pm.maxHp >> 1;
  else {
    let amount: number;
    if (x.pseudo) {
      // Softboiled: the user loses 1/5 of its max HP
      const user = x.party[e.ram.softboiledUser ?? 0];
      amount = Math.floor(user.maxHp / 5);
      const uOld = user.hp;
      user.hp = Math.max(0, user.hp - amount) & 0xffff;
      yield* e.env.playSoundWaitForCurrent('SFX_HEAL_HP');
      yield* animatePartyHPBar(x, e.ram.softboiledUser ?? 0, uOld);
    } else if (it === I('SODA_POP')) amount = 60;
    else if (it === I('LEMONADE')) amount = 80;
    else if (it === I('FRESH_WATER')) amount = 50;
    else if (it === I('SUPER_POTION')) amount = 50;
    else if (it === I('POTION')) amount = 20;
    else amount = 200; // Full Restore, Max Potion, Hyper Potion (Max Revive is capped below)
    pm.hp = (pm.hp + amount) & 0xffff;
    if (pm.hp >= pm.maxHp || it === I('FULL_RESTORE') || it === I('MAX_POTION') || it === I('MAX_REVIVE')) pm.hp = pm.maxHp;
    if (it === I('FULL_RESTORE')) pm.status = 0;
  }
  if (b && which === b.playerMonNumber) {
    b.player.mon.hp = pm.hp;
    if (it === I('FULL_RESTORE')) b.player.mon.status = 0;
  }
  setMem(x, 'wHPBarHPDifference', Math.abs(pm.hp - old));
  if (!x.pseudo) removeUsedItem(x);
  const healSound = !(it < I('FULL_RESTORE') || it === I('FULL_HEAL'));
  if (healSound) {
    yield* e.env.playSoundWaitForCurrent('SFX_HEAL_HP');
    yield* animatePartyHPBar(x, which, old);
  } else yield* e.env.playSoundWaitForCurrent('SFX_HEAL_AILMENT');
  yield* doneHealing(x, which, revive ? '_ReviveText' : '_PotionText', true);
}

/** .doneHealing / .showHealingItemMessage: redraw the party menu with the result message. */
function* doneHealing(x: ItemContext, which: number, msg: string, removed: boolean): Co {
  const e = x.e;
  if (!removed && !x.pseudo) removeUsedItem(x);
  if (!removed) yield* e.env.playSoundWaitForCurrent('SFX_HEAL_AILMENT');
  setMem(x, 'wNameBuffer', x.party[which].nickname);
  commitField(x);
  const mem: Record<number, string | number> = {};
  for (const [k, v] of x.mem) mem[k] = v;
  yield* redrawPartyMenu(e, { party: x.party, mode: 'item', message: { label: msg, mem } });
  yield* e.delayFrames(50);
  yield* e.waitForTextScrollButtonPress();
  yield* reloadAfterMenu(x);
}

/** UpdateHPBar2 on the party menu (HP bar at (4, 2i+1)). */
function* animatePartyHPBar(x: ItemContext, which: number, oldHp: number): Co {
  const e = x.e;
  const pm = x.party[which];
  const from = BattleUI.barPixels(oldHp, pm.maxHp);
  const to = BattleUI.barPixels(pm.hp, pm.maxHp);
  const step = to < from ? -1 : 1;
  for (let px = from; px !== to; ) {
    px += step;
    const y = which * 2 + 1;
    e.screen.put(4, y, 0x71);
    e.screen.put(5, y, 0x62);
    let rest = px;
    for (let i = 0; i < 6; i++) {
      const v = rest >= 8 ? 8 : rest;
      e.screen.put(6 + i, y, v === 8 ? 0x6b : 0x63 + v);
      rest = Math.max(0, rest - 8);
    }
    yield;
    yield;
  }
}

/** .useVitamin / .useRareCandy */
function* useVitamin(x: ItemContext, which: number): Co {
  const e = x.e;
  const pm = x.party[which];
  const sp = species(e.bundle, pm.species);
  setMem(x, 'wNameBuffer', pm.nickname);
  if (x.item === I('RARE_CANDY')) {
    if (pm.level >= c('battle', 'MAX_LEVEL')) {
      yield* print(x, '_VitaminNoEffectText');
      x.result = 0;
      return yield* reloadAfterMenu(x);
    }
    pm.level++;
    pm.exp = calcExperience(e.bundle, sp.growthRate, pm.level);
    const oldMax = pm.maxHp;
    Object.assign(pm, calcStats(sp, pm.dvs, pm.statExp, pm.level, true));
    pm.hp = (pm.hp + pm.maxHp - oldMax) & 0xffff;
    e.ram.mem.set(ramSym('wCurEnemyLevel'), pm.level);
    setMem(x, 'wCurEnemyLevel', pm.level);
    const mem: Record<number, string | number> = {};
    for (const [k, v] of x.mem) mem[k] = v;
    yield* redrawPartyMenu(e, { party: x.party, mode: 'item', message: { label: '_RareCandyText', mem } });
    printStatsBox({ e }, pm);
    yield* e.waitForTextScrollButtonPress();
    yield* learnMoveFromLevelUp(e, x.party, which, pm.level, { mem: x.mem, battle: x.battle });
    happiness(x, 'PIKAHAPPY_LEVELUP', pm);
    // TryEvolvingMon (wForceEvolution = 0)
    removeUsedItem(x);
    yield* evolutionAfterBattle(e, 1 << which, false, 0, x.party);
    x.party.splice(0, x.party.length, ...structuredClone(e.state.party));
    return;
  }
  const stats = ['hp', 'atk', 'def', 'spd', 'spc'] as const;
  const k = stats[x.item - I('HP_UP')];
  if (pm.statExp[k] >> 8 >= 100) {
    yield* print(x, '_VitaminNoEffectText');
    return;
  }
  pm.statExp[k] = Math.min(0xffff, pm.statExp[k] + 10 * 256);
  Object.assign(pm, calcStats(sp, pm.dvs, pm.statExp, pm.level, true));
  setMem(x, 'wStringBuffer', ['HEALTH', 'ATTACK', 'DEFENSE', 'SPEED', 'SPECIAL'][x.item - I('HP_UP')]);
  e.hooks.playSound?.('SFX_HEAL_AILMENT');
  yield* print(x, '_VitaminStatRoseText');
  removeUsedItem(x);
}


// ------------------------------------------------------------------ evolution stones
/** ItemUseEvoStone */
function* itemUseEvoStone(x: ItemContext): Co {
  const e = x.e;
  if (inBattle(x)) return yield* itemUseNotTime(x);
  const stone = x.item;
  const which = yield* chooseMon(x, 'stone', { stone });
  if (which === undefined) return yield* canceled(x);
  const pm = x.party[which];
  if (!canUseStone(e, pm.species, stone)) {
    yield* itemUseNoEffect(x);
    x.result = 0;
    return;
  }
  if (isStarterPikachu(e.state, pm)) {
    yield* playPikachuCry(e, pikachuCry(28));
    setMem(x, 'wNameBuffer', pm.nickname);
    yield* print(x, '_RefusingText');
    setPikachuMood(x, 4, 0x82);
    x.result = 0;
    return;
  }
  yield* e.env.playSoundWaitForCurrent('SFX_HEAL_AILMENT');
  yield* e.waitForSoundToFinish();
  removeUsedItem(x);
  e.store.dispatch({ type: 'setBag', bag: x.bag }, { undoable: false });
  yield* evolutionAfterBattle(e, 1 << which, true, stone, x.party);
  x.party.splice(0, x.party.length, ...structuredClone(e.state.party));
}

// ------------------------------------------------------------------ battle items
/** ItemUseBait / ItemUseRock (Safari Zone) */
function* itemUseBaitRock(x: ItemContext, bait: boolean): Co {
  const b = x.battle;
  if (!b) return yield* itemUseNotTime(x);
  yield* print(x, bait ? '_ThrewBaitText' : '_ThrewRockText');
  const en = b.enemy.mon;
  if (bait) en.catchRate >>= 1;
  else en.catchRate = Math.min(0xff, en.catchRate * 2);
  b.whoseTurn = 0;
  if (bait) b.safariEscapeFactor = 0;
  else b.safariBaitFactor = 0;
  let r: number;
  do r = b.random() & 7;
  while (r >= 5);
  if (bait) b.safariBaitFactor = Math.min(0xff, b.safariBaitFactor + r + 1);
  else b.safariEscapeFactor = Math.min(0xff, b.safariEscapeFactor + r + 1);
  yield* moveAnimation(b, c('move', bait ? 'BAIT_ANIM' : 'ROCK_ANIM'), 0);
  yield* b.delay(70);
}

/** ItemUseXAccuracy / Guard Spec / Dire Hit */
function* itemUseBattleFlag(x: ItemContext, flag: number): Co {
  const b = x.battle;
  if (!b) return yield* itemUseNotTime(x);
  if (flag === S2.USING_X_ACCURACY) {
    b.player.s2 |= flag;
    happiness(x, 'PIKAHAPPY_USEDXITEM', x.party[b.whichPokemon]);
  } else {
    happiness(x, 'PIKAHAPPY_USEDXITEM', x.party[b.playerMonNumber]);
    b.player.s2 |= flag;
  }
  yield* printItemUseTextAndRemoveItem(x);
}

/** ItemUseXStat */
function* itemUseXStat(x: ItemContext): Co {
  const b = x.battle;
  if (!b) {
    yield* itemUseNotTime(x);
    x.result = 2;
    return;
  }
  const mv = b.player.move;
  const savedNum = mv.num;
  const savedEffect = mv.effect;
  mv.effect = x.item - (I('X_ATTACK') - c('move_effect', 'ATTACK_UP1_EFFECT'));
  yield* printItemUseTextAndRemoveItem(x);
  mv.num = c('move', 'XSTATITEM_ANIM');
  b.loadScreen1();
  yield* b.delay(3);
  b.whoseTurn = 0;
  yield* statModifierUpEffect(b);
  happiness(x, 'PIKAHAPPY_USEDXITEM', x.party[b.playerMonNumber]);
  mv.effect = savedEffect;
  mv.num = savedNum;
}

/** ItemUsePokeDoll (wild battles only) */
function* itemUsePokeDoll(x: ItemContext): Co {
  const b = x.battle;
  if (!b || b.isInBattle !== WILD_BATTLE) return yield* itemUseNotTime(x);
  b.escapedFromBattle = 1;
  yield* printItemUseTextAndRemoveItem(x);
}

/** ItemUsePokeFlute */
function* itemUsePokeFlute(x: ItemContext): Co {
  const e = x.e;
  const b = x.battle;
  if (!b) {
    const map = e.world.data.id;
    const p = e.state.player;
    const flag = (n: string) => getBit(e.state.eventFlags, c('event', n));
    const at = (coords: [number, number][]) => coords.some(([cx, cy]) => cx === p.x && cy === p.y);
    if (map === c('map', 'ROUTE_12') && !flag('EVENT_BEAT_ROUTE12_SNORLAX') && at([[9, 62], [10, 61], [10, 63], [11, 62]])) {
      yield* print(x, '_PlayedFluteHadEffectText', '<promptbutton>');
      yield* playFluteOverworld(x);
      e.store.dispatch({ type: 'setEvent', flag: c('event', 'EVENT_FIGHT_ROUTE12_SNORLAX'), value: true }, { undoable: false });
      return;
    }
    if (map === c('map', 'ROUTE_16') && !flag('EVENT_BEAT_ROUTE16_SNORLAX') && at([[27, 10], [25, 10]])) {
      yield* print(x, '_PlayedFluteHadEffectText', '<promptbutton>');
      yield* playFluteOverworld(x);
      e.store.dispatch({ type: 'setEvent', flag: c('event', 'EVENT_FIGHT_ROUTE16_SNORLAX'), value: true }, { undoable: false });
      return;
    }
    if (map === c('map', 'PEWTER_POKECENTER') && e.ram.pikachuOverworldStateFlags & 2 && e.isPikachuRightNextToPlayer?.()) {
      yield* print(x, '_PlayedFluteHadEffectText', '<promptbutton>');
      yield* playFluteOverworld(x);
      e.playPikachuEmotion?.(26);
      return;
    }
    return yield* print(x, '_PlayedFluteNoEffectText');
  }
  let anyAsleep = false;
  const wake = (list: PartyMon[]) =>
    list.forEach((m) => {
      if (m.status & ST.SLP_MASK) anyAsleep = true;
      m.status &= ~ST.SLP_MASK;
    });
  wake(x.party);
  if (b.isInBattle !== WILD_BATTLE) wake(b.enemyParty);
  b.player.mon.status &= ~ST.SLP_MASK;
  const en = b.enemy.mon.status;
  b.enemy.mon.status &= ~ST.SLP_MASK;
  if (en & ST.SLP_MASK) anyAsleep = true;
  b.loadScreen2();
  if (!anyAsleep) return yield* print(x, '_PlayedFluteNoEffectText');
  yield* print(x, '_PlayedFluteHadEffectText', '<promptbutton>');
  if (!(e.ram.lowHealthAlarm & 0x80)) {
    yield* e.waitForSoundToFinish();
    e.hooks.playSound?.('MUSIC_POKE_FLUTE_IN_BATTLE');
    while (e.sound.soundId(6)) yield;
  }
  yield* print(x, '_FluteWokeUpText');
}

function* playFluteOverworld(x: ItemContext): Co {
  const e = x.e;
  e.stopAllMusic();
  const flute = c('music', 'SFX_POKEFLUTE');
  e.sound.playMusic(flute, e.bundle.audio.engineBanks[0]);
  while (e.sound.soundId(2) === flute) yield;
  e.playDefaultMusic();
}

// ------------------------------------------------------------------ field items
/** ItemUseRepel / Super Repel / Max Repel */
function* itemUseRepel(x: ItemContext, steps: number): Co {
  if (inBattle(x)) return yield* itemUseNotTime(x);
  x.e.ram.repelRemainingSteps = steps;
  yield* printItemUseTextAndRemoveItem(x);
}

/** ItemUseCoinCase */
function* itemUseCoinCase(x: ItemContext): Co {
  if (inBattle(x)) return yield* itemUseNotTime(x);
  yield* print(x, '_CoinCaseNumCoinsText');
}

/** ItemUseBicycle */
function* itemUseBicycle(x: ItemContext): Co {
  const e = x.e;
  if (inBattle(x)) return yield* itemUseNotTime(x);
  const mode = e.state.player.mode;
  if (mode === 'surf') return yield* itemUseNotTime(x);
  setMem(x, 'wStringBuffer', itemData(e.bundle, x.item).name);
  if (mode === 'bike') {
    e.store.dispatch({ type: 'setMode', mode: 'walk' }, { undoable: false });
    e.playDefaultMusic();
    return yield* print(x, '_GotOffBicycleText1', '<low>', '_GotOffBicycleText2');
  }
  if (!e.isBikeRidingAllowed()) return yield* itemUseFailed(x, '_NoCyclingAllowedHereText');
  e.ram.joyHeld = 0;
  e.store.dispatch({ type: 'setMode', mode: 'bike' }, { undoable: false });
  e.playDefaultMusic();
  yield* print(x, '_GotOnBicycleText1', '<low>', '_GotOnBicycleText2');
}

/** ItemUseEscapeRope (also Dig through wPseudoItemID): back to the last Pokémon Center's town. */
function* itemUseEscapeRope(x: ItemContext): Co {
  const e = x.e;
  if (inBattle(x)) return yield* itemUseNotTime(x);
  const map = e.world.data.id;
  if (['AGATHAS_ROOM', 'BILLS_HOUSE', 'POKEMON_FAN_CLUB'].some((n) => c('map', n) === map)) return yield* itemUseNotTime(x);
  if (!e.bundle.tileTables.escapeRopeTilesets.includes(e.world.data.tileset)) return yield* itemUseNotTime(x);
  e.ram.noBattles = false;
  e.store.dispatch({ type: 'setEvent', flag: c('event', 'EVENT_IN_SAFARI_ZONE'), value: false }, { undoable: false });
  e.store.dispatch({ type: 'setVar', name: 'wNumSafariBalls', value: 0 }, { undoable: false });
  e.store.dispatch({ type: 'setMapScript', map: c('map', 'SAFARI_ZONE_GATE'), script: 0 }, { undoable: false });
  x.result = 1;
  e.ram.flyWarp = true;
  e.ram.escapeWarp = true;
  if (x.pseudo) return;
  yield* e.delayFrames(30);
  removeUsedItem(x);
}

/** ItemUseItemfinder: HiddenItemNear, four double beeps if one is close. */
function* itemUseItemfinder(x: ItemContext): Co {
  const e = x.e;
  if (inBattle(x)) return yield* itemUseNotTime(x);
  const { x: px, y: py } = e.state.player;
  const clamp = (v: number) => (v - 5 < 0 ? 0 : v - 5); // Sub5ClampTo0
  const near = e.bundle.hidden.itemCoords.some(
    (h, i) => h.map === e.world.data.id && !getBit(e.state.hiddenItems, i) && h.y > clamp(py) && h.y <= py + 4 && h.x > clamp(px) && h.x <= px + 5,
  );
  if (near)
    for (let i = 0; i < 4; i++) {
      e.hooks.playSound?.('healing_machine');
      yield* e.delayFrames(16);
      e.hooks.playSound?.('purchase');
      yield* e.delayFrames(16);
    }
  yield* e.printText(near ? 'ItemfinderFoundItemText' : 'ItemfinderFoundNothingText');
}

/** Items whose field systems are still being ported (TASKS.md): usable only where the system exists. */
function fieldSystem(name: string): Handler {
  return function* (x) {
    if (inBattle(x)) return yield* itemUseNotTime(x);
    const h = x.e.fieldItems?.[name];
    if (!h) {
      x.e.hooks.unported?.(`item ${name}`);
      x.result = 0;
      return;
    }
    yield* h(x);
  };
}

// ------------------------------------------------------------------ PP items
/** ItemUsePPUp / ItemUsePPRestore */
function* itemUsePP(x: ItemContext): Co {
  const e = x.e;
  const it = x.item;
  if (it === I('PP_UP') && inBattle(x)) return yield* itemUseNotTime(x);
  for (;;) {
    const which = yield* chooseMon(x, 'item');
    if (which === undefined) return yield* ppItemNotUsed(x);
    const b = x.battle;
    if (b && which === b.playerMonNumber && b.player.s3 & S3.TRANSFORMED) {
      yield* itemUseNotTime(x);
      return yield* ppItemNotUsed(x);
    }
    const pm = x.party[which];
    if (it >= I('ELIXER')) {
      const max = it === I('MAX_ELIXER');
      let restored = 0;
      for (let i = 0; i < 4; i++) if (pm.moves[i] && restorePP(e, pm, i, max)) restored++;
      if (!restored) {
        yield* itemUseNoEffect(x);
        return yield* ppItemNotUsed(x);
      }
      return yield* afterRestoringPP(x, which);
    }
    yield* print(x, it === I('PP_UP') ? '_RaisePPWhichTechniqueText' : '_RestorePPWhichTechniqueText');
    const slot = yield* relearnMoveMenu(x, pm);
    if (slot === undefined) continue; // .chooseMon
    setMem(x, 'wStringBuffer', e.bundle.moves[pm.moves[slot] - 1].name);
    if (it === I('PP_UP')) {
      if (pm.pp[slot] >= 3 << 6) {
        yield* print(x, '_PPMaxedOutText');
        continue;
      }
      pm.pp[slot] += 1 << 6;
      // RestoreBonusPP with wUsingPPUp: the bonus is added to the current PP once
      const base = movePP(e.bundle, pm.moves[slot]);
      pm.pp[slot] = (pm.pp[slot] + Math.min(Math.floor(base / 5), 7)) & 0xff;
      e.hooks.playSound?.('SFX_HEAL_AILMENT');
      yield* print(x, '_PPIncreasedText');
      removeUsedItem(x);
      return;
    }
    if (!restorePP(e, pm, slot, it === I('MAX_ETHER'))) {
      yield* itemUseNoEffect(x);
      return yield* ppItemNotUsed(x);
    }
    return yield* afterRestoringPP(x, which);
  }
}

function* ppItemNotUsed(x: ItemContext): Co {
  x.result = 0;
  yield* reloadAfterMenu(x);
}

function* afterRestoringPP(x: ItemContext, which: number): Co {
  const b = x.battle;
  if (b && which === b.playerMonNumber) b.player.mon.pp = [...x.party[which].pp];
  x.e.hooks.playSound?.('SFX_HEAL_AILMENT');
  yield* print(x, '_PPRestoredText');
  removeUsedItem(x);
}

/** .restorePP: returns false (Z) if nothing changed. */
function restorePP(e: Engine, pm: PartyMon, slot: number, max: boolean): boolean {
  const base = movePP(e.bundle, pm.moves[slot]);
  const ups = pm.pp[slot] >> 6;
  const maxPP = base + Math.min(Math.floor(base / 5), 7) * ups;
  const cur = pm.pp[slot];
  if (max) {
    if (cur === maxPP) return false; // compares the raw byte, PP Up bits included
  } else {
    if ((cur & PP_MASK) === maxPP) return false;
    const v = (cur & PP_MASK) + 10;
    pm.pp[slot] = (cur & 0xc0) + (v >= maxPP ? maxPP : v);
    return true;
  }
  pm.pp[slot] = (cur & 0xc0) + maxPP;
  return true;
}

/** MoveSelectionMenu with wMoveMenuType = 2 (party mon's moves at (4,7), B allowed). */
function* relearnMoveMenu(x: ItemContext, pm: PartyMon): Co<number | undefined> {
  const e = x.e;
  e.screen.box(4, 7, 4, 14);
  for (let i = 0; i < 4; i++) {
    const m = pm.moves[i];
    encodePlain(m ? e.bundle.moves[m - 1].name : '-').forEach((code, j) => e.screen.put(6 + j, 8 + i, code));
  }
  const n = pm.moves.filter((m) => m).length;
  const [item, key] = yield* handleMenuInput(e, { topX: 5, topY: 8, maxItem: n - 1, current: 0, spacing: 1, watchedKeys: PAD_A | PAD_B, wrap: true });
  if (key & PAD_B) return undefined;
  return item;
}

// ------------------------------------------------------------------ TMs and HMs
/** ItemUseTMHM */
function* itemUseTMHM(x: ItemContext): Co {
  const e = x.e;
  if (inBattle(x)) return yield* itemUseNotTime(x);
  const isHMItem = x.item < I('TM01');
  const idx = isHMItem ? x.item - I('HM01') + 50 : x.item - I('TM01');
  const move = e.bundle.tmMoves[idx];
  const name = e.bundle.moves[move - 1].name;
  setMem(x, 'wStringBuffer', name);
  yield* print(x, isHMItem ? '_BootedUpHMText' : '_BootedUpTMText');
  yield* print(x, '_TeachMachineMoveText');
  const yes = yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7);
  if (yes !== 0) {
    x.result = 2;
    return;
  }
  for (;;) {
    const which = yield* chooseMon(x, 'tm', { tmMove: move });
    setMem(x, 'wStringBuffer', name);
    if (which === undefined) {
      e.screen.clear();
      return;
    }
    const pm = x.party[which];
    setMem(x, 'wNameBuffer', pm.nickname);
    if (!canLearnTM(e, pm.species, move)) {
      e.hooks.playSound?.('SFX_DENIED');
      yield* print(x, '_MonCannotLearnMachineMoveText');
      continue;
    }
    if (pm.moves.includes(move)) {
      // CheckIfMoveIsKnown
      yield* print(x, '_AlreadyKnowsText');
      continue;
    }
    const learned = yield* learnMove(e, x.party, which, move, { mem: x.mem });
    if (!learned) return;
    happiness(x, 'PIKAHAPPY_USEDTMHM', pm);
    if (isStarterPikachu(e.state, pm) && (move === c('move', 'THUNDERBOLT') || move === c('move', 'THUNDER'))) setPikachuMood(x, 5, 0x85);
    if (!isHM(e, move) && !isHMItem) removeUsedItem(x);
    return;
  }
}

// ------------------------------------------------------------------ misc
function* itemUseNotYoursToUse(x: ItemContext): Co {
  yield* itemUseFailed(x, '_ItemUseNotYoursToUseText');
}

const HANDLERS: Record<number, Handler> = {};
const on = (names: string[], h: Handler) => names.forEach((n) => (HANDLERS[I(n)] = h));
on(['MASTER_BALL', 'ULTRA_BALL', 'GREAT_BALL', 'POKE_BALL', 'SAFARI_BALL'], itemUseBall);
on(['TOWN_MAP'], fieldSystem('TOWN_MAP'));
on(['BICYCLE'], itemUseBicycle);
on(['SURFBOARD'], fieldSystem('SURFBOARD'));
on(['POKEDEX'], (x) => showPokedexMenu(x.e)); // ItemUsePokedex
on(['MOON_STONE', 'FIRE_STONE', 'THUNDER_STONE', 'WATER_STONE', 'LEAF_STONE'], itemUseEvoStone);
on(
  ['ANTIDOTE', 'BURN_HEAL', 'ICE_HEAL', 'AWAKENING', 'PARLYZ_HEAL', 'FULL_RESTORE', 'MAX_POTION', 'HYPER_POTION', 'SUPER_POTION', 'POTION',
   'FULL_HEAL', 'REVIVE', 'MAX_REVIVE', 'FRESH_WATER', 'SODA_POP', 'LEMONADE'],
  itemUseMedicine,
);
on(['HP_UP', 'PROTEIN', 'IRON', 'CARBOS', 'CALCIUM', 'RARE_CANDY'], function* (x) {
  if (inBattle(x)) return yield* itemUseNotTime(x);
  yield* itemUseMedicine(x);
});
// the badge slots double as the Safari Zone's BAIT and ROCK
HANDLERS[I('SAFARI_BAIT')] = (x) => itemUseBaitRock(x, true);
HANDLERS[I('SAFARI_ROCK')] = (x) => itemUseBaitRock(x, false);
on(['ESCAPE_ROPE'], itemUseEscapeRope);
on(['REPEL'], (x) => itemUseRepel(x, 100));
on(['SUPER_REPEL'], (x) => itemUseRepel(x, 200));
on(['MAX_REPEL'], (x) => itemUseRepel(x, 250));
on(['X_ACCURACY'], (x) => itemUseBattleFlag(x, S2.USING_X_ACCURACY));
on(['GUARD_SPEC'], (x) => itemUseBattleFlag(x, S2.PROTECTED_BY_MIST));
on(['DIRE_HIT'], (x) => itemUseBattleFlag(x, S2.GETTING_PUMPED));
// ItemUseCardKey reads `ld a, [GetTileAndCoordsInFrontOfPlayer]`, a code byte ($CD), instead
// of the tile, so the door tables never match: from the bag it is never the time to use it
on(['CARD_KEY'], itemUseNotTime);
on(['POKE_DOLL'], itemUsePokeDoll);
on(['X_ATTACK', 'X_DEFEND', 'X_SPEED', 'X_SPECIAL'], itemUseXStat);
on(['COIN_CASE'], itemUseCoinCase);
on(['OAKS_PARCEL'], itemUseNotYoursToUse);
on(['ITEMFINDER'], itemUseItemfinder);
on(['POKE_FLUTE'], itemUsePokeFlute);
on(['OLD_ROD'], fieldSystem('OLD_ROD'));
on(['GOOD_ROD'], fieldSystem('GOOD_ROD'));
on(['SUPER_ROD'], fieldSystem('SUPER_ROD'));
on(['PP_UP', 'ETHER', 'MAX_ETHER', 'ELIXER', 'MAX_ELIXER'], itemUsePP);

export { MOD_STATS, goBackToPartyMenu };
