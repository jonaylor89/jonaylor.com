/**
 * CheckForHiddenEventOrBookshelfOrCardKeyDoor (home/hidden_events.asm,
 * engine/overworld/hidden_events.asm) and the hidden event routines in
 * engine/events/hidden_events/*, engine/events/hidden_items.asm and
 * engine/events/card_key.asm, plus the text_asm of the texts they print.
 *
 * Routines that belong to a map's puzzle or minigame (slot machines, the
 * Pokémon Mansion switches, the link-room Game Boys) are looked up in
 * `Engine.hiddenEventHandlers`, which those map ports fill in.
 */
import type { Co, Engine } from './Engine';
import type { ScriptEnv } from './ScriptEnv';
import { c } from '../rom/constants';
import { getBit } from '../game/state';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT, FACING_UP } from './sprites';
import { PAD_A, PAD_B, PAD_LEFT, PAD_RIGHT } from './pad';
import { picPixels } from '../rom/extract/pics';
import type { Pic } from '../data/schema';
import { encodePlain } from '../ui/TextPrinter';
import { handleMenuInput, restoreScreen, saveScreen } from '../ui/menus';
import { showPokedexData } from '../ui/pokedex';

export interface HiddenEvent {
  x: number;
  y: number;
  arg: number;
  fn: string;
}

/** A hidden event routine. Returns hItemAlreadyFound: 0 = handled, nonzero = carry on to sprites/signs. */
export type HiddenEventFn = (e: Engine, ev: HiddenEvent) => Co<number | void>;

const predefId = (e: Engine, label: string): number => {
  const id = e.bundle.hidden.predefIds[label];
  if (!id) throw new Error(`no text predef ${label}`);
  return id;
};

/** EnableAutoTextBoxDrawing */
const autoBox = (e: Engine) => {
  e.ram.autoTextBoxControl = 0;
  e.ram.doNotWaitForButtonPress = 0;
};

const spriteFacing = (e: Engine): number =>
  ({ up: FACING_UP, down: FACING_DOWN, left: FACING_LEFT, right: FACING_RIGHT })[e.state.player.facing];

function* printPredef(e: Engine, label: string): Co {
  yield* e.printPredefTextID(predefId(e, label));
}

/** A routine that just prints one predef text, optionally only when facing up. */
const printer =
  (label: string, upOnly = false): HiddenEventFn =>
  function* (e) {
    if (upOnly && e.state.player.facing !== 'up') return;
    autoBox(e);
    yield* printPredef(e, label);
  };

/** DisplayMonFrontSpriteInBox: the MON_SPRITE_POPUP box with the front pic until a button is pressed. */
function* displayMonFrontSpriteInBox(e: Engine, pic: Pic | undefined): Co {
  yield* e.delayFrames(3);
  const saved = saveScreen(e);
  const s = e.screen;
  s.box(6, 4, 8, 7);
  e.updateSprites();
  if (pic) {
    // AnimateSendingOutMon at (10,11): the pic's top-left is 3 tiles left and 6 up
    const W = pic.width * 8;
    const src = picPixels(pic);
    const ox = (7 - pic.width) >> 1;
    const oy = 7 - pic.width;
    for (let ty = 0; ty < 7; ty++)
      for (let tx = 0; tx < 7; tx++) {
        const tile = new Array<number>(64).fill(0);
        for (let yy = 0; yy < 8; yy++)
          for (let xx = 0; xx < 8; xx++) {
            const px = tx * 8 + xx - ox * 8;
            const py = ty * 8 + yy - oy * 8;
            if (px >= 0 && py >= 0 && px < W && py < W) tile[yy * 8 + xx] = src[py * W + px];
          }
        s.setGlyphOverride(0x100 + ty * 7 + tx, tile);
        s.put(7 + tx, 5 + ty, 0x100 + ty * 7 + tx);
      }
  }
  yield* e.waitForTextScrollButtonPress();
  restoreScreen(e, saved);
  s.clearGlyphOverrides();
  yield* e.delayFrames(3);
}

const frontPic = (e: Engine, species: string): Pic | undefined => {
  const special: Record<string, string> = { FOSSIL_AERODACTYL: 'FossilAerodactylPic', FOSSIL_KABUTOPS: 'FossilKabutopsPic' };
  if (special[species]) return e.bundle.pics.special[special[species]];
  return e.bundle.pics.front[c('pokemon', species)];
};

const monInBox =
  (species: string, text: string): HiddenEventFn =>
  function* (e) {
    yield* displayMonFrontSpriteInBox(e, frontPic(e, species));
    autoBox(e);
    yield* printPredef(e, text);
  };

/** FindHiddenItemOrCoinsIndex */
const findIndex = (list: { map: number; x: number; y: number }[], map: number, ev: HiddenEvent) =>
  list.findIndex((p) => p.map === map && p.x === ev.x && p.y === ev.y);

const ROUTINES: Record<string, HiddenEventFn> = {
  *HiddenItems(e, ev) {
    const i = findIndex(e.bundle.hidden.itemCoords, e.world.data.id, ev);
    if (i < 0) throw new Error(`hidden item at (${ev.x},${ev.y}) on ${e.world.data.constName} is not in HiddenItemCoords`);
    if (getBit(e.state.hiddenItems, i)) return 0xff;
    autoBox(e);
    e.ram.doNotWaitForButtonPress = 1;
    e.ram.nameBuffer = e.bundle.items.find((it) => it.id === ev.arg)?.name ?? '?';
    e.ram.hiddenItemIndex = i;
    e.ram.hiddenEventArg = ev.arg;
    yield* printPredef(e, 'FoundHiddenItemText');
  },
  *HiddenCoins(e, ev) {
    if (!e.state.bag.some((s) => s.item === c('item', 'COIN_CASE'))) return 0xff;
    const i = findIndex(e.bundle.hidden.coinCoords, e.world.data.id, ev);
    if (i < 0) throw new Error(`hidden coins at (${ev.x},${ev.y}) on ${e.world.data.constName} are not in HiddenCoinCoords`);
    if (getBit(e.state.hiddenCoins, i)) return 0xff;
    const n = ev.arg - c('item', 'COIN');
    // 40 is a typo for the 20-coin case in the original
    const amount = n === 10 ? 10 : n === 20 || n === 40 ? 20 : 100;
    e.ram.mem.set(0xffa0, amount); // hCoins
    e.store.dispatch({ type: 'addCoins', amount }, { undoable: false });
    e.store.dispatch({ type: 'setHiddenFound', kind: 'coins', index: i }, { undoable: false });
    autoBox(e);
    // the coin case was full only if the total is exactly 9999 after adding
    yield* printPredef(e, e.state.coins === 9999 ? 'DroppedHiddenCoinsText' : 'FoundHiddenCoinsText');
  },
  *OpenPokemonCenterPC(e) {
    if (e.state.player.facing !== 'up') return;
    autoBox(e);
    e.ram.autoTextBoxControl = 1;
    yield* printPredef(e, 'PokemonCenterPCText');
  },
  OpenRedsPC: printer('RedBedroomPCText'),
  PrintRedSNESText: printer('RedBedroomSNESText'),
  PrintBookcaseText: printer('BookcaseText'),
  PrintMagazinesText: printer('MagazinesText'),
  PrintNewBikeText: printer('NewBicycleText'),
  PrintFightingDojoText: printer('FightingDojoText'),
  PrintFightingDojoText2: printer('EnemiesOnEverySideText'),
  PrintFightingDojoText3: printer('WhatGoesAroundComesAroundText'),
  PrintIndigoPlateauHQText: printer('IndigoPlateauHQText', true),
  PrintTrashText: printer('VermilionGymTrashText'),
  DisplayOakLabLeftPoster: printer('PushStartText'),
  DisplayOakLabEmailText: printer('OakLabEmailText', true),
  *DisplayOakLabRightPoster(e) {
    autoBox(e);
    let owned = 0;
    for (let i = 0; i < 151; i++) if (getBit(e.state.pokedex.owned, i)) owned++;
    yield* printPredef(e, owned < 2 ? 'SaveOptionText' : 'StrengthsAndWeaknessesText');
  },
  *PrintBenchGuyText(e) {
    autoBox(e);
    // BenchGuyTextPointers walked byte by byte, including the missing `inc hl` on a facing mismatch
    const bytes = e.bundle.hidden.benchGuys.flatMap((b) => [b.map, b.facing, b.predef]).concat(0xff);
    const map = e.world.data.id;
    const facing = spriteFacing(e);
    let i = 0;
    for (;;) {
      const a = bytes[i++];
      if (a === 0xff || a === undefined) return;
      if (a !== map) {
        i += 2;
        continue;
      }
      if (bytes[i++] !== facing) continue;
      yield* e.printPredefTextID(bytes[i]);
      return;
    }
  },
  *PrintNotebookText(e, ev) {
    autoBox(e);
    e.ram.doNotWaitForButtonPress = 1;
    yield* e.printPredefTextID(ev.arg);
  },
  *PrintBlackboardLinkCableText(e, ev) {
    autoBox(e);
    e.ram.doNotWaitForButtonPress = 1;
    yield* e.printPredefTextID(ev.arg);
  },
  *GymStatues(e) {
    autoBox(e);
    if (e.state.player.facing !== 'up') return;
    const entry = e.bundle.hidden.mapBadgeFlags.find((m) => m.map === e.world.data.id);
    if (!entry) return;
    const beat = e.state.vars.wBeatGymFlags ?? 0;
    yield* printPredef(e, (beat & entry.mask) === entry.mask ? 'GymStatueText2' : 'GymStatueText1');
  },
  AerodactylFossil: monInBox('FOSSIL_AERODACTYL', 'AerodactylFossilText'),
  KabutopsFossil: monInBox('FOSSIL_KABUTOPS', 'KabutopsFossilText'),
  FanClubPicture1: monInBox('RAPIDASH', 'FanClubPicture1Text'),
  FanClubPicture2: monInBox('FEAROW', 'FanClubPicture2Text'),
  *Route15GateLeftBinoculars(e) {
    if (e.state.player.facing !== 'up') return;
    autoBox(e);
    yield* printPredef(e, 'Route15UpstairsBinocularsText');
    e.hooks.playCry?.(c('pokemon', 'ARTICUNO'));
    yield* displayMonFrontSpriteInBox(e, frontPic(e, 'ARTICUNO'));
  },
  *BillsHousePC(e) {
    autoBox(e);
    if (e.state.player.facing !== 'up') return;
    const ev = (n: string) => e.event(n);
    if (ev('EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING')) {
      e.ram.doNotWaitForButtonPress = 1;
      yield* printPredef(e, 'BillsHousePokemonList');
      return;
    }
    if (ev('EVENT_USED_CELL_SEPARATOR_ON_BILL') || !ev('EVENT_BILL_SAID_USE_CELL_SEPARATOR')) {
      yield* printPredef(e, 'BillsHouseMonitorText');
      return;
    }
    // .doCellSeparator
    e.ram.doNotWaitForButtonPress = 1;
    yield* printPredef(e, 'BillsHouseInitiatedText');
    for (const [delay, sfx] of [
      [32, 'tink'],
      [80, 'shrink'],
      [48, 'tink'],
      [32, 'get_item_1'],
    ] as const) {
      yield* e.delayFrames(delay);
      yield* e.env.playSoundAndWait(sfx);
    }
    e.env.playDefaultMusic();
    e.setEvent('EVENT_USED_CELL_SEPARATOR_ON_BILL');
  },
  *GymTrashScript(e, ev) {
    autoBox(e);
    e.env.setVar('wGymTrashCanIndex', ev.arg);
    if (e.event('EVENT_2ND_LOCK_OPENED')) {
      yield* printPredef(e, 'VermilionGymTrashText');
      return;
    }
    const can = ev.arg;
    const v = e.state.vars;
    let text: string;
    if (!e.event('EVENT_1ST_LOCK_OPENED')) {
      if ((v.wFirstLockTrashCanIndex ?? 0) === can) {
        e.setEvent('EVENT_1ST_LOCK_OPENED');
        sampleSecondTrashCan(e, can);
        text = 'VermilionGymTrashSuccessText1';
      } else text = 'VermilionGymTrashText';
    } else if ((v.wSecondLockTrashCanIndex ?? 0) === can || (v.wSecondLockTrashCanIndex2 ?? 0) === can) {
      e.setEvent('EVENT_2ND_LOCK_OPENED');
      e.ram.curMapLoaded2 = true;
      text = 'VermilionGymTrashSuccessText3';
    } else {
      // reset the cans
      e.setEvent('EVENT_1ST_LOCK_OPENED', false);
      e.env.setVar('wFirstLockTrashCanIndex', e.random() & 0xe);
      text = 'VermilionGymTrashFailText';
    }
    yield* printPredef(e, text);
  },
  *PrintCinnabarQuiz(e, ev) {
    if (e.state.player.facing !== 'up') return;
    autoBox(e);
    e.ram.hiddenEventArg = ev.arg;
    yield* printPredef(e, 'CinnabarGymQuiz');
  },
};

/** Yellow_SampleSecondTrashCan with TrashCanRandom (the 3-entry case uses the whole swapped random byte). */
function sampleSecondTrashCan(e: Engine, can: number): void {
  const t = e.bundle.hidden.trashCans;
  const base = can * 9;
  const count = t[base];
  let i: number;
  if (count <= 1) i = 0;
  else if (count === 2) i = e.random() & 1;
  else if (count === 3) {
    const r = e.random();
    i = ((r << 4) | (r >> 4)) & 0xff;
  } else i = e.random() & 3;
  e.env.setVar('wSecondLockTrashCanIndex', t[base + 1 + i * 2]);
  e.env.setVar('wSecondLockTrashCanIndex2', t[base + 2 + i * 2]);
}

/** CheckForHiddenEventOrBookshelfOrCardKeyDoor. Returns true when the A press was used up (hItemAlreadyFound = 0). */
export function* checkForHiddenEventOrBookshelfOrCardKeyDoor(e: Engine): Co<boolean> {
  const p = e.state.player;
  const [fx, fy] = e.frontOfPlayer();
  const list = e.bundle.hidden.events[e.world.data.id] ?? [];
  const ev = list.find((h) => h.x === fx && h.y === fy);
  if (ev) {
    const fn = ROUTINES[ev.fn] ?? e.hiddenEventHandlers[ev.fn] ?? e.scripts.hidden?.[ev.fn];
    if (!fn) {
      e.hooks.unported?.(`hidden event ${ev.fn} on ${e.world.data.constName}`);
      return true;
    }
    const r = (yield* fn(e, ev)) ?? 0;
    return r === 0;
  }
  // .hiddenEventNotFound: PrintBookshelfText
  const tileInFront = e.world.collisionTile(fx, fy);
  if (p.facing === 'up') {
    const tile = e.world.tileAt(fx * 2, fy * 2 + 1); // lda_coord 8, 7
    const shelf = e.bundle.hidden.bookshelves.find((b) => b.tileset === e.world.data.tileset && b.tile === tile);
    if (shelf) {
      autoBox(e);
      yield* e.printPredefTextID(shelf.predef);
      return true;
    }
  }
  yield* printCardKeyText(e, tileInFront, fx, fy);
  return false;
}

/** PrintCardKeyText: Silph Co. card key doors. */
function* printCardKeyText(e: Engine, tile: number, fx: number, fy: number): Co {
  const map = e.world.data.id;
  if (!e.bundle.hidden.silphCoMaps.includes(map)) return;
  const eleven = map === c('map', 'SILPH_CO_11F');
  if (tile !== 0x18 && tile !== 0x24 && !(eleven && tile === 0x5e)) return;
  if (!e.state.bag.some((s) => s.item === c('item', 'CARD_KEY'))) {
    yield* printPredef(e, 'CardKeyFailText');
    return;
  }
  e.ram.playerMovingDirection = 0;
  yield* printPredef(e, 'CardKeySuccessText');
  const bx = fx >> 1;
  const by = fy >> 1;
  e.ram.cardKeyDoor = { x: bx, y: by };
  e.world.replaceBlock(bx, by, eleven ? 0x03 : 0x0e);
  e.ram.curMapLoaded1 = true;
  e.hooks.playSound?.('go_inside');
}

/** UpdateCinnabarGymGateTileBlocks_: open floor for unlocked gates, the gate block otherwise. */
export function updateCinnabarGymGateTileBlocks(e: Engine): void {
  const gates = e.bundle.hidden.cinnabarGates;
  const gate0 = c('event', 'EVENT_CINNABAR_GYM_GATE0_UNLOCKED');
  for (let i = gates.length; i >= 1; i--) {
    const g = gates[i - 1];
    const open = getBit(e.state.eventFlags, gate0 + i);
    e.world.replaceBlock(g.x, g.y, open ? 0x0e : g.block);
  }
}

// ------------------------------------------------------------------ text_asm of the predef texts
const putLines = (e: Engine, x: number, y: number, s: string) => {
  s.split('{next}').forEach((line, i) => encodePlain(line).forEach((code, j) => e.screen.put(x + j, y + i * 2, code)));
};

export const hiddenEventTexts: Record<string, (env: ScriptEnv) => Co> = {
  /** FoundHiddenItemText's asm: give the item, or say the bag is full. */
  *FoundHiddenItemText(env) {
    const e = env.e;
    const item = e.ram.hiddenEventArg;
    try {
      e.store.dispatch({ type: 'giveItem', item, qty: 1 }, { undoable: false });
    } catch {
      yield* e.waitForTextScrollButtonPress();
      e.ram.doNotWaitForButtonPress = 0;
      yield* env.printText('HiddenItemBagFullText');
      return;
    }
    e.store.dispatch({ type: 'setHiddenFound', kind: 'item', index: e.ram.hiddenItemIndex }, { undoable: false });
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('get_item_2');
  },
  *BookOrSculptureText(env) {
    const e = env.e;
    let label = 'PokemonBooksText';
    if (e.world.data.tileset === c('tileset', 'MANSION')) {
      const [fx, fy] = e.frontOfPlayer();
      if (e.world.tileAt(fx * 2, fy * 2) === 0x38) label = 'DiglettSculptureText'; // lda_coord 8, 6
    }
    yield* env.printText(label);
  },
  *IndigoPlateauStatues(env) {
    yield* env.printText('IndigoPlateauStatuesText1');
    yield* env.printText(env.e.state.player.x & 1 ? 'IndigoPlateauStatuesText2' : 'IndigoPlateauStatuesText3');
  },
  *SaffronCityPokecenterBenchGuyText(env) {
    yield* env.printText(env.checkEvent('EVENT_BEAT_SILPH_CO_GIOVANNI') ? 'SaffronCityPokecenterBenchGuyText2' : 'SaffronCityPokecenterBenchGuyText1');
  },
  *BillsHouseInitiatedText(env) {
    env.stopAllMusic();
    yield* env.delayFrames(16);
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('switch');
    yield* env.delayFrames(60);
  },
  *BillsHousePokemonList(env) {
    const e = env.e;
    yield* env.printText('BillsHousePokemonListText1');
    let current = 0;
    for (;;) {
      e.ram.noTextDelay = true;
      e.screen.box(0, 0, 10, 9);
      putLines(e, 2, 2, e.bundle.strings.BillsMonListText);
      yield* env.printText('BillsHousePokemonListText2');
      const buffer2 = saveScreen(e);
      const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: 4, current, watchedKeys: PAD_A | PAD_B });
      current = item;
      if (key & PAD_B || item === 4) {
        e.ram.noTextDelay = false;
        restoreScreen(e, buffer2);
        break;
      }
      const sp = c('pokemon', 'EEVEE') + item;
      yield* displayPokedex(e, sp);
      restoreScreen(e, buffer2);
    }
  },
  *LinkCableHelp(env) {
    const e = env.e;
    const buffer1 = saveScreen(e);
    yield* env.printText('LinkCableHelpText1');
    let current = 0;
    for (;;) {
      e.ram.noTextDelay = true;
      e.screen.box(0, 0, 8, 13);
      putLines(e, 2, 2, e.bundle.strings.HowToLinkText);
      yield* env.printText('LinkCableHelpText2');
      const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: 3, current, watchedKeys: PAD_A | PAD_B });
      current = item;
      if (key & PAD_B || item === 3) break;
      e.ram.noTextDelay = false;
      yield* env.printText(`LinkCableInfoText${item + 1}`);
    }
    e.ram.noTextDelay = false;
    restoreScreen(e, buffer1);
  },
  *ViridianSchoolBlackboard(env) {
    const e = env.e;
    const buffer1 = saveScreen(e);
    yield* env.printText('ViridianSchoolBlackboardText1');
    let topX = 1;
    let offset = 0;
    let current = 0;
    const texts = ['Sleep', 'Poison', 'Prlz', 'Burn', 'Frozen'];
    for (;;) {
      e.ram.noTextDelay = true;
      e.screen.box(0, 0, 6, 10);
      putLines(e, 1, 2, e.bundle.strings.StatusAilmentText1);
      putLines(e, 6, 2, e.bundle.strings.StatusAilmentText2);
      yield* env.printText('ViridianSchoolBlackboardText2');
      const [item, key] = yield* handleMenuInput(e, {
        topX,
        topY: 2,
        maxItem: 2,
        current,
        watchedKeys: PAD_LEFT | PAD_RIGHT | PAD_A | PAD_B,
      });
      current = item;
      if (key & PAD_B) break;
      if (key & PAD_RIGHT) {
        topX = 6;
        offset = 3;
        continue;
      }
      if (key & PAD_LEFT) {
        topX = 1;
        offset = 0;
        continue;
      }
      const which = item + offset;
      if (which === 5) break; // QUIT
      e.ram.noTextDelay = false;
      yield* env.printText(`ViridianBlackboard${texts[which]}Text`);
    }
    e.ram.noTextDelay = false;
    restoreScreen(e, buffer1);
  },
  *ViridianSchoolNotebook(env) {
    const turnPage = function* () {
      yield* env.printText('TurnPageText');
      return yield* env.yesNoChoice();
    };
    yield* env.printText('ViridianSchoolNotebookText1');
    if (!(yield* turnPage())) return;
    yield* env.printText('ViridianSchoolNotebookText2');
    if (!(yield* turnPage())) return;
    yield* env.printText('ViridianSchoolNotebookText3');
    if (!(yield* turnPage())) return;
    yield* env.printText('ViridianSchoolNotebookText4');
    yield* env.printText('ViridianSchoolNotebookText5');
  },
  *TownMapText(env) {
    const e = env.e;
    e.ram.doNotWaitForButtonPress = 1;
    if (!e.townMap) {
      e.hooks.unported?.('DisplayTownMap');
      return;
    }
    yield* e.townMap(e);
  },
  /** CinnabarGymQuizCorrectText's asm: the door sound only for a gate that wasn't open yet. */
  *CinnabarGymQuizCorrectText(env) {
    const gate0 = c('event', 'EVENT_CINNABAR_GYM_GATE0_UNLOCKED');
    if (getBit(env.e.state.eventFlags, gate0 + env.e.ram.backupGymGateIndex)) return;
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('go_inside');
  },
  *VermilionGymTrashSuccessText1(env) {
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('switch');
  },
  *VermilionGymTrashSuccessText3(env) {
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('go_inside');
  },
  *VermilionGymTrashFailText(env) {
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('denied');
  },
  *CinnabarGymQuiz(env) {
    const e = env.e;
    env.setVar('wOpponentAfterWrongAnswer', 0);
    e.ram.cinnabarQuizWrong = false;
    const arg = e.ram.hiddenEventArg;
    const gate = arg & 0xf;
    const answer = arg >> 4;
    yield* env.printText(gate === 1 ? 'CinnabarGymQuizIntroText' : 'CinnabarGymQuizShortIntroText');
    yield* env.printText(`CinnabarQuizQuestionsText${gate}`);
    e.ram.doNotWaitForButtonPress = 1;
    // CinnabarGymQuiz_AskQuestion: YES is menu item 0, NO is 1
    const choice = (yield* env.yesNoChoice()) ? 0 : 1;
    const gate0 = c('event', 'EVENT_CINNABAR_GYM_GATE0_UNLOCKED');
    if (choice === answer) {
      e.ram.curMapLoaded1 = true;
      e.ram.backupGymGateIndex = gate;
      yield* env.printText('CinnabarGymQuizCorrectText');
      e.store.dispatch({ type: 'setEvent', flag: gate0 + gate, value: true }, { undoable: false });
      updateCinnabarGymGateTileBlocks(e);
      return;
    }
    yield* env.waitForSoundToFinish();
    yield* env.playSoundAndWait('denied');
    yield* env.printText('CinnabarGymQuizIncorrectText');
    const trainer0 = c('event', 'EVENT_BEAT_CINNABAR_GYM_TRAINER_0');
    // FlagAction on TRAINER_0's byte with bit gate + 2 (TRAINER_0 is bit 2): the gate's own trainer
    if (getBit(e.state.eventFlags, trainer0 + gate)) return;
    env.setVar('wOpponentAfterWrongAnswer', gate + 2);
    e.ram.cinnabarQuizWrong = true;
  },
};

/** DisplayPokedex: the data page, then the species counts as seen. */
export function* displayPokedex(e: Engine, speciesIndex: number): Co {
  e.ram.noTextDelay = true;
  yield* showPokedexData(e, speciesIndex);
  e.ram.noTextDelay = false;
  yield* e.delayFrames(10);
  const dex = e.bundle.species[speciesIndex]?.dex;
  if (dex) e.store.dispatch({ type: 'setPokedex', dex, seen: true }, { undoable: false });
  e.ram.doNotWaitForButtonPress = 1;
}
