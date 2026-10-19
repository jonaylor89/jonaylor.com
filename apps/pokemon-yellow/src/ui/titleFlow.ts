/**
 * From power-on to the overworld: MainMenu (engine/menus/main_menu.asm) with
 * CONTINUE / NEW GAME / OPTION and DisplayContinueGameInfo, and OakSpeech
 * (engine/movie/oak_speech/oak_speech.asm, oak_speech2.asm) with the default
 * name menus, the sliding pics and the shrinking player.
 */
import type { Co, Engine } from '../engine/Engine';
import type { Pic } from '../data/schema';
import { deleteSave, readSave } from '../game/save';
import { newGameState, getBit } from '../game/state';
import { PAD_A, PAD_B, PAD_START } from '../engine/pad';
import { handleMenuInput, namingScreen, twoOptionMenu } from './menus';
import { awaitPromise, optionMenu } from './startMenu';
import { encodePlain } from './TextPrinter';
import { frontPixels, placePixels } from './picTiles';
import { inputToPad } from '../engine/pad';
import { c } from '../rom/constants';
import { GbHardware } from '../gb/hardware';
import { playIntro } from '../movie/intro';
import { PAD_SELECT, PAD_UP } from '../engine/pad';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';

const BLANK = 0x7f;

function put(e: Engine, x: number, y: number, s: string): void {
  s.split('{next}').forEach((line, i) => encodePlain(line).forEach((code, j) => e.screen.put(x + j, y + i * 2, code)));
}

function clearScreen(e: Engine): void {
  e.screen.clear();
  e.screen.fill(0, 0, 20, 18, BLANK);
}

/** The whole boot: title screen, main menu, then either the save or a new game. */
export function* bootSequence(e: Engine): Co {
  e.screen.backdrop = true;
  let init = true; // Init: the intro plays first
  for (;;) {
    const save = yield* awaitPromise(readSave('slot1').catch(() => undefined));
    if (init) {
      // Init: BANK(SFX_Shooting_Star) is the audio bank for the intro
      const bank = e.bundle.audio.engineBanks[2];
      e.sound.setBanks(bank, bank);
      yield* playIntro(e);
    }
    init = false;
    const title = yield* titleScreen(e);
    if (title === 'reset') {
      init = true;
      continue;
    }
    if (title === 'clear') {
      yield* doClearSaveDialogue(e);
      init = true;
      continue;
    }
    const choice = yield* mainMenu(e, !!save);
    if (choice === 'title') continue;
    if (choice === 'continue' && save) {
      e.adoptState(save.state);
      // wNumHoFTeams and still in the Hall of Fame: start in Pallet Town
      if ((e.state.vars.wNumHoFTeams ?? 0) && e.state.player.map === c('map', 'HALL_OF_FAME')) {
        e.screen.backdrop = false;
        yield* e.specialWarp(c('map', 'PALLET_TOWN'));
        return;
      }
      e.store.dispatch({ type: 'face', facing: 'down' }, { undoable: false });
    } else yield* oakSpeech(e);
    break;
  }
  e.screen.backdrop = false;
  e.screen.clear();
  yield* e.delayFrames(20); // SpecialEnterMap
}

/**
 * DisplayTitleScreen: the logo drops in by scrolling the background (Pikachu sits
 * in the window meanwhile), the speech bubble, then the blinking loop until
 * A/START. Returns 'menu', 'clear' (UP+SELECT+B) or 'reset' (the timeout).
 */
export function* titleScreen(e: Engine): Co<'menu' | 'clear' | 'reset'> {
  const t = e.bundle.ui.title;
  const hw = new GbHardware(e);
  const p = hw.ppu;
  const bank = e.bundle.audio.musicBanks.MUSIC_TITLE_SCREEN;
  e.sound.setBanks(bank, bank);
  e.hooks.fade?.(1, 'white'); // GBPalWhiteOut
  e.screen.setPpu(p);
  Object.assign(p, { lcdOn: true, bgOn: true, objOn: true, winOn: true, bgMap: 0, winMap: 1, tileData8000: false, lyTarget: undefined });
  hw.scx = 0;
  hw.scy = 0x40;
  hw.wy = 0x90;
  // LoadFontTilePatterns, then the title graphics over it
  const font = e.bundle.ui.font;
  p.loadTiles(0x80, font.pixels, font.count);
  p.loadTiles(0x80 + 0x60, t.copyrightLogo, 5);
  p.loadTiles(0x80 + 0x6e, t.nine, 1);
  p.loadTiles(0x80 + 0x65, t.gameFreakLogo, 9);
  p.loadTiles(0x100, t.pokemonLogo); // LoadYellowTitleScreenGFX
  p.loadTiles(0x80 + 0x7d, t.pokemonLogoCorner);
  p.loadTiles(0x80, t.pikachuBG);
  p.loadTiles(0x80 + 0x70, t.pikachuOB);
  p.bgMaps[0].fill(BLANK);
  p.bgMaps[1].fill(BLANK, 0, 0x40);
  const box = (map: number[], x: number, y: number, w: number, h: number) => {
    for (let r = 0; r < h; r++) for (let i = 0; i < w; i++) hw.tileMap[(y + r) * 20 + x + i] = map[r * w + i];
  };
  hw.tileMap.fill(BLANK);
  box(t.logoTilemap, 2, 1, 16, 7);
  t.copyright.forEach((code, i) => (hw.tileMap[17 * 20 + 2 + i] = code));
  const buffer2 = hw.tileMap.slice();
  // TitleScreen_PlacePikachu
  box(t.pikachuTilemap, 4, 8, 12, 9);
  [0x96, 0x9d, 0xa7, 0xb1].forEach((code, i) => (hw.tileMap[(10 + i) * 20 + 16] = code));
  t.eyes.forEach(([y, x, tile, attr], i) => Object.assign(hw.shadowOam[i], { y, x, tile, attr }));
  hw.copyTileMapNow(0x9b00); // rows 8-17 land in the window's map
  const buffer1 = hw.tileMap.slice();
  hw.wy = 0x40;
  hw.tileMap.set(buffer2);
  hw.copyTileMapNow(0x9800);
  hw.autoBgDest = 0x9800;
  hw.autoBgTransfer = true;
  yield* hw.delayFrames(3);
  const P = (n: string) => c('palette', n);
  e.hooks.paletteLayout?.([P('PAL_LOGO2'), P('PAL_LOGO1'), P('PAL_MEWMON'), P('PAL_PURPLEMON')], [
    { pal: 0, x0: 0, y0: 0, x1: 19, y1: 7 },
    { pal: 2, x0: 0, y0: 8, x1: 19, y1: 17 },
    { pal: 0, x0: 9, y0: 8, x1: 10, y1: 8 },
  ]);
  e.hooks.fade?.(0); // GBPalNormal
  p.bgp = 0xe4;
  p.obp0 = 0xe0;
  // the bouncing logo
  for (const [d, n] of t.bounce) {
    if (d === -3) e.env.playSound('intro_crash');
    for (let i = 0; i < n; i++) {
      yield* hw.vblank();
      hw.scy = (hw.scy + d) & 0xff;
    }
  }
  hw.tileMap.set(buffer1); // LoadScreenTilesFromBuffer1
  yield* hw.delayFrames(36);
  e.env.playSound('intro_whoosh');
  box(t.bubbleTilemap, 6, 4, 7, 4); // TitleScreen_PlacePikaSpeechBubble
  hw.tileMap[8 * 20 + 9] = 0x64;
  hw.tileMap[8 * 20 + 10] = 0x65;
  hw.wy = 144;
  yield* hw.delayFrames(3);
  yield* playPikachuCry(e, pikachuCry(1));
  e.stopAllMusic();
  e.playMusic('MUSIC_TITLE_SCREEN');
  // .titleScreenLoop
  let scene = 0;
  let timer = 0;
  let resetCounter = 0;
  for (;;) {
    resetCounter++;
    if (resetCounter >> 8 === 0x0c) {
      e.stopAllMusic();
      e.screen.setPpu(undefined);
      return 'reset';
    }
    yield* hw.vblank();
    const held = inputToPad(e.input, 'held'); // hJoyHeld
    if ((held & (PAD_UP | PAD_SELECT | PAD_B)) === (PAD_UP | PAD_SELECT | PAD_B) || held & (PAD_A | PAD_START)) {
      yield* playPikachuCry(e, pikachuCry(11));
      e.hooks.fade?.(1, 'white'); // GBPalWhiteOutWithDelay3
      yield* hw.delayFrames(3);
      e.screen.setPpu(undefined);
      e.hooks.palette?.(undefined);
      clearScreen(e);
      yield* e.delayFrames(3);
      e.hooks.fade?.(0);
      return (held & (PAD_UP | PAD_SELECT | PAD_B)) === (PAD_UP | PAD_SELECT | PAD_B) ? 'clear' : 'menu';
    }
    // DoTitleScreenFunction: the eyes blink now and then
    const tm = timer;
    timer = (timer + 1) & 0xff;
    if (tm === 0 || tm === 0x80 || tm === 0x90) scene = 1;
    const BLINK = [-1, 4, -2, -2, 8, -2, -2, 4, -2, -2, 0, -3];
    const step = BLINK[scene] ?? -1;
    if (step === -3) scene = 0;
    else if (step !== -1) {
      if (step >= 0) for (let i = 0; i < 8; i++) hw.shadowOam[i].tile = (hw.shadowOam[i].tile & 0xf3) | step;
      scene++;
    }
  }
}

/** DoClearSaveDialogue: "Clear all saved data?" NO/YES (B does nothing), then Init. */
function* doClearSaveDialogue(e: Engine): Co {
  clearScreen(e);
  e.hooks.palette?.(undefined);
  yield* e.printText('ClearSaveDataText');
  e.ram.joyIgnore = PAD_B;
  const choice = yield* twoOptionMenu(e, 'NO_YES_MENU', 14, 7);
  e.ram.joyIgnore = 0;
  if (choice === 1) yield* awaitPromise(deleteSave('slot1'));
  e.closeTextDisplay();
}

/** MainMenu: 'continue', 'new' or 'title' (B). */
export function* mainMenu(e: Engine, hasSave: boolean): Co<'continue' | 'new' | 'title'> {
  for (;;) {
    yield* e.delayFrames(20);
    clearScreen(e);
    e.hooks.palette?.(undefined);
    e.hooks.fade?.(0);
    const str = e.bundle.strings;
    if (hasSave) {
      e.screen.box(0, 0, 6, 13);
      put(e, 2, 2, str.ContinueText);
    } else {
      e.screen.box(0, 0, 4, 13);
      put(e, 2, 2, str.NewGameText);
    }
    const max = hasSave ? 2 : 1;
    const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: max, current: 0, watchedKeys: PAD_A | PAD_B | PAD_START });
    if (key & PAD_B) return 'title';
    yield* e.delayFrames(20);
    const choice = hasSave ? item : item + 1;
    if (choice === 1) return 'new';
    if (choice === 2) {
      yield* optionMenu(e);
      continue;
    }
    // .choseContinue
    yield* displayContinueGameInfo(e, hasSave);
    for (;;) {
      yield;
      const held = inputToPad(e.input, 'held');
      if (held & PAD_A) {
        e.hooks.fade?.(1, 'white'); // GBPalWhiteOutWithDelay3
        yield* e.delayFrames(3);
        clearScreen(e);
        yield* e.delayFrames(10);
        e.hooks.fade?.(0);
        return 'continue';
      }
      if (held & PAD_B) break;
    }
  }
}

/** DisplayContinueGameInfo: the save file's player, badges, Pokédex and time. */
function* displayContinueGameInfo(e: Engine, hasSave: boolean): Co {
  if (!hasSave) return;
  const save = yield* awaitPromise(readSave('slot1').catch(() => undefined));
  const s = save?.state ?? e.state;
  e.screen.box(4, 7, 8, 14);
  put(e, 5, 9, e.bundle.strings.SaveScreenInfoText);
  put(e, 12, 9, s.player.name);
  let badges = 0;
  for (let i = 0; i < 8; i++) if (s.badges & (1 << i)) badges++;
  put(e, 17, 11, String(badges).padStart(2, ' '));
  let owned = 0;
  for (let i = 0; i < 151; i++) if (getBit(s.pokedex.owned, i)) owned++;
  put(e, 16, 13, String(owned).padStart(3, ' '));
  const minutes = Math.floor(s.frames / 3600);
  put(e, 13, 15, String(Math.min(Math.floor(minutes / 60), 255)).padStart(3, ' '));
  e.screen.put(16, 15, 0x6d);
  put(e, 17, 15, String(minutes % 60).padStart(2, '0'));
  yield* e.delayFrames(30);
}

// ------------------------------------------------------------------ Oak's speech
/** IntroDisplayPicCenteredOrUpperRight (centred): a 7x7 pic at (6,4). */
function introPic(e: Engine, pic: Pic | undefined, flipped = false): void {
  clearScreen(e);
  if (!pic) return;
  let px = frontPixels(pic);
  if (flipped) {
    const out = new Array<number>(56 * 56);
    for (let y = 0; y < 56; y++) for (let x = 0; x < 56; x++) out[y * 56 + x] = px[y * 56 + 55 - x];
    px = out;
  }
  placePixels(e, px, 6, 4);
}

/** FadeInIntroPic: six BGP steps, ten frames each. */
function* fadeInIntroPic(e: Engine): Co {
  e.hooks.fade?.(0);
  for (const m of [
    [0, 1, 1, 1],
    [0, 2, 2, 2],
    [0, 3, 3, 3],
    [0, 2, 3, 3],
    [0, 1, 3, 3],
    [0, 1, 2, 3],
  ]) {
    e.screen.setShadeMap(m);
    yield* e.delayFrames(10);
  }
  e.screen.setShadeMap(undefined);
}

/** MovePicLeft: the screen (the window) slides in from x = 112. */
function* movePicLeft(e: Engine): Co {
  e.screen.setScroll(112, 0);
  yield;
  e.hooks.fade?.(0);
  e.screen.setShadeMap(undefined);
  for (let wx = 119; ; ) {
    yield;
    wx -= 8;
    if (wx < 0) break;
    e.screen.setScroll(wx - 7, 0);
  }
  e.screen.setScroll(0, 0);
}

/** OakSpeechSlidePicCommon: shift a 125-cell run of the tilemap one cell per step, six steps. */
function* slidePic(e: Engine, start: number, left: boolean): Co {
  const cells = e.screen.cells;
  const size = 6 * 20 + 5;
  let from = left ? start : start + size;
  for (let step = 0; step < 6; step++) {
    if (!left) {
      for (let i = 0, p = from; i < size; i++, p--) cells[p + 1] = cells[p];
    } else {
      let p = from;
      for (let i = 0; i < size; i++, p++) cells[p - 1] = cells[p];
      cells[p - 1] = BLANK; // the pic's last tile is zeroed
    }
    e.screen.markDirty();
    yield* e.delayFrames(3);
    from += left ? -1 : 1;
  }
}

/** ChoosePlayerName / ChooseRivalName */
function* chooseName(e: Engine, who: 'player' | 'rival', pic: Pic | undefined): Co {
  const names = e.bundle.misc.defaultNames[who];
  yield* slidePic(e, 4 * 20 + 5, false); // OakSpeechSlidePicRight
  // DisplayIntroNameTextBox
  e.screen.box(0, 0, 10, 9);
  put(e, 3, 0, e.bundle.strings['DisplayIntroNameTextBox.namestring']);
  put(e, 2, 2, names.menu);
  const [item] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: 3, current: 0, watchedKeys: PAD_A });
  let name: string;
  if (item === 0) {
    for (;;) {
      name = yield* namingScreen(e, who === 'player' ? 'player' : 'rival');
      if (name) break;
    }
    clearScreen(e);
    yield* e.delayFrames(3);
    introPic(e, pic);
  } else {
    name = names.names[item];
    // OakSpeechSlidePicLeft
    e.screen.fill(0, 0, 11, 12, BLANK);
    yield* e.delayFrames(10);
    yield* e.delayFrames(3);
    yield* slidePic(e, 4 * 20 + 12, true);
  }
  e.store.dispatch({ type: 'setNames', [who]: name }, { undoable: false });
  yield* e.printText(who === 'player' ? 'YourNameIsText' : 'HisNameIsText');
}

/** OakSpeech, ending with the new game state in place. */
export function* oakSpeech(e: Engine): Co {
  e.stopAllMusic();
  e.playMusic('MUSIC_ROUTES2');
  clearScreen(e);
  // PrepareOakSpeech + InitPlayerData2: a fresh state with a random trainer ID
  const options = e.state.options;
  const mods = yield* awaitPromise(e.hooks.chooseMods?.() ?? Promise.resolve(undefined));
  const state = newGameState(e.bundle, ((e.random() << 24) | (e.random() << 16) | (e.random() << 8) | e.random()) >>> 0);
  state.player.id = (e.hRandomAdd() << 8) | e.random();
  state.options = { ...options };
  if (mods) state.mods = mods;
  e.adoptState(state);
  const pics = e.bundle.pics;
  introPic(e, pics.special.ProfOakPic);
  yield* fadeInIntroPic(e);
  yield* e.printText('OakSpeechText1');
  yield* e.env.fadeToWhite();
  clearScreen(e);
  introPic(e, pics.front[c('pokemon', 'STARTER_PIKACHU')], true);
  yield* movePicLeft(e);
  yield* e.printText('OakSpeechText2');
  yield* e.env.fadeToWhite();
  clearScreen(e);
  introPic(e, pics.special.RedPicFront);
  yield* movePicLeft(e);
  yield* e.printText('IntroducePlayerText');
  yield* chooseName(e, 'player', pics.special.RedPicFront);
  yield* e.env.fadeToWhite();
  clearScreen(e);
  introPic(e, pics.special.Rival1Pic);
  yield* fadeInIntroPic(e);
  yield* e.printText('IntroduceRivalText');
  yield* chooseName(e, 'rival', pics.special.Rival1Pic);
  // .skipSpeech
  yield* e.env.fadeToWhite();
  clearScreen(e);
  introPic(e, pics.special.RedPicFront);
  yield* e.env.fadeFromWhite();
  yield* e.printText('OakSpeechText3');
  e.env.playSound('shrink');
  yield* e.delayFrames(4);
  introPic(e, pics.special.ShrinkPic1);
  yield* e.delayFrames(4);
  introPic(e, pics.special.ShrinkPic2);
  e.stopAllMusic();
  yield* e.delayFrames(20);
  e.screen.fill(6, 5, 7, 7, BLANK);
  yield* e.delayFrames(50);
  yield* e.env.fadeToWhite();
  clearScreen(e);
  e.screen.clearGlyphOverrides();
  e.store.dispatch({ type: 'face', facing: 'up' }, { undoable: false });
  yield* e.delayFrames(20);
  e.hooks.fade?.(0);
}
