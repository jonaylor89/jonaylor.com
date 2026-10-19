/** Font and text-box graphics used by the Game Boy-style UI. */
import type { Rom } from '../Rom';
import { c, sym, symBank, toOffset } from '../symbols';
import { decodeString } from '../text';
import type { UiGraphics } from '../../data/schema';
import { decode2bpp } from './util';
import { CONSTANTS } from '../constants';

export function extractUiGraphics(rom: Rom): UiGraphics {
  const font = sym('FontGraphics');
  const fontLen = sym('FontGraphicsEnd') - font;
  const fontPixels: number[] = [];
  for (let i = 0; i < fontLen; i++) {
    const b = rom.u8(font + i);
    // 1bpp: set bits are drawn in the darkest color (3).
    for (let x = 0; x < 8; x++) fontPixels.push((b >> (7 - x)) & 1 ? 3 : 0);
  }
  const box = sym('TextBoxGraphics');
  const boxLen = sym('TextBoxGraphicsEnd') - box;
  const hp = sym('HpBarAndStatusGraphics');
  const hpLen = sym('HpBarAndStatusGraphicsEnd') - hp;
  return {
    font: { firstChar: 0x80, count: fontLen >> 3, pixels: fontPixels },
    fontExtra: { firstChar: 0x60, count: boxLen >> 4, pixels: decode2bpp(rom.slice(box, boxLen)) },
    hpBarAndStatus: { count: hpLen >> 4, pixels: decode2bpp(rom.slice(hp, hpLen)) },
    // Party menu icons: vSprites tiles as loaded by LoadMonPartySpriteGfx, and ICON_* by dex number
    partyIcons: (() => {
      const tiles = new Array<number>(128 * 64).fill(0);
      const tbl = sym('MonPartySpritePointers');
      for (let i = 0; i < 0x1e; i++) {
        const p = tbl + i * 6;
        const src = rom.u16(p);
        const count = rom.u8(p + 2);
        const bank = rom.u8(p + 3);
        const dest = (rom.u16(p + 4) - 0x8000) >> 4;
        const px = decode2bpp(rom.slice(toOffset(bank, src), count * 16));
        for (let k = 0; k < count * 64; k++) tiles[dest * 64 + k] = px[k];
      }
      const data = sym('MonPartyData');
      const byDex: number[] = [];
      for (let dex = 1; dex <= 151; dex++) {
        const byte = rom.u8(data + ((dex - 1) >> 1));
        byDex.push(dex & 1 ? byte >> 4 : byte & 0xf);
      }
      return { tiles, byDex };
    })(),
    // PokedexTileGraphics, loaded at $60 by LoadPokedexTilePatterns
    pokedexTiles: (() => {
      const a = sym('PokedexTileGraphics');
      const len = sym('PokedexTileGraphicsEnd') - a;
      return { count: len >> 4, pixels: decode2bpp(rom.slice(a, len)) };
    })(),
    // gfx/battle/balls.2bpp: ball, status ball, fainted ball, empty slot
    pokeballs: (() => {
      const a = sym('PokeballTileGraphics');
      const len = sym('PokeballTileGraphicsEnd') - a;
      return { count: len >> 4, pixels: decode2bpp(rom.slice(a, len)) };
    })(),
    // 16x16 bubbles, 4 tiles each (TL, TR, BL, BR), indexed by *_BUBBLE constants.
    edTile: (() => {
      const p = sym('ED_Tile');
      const px: number[] = [];
      for (let i = 0; i < 8; i++) {
        const b = rom.u8(p + i);
        for (let x = 0; x < 8; x++) px.push((b >> (7 - x)) & 1 ? 3 : 0);
      }
      return px;
    })(),
    // Printer_GetMonStats: gfx/printer/hp.1bpp and lv.1bpp (CopyVideoDataDouble)
    printerGlyphs: (() => {
      const one = (at: number) => {
        const px: number[] = [];
        for (let i = 0; i < 8; i++) {
          const b = rom.u8(at + i);
          for (let x = 0; x < 8; x++) px.push((b >> (7 - x)) & 1 ? 3 : 0);
        }
        return px;
      };
      return { hp: one(sym('GFX_ea563')), lv: one(sym('GFX_ea56b')) };
    })(),
    // LoadSlotMachineTiles: tiles 1 at BG $00, tiles 2 ($1c tiles, as copied) at OBJ $00 and BG $25
    slots: {
      tiles1: decode2bpp(rom.slice(sym('SlotMachineTiles1'), sym('SlotMachineTiles1End') - sym('SlotMachineTiles1'))),
      tiles2: decode2bpp(rom.slice(sym('SlotMachineTiles2'), 0x1c * 16)),
      map: [...rom.slice(sym('SlotMachineMap'), sym('SlotMachineMapEnd') - sym('SlotMachineMap'))],
      wheels: ['SlotMachineWheel1', 'SlotMachineWheel2', 'SlotMachineWheel3'].map((l) => [...rom.slice(sym(l), 36)]),
      multiplier: decodeString(rom, sym('CoinMultiplierSlotMachineText'), 12),
      rewards: ['SlotReward300Text', 'SlotReward100Text', 'SlotReward8Text', 'SlotReward15Text'].map((l) => decodeString(rom, sym(l), 4)),
    },
    // DisplayTitleScreen (engine/movie/title.asm, title_yellow.asm)
    title: (() => {
      const g = (from: string, to: string) => decode2bpp(rom.slice(sym(from), sym(to) - sym(from)));
      const bounce: [number, number][] = [];
      for (let p = sym('DisplayTitleScreen.TitleScreenPokemonLogoYScrolls'); rom.u8(p); p += 2) bounce.push([(rom.u8(p) << 24) >> 24, rom.u8(p + 1)]);
      const copyright: number[] = [];
      for (let p = sym('DisplayTitleScreen.tileScreenCopyrightTiles'); rom.u8(p) !== 0xff; p++) copyright.push(rom.u8(p));
      const eyes: [number, number, number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const p = sym('TitleScreenPikachuEyesOAMData') + i * 4;
        eyes.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2), rom.u8(p + 3)]);
      }
      return {
        copyrightLogo: decode2bpp(rom.slice(sym('NintendoCopyrightLogoGraphics'), 5 * 16)),
        nine: decode2bpp(rom.slice(sym('NineTile'), 16)),
        gameFreakLogo: decode2bpp(rom.slice(sym('GameFreakLogoGraphics'), 9 * 16)),
        pokemonLogo: g('PokemonLogoGraphics', 'PokemonLogoGraphicsEnd'),
        pokemonLogoCorner: g('PokemonLogoCornerGraphics', 'PokemonLogoCornerGraphicsEnd'),
        pikachuBG: g('TitlePikachuBGGraphics', 'TitlePikachuBGGraphicsEnd'),
        pikachuOB: g('TitlePikachuOBGraphics', 'TitlePikachuOBGraphicsEnd'),
        logoTilemap: [...rom.slice(sym('TitleScreenPokemonLogoTilemap'), 16 * 7)],
        bubbleTilemap: [...rom.slice(sym('TitleScreenPikaBubbleTilemap'), 7 * 4)],
        pikachuTilemap: [...rom.slice(sym('TitleScreenPikachuTilemap'), 12 * 9)],
        eyes,
        bounce,
        copyright,
      };
    })(),
    // DrawTrainerInfo / DrawBadges graphics (gfx/trainer_card.asm)
    trainerCard: {
      infoTiles: decode2bpp(rom.slice(sym('TrainerInfoTextBoxTileGraphics'), sym('TrainerInfoTextBoxTileGraphicsEnd') - sym('TrainerInfoTextBoxTileGraphics'))),
      blankNames: decode2bpp(rom.slice(sym('BlankLeaderNames'), 0x17 * 16)),
      badgeNumbers: decode2bpp(rom.slice(sym('BadgeNumbersTileGraphics'), 8 * 16)),
      facesAndBadges: decode2bpp(rom.slice(sym('GymLeaderFaceAndBadgeTileGraphics'), 64 * 16)),
      badgesText: [...rom.slice(sym('TrainerInfo_BadgesText'), 8)],
    },
    // Credits (engine/movie/credits.asm) and the copyright lines (LoadCopyrightTiles)
    credits: (() => {
      const order: number[] = [];
      for (let p = sym('CreditsOrder'); ; p++) {
        const v = (rom.u8(p) << 24) >> 24;
        order.push(v);
        if (v === c('credits', 'CRED_THE_END')) break;
      }
      const ptrs = sym('CreditsTextPointers');
      const bank = Math.floor(ptrs / 0x4000);
      const count = CONSTANTS.credits.NUM_CRED_STRINGS;
      const texts = Array.from({ length: count }, (_, i) => {
        const at = toOffset(bank, rom.u16(ptrs + i * 2));
        return { dx: (rom.u8(at) << 24) >> 24, text: decodeString(rom, at + 1, 80) };
      });
      const mons: number[] = [];
      for (let p = sym('CreditsMons'); mons.length < order.filter((v) => v === -1 || v === -2).length; p++) mons.push(rom.u8(p));
      const logo = sym('NintendoCopyrightLogoGraphics');
      const copyrightRows: number[][] = [[]];
      for (let p = sym('CopyrightTextString'); ; p++) {
        const b = rom.u8(p);
        if (b === 0x50) break;
        if (b === 0x4e) copyrightRows.push([]);
        else copyrightRows[copyrightRows.length - 1].push(b);
      }
      return {
        order,
        texts,
        mons,
        theEnd: decode2bpp(rom.slice(sym('TheEndGfx'), sym('TheEndGfxEnd') - sym('TheEndGfx'))),
        copyrightTiles: decode2bpp(rom.slice(logo, sym('TextBoxGraphics') + 0x10 - logo)),
        copyrightRows,
      };
    })(),
    // DisplayDiplomaTop / DisplayDiplomaBottom (engine/events/diploma2.asm)
    diploma: {
      tiles: decode2bpp(rom.slice(sym('DiplomaGraphics'), sym('DiplomaGraphicsEnd') - sym('DiplomaGraphics'))),
      pikachuMap: [...rom.slice(sym('DiplomaPikachuTiles'), 10 * 12)],
      congratulations: [...rom.slice(sym('CongratulationsTiles'), 11)],
      mewMap: [...rom.slice(sym('DiplomaMewTiles'), 4 * 5)],
      title: [...rom.slice(sym('DiplomaText'), 9)],
      player: decodeString(rom, sym('DiplomaPlayer'), 10),
      congrats: decodeString(rom, sym('DiplomaCongrats'), 80),
      gameFreak: decodeString(rom, sym('DiplomaGameFreak'), 12),
      playTime: decodeString(rom, sym('DiplomaPlayTime'), 12),
    },
    alphabets: {
      upper: [...rom.slice(sym('UpperCaseAlphabet'), 45)],
      lower: [...rom.slice(sym('LowerCaseAlphabet'), 45)],
      upperSwitch: decodeString(rom, sym('UpperCaseAlphabet') + 45),
      lowerSwitch: decodeString(rom, sym('LowerCaseAlphabet') + 45),
    },
    twoOptionMenus: (() => {
      const t = sym('TwoOptionMenuStrings');
      const bank = symBank('TwoOptionMenuStrings');
      const out = [];
      for (let i = 0; i < c('menu', 'NO_YES_MENU') + 1; i++) {
        const p = t + i * 5;
        const text = toOffset(bank, rom.u16(p + 3));
        out.push({ width: rom.u8(p), height: rom.u8(p + 1), blankLine: rom.u8(p + 2) !== 0, text: decodeString(rom, text, 40) });
      }
      return out;
    })(),
    emotionBubbles: {
      count: (c('script', 'FISH_BUBBLE') + 1) * 4,
      pixels: decode2bpp(rom.slice(sym('EmotionBubbles'), (c('script', 'FISH_BUBBLE') + 1) * 64)),
    },
  };
}
