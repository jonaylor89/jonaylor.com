/**
 * A texture pack's GPU state for one view: ramps, per-material parameters,
 * light, fade and the shadow map baked once per map build. All map
 * materials share these uniform objects, so updates need no recompiles.
 */
import * as THREE from 'three';
import type { RGB } from '../palette';
import { MAT, MATERIAL_COUNT, MATERIAL_NAMES, type MaterialName } from './materials';
import type { LightParams, PostParams, Ramp, SurfaceParams, TexturePack } from './types';
import type { ThemeUniforms } from './shader';

/** Engine defaults; a pack only overrides what it styles. */
export const DEFAULT_SURFACE: Record<MaterialName, SurfaceParams> = {
  GENERIC: { base: 1, pattern: 1, detail: 0.3, tint: 0.35, gloss: 0, altAmount: 0, glow: 0 },
  GROUND: { base: 0.8, pattern: 0.45, detail: 0.55, tint: 0, gloss: 0, alt: 'PATH', altAmount: 0.65, glow: 0 },
  TALL_GRASS: { base: 1, pattern: 0.2, detail: 0.8, tint: 0, gloss: 0.05, altAmount: 0, glow: 0 },
  FLOWERS: { base: 1, pattern: 1, detail: 0.3, tint: 0.45, gloss: 0, altAmount: 0, glow: 0 },
  WATER: { base: 1, pattern: 1, detail: 0, tint: 0, gloss: 0.8, altAmount: 0, glow: 0 },
  FOLIAGE: { base: 1, pattern: 0.85, detail: 0.6, tint: 0, gloss: 0.04, altAmount: 0, glow: 0 },
  ROOF: { base: 1, pattern: 0.6, detail: 0.6, tint: 0.65, gloss: 0.12, altAmount: 0, glow: 0 },
  FACADE: { base: 0.6, pattern: 0.8, detail: 0.4, tint: 0.15, gloss: 0, altAmount: 0, glow: 0 },
  ROCK: { base: 1.2, pattern: 0.45, detail: 0.6, tint: 0, gloss: 0.03, alt: 'FOLIAGE', altAmount: 0, glow: 0 },
  WOOD: { base: 1, pattern: 0.7, detail: 0.45, tint: 0.1, gloss: 0.05, altAmount: 0, glow: 0 },
  FLOOR_WOOD: { base: 1, pattern: 0.35, detail: 0.6, tint: 0, gloss: 0.15, altAmount: 0, glow: 0 },
  FLOOR_TILE: { base: 0.6, pattern: 0.55, detail: 0.6, tint: 0.4, gloss: 0.3, altAmount: 0, glow: 0 },
  CAVE_FLOOR: { base: 1.3, pattern: 0.5, detail: 0.6, tint: 0, gloss: 0, altAmount: 0, glow: 0 },
  INDOOR_WALL: { base: 0.6, pattern: 0.75, detail: 0.4, tint: 0.45, gloss: 0, altAmount: 0, glow: 0 },
  METAL: { base: 1, pattern: 1, detail: 0.3, tint: 0.3, gloss: 0.55, altAmount: 0, glow: 0 },
  STONE: { base: 1, pattern: 0.6, detail: 0.5, tint: 0.1, gloss: 0.05, altAmount: 0, glow: 0 },
  PATH: { base: 0.8, pattern: 0.5, detail: 0.5, tint: 0, gloss: 0, altAmount: 0, glow: 0 },
  SHADOW: { base: 3, pattern: 0, detail: 0, tint: 0, gloss: 0, altAmount: 0, glow: 0 },
};

/** Fallback ramps: a neutral, natural world. */
export const DEFAULT_RAMPS: Record<MaterialName, Ramp> = {
  GENERIC: ['#f2efe6', '#b9b2a2', '#6f6758', '#2b2620'],
  GROUND: ['#b8d98a', '#86bd5a', '#4f8a3a', '#234022'],
  TALL_GRASS: ['#c4e27c', '#7fbf45', '#3f8a2f', '#1d4219'],
  FLOWERS: ['#fff6f0', '#f29bb5', '#5c9e3c', '#2c3f22'],
  WATER: ['#d6f2ff', '#5fb7e6', '#2a72b8', '#123a6a'],
  FOLIAGE: ['#a9db6a', '#5ea83c', '#2f6a2a', '#4a3020'],
  ROOF: ['#f4c7a4', '#d0644a', '#8a3328', '#3b1712'],
  FACADE: ['#fbf4e4', '#dccfb4', '#9e8f74', '#3a3a46'],
  ROCK: ['#d8cdb8', '#a69780', '#6e604f', '#33291f'],
  WOOD: ['#f0d2a0', '#c18c55', '#83532c', '#3c2414'],
  FLOOR_WOOD: ['#f2d3a2', '#cf9a62', '#93603a', '#4a2c18'],
  FLOOR_TILE: ['#f6f3ea', '#d9d4c6', '#a8a291', '#4c4840'],
  CAVE_FLOOR: ['#c9b89c', '#9a8668', '#64533f', '#2e241a'],
  INDOOR_WALL: ['#f8f1de', '#e2d4b2', '#a99772', '#4b3f2c'],
  METAL: ['#eef2f6', '#b2bcc6', '#6d7884', '#262c33'],
  STONE: ['#e6e3dc', '#b5b0a5', '#7b766c', '#36332e'],
  PATH: ['#efdcb2', '#d4b583', '#a3814f', '#55402a'],
  SHADOW: ['#000000', '#000000', '#000000', '#000000'],
};

/** Character palettes (entry 2 is only seen during fades). */
export const DEFAULT_CHARACTERS: { player: Ramp; pikachu: Ramp; people: Ramp[] } = {
  player: ['#ffe8d2', '#dd3d34', '#7e2a2a', '#241a1f'],
  pikachu: ['#fff3c2', '#f5c52c', '#a97a12', '#3b2a12'],
  people: [
    ['#ffeedf', '#4a7fd0', '#2c4c86', '#22202c'],
    ['#ffeedf', '#4ea65e', '#2d6a39', '#22202c'],
    ['#ffeedf', '#8a63c9', '#55388a', '#22202c'],
    ['#ffeedf', '#2f9e9f', '#1d6365', '#22202c'],
    ['#ffeedf', '#b37a44', '#6f4a26', '#22202c'],
    ['#ffeedf', '#de7397', '#9a4462', '#22202c'],
  ],
};

export const DEFAULT_POST: PostParams = {
  saturation: 1, contrast: 1, exposure: 1, lift: '#000000', gain: '#ffffff',
  vignette: 0, grain: 0, tiltShift: 0, outline: 0, outlineColor: '#1b1a24', bloom: 0,
};

export function hexToRgb(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`bad colour ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const linear = (hex: string) => new THREE.Color().setStyle(hex);

export function resolvedSurface(pack: TexturePack, name: MaterialName): SurfaceParams {
  return { ...DEFAULT_SURFACE[name], ...pack.surface?.[name] };
}
export function resolvedRamp(pack: TexturePack, name: MaterialName): Ramp {
  return pack.ramps[name] ?? DEFAULT_RAMPS[name];
}
export type LightSetting = 'outdoor' | 'indoor' | 'cave';
export function resolvedLight(pack: TexturePack, setting: LightSetting): LightParams {
  if (setting === 'outdoor') return pack.light;
  const indoor = { ...pack.light, ...pack.indoorLight };
  if (setting === 'indoor') return indoor;
  return { ...indoor, ambientStrength: indoor.ambientStrength * 0.55, sunStrength: indoor.sunStrength * 0.45, ...pack.caveLight };
}
/** The light carried by the player: night packs everywhere, other packs in caves. */
export function resolvedLantern(pack: TexturePack, setting: LightSetting): { color: string; radius: number } | undefined {
  const cave = setting === 'cave' ? pack.caveLight : undefined;
  if (pack.night) return { color: cave?.lantern ?? pack.night.lantern, radius: cave?.lanternRadius ?? pack.night.lanternRadius };
  if (setting === 'cave') return { color: cave?.lantern ?? '#ffc982', radius: cave?.lanternRadius ?? 5.5 };
  return undefined;
}
export function resolvedPost(pack: TexturePack): PostParams | undefined {
  return pack.post ? { ...DEFAULT_POST, ...pack.post } : undefined;
}

/** FadePal / rBGP remap as a fade amount: > 0 toward black, < 0 toward white. */
export function fadeAmount(remap: number[]): number {
  const shift = remap.reduce((sum, shade, i) => sum + shade - i, 0);
  return Math.max(-1, Math.min(1, shift / 6));
}

const SHADOW_LAYER = 1;
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class PackRuntime {
  readonly uniforms: ThemeUniforms;
  readonly rampTexture: THREE.DataTexture;
  readonly shadowSize: number;
  private shadowTarget?: THREE.WebGLRenderTarget;
  private shadowMaterial?: THREE.MeshBasicMaterial;
  private setting: LightSetting = 'outdoor';

  constructor(readonly pack: TexturePack, readonly mobile: boolean) {
    const data = new Uint8Array(4 * MATERIAL_COUNT * 4);
    MATERIAL_NAMES.forEach((name, row) => resolvedRamp(pack, name).forEach((hex, i) => {
      const [r, g, b] = hexToRgb(hex);
      data.set([r, g, b, 255], (row * 4 + i) * 4);
    }));
    this.rampTexture = new THREE.DataTexture(data, 4, MATERIAL_COUNT, THREE.RGBAFormat);
    this.rampTexture.colorSpace = THREE.SRGBColorSpace;
    this.rampTexture.magFilter = this.rampTexture.minFilter = THREE.LinearFilter;
    this.rampTexture.wrapS = this.rampTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.rampTexture.needsUpdate = true;
    const surfA: THREE.Vector4[] = [], surfB: THREE.Vector4[] = [];
    for (const name of MATERIAL_NAMES) {
      const s = resolvedSurface(pack, name);
      surfA.push(new THREE.Vector4(s.base, s.pattern, s.detail, s.tint));
      surfB.push(new THREE.Vector4(s.gloss, s.alt ? MAT[s.alt] : -1, s.altAmount, s.glow));
    }
    this.shadowSize = mobile ? 0 : 4096;
    this.uniforms = {
      uRamps: { value: this.rampTexture },
      uSurfA: { value: surfA },
      uSurfB: { value: surfB },
      uPalette: { value: [0, 1, 2, 3].map(() => new THREE.Color()) },
      uPaletteHue: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSkyAmb: { value: new THREE.Color() },
      uGroundAmb: { value: new THREE.Color() },
      uLightParams: { value: new THREE.Vector4() },
      uFade: { value: 0 },
      uSnow: { value: pack.snow ?? 0 },
      uThemeTime: { value: 0 },
      uWindowGlow: { value: linear(pack.night?.windows ?? '#ffd27a') },
      uLantern: { value: new THREE.Vector4(0, 0, 0, 0) },
      uLanternColor: { value: linear(pack.night?.lantern ?? '#ffcf8a') },
      uShadowMap: { value: null },
      uShadowStrength: { value: 0 },
      uShadowTexel: { value: new THREE.Vector2(1 / 4096, 1 / 4096) },
      uShadowMatrix: { value: new THREE.Matrix4() },
    };
    this.setLight('outdoor');
  }

  cacheKey(hasWater: boolean): string {
    return `${this.pack.id}:${hasWater ? 'water' : 'land'}`;
  }

  /** CPU copy of a ramp (sRGB bytes), e.g. for the grass-priority overlay. */
  ramp(name: MaterialName): RGB[] {
    return resolvedRamp(this.pack, name).map(hexToRgb);
  }

  setPalette(colors: RGB[]): void {
    colors.forEach(([r, g, b], i) => (this.uniforms.uPalette.value as THREE.Color[])[i].setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace));
    // One hue per area for tinting: the most colourful of the palette's middle shades.
    const chroma = ([r, g, b]: RGB) => Math.max(r, g, b) - Math.min(r, g, b);
    const [r, g, b] = chroma(colors[1]) >= chroma(colors[2]) ? colors[1] : colors[2];
    (this.uniforms.uPaletteHue.value as THREE.Color).setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  }

  setLight(setting: LightSetting): void {
    this.setting = setting;
    const outdoor = setting === 'outdoor';
    const l = resolvedLight(this.pack, setting);
    (this.uniforms.uSunDir.value as THREE.Vector3).set(...l.sunDir).normalize();
    (this.uniforms.uSunColor.value as THREE.Color).setStyle(l.sun).multiplyScalar(l.sunStrength);
    (this.uniforms.uSkyAmb.value as THREE.Color).setStyle(l.skyAmbient);
    (this.uniforms.uGroundAmb.value as THREE.Color).setStyle(l.groundAmbient);
    (this.uniforms.uLightParams.value as THREE.Vector4).set(l.ambientStrength, l.wrap, l.ao, l.rim);
    this.uniforms.uSnow.value = outdoor ? this.pack.snow ?? 0 : 0;
    this.uniforms.uShadowStrength.value = this.shadowTarget ? l.shadows : 0;
    const lantern = resolvedLantern(this.pack, setting);
    (this.uniforms.uLantern.value as THREE.Vector4).w = lantern?.radius ?? 0;
    if (lantern) (this.uniforms.uLanternColor.value as THREE.Color).setStyle(lantern.color);
  }

  setFade(remap: number[]): void {
    this.uniforms.uFade.value = fadeAmount(remap);
  }

  setTime(seconds: number): void {
    this.uniforms.uThemeTime.value = seconds;
  }

  setPlayer(x: number, y: number, z: number): void {
    const v = this.uniforms.uLantern.value as THREE.Vector4;
    v.set(x, y, z, v.w);
  }

  /** Render map depth from the sun once per build; meshes stay static afterwards. */
  bakeShadows(renderer: THREE.WebGLRenderer, scene: THREE.Scene, meshes: THREE.Object3D[]): void {
    const strength = resolvedLight(this.pack, this.setting).shadows;
    if (!this.shadowSize || strength <= 0 || !meshes.length) {
      this.uniforms.uShadowStrength.value = 0;
      return;
    }
    const box = new THREE.Box3();
    for (const m of meshes) { box.expandByObject(m); m.layers.enable(SHADOW_LAYER); }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 + 1;
    const dir = (this.uniforms.uSunDir.value as THREE.Vector3).clone();
    const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, radius * 4);
    cam.position.copy(center).addScaledVector(dir, radius * 2);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    // Fit the frustum to the map's corners in light space.
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y + 2 : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse);
      min.min(p); max.max(p);
    }
    cam.left = min.x - 0.5; cam.right = max.x + 0.5; cam.bottom = min.y - 0.5; cam.top = max.y + 0.5;
    cam.near = Math.max(0.01, -max.z - 1); cam.far = -min.z + 1;
    cam.updateProjectionMatrix();
    cam.layers.set(SHADOW_LAYER);
    if (!this.shadowTarget) {
      const size = this.shadowSize;
      this.shadowTarget = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, depthTexture: new THREE.DepthTexture(size, size) });
      this.shadowMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });
      this.uniforms.uShadowTexel.value = new THREE.Vector2(1 / size, 1 / size);
    }
    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial, previousBackground = scene.background, previousFog = scene.fog;
    scene.overrideMaterial = this.shadowMaterial!;
    scene.background = null; scene.fog = null;
    renderer.setRenderTarget(this.shadowTarget);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(previousTarget);
    scene.overrideMaterial = previousOverride; scene.background = previousBackground; scene.fog = previousFog;
    this.uniforms.uShadowMap.value = this.shadowTarget.depthTexture;
    (this.uniforms.uShadowMatrix.value as THREE.Matrix4).copy(BIAS).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.uniforms.uShadowStrength.value = strength;
  }

  dispose(): void {
    this.rampTexture.dispose();
    this.shadowTarget?.depthTexture?.dispose();
    this.shadowTarget?.dispose();
    this.shadowMaterial?.dispose();
  }
}
