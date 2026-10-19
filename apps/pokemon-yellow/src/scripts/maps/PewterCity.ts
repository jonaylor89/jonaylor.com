/** Port of scripts/PewterCity.asm: the museum guy and the gym guy who lead the player. */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_CTRL_PAD, PAD_SELECT, PAD_START } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT } from '../../engine/sprites';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_PEWTERCITY_${n}`);
const NERD = 'PEWTERCITY_SUPER_NERD1';
const YOUNGSTER = 'PEWTERCITY_YOUNGSTER';

/** GetSpritePosition2: remember where the guide stood. */
function saveGuidePosition(e: ScriptEnv, obj: string): void {
  const p = e.getSpritePosition(obj);
  e.setVar('wSavedSpriteMapX', p.x);
  e.setVar('wSavedSpriteMapY', p.y);
}

/** SetSpritePosition2 + ShowObject: the guide is back at their post. */
function resetGuide(e: ScriptEnv, obj: string, toggle: string): void {
  e.setSpriteMapPosition(obj, e.getVar('wSavedSpriteMapX'), e.getVar('wSavedSpriteMapY'));
  e.showObject(toggle);
  e.joyIgnore = 0;
  e.curScript = S('DEFAULT');
}

const scripts: ScriptFn[] = [
  // PewterCityDefaultScript
  function* (e) {
    e.e.setMapScriptOf('MUSEUM_1F', 0);
    e.resetEvent('EVENT_BOUGHT_MUSEUM_TICKET');
    // PewterCityCheckPlayerLeavingEastScript
    if (e.checkEvent('EVENT_BEAT_BROCK')) return;
    const leaving = e.arePlayerCoordsInArray([
      [17, 35],
      [17, 36],
      [18, 37],
      [19, 37],
    ]);
    if (!leaving) return;
    e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
    yield* e.displayTextID('TEXT_PEWTERCITY_YOUNGSTER');
  },
  // PewterCitySuperNerd1ShowsPlayerMuseumScript
  function* (e) {
    if (e.npcMovementScriptActive) return;
    yield* e.setSpriteFacingDirectionAndDelay(NERD, 'up');
    e.playDefaultMusic();
    yield* e.displayTextID('TEXT_PEWTERCITY_SUPER_NERD1_ITS_RIGHT_HERE');
    // SetSpritePosition1 with map coords (17, 12) - 4
    e.setSpriteMapPosition(NERD, 13, 8);
    e.moveSprite(NERD, [NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN]);
    e.curScript = S('HIDE_SUPER_NERD1');
  },
  // PewterCityHideSuperNerd1Script
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_MUSEUM_GUY');
    e.curScript = S('RESET_SUPER_NERD1');
  },
  // PewterCityResetSuperNerd1Script
  function* (e) {
    resetGuide(e, NERD, 'TOGGLE_MUSEUM_GUY');
  },
  // PewterCityYoungsterShowsPlayerGymScript
  function* (e) {
    if (e.npcMovementScriptActive) return;
    e.setSpriteFacing(YOUNGSTER, 'left');
    e.playDefaultMusic();
    yield* e.displayTextID('TEXT_PEWTERCITY_YOUNGSTER_GO_TAKE_ON_BROCK');
    // SetSpritePosition1 with map coords (16, 22) - 4. The original also loads a screen X of $40
    // instead of $50, so its sprite is drawn one square off until it moves; we place it by map
    // coordinates only.
    e.setSpriteMapPosition(YOUNGSTER, 12, 18);
    e.moveSprite(YOUNGSTER, new Array(5).fill(NPC_MOVEMENT_RIGHT));
    e.curScript = S('HIDE_YOUNGSTER');
  },
  // PewterCityHideYoungsterScript
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_GYM_GUY');
    e.curScript = S('RESET_YOUNGSTER');
  },
  // PewterCityResetYoungsterScript
  function* (e) {
    resetGuide(e, YOUNGSTER, 'TOGGLE_GYM_GUY');
  },
];

const yesNoText = (question: string, yes: string, no: string, onNo?: (e: ScriptEnv) => void): ScriptFn =>
  function* (e) {
    yield* e.printText(question);
    if (yield* e.yesNoChoice()) {
      yield* e.printText(yes);
      return;
    }
    yield* e.printText(no);
    onNo?.(e);
  };

export const PewterCity: MapScript = {
  map: 'PEWTER_CITY',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    e.e.ram.pikachuMapScriptActive = false;
    yield* scripts[e.curScript](e);
  },
  texts: {
    PewterCitySuperNerd1Text: yesNoText(
      'PewterCitySuperNerd1Text.DidYouCheckOutMuseumText',
      'PewterCitySuperNerd1Text.WerentThoseFossilsAmazingText',
      'PewterCitySuperNerd1Text.YouHaveToGoText',
      (e) => {
        e.joyHeld = 0;
        e.startNpcMovementScript(2, NERD);
        saveGuidePosition(e, NERD);
        e.curScript = S('SUPER_NERD1_SHOWS_PLAYER_MUSEUM');
      },
    ),
    PewterCitySuperNerd2Text: yesNoText(
      'PewterCitySuperNerd2Text.DoYouKnowWhatImDoingText',
      'PewterCitySuperNerd2Text.ThatsRightText',
      'PewterCitySuperNerd2Text.ImSprayingRepelText',
    ),
    *PewterCityYoungsterText(e) {
      yield* e.printText('PewterCityYoungsterText.YoureATrainerFollowMeText');
      e.joyHeld = 0;
      e.startNpcMovementScript(3, YOUNGSTER);
      saveGuidePosition(e, YOUNGSTER);
      e.curScript = S('YOUNGSTER_SHOWS_PLAYER_GYM');
    },
  },
};
