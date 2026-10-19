/** Ports of scripts/RedsHouse1F.asm, RedsHouse1F_2.asm, RedsHouse2F.asm */
import type { MapScript } from '../types';

export const RedsHouse1F: MapScript = {
  map: 'REDS_HOUSE_1F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
  },
  texts: {
    // RedsHouse1FPrintMomText
    *RedsHouse1FMomText(e) {
      if (!e.getVar('flag:GOT_STARTER')) {
        yield* e.printText('RedsHouse1FPrintMomText.WakeUpText');
        return;
      }
      // RedsHouse1FMomHealScript
      yield* e.printText('RedsHouse1FMomYouShouldRestText');
      yield* e.fadeToWhite();
      e.healParty();
      e.playMusic('MUSIC_PKMN_HEALED');
      yield* e.delayFrames(150); // until the jingle ends
      e.playDefaultMusic();
      yield* e.fadeFromWhite();
      yield* e.printText('RedsHouse1FMomLookingGreatText');
    },
    // RedsHouse1FPrintTVText
    *RedsHouse1FTVText(e) {
      yield* e.printText(e.playerFacing === 'up' ? 'RedsHouse1FPrintTVText.StandByMeMovieText' : 'RedsHouse1FPrintTVText.WrongSideText');
    },
  },
};

export const RedsHouse2F: MapScript = {
  map: 'REDS_HOUSE_2F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    // RedsHouse2F_ScriptPointers: every entry is RedsHouse2FDefaultScript (ret)
  },
};
