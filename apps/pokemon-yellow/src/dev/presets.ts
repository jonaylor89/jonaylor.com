/** Destructive, explicitly labelled debug fixtures, not gameplay progression.
 * Names/IDs resolve against the ROM references; no ROM assets are embedded.
 */
import type { GameBundle } from '../data/schema';
import { c } from '../rom/constants';
import { newGameState, type GameState } from '../game/state';
import { makePartyMon, healMon } from '../game/pokemon';
import type { Engine } from '../engine/Engine';

const opening = ['EVENT_OAK_APPEARED_IN_PALLET', 'EVENT_FOLLOWED_OAK_INTO_LAB', 'EVENT_FOLLOWED_OAK_INTO_LAB_2', 'EVENT_OAK_ASKED_TO_CHOOSE_MON', 'EVENT_GOT_STARTER', 'EVENT_BATTLED_RIVAL_IN_OAKS_LAB', 'EVENT_GOT_OAKS_PARCEL', 'EVENT_OAK_GOT_PARCEL', 'EVENT_GOT_POKEDEX'];
const leaders = ['EVENT_BEAT_BROCK', 'EVENT_BEAT_MISTY', 'EVENT_BEAT_LT_SURGE', 'EVENT_BEAT_ERIKA', 'EVENT_BEAT_KOGA', 'EVENT_BEAT_SABRINA', 'EVENT_BEAT_BLAINE', 'EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI'];
const rocket = ['EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES', 'EVENT_BEAT_GHOST_MAROWAK', 'EVENT_RESCUED_MR_FUJI', 'EVENT_RESCUED_MR_FUJI_2', 'EVENT_GOT_POKE_FLUTE', 'EVENT_BEAT_SILPH_CO_RIVAL', 'EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES', 'EVENT_BEAT_SILPH_CO_GIOVANNI'];
interface Preset {
  id: string; label: string; map: string; x: number; y: number;
  badges: number; events: string[]; script?: string; emptyParty?: boolean;
}
export const STORY_PRESETS: readonly Preset[] = [
  { id: 'new', label: 'New game', map: 'REDS_HOUSE_2F', x: 3, y: 6, badges: 0, events: [], emptyParty: true },
  { id: 'pokedex', label: 'Pokédex / Brock', map: 'PEWTER_GYM', x: 4, y: 2, badges: 0, events: opening },
  { id: 'three-badges', label: 'Three badges / Celadon', map: 'CELADON_CITY', x: 20, y: 18, badges: 7, events: [...opening, ...leaders.slice(0, 3), 'EVENT_GOT_HM01'] },
  { id: 'silph', label: 'Silph cleared / Fuchsia', map: 'FUCHSIA_CITY', x: 20, y: 20, badges: 15, events: [...opening, ...leaders.slice(0, 4), ...rocket, 'EVENT_GOT_HM01'] },
  { id: 'seven-badges', label: 'Seven badges / Viridian', map: 'VIRIDIAN_CITY', x: 18, y: 8, badges: 127, events: [...opening, ...leaders.slice(0, 7), ...rocket, 'EVENT_GOT_HM01'] },
  { id: 'league', label: 'Eight badges / League', map: 'INDIGO_PLATEAU_LOBBY', x: 7, y: 8, badges: 255, events: [...opening, ...leaders, ...rocket, 'EVENT_GOT_HM01'] },
  { id: 'postgame', label: 'Post-game / Cerulean', map: 'CERULEAN_CITY', x: 18, y: 16, badges: 255, events: [...opening, ...leaders, ...rocket, 'EVENT_GOT_HM01'] },
];
export const CUTSCENE_PRESETS: readonly Preset[] = [
  { id: 'oak', label: 'Oak stops the player', map: 'PALLET_TOWN', x: 10, y: 0, badges: 0, events: [], emptyParty: true },
  { id: 'bill', label: 'Bill’s Cell Separator', map: 'BILLS_HOUSE', x: 4, y: 5, badges: 3, events: [...opening, ...leaders.slice(0, 2)] },
  { id: 'ship', label: 'S.S. Anne departure', map: 'VERMILION_DOCK', x: 14, y: 2, badges: 3, events: [...opening, ...leaders.slice(0, 2), 'EVENT_GOT_HM01'] },
  { id: 'champion', label: 'Champion → Oak → Hall of Fame', map: 'CHAMPIONS_ROOM', x: 4, y: 7, badges: 255, events: [...opening, ...leaders, ...rocket], script: 'SCRIPT_CHAMPIONSROOM_PLAYER_ENTERS' },
  { id: 'hall', label: 'Hall of Fame ceremony / credits', map: 'HALL_OF_FAME', x: 4, y: 7, badges: 255, events: [...opening, ...leaders, ...rocket] },
];
/** Retain legal earlier-level attacks: a freshly generated Lv100 Mewtwo's
 * last four level-up moves are all non-damaging in Gen 1. */
export function makeQaParty(bundle: GameBundle, otId: number, otName: string) {
  const mon = makePartyMon(bundle, { species: c('pokemon', 'MEWTWO'), level: 100, dvs: 0xffff, otId, otName });
  mon.moves = [c('move', 'PSYCHIC_M'), c('move', 'SWIFT'), c('move', 'RECOVER'), c('move', 'AMNESIA')];
  healMon(bundle, mon);
  return [mon];
}
export function presetState(bundle: GameBundle, id: string, seed = 7): GameState {
  const preset = [...STORY_PRESETS, ...CUTSCENE_PRESETS].find((p) => p.id === id);
  if (!preset) throw new Error(`unknown story preset ${id}`);
  const s = newGameState(bundle, seed);
  Object.assign(s.player, { map: c('map', preset.map), x: preset.x, y: preset.y, lastMap: c('map', 'PALLET_TOWN') });
  s.badges = preset.badges;
  for (const name of preset.events) { const flag = c('event', name); s.eventFlags[flag >> 3] |= 1 << (flag & 7); }
  if (preset.script) s.mapScripts[s.player.map] = c('map_script', preset.script);
  if (preset.events.includes('EVENT_GOT_POKEDEX')) {
    s.mapScripts[c('map', 'PALLET_TOWN')] = c('map_script', 'SCRIPT_PALLETTOWN_DAISY');
    s.mapScripts[c('map', 'OAKS_LAB')] = c('map_script', 'SCRIPT_OAKSLAB_NOOP');
    s.vars.wPlayerStarter = c('pokemon', 'PIKACHU');
    s.vars.wRivalStarter = c('pokemon', 'RIVAL_STARTER_JOLTEON');
    s.vars.wBeatGymFlags = s.badges;
    for (const name of ['TOGGLE_PALLET_TOWN_OAK', 'TOGGLE_OAKS_LAB_OAK_2', 'TOGGLE_OAKS_LAB_RIVAL', 'TOGGLE_STARTER_BALL_1']) {
      s.objectVisible[c('toggle', name)] = false;
    }
    s.objectVisible[c('toggle', 'TOGGLE_OAKS_LAB_OAK_1')] = true;
  }
  if (!preset.emptyParty) {
    s.party = makeQaParty(bundle, s.player.id, s.player.name);
    s.bag = [{ item: c('item', 'FULL_RESTORE'), qty: 20 }];
    if (preset.events.includes('EVENT_GOT_HM01')) s.bag.push({ item: c('item', 'HM_CUT'), qty: 1 });
    s.options.textSpeed = 'fast'; s.options.battleAnimation = false; s.options.battleStyle = 'set';
  }
  if (id === 'postgame') {
    s.objectVisible[c('toggle', 'TOGGLE_CERULEAN_CAVE_GUY')] = false;
    s.hallOfFame = [s.party.map((m) => ({ species: m.species, level: m.level, nick: m.nickname }))];
  }
  return s;
}
export function applyPreset(engine: Engine, id: string): void {
  engine.store.dispatch({ type: 'replaceState', state: presetState(engine.bundle, id) });
  engine.reload();
  if (id === 'ship') engine.ram.destinationWarpId = 1;
}
export function spawnEncounter(engine: Engine, species: number, level: number): void {
  if (!engine.bundle.species[species] || !Number.isInteger(level) || level < 1 || level > 100) throw new Error('Choose a valid species and level 1–100.');
  if (engine.ram.isInBattle || engine.ram.curOpponent) throw new Error('Finish the current encounter first.');
  if (!engine.state.party.length) throw new Error('A party Pokémon is needed first.');
  engine.ram.curOpponent = species;
  engine.ram.curEnemyLevel = level;
}
