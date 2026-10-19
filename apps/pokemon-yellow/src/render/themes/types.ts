/**
 * Texture packs: optional, device-local looks for the 3D world. A pack never
 * changes ROM data, collision or game state; it restyles map surfaces (by
 * material, see materials.ts), lighting, sky, weather and an optional final
 * image pass. The original GB look is not a pack: it is the absence of one.
 */
import type { ColorFilter } from '../palette';
import type { MaterialName } from './materials';

/** '#rrggbb' */
export type Hex = string;
/** Four anchor colours, lightest (ROM shade 0) to darkest (ROM shade 3). */
export type Ramp = [Hex, Hex, Hex, Hex];

export interface SurfaceParams {
  /** Ramp position (0 lightest … 3 darkest) used where the ROM pattern is ignored. */
  base: number;
  /** How much the ROM tile's own shades show (0: only procedural, 1: the original pattern). */
  pattern: number;
  /** Strength of the procedural texture (ramp positions it may shift). */
  detail: number;
  /** Blend toward the area's SGB palette colour (keeps each town's roof hue, for example). */
  tint: number;
  /** Specular highlight strength (0 matte … 1 glossy). */
  gloss: number;
  /** A second material's ramp mixed in by large-scale noise (worn dirt in lawns, moss on rock). */
  alt?: MaterialName;
  altAmount: number;
  /** Emissive strength (night windows, lamps); uses the ramp's lightest colour. */
  glow: number;
}

export interface LightParams {
  sun: Hex;
  /** Direction toward the sun (x east, y up, z south); normalised by the engine. */
  sunDir: [number, number, number];
  sunStrength: number;
  skyAmbient: Hex;
  groundAmbient: Hex;
  ambientStrength: number;
  /** Wrap lighting: 0 hard terminator … 1 soft. */
  wrap: number;
  /** Baked contact-shadow strength (0 none … 1 strong). */
  ao: number;
  /** Shadow-map darkness (0 disables the shadow pass). */
  shadows: number;
  /** Fresnel rim highlight (toy/plastic looks). */
  rim: number;
}

export interface SkyParams {
  zenith: Hex;
  horizon: Hex;
  sunDisc: number;
  clouds: number;
  cloudColor: Hex;
  stars: number;
}

export interface WeatherParams {
  kind: 'snow' | 'leaves' | 'petals' | 'fireflies' | 'dust' | 'rain';
  /** Particles per 1000 cubic units around the camera (36×12×36 box): ~40 light, ~90 heavy. */
  density: number;
  color: Hex;
  color2?: Hex;
  /** Particle size multiplier (1 = default for the kind). */
  size?: number;
  /** Also shown indoors (dust motes). */
  indoor?: boolean;
}

export interface PostParams {
  saturation: number;
  contrast: number;
  exposure: number;
  /** Shadows/highlights colour balance: lift adds to darks, gain multiplies. */
  lift: Hex;
  gain: Hex;
  vignette: number;
  /** Static film grain / paper texture. */
  grain: number;
  /** Miniature-diorama blur away from the screen's focus band. */
  tiltShift: number;
  /** Depth-edge ink lines. */
  outline: number;
  outlineColor: Hex;
  /** Soft glow from bright areas (cheap, single pass). */
  bloom: number;
}

export interface TexturePack {
  id: string;
  /** Upper-case menu label, e.g. 'REMASTERED'. */
  label: string;
  /** One short sentence for the settings hint. */
  description: string;
  /** Menu order (Original is always first). */
  order: number;
  ramps: Partial<Record<MaterialName, Ramp>>;
  surface?: Partial<Record<MaterialName, Partial<SurfaceParams>>>;
  light: LightParams;
  /** Interior maps; missing fields fall back to `light`. */
  indoorLight?: Partial<LightParams>;
  /** Caves (missing: the indoor light, dimmed, with a warm lantern around the player). */
  caveLight?: Partial<LightParams> & { lantern?: Hex; lanternRadius?: number };
  sky: SkyParams;
  /** Background beyond indoor maps. */
  indoorVoid: Hex;
  /** Distance fog (outdoor), in world units. */
  fog?: { near: number; far: number };
  /** 0…1: snow on upward-facing surfaces. */
  snow?: number;
  weather?: WeatherParams;
  post?: Partial<PostParams>;
  /**
   * Characters keep their ROM art but get their own colours: under the normal
   * rOBP0 a sprite shows ramp entries 0 (skin/highlight), 1 (clothes) and 3
   * (outline). Still props (boulders, item balls) use the area palette,
   * optionally graded by `filter`. Missing palettes use the engine defaults.
   */
  sprites?: { filter?: ColorFilter; tint?: Hex; player?: Ramp; pikachu?: Ramp; people?: Ramp[] };
  /** Night packs: glowing windows (FACADE shade 3) and a light carried by the player. */
  night?: { windows: Hex; lantern: Hex; lanternRadius: number };
  /**
   * Optional GLSL run after the engine's surface model, before snow and lighting:
   * `void packSurface(inout vec3 albedo, inout float gloss, int material, float shade, vec3 p, vec3 n)`.
   * `material` is an `M_<NAME>` define (M_GROUND, M_FOLIAGE, …), `shade` the ROM shade 0-3 after
   * any fade remap, `p` the world position (1 unit = one 16px square), `n` the face normal.
   * Available: `tHash(vec2)`, `tNoise(vec2)`, `tFbm(vec2)`, `tCell(vec2)` (voronoi distance, id),
   * `tPlanar(p, n)`, `rampAt(material, t)`, `uPalette[4]`, `uPaletteHue`, `uThemeTime` (seconds,
   * paused with the game), `uOutdoor` (1 outdoors incl. the forest, 0 indoors and in caves).
   * Keep it cheap: no loops; it runs for every map fragment.
   */
  glsl?: string;
}
