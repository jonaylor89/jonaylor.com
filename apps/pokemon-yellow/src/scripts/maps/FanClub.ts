/**
 * The Pokémon Fan Club (scripts/PokemonFanClub.asm): Pikachu runs off to play
 * with the Seel, the two fans out-boast each other, and the chairman tells his
 * story for a BIKE VOUCHER, later offering to print a Pokémon's portrait.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { c } from '../../rom/constants';
import { FACING_DOWN } from '../../engine/sprites';
import { PIKA_NOT_FOLLOWING } from '../../engine/pikachu';
import { talkToPikachu } from '../../engine/pikachuEmotions';
import { isStarterPikachu } from '../../game/pikachu';
import { partyMenu } from '../../ui/partyMenu';
import { restoreScreen, saveScreen } from '../../ui/menus';
import { printFanClubPortrait } from '../../ui/printer';

const S = (n: number) => c('map_script', `SCRIPT_POKEMONFANCLUB_SCRIPT${n}`);
/** PokemonFanClubPikachuMovementData */
const PIKACHU_TO_SEEL = [0x00, 0x26, 0x20, 0x20, 0x20, 0x1e, 0x3f];

/** PokemonFanClubScript_59a44: Pikachu spots the Seel and runs to it. */
function* pikachuRunsToSeel(e: ScriptEnv): Co {
  const st = e.e.state;
  if (!e.pikachuSpawnStarter) return;
  if (st.party.some((m) => isStarterPikachu(st, m) && m.status)) return; // CheckPikachuStatusCondition
  e.curScript = S(1);
  e.e.ram.playerMovingDirection = 0;
  e.updateSprites();
  e.updateSprites();
  yield* e.emotionBubble(e.e.pikachuSlot, 'EXCLAMATION_BUBBLE');
  yield* e.e.pikachu.applyMovementData(PIKACHU_TO_SEEL);
  const seel = e.sprite(3);
  seel.movementStatus = 2;
  seel.facing = FACING_DOWN;
  yield* talkToPikachu(e.e);
  e.e.ram.pikachuOverworldStateFlags |= PIKA_NOT_FOLLOWING;
}

const scripts: ScriptFn[] = [
  // PokemonFanClubScript0: on entering
  function* (e) {
    if (!e.e.ram.pikachuMapScriptActive) yield* pikachuRunsToSeel(e);
    e.e.ram.pikachuMapScriptActive = true;
  },
  // PokemonFanClubScript1: a 25/256 chance each visit
  function* (e) {
    if (!e.e.ram.pikachuMapScriptActive) {
      e.e.random();
      if (e.e.rng.hRandomAdd < 25) yield* pikachuRunsToSeel(e);
    }
    e.e.ram.pikachuMapScriptActive = true;
  },
];

/** The two fans: each boast sets the other's event. */
function fan(label: string, otherBoast: string, ownBoast: string): ScriptFn {
  return function* (e) {
    const T = (n: string) => `${label}.${n}`;
    if (e.checkEvent('EVENT_LEFT_FANCLUB_AFTER_BIKE_VOUCHER')) return yield* e.printText(T('yellowtext'));
    if (e.checkEvent(otherBoast)) {
      e.resetEvent(otherBoast);
      return yield* e.printText(T('bettertext'));
    }
    e.setEvent(ownBoast);
    yield* e.printText(T('normaltext'));
  };
}

function* chairman(e: ScriptEnv): Co {
  const T = (n: string) => `PokemonFanClubChairmanText.${n}`;
  if (e.checkEvent('EVENT_LEFT_FANCLUB_AFTER_BIKE_VOUCHER')) {
    // Yellow: he offers to print a Pokémon's portrait
    yield* e.printText('Text_59c1f');
    if (!(yield* e.yesNoChoice())) return yield* e.printText('Text_59c24');
    const saved = saveScreen(e.e);
    const chosen = yield* partyMenu(e.e, { party: structuredClone(e.e.state.party), mode: 'normal' });
    e.e.screen.clearGlyphOverrides();
    if (chosen === undefined) {
      restoreScreen(e.e, saved);
      return yield* e.printText('Text_59c24');
    }
    e.e.ram.noTextDelay = true;
    const canceled = yield* printFanClubPortrait(e.e, e.e.state.party[chosen]);
    e.e.ram.noTextDelay = false;
    e.e.screen.clearGlyphOverrides();
    restoreScreen(e.e, saved);
    return yield* e.printText(canceled ? 'Text_59c2e' : 'Text_59c29');
  }
  if (e.checkEvent('EVENT_GOT_BIKE_VOUCHER')) return yield* e.printText(T('FinalText'));
  yield* e.printText(T('IntroText'));
  if (!(yield* e.yesNoChoice())) return yield* e.printText(T('NoStoryText'));
  yield* e.printText(T('StoryText'));
  if (!e.giveItem('BIKE_VOUCHER')) return yield* e.printText(T('BagFullText'));
  yield* e.printText(T('BikeVoucherText'));
  e.setEvent('EVENT_GOT_BIKE_VOUCHER');
}

export const PokemonFanClub: MapScript = {
  map: 'POKEMON_FAN_CLUB',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    PokemonFanClubClefairyFanText: fan('PokemonFanClubClefairyFanText', 'EVENT_PIKACHU_FAN_BOAST', 'EVENT_SEEL_FAN_BOAST'),
    PokemonFanClubSeelFanText: fan('PokemonFanClubSeelFanText', 'EVENT_SEEL_FAN_BOAST', 'EVENT_PIKACHU_FAN_BOAST'),
    PokemonFanClubChairmanText: chairman,
  },
};
