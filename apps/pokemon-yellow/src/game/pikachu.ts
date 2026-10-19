/**
 * Starter Pikachu identity and happiness/mood bookkeeping:
 * engine/pikachu/pikachu_status.asm (IsThisPartyMonStarterPikachu,
 * IsStarterPikachuAliveInOurParty, UpdatePikachuMoodAfterBattle),
 * IsPlayerPikachuAsleepInParty (pikachu_emotions.asm) and
 * ModifyPikachuHappiness (engine/events/pikachu_happiness.asm).
 */
import type { GameBundle } from '../data/schema';
import type { GameState, PartyMon } from './state';
import { c } from '../rom/constants';

/** The OT name comparison covers NAME_LENGTH_JP - 1 bytes (terminator included). */
function sameOT(a: string, b: string): boolean {
  const n = c('text', 'NAME_LENGTH_JP') - 1;
  return (a + '@'.repeat(n)).slice(0, n) === (b + '@'.repeat(n)).slice(0, n);
}

export function isStarterPikachu(s: GameState, m: PartyMon | undefined): boolean {
  if (!m || m.species !== c('pokemon', 'STARTER_PIKACHU')) return false;
  return m.otId === s.player.id && sameOT(m.otName, s.player.name);
}

/** IsStarterPikachuAliveInOurParty: the first starter Pikachu found decides. */
export function isStarterPikachuAliveInParty(s: GameState, party: PartyMon[] = s.party): boolean {
  for (const m of party) if (isStarterPikachu(s, m)) return m.hp > 0;
  return false;
}

/** IsSurfingPikachuInParty: the starter Pikachu (alive or not) knows SURF. */
export function isSurfingPikachuInParty(s: GameState, party: PartyMon[] = s.party): boolean {
  const surf = c('move', 'SURF');
  return party.some((m) => isStarterPikachu(s, m) && m.moves.includes(surf));
}

/** IsPlayerPikachuAsleepInParty */
export function isPlayerPikachuAsleepInParty(s: GameState, party: PartyMon[] = s.party): boolean {
  for (const m of party) {
    if (!isStarterPikachu(s, m)) continue;
    return (m.status & c('battle', 'SLP_MASK')) !== 0;
  }
  return false;
}

/**
 * ModifyPikachuHappiness. `which` is the party mon the event concerns (the
 * original checks wWhichPokemon) except for GYMLEADER/WALKING, which look
 * for the starter anywhere in the party. Returns the new {happiness, mood}.
 */
export function modifyPikachuHappiness(
  bundle: GameBundle,
  s: GameState,
  event: string,
  which: PartyMon | undefined,
  party: PartyMon[] = s.party,
  emotionModifier = 0,
): { happiness: number; mood: number } | undefined {
  const d = c('pikachu_emotion', event);
  if (d === c('pikachu_emotion', 'PIKAHAPPY_GYMLEADER') || d === c('pikachu_emotion', 'PIKAHAPPY_WALKING')) {
    if (!isStarterPikachuAliveInParty(s, party)) return undefined;
  } else if (!isStarterPikachu(s, which)) return undefined;
  let { happiness, mood } = s.pikachu;
  const bracket = happiness < 100 ? 0 : happiness < 200 ? 1 : 2;
  const delta = bundle.battle.happinessChange[d - 1][bracket];
  if (delta < 100) happiness = Math.min(0xff, happiness + delta);
  else {
    const sum = happiness + delta;
    happiness = sum > 0xff ? sum & 0xff : 0;
  }
  const b = bundle.battle.pikachuMoods[d - 1];
  if (b !== 0x80) {
    if (b < 0x80) {
      if (mood >= b) mood = b;
    } else if (mood < b && !emotionModifier) mood = b;
  }
  return { happiness, mood };
}

/** UpdatePikachuMoodAfterBattle(d) */
export function moodAfterBattle(s: GameState, d: number): number | undefined {
  if (!isStarterPikachuAliveInParty(s)) return undefined;
  const mood = s.pikachu.mood;
  if (d >= 128) return mood < d ? d : undefined;
  return mood >= d ? d : undefined;
}
