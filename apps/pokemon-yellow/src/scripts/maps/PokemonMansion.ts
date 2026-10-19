/**
 * Pokémon Mansion: scripts/PokemonMansion1F.asm, 2F, 3F and B1F. One switch event
 * (EVENT_MANSION_SWITCH_ON) swaps which gates are open on every floor; 3F has holes.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { HiddenEventFn } from '../../engine/hiddenEvents';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle } from '../../engine/trainers';
import { isPlayerOnDungeonWarp } from '../../field/warpAnims';
import { c } from '../../rom/constants';

const FLOOR = 0x0e;
const H_GATE = 0x2d;
const V_GATE = 0x5f;
const WALL = 0x54;

/** [x, y, block when off, block when on] (the lb bc, y, x pairs of <Map>CheckReplaceSwitchDoorBlocks) */
type Gate = [number, number, number, number];

function mansionFloor(map: string, label: string, gates: Gate[], defaultScript: ScriptFn = checkFightingMapTrainers, switchText = 'PokemonMansion2FSwitchText'): MapScript {
  const scripts = [defaultScript, displayEnemyTrainerTextAndStartBattle, endTrainerBattle];
  return {
    map,
    *run(e) {
      if (e.takeMapLoaded1()) {
        const on = e.checkEvent('EVENT_MANSION_SWITCH_ON');
        for (const [x, y, off, onBlock] of gates) e.e.world.replaceBlock(x, y, on ? onBlock : off);
      }
      e.enableAutoTextBoxDrawing();
      yield* scripts[e.curScript](e);
    },
    texts: { [switchText]: mansionSwitchText(label) },
  };
}

/** PokemonMansion<n>FSwitchText: press the secret switch to toggle every gate. */
const mansionSwitchText = (label: string): ScriptFn =>
  function* (e) {
    const T = (n: string) => `${label}.${n}`;
    yield* e.printText(T('Text'));
    if (!(yield* e.yesNoChoice())) return yield* e.printText(T(label.startsWith('PokemonMansion1F') ? 'NotPressedText' : 'NotPressed'));
    e.doNotWaitForButtonPress = true;
    e.e.ram.curMapLoaded1 = true;
    yield* e.printText(T('PressedText'));
    e.playSound('go_inside');
    if (e.checkEvent('EVENT_MANSION_SWITCH_ON')) e.resetEvent('EVENT_MANSION_SWITCH_ON');
    else e.setEvent('EVENT_MANSION_SWITCH_ON');
  };

/** Mansion<n>Script_Switches: the hidden switch, only when facing up. */
export const mansionSwitches =
  (textId: string): HiddenEventFn =>
  function* (e) {
    if (e.state.player.facing !== 'up') return;
    e.env.joyHeld = 0;
    yield* e.env.displayTextID(textId);
  };

export const PokemonMansion1F = mansionFloor(
  'POKEMON_MANSION_1F',
  'PokemonMansion1FSwitchText',
  [
    [12, 6, FLOOR, H_GATE],
    [8, 3, H_GATE, FLOOR],
    [10, 8, H_GATE, FLOOR],
    [13, 13, H_GATE, FLOOR],
  ],
  checkFightingMapTrainers,
  'PokemonMansion1FSwitchText',
);

export const PokemonMansion2F = mansionFloor('POKEMON_MANSION_2F', 'PokemonMansion2FSwitchText', [
  [4, 2, FLOOR, V_GATE],
  [9, 4, WALL, FLOOR],
  [3, 11, V_GATE, FLOOR],
]);

/** PokemonMansion3FDefaultScript: the holes drop to 1F (or 2F for the third). */
const mansion3FDefault: ScriptFn = function* (e: ScriptEnv) {
  isPlayerOnDungeonWarp(e.e, [
    [14, 16],
    [14, 17],
    [14, 19],
  ]);
  const which = e.e.ram.whichDungeonWarp;
  if (!which) return yield* checkFightingMapTrainers(e);
  e.e.ram.dungeonWarpDestinationMap = c('map', which === 3 ? 'POKEMON_MANSION_2F' : 'POKEMON_MANSION_1F');
};

export const PokemonMansion3F = mansionFloor(
  'POKEMON_MANSION_3F',
  'PokemonMansion2FSwitchText',
  [
    [7, 2, FLOOR, V_GATE],
    [7, 5, V_GATE, FLOOR],
  ],
  mansion3FDefault,
);

export const PokemonMansionB1F = mansionFloor('POKEMON_MANSION_B1F', 'PokemonMansion2FSwitchText', [
  [13, 8, FLOOR, H_GATE],
  [6, 11, FLOOR, V_GATE],
  [4, 3, V_GATE, FLOOR],
  [8, 8, WALL, FLOOR],
]);
