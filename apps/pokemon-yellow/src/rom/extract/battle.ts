/** Battle engine data tables (all read from the ROM by label). */
import type { Rom } from '../Rom';
import type { GameBundle } from '../../data/schema';
import { labelsAt, ramSym, sym, symBank, toOffset } from '../symbols';
import { CONSTANTS } from '../constants';
import { decode2bpp, readUntil } from './util';
import { decodeString } from '../text';

export function extractBattleData(rom: Rom): GameBundle['battle'] {
  const list = (label: string) => readUntil(rom, sym(label));
  const ratios: [number, number][] = [];
  const r = sym('StatModifierRatios');
  for (let i = 0; i < 13; i++) ratios.push([rom.u8(r + i * 2), rom.u8(r + i * 2 + 1)]);
  // SpecialTrainerMoves: class, number, then (party slot, move slot, move)* 0, ..., $ff
  const specialTrainerMoves: GameBundle['battle']['specialTrainerMoves'] = [];
  for (let p = sym('SpecialTrainerMoves'); rom.u8(p) !== 0xff; ) {
    const entry = { trainerClass: rom.u8(p), trainerNo: rom.u8(p + 1), moves: [] as { mon: number; slot: number; move: number }[] };
    p += 2;
    while (rom.u8(p) !== 0) {
      entry.moves.push({ mon: rom.u8(p), slot: rom.u8(p + 1), move: rom.u8(p + 2) });
      p += 3;
    }
    p++;
    specialTrainerMoves.push(entry);
  }
  // 1bpp HUD tiles, expanded to pixel indices (set bit = color 3)
  const oneBpp = (start: string, end: string) => {
    const a = sym(start);
    const len = sym(end) - a;
    const px: number[] = [];
    for (let i = 0; i < len; i++) {
      const b = rom.u8(a + i);
      for (let x = 0; x < 8; x++) px.push((b >> (7 - x)) & 1 ? 3 : 0);
    }
    return px;
  };
  // MoveGrammar: groups of move ids separated by 0, terminated by $ff (GetMoveGrammar)
  const moveGrammar: number[][] = [[]];
  for (let p = sym('MoveGrammar'); rom.u8(p) !== 0xff; p++) {
    const v = rom.u8(p);
    if (v === 0) moveGrammar.push([]);
    else moveGrammar[moveGrammar.length - 1].push(v);
  }
  // TrainerAIPointers: per class, db count / dw routine
  const numClasses = Object.keys(CONSTANTS.trainer ?? {}).length;
  void numClasses;
  const trainerAI: { count: number; routine: string }[] = [];
  const aiBank = symBank('TrainerAIPointers');
  const aiEnd = sym('JugglerAI');
  for (let p = sym('TrainerAIPointers'); p < aiEnd; p += 3) {
    const ptr = rom.u16(p + 1);
    const label = labelsAt(toOffset(aiBank, ptr)).find((l) => /AI$/.test(l));
    if (!label) throw new Error(`TrainerAIPointers: no AI routine label at $${ptr.toString(16)}`);
    trainerAI.push({ count: rom.u8(p), routine: label });
  }
  // engine/events/pikachu_happiness.asm tables
  const hc = sym('HappinessChangeTable');
  const happinessChange: number[][] = [];
  for (let i = 0; i < 11; i++) happinessChange.push([0, 1, 2].map((j) => rom.u8(hc + i * 3 + j)));
  const pm = sym('PikachuMoods');
  const pikachuMoods = Array.from({ length: 11 }, (_, i) => rom.u8(pm + i));
  // MonsterSprite tiles 0-7: the Substitute doll (AnimationSubstitute)
  const ms = sym('MonsterSprite');
  const substituteTiles = decode2bpp(rom.slice(ms, 8 * 16));
  // engine/battle/battle_transitions.asm data
  const dungeon1 = readUntil(rom, sym('DungeonMaps1'));
  const dungeon2: [number, number][] = [];
  for (let p = sym('DungeonMaps2'); rom.u8(p) !== 0xff; p += 2) dungeon2.push([rom.u8(p), rom.u8(p + 1)]);
  const circleLabels = [1, 2, 3, 4, 5].map((n) => `BattleTransition_CircleData${n}`);
  const circleData = circleLabels.map((l) => {
    const out: number[] = [];
    for (let p = sym(l); ; p++) {
      const v = rom.u8(p);
      if (v === 0xff) break;
      out.push(v);
    }
    return out;
  });
  const tileMap = ramSym('wTileMap');
  const bankOf = symBank('BattleTransition_HalfCircle1');
  const halfCircle = (label: string) =>
    Array.from({ length: 10 }, (_, i) => {
      const p = sym(label) + i * 5;
      const ptr = toOffset(bankOf, rom.u16(p + 1));
      const coord = rom.u16(p + 3) - tileMap;
      return { right: rom.u8(p) === 1, data: circleLabels.findIndex((l) => sym(l) === ptr), x: coord % 20, y: Math.floor(coord / 20) };
    });
  const flash: number[] = [];
  for (let p = sym('BattleTransition_FlashScreenPalettes'); rom.u8(p) !== 1; p++) flash.push(rom.u8(p));
  const transitions = { dungeon1, dungeon2, circleData, halfCircle1: halfCircle('BattleTransition_HalfCircle1'), halfCircle2: halfCircle('BattleTransition_HalfCircle2'), flash };
  // gfx/font/P.1bpp: the bold P of "PP" on the status screen
  const pTile: number[] = [];
  for (let i = 0; i < 8; i++) {
    const v = rom.u8(sym('PTile') + i);
    for (let x = 0; x < 8; x++) pTile.push((v >> (7 - x)) & 1 ? 3 : 0);
  }
  // field moves (engine/menus/text_box.asm) and the START menu's usable item lists
  const fieldMoves: { move: number; name: string; x: number }[] = [];
  const names: string[] = [];
  for (let p = sym('FieldMoveNames'), i = 0; i < 9; i++) {
    const n = decodeString(rom, p, 16);
    names.push(n);
    while (rom.u8(p) !== 0x50) p++;
    p++;
  }
  for (let p = sym('FieldMoveDisplayData'); rom.u8(p) !== 0xff; p += 3) {
    fieldMoves.push({ move: rom.u8(p), name: names[rom.u8(p + 1) - 1], x: rom.u8(p + 2) });
  }
  const usableParty = readUntil(rom, sym('UsableItems_PartyMenu'));
  const usableCloseMenu = readUntil(rom, sym('UsableItems_CloseMenu'));
  return {
    fieldMoves,
    usableParty,
    usableCloseMenu,
    pTile,
    transitions,
    substituteTiles,
    happinessChange,
    pikachuMoods,
    moveGrammar,
    trainerAI,
    residualEffects1: list('ResidualEffects1'),
    residualEffects2: list('ResidualEffects2'),
    // SpecialEffects falls through into SpecialEffectsCont
    specialEffects: list('SpecialEffects'),
    specialEffectsCont: list('SpecialEffectsCont'),
    alwaysHappenSideEffects: list('AlwaysHappenSideEffects'),
    setDamageEffects: list('SetDamageEffects'),
    highCriticalMoves: list('HighCriticalMoves'),
    statModifierRatios: ratios,
    specialTrainerMoves,
    hudTiles1: oneBpp('BattleHudTiles1', 'BattleHudTiles1End'),
    hudTiles23: oneBpp('BattleHudTiles2', 'BattleHudTiles3End'),
  };
}
