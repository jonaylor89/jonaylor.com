/**
 * START menu (engine/menus/draw_start_menu.asm, home/start_menu.asm),
 * SaveMenu (engine/menus/save.asm) and DisplayOptionMenu (engine/menus/options.asm).
 */
import type { Co, Engine } from '../engine/Engine';
import { PAD_A, PAD_B, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_START, PAD_UP } from '../engine/pad';
import { encodePlain } from './TextPrinter';
import { handleMenuInput, LowSensitivity, restoreScreen, saveScreen, twoOptionMenu } from './menus';
import { getBit } from '../game/state';
import { readSave, writeSave } from '../game/save';
import { c } from '../rom/constants';
import { startMenuItem, startMenuPokemon } from './startSubMenus';
import { showPokedexMenu } from './pokedex';
import { trainerCard } from './trainerCard';

const put = (e: Engine, x: number, y: number, s: string) => {
  let cx = x;
  let cy = y;
  for (const part of s.replace(/\{poke\}/g, 'POKé').split('{next}')) {
    encodePlain(part).forEach((code, i) => e.screen.put(cx + i, cy, code));
    cy += 2;
    cx = x;
  }
};

/** PrintSafariZoneSteps: steps left and Safari Balls, on the Safari Zone's maps */
function printSafariZoneSteps(e: Engine): void {
  const map = e.world.data.id;
  if (map < c('map', 'SAFARI_ZONE_EAST') || map >= c('map', 'CERULEAN_CAVE_2F')) return;
  const str = e.bundle.strings;
  const vars = e.state.vars;
  e.screen.box(0, 0, 3, 7);
  put(e, 1, 1, String(vars.wSafariSteps ?? 0).padStart(3, ' '));
  put(e, 4, 1, str.SafariSteps);
  put(e, 1, 3, str.SafariBallText);
  const balls = vars.wNumSafariBalls ?? 0;
  if (balls < 10) put(e, 5, 3, ' ');
  put(e, 6, 3, String(balls).padStart(2, ' '));
}

export type StartMenuChoice = 'pokedex' | 'pokemon' | 'item' | 'trainer' | 'save' | 'option' | 'exit';

/** DisplayStartMenu loop. Sub-screens not yet built are reported via hooks.unported. */
export function* startMenu(e: Engine): Co {
  const str = e.bundle.strings;
  const hasDex = getBit(e.state.eventFlags, c('event', 'EVENT_GOT_POKEDEX'));
  for (;;) {
    const saved = saveScreen(e);
    e.screen.box(10, 0, hasDex ? 14 : 12, 8);
    const items: [StartMenuChoice, string][] = [];
    if (hasDex) items.push(['pokedex', str.StartMenuPokedexText]);
    items.push(['pokemon', str.StartMenuPokemonText], ['item', str.StartMenuItemText], ['trainer', e.state.player.name]);
    items.push(['save', str.StartMenuSaveText], ['option', str.StartMenuOptionText], ['exit', str.StartMenuExitText]);
    items.forEach(([, label], i) => put(e, 12, 2 + i * 2, label));
    printSafariZoneSteps(e);
    const remembered = Math.min(e.ram.startMenuItem ?? 0, items.length - 1);
    const [item, key] = yield* handleMenuInput(e, {
      topX: 11,
      topY: 2,
      maxItem: items.length - 1,
      current: remembered,
      // The original also watches UP/DOWN to implement wrap-around itself (home/start_menu.asm).
      watchedKeys: PAD_START | PAD_B | PAD_A,
      wrap: true,
    });
    e.ram.startMenuItem = item;
    if (key & (PAD_B | PAD_START)) {
      restoreScreen(e, saved);
      e.closeTextDisplay();
      return;
    }
    const choice = items[item][0];
    if (choice === 'exit') {
      e.closeTextDisplay();
      return;
    }
    if (choice === 'save') {
      yield* saveMenu(e);
      e.closeTextDisplay();
      return;
    }
    if (choice === 'option') {
      yield* optionMenu(e);
      e.screen.clear();
      continue;
    }
    if (choice === 'pokemon' || choice === 'item') {
      const r = choice === 'pokemon' ? yield* startMenuPokemon(e) : yield* startMenuItem(e);
      if (r === 'close') {
        e.screen.clear();
        e.closeTextDisplay();
        return;
      }
      restoreScreen(e, saved);
      continue;
    }
    if (choice === 'pokedex') yield* showPokedexMenu(e);
    else if (choice === 'trainer') {
      const cells = e.screen.cells.slice();
      yield* trainerCard(e);
      e.screen.clearGlyphOverrides();
      e.screen.cells.set(cells);
      e.screen.markDirty();
    }
    restoreScreen(e, saved);
  }
}


/** SaveMenu: info box, "Would you like to SAVE?", older-file check, write. */
export function* saveMenu(e: Engine): Co {
  const s = e.state;
  const saved = saveScreen(e);
  // PrintSaveScreenText
  e.screen.box(4, 0, 8, 14);
  put(e, 5, 2, e.bundle.strings.SaveScreenInfoText);
  put(e, 12, 2, s.player.name);
  let badges = 0;
  for (let i = 0; i < 8; i++) if (s.badges & (1 << i)) badges++;
  put(e, 17, 4, String(badges).padStart(2, ' '));
  let owned = 0;
  for (let i = 0; i < 151; i++) if (getBit(s.pokedex.owned, i)) owned++;
  put(e, 16, 6, String(owned).padStart(3, ' '));
  const mins = Math.floor(s.frames / 60 / 60);
  put(e, 13, 8, `${String(Math.min(999, Math.floor(mins / 60))).padStart(3, ' ')}`);
  e.screen.put(16, 8, 0x6d); // the small colon
  put(e, 17, 8, String(mins % 60).padStart(2, '0'));
  yield* e.delayFrames(30);
  yield* e.delayFrames(10);
  yield* e.printText('WouldYouLikeToSaveText');
  if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 0, 7)) !== 0) {
    restoreScreen(e, saved);
    return;
  }
  yield* e.delayFrames(10);
  const existing = yield* awaitPromise(readSave('slot1').catch(() => undefined));
  if (existing && existing.state.player.id !== s.player.id) {
    yield* e.printText('OlderFileWillBeErasedText');
    if ((yield* twoOptionMenu(e, 'YES_NO_MENU', 0, 7)) !== 0) {
      restoreScreen(e, saved);
      return;
    }
  }
  if (!(yield* persistCheckpoint(e))) return;
  yield* e.printText('SavingText');
  yield* e.delayFrames(128);
  yield* e.printText('GameSavedText');
  yield* e.delayFrames(10);
  yield* e.env.playSoundWaitForCurrent('save');
  yield* e.waitForSoundToFinish();
}

/** Unlike menu reads, a durable write must not time out and report false success. */
export function* persistCheckpoint(e: Engine): Co<boolean> {
  let done = false;
  let saved = false;
  writeSave('slot1', e.state).then(() => { saved = true; done = true; }, () => { done = true; });
  while (!done) yield;
  if (!saved) yield* e.printOps([{ t: 'text', v: 'Save failed.{next}Check browser storage.{prompt}' }]);
  return saved;
}

/** Wait (in frames) for a promise; resolves to undefined on rejection. */
export function* awaitPromise<T>(p: Promise<T>): Co<T | undefined> {
  let done = false;
  let value: T | undefined;
  p.then(
    (v) => ((value = v), (done = true)),
    () => (done = true),
  );
  for (let i = 0; i < 600 && !done; i++) yield;
  return value;
}

/** DisplayOptionMenu: TEXT SPEED / ANIMATION / BATTLESTYLE / SOUND / PRINT / CANCEL. */
export function* optionMenu(e: Engine): Co {
  const str = e.bundle.strings;
  const o = { ...e.state.options };
  const speeds = ['fast', 'medium', 'slow'] as const;
  e.screen.clear();
  e.screen.box(0, 0, 16, 18);
  put(e, 2, 2, str.AllOptionsText);
  put(e, 2, 16, str.OptionMenuCancelText);
  const T = (k: string) => str[`OptionsMenu_${k}`];
  const draw = () => {
    put(e, 14, 2, T(['TextSpeed.Fast', 'TextSpeed.Mid', 'TextSpeed.Slow'][speeds.indexOf(o.textSpeed)]));
    put(e, 14, 4, T(o.battleAnimation ? 'BattleAnimations.On' : 'BattleAnimations.Off'));
    put(e, 14, 6, T(o.battleStyle === 'shift' ? 'BattleStyle.Shift' : 'BattleStyle.Set'));
    put(e, 8, 8, T(['SpeakerSettings.Mono', 'SpeakerSettings.Earphone1', 'SpeakerSettings.Earphone2', 'SpeakerSettings.Earphone3'][o.sound ?? 0]));
    put(e, 8, 10, T(['GBPrinterBrightness.Lightest', 'GBPrinterBrightness.Lighter', 'GBPrinterBrightness.Normal', 'GBPrinterBrightness.Darker', 'GBPrinterBrightness.Darkest'][o.printer ?? 2]));
  };
  let cursor = 0; // 0-4 options, 7 = CANCEL
  const placeCursor = () => {
    for (let y = 1; y <= 16; y++) e.screen.put(1, y, 0x7f);
    e.screen.put(1, 2 + cursor * 2, 0xed);
  };
  draw();
  placeCursor();
  const js = new LowSensitivity(e);
  for (;;) {
    yield;
    const k = js.read(e);
    if (!k) continue;
    if (k & (PAD_START | PAD_B) || (k & PAD_A && cursor === 7)) break;
    if (k & PAD_DOWN) cursor = cursor === 4 ? 7 : cursor === 7 ? 0 : cursor + 1;
    else if (k & PAD_UP) cursor = cursor === 0 ? 7 : cursor === 7 ? 4 : cursor - 1;
    else if (k & (PAD_LEFT | PAD_RIGHT)) {
      const d = k & PAD_RIGHT ? 1 : -1;
      if (cursor === 0) o.textSpeed = speeds[(speeds.indexOf(o.textSpeed) + d + 3) % 3];
      if (cursor === 1) o.battleAnimation = !o.battleAnimation;
      if (cursor === 2) o.battleStyle = o.battleStyle === 'shift' ? 'set' : 'shift';
      if (cursor === 3) o.sound = ((o.sound ?? 0) + d + 4) % 4;
      if (cursor === 4) o.printer = ((o.printer ?? 2) + d + 5) % 5;
      draw();
    }
    placeCursor();
    yield* e.delayFrames(3);
  }
  e.store.dispatch({ type: 'setOptions', options: o }, { undoable: false });
}
