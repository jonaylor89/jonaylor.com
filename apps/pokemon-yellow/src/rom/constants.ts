/**
 * Constant names/values generated from pret/pokeyellow (tools/gen-reference.ts).
 * Names and numbers only — no game data.
 */
import constantData from './generated/constants.json';

export type ConstGroup = Record<string, number>;
export const CONSTANTS = constantData as Record<string, ConstGroup>;

/** Look up a constant value, e.g. c('map', 'PALLET_TOWN'). */
export function c(group: string, name: string): number {
  const v = CONSTANTS[group]?.[name];
  if (v === undefined) throw new Error(`unknown constant ${group}.${name}`);
  return v;
}

/** Find the first constant in a group whose value equals v. */
export function constName(group: string, v: number, filter?: (name: string) => boolean): string | undefined {
  const g = CONSTANTS[group];
  if (!g) throw new Error(`unknown constant group ${group}`);
  for (const [k, val] of Object.entries(g)) if (val === v && (!filter || filter(k))) return k;
  return undefined;
}

/** All constants in a group as [name, value] pairs sorted by value. */
export function constEntries(group: string, prefix = ''): [string, number][] {
  const g = CONSTANTS[group];
  if (!g) throw new Error(`unknown constant group ${group}`);
  return Object.entries(g)
    .filter(([k]) => k.startsWith(prefix))
    .sort((a, b) => a[1] - b[1]);
}
