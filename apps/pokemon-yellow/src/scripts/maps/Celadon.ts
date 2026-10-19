/**
 * Celadon Mansion (scripts/CeladonMansion1F.asm + CeladonMansion1F_2.asm,
 * CeladonMansion3F.asm, CeladonMansionRoofHouse.asm) and the Route 11 gate's
 * left binoculars (scripts/Route11Gate2F.asm).
 */
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { MapScript } from '../types';
import { isStarterPikachuAliveInParty } from '../../game/pikachu';
import { playPikachuCry, pikachuCry } from '../../engine/pikachuEmotions';
import { displayDiploma, printDiploma } from '../../ui/diploma';
import { handleMenuInput, restoreScreen, saveScreen } from '../../ui/menus';
import { placeString } from '../../ui/mart';
import { PAD_A, PAD_B } from '../../engine/pad';
import { c } from '../../rom/constants';

/** PikachuHappinessThresholds_f1eb9: the first entry whose threshold is above the happiness. */
const GRANNY_THRESHOLDS: [number, string][] = [
  [51, 'CeladonMansion1Text_f1ed5'],
  [101, 'CeladonMansion1Text_f1eda'],
  [131, 'CeladonMansion1Text_f1edf'],
  [161, 'CeladonMansion1Text_f1ee4'],
  [201, 'CeladonMansion1Text_f1ee9'],
  [255, 'CeladonMansion1Text_f1eee'],
];

export function* celadonMansion1FGranny(e: ScriptEnv) {
  const happiness = e.e.state.pikachu.happiness;
  // CeladonMansion1FPrintGrannyText
  e.doNotWaitForButtonPress = true;
  yield* e.printText('CeladonMansion1Text_f1e96');
  if (isStarterPikachuAliveInParty(e.e.state)) {
    yield* e.printText('CeladonMansionText_f1e9c');
    e.doNotWaitForButtonPress = false;
    // the -256 terminator's low byte is 0, which ends the search on the last text
    const text = GRANNY_THRESHOLDS.find(([t]) => happiness < t)?.[1] ?? 'CeladonMansion1Text_f1eee';
    yield* e.printText(text);
  }
  if (happiness >= 251) {
    yield* e.delayFrames(50);
    yield* playPikachuCry(e.e, pikachuCry(23));
  }
}

/** NUM_POKEMON - 1: every Pokémon but Mew */
const dexComplete = (e: ScriptEnv) => e.pokedexOwnedCount() >= 150;

export function* celadonMansion3FProgrammer(e: ScriptEnv) {
  yield* e.printText(dexComplete(e) ? 'CeladonMansion3Text_486f5' : 'CeladonMansion3Text_486f0');
}

export function* celadonMansion3FWriter(e: ScriptEnv) {
  yield* e.printText(dexComplete(e) ? 'CeladonMansion3FWriterText.Text2' : 'CeladonMansion3FWriterText.Text1');
}

export function* celadonMansion3FGraphicArtist(e: ScriptEnv) {
  const T = (n: string) => `CeladonMansion3FGraphicArtistText.${n}`;
  if (!dexComplete(e)) return yield* e.printText(T('Text1'));
  yield* e.printText(T('Text2'));
  if (!(yield* e.yesNoChoice())) return yield* e.printText(T('Text3'));
  const saved = saveScreen(e.e);
  e.e.ram.noTextDelay = true;
  const canceled = yield* printDiploma(e.e);
  e.e.ram.noTextDelay = false;
  restoreScreen(e.e, saved);
  yield* e.printText(T(canceled ? 'Text5' : 'Text4'));
}

export function* celadonMansion3FGameDesigner(e: ScriptEnv) {
  const T = (n: string) => `CeladonMansion3FGameDesignerText.${n}`;
  if (!dexComplete(e)) return yield* e.printText(T('Text'));
  yield* e.printText(T('CompletedDexText'));
  yield* e.delayFrames(3);
  e.doNotWaitForButtonPress = false;
  yield* e.printText(T('UnlockedDiplomaPrinting'));
}

/** The text_asm in CompletedDexText: the diploma, then no wait for a button. */
export function* celadonMansion3FCompletedDexAsm(e: ScriptEnv) {
  yield* displayDiploma(e.e);
  e.doNotWaitForButtonPress = true;
}

/** CeladonMartRoofLittleGirlText: a drink for a TM (TM13, TM48, TM49) */
export function* celadonMartRoofLittleGirl(e: ScriptEnv) {
  const b = e.e.bundle;
  // CeladonMartRoofScript_GetDrinksInBag
  const drinks = b.misc.roofDrinks.filter((d) => e.e.state.bag.some((s) => s.item === d));
  if (!drinks.length) return yield* e.printText('CeladonMartRoofLittleGirlText.ImThirstyText');
  e.doNotWaitForButtonPress = true;
  yield* e.printText('CeladonMartRoofLittleGirlText.GiveHerADrinkText');
  if (!(yield* e.yesNoChoice())) return;
  // CeladonMartRoofScript_GiveDrinkToGirl
  e.e.ram.noTextDelay = true;
  yield* e.printText('CeladonMartRoofLittleGirlGiveHerWhichDrinkText');
  e.e.screen.box(0, 0, drinks.length * 2 + 1, 12);
  e.updateSprites();
  drinks.forEach((d, i) => placeString(e.e, 2, 2 + i * 2, b.items.find((it) => it.id === d)?.name ?? '?'));
  e.e.ram.noTextDelay = false;
  const [choice, key] = yield* handleMenuInput(e.e, { topX: 1, topY: 2, maxItem: drinks.length - 1, current: 0, watchedKeys: PAD_A | PAD_B });
  if (key & PAD_B) return;
  const drink = drinks[choice];
  const reward = ([
    ['FRESH_WATER', 'EVENT_GOT_TM13', 'TM_ICE_BEAM', 'FreshWater', 'TM13'],
    ['SODA_POP', 'EVENT_GOT_TM48', 'TM_ROCK_SLIDE', 'SodaPop', 'TM48'],
    ['LEMONADE', 'EVENT_GOT_TM49', 'TM_TRI_ATTACK', 'Lemonade', 'TM49'],
  ] as const).find(([item]) => c('item', item) === drink)!;
  const [, event, tm, yay, tmName] = reward;
  if (e.checkEvent(event)) return yield* e.printText('CeladonMartRoofLittleGirlImNotThirstyText');
  yield* e.printText(`CeladonMartRoofLittleGirlYay${yay}Text`);
  e.e.store.dispatch({ type: 'takeItem', item: drink, qty: 1 }, { undoable: false });
  if (!e.giveItem(tm)) return yield* e.printText('CeladonMartRoofLittleGirlNoRoomText');
  yield* e.printText(`CeladonMartRoofLittleGirlReceived${tmName}Text`);
  e.setEvent(event);
}

export function* celadonMansionRoofHouseEevee(e: ScriptEnv) {
  if (yield* e.givePokemon('EEVEE', 25)) e.hideObject('TOGGLE_CELADON_MANSION_EEVEE_GIFT');
}

export function* route11Gate2FLeftBinoculars(e: ScriptEnv) {
  // GateUpstairsScript_PrintIfFacingUp: only when looking out of the window
  if (e.playerFacing !== 'up') {
    e.doNotWaitForButtonPress = true;
    return;
  }
  const T = (n: string) => `Route11Gate2FLeftBinocularsText.${n}`;
  yield* e.printText(T(e.checkEvent('EVENT_BEAT_ROUTE12_SNORLAX') ? 'NoSnorlaxText' : 'SnorlaxText'));
}

/** CeladonCity_Script: CeladonCityScript1 resets EVENT_1B8, EVENT_1BF and EVENT_67F every frame. */
export const CeladonCity: MapScript = {
  map: 'CELADON_CITY',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    for (const ev of ['EVENT_1B8', 'EVENT_1BF', 'EVENT_67F']) if (e.checkEvent(ev)) e.resetEvent(ev);
  },
};
