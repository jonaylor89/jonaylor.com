import type { Co } from '../engine/Engine';
import type { ScriptEnv } from '../engine/ScriptEnv';
import type { MapTextEntry } from '../data/schema';

export type ScriptFn = (e: ScriptEnv) => Co;

/** A ported map: its <Map>_Script and the text_asm routines in its text pointer table. */
export interface MapScript {
  /** Map constant, e.g. 'PALLET_TOWN'. */
  map: string;
  /** <Map>_Script: runs every overworld loop iteration while the player is not mid-step. */
  run?: ScriptFn;
  /** text_asm handlers keyed by the label of the text they belong to. */
  texts?: Record<string, ScriptFn>;
}

export type SpecialTextScript = (e: ScriptEnv, entry: MapTextEntry) => Co<boolean | void>;

export interface ScriptRegistry {
  maps: Record<string, MapScript>;
  /** text_asm handlers shared across maps (home bank texts). */
  texts: Record<string, ScriptFn>;
  /** Label patterns for text_asm routines shared by many maps (e.g. every Pokécenter's Chansey). */
  patterns?: [RegExp, ScriptFn][];
  /** TX_SCRIPT_* handlers (Pokécenter nurse, marts, PCs, ...). */
  specials: Partial<Record<MapTextEntry['kind'], SpecialTextScript>>;
  /** Hidden-event routines that live in map scripts (keyed by the routine's label). */
  hidden?: Record<string, import('../engine/hiddenEvents').HiddenEventFn>;
}

/** Helper: call one of a map's script pointer functions by index (CallFunctionInTable). */
export function* callScript(e: ScriptEnv, table: ScriptFn[]): Co {
  const fn = table[e.curScript];
  if (!fn) throw new Error(`script index ${e.curScript} out of range`);
  yield* fn(e);
}
