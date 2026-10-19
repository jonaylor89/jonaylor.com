/** Builds GPU textures from ROM-derived pixel data and a 4-color palette. */
import * as THREE from 'three';
import type { OverworldSprite, TilesetData } from '../data/schema';
import type { RGB } from './palette';

export const ATLAS_COLS = 16;

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function pixelTexture(canvas: OffscreenCanvas | HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface TileAtlas {
  texture: THREE.Texture;
  /** UV rect [u0, v0, u1, v1] for a tile id. */
  uv(tile: number): [number, number, number, number];
  /** Redraw one tile (tile animations: water, flowers). */
  drawTile(tile: number, pixels: ArrayLike<number>): void;
  /** Redraw every tile, as currently drawn, with other colors (palette fades). */
  recolor(colors: RGB[]): void;
}

export function buildTileAtlas(ts: TilesetData, colors: RGB[]): TileAtlas {
  const rows = Math.ceil(ts.tileCount / ATLAS_COLS);
  const w = ATLAS_COLS * 8;
  const h = rows * 8;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(w, h);
  // the color index of every pixel as drawn (tile animations included), for recoloring
  const indices = new Uint8Array(ts.tileCount * 64);
  const put = (tile: number, px: ArrayLike<number>, target: ImageData, ox: number, oy: number) => {
    for (let p = 0; p < 64; p++) indices[tile * 64 + p] = px[p];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const col = colors[px[y * 8 + x]];
        const i = ((oy + y) * target.width + ox + x) * 4;
        target.data[i] = col[0];
        target.data[i + 1] = col[1];
        target.data[i + 2] = col[2];
        target.data[i + 3] = 255;
      }
  };
  for (let t = 0; t < ts.tileCount; t++) {
    put(t, ts.tilePixels.slice(t * 64, t * 64 + 64), img, (t % ATLAS_COLS) * 8, Math.floor(t / ATLAS_COLS) * 8);
  }
  ctx.putImageData(img, 0, 0);
  const texture = pixelTexture(canvas);
  const inset = 0.02;
  return {
    texture,
    uv(tile) {
      const x = (tile % ATLAS_COLS) * 8;
      const y = Math.floor(tile / ATLAS_COLS) * 8;
      return [(x + inset) / w, 1 - (y + 8 - inset) / h, (x + 8 - inset) / w, 1 - (y + inset) / h];
    },
    drawTile(tile, pixels) {
      const one = ctx.createImageData(8, 8);
      put(tile, pixels, one, 0, 0);
      ctx.putImageData(one, (tile % ATLAS_COLS) * 8, Math.floor(tile / ATLAS_COLS) * 8);
      texture.needsUpdate = true;
    },
    recolor(next) {
      colors = next;
      for (let t = 0; t < ts.tileCount; t++) put(t, indices.slice(t * 64, t * 64 + 64), img, (t % ATLAS_COLS) * 8, Math.floor(t / ATLAS_COLS) * 8);
      ctx.putImageData(img, 0, 0);
      texture.needsUpdate = true;
    },
  };
}

/** rOBP0 in the normal (FadePal4) state: color 3->3, 2->1, 1->0, 0->transparent. */
export const OBP0 = [0, 0, 1, 3];

/** Sprite sheet texture: frames laid out horizontally, color 0 transparent. */
export function buildSpriteTexture(sp: OverworldSprite, colors: RGB[], obp: number[] = OBP0): SpriteTexture {
  const w = sp.frames * 16;
  const canvas = makeCanvas(w, 16);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(w, 16);
  const draw = (colors: RGB[], obp: number[]) => {
    for (let f = 0; f < sp.frames; f++)
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const v = sp.pixels[f * 256 + y * 16 + x];
          const i = (y * w + f * 16 + x) * 4;
          const col = colors[obp[v]];
          img.data[i] = col[0];
          img.data[i + 1] = col[1];
          img.data[i + 2] = col[2];
          img.data[i + 3] = v === 0 ? 0 : 255;
        }
    ctx.putImageData(img, 0, 0);
  };
  draw(colors, obp);
  const tex = pixelTexture(canvas) as SpriteTexture;
  tex.recolor = (c, o) => {
    draw(c, o);
    tex.needsUpdate = true;
  };
  return tex;
}

/** A sprite texture that can be redrawn with another palette/rOBP (palette fades) */
export type SpriteTexture = THREE.Texture & { recolor(colors: RGB[], obp: number[]): void };
