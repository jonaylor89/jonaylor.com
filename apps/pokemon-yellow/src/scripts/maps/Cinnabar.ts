/**
 * Cinnabar Island (scripts/CinnabarIsland.asm) and the Cinnabar Lab fossil
 * scientist (scripts/CinnabarLabFossilRoom.asm, engine/events/cinnabar_lab.asm).
 */
import type { Co } from '../../engine/Engine';
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_A, PAD_B, PAD_DOWN, PLAYER_DIR_UP } from '../../engine/pad';
import { c } from '../../rom/constants';
import { ramSym } from '../../rom/symbols';
import { handleMenuInput } from '../../ui/menus';
import { placeString } from '../../ui/mart';

const FOSSILS: [string, string][] = [
  ['DOME_FOSSIL', 'KABUTO'],
  ['HELIX_FOSSIL', 'OMANYTE'],
  ['OLD_AMBER', 'AERODACTYL'],
];

/**
 * LoadFossilItemAndMonName: the mon's name in wStringBuffer, the item's in
 * wNameBuffer, while `body` prints texts that show them.
 */
function* withFossilNames(env: ScriptEnv, body: () => Co): Co {
  const e = env.e;
  const item = e.state.vars.wFossilItem ?? 0;
  const mon = e.state.vars.wFossilMon ?? 0;
  const stringBuffer = ramSym('wStringBuffer');
  e.ram.nameBuffer = e.bundle.items.find((i) => i.id === item)?.name ?? '';
  e.ram.mem.set(stringBuffer, e.bundle.species[mon]?.name ?? '');
  try {
    yield* body();
  } finally {
    e.ram.mem.delete(stringBuffer);
  }
}

/** GiveFossilToCinnabarLab */
function* giveFossilToCinnabarLab(env: ScriptEnv, fossils: number[]): Co {
  const e = env.e;
  const T = (n: string) => `GiveFossilToCinnabarLab.${n}`;
  e.ram.noTextDelay = true;
  e.screen.box(0, 0, fossils.length * 2 + 1, 13);
  env.updateSprites();
  fossils.forEach((id, i) => placeString(e, 2, 2 + i * 2, e.bundle.items.find((it) => it.id === id)?.name ?? '?'));
  e.ram.noTextDelay = false;
  const [choice, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: fossils.length - 1, current: 0, watchedKeys: PAD_A | PAD_B });
  if (key & PAD_B) return yield* env.printText(T('ComeAgainText'));
  const item = fossils[choice];
  const mon = FOSSILS.find(([f]) => c('item', f) === item)![1];
  env.setVar('wFossilItem', item);
  env.setVar('wFossilMon', c('pokemon', mon));
  let refused = false;
  yield* withFossilNames(env, function* () {
    yield* env.printText(T('ScientistSeesFossilText'));
    if (!(yield* env.yesNoChoice())) {
      refused = true;
      return;
    }
    yield* env.printText(T('ScientistTakesFossilText'));
  });
  if (refused) return yield* env.printText(T('ComeAgainText'));
  e.store.dispatch({ type: 'takeItem', item, qty: 1 }, { undoable: false });
  yield* env.printText(T('GoForAWalkText'));
  env.setEvent('EVENT_GAVE_FOSSIL_TO_LAB');
  env.setEvent('EVENT_LAB_STILL_REVIVING_FOSSIL');
}

export function* cinnabarLabFossilScientist(env: ScriptEnv): Co {
  const T = (n: string) => `CinnabarLabFossilRoomScientist1Text.${n}`;
  if (!env.checkEvent('EVENT_GAVE_FOSSIL_TO_LAB')) {
    yield* env.printText(T('Text'));
    // Lab4Script_GetFossilsInBag
    const fossils = FOSSILS.map(([f]) => c('item', f)).filter((id) => env.e.state.bag.some((s) => s.item === id));
    if (!fossils.length) return yield* env.printText(T('NoFossilsText'));
    return yield* giveFossilToCinnabarLab(env, fossils);
  }
  if (env.checkEvent('EVENT_LAB_STILL_REVIVING_FOSSIL')) return yield* env.printText(T('GoForAWalkText'));
  yield* withFossilNames(env, () => env.printText(T('FossilIsBackToLifeText')));
  env.setEvent('EVENT_LAB_HANDING_OVER_FOSSIL_MON');
  if (!(yield* env.givePokemon(env.e.state.vars.wFossilMon ?? 0, 30))) return;
  for (const ev of ['EVENT_GAVE_FOSSIL_TO_LAB', 'EVENT_LAB_STILL_REVIVING_FOSSIL', 'EVENT_LAB_HANDING_OVER_FOSSIL_MON']) env.resetEvent(ev);
}

const S = (n: string) => c('map_script', `SCRIPT_CINNABARISLAND_${n}`);

const islandScripts: ScriptFn[] = [
  // CinnabarIslandDefaultScript: the gym door stays shut without the SECRET KEY
  function* (e) {
    if (e.isItemInBag('SECRET_KEY')) return;
    if (e.y !== 4 || e.x !== 18) return;
    e.e.ram.playerMovingDirection = PLAYER_DIR_UP;
    yield* e.displayTextID('TEXT_CINNABARISLAND_DOOR_IS_LOCKED');
    e.joyHeld = 0;
    e.setSimulatedJoypad([PAD_DOWN], 1);
    e.startSimulatingJoypadStates();
    e.setPlayerFacing('down');
    e.joyIgnore = 0;
    e.curScript = S('PLAYER_MOVING');
  },
  // CinnabarIslandPlayerMovingScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delayFrames(3);
    e.curScript = S('DEFAULT');
  },
];

export const CinnabarIsland: MapScript = {
  map: 'CINNABAR_ISLAND',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    e.e.ram.curMapLoaded1 = true;
    e.resetEvent('EVENT_MANSION_SWITCH_ON');
    e.resetEvent('EVENT_LAB_STILL_REVIVING_FOSSIL');
    const fn = islandScripts[e.curScript];
    if (!fn) throw new Error(`CINNABAR_ISLAND script ${e.curScript}`);
    yield* fn(e);
  },
};
