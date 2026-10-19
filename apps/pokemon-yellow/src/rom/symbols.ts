/**
 * Address/label tables generated from the pret/pokeyellow build
 * (see tools/gen-reference.ts). These contain names and addresses only —
 * every byte of actual game data is read from the user's ROM.
 */
import symbolData from './generated/symbols.json';

export { CONSTANTS, c, constName, constEntries, type ConstGroup } from './constants';

const ROM = (symbolData as { rom: Record<string, number> }).rom;
const RAM = (symbolData as { ram: Record<string, number> }).ram;
export const TEXT_LABELS: readonly string[] = (symbolData as { textLabels: string[] }).textLabels;
/** Map label -> first trainer header label (from def_trainers). */
export const TRAINER_HEADER_LABELS: Record<string, string> = (symbolData as { trainerHeaders: Record<string, string> }).trainerHeaders;


/** Convert a banked GB address to a flat ROM offset. */
export function toOffset(bank: number, addr: number): number {
  if (addr < 0x4000) return addr;
  if (addr >= 0x8000) throw new Error(`address $${addr.toString(16)} is not in ROM`);
  return bank * 0x4000 + (addr - 0x4000);
}

/** Flat ROM offset -> [bank, address] */
export function fromOffset(offset: number): [number, number] {
  if (offset < 0x4000) return [0, offset];
  return [Math.floor(offset / 0x4000), 0x4000 + (offset % 0x4000)];
}

export function allRomLabels(): string[] {
  return Object.keys(ROM);
}

export function hasSymbol(name: string): boolean {
  return ROM[name] !== undefined;
}

/** ROM offset of a label. Throws loudly if the label is unknown. */
export function sym(name: string): number {
  const v = ROM[name];
  if (v === undefined) throw new Error(`unknown ROM symbol: ${name}`);
  return toOffset(v >>> 16, v & 0xffff);
}

export function symBank(name: string): number {
  const v = ROM[name];
  if (v === undefined) throw new Error(`unknown ROM symbol: ${name}`);
  return v >>> 16;
}

/** Address (in GB address space) of a WRAM/SRAM label. */
export function ramSym(name: string): number {
  const v = RAM[name];
  if (v === undefined) throw new Error(`unknown RAM symbol: ${name}`);
  return v & 0xffff;
}

let romByOffset: Map<number, string[]> | undefined;
/** All labels that point at a flat ROM offset (global labels first). */
export function labelsAt(offset: number): string[] {
  if (!romByOffset) {
    romByOffset = new Map();
    for (const [name, v] of Object.entries(ROM)) {
      const off = toOffset(v >>> 16, v & 0xffff);
      const list = romByOffset.get(off) ?? [];
      list.push(name);
      romByOffset.set(off, list);
    }
    for (const list of romByOffset.values()) list.sort((a, b) => Number(a.includes('.')) - Number(b.includes('.')));
  }
  return romByOffset.get(offset) ?? [];
}

let ramByAddr: Map<number, string> | undefined;
export function ramLabelAt(addr: number): string | undefined {
  if (!ramByAddr) {
    ramByAddr = new Map();
    for (const [name, v] of Object.entries(RAM)) {
      const a = v & 0xffff;
      if (!ramByAddr.has(a) || name.startsWith('w') && !ramByAddr.get(a)!.startsWith('w')) ramByAddr.set(a, name);
    }
  }
  return ramByAddr.get(addr);
}


let sortedOffsets: number[] | undefined;
/** Offset of the first label strictly after `offset` (used to size tables). */
export function nextLabelOffset(offset: number, includeLocal = false): number {
  if (!sortedOffsets || includeLocal) {
    const set = new Set<number>();
    for (const [name, v] of Object.entries(ROM)) {
      if (!includeLocal && name.includes('.')) continue;
      set.add(toOffset(v >>> 16, v & 0xffff));
    }
    const arr = [...set].sort((a, b) => a - b);
    if (includeLocal) return firstAfter(arr, offset);
    sortedOffsets = arr;
  }
  return firstAfter(sortedOffsets, offset);
}

function firstAfter(arr: number[], offset: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= offset) lo = mid + 1;
    else hi = mid;
  }
  // Labels never cross a bank boundary.
  const bankEnd = offset < 0x4000 ? 0x4000 : (Math.floor(offset / 0x4000) + 1) * 0x4000;
  return lo < arr.length ? Math.min(arr[lo], bankEnd) : bankEnd;
}

