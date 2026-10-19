/**
 * Elevators (engine/events/elevator.asm DisplayElevatorFloorMenu,
 * engine/overworld/elevator.asm ShakeElevator) and the <Map>StoreWarpEntriesScript
 * idiom: the elevator's two door warps lead back where the player came from
 * until a floor is chosen.
 */
import type { MapScript } from './types';
import type { ScriptEnv } from '../engine/ScriptEnv';
import type { Co } from '../engine/Engine';
import { displayListMenu } from '../ui/listMenu';
import { restoreScreen, saveScreen } from '../ui/menus';


/** <Elevator>StoreWarpEntriesScript: both door warps return to the warp used to enter. */
export function storeWarpEntries(e: ScriptEnv): void {
  for (let i = 0; i < 2; i++) e.e.world.setWarpDestination(i, e.e.ram.warpedFromWhichWarp, e.e.ram.warpedFromWhichMap);
}

/** DisplayElevatorFloorMenu with the elevator's floors and wElevatorWarpMaps (from the ROM). */
export function* displayElevatorFloorMenu(e: ScriptEnv, label: string): Co {
  const el = e.e.bundle.misc.elevators[label];
  if (!el) throw new Error(`no elevator data for ${label}`);
  e.e.ram.noTextDelay = true;
  yield* e.printText('WhichFloorText');
  e.e.ram.noTextDelay = false;
  const saved = saveScreen(e.e);
  const choice = yield* displayListMenu(e.e, {
    kind: 'special',
    entries: el.floors.map((id) => ({ id })),
    cursor: { item: 0, scroll: 0 },
  });
  restoreScreen(e.e, saved);
  if (!choice) return;
  e.e.ram.usedElevator = true;
  const w = el.warps[choice.index];
  for (let i = 0; i < 2; i++) e.e.world.setWarpDestination(i, w.warp, w.map);
}

/** ShakeElevator: 100 two-frame wobbles of the screen with the collision sound, then the PA chime. */
export function* shakeElevator(e: ScriptEnv): Co {
  yield* e.delayFrames(3);
  e.stopAllMusic();
  let d = 1;
  for (let i = 0; i < 100; i++) {
    d ^= 0xfe; // ±1 px
    e.e.ram.shakeY = (d << 24) >> 24;
    e.playSound('collision');
    yield* e.delayFrames(2);
  }
  e.e.ram.shakeY = 0;
  e.stopAllMusic();
  e.playSound('safari_zone_pa');
  yield* e.delayFrames(SAFARI_PA_FRAMES);
  e.updateSprites();
  e.playDefaultMusic();
}
/** Length of SFX_SAFARI_ZONE_PA (waited for on wChannelSoundIDs + CHAN5). */
const SAFARI_PA_FRAMES = 140;

/** A map whose script is only the elevator bookkeeping (Celadon Mart, Rocket Hideout, Silph Co). */
export function elevatorMap(map: string, label: string, text: MapScript['texts'] = {}): MapScript {
  return {
    map,
    *run(e) {
      if (e.takeMapLoaded1()) storeWarpEntries(e);
      if (e.e.ram.usedElevator) {
        e.e.ram.usedElevator = false;
        yield* shakeElevator(e);
      }
      e.e.ram.autoTextBoxControl = 0;
      e.doNotWaitForButtonPress = true;
    },
    texts: {
      *[`${label}Text`](e) {
        yield* displayElevatorFloorMenu(e, label);
      },
      ...text,
    },
  };
}

export const CeladonMartElevator = elevatorMap('CELADON_MART_ELEVATOR', 'CeladonMartElevator');
export const SilphCoElevator = elevatorMap('SILPH_CO_ELEVATOR', 'SilphCoElevator', {
  *SilphCoElevatorElevatorText(e) {
    yield* displayElevatorFloorMenu(e, 'SilphCoElevator');
  },
});
export const RocketHideoutElevator = elevatorMap('ROCKET_HIDEOUT_ELEVATOR', 'RocketHideoutElevator', {
  *RocketHideoutElevatorText(e) {
    if (!e.isItemInBag('LIFT_KEY')) return yield* e.printText('RocketHideoutElevatorText.AppearsToNeedKeyText');
    yield* displayElevatorFloorMenu(e, 'RocketHideoutElevator');
  },
});
