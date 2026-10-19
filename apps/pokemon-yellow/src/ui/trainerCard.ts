/**
 * The trainer card (StartMenu_TrainerInfo, DrawTrainerInfo and DrawBadges in
 * engine/menus/start_sub_menus.asm and draw_badges.asm). The original shuffles
 * tile memory: the player's pic is drawn at (15,1) with its last two columns
 * wrapping onto the next rows (blanked again), then the pic tiles are shifted by
 * one column and the gym leader faces overwrite tiles $20-$5F. That is emulated
 * with a small BG tile memory so the result matches.
 */
import type { Co, Engine } from '../engine/Engine';
import { picPixels } from '../rom/extract/pics';
import { encodePlain, formatBCD } from './TextPrinter';
import { c } from '../rom/constants';

const W = 20;
const BLANK = 0x7f;

/** Draw the trainer card and wait for a button. */
export function* trainerCard(e: Engine): Co {
  const s = e.screen;
  const tc = e.bundle.ui.trainerCard;
  s.clear();
  s.fill(0, 0, 20, 18, BLANK);
  // BG tile memory for codes $00-$7F and the $D6-$DF font slots the card replaces
  const vram = new Map<number, number[]>();
  const tile = (px: number[], i: number) => px.slice(i * 64, i * 64 + 64);

  // DisplayPicCenteredOrUpperRight(RedPicFront, upper right): 7x7 tiles, column-major from $00
  const pic = e.bundle.pics.special.RedPicFront;
  if (pic) {
    const Wp = pic.width * 8;
    const src = picPixels(pic);
    const ox = (7 - pic.width) >> 1;
    const oy = 7 - pic.width;
    for (let col = 0; col < 7; col++)
      for (let row = 0; row < 7; row++) {
        const t = new Array<number>(64).fill(0);
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const px = (col - ox) * 8 + x;
            const py = (row - oy) * 8 + y;
            if (px >= 0 && py >= 0 && px < Wp && py < Wp) t[y * 8 + x] = src[py * Wp + px];
          }
        vram.set(col * 7 + row, t);
        // CopyUncompressedPicToHL from hlcoord 15, 1: columns past the right edge wrap
        const at = (1 + row) * W + 15 + col;
        s.put(at % W, Math.floor(at / W), col * 7 + row);
      }
  }
  // TrainerInfo_DrawVerticalLine x2: blank the wrapped columns
  for (let y = 2; y < 10; y++) {
    s.put(0, y, BLANK);
    s.put(1, y, BLANK);
  }
  // shift the pic tiles one column ($07.. → $00.., $1C tiles)
  for (let i = 0; i < 0x1c; i++) vram.set(i, vram.get(i + 7) ?? new Array(64).fill(0));
  for (let i = 0; i < 8; i++) vram.set(0x77 + i, tile(tc.infoTiles, i));
  for (let i = 0; i < 0x17; i++) vram.set(0x60 + i, tile(tc.blankNames, i));
  for (let i = 0; i < 8; i++) vram.set(0xd8 + i, tile(tc.badgeNumbers, i));
  for (let i = 0; i < 64; i++) vram.set(0x20 + i, tile(tc.facesAndBadges, i));
  vram.set(0xd6, tile(e.bundle.ui.fontExtra.pixels, 13)); // the colon
  vram.set(0xd7, tile(tc.infoTiles, 8)); // the background pattern
  for (const [code, px] of vram) s.setGlyphOverride(code, px);

  // TrainerInfo_DrawTextBox: 18x6 at (0,0) and 16x6 at (1,10)
  const box = (x: number, y: number, w: number) => {
    s.put(x, y, 0x79);
    for (let i = 1; i < w; i++) s.put(x + i, y, 0x7a);
    s.put(x + w, y, 0x7b);
    for (let r = 1; r <= 6; r++) {
      s.put(x, y + r, 0x7c);
      s.put(x + w, y + r, 0x78);
    }
    s.put(x, y + 7, 0x7d);
    for (let i = 1; i < w; i++) s.put(x + i, y + 7, 0x77);
    s.put(x + w, y + 7, 0x7e);
  };
  box(0, 0, 19);
  box(1, 10, 17);
  for (let y = 10; y < 18; y++) {
    s.put(0, y, 0xd7);
    s.put(19, y, 0xd7);
  }
  tc.badgesText.forEach((code, i) => s.put(6 + i, 9, code));
  const put = (x: number, y: number, str: string) =>
    str.split('{next}').forEach((line, i) => encodePlain(line).forEach((code, j) => s.put(x + j, y + i * 2, code)));
  put(2, 2, e.bundle.strings.TrainerInfo_NameMoneyTimeText);
  put(7, 2, e.state.player.name);
  put(8, 4, formatBCD(e.state.money, 3 | 0x80 | 0x40 | 0x20));
  const minutes = Math.floor(e.state.frames / 3600);
  const hours = String(Math.min(Math.floor(minutes / 60), 255));
  put(9, 6, hours);
  s.put(9 + hours.length, 6, 0xd6);
  put(10 + hours.length, 6, String(minutes % 60).padStart(2, '0'));

  drawBadges(e);
  // SetPal_TrainerCard: PAL_SET MEWMON/BADGE/REDMON/YELLOWMON, colors only for owned badges
  const P = (n: string) => c('palette', n);
  e.hooks.paletteLayout?.(
    [P('PAL_MEWMON'), P('PAL_BADGE'), P('PAL_REDMON'), P('PAL_YELLOWMON')],
    BADGE_BLOCKS.filter(([badge]) => (e.state.badges >> badge) & 1).map(([, pal, x0, y0, x1, y1]) => ({ pal, x0, y0, x1, y1 })),
  );
  yield* e.waitForTextScrollButtonPress();
  e.hooks.palette?.(undefined);
}

/** BlkPacket_TrainerCard: [badge, palette, x0, y0, x1, y1] (Rainbow Badge has three blocks) */
const BADGE_BLOCKS: [number, number, number, number, number, number][] = [
  [0, 0, 3, 12, 4, 13],
  [1, 1, 7, 12, 8, 13],
  [2, 3, 11, 12, 12, 13],
  [3, 2, 16, 11, 17, 12],
  [3, 1, 14, 13, 15, 13],
  [3, 3, 16, 13, 17, 13],
  [4, 2, 3, 15, 4, 16],
  [5, 3, 7, 15, 8, 16],
  [6, 2, 11, 15, 12, 16],
  [7, 1, 15, 15, 16, 16],
];

/** DrawBadges: the 4x2 faces, each replaced by its badge once obtained. */
function drawBadges(e: Engine): void {
  const s = e.screen;
  const faces = [0x20, 0x28, 0x30, 0x38, 0x40, 0x48, 0x50, 0x58];
  const owned = faces.map((_, i) => (e.state.badges >> i) & 1);
  const tiles = faces.map((t, i) => (owned[i] ? t + 4 : t));
  let number = 0xd8;
  let name = 0x60;
  let k = 0;
  for (const row of [11, 14]) {
    for (let n = 0; n < 4; n++, k++) {
      const x = 2 + n * 4;
      s.put(x, row, number++);
      if (!owned[k]) {
        s.put(x + 1, row, name);
        s.put(x + 2, row, name + 1);
      }
      name += 2;
      const t = tiles[k];
      s.put(x + 1, row + 1, t);
      s.put(x + 2, row + 1, t + 1);
      s.put(x + 1, row + 2, t + 2);
      s.put(x + 2, row + 2, t + 3);
    }
  }
}
