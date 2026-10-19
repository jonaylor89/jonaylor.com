/**
 * The pieces every gym script shares: LoadGymLeaderAndCityName, the leader's
 * text_asm (challenge → EngageMapTrainer/InitBattleEnemyParameters, then the
 * TM and badge after the battle) and the post-battle script.
 */
import type { ScriptFn } from './types';
import type { ScriptEnv } from '../engine/ScriptEnv';
import type { Co } from '../engine/Engine';
import { PAD_CTRL_PAD } from '../engine/pad';
import { c } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { engageMapTrainer, initBattleEnemyParameters } from '../engine/trainers';

export interface GymLeader {
  /** Gym map label prefix, e.g. 'PewterGym' (for <Gym>_Script.CityName/LeaderName). */
  gym: string;
  /** wGymLeaderNo */
  number: number;
  /** EVENT_BEAT_BROCK ... */
  beatEvent: string;
  /** EVENT_GOT_TM34 ... */
  tmEvent: string;
  /** TM_BIDE ... */
  tm: string;
  badgeBit: string;
  /** TEXT_* ids: "wait, take this", "received TM", "no room for the TM" */
  waitText: string;
  receivedTmText: string;
  noRoomText: string;
  /** Labels of the leader's own texts. */
  preBattleText: string;
  postBattleText: string;
  /** End-of-battle text (win and loss use the same one). */
  badgeText: string;
  /** Map script index of <Gym><Leader>PostBattle. */
  postBattleScript: number;
  /** What the rest of the script does on victory (toggles, events, gym trainers). */
  onVictory: (e: ScriptEnv) => void;
}

/** LoadGymLeaderAndCityName on BIT_CUR_MAP_LOADED_2 (_1 in Vermilion Gym), for the gym statue texts. */
export function loadGymNames(e: ScriptEnv, gym: string, flag: 1 | 2 = 2, label = `${gym}_Script`): void {
  if (!(flag === 2 ? e.takeMapLoaded2() : e.takeMapLoaded1())) return;
  const s = e.e.bundle.strings;
  e.e.ram.mem.set(ramSym('wGymCityName'), s[`${label}.CityName`]);
  e.e.ram.mem.set(ramSym('wGymLeaderName'), s[`${label}.LeaderName`]);
}

/** <Gym>ScriptReceiveTM: thank-you text, the TM (if there is room), the badge. */
export function* receiveTM(e: ScriptEnv, g: GymLeader): Co {
  yield* e.displayTextID(g.waitText);
  e.setEvent(g.beatEvent);
  if (e.giveItem(g.tm)) {
    yield* e.displayTextID(g.receivedTmText);
    e.setEvent(g.tmEvent);
  } else yield* e.displayTextID(g.noRoomText);
  // .gymVictory
  const bit = c('ram', g.badgeBit);
  e.e.store.dispatch({ type: 'setBadge', badge: bit, value: true }, { undoable: false });
  e.setVar('wBeatGymFlags', e.getVar('wBeatGymFlags') | (1 << bit));
  g.onVictory(e);
  resetGymScripts(e);
}

/** SetEventRange: every event flag from `first` to `last`. */
export function setEventRange(e: ScriptEnv, first: string, last: string): void {
  for (let f = c('event', first); f <= c('event', last); f++) e.e.store.dispatch({ type: 'setEvent', flag: f, value: true }, { undoable: false });
}

/** ResetEventRange: clear every event flag from `first` to `last`. */
export function resetEventRange(e: ScriptEnv, first: string | number, last: string | number): void {
  const a = typeof first === 'number' ? first : c('event', first);
  const b = typeof last === 'number' ? last : c('event', last);
  for (let f = a; f <= b; f++) e.e.store.dispatch({ type: 'setEvent', flag: f, value: false }, { undoable: false });
}

/** <Gym>ResetScripts */
export function resetGymScripts(e: ScriptEnv): void {
  e.joyIgnore = 0;
  e.curScript = 0;
}

/** <Gym><Leader>PostBattle */
export function gymLeaderPostBattle(g: GymLeader): ScriptFn {
  return function* (e) {
    if (e.ram.isInBattle === 0xff) {
      resetGymScripts(e);
      return;
    }
    e.joyIgnore = PAD_CTRL_PAD;
    yield* receiveTM(e, g);
  };
}

/** <Gym><Leader>Text */
export function gymLeaderText(g: GymLeader): ScriptFn {
  return function* (e) {
    if (e.checkEvent(g.beatEvent)) {
      if (!e.checkEvent(g.tmEvent)) {
        yield* receiveTM(e, g);
        e.doNotWaitForButtonPress = true; // DisableWaitingAfterTextDisplay
        return;
      }
      yield* e.printText(g.postBattleText);
      return;
    }
    yield* e.printText(g.preBattleText);
    const r = e.ram;
    r.talkedToTrainer = true;
    r.printEndBattleText = true;
    r.endBattleWinText = g.badgeText;
    r.endBattleLoseText = g.badgeText;
    // EngageMapTrainer runs PlayTrainerMusic before wGymLeaderNo is set
    engageMapTrainer(e, e.spriteIndex);
    initBattleEnemyParameters(e);
    r.gymLeaderNo = g.number;
    e.joyHeld = 0;
    e.curScript = g.postBattleScript;
  };
}
