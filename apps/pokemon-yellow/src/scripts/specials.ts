/** TX_SCRIPT_* text scripts (home/text_script.asm). */
import { celadonPrizeMenu } from '../ui/prizes';
import type { SpecialTextScript } from './types';
import { twoOptionMenu, saveScreen, restoreScreen } from '../ui/menus';
import { c } from '../rom/constants';
import { CableClubNPC } from './common';
import type { ScriptEnv } from '../engine/ScriptEnv';
import { PIKA_NOT_FOLLOWING } from '../engine/pikachu';
import { FACING_DOWN } from '../engine/sprites';
import { isStarterPikachuAliveInParty } from '../game/pikachu';
import { pokemart, vendingMachine } from '../ui/mart';
import { activatePC, billsPCDirect, playerPCDirect } from '../ui/pc';

const SAFARI_REST_HOUSES = ['SAFARI_ZONE_EAST_REST_HOUSE', 'SAFARI_ZONE_NORTH_REST_HOUSE', 'SAFARI_ZONE_WEST_REST_HOUSE'];

/** PikachuWalksToNurseJoy: from beside or below the player up onto the counter. */
function pikachuToNurseData(e: ScriptEnv['e']): number[] | undefined {
  const pk = e.pikachu;
  const p = e.state.player;
  if (pk.mapY !== p.y) return pk.mapY > p.y ? [0x00, 0x36, 0x2b, 0x34, 0x3f] : undefined;
  return pk.mapX > p.x ? [0x00, 0x36, 0x33, 0x3f] : [0x00, 0x36, 0x34, 0x3f];
}

/** DisplayPokemonCenterDialogue_ (engine/events/pokecenter.asm). */
const pokecenterNurse: SpecialTextScript = function* (env) {
  const e = env.e;
  const following = () => !(e.ram.pikachuOverworldStateFlags & PIKA_NOT_FOLLOWING);
  if (e.world.data.id === c('map', 'PEWTER_POKECENTER') && !following()) {
    // Pikachu fell asleep to Jigglypuff's song: no healing
    yield* env.printText('LooksContentText');
    return true;
  }
  const saved = saveScreen(e);
  yield* env.printText('PokemonCenterWelcomeText');
  const used = env.getVar('flag:USED_POKECENTER');
  env.setVar('flag:USED_POKECENTER', 1);
  if (!used) yield* env.printText('ShallWeHealYourPokemonText');
  const choice = yield* twoOptionMenu(e, 'HEAL_CANCEL_MENU', 11, 6);
  env.updateSprites();
  if (choice !== 0) {
    restoreScreen(e, saved);
    yield* env.printText('PokemonCenterFarewellText');
    env.updateSprites();
    return true;
  }
  // SetLastBlackoutMap (Safari Zone rest houses don't count)
  if (!SAFARI_REST_HOUSES.some((m) => c('map', m) === e.world.data.id)) env.setVar('wLastBlackoutMap', e.state.player.lastMap);
  const pikachu = isStarterPikachuAliveInParty(e.state);
  if (pikachu && following()) {
    env.updateSprites();
    const data = pikachuToNurseData(e);
    if (data) yield* e.pikachu.applyMovementData(data);
  }
  yield* env.printText('NeedYourPokemonText');
  yield* env.delayFrames(64);
  if (following()) {
    e.setPikachuDrawing(false);
    if (pikachu) {
      // Func_6eaa: the nurse takes Pikachu
      env.setSpriteFacing(1, 'up');
      yield* env.delayFrames(64);
    }
  }
  yield* env.setSpriteFacingDirectionAndDelay(1, 'left'); // nurse turns to the machine
  yield* env.delayFrames(30);
  // AnimateHealingMachine: one ball per party member, then the healing jingle.
  yield* env.delayFrames(e.state.party.length * 8 + 32);
  env.healParty();
  env.playMusic('MUSIC_PKMN_HEALED');
  yield* env.delayFrames(150);
  env.playDefaultMusic();
  if (following()) {
    if (pikachu) {
      env.setSpriteFacing(1, 'up');
      yield* env.delayFrames(64);
    }
    e.pikachu.spawnState = 5;
    e.setPikachuDrawing(true);
  }
  yield* env.setSpriteFacingDirectionAndDelay(1, 'down');
  yield* env.printText('PokemonFightingFitText');
  if (pikachu) {
    e.pikachu.facing = FACING_DOWN;
    e.pikachu.renderDir = FACING_DOWN;
    e.pikachu.sync();
    yield* env.delayFrames(6);
  }
  env.updateSprites();
  // the nurse bows (sprite image index 1)
  const nurse = env.sprite(1);
  nurse.animFrame = 1;
  yield* env.delayFrames(40);
  nurse.animFrame = 0;
  env.updateSprites();
  yield* env.printText('PokemonCenterFarewellText');
  env.updateSprites();
  return true;
};

export const specials: Partial<Record<string, SpecialTextScript>> = {
  pokecenter_nurse: pokecenterNurse,
  cable_club_receptionist: CableClubNPC,
  mart: (env, entry) => pokemart(env, entry.kind === 'mart' ? entry.items : []),
  pokecenter_pc: activatePC,
  vending_machine: vendingMachine,
  bills_pc: billsPCDirect,
  players_pc: playerPCDirect,
  prize_vendor: (env) => celadonPrizeMenu(env),
};
