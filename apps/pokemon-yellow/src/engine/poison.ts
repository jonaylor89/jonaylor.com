/**
 * ApplyOutOfBattlePoisonDamage (engine/events/poison.asm), run after every
 * finished step: the Day Care mon's experience (IncrementDayCareMonExp),
 * Pikachu's walking happiness and mood (UpdatePikachuHappinessAndMood), and
 * every fourth step 1 HP of poison damage per poisoned party mon.
 */
import type { Co, Engine } from './Engine';
import { c } from '../rom/constants';
import { isStarterPikachu, modifyPikachuHappiness } from '../game/pikachu';
import { playPikachuCry, pikachuCry } from './pikachuEmotions';

/** wDayCareMonExp is three bytes; the top byte stops at $50 (5,242,880). */
export const DAYCARE_EXP_CAP = 0x500000;

/** IncrementDayCareMonExp */
export function incrementDayCareMonExp(e: Engine): void {
  const d = e.state.daycare;
  if (!d) return;
  let exp = d.exp + 1;
  if (exp > 0xffffff) exp = 0;
  if (exp >= DAYCARE_EXP_CAP && (exp & 0xffff) === 0) exp = DAYCARE_EXP_CAP; // only checked on a carry into the top byte
  if (exp === d.exp) return;
  e.store.dispatch({ type: 'setDaycare', mon: { ...d, exp } }, { undoable: false });
}

/** UpdatePikachuHappinessAndMood */
function* updatePikachuHappinessAndMood(e: Engine): Co {
  if (e.ram.stepCounter === 0 && e.random() & 1) {
    const h = modifyPikachuHappiness(e.bundle, e.state, 'PIKAHAPPY_WALKING', undefined, e.state.party, e.ram.pikachuEmotionModifier);
    if (h) e.store.dispatch({ type: 'setPikachu', happiness: h.happiness, mood: h.mood }, { undoable: false });
  }
  // every step the mood moves one unit towards 128
  let mood = e.state.pikachu.mood;
  if (mood !== 128) {
    mood += mood < 128 ? 1 : -1;
    e.store.dispatch({ type: 'setPikachu', mood }, { undoable: false });
    if (mood !== 128) return;
  }
  e.ram.pikachuEmotionModifier = 0;
}

/** Returns true when the player blacked out (wOutOfBattleBlackout). */
export function* applyOutOfBattlePoisonDamage(e: Engine): Co<boolean> {
  const r = e.ram;
  if (r.scriptedMovementState || r.pikachuMapScriptActive || !e.state.party.length) return false;
  incrementDayCareMonExp(e);
  yield* updatePikachuHappinessAndMood(e);
  if ((r.stepCounter & 3) === 0) {
    const PSN = 1 << c('battle', 'PSN');
    for (let i = 0; i < e.state.party.length; i++) {
      const m = e.state.party[i];
      if (!(m.status & PSN) || m.hp === 0) continue;
      const party = structuredClone(e.state.party);
      const mon = party[i];
      mon.hp--;
      if (mon.hp === 0) mon.status = 0;
      e.store.dispatch({ type: 'setParty', party }, { undoable: false });
      if (mon.hp !== 0) continue;
      // the mon fainted from the damage: DisplayTextID(TEXT_MON_FAINTED)
      r.nameBuffer = mon.nickname;
      r.joyIgnore = 0;
      e.env.enableAutoTextBoxDrawing();
      yield* e.printText('PokemonFaintedText');
      yield* e.waitForTextScrollButtonPress();
      e.closeTextDisplay();
      if (isStarterPikachu(e.state, mon)) {
        yield* playPikachuCry(e, pikachuCry(4));
        const h = modifyPikachuHappiness(e.bundle, e.state, 'PIKAHAPPY_PSNFNT', mon, e.state.party, r.pikachuEmotionModifier);
        if (h) e.store.dispatch({ type: 'setPikachu', happiness: h.happiness, mood: h.mood }, { undoable: false });
      }
    }
    if (e.state.party.some((m) => m.status & PSN)) {
      // ChangeBGPalColor0_4Frames: rBGP inverted (xor $FF) for 4 frames
      e.hooks.bgp?.(0xe4 ^ 0xff);
      yield* e.delayFrames(4);
      e.hooks.bgp?.(undefined);
      e.env.playSound('poisoned');
    }
  }
  if (e.state.party.some((m) => m.hp > 0)) return false;
  // DisplayTextID(TEXT_BLACKED_OUT)
  e.env.enableAutoTextBoxDrawing();
  yield* e.printText('PlayerBlackedOutText');
  r.alwaysOnBike = false;
  if (e.env.checkEvent('EVENT_IN_SAFARI_ZONE')) {
    e.env.setVar('wNumSafariBalls', 0);
    e.env.setVar('wSafariSteps', 0);
    // EventFlagAddressA: a = 0 is stored over the whole event byte holding EVENT_IN_SAFARI_ZONE
    const byte = c('event', 'EVENT_IN_SAFARI_ZONE') >> 3;
    for (let i = 0; i < 8; i++) e.store.dispatch({ type: 'setEvent', flag: byte * 8 + i, value: false }, { undoable: false });
    e.env.setVar('wNextSafariZoneGateScript', 0);
    e.env.setMapScript('SAFARI_ZONE_GATE', 'SCRIPT_SAFARIZONEGATE_DEFAULT');
  }
  e.closeTextDisplay();
  return true;
}
