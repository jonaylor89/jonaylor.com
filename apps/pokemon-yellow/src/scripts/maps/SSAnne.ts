/**
 * The S.S. ANNE: the rival battle on 2F (scripts/SSAnne2F.asm), the seasick
 * captain and HM01 (scripts/SSAnneCaptainsRoom.asm), and the Snorlax
 * gentleman in the 2F cabins (scripts/SSAnne2FRooms.asm).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_CTRL_PAD } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT } from '../../engine/sprites';
import { c } from '../../rom/constants';
import { saveScreen, restoreScreen } from '../../ui/menus';
import { displayPokedex } from '../../engine/hiddenEvents';

const LOST_BATTLE = 0xff;
const S = (n: string) => c('map_script', `SCRIPT_SSANNE2F_${n}`);
const RIVAL = 'SSANNE2F_RIVAL';
/** The jingle plays for about this long (until the audio engine reports its end). */
const HEALED_JINGLE_FRAMES = 150;

/** SSAnne2FSetFacingDirectionScript: the rival faces the player at x 36 (down) or x 37 (right). */
function* faceRival(e: ScriptEnv): Co {
  if (e.x === 37) {
    e.setPlayerMovingDirection('left');
    yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'right');
  } else yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'down');
}

const scripts: ScriptFn[] = [
  // SSAnne2FDefaultScript
  function* (e) {
    const i = e.arePlayerCoordsInArray([[8, 36], [8, 37]]);
    if (!i) return;
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL');
    e.showObject('TOGGLE_SS_ANNE_2F_RIVAL');
    yield* e.delayFrames(3);
    e.joyHeld = 0;
    e.joyIgnore = PAD_CTRL_PAD;
    e.moveSprite(RIVAL, new Array(i === 2 ? 4 : 3).fill(NPC_MOVEMENT_DOWN));
    e.curScript = S('RIVAL_START_BATTLE');
  },
  // SSAnne2FRivalStartBattleScript
  function* (e) {
    if (e.npcMoving) return;
    yield* faceRival(e);
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_SSANNE2F_RIVAL');
    yield* e.delayFrames(3);
    e.startTrainerBattle('OPP_RIVAL2', 1, 'SSAnne2FRivalDefeatedText', 'SSAnne2FRivalVictoryText');
    yield* faceRival(e);
    e.curScript = S('RIVAL_AFTER_BATTLE');
  },
  // SSAnne2FRivalAfterBattleScript
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      e.joyIgnore = 0;
      e.curScript = S('DEFAULT');
      return;
    }
    yield* faceRival(e);
    e.joyIgnore = PAD_CTRL_PAD;
    yield* e.displayTextID('TEXT_SSANNE2F_RIVAL_CUT_MASTER');
    const down4 = new Array(4).fill(NPC_MOVEMENT_DOWN);
    e.moveSprite(RIVAL, e.x === 37 ? down4 : [NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_DOWN, ...down4]);
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStart
    e.curScript = S('RIVAL_EXIT');
  },
  // SSAnne2FRivalExitScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    e.hideObject('TOGGLE_SS_ANNE_2F_RIVAL');
    e.playDefaultMusic();
    e.curScript = S('NOOP');
  },
  // SSAnne2FNoopScript
  function* () {},
];

export const SSAnne2F: MapScript = {
  map: 'SS_ANNE_2F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    // the rival's text sets up the end-of-battle texts (the battle is started by the script)
    *SSAnne2FRivalText(e) {
      yield* e.printText('SSAnne2FRivalText.Text');
      e.ram.talkedToTrainer = true;
      e.ram.printEndBattleText = true;
      e.ram.endBattleWinText = 'SSAnne2FRivalDefeatedText';
      e.ram.endBattleLoseText = 'SSAnne2FRivalVictoryText';
    },
  },
};

export const SSAnneCaptainsRoom: MapScript = {
  map: 'SS_ANNE_CAPTAINS_ROOM',
  *run(e) {
    // the seasick captain doesn't turn to face the player
    if (!e.checkEvent('EVENT_GOT_HM01')) e.e.ram.noNpcFacePlayer = true;
    e.enableAutoTextBoxDrawing();
  },
  texts: {
    *SSAnneCaptainsRoomCaptainText(e) {
      if (e.checkEvent('EVENT_GOT_HM01')) return yield* e.printText('SSAnneCaptainsRoomCaptainNotSickAnymoreText');
      yield* e.printText('SSAnneCaptainsRoomRubCaptainsBackText');
      yield* e.printText('SSAnneCaptainsRoomCaptainIFeelMuchBetterText');
      if (!e.giveItem('HM_CUT')) return yield* e.printText('SSAnneCaptainsRoomCaptainHM01NoRoomText');
      yield* e.printText('SSAnneCaptainsRoomCaptainReceivedHM01Text');
      e.setEvent('EVENT_GOT_HM01');
      e.e.ram.noNpcFacePlayer = false;
    },
    // the text_asm inside SSAnneCaptainsRoomRubCaptainsBackText: the healing jingle while rubbing
    *SSAnneCaptainsRoomRubCaptainsBackText(e) {
      e.playMusic('MUSIC_PKMN_HEALED');
      yield* e.delayFrames(HEALED_JINGLE_FRAMES);
      e.playDefaultMusic();
      e.setEvent('EVENT_RUBBED_CAPTAINS_BACK');
      e.e.ram.noNpcFacePlayer = false;
    },
  },
};

/** SSAnne2FRoomsGentleman3Text: shows SNORLAX's Pokédex entry */
export function* ssAnne2FRoomsGentleman3(e: ScriptEnv): Co {
  const saved = saveScreen(e.e);
  yield* e.printText('SSAnne2FRoomsGentleman3Text.Text');
  restoreScreen(e.e, saved);
  yield* displayPokedex(e.e, c('pokemon', 'SNORLAX'));
}
