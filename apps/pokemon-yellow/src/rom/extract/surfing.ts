/**
 * Data for the Surfing Pikachu minigame (engine/minigame/surfing_pikachu.asm)
 * and its printed high score (engine/printer/printer.asm): graphics,
 * tilemaps, the animated-object tables, the wave course data and the small
 * inline tile strings. Wave functions are read from their code: each is
 * `ld bc, heights / ld de, pattern / jp Advance|Reset` (or `ret`).
 */
import type { Rom } from '../Rom';
import { labelsAt, sym } from '../symbols';
import { decode2bpp } from './util';
import { decodeString } from '../text';
import { extractAnimTables } from './animTables';
import type { SurfingData } from '../../data/schema';

export function extractSurfing(rom: Rom): SurfingData {
  const bank = (label: string) => Math.floor(sym(label) / 0x4000);
  const ptr = (b: number, p: number) => b * 0x4000 + (p - 0x4000);
  const bytes = (label: string, n: number) => [...rom.slice(sym(label), n)];
  const span = (from: string, to: string) => bytes(from, sym(to) - sym(from));
  const tiles = (label: string, n: number) => decode2bpp(rom.slice(sym(label), n * 16));

  const { spawn, frames, oam } = extractAnimTables(rom, {
    spawn: 'SurfingPikachuObjectSpawnData',
    spawnEnd: 'SurfingPikachuObjectCallbacks',
    frames: 'SurfingPikachuFrames',
    oam: 'SurfingPikachuOAMData',
  });

  // wave functions
  const wb = bank('SurfingMinigame_GetWaveDataPointers');
  const wt = sym('SurfingMinigame_GetWaveDataPointers.WaveFunctions');
  const waveFunctions: SurfingData['waveFunctions'] = [];
  for (let p = wt; p < sym('SurfingMinigame_ChooseNextWaveSequence'); p += 2) {
    const at = ptr(wb, rom.u16(p));
    if (labelsAt(at).includes('SurfingMinigame_ChooseNextWaveSequence')) {
      waveFunctions.push({ kind: 'choose' });
      continue;
    }
    if (rom.u8(at) !== 0x01 || rom.u8(at + 3) !== 0x11) throw new Error(`unexpected wave function at ${at.toString(16)}`);
    const c = rom.u8(at + 1);
    const b = rom.u8(at + 2);
    const pattern = [...rom.slice(ptr(wb, rom.u16(at + 4)), 8)];
    const op = rom.u8(at + 6);
    let next: 'advance' | 'reset' | 'stay' = 'stay';
    if (op === 0xc3) {
      const target = labelsAt(ptr(wb, rom.u16(at + 7)));
      next = target.includes('SurfingMinigame_ResetWaveSequence') ? 'reset' : 'advance';
    }
    waveFunctions.push({ kind: 'pattern', heights: [b, c], pattern, next });
  }

  const sine: number[] = [];
  for (let i = 0; i < 32; i++) sine.push(rom.u16(sym('SurfingPikachu_Sine.SineWave') + i * 2));
  const hs = (l: string) => decodeString(rom, sym(l), 20);

  return {
    graphics1: tiles('SurfingPikachu1Graphics1', 80),
    graphics2: tiles('SurfingPikachu1Graphics2', 256),
    graphics3: tiles('SurfingPikachu1Graphics3', 144),
    highScoreGraphics: decode2bpp(rom.slice(sym('SurfingPikachu2Graphics'), sym('SurfingPikachu2GraphicsEnd') - sym('SurfingPikachu2Graphics'))),
    beachIntro: span('SurfingMinigame_BeachIntroTilemap', 'SurfingMinigame_BeachIntroTilemapEnd'),
    useControlPad: span('SurfingMinigame_UseControlPadTilemap', 'SurfingMinigame_UseControlPadTilemapEnd'),
    toSurfRad: span('SurfingMinigame_ToSurfRadTilemap', 'SurfingMinigame_ToSurfRadTilemapEnd'),
    title: span('SurfingMinigame_TitleTilemap', 'SurfingMinigame_TitleTilemapEnd'),
    beachOutro: span('SurfingMinigame_DrawResultsScreen.BeachOutroTilemap', 'SurfingMinigame_DrawResultsScreen.BeachOutroTilemapEnd'),
    statusBar: bytes('SurfingPikachuStatusBarTiles', 9),
    metatiles: span('SurfingMinigame_BGMetatileTable', 'SurfingMinigameWavePattern00'),
    waveSequenceStarts: bytes('SurfingMinigame_WaveSequenceStarts', 8),
    waveFunctions,
    lyInitialSine: span('SurfingMinigame_LYOverridesInitialSineWave', 'SurfingMinigame_LYOverridesInitialSineWaveEnd'),
    sine,
    tempos: [0, 1, 2, 3, 4].map((i) => rom.u16(sym('SurfingMinigame_UpdateMusicTempo.Tempos') + i * 2)),
    spawn,
    frames,
    oam,
    strings: {
      hiScore: span('SurfingMinigame_PrintTextHiScore.Hi_Score', 'SurfingMinigame_PrintTextHiScore.Hi_ScoreEnd'),
      hpLeft: span('SurfingMinigame_WriteHPLeft.HP_Left', 'SurfingMinigame_WriteHPLeft.HP_LeftEnd'),
      radness: span('SurfingMinigame_WriteRadness.Radness', 'SurfingMinigame_WriteRadness.RadnessEnd'),
      total: span('SurfingMinigame_WriteTotal.Total', 'SurfingMinigame_WriteTotal.TotalEnd'),
    },
    highScore: {
      tilemap1: bytes('Printer_PrepareSurfingMinigameHighScoreTileMap.Tilemap1', 3 * 8),
      tilemap2: bytes('Printer_PrepareSurfingMinigameHighScoreTileMap.Tilemap2', 6 * 16),
      pikachusBeach: hs('Printer_PrepareSurfingMinigameHighScoreTileMap.PikachusBeachString'),
      hiScore: hs('Printer_PrepareSurfingMinigameHighScoreTileMap.HiScoreString'),
      points: hs('Printer_PrepareSurfingMinigameHighScoreTileMap.PointsString'),
    },
  };
}
