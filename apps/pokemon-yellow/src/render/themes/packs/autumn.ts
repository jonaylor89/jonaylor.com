/** Autumn: golden-hour fall colour, fallen leaves and drifting foliage. */
import type { TexturePack } from '../types';

const pack: TexturePack = {
  id: 'autumn',
  label: 'AUTUMN',
  description: 'Golden-hour light, red and amber trees, leaf-strewn lawns and drifting leaves.',
  order: 50,
  ramps: {
    GROUND: ['#e3d08a', '#c2ad5e', '#87773a', '#3f371b'],
    PATH: ['#e8c99a', '#c79d68', '#8f6a40', '#4c3420'],
    TALL_GRASS: ['#cfc56c', '#9a983d', '#5f6024', '#2b2c10'],
    FLOWERS: ['#fff3e0', '#f3a03e', '#7a7a34', '#33301a'],
    WATER: ['#f6efe2', '#86c3d8', '#3d86aa', '#1a4563'],
    FOLIAGE: ['#ffcf6a', '#e88a2c', '#a3401f', '#4e2c1a'],
    ROOF: ['#ffd8b8', '#cf6340', '#8a3122', '#3a1610'],
    FACADE: ['#fff3e2', '#ecd9bc', '#b19976', '#4a4048'],
    ROCK: ['#e0cfb2', '#b09878', '#776049', '#3a2c20'],
    WOOD: ['#f0cf9a', '#c98c50', '#86552a', '#3d2414'],
    FLOOR_WOOD: ['#f7d6a0', '#d79c5c', '#9a6635', '#4d2e17'],
    FLOOR_TILE: ['#fcf6ea', '#e6dccb', '#b5a790', '#504538'],
    CAVE_FLOOR: ['#d5bf9c', '#a58a66', '#6d5640', '#31241a'],
    INDOOR_WALL: ['#fff4e0', '#eed6ae', '#b69a6e', '#4f3f2a'],
    METAL: ['#f3f1ee', '#c2bdb6', '#807a72', '#2b2824'],
    STONE: ['#efe8de', '#c3b8a8', '#887d6e', '#3b352d'],
  },
  surface: {
    GROUND: { pattern: 0.2, detail: 0.7, base: 0.9, alt: 'PATH', altAmount: 0.6 },
    TALL_GRASS: { detail: 0.9 },
    FOLIAGE: { detail: 0.7 },
    ROOF: { tint: 0.75 },
    FACADE: { pattern: 0.55 },
    FLOOR_WOOD: { pattern: 0.12 },
    CAVE_FLOOR: { pattern: 0.25 },
  },
  light: {
    sun: '#ffcb8e', sunDir: [-0.7, 0.55, 0.45], sunStrength: 1.0,
    skyAmbient: '#c9b6d6', groundAmbient: '#a8905e', ambientStrength: 0.55,
    wrap: 0.25, ao: 0.9, shadows: 0.62, rim: 0.08,
  },
  indoorLight: {
    sun: '#ffdcae', sunDir: [-0.3, 1, 0.4], sunStrength: 0.62,
    skyAmbient: '#ffe6c4', groundAmbient: '#c6a37a', ambientStrength: 0.62, shadows: 0.4, rim: 0,
  },
  sky: { zenith: '#9b8fc4', horizon: '#ffd2a8', sunDisc: 1.2, clouds: 0.55, cloudColor: '#ffe2c6', stars: 0 },
  indoorVoid: '#211a1c',
  fog: { near: 24, far: 62 },
  weather: { kind: 'leaves', density: 22, color: '#e2742a', color2: '#f2b233', size: 1.8 },
  post: { saturation: 1.06, contrast: 1.04, lift: '#140a04', gain: '#fff6ea', vignette: 0.28, tiltShift: 0.35, bloom: 0.18, grain: 0.014 },
  sprites: { tint: '#fff4e6' },
  glsl: /* glsl */ `
void packSurface(inout vec3 albedo, inout float gloss, int material, float shade, vec3 p, vec3 n) {
  if (material == M_FOLIAGE && shade < 2.5) {
    // Each tree (by its square) turns its own colour: red, amber, gold, or still green.
    float pick = tHash(floor(p.xz * 0.5) + 0.37);
    vec3 tone = pick < 0.3 ? vec3(0.78, 0.13, 0.05) : pick < 0.62 ? vec3(0.95, 0.42, 0.06) : pick < 0.86 ? vec3(0.98, 0.7, 0.12) : vec3(0.32, 0.45, 0.12);
    float l = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    albedo = tone * (0.35 + l * 1.4);
  } else if (material == M_GROUND || material == M_TALL_GRASS) {
    // Fallen leaves: sparse speckle of red/orange on the lawn.
    vec2 c = tCell(p.xz * 7.0);
    float leaf = (1.0 - smoothstep(0.08, 0.16, c.x)) * step(0.55, c.y) * (n.y > 0.6 ? 1.0 : 0.0);
    vec3 lc = c.y > 0.8 ? vec3(0.7, 0.12, 0.04) : vec3(0.9, 0.38, 0.06);
    albedo = mix(albedo, lc, leaf * 0.85);
  }
}
`,
};
export default pack;
