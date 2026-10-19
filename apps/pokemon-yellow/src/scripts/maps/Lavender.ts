/** The Name Rater (scripts/NameRatersHouse.asm). */
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { ramSym } from '../../rom/symbols';
import { partyMenu } from '../../ui/partyMenu';
import { namingScreen, restoreScreen, saveScreen } from '../../ui/menus';

export function* nameRater(env: ScriptEnv) {
  const e = env.e;
  const T = (n: string) => `NameRatersHouseNameRaterText.${n}`;
  const comeAnyTime = () => env.printText(T('ComeAnyTimeYouLikeText'));
  yield* env.printText(T('WantMeToRateText'));
  if (!(yield* env.yesNoChoice())) return yield* comeAnyTime();
  yield* env.printText(T('WhichPokemonText'));
  const buffer = saveScreen(e);
  const chosen = yield* partyMenu(e, { party: structuredClone(e.state.party), mode: 'normal' });
  e.screen.clearGlyphOverrides();
  restoreScreen(e, buffer);
  if (chosen === undefined) return yield* comeAnyTime();
  const mon = e.state.party[chosen];
  e.ram.nameBuffer = mon.nickname; // GetPartyMonName2
  // NameRatersHouseCheckMonOTScript: traded mons keep their name
  if (mon.otName !== e.state.player.name || mon.otId !== e.state.player.id) return yield* env.printText(T('ATrulyImpeccableNameText'));
  yield* env.printText(T('GiveItANiceNameText'));
  if (!(yield* env.yesNoChoice())) return yield* comeAnyTime();
  yield* env.printText(T('WhatShouldWeNameItText'));
  // DisplayNameRaterScreen
  const name = yield* namingScreen(e, 'mon', e.bundle.species[mon.species]?.name ?? '');
  if (!name) return yield* comeAnyTime();
  const party = structuredClone(e.state.party);
  party[chosen].nickname = name;
  e.store.dispatch({ type: 'setParty', party }, { undoable: false });
  const wBuffer = ramSym('wBuffer');
  e.ram.mem.set(wBuffer, name);
  try {
    yield* env.printText(T('PokemonHasBeenRenamedText'));
  } finally {
    e.ram.mem.delete(wBuffer);
  }
}
