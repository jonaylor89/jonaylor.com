/**
 * The Day Care on Route 5 (scripts/Daycare.asm): one Pokémon is left with the
 * gentleman, gains 1 exp per step (src/engine/poison.ts) and is returned for
 * ¥100 per level grown plus ¥100, learning its new moves without prompts.
 */
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { PartyMon } from '../../game/state';
import { c } from '../../rom/constants';
import { ramSym } from '../../rom/symbols';
import { calcExperience, calcStats, movePP, species } from '../../game/pokemon';
import { calcLevelFromExperience } from '../../battle/experience';
import { isStarterPikachu } from '../../game/pikachu';
import { partyMenu } from '../../ui/partyMenu';
import { restoreScreen, saveScreen } from '../../ui/menus';
import { displayMoneyBox } from '../../ui/mart';
import { playPikachuCry, pikachuCry } from '../../engine/pikachuEmotions';

const T = (n: string) => `DaycareGentlemanText.${n}`;
const HM_MOVES = ['CUT', 'FLY', 'SURF', 'STRENGTH', 'FLASH'];

/** KnowsHMMove */
function knowsHMMove(m: PartyMon): boolean {
  return m.moves.some((mv) => HM_MOVES.some((n) => c('move', n) === mv));
}

/**
 * WriteMonMoves with wLearningMovesFromDayCare: the learnset moves above
 * `startLevel` up to the mon's level, shifting out the first move (and its PP)
 * when all four slots are full; new moves get their base PP.
 */
export function learnDayCareMoves(m: PartyMon, learnset: { level: number; move: number }[], startLevel: number, pp: (move: number) => number): void {
  for (const { level, move } of learnset) {
    if (m.level < level) break;
    if (startLevel >= level) continue;
    if (m.moves.includes(move)) continue;
    let slot = m.moves.indexOf(0);
    if (slot < 0) {
      m.moves.copyWithin(0, 1);
      m.pp.copyWithin(0, 1);
      slot = 3;
    }
    m.moves[slot] = move;
    m.pp[slot] = pp(move);
  }
}

export function* daycareGentleman(env: ScriptEnv) {
  const e = env.e;
  const party = e.state.party;
  const day = e.state.daycare;
  if (!day) {
    yield* env.printText(T('IntroText'));
    if (!(yield* env.yesNoChoice())) return yield* env.printText(T('ComeAgainText'));
    if (party.length === 1) return yield* env.printText(T('OnlyHaveOneMonText'));
    yield* env.printText(T('WhichMonText'));
    const buffer = saveScreen(e);
    const chosen = yield* partyMenu(e, { party: structuredClone(party), mode: 'normal' });
    e.screen.clearGlyphOverrides();
    restoreScreen(e, buffer);
    if (chosen === undefined) return yield* env.printText(T('AllRightThenText'));
    const mon = structuredClone(party[chosen]);
    if (knowsHMMove(mon)) return yield* env.printText(T('CantAcceptMonWithHMText'));
    e.ram.nameBuffer = mon.nickname;
    yield* env.printText(T('WillLookAfterMonText'));
    // MoveMon PARTY_TO_DAYCARE, then RemovePokemon
    const pikachu = isStarterPikachu(e.state, mon);
    mon.boxLevel = mon.level;
    e.store.dispatch({ type: 'setDaycare', mon }, { undoable: false });
    e.store.dispatch({ type: 'setParty', party: party.filter((_, i) => i !== chosen) }, { undoable: false });
    if (pikachu) yield* playPikachuCry(e, pikachuCry(28));
    else yield* env.playCry(e.bundle.species[mon.species]?.constName ?? String(mon.species));
    return yield* env.printText(T('ComeSeeMeInAWhileText'));
  }

  // .daycareInUse
  e.ram.nameBuffer = day.nickname;
  e.ram.mem.set(ramSym('wDayCareMonName'), day.nickname);
  const sp = species(e.bundle, day.species);
  const MAX_LEVEL = c('battle', 'MAX_LEVEL');
  let level = calcLevelFromExperience(e.bundle, sp.growthRate, day.exp);
  const mon = structuredClone(day);
  if (level >= MAX_LEVEL) {
    level = MAX_LEVEL;
    mon.exp = calcExperience(e.bundle, sp.growthRate, MAX_LEVEL);
  }
  const startLevel = mon.boxLevel;
  const grown = level === startLevel ? 0 : (level - startLevel) & 0xff;
  // the box level reads the new level only while the gentleman talks; leaving the mon restores it
  const leave = function* (text: string) {
    e.store.dispatch({ type: 'setDaycare', mon: { ...mon, boxLevel: startLevel } }, { undoable: false });
    yield* env.printText(T(text));
  };
  e.ram.mem.set(ramSym('wDayCareNumLevelsGrown'), grown);
  yield* env.printText(T(grown ? 'MonHasGrownText' : 'MonNeedsMoreTimeText'));
  if (party.length >= 6) return yield* leave('NoRoomForMonText');
  const cost = 100 * (grown + 1);
  e.ram.mem.set(ramSym('wDayCareTotalCost'), cost);
  yield* env.printText(T('OweMoneyText'));
  displayMoneyBox(e);
  if (!(yield* env.yesNoChoice())) return yield* leave('AllRightThenText');
  if (e.state.money < cost) return yield* leave('NotEnoughMoneyText');
  e.store.dispatch({ type: 'addMoney', amount: -cost }, { undoable: false });
  env.playSound('purchase');
  displayMoneyBox(e);
  yield* env.printText(T('HeresYourMonText'));
  // MoveMon DAYCARE_TO_PARTY: level from exp, stats with stat exp; then the new moves and full HP
  mon.level = level;
  mon.boxLevel = level;
  Object.assign(mon, calcStats(sp, mon.dvs, mon.statExp, level, true));
  learnDayCareMoves(mon, sp.learnset, startLevel, (mv) => movePP(e.bundle, mv));
  mon.hp = mon.maxHp;
  e.store.dispatch({ type: 'setDaycare', mon: undefined }, { undoable: false });
  e.store.dispatch({ type: 'setParty', party: [...party, mon] }, { undoable: false });
  if (isStarterPikachu(e.state, mon)) {
    e.pikachu.spawnState = 6;
    yield* playPikachuCry(e, pikachuCry(35));
  } else yield* env.playCry(sp.constName);
  yield* env.printText(T('GotMonBackText'));
}
