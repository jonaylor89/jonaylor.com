/**
 * Pikachu's Beach house (scripts/SummerBeachHouse.asm, SummerBeachHouse_2.asm):
 * the surfin' dude starts the Surfing Pikachu minigame for a Pikachu that knows
 * SURF; the printer shows (and prints) the high score.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { isSurfingPikachuInParty } from '../../game/pikachu';
import { drawSurfingHighScore, PAUSE_IGT, SURF_SELECT, surfingPikachuMinigame } from '../../minigame/surfing';
import { printerJob } from '../../ui/printer';
import { restoreScreen, saveScreen } from '../../ui/menus';

const FLAGS = 'wPikachuMapScriptFlags';

const surfinDude: ScriptFn = function* (e: ScriptEnv) {
  const T = (n: string) => `SummerBeachHouseSurfinDudeText.${n}`;
  if (!isSurfingPikachuInParty(e.e.state)) return yield* e.printText(T('SurfinDudeText4'));
  const flags = e.getVar(FLAGS);
  e.setVar(FLAGS, flags | PAUSE_IGT);
  yield* e.printText(T(flags & PAUSE_IGT ? 'SurfinDudeText3' : 'SurfinDudeText1'));
  if (!(yield* e.yesNoChoice())) return yield* e.printText(T('SurfinDudeText2'));
  e.doNotWaitForButtonPress = true;
  yield* surfingPikachuMinigame(e.e);
  e.setVar(FLAGS, e.getVar(FLAGS) | SURF_SELECT);
};

const printer: ScriptFn = function* (e: ScriptEnv) {
  const T = (n: string) => `SummerBeachHousePrinterText.${n}`;
  e.doNotWaitForButtonPress = true;
  if (!isSurfingPikachuInParty(e.e.state)) return yield* e.printText(T('SummerBeachHousePrinterText1'));
  if (e.getVar(FLAGS) & SURF_SELECT) e.doNotWaitForButtonPress = false;
  yield* e.printText(T('SummerBeachHousePrinterText2'));
  if (!(e.getVar(FLAGS) & SURF_SELECT)) return;
  e.doNotWaitForButtonPress = true;
  yield* e.printText(T('SummerBeachHousePrinterText3'));
  const print = yield* e.yesNoChoice();
  const saved = saveScreen(e.e);
  e.e.ram.noTextDelay = true;
  drawSurfingHighScore(e.e);
  let canceled = false;
  if (print) canceled = yield* printerJob(e.e); // PrintSurfingMinigameHighScore
  else yield* e.e.waitForTextScrollButtonPress();
  e.e.ram.noTextDelay = false;
  e.e.screen.clearGlyphOverrides();
  e.e.hooks.palette?.(undefined);
  restoreScreen(e.e, saved);
  if (print) yield* e.printText(canceled ? 'Text_f2412' : 'Text_f240c');
};

export const SummerBeachHouse: MapScript = {
  map: 'SUMMER_BEACH_HOUSE',
  *run(e) {
    e.enableAutoTextBoxDrawing();
  },
  texts: {
    SummerBeachHouseSurfinDudeText: surfinDude,
    SummerBeachHousePrinterText: printer,
  },
};
