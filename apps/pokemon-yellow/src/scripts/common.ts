/** text_asm routines in the home bank and shared by many maps. */
import type { ScriptFn } from './types';
import { c } from '../rom/constants';

/** PickUpItemText → PickUpItem (engine/events/pick_up_item.asm) */
export const PickUpItemText: ScriptFn = function* (env) {
  const e = env.e;
  env.enableAutoTextBoxDrawing();
  const slot = e.ram.spriteIndex;
  const toggles = e.bundle.toggleableObjects;
  const t = toggles.findIndex((x) => x.map === e.world.data.id && x.object === slot);
  if (t < 0) return; // not toggleable: nothing happens
  const obj = e.sprites[slot]?.obj;
  if (!obj?.item) throw new Error(`item ball ${slot} on ${e.world.data.constName} has no item`);
  const item = e.bundle.items.find((i) => i.id === obj.item);
  e.ram.nameBuffer = item?.name ?? '?';
  try {
    e.store.dispatch({ type: 'giveItem', item: obj.item, qty: 1 }, { undoable: false });
  } catch {
    yield* env.printText('NoMoreRoomForItemText');
    return;
  }
  e.store.dispatch({ type: 'setObjectVisible', toggle: t, visible: false }, { undoable: false });
  if (e.sprites[slot]) e.sprites[slot].hidden = true;
  env.doNotWaitForButtonPress = true;
  yield* env.printText('FoundItemText');
};

/** PokecenterChanseyText (engine/events/pokecenter_chansey.asm) */
export const PokecenterChanseyText: ScriptFn = function* (env) {
  yield* env.printText('NurseChanseyText');
  yield* env.playCry('CHANSEY');
};

/** CableClubNPC with no link partner (engine/link/cable_club_npc.asm). */
export const CableClubNPC = function* (env: Parameters<ScriptFn>[0]) {
  yield* env.printText('CableClubNPCWelcomeText');
  if (!env.checkEvent('EVENT_GOT_POKEDEX')) {
    yield* env.delayFrames(60);
    yield* env.printText('CableClubNPCMakingPreparationsText');
    return true;
  }
  // 90 attempts to establish a connection, one per frame; no partner ever answers.
  yield* env.delayFrames(90);
  yield* env.printText('CableClubNPCAreaReservedFor2FriendsLinkedByCableText');
  return true;
};

export const commonTexts: Record<string, ScriptFn> = { PickUpItemText };
export const commonPatterns: [RegExp, ScriptFn][] = [[/Pok[eé]?[Cc]enterChanseyText$|ChanseyText$/, PokecenterChanseyText]];
void c;
