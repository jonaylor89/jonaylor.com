/**
 * Ports of scripts/Museum1F.asm (+ Museum1F_2.asm), the Pewter Pokémon
 * Center's Jigglypuff (PewterPokecenter_2.asm) and the Mt. Moon Pokémon
 * Center's Magikarp salesman (engine/events/hidden_events/... MagikarpSalesman).
 */
import type { MapScript } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Facing } from '../../world/movement';
import { PAD_DOWN } from '../../engine/pad';
import { c } from '../../rom/constants';
import { displayMoneyBox } from '../../ui/mart';
import { isStarterPikachu } from '../../game/pikachu';

const MUSEUM_S = (n: string) => c('map_script', `SCRIPT_MUSEUM1F_${n}`);

function* museumScientist1(e: ScriptEnv) {
  const T = (n: string) => `Museum1FPrintScientist1Text.${n}`;
  const { x, y } = e;
  // talking from behind the counter (the original reuses a = wYCoord for the second check)
  const behindCounter = (y === 4 && x === 13) || (y !== 4 && y === 3 && x === 12);
  if (behindCounter) {
    yield* e.printText(T('DoYouKnowWhatAmberIsText'));
    if (yield* e.yesNoChoice()) yield* e.printText(T('TheresALabSomewhereText'));
    else yield* e.printText(T('AmberIsFossilizedTreeSapText'));
    return;
  }
  if (y !== 4) {
    // .not_behind_counter
    yield* e.printText(e.checkEvent('EVENT_BOUGHT_MUSEUM_TICKET') ? T('TakePlentyOfTimeText') : T('GoToOtherSideText'));
    return;
  }
  // .check_ticket
  if (e.checkEvent('EVENT_BOUGHT_MUSEUM_TICKET')) {
    yield* e.printText(T('TakePlentyOfTimeText'));
    return;
  }
  displayMoneyBox(e.e);
  e.joyHeld = 0;
  yield* e.printText(T('WouldYouLikeToComeInText'));
  let allowed = false;
  if (yield* e.yesNoChoice()) {
    if (e.e.state.money < 50) yield* e.printText(T('DontHaveEnoughMoneyText'));
    else {
      yield* e.printText(T('ThankYouText'));
      e.setEvent('EVENT_BOUGHT_MUSEUM_TICKET');
      e.e.store.dispatch({ type: 'addMoney', amount: -50 }, { undoable: false });
      displayMoneyBox(e.e);
      yield* e.playSoundWaitForCurrent('purchase');
      yield* e.waitForSoundToFinish();
      allowed = true;
    }
  }
  if (!allowed) {
    // .deny_entry
    yield* e.printText(T('ComeAgainText'));
    e.setSimulatedJoypad([PAD_DOWN], 1);
    e.startSimulatingJoypadStates();
    e.updateSprites();
    return;
  }
  e.curScript = MUSEUM_S('NOOP');
}

export const Museum1F: MapScript = {
  map: 'MUSEUM_1F',
  *run(e) {
    e.e.ram.autoTextBoxControl = 1;
    e.doNotWaitForButtonPress = false;
    if (e.curScript !== MUSEUM_S('DEFAULT')) return;
    // Museum1FDefaultScript
    if (e.y !== 4 || (e.x !== 9 && e.x !== 10)) return;
    e.joyHeld = 0;
    yield* e.displayTextID('TEXT_MUSEUM1F_SCIENTIST1');
  },
  texts: {
    *Museum1FScientist1Text(e) {
      yield* museumScientist1(e);
    },
  },
};

/** Turns while the Jigglypuff song plays when there is no audio engine to ask (TASKS.md: audio). */
const JIGGLYPUFF_TURNS_WITHOUT_AUDIO = 14;

export const PewterPokecenterJigglypuff = function* (e: ScriptEnv) {
  // PewterJigglypuff
  e.doNotWaitForButtonPress = true;
  yield* e.printText('PewterJigglypuff.Text');
  e.stopAllMusic();
  yield* e.delayFrames(32);
  const order: Facing[] = ['down', 'left', 'up', 'right'];
  const puff = e.sprite(3);
  let i = Math.max(0, order.indexOf(e.e.facingOf(puff)));
  e.playMusic('MUSIC_JIGGLYPUFF_SONG');
  for (let turn = 0; ; turn++) {
    e.setSpriteFacing(3, order[i]);
    i = (i + 1) & 3;
    yield* e.delayFrames(24);
    const playing = e.e.hooks.isMusicPlaying ? e.e.hooks.isMusicPlaying() : turn + 1 < JIGGLYPUFF_TURNS_WITHOUT_AUDIO;
    if (!playing) break;
  }
  yield* e.delayFrames(48);
  e.playDefaultMusic();
  if (!e.pikachuSpawnStarter) return;
  // CheckPikachuStatusCondition: a Pikachu with a status problem stays awake
  const pika = e.e.state.party.find((m) => isStarterPikachu(e.e.state, m));
  if (pika && pika.status) return;
  e.e.ram.pikachuOverworldStateFlags |= 2; // DisablePikachuFollowingPlayer: Pikachu fell asleep
};

/** MagikarpSalesman (engine/events/magikarp_salesman.asm) */
export const MagikarpSalesman = function* (e: ScriptEnv) {
  const T = (n: string) => `MagikarpSalesman.${n}`;
  if (e.checkEvent('EVENT_BOUGHT_MAGIKARP')) {
    yield* e.printText(T('NoRefundsText'));
    return;
  }
  yield* e.printText(T('IGotADealText'));
  displayMoneyBox(e.e);
  if (!(yield* e.yesNoChoice())) {
    yield* e.printText(T('NoText'));
    return;
  }
  if (e.e.state.money < 500) {
    yield* e.printText(T('NoMoneyText'));
    return;
  }
  if (!(yield* e.givePokemon('MAGIKARP', 5))) return;
  e.e.store.dispatch({ type: 'addMoney', amount: -500 }, { undoable: false });
  displayMoneyBox(e.e);
  e.setEvent('EVENT_BOUGHT_MAGIKARP');
};
