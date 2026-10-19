/** Winter: fresh snowfall over Kanto, low cool sun, frosted grass and icy water. */
import type { TexturePack } from '../types';

const pack: TexturePack = {
  id: 'winter',
  label: 'WINTER',
  description: 'Fresh snow on every roof and tree, trodden paths, icy water and gentle snowfall.',
  order: 40,
  ramps: {
    GROUND: ['#e9eef3', '#cfd8e2', '#9aa7b6', '#4f5a68'],
    PATH: ['#cbc3ba', '#a69b90', '#766a5f', '#3e3530'],
    TALL_GRASS: ['#d6e4c8', '#8aa27a', '#4a6648', '#1e3022'],
    FLOWERS: ['#ffffff', '#e8b8d0', '#6f8a6e', '#2c3a30'],
    WATER: ['#e9fbff', '#8fd6ea', '#3f8fb8', '#173f63'],
    FOLIAGE: ['#7fa48a', '#3e6c55', '#1f4236', '#4a3a30'],
    ROOF: ['#ffd9cf', '#c85f4f', '#7e3129', '#2f1513'],
    FACADE: ['#fbf6ee', '#e3d8c8', '#a99984', '#3e4656'],
    ROCK: ['#d9dde3', '#a3a8b0', '#6b707a', '#2f3239'],
    WOOD: ['#e6c9a0', '#b07f52', '#71492b', '#33200f'],
    FLOOR_WOOD: ['#f5d6a6', '#d39a60', '#96623a', '#4a2d18'],
    FLOOR_TILE: ['#fbf8f1', '#e2ddd0', '#b0a996', '#4d4942'],
    CAVE_FLOOR: ['#cdd3dc', '#98a0ad', '#626a78', '#2b303a'],
    INDOOR_WALL: ['#fff6e4', '#efd8b2', '#b79c73', '#4f402c'],
    METAL: ['#f1f5f9', '#bac5d1', '#74818f', '#262d36'],
    STONE: ['#eef0f3', '#c0c4ca', '#858a92', '#3a3d43'],
  },
  surface: {
    GROUND: { pattern: 0.15, detail: 0.6, base: 0.35, alt: 'PATH', altAmount: 0.85 },
    TALL_GRASS: { detail: 0.9, base: 1.2 },
    ROOF: { tint: 0.8 },
    FACADE: { pattern: 0.55 },
    WATER: { gloss: 1 },
    FLOOR_WOOD: { pattern: 0.12 },
    CAVE_FLOOR: { pattern: 0.25 },
  },
  light: {
    sun: '#ffe9d6', sunDir: [-0.65, 0.55, 0.5], sunStrength: 0.62,
    skyAmbient: '#c9dcf5', groundAmbient: '#b4c0cf', ambientStrength: 0.62,
    wrap: 0.3, ao: 0.85, shadows: 0.55, rim: 0.05,
  },
  indoorLight: {
    sun: '#ffdcae', sunDir: [-0.25, 1, 0.4], sunStrength: 0.62,
    skyAmbient: '#ffe7c4', groundAmbient: '#caa982', ambientStrength: 0.62, shadows: 0.4, rim: 0,
  },
  caveLight: { skyAmbient: '#b6b2ab', groundAmbient: '#6d7686', lantern: '#ffcf96' },
  sky: { zenith: '#8aa7c8', horizon: '#e4ecf4', sunDisc: 0.6, clouds: 0.85, cloudColor: '#f4f7fb', stars: 0 },
  indoorVoid: '#1c1d27',
  fog: { near: 22, far: 58 },
  weather: { kind: 'snow', density: 65, color: '#ffffff', color2: '#e6f0ff', size: 1.2 },
  post: { saturation: 0.92, contrast: 1.03, lift: '#0a1020', gain: '#f4f8ff', vignette: 0.25, tiltShift: 0.3, bloom: 0.15, grain: 0.012 },
  sprites: { tint: '#f4f6ff' },
  // Snow is painted here (not pack.snow), outdoors only, so trodden paths, tall grass and water stay readable.
  glsl: /* glsl */ `
void packSurface(inout vec3 albedo, inout float gloss, int material, float shade, vec3 p, vec3 n) {
  float up = smoothstep(0.45, 0.85, n.y) * uOutdoor;
  vec3 snow = vec3(0.86, 0.9, 0.96) + (tNoise(p.xz * 18.0) - 0.5) * 0.05;
  float cover = 0.0;
  if (material == M_GROUND) {
    float trodden = smoothstep(0.56, 0.74, tFbm(p.xz * 0.21 + 3.1));
    cover = up * mix(0.95, 0.42, trodden) * smoothstep(0.2, 0.5, tFbm(p.xz * 2.3) + 0.35);
  } else if (material == M_TALL_GRASS) {
    // Frosted tufts poke out of the drifts; the patch floor keeps a thin crust.
    cover = p.y < 0.01 ? 0.45 * up * smoothstep(0.3, 0.7, tNoise(p.xz * 9.0)) : smoothstep(0.16, 0.26, p.y) * 0.75;
  } else if (material == M_ROOF) {
    // Shingles show through in streaks along the courses.
    cover = up * smoothstep(0.3, 0.7, tFbm(vec2(p.x * 2.5, p.y * 9.0)) * 0.7 + 0.25);
  } else if (material == M_FOLIAGE || material == M_ROCK || material == M_WOOD || material == M_FACADE || material == M_STONE || material == M_FLOWERS) {
    cover = up * smoothstep(0.25, 0.6, tFbm(p.xz * 1.7) * 0.6 + 0.45);
  } else if (material == M_WATER) {
    // Glassy ice sheen toward the shore.
    albedo = mix(albedo, vec3(0.78, 0.9, 0.96), 0.18);
    gloss = 1.0;
  }
  albedo = mix(albedo, snow, cover);
  gloss = mix(gloss, 0.18, cover);
}
`,
};
export default pack;
