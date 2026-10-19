/** Shared setup for overworld tests: a game state at a map position with a two-mon party. */
import { bundle } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { newGameState, type GameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import type { Facing } from '../src/world/movement';
import type { GameBundle } from '../src/data/schema';

export async function fieldAt(map: string, x: number, y: number, facing: Facing, edit?: (s: GameState, b: GameBundle) => void) {
  const b = await bundle();
  const st = newGameState(b, 0x77);
  st.player.map = c('map', map);
  st.player.x = x;
  st.player.y = y;
  st.player.facing = facing;
  const mk = (n: string, l: number) => makePartyMon(b, { species: c('pokemon', n), level: l, dvs: 0xffff, otId: st.player.id, otName: st.player.name });
  st.party = [mk('PIKACHU', 10), mk('PIDGEY', 7)];
  edit?.(st, b);
  const h = new Harness(b, st);
  h.engine.ram.debugNoWildEncounters = true;
  h.run(30);
  return h;
}

/** START → POKéMON → the mon in `slot` → its first field move. */
export function useFieldMove(h: Harness, slot: number): void {
  h.press('start', 2, 10);
  h.press('a', 2, 20); // POKéMON (no Pokédex yet)
  for (let i = 0; i < slot; i++) h.press('down', 2, 4);
  h.press('a', 2, 10);
  h.press('a', 2, 20); // the field move is listed first
}

