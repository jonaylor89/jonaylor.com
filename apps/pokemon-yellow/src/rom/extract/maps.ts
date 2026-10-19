/**
 * Map headers, block data, connections, warps, signs, objects, text pointers.
 * Formats: macros/scripts/maps.asm, data/maps/** in pokeyellow.
 */
import type { Rom } from '../Rom';
import { c, constEntries, labelsAt, nextLabelOffset, toOffset, TRAINER_HEADER_LABELS, hasSymbol, sym, symBank, ramSym, fromOffset } from '../symbols';
import type { Direction, MapData, MapScriptOp, MapTextEntry, ObjectEvent } from '../../data/schema';
import type { TextCollector } from './texts';
import { assert } from './util';
import { labelFor } from '../text';

const TEXT_SCRIPTS: Record<number, MapTextEntry['kind']> = {
  0xff: 'pokecenter_nurse',
  0xfe: 'mart',
  0xfd: 'bills_pc',
  0xfc: 'players_pc',
  0xf9: 'pokecenter_pc',
  0xf7: 'prize_vendor',
  0xf6: 'cable_club_receptionist',
  0xf5: 'vending_machine',
};

export function extractMaps(rom: Rom, texts: TextCollector): Record<number, MapData> {
  const numMaps = c('map', 'NUM_MAPS');
  const pointers = rom.sym('MapHeaderPointers');
  const banks = rom.sym('MapHeaderBanks');
  const songs = rom.sym('MapSongBanks');
  const mapNames = new Map<number, string>();
  for (const [k, v] of constEntries('map')) {
    if (k.startsWith('NUM_') || k.startsWith('FIRST_') || mapNames.has(v)) continue;
    mapNames.set(v, k);
  }
  const sizes: Record<string, number> = {};
  for (const [k, v] of constEntries('map_size')) sizes[k] = v;

  const maps: Record<number, MapData> = {};
  for (let id = 0; id < numMaps; id++) {
    const constName = mapNames.get(id);
    if (!constName || constName.startsWith('UNUSED_MAP')) continue;
    const bank = rom.u8(banks + id);
    const header = toOffset(bank, rom.u16(pointers + id * 2));
    const headerLabel = labelsAt(header).find((l) => l.endsWith('_h'));
    assert(headerLabel, `map ${constName} header label`);
    const label = headerLabel.slice(0, -2);

    const r = rom.reader(header);
    const tileset = r.u8();
    const height = r.u8();
    const width = r.u8();
    // Some maps (e.g. the unused *_COPY ids) share headers; the constants record the intended size.
    if (sizes[`${constName}_WIDTH`] !== undefined) {
      assert(sizes[`${constName}_WIDTH`] === width && sizes[`${constName}_HEIGHT`] === height, `size of ${constName}`);
    }
    const blocksPtr = toOffset(bank, r.u16());
    const textPtrs = toOffset(bank, r.u16());
    const scriptPtr = toOffset(bank, r.u16());
    const connFlags = r.u8();
    const connections: MapData['connections'] = {};
    const dirs: [Direction, number][] = [
      ['north', 8],
      ['south', 4],
      ['west', 2],
      ['east', 1],
    ];
    for (const [dir, bit] of dirs) {
      if (!(connFlags & bit)) continue;
      const map = r.u8();
      r.u16(); // strip source pointer
      r.u16(); // strip destination pointer (wOverworldMap)
      r.u8(); // strip length
      r.u8(); // connected map width
      const yAlign = r.s8();
      const xAlign = r.s8();
      r.u16(); // window pointer
      const offset = (dir === "north" || dir === "south" ? -xAlign / 2 : -yAlign / 2) || 0;
      connections[dir] = { map, offset };
    }
    const objPtr = toOffset(bank, r.u16());

    const blocks = [...rom.slice(blocksPtr, width * height)];

    // ---- object data
    const o = rom.reader(objPtr);
    const borderBlock = o.u8();
    const warps = [];
    for (let i = 0, n = o.u8(); i < n; i++) {
      const y = o.u8();
      const x = o.u8();
      const destWarp = o.u8();
      const destMap = o.u8();
      warps.push({ x, y, destMap, destWarp });
    }
    const signs = [];
    for (let i = 0, n = o.u8(); i < n; i++) {
      const y = o.u8();
      const x = o.u8();
      const textId = o.u8();
      signs.push({ x, y, textId });
    }
    const objects: ObjectEvent[] = [];
    for (let i = 0, n = o.u8(); i < n; i++) {
      const sprite = o.u8();
      const y = o.u8() - 4;
      const x = o.u8() - 4;
      const movement = o.u8();
      const rangeOrDirection = o.u8();
      const tb = o.u8();
      const obj: ObjectEvent = { index: i + 1, sprite, x, y, movement, rangeOrDirection, textId: tb & 0x3f, kind: 'npc' };
      if (tb & 0x40) {
        const a = o.u8();
        const b = o.u8();
        if (a >= 200) {
          obj.kind = 'trainer';
          obj.trainerClass = a - 200;
          obj.trainerIndex = b;
        } else {
          obj.kind = 'pokemon';
          obj.species = a;
          obj.level = b;
        }
      } else if (tb & 0x80) {
        obj.kind = 'item';
        obj.item = o.u8();
      }
      objects.push(obj);
    }

    // ---- text pointers: the table runs until the next label.
    const textEntries = parseTextTable(rom, texts, bank, textPtrs, maxTextId(signs, objects), constName);
    const altTexts: Record<string, Record<number, MapTextEntry>> = {};
    for (const alt of [`${label}_TextPointers2`]) {
      if (hasSymbol(alt)) altTexts[alt] = parseTextTable(rom, texts, bank, sym(alt), 0, constName);
    }
    maps[id] = {
      id,
      constName,
      label,
      tileset,
      width,
      height,
      blocks,
      borderBlock,
      connections,
      warps,
      signs,
      objects,
      texts: textEntries,
      scriptLabel: labelFor(scriptPtr),
      trainerHeaders: extractTrainerHeaders(rom, label, texts, id),
      altTexts,
      ...(() => {
        const k = classifyMapScript(rom, scriptPtr);
        return { scriptKind: k.kind, ...(k.ops ? { scriptOps: k.ops } : {}) };
      })(),
      music: { id: rom.u8(songs + id * 2), bank: rom.u8(songs + id * 2 + 1) },
    };
  }
  return maps;
}

export interface ToggleableObject {
  map: number;
  object: number;
  initiallyVisible: boolean;
}

export function extractToggleableObjects(rom: Rom): ToggleableObject[] {
  const off = rom.sym('ToggleableObjectStates');
  const out: ToggleableObject[] = [];
  for (let p = off; ; p += 3) {
    const map = rom.u8(p);
    if (map === 0xff) break;
    out.push({ map, object: rom.u8(p + 1), initiallyVisible: rom.u8(p + 2) === c('toggle', 'ON') });
  }
  return out;
}

/** Offsets of every trainer header, for recognising `ld hl, <header>; call TalkToTrainer`. */
export const TRAINER_HEADER_AT = new Map<number, { map: number; header: number }>();

function maxTextId(signs: { textId: number }[], objects: { textId: number }[]): number {
  return Math.max(0, ...signs.map((s) => s.textId), ...objects.map((o) => o.textId));
}

/** A map text pointer table: words until the next label (at least `minCount` entries). */
function parseTextTable(rom: Rom, texts: TextCollector, bank: number, textPtrs: number, minCount: number, constName: string) {
  const out: Record<number, MapTextEntry> = {};
  const tableEnd = Math.min(nextLabelOffset(textPtrs), textPtrs + 2 * 64);
  const count = Math.max(minCount, (tableEnd - textPtrs) >> 1);
  for (let t = 1; t <= count; t++) {
    const raw = rom.u16(textPtrs + (t - 1) * 2);
    if (raw < 0x100 || raw >= 0x8000) {
      assert(t > minCount, `${constName} text ${t} pointer $${raw.toString(16)}`);
      break;
    }
    const target = toOffset(bank, raw);
    if (t > minCount && labelsAt(target).length === 0) break;
    out[t] = textEntryAt(rom, texts, target);
  }
  return out;
}

/** The text a text pointer points at: a TX_SCRIPT_* special or a text label. */
export function textEntryAt(rom: Rom, texts: TextCollector, target: number): MapTextEntry {
  const special = TEXT_SCRIPTS[rom.u8(target)];
  if (special === 'mart') {
    const n = rom.u8(target + 1);
    return { kind: 'mart', items: [...rom.slice(target + 2, n)] };
  }
  if (special) return { kind: special } as MapTextEntry;
  const lab = labelFor(target);
  texts.add(lab, target);
  return { kind: 'text', label: lab };
}

function extractTrainerHeaders(rom: Rom, mapLabel: string, texts: TextCollector, mapId: number) {
  const label = TRAINER_HEADER_LABELS[mapLabel];
  if (!label || !hasSymbol(label)) return [];
  const eventFlags = ramSym('wEventFlags');
  const [bank] = fromOffset(sym(label));
  const out = [];
  for (let p = sym(label); rom.u8(p) !== 0xff; p += 12) {
    TRAINER_HEADER_AT.set(p, { map: mapId, header: out.length });
    const bit = rom.u8(p);
    const text = (o: number) => {
      const target = toOffset(bank, rom.u16(p + o));
      const l = labelFor(target);
      texts.add(l, target);
      return l;
    };
    out.push({
      spriteIndex: bit,
      engageDistance: rom.u8(p + 1) >> 4,
      eventFlag: (rom.u16(p + 2) - eventFlags) * 8 + bit,
      beforeText: text(4),
      afterText: text(6),
      endBattleText: text(8),
    });
  }
  return out;
}

/** Recognise boilerplate map scripts from their instruction bytes. */
function classifyMapScript(rom: Rom, p: number): { kind: MapData['scriptKind']; ops?: MapScriptOp[] } {
  const auto = sym('EnableAutoTextBoxDrawing');
  const w = (o: number) => rom.u16(o);
  // Straight-line setup scripts: text box mode, wLastMap, the Pikachu map-script flag, link polling.
  {
    const ops: MapScriptOp[] = [];
    let q = p;
    let a = -1;
    let hl = -1;
    for (let i = 0; i < 16; i++) {
      const op = rom.u8(q);
      if (op === 0xcd || op === 0xc3) {
        const t = w(q + 1);
        if (t === auto) ops.push({ op: 'autoTextBox', on: true });
        else if (t === sym('DisableAutoTextBoxDrawing')) ops.push({ op: 'autoTextBox', on: false });
        else if (t !== sym('Serial_TryEstablishingExternallyClockedConnection')) break;
        q += 3;
        if (op === 0xc3) return { kind: 'simple', ops };
      } else if (op === 0x3e) {
        a = rom.u8(q + 1);
        q += 2;
      } else if (op === 0xea && w(q + 1) === ramSym('wLastMap') && a >= 0) {
        ops.push({ op: 'lastMap', map: a });
        q += 3;
      } else if (op === 0xea && w(q + 1) === ramSym('wAutoTextBoxDrawingControl') && a >= 0) {
        ops.push({ op: 'autoTextBoxControl', value: a });
        q += 3;
      } else if (op === 0x21) {
        hl = w(q + 1);
        q += 3;
      } else if (op === 0xcb && hl === ramSym('wPikachuMapScriptFlags') && ((rom.u8(q + 1) & 0xc7) === 0xc6 || (rom.u8(q + 1) & 0xc7) === 0x86)) {
        ops.push({ op: 'pikachuMapScript', on: (rom.u8(q + 1) & 0xc7) === 0xc6 });
        q += 2;
      } else if (op === 0xc9) {
        return { kind: 'simple', ops };
      } else break;
    }
  }
  // call EnableAutoTextBoxDrawing / ld hl, Headers / ld de, Pointers / ld a, [var]
  // call ExecuteCurMapScriptInTable / ld [var], a / ret
  const noAuto = sym('DisableAutoTextBoxDrawing');
  if (
    rom.u8(p) === 0xcd && (w(p + 1) === auto || w(p + 1) === noAuto) &&
    rom.u8(p + 3) === 0x21 && rom.u8(p + 6) === 0x11 && rom.u8(p + 9) === 0xfa &&
    rom.u8(p + 12) === 0xcd && w(p + 13) === sym('ExecuteCurMapScriptInTable') &&
    rom.u8(p + 15) === 0xea && rom.u8(p + 18) === 0xc9
  ) {
    const [bank] = fromOffset(p);
    const table = toOffset(bank, w(p + 7));
    const len = (nextLabelOffset(table) - table) >> 1;
    const std = ['CheckFightingMapTrainers', 'DisplayEnemyTrainerTextAndStartBattle', 'EndTrainerBattle'].map(sym);
    if (len === 3 && std.every((f, i) => w(table + i * 2) === f)) {
      return w(p + 1) === auto ? { kind: 'trainers' } : { kind: 'trainers', ops: [{ op: 'autoTextBox', on: false }] };
    }
  }
  return { kind: 'custom' };
}

/**
 * Special warps (data/maps/special_warps.asm): Fly / blackout destinations by
 * map, the dungeon warp list and the Safari Zone rest houses.
 */
export function extractSpecialWarps(rom: Rom) {
  // fly_warp: dw view pointer, db y, db x, db sub-block y, db sub-block x
  const readFlyWarp = (p: number) => ({ y: rom.u8(p + 2), x: rom.u8(p + 3) });
  const fly: Record<number, { x: number; y: number }> = {};
  const bank = symBank('FlyWarpDataPtr');
  // the table has no terminator: the fly_warp data follows it directly
  let end = Infinity;
  for (let p = sym('FlyWarpDataPtr'); p < end; p += 4) {
    const map = rom.u8(p);
    const at = toOffset(bank, rom.u16(p + 2));
    end = Math.min(end, at);
    fly[map] = readFlyWarp(at);
  }
  const dungeon: { map: number; warp: number; x: number; y: number }[] = [];
  const list = sym('DungeonWarpList');
  const data = sym('DungeonWarpData');
  for (let i = 0; rom.u8(list + i * 2) !== 0xff; i++) {
    dungeon.push({ map: rom.u8(list + i * 2), warp: rom.u8(list + i * 2 + 1), ...readFlyWarp(data + i * 6) });
  }
  const restHouses: number[] = [];
  for (let p = sym('SafariZoneRestHouses'); rom.u8(p) !== 0xff; p++) restHouses.push(rom.u8(p));
  return { fly, dungeon, restHouses };
}
