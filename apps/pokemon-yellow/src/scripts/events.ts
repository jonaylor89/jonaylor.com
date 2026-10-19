/**
 * Event routines shared by several maps: OaksAideScript
 * (engine/events/oaks_aide.asm) and DoInGameTradeDialogue
 * (engine/events/in_game_trades.asm).
 */
import type { Co } from '../engine/Engine';
import type { ScriptEnv } from '../engine/ScriptEnv';
import { c } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { getBit } from '../game/state';
import { makePartyMon } from '../game/pokemon';
import { partyMenu } from '../ui/partyMenu';
import { restoreScreen, saveScreen } from '../ui/menus';
import { evolutionAfterBattle } from '../game/evolution';
import { internalClockTradeAnim } from '../movie/trade';

export type OaksAideResult = 'got' | 'bagFull' | 'notEnough' | 'refused';

/** OaksAideScript: an item for owning at least `requirement` kinds of Pokémon. */
export function* oaksAide(env: ScriptEnv, requirement: number, item: string): Co<OaksAideResult> {
  const e = env.e;
  const itemId = c('item', item);
  const name = e.bundle.items.find((i) => i.id === itemId)?.name ?? '?';
  e.ram.mem.set(ramSym('hOaksAideRequirement'), requirement);
  e.ram.mem.set(ramSym('wOaksAideRewardItemName'), name);
  yield* env.printText('OaksAideHiText');
  if (!(yield* env.yesNoChoice())) {
    yield* env.printText('OaksAideComeBackText');
    return 'refused';
  }
  let owned = 0;
  for (let i = 0; i < 151; i++) if (getBit(e.state.pokedex.owned, i)) owned++;
  e.ram.mem.set(ramSym('hOaksAideNumMonsOwned'), owned);
  if (requirement > owned) {
    yield* env.printText('OaksAideUhOhText');
    return 'notEnough';
  }
  yield* env.printText('OaksAideHereYouGoText');
  if (!env.giveItem(item)) {
    yield* env.printText('OaksAideNoRoomText');
    return 'bagFull';
  }
  yield* env.printText('OaksAideGotItemText');
  return 'got';
}

const TRADE_EVOLVERS = ['KADABRA', 'GRAVELER', 'MACHOKE', 'HAUNTER'];

/** DoInGameTradeDialogue for TradeMons entry `which` (a TRADE_FOR_* constant). */
export function* inGameTrade(env: ScriptEnv, which: number): Co {
  const e = env.e;
  const t = e.bundle.trades.mons[which];
  if (!t) throw new Error(`no in-game trade ${which}`);
  const texts = e.bundle.trades.texts[t.dialog];
  const nameOf = (sp: number) => e.bundle.species[sp]?.name ?? '?';
  e.ram.mem.set(ramSym('wInGameTradeGiveMonName'), nameOf(t.give));
  e.ram.mem.set(ramSym('wInGameTradeReceiveMonName'), nameOf(t.get));
  const flags = () => e.state.vars.wCompletedInGameTradeFlags ?? 0;
  const done = () => (flags() >> which) & 1;
  if (done()) {
    yield* env.printText(texts[4]); // TRADETEXT_AFTER_TRADE
    return;
  }
  yield* env.printText(texts[0]); // TRADETEXT_WANNA_TRADE
  if (!(yield* env.yesNoChoice())) {
    yield* env.printText(texts[1]);
    return;
  }
  // InGameTrade_DoTrade
  const buffer2 = saveScreen(e);
  const party = structuredClone(e.state.party);
  const chosen = yield* partyMenu(e, { party, mode: 'normal' });
  e.screen.clearGlyphOverrides();
  restoreScreen(e, buffer2);
  yield* e.delayFrames(10);
  if (chosen === undefined) {
    yield* env.printText(texts[1]);
    return;
  }
  const given = party[chosen];
  if (given.species !== t.give) {
    yield* env.printText(texts[2]);
    return;
  }
  env.setVar('wCompletedInGameTradeFlags', flags() | (1 << which));
  yield* env.printText('ConnectCableText');
  // InGameTrade_PrepareTradeData: preserve the received OT ID before the animation's VBlanks.
  e.random();
  const otId = (e.rng.hRandomAdd << 8) | e.rng.hRandomSub;
  yield* internalClockTradeAnim(e, given, { species: t.get, otName: e.bundle.trades.otName, otId });
  // RemovePokemon, then AddPartyMon (DVs from two Random calls; $80 skips naming) and InGameTrade_CopyDataToReceivedMon
  party.splice(chosen, 1);
  const b = e.random();
  const a = e.random();
  const mon = makePartyMon(e.bundle, { species: t.get, level: given.level, dvs: (a << 8) | b, otId, otName: e.bundle.trades.otName });
  mon.nickname = t.nick;
  party.push(mon);
  e.store.dispatch({ type: 'setParty', party }, { undoable: false });
  const dex = e.bundle.dexOrder[t.get];
  e.store.dispatch({ type: 'setPokedex', dex, seen: true, owned: true }, { undoable: false });
  if (TRADE_EVOLVERS.some((n) => c('pokemon', n) === t.get)) {
    // InGameTrade_CheckForTradeEvo: TryEvolvingMon with LINK_STATE_TRADING
    yield* evolutionAfterBattle(e, 1 << (party.length - 1), true, 0, undefined, true);
    env.playDefaultMusic();
  }
  e.screen.clear();
  yield* e.delayFrames(10);
  yield* env.printText('TradedForText');
  yield* env.printText(texts[3]); // TRADETEXT_THANKS
}
