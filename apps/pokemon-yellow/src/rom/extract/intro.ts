/**
 * The power-on sequence before the title screen (engine/movie/intro.asm,
 * splash.asm, intro_yellow.asm): the Game Freak shooting star and the Yellow
 * intro scenes.
 */
import type { Rom } from '../Rom';
import { sym } from '../symbols';
import { decode2bpp } from './util';
import { extractAnimTables } from './animTables';
import type { IntroData } from '../../data/schema';

export function extractIntro(rom: Rom): IntroData {
  const span = (from: string, to: string) => [...rom.slice(sym(from), sym(to) - sym(from))];
  const tiles = (from: string, to: string) => decode2bpp(rom.slice(sym(from), sym(to) - sym(from)));
  const oam = (label: string, end: string) => {
    const out: [number, number, number, number][] = [];
    for (let p = sym(label); p < sym(end); p += 4) out.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2), rom.u8(p + 3)]);
    return out;
  };
  // the waves of small stars: Y, X and the low attribute bits per star, $ff ends a wave
  const sbank = Math.floor(sym('SmallStarsWaveCoordsPointerTable') / 0x4000);
  const waves: [number, number, number][][] = [];
  for (let i = 0; i < 6; i++) {
    const at = sbank * 0x4000 + (rom.u16(sym('SmallStarsWaveCoordsPointerTable') + i * 2) - 0x4000);
    const wave: [number, number, number][] = [];
    for (let p = at; wave.length < 4 && rom.u8(p) !== 0xff; p += 3) wave.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2)]);
    waves.push(wave);
  }
  const moveAnim = sym('MoveAnimationTiles1');
  const speedBars: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const p = sym('YellowIntroFlyingSpeedBarData') + i * 3;
    speedBars.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2)]);
  }
  const g2 = tiles('YellowIntroGraphics2', 'YellowIntroGraphics2End');
  return {
    gameFreak: tiles('GameFreakIntro', 'GameFreakIntroEnd'),
    starTiles: [...decode2bpp(rom.slice(moveAnim + 3 * 16, 16)), ...decode2bpp(rom.slice(moveAnim + 19 * 16, 16))],
    fallingStar: tiles('FallingStar', 'FallingStarEnd'),
    logoOam: oam('GameFreakLogoOAMData', 'GameFreakLogoOAMDataEnd'),
    shootingStarOam: oam('GameFreakShootingStarOAMData', 'GameFreakShootingStarOAMDataEnd'),
    smallStarOam: oam('SmallStarsOAM', 'SmallStarsOAMEnd')[0],
    smallStarWaves: waves,
    graphics1: tiles('YellowIntroGraphics1', 'YellowIntroGraphics1End'),
    graphics2: g2.slice(0, g2.length - 64), // the last tile isn't copied
    clouds: tiles('YellowIntroCloudGFX', 'YellowIntroScene12'),
    tilemapSky: [...rom.slice(sym('Unkn_f9b6e'), 6 * 20)],
    tilemapCloud: [...rom.slice(sym('Unkn_f9be6'), 3 * 4)],
    tilemapSmall: [...rom.slice(sym('Unkn_f9bf2'), 2 * 2)],
    speedBars,
    thunderPals: [...rom.slice(sym('YellowIntroPalSequence_f9dd6'), sym('YellowIntroPalSequence_f9e0a') - sym('YellowIntroPalSequence_f9dd6'))],
    fadePals: [...rom.slice(sym('YellowIntroPalSequence_f9e0a'), sym('YellowIntroScene17') - sym('YellowIntroPalSequence_f9e0a'))],
    sineWave: span('YellowIntro_Copy8BitSineWave.SineWave', 'YellowIntro_Copy8BitSineWave.SineWaveEnd'),
    sine: Array.from({ length: 32 }, (_, i) => rom.u16(sym('Unkn_fa0aa') + i * 2)),
    anim: extractAnimTables(rom, {
      spawn: 'YellowIntro_AnimatedObjectSpawnStateData',
      spawnEnd: 'YellowIntro_AnimatedObjectJumptable',
      frames: 'YellowIntro_AnimatedObjectFramesData',
      oam: 'YellowIntro_AnimatedObjectOAMData',
    }),
  };
}
