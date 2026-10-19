/**
 * Port of UpdateMovingBgTiles (home/vcopy.asm): water tile $14 shifts one
 * pixel every 20 frames (4 steps right, 4 steps left), and in
 * TILEANIM_WATER_FLOWER tilesets tile $03 cycles through FlowerTile1-3.
 */
import type { TilesetData } from '../data/schema';
import type { TileAtlas } from './textures';
import { c } from '../rom/constants';

const WATER_TILE = 0x14;
const FLOWER_TILE = 0x03;

export class TileAnimator {
  private counter1 = 0;
  private counter2 = 0;
  private water: number[];
  private readonly mode: number;

  constructor(
    private readonly ts: TilesetData,
    private readonly atlas: TileAtlas,
    private readonly flowers: number[][] = [],
  ) {
    this.mode = ts.animation;
    this.water = ts.tilePixels.slice(WATER_TILE * 64, WATER_TILE * 64 + 64);
  }

  tick(frames: number): void {
    if (this.mode === c('map_data', 'TILEANIM_NONE')) return;
    for (let i = 0; i < frames; i++) this.step();
  }

  private step(): void {
    this.counter1++;
    if (this.counter1 < 20) return;
    if (this.counter1 === 21) {
      this.counter1 = 0;
      const sel = this.counter2 & 3;
      const tile = this.flowers[sel < 2 ? 0 : sel === 2 ? 1 : 2];
      if (tile) this.atlas.drawTile(FLOWER_TILE, tile);
      return;
    }
    this.counter2 = (this.counter2 + 1) & 7;
    const left = (this.counter2 & 4) !== 0;
    const next = new Array<number>(64);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        // rlca shifts pixels left (wrapping), rrca shifts right
        const src = left ? (x + 1) % 8 : (x + 7) % 8;
        next[y * 8 + x] = this.water[y * 8 + src];
      }
    this.water = next;
    this.atlas.drawTile(WATER_TILE, next);
    if (this.mode === c('map_data', 'TILEANIM_WATER')) this.counter1 = 0;
  }
}
