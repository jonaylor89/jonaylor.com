/** Toybox: a glossy, candy-bright toy diorama with a strong miniature focus. */
import type { TexturePack } from '../types';

const pack: TexturePack = {
  id: 'toybox',
  label: 'TOYBOX',
  description: 'Glossy plastic and clay in candy colours, like a tilt-shift toy diorama.',
  order: 20,
  ramps: {
    GROUND: ['#9fdc78', '#68c45c', '#3a9a4c', '#1d5e36'],
    PATH: ['#ffe9b8', '#ffd17e', '#e7a858', '#9a6232'],
    TALL_GRASS: ['#6cc864', '#38a856', '#1c7c46', '#0c4a30'],
    FLOWERS: ['#ffffff', '#ff5fa2', '#4fcf5f', '#1e6a35'],
    WATER: ['#d8fbff', '#4fd2ff', '#1f8fe8', '#0d4fae'],
    FOLIAGE: ['#92dc6c', '#48b654', '#1f8446', '#9a5a2c'],
    ROOF: ['#ffd0d6', '#ff4f5e', '#c4223a', '#5a0e1e'],
    FACADE: ['#fffdf6', '#fff1d4', '#e8c896', '#3b5ea8'],
    ROCK: ['#f2e6d2', '#d6b892', '#a8835e', '#5a3e28'],
    WOOD: ['#ffc7a0', '#e86f48', '#b0402c', '#5a1a14'],
    FLOOR_WOOD: ['#f6e2c0', '#e6c08e', '#bf8f5c', '#6a4426'],
    FLOOR_TILE: ['#f4f0ff', '#dcd4f2', '#b2a6d6', '#544a7c'],
    CAVE_FLOOR: ['#f0d8b0', '#d2a878', '#a2764e', '#523620'],
    INDOOR_WALL: ['#fffaf0', '#ffe9c8', '#e2bf8e', '#6a4c30'],
    METAL: ['#ffffff', '#cfe0f2', '#7f9ab8', '#2c3c56'],
    STONE: ['#ffffff', '#dcd8e8', '#9e98b6', '#45405a'],
  },
  surface: {
    GROUND: { pattern: 0.12, detail: 0.35, base: 0.85, altAmount: 0.45 },
    PATH: { pattern: 0.25, detail: 0.3 },
    TALL_GRASS: { detail: 0.7, gloss: 0.25 },
    FOLIAGE: { detail: 0.45, gloss: 0.35 },
    ROOF: { tint: 0.9, gloss: 0.7, detail: 0.45 },
    FACADE: { pattern: 0.35, detail: 0.15, gloss: 0.2 },
    WOOD: { detail: 0.25, gloss: 0.35 },
    ROCK: { detail: 0.35, gloss: 0.3 },
    WATER: { gloss: 1 },
    METAL: { gloss: 0.9 },
    FLOOR_WOOD: { pattern: 0.3, detail: 0.6, gloss: 0.45 },
    FLOOR_TILE: { gloss: 0.6 },
    CAVE_FLOOR: { pattern: 0.2, detail: 0.4, gloss: 0.15 },
    STONE: { gloss: 0.4 },
  },
  light: {
    sun: '#fff1de', sunDir: [-0.45, 1, 0.55], sunStrength: 0.7,
    skyAmbient: '#cfe6ff', groundAmbient: '#ffd9b8', ambientStrength: 0.5,
    wrap: 0.45, ao: 0.8, shadows: 0.42, rim: 0.7,
  },
  indoorLight: {
    sun: '#fff6e6', sunDir: [-0.2, 1, 0.45], sunStrength: 0.5,
    skyAmbient: '#fff0e0', groundAmbient: '#ffd8c0', ambientStrength: 0.55, shadows: 0.35, rim: 0.45,
  },
  caveLight: { lantern: '#ffd59a', lanternRadius: 6.5 },
  sky: { zenith: '#6ec3ff', horizon: '#e4f6ff', sunDisc: 0.8, clouds: 0.85, cloudColor: '#ffffff', stars: 0 },
  indoorVoid: '#2a2140',
  fog: { near: 30, far: 70 },
  post: { saturation: 1.2, contrast: 1.16, exposure: 1.0, vignette: 0.22, tiltShift: 0.62, bloom: 0.14, outline: 0.22, outlineColor: '#2a2050' },
  sprites: {
    filter: 'vivid',
    player: ['#fff0e0', '#ff3a3a', '#a01e2e', '#2a1630'],
    pikachu: ['#fff8c8', '#ffd21f', '#c08a00', '#3a2410'],
  },
  // Plastic: lift the darkest tones and push colour, so surfaces read as moulded.
  glsl: /* glsl */ `
void packSurface(inout vec3 albedo, inout float gloss, int material, float shade, vec3 p, vec3 n) {
  float l = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  albedo = max(mix(vec3(l), albedo, 1.1), 0.0);
  albedo = albedo * 0.94 + 0.02;
}
`,
};
export default pack;
