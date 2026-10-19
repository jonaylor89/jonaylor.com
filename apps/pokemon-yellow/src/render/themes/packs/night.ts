/** Starlit Night: Kanto after dark, moonlit and cosy, with glowing windows and a lantern. */
import type { TexturePack } from '../types';

const pack: TexturePack = {
  id: 'night',
  label: 'STARLIT NIGHT',
  description: 'Moonlit Kanto under the stars: glowing windows, fireflies and a lantern.',
  order: 60,
  ramps: {
    GROUND: ['#a9d48a', '#7cb766', '#4d8452', '#21402e'],
    PATH: ['#e6d6b4', '#c8ae86', '#937a5c', '#4c3b2c'],
    TALL_GRASS: ['#b4dc7e', '#6eae52', '#33774a', '#163628'],
    FLOWERS: ['#fff8ff', '#e9a8ff', '#5d9c56', '#24402c'],
    WATER: ['#d8f0ff', '#5fa7e0', '#2a62a8', '#102a5c'],
    FOLIAGE: ['#a6d68a', '#5ea35a', '#2b6a3e', '#4c3628'],
    ROOF: ['#ffd9cf', '#d67864', '#8c3f3c', '#3a1c22'],
    FACADE: ['#fbf6ee', '#e3dccf', '#a9a29a', '#3d3a44'],
    ROCK: ['#d9d3c8', '#a59d92', '#6c665f', '#312e2e'],
    WOOD: ['#f0d3a6', '#c99460', '#875a36', '#3c2619'],
    FLOOR_WOOD: ['#f7d7a4', '#d89e62', '#9a673b', '#4b2e1a'],
    FLOOR_TILE: ['#fff8ec', '#ebe1cf', '#b9ad97', '#544a3e'],
    CAVE_FLOOR: ['#cdc0a8', '#9c8b70', '#665846', '#2e261e'],
    INDOOR_WALL: ['#fff6e2', '#f0dbb3', '#b99e74', '#52422e'],
    METAL: ['#eef3f8', '#b8c4d0', '#73808e', '#262c36'],
    STONE: ['#ebe8e4', '#bab4ab', '#817b72', '#38352f'],
  },
  surface: {
    GROUND: { pattern: 0.2, detail: 0.6, base: 0.9 },
    TALL_GRASS: { detail: 0.9 },
    ROOF: { tint: 0.7, gloss: 0.25 },
    FACADE: { pattern: 0.55, glow: 0.8 },
    WATER: { gloss: 1 },
    FLOOR_WOOD: { pattern: 0.12 },
    CAVE_FLOOR: { pattern: 0.25 },
  },
  light: {
    sun: '#a9c2ff', sunDir: [0.45, 0.62, 0.55], sunStrength: 0.42,
    skyAmbient: '#5b6fb8', groundAmbient: '#2e3a5c', ambientStrength: 0.66,
    wrap: 0.35, ao: 0.85, shadows: 0.55, rim: 0.12,
  },
  indoorLight: {
    sun: '#ffe2b0', sunDir: [-0.25, 1, 0.4], sunStrength: 0.6,
    skyAmbient: '#ffe6c4', groundAmbient: '#b8946a', ambientStrength: 0.62, shadows: 0.4, rim: 0,
  },
  caveLight: { lanternRadius: 6, ambientStrength: 0.2, sunStrength: 0.15, skyAmbient: '#6a7fb8', groundAmbient: '#2a2f48' },
  sky: { zenith: '#070d26', horizon: '#2b3a6a', sunDisc: 0.6, clouds: 0.3, cloudColor: '#5d6c96', stars: 1 },
  indoorVoid: '#120f1c',
  fog: { near: 24, far: 58 },
  weather: { kind: 'fireflies', density: 10, color: '#d9ff7a', color2: '#ffe27a', size: 1.2 },
  post: { saturation: 1.02, contrast: 1.05, exposure: 1.05, lift: '#0a0f24', vignette: 0.42, bloom: 0.2, tiltShift: 0.2, grain: 0.02 },
  sprites: { tint: '#c9d2ee' },
  night: { windows: '#ffc66a', lantern: '#ffc27a', lanternRadius: 5 },
};
export default pack;
