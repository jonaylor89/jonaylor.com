/**
 * The Game Corner slot machines (engine/slots/game_corner_slots.asm,
 * game_corner_slots2.asm, slot_machine.asm): StartSlotMachine with its
 * out-of-order machines and the lucky machine, the bet menu, three spinning
 * wheels the player stops with A, the win-control flags and their quirks
 * (wheel slipping, wheel 3 rerolls, the 7/bar mode), payout and the coin count-up.
 */
import type { Co, Engine } from '../engine/Engine';
import type { HiddenEvent } from '../engine/hiddenEvents';
import { c } from '../rom/constants';
import { PAD_A, PAD_B } from '../engine/pad';
import { encodePlain } from './TextPrinter';
import { handleMenuInput, LowSensitivity, restoreScreen, saveScreen, twoOptionMenu } from './menus';
import { formatBCD } from './TextPrinter';

const OUT_OF_ORDER = 0xfd;
const OUT_TO_LUNCH = 0xfe;
const SOMEONES_KEYS = 0xff;
/** Symbol ids (the high byte of each wheel entry) */
const SEVEN = 0x02;
const BAR = 0x06;
const CHERRY = 0x0a;
/** OBJ glyph codes for SlotMachineTiles2 */
const OBJ = 0x600;

interface Slots {
  wheel: [number, number, number]; // wSlotMachineWheel<n>Offset
  slip: [number, number]; // wheel 1/2 slip counters
  reroll: number;
  canWin: boolean;
  canWin7OrBar: boolean;
  bet: number;
  stopping: number; // wStoppingWhichSlotMachineWheel
}

function put(e: Engine, x: number, y: number, s: string): void {
  encodePlain(s).forEach((code, i) => e.screen.put(x + i, y, code));
}

/** The three symbol ids (bottom, middle, top) a wheel shows (SlotMachine_GetWheelTiles). */
function wheelSymbols(e: Engine, n: number, offset: number): [number, number, number] {
  const w = e.bundle.ui.slots.wheels[n];
  return [w[offset], w[offset + 2], w[offset + 4]];
}

/** SlotMachine_AnimWheel: draw the wheel's six half-symbols and advance its offset. */
function animWheel(e: Engine, s: Slots, n: number): void {
  s.wheel[n] = (s.wheel[n] + 1) % 30;
  drawWheels(e, s);
}

function drawWheels(e: Engine, s: Slots): void {
  const w = e.bundle.ui.slots.wheels;
  const objs: { x: number; y: number; code: number }[] = [];
  for (let n = 0; n < 3; n++) {
    const x = 0x30 + n * 0x20 - 8;
    for (let row = 0; row < 6; row++) {
      const tile = w[n][s.wheel[n] + row];
      const y = 0x58 - row * 8 - 16;
      objs.push({ x, y, code: OBJ + tile }, { x: x + 8, y, code: OBJ + tile + 1 });
    }
  }
  e.screen.setObjects(objs);
}

/** LoadSlotMachineTiles */
function loadSlotMachine(e: Engine): void {
  const sl = e.bundle.ui.slots;
  const scr = e.screen;
  for (let i = 0; i < sl.tiles1.length / 64; i++) scr.setGlyphOverride(i, sl.tiles1.slice(i * 64, i * 64 + 64));
  for (let i = 0; i < sl.tiles2.length / 64; i++) {
    const px = sl.tiles2.slice(i * 64, i * 64 + 64);
    scr.setGlyphOverride(0x25 + i, px);
    scr.setGlyphOverride(OBJ + i, px);
  }
  scr.clear();
  scr.fill(0, 0, 20, 18, 0x7f);
  sl.map.forEach((code, i) => scr.put(i % 20, Math.floor(i / 20), code));
  // SET_PAL_SLOTS: PalPacket_Slots with BlkPacket_Slots
  const P = (n: string) => c('palette', n);
  e.hooks.paletteLayout?.(
    [P('PAL_SLOTS1'), P('PAL_SLOTS2'), P('PAL_SLOTS3'), P('PAL_SLOTS4')],
    [
      { pal: 1, x0: 0, y0: 0, x1: 19, y1: 11 },
      { pal: 2, x0: 0, y0: 4, x1: 19, y1: 9 },
      { pal: 3, x0: 0, y0: 6, x1: 19, y1: 7 },
      { pal: 0, x0: 4, y0: 4, x1: 15, y1: 9 },
      { pal: 0, x0: 0, y0: 12, x1: 19, y1: 17 },
    ],
  );
}

const printCredit = (e: Engine) => put(e, 5, 1, formatBCD(e.state.coins, 2));
const printPayout = (e: Engine, n: number) => put(e, 11, 1, String(n).padStart(4, '0'));

/** SlotMachine_SetFlags */
function setFlags(e: Engine, s: Slots, sevenChance: number): void {
  if (s.canWin7OrBar) return;
  if (e.ram.slotsAllowMatchesCounter) {
    s.canWin = true;
    return;
  }
  const b = e.random();
  if (b === 0) {
    e.ram.slotsAllowMatchesCounter = 60;
    return;
  }
  if (sevenChance < b) s.canWin7OrBar = true;
  else if (210 < b) s.canWin = true;
  else s.canWin = s.canWin7OrBar = false;
}

/** Light (or put out) the balls beside the paylines the bet covers. */
function updateBalls(e: Engine, bet: number, tile: number): void {
  const rows = bet >= 3 ? [2, 10, 4, 8, 6] : bet === 2 ? [4, 8, 6] : [6];
  for (const y of rows) {
    e.screen.put(3, y, tile);
    e.screen.put(16, y, tile);
    e.screen.put(3, y + 1, tile + 1);
    e.screen.put(16, y + 1, tile + 1);
  }
}

/**
 * SlotMachine_FindWheel1Wheel2Matches: could wheel 3 still complete a line? Returns the
 * wheel-2 position compared last (de): the matching one, or the bottom when none match.
 */
function wheel12Match(a: number[], b: number[]): { match: boolean; at: number } {
  if (b[0] === a[0]) return { match: true, at: 0 };
  if (b[1] === a[0] || b[1] === a[1] || b[1] === a[2]) return { match: true, at: 1 };
  if (b[2] === a[2]) return { match: true, at: 2 };
  return { match: false, at: 0 };
}

/** SlotMachine_SpinWheels */
function* spinWheels(e: Engine, s: Slots): Co {
  for (let i = 0; i < 20; i++) {
    for (let n = 0; n < 3; n++) animWheel(e, s, n);
    yield* e.delayFrames(2);
  }
  s.stopping = 0;
  const js = new LowSensitivity(e);
  for (;;) {
    // SlotMachine_HandleInputWhileWheelsSpin
    yield;
    if (js.read(e) & PAD_A) {
      const slipping = s.stopping === 1 ? s.slip[0] : s.stopping === 2 ? s.slip[1] : 0;
      if (!slipping) {
        s.stopping++;
        e.env.playSound('slots_stop_wheel');
      }
    }
    // SlotMachine_StopOrAnimWheel1/2: a wheel told to stop can only stop with a symbol centred
    // (odd offset); while its slip counter runs it may slip on, decided by StopWheel<n>Early
    for (const n of [0, 1] as const) {
      let stopped = false;
      if (s.stopping >= n + 1 && s.wheel[n] & 1) {
        if (s.slip[n] === 0) stopped = true;
        else {
          s.slip[n]--;
          stopped = n === 0 ? stopEarly1(e, s) : stopEarly2(e, s);
        }
      }
      if (!stopped) animWheel(e, s, n);
    }
    // wheel 3 stops as soon as a symbol is centred
    if (s.stopping >= 3 && s.wheel[2] & 1) return;
    animWheel(e, s, 2);
    yield* e.delayFrames(2); // wOnSGB ^ 1 + 1
  }
}

/** SlotMachine_StopWheel1Early: true when the wheel stops now (zeroing the slip counter). */
function stopEarly1(e: Engine, s: Slots): boolean {
  const w1 = wheelSymbols(e, 0, s.wheel[0]);
  // stop unless a cherry is in the middle; in 7/bar mode the intended "stop on a 7" check
  // never fires (cp HIGH(SLOTS7) / jr c), so the wheel slips until its counter runs out
  const stop = s.canWin7OrBar ? false : w1[1] !== CHERRY;
  if (stop) s.slip[0] = 0;
  return stop;
}

/** SlotMachine_StopWheel2Early */
function stopEarly2(e: Engine, s: Slots): boolean {
  const w1 = wheelSymbols(e, 0, s.wheel[0]);
  const w2 = wheelSymbols(e, 1, s.wheel[1]);
  const m = wheel12Match(w1, w2);
  // stop early when a line is still possible; in 7/bar mode, when the compared wheel-2
  // symbol is a 7 or a bar (whether or not it matched)
  const stop = s.canWin7OrBar ? w2[m.at] <= BAR : m.match;
  if (stop) s.slip[1] = 0;
  return stop;
}

/** SlotMachine_CheckForMatches; returns after paying out or "Not this time!" */
function* checkForMatches(e: Engine, s: Slots): Co {
  for (;;) {
    const [w1, w2, w3] = [0, 1, 2].map((n) => wheelSymbols(e, n, s.wheel[n]));
    const lines: [number, number, number][] = [];
    // SlotMachine_GetWheel3Tiles refreshes all three wheels
    if (s.bet >= 3) lines.push([w1[0], w2[1], w3[2]], [w1[2], w2[1], w3[0]]);
    if (s.bet >= 2) lines.push([w1[2], w2[2], w3[2]], [w1[0], w2[0], w3[0]]);
    lines.push([w1[1], w2[1], w3[1]]);
    const match = lines.find(([a, b, cc]) => a === b && a === cc);
    const rollWheel3 = function* () {
      animWheel(e, s, 2);
      yield;
      animWheel(e, s, 2);
      yield;
    };
    if (!match) {
      if (s.canWin || s.canWin7OrBar) {
        s.reroll = (s.reroll - 1) & 0xff;
        if (s.reroll) {
          yield* rollWheel3();
          continue;
        }
      }
      yield* e.printText('NotThisTimeText');
      return;
    }
    const symbol = match[0];
    if (!(s.canWin || s.canWin7OrBar)) {
      yield* rollWheel3();
      continue;
    }
    if (!s.canWin7OrBar && symbol <= BAR) {
      yield* rollWheel3();
      continue;
    }
    // .acceptMatch: the reward for the symbol
    const winning = symbol - 2;
    const sl = e.bundle.ui.slots;
    let flashes: number;
    let payout: number;
    let rewardText: string;
    if (symbol === SEVEN) {
      yield* e.printText('YeahText');
      e.env.playSound('get_item2');
      const keep = e.random() < 0x80;
      if (!keep) s.canWin = s.canWin7OrBar = false;
      e.ram.slotsAllowMatchesCounter = 0;
      [flashes, payout, rewardText] = [0x14, 300, sl.rewards[0]];
    } else if (symbol === BAR) {
      e.env.playSound('get_key_item');
      s.canWin = s.canWin7OrBar = false;
      [flashes, payout, rewardText] = [8, 100, sl.rewards[1]];
    } else {
      if (e.ram.slotsAllowMatchesCounter) e.ram.slotsAllowMatchesCounter--;
      [flashes, payout, rewardText] = symbol === CHERRY ? [2, 8, sl.rewards[2]] : [4, 15, sl.rewards[3]];
    }
    // .flashScreenLoop: BG color 3 alternates with 2
    for (let i = 0; i < flashes; i++) {
      e.screen.setShadeSwap(i % 2 === 0);
      yield* e.delayFrames(5);
    }
    e.screen.setShadeSwap(false);
    printPayout(e, payout);
    e.ram.nameBuffer = rewardText; // wStringBuffer
    // SymbolLinedUpSlotMachineText: the symbol in the box, then LinedUpText 4 tiles further on
    e.screen.box(0, 12, 4, 18);
    printWinningSymbol(e, winning);
    yield* e.textCommandProcessor(e.bundle.texts.LinedUpText, 5, 14);
    yield* e.waitForTextScrollButtonPress();
    // SlotMachine_PayCoinsToPlayer: one coin at a time, the music paused
    e.sound.setMute(1);
    yield* e.waitForSoundToFinish();
    let anim = 5;
    while (payout) {
      payout--;
      e.store.dispatch({ type: 'addCoins', amount: 1 }, { undoable: false });
      printCredit(e);
      printPayout(e, payout);
      e.env.playSound('slots_reward');
      if (--anim === 0) anim = 5;
      yield* e.delayFrames(symbol <= BAR ? 4 : 8);
    }
    return;
  }
}

/** SlotMachine_PrintWinningSymbol: the symbol (BG $25 + id) and ▼ in the text box */
function printWinningSymbol(e: Engine, winning: number): void {
  const a = 0x25 + winning;
  e.screen.put(2, 14, a);
  e.screen.put(3, 14, a + 1);
  e.screen.put(2, 13, a + 2);
  e.screen.put(3, 13, a + 3);
  e.screen.put(18, 16, 0xee);
}

/** MainSlotMachineLoop */
function* mainLoop(e: Engine, s: Slots, sevenChance: number): Co {
  for (;;) {
    printCredit(e);
    printPayout(e, 0);
    yield* e.printText('BetHowManySlotMachineText');
    const saved = saveScreen(e);
    for (;;) {
      e.screen.box(14, 11, 5, 4);
      e.bundle.ui.slots.multiplier.split('{next}').forEach((line, i) => put(e, 16, 12 + i * 2, line));
      const [item, key] = yield* handleMenuInput(e, { topX: 15, topY: 12, maxItem: 2, current: 0, watchedKeys: PAD_A | PAD_B });
      if (key & PAD_B) {
        restoreScreen(e, saved);
        return;
      }
      s.bet = 3 - item;
      if (e.state.coins >= s.bet) break;
      yield* e.printText('NotEnoughCoinsSlotMachineText');
    }
    restoreScreen(e, saved);
    e.store.dispatch({ type: 'addCoins', amount: -s.bet }, { undoable: false });
    printCredit(e);
    updateBalls(e, s.bet, 0x14); // SlotMachine_LightBalls
    setFlags(e, s, sevenChance);
    s.slip = [4, 4];
    s.reroll = 4;
    yield* e.waitForSoundToFinish();
    e.env.playSound('slots_new_spin');
    yield* e.printText('StartSlotMachineText');
    yield* spinWheels(e, s);
    yield* checkForMatches(e, s);
    e.sound.setMute(0);
    if (!e.state.coins) {
      yield* e.printText('OutOfCoinsSlotMachineText');
      yield* e.delayFrames(60);
      return;
    }
    yield* e.printText('OneMoreGoSlotMachineText');
    if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 12)) !== 0) return;
    updateBalls(e, 3, 0x23); // SlotMachine_PutOutLitBalls
  }
}

/** StartSlotMachine (the hidden events on the Game Corner's machines) */
export function* startSlotMachine(e: Engine, ev: HiddenEvent): Co {
  const env = e.env;
  const printPredefLabel = (label: string) => e.printPredefTextID(e.bundle.hidden.predefIds[label]);
  if (ev.arg === OUT_OF_ORDER || ev.arg === OUT_TO_LUNCH || ev.arg === SOMEONES_KEYS) {
    env.enableAutoTextBoxDrawing();
    const label = ev.arg === OUT_OF_ORDER ? 'GameCornerOutOfOrderText' : ev.arg === OUT_TO_LUNCH ? 'GameCornerOutToLunchText' : 'GameCornerSomeonesKeysText';
    return yield* printPredefLabel(label);
  }
  // AbleToPlaySlotsCheck: only facing left or right
  const f = e.state.player.facing;
  if (f !== 'left' && f !== 'right') return;
  if (!env.isItemInBag('COIN_CASE')) {
    env.enableAutoTextBoxDrawing();
    return yield* printPredefLabel('GameCornerCoinCaseText');
  }
  if (!e.state.coins) {
    env.enableAutoTextBoxDrawing();
    return yield* printPredefLabel('GameCornerNoCoinsText');
  }
  // the lucky machine (wLuckySlotHiddenEventIndex) has better 7/bar odds
  const index = (e.bundle.hidden.events[e.world.data.id] ?? []).findIndex((h) => h.x === ev.x && h.y === ev.y);
  const sevenChance = index + 1 === env.vars.wLuckySlotHiddenEventIndex ? 250 : 253;
  // PromptUserToPlaySlots
  const buffer2 = saveScreen(e);
  e.ram.autoTextBoxControl = 1;
  e.screen.box(0, 12, 4, 18);
  yield* e.printText('PlaySlotMachineText');
  if (yield* env.yesNoChoice()) {
    yield* env.emotionBubble(0, 'SMILE_BUBBLE');
    loadSlotMachine(e);
    e.ram.noTextDelay = true;
    e.ram.slotsAllowMatchesCounter = 0;
    const s: Slots = { wheel: [0x1c, 0x1c, 0x1c], slip: [0, 0], reroll: 0, canWin: false, canWin7OrBar: false, bet: 0, stopping: 0 };
    drawWheels(e, s);
    yield* mainLoop(e, s, sevenChance);
    e.ram.noTextDelay = false;
    e.ram.slotsAllowMatchesCounter = 0;
    e.screen.setObjects([]);
    e.screen.clearGlyphOverrides();
    e.hooks.palette?.(undefined);
  }
  restoreScreen(e, buffer2);
  e.closeTextDisplay();
}
