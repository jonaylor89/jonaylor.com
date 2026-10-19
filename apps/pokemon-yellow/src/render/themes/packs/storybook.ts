/** Storybook: a hand-painted picture book — watercolour washes on warm paper with sepia ink lines. */
import type { TexturePack } from '../types';

const pack: TexturePack = {
  id: 'storybook',
  label: 'STORYBOOK',
  description: 'Watercolour washes on warm paper, sepia ink lines and soft, hazy light.',
  order: 30,
  ramps: {
    GROUND: ['#cfe0a6', '#a7c67e', '#729457', '#3e5233'],
    PATH: ['#f3e2bd', '#e2c58f', '#bf9b62', '#6e5536'],
    TALL_GRASS: ['#c4dc8e', '#93ba62', '#618a45', '#34502a'],
    FLOWERS: ['#fff8ec', '#efa9a0', '#8fae6c', '#4a5638'],
    WATER: ['#e9f1ea', '#a9cdd0', '#6c9fb0', '#3f6478'],
    FOLIAGE: ['#c2dc90', '#88b065', '#557b45', '#7a5b3e'],
    ROOF: ['#f4d6c0', '#d58f72', '#a2604c', '#5a3328'],
    FACADE: ['#fbf3e1', '#eadcbf', '#c4ae8a', '#6b5d55'],
    ROCK: ['#ebe0c8', '#c9b796', '#998668', '#5b4b38'],
    WOOD: ['#f2dcb2', '#d6ad7a', '#a77d50', '#5c4129'],
    FLOOR_WOOD: ['#f5e1bb', '#dfbb86', '#b48d5c', '#674b30'],
    FLOOR_TILE: ['#fbf6ea', '#ebe2cf', '#c7bba1', '#71675a'],
    CAVE_FLOOR: ['#e2d3b4', '#bea783', '#8f7b5c', '#54452f'],
    INDOOR_WALL: ['#fcf4e2', '#efe0c0', '#cbb68d', '#6e5f48'],
    METAL: ['#eef0ea', '#c9cec6', '#949a90', '#4c5049'],
    STONE: ['#f1ebdf', '#d2c8b6', '#a49985', '#5b5345'],
  },
  surface: {
    GROUND: { pattern: 0.22, detail: 0.5, base: 0.85, altAmount: 0.45 },
    TALL_GRASS: { detail: 0.7, base: 1.1 },
    FLOWERS: { tint: 0.2 },
    PATH: { detail: 0.35 },
    FOLIAGE: { detail: 0.45 },
    ROOF: { tint: 0.8, detail: 0.45, gloss: 0 },
    FACADE: { pattern: 0.5, detail: 0.25 },
    FLOOR_WOOD: { pattern: 0.12, detail: 0.4, gloss: 0 },
    FLOOR_TILE: { gloss: 0.05 },
    CAVE_FLOOR: { pattern: 0.25 },
    WATER: { gloss: 0.25 },
    METAL: { gloss: 0.15 },
  },
  light: {
    sun: '#fff1da', sunDir: [-0.35, 1, 0.55], sunStrength: 0.62,
    skyAmbient: '#f3ead6', groundAmbient: '#c9c09a', ambientStrength: 0.62,
    wrap: 0.6, ao: 0.75, shadows: 0.32, rim: 0,
  },
  indoorLight: {
    sun: '#fff0d8', sunDir: [-0.2, 1, 0.4], sunStrength: 0.5,
    skyAmbient: '#fbefd8', groundAmbient: '#d6c39f', ambientStrength: 0.7, shadows: 0.25,
  },
  caveLight: { lantern: '#ffd9a0', lanternRadius: 6 },
  sky: { zenith: '#bcd3d6', horizon: '#f6ead0', sunDisc: 0.35, clouds: 0.8, cloudColor: '#fffaf0', stars: 0 },
  indoorVoid: '#2e2620',
  fog: { near: 22, far: 58 },
  post: {
    saturation: 0.95, contrast: 1.0, exposure: 1.0, lift: '#160d04', gain: '#fffaf1',
    vignette: 0.4, grain: 0.05, outline: 0.9, outlineColor: '#4a3322', bloom: 0.05, tiltShift: 0.12,
  },
  sprites: {
    player: ['#fbe6d0', '#c8574a', '#7a3a32', '#3d2a22'],
    pikachu: ['#fdf0c8', '#ecc65a', '#a8822e', '#4a3520'],
    people: [
      ['#fbeee0', '#6d8fb8', '#3f5a7a', '#3a2e2a'],
      ['#fbeee0', '#7ea06a', '#4c6a3e', '#3a2e2a'],
      ['#fbeee0', '#9a7cb4', '#61487a', '#3a2e2a'],
      ['#fbeee0', '#5e9e9a', '#3a6664', '#3a2e2a'],
      ['#fbeee0', '#b98a5c', '#765535', '#3a2e2a'],
      ['#fbeee0', '#d48a9a', '#8f5260', '#3a2e2a'],
    ],
  },
  // Watercolour: uneven washes, pigment granulation, and a touch of paper showing through.
  glsl: /* glsl */ `
void packSurface(inout vec3 albedo, inout float gloss, int material, float shade, vec3 p, vec3 n) {
  if (material == M_WATER) return;
  vec2 q = tPlanar(p, n);
  float wash = tFbm(q * 0.55 + vec2(3.7, 1.3));
  albedo *= mix(0.8, 1.12, wash);
  float grain = tNoise(q * 58.0) * 0.6 + tNoise(q * 23.0) * 0.4;
  albedo *= 1.0 - (grain - 0.5) * 0.12;
  float bloom = smoothstep(0.62, 0.8, tFbm(q * 0.33 + 9.1));
  albedo = mix(albedo, vec3(0.98, 0.95, 0.88), 0.06 + bloom * 0.1);
  gloss *= 0.5;
}
`,
};
export default pack;
