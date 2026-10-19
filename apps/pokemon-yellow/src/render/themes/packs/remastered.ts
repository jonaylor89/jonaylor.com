/** Remastered: a sunny, high-detail diorama. The reference pack for the engine's defaults. */
import type { TexturePack } from '../types';

const pack: TexturePack = {
  id: 'remastered',
  label: 'REMASTERED',
  description: 'Sunlit lawns, shingled roofs, real shadows and a soft miniature focus.',
  order: 10,
  ramps: {
    GROUND: ['#b6dc7a', '#88c455', '#4f8e3b', '#264421'],
    PATH: ['#f1ddb2', '#dabb86', '#a9885b', '#5b442c'],
    TALL_GRASS: ['#dcf290', '#8fca4d', '#418c34', '#1b401c'],
    FLOWERS: ['#fffaf2', '#ff9fb8', '#5ea83c', '#2a4022'],
    WATER: ['#e6f8ff', '#71c9f0', '#2c80c5', '#133d73'],
    FOLIAGE: ['#bde47c', '#6bb445', '#2f7431', '#5c3b22'],
    ROOF: ['#ffdcc6', '#e2724f', '#9c3b2c', '#3f1b14'],
    FACADE: ['#fffaf0', '#efe2c8', '#b9a584', '#4a5262'],
    ROCK: ['#e4d7be', '#b6a285', '#7b6751', '#3b2f23'],
    WOOD: ['#f4d6a3', '#d09759', '#8e5b2f', '#402716'],
    FLOOR_WOOD: ['#f7daa9', '#d7a167', '#9b6b3f', '#4e301b'],
    FLOOR_TILE: ['#fcf9f1', '#e4e0d3', '#b3ac99', '#4f4b43'],
    CAVE_FLOOR: ['#d5c4a4', '#a48f6d', '#6d5b44', '#31271c'],
    INDOOR_WALL: ['#fff9e9', '#eddcb9', '#b5a079', '#4f422f'],
    METAL: ['#f3f6f9', '#bdc7d1', '#77838f', '#282e36'],
    STONE: ['#f0ede7', '#c1bbb1', '#868176', '#3b3832'],
  },
  surface: {
    GROUND: { pattern: 0.2, detail: 0.7, base: 0.9 },
    TALL_GRASS: { detail: 0.9 },
    ROOF: { tint: 0.85 },
    FACADE: { pattern: 0.55 },
    FLOOR_WOOD: { pattern: 0.12 },
    CAVE_FLOOR: { pattern: 0.25 },
  },
  light: {
    sun: '#fff0d4', sunDir: [-0.5, 0.9, 0.45], sunStrength: 0.82,
    skyAmbient: '#c4ddff', groundAmbient: '#8f9f70', ambientStrength: 0.48,
    wrap: 0.25, ao: 0.9, shadows: 0.6, rim: 0,
  },
  indoorLight: {
    sun: '#fff3dd', sunDir: [-0.25, 1, 0.4], sunStrength: 0.62,
    skyAmbient: '#fff2de', groundAmbient: '#cbb594', ambientStrength: 0.62, shadows: 0.4,
  },
  sky: { zenith: '#5aa8ee', horizon: '#d2eaff', sunDisc: 1, clouds: 0.65, cloudColor: '#ffffff', stars: 0 },
  indoorVoid: '#1d1a24',
  fog: { near: 28, far: 66 },
  post: { saturation: 1.08, contrast: 1.04, vignette: 0.22, tiltShift: 0.35, bloom: 0.12, grain: 0.012 },
  sprites: { filter: 'vivid' },
};
export default pack;
