/**
 * Three.js scene for the overworld: map mesh, character billboards and a
 * smoothly-following third-person camera.
 */
import * as THREE from 'three';
import type { GameBundle } from '../data/schema';
import type { WorldMap } from '../world/WorldMap';
import type { Facing } from '../world/movement';
import { AssetManifest, MissingAssetError } from './manifest';
import { buildMapMesh, cutawayUniforms, type BuiltMap } from './MapMesh';
import { isOutsideMap } from '../world/movement';
import { buildSpriteTexture, buildTileAtlas, type SpriteTexture, type TileAtlas } from './textures';
import { applyFilter, FADE_PALS_BGP, FADE_PALS_OBP0, paletteColors, remapColors, type ColorFilter, type RGB } from './palette';
import { SpriteActor } from './SpriteActor';
import { TileAnimator } from './TileAnimator';
import { WaterMotion } from './water';
import { c } from '../rom/constants';
import { CameraDirector, type CameraShot } from './camera';
import { BattleStage } from './BattleStage';
import { FrameProfiler, renderQuality } from './quality';
import type { TileScreen } from '../ui/TileScreen';
import { ORIGINAL_LOOK, texturePack } from './themes';
import { DEFAULT_CHARACTERS, hexToRgb, PackRuntime, resolvedPost } from './themes/runtime';
import { extraSheetId } from '../engine/sprites';
import { INDEX_GRAYS } from './themes/shader';
import { SkyDome } from './themes/sky';
import { Weather } from './themes/weather';
import { PostPass } from './themes/post';
import { floorMaterial, MATERIAL_NAMES, outdoorTileset } from './themes/materials';

export interface ViewSettings {
  cameraDistance: number;
  cameraPitchDeg: number;
  reducedMotion: boolean;
  colorFilter: ColorFilter;
  /** World look: 'original' or a texture pack id (see render/themes). */
  look: string;
}

export const DEFAULT_VIEW: ViewSettings = { cameraDistance: 15, cameraPitchDeg: 50, reducedMotion: false, colorFilter: 'gbc', look: ORIGINAL_LOOK };

export interface ActorState {
  key: string;
  sprite: number;
  x: number;
  y: number;
  facing: Facing;
  animFrame: number;
  /** Extra height (ledge hops). */
  lift: number;
  /** Standing in tall grass: the lower half is drawn behind the grass */
  grass?: boolean;
  visible: boolean;
}

export class OverworldView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  readonly manifest: AssetManifest;
  readonly profiler = new FrameProfiler();
  readonly quality = renderQuality(matchMedia('(pointer: coarse)').matches, window.devicePixelRatio);
  diagnostics() {
    const info = this.renderer.info;
    const scene = this.post?.sceneInfo ?? info.render;
    return { ...this.profiler.snapshot(), ...this.quality, look: this.pack?.pack.id ?? ORIGINAL_LOOK, drawCalls: scene.calls, triangles: scene.triangles, geometries: info.memory.geometries, textures: info.memory.textures };
  }
  private built?: BuiltMap;
  /** Meshes for connected maps that use a different tileset. */
  private extra: { built: BuiltMap; atlas: TileAtlas }[] = [];
  private atlas?: TileAtlas;
  private animator?: TileAnimator;
  private readonly waterMotion = new WaterMotion();
  private world?: WorldMap;
  private colors: RGB[] = [];
  private readonly actors = new Map<string, SpriteActor>();
  private readonly spriteTextures = new Map<number, SpriteTexture>();
  private camTarget = new THREE.Vector3();
  private camInit = false;
  readonly cameraDirector = new CameraDirector();
  private cutscene?: { shot?: CameraShot; focus: { x: number; z: number }; frame: number };
  private battleStage?: BattleStage;
  setBattleScene(active: boolean): void {
    if (active && !this.battleStage) {
      this.battleStage = new BattleStage();
      const pack = this.pack?.pack;
      if (pack && this.world) {
        const ground = MATERIAL_NAMES[floorMaterial(this.world.tileset.name)];
        const [r, g, b] = this.pack!.ramp(ground)[1];
        const platform = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
        const voidColor = new THREE.Color().setStyle(pack.indoorVoid);
        this.battleStage.setLook(this.packOutside
          ? { top: new THREE.Color().setStyle(pack.sky.zenith), bottom: new THREE.Color().setStyle(pack.sky.horizon), platform }
          : { top: voidColor, bottom: voidColor.clone().lerp(platform, 0.35), platform });
      }
    } else if (!active) { this.battleStage?.dispose(); this.battleStage = undefined; }
  }
  syncBattleScene(screen: TileScreen, frame: number): void { this.battleStage?.update(screen, frame, this.settings.reducedMotion); }
  battleAnimation(id: number, turn: number, frame: number): void { this.battleStage?.animation(id, turn, frame); }
  setCutscene(shot: CameraShot | undefined, focus: { x: number; z: number }, frame: number): void {
    this.cutscene = { shot, focus, frame };
  }
  settings: ViewSettings = { ...DEFAULT_VIEW };
  /** Vertical screen shake in squares (ShakeElevator's hSCY wobble). */
  shakeY = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly bundle: GameBundle,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.manifest = new AssetManifest(bundle);
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Build the scene for a map. `shift` moves the camera with the player across connections. */
  loadMap(world: WorldMap, paletteId: number, shift?: { dx: number; dy: number }, fadePal = 4): void {
    this.disposeMap();
    this.waterMotion.relocate(shift);
    this.world = world;
    this.paletteId = paletteId;
    this.syncPack();
    this.updatePalettes();
    this.bgRemap = FADE_PALS_BGP[fadePal - 1];
    this.objRemap = FADE_PALS_OBP0[fadePal - 1];
    this.colors = remapColors(this.atlasPalette(), this.bgRemap);
    this.atlas = buildTileAtlas(world.tileset, this.colors);
    this.spinnerShown = undefined;
    const outside = isOutsideMap(world);
    const foreign = (sx: number, sy: number) => world.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2)) !== world.tileset;
    this.built = buildMapMesh(world, this.manifest, this.atlas, { margin: this.quality.margin, flatBorder: !outside, skip: foreign, waterMotion: this.waterMotion, pack: this.pack });
    this.scene.add(this.built.mesh);
    this.buildForeignConnections(world);
    this.animator = new TileAnimator(world.tileset, this.atlas, this.bundle.tileTables.flowerTiles);
    this.outside = outside;
    if (this.pack) {
      this.pack.setPalette(this.basePalette);
      // Packs treat the forest as outdoors too (sun, sky and shadows), unlike the GB backdrop.
      this.packOutside = outside || outdoorTileset(world.tileset.name);
      this.pack.setLight(this.packOutside ? 'outdoor' : world.tileset.name === 'CAVERN' ? 'cave' : 'indoor');
      this.pack.setFade(this.bgRemap);
      this.bakePackShadows();
    }
    this.applySky();
    if (shift) {
      this.camTarget.add(new THREE.Vector3(shift.dx, 0, shift.dy));
      this.cameraDirector.shift(shift.dx, shift.dy);
    }
    else {
      this.camInit = false;
      this.cameraDirector.reset();
      this.cutscene = undefined;
    }
    if (shift) this.camera.position.add(new THREE.Vector3(shift.dx, 0, shift.dy));
  }

  private paletteId = 0;
  /** Reapply filters to the loaded atlases/sprites without rebuilding geometry; a new look rebuilds the map. */
  refreshSettings(): void {
    if (!this.world) return;
    if ((this.pack?.pack.id ?? ORIGINAL_LOOK) !== (texturePack(this.settings.look)?.id ?? ORIGINAL_LOOK)) {
      const [bg, obj] = [this.bgRemap, this.objRemap];
      this.loadMap(this.world, this.paletteId, undefined, 4);
      this.camInit = true;
      this.setPaletteRemap(bg, obj);
      return;
    }
    this.updatePalettes();
    this.pack?.setPalette(this.basePalette);
    this.recolorTextures();
  }

  // ------------------------------------------------------------ texture packs
  private pack?: PackRuntime;
  private sky?: SkyDome;
  private weather?: Weather;
  private post?: PostPass;
  private packTime = 0;
  private readonly blobs = new Map<string, THREE.Mesh>();
  private blobTexture?: THREE.Texture;
  /** The pack selected in settings, created/disposed to match (before building meshes). */
  private syncPack(): void {
    const want = texturePack(this.settings.look);
    if (this.pack?.pack === want) return;
    this.pack?.dispose();
    for (const o of [this.sky?.mesh, this.weather?.points]) if (o) this.scene.remove(o);
    this.sky?.dispose(); this.weather?.dispose(); this.post?.dispose();
    this.pack = this.sky = this.weather = this.post = undefined;
    for (const k of [...this.blobs.keys()]) this.removeBlob(k);
    if (!want) return;
    this.pack = new PackRuntime(want, this.quality.mobile);
    this.pack.setTime(this.packTime);
    this.sky = new SkyDome(want.sky, this.pack.uniforms);
    this.scene.add(this.sky.mesh);
    if (want.weather) {
      this.weather = new Weather(want.weather, this.pack.uniforms, this.quality.mobile, this.quality.pixelRatio);
      this.scene.add(this.weather.points);
    }
    // Phones keep the grade and vignette (one cheap pass), without blur, outline or bloom taps.
    const post = resolvedPost(want);
    if (post) this.post = new PostPass(this.quality.mobile ? { ...post, tiltShift: 0, outline: 0, bloom: 0 } : post);
  }
  /** The map atlas's four colours before rBGP: ROM shade indices in a pack. */
  private atlasPalette(): RGB[] {
    return this.pack ? INDEX_GRAYS : this.basePalette;
  }
  /** The area palette for still props (and every sprite without a pack). */
  private spritePalette: RGB[] = [];
  private updatePalettes(): void {
    const raw = paletteColors(this.bundle, this.paletteId);
    this.basePalette = applyFilter(raw, this.settings.colorFilter);
    this.spritePalette = this.pack?.pack.sprites?.filter ? applyFilter(raw, this.pack.pack.sprites.filter) : this.basePalette;
  }
  /** Texture packs dress characters in their own colours; the GB look uses the area palette. */
  private spritePaletteFor(id: number): RGB[] {
    const sprites = this.pack?.pack.sprites;
    if (!this.pack || id < 0 || this.bundle.sprites.find((s) => s.id === id) && this.manifest.sprite(id).kind === 'model') return this.spritePalette;
    const player = [c('sprite', 'SPRITE_RED'), extraSheetId('RedBikeSprite'), extraSheetId('RedFishingSprite')];
    const pikachu = [c('sprite', 'SPRITE_PIKACHU'), extraSheetId('SurfingPikachuSprite')];
    const people = sprites?.people ?? DEFAULT_CHARACTERS.people;
    const ramp = player.includes(id) ? sprites?.player ?? DEFAULT_CHARACTERS.player
      : pikachu.includes(id) ? sprites?.pikachu ?? DEFAULT_CHARACTERS.pikachu
      : people[(id * 7) % people.length];
    return ramp.map(hexToRgb);
  }
  private bakePackShadows(): void {
    if (!this.pack || !this.built) return;
    this.pack.bakeShadows(this.renderer, this.scene, [this.built.mesh, ...this.extra.map((e) => e.built.mesh)]);
  }
  private grassColors(): RGB[] {
    return this.pack ? remapColors(this.pack.ramp('TALL_GRASS'), this.bgRemap) : this.colors;
  }
  private bubbleColors(): RGB[] {
    return this.pack ? remapColors(this.spritePaletteFor(c('sprite', 'SPRITE_RED')), this.bgRemap) : this.colors;
  }
  private syncBlob(key: string, x: number, y: number, h: number, visible: boolean): void {
    let m = this.blobs.get(key);
    if (!m) {
      if (!visible) return;
      if (!this.blobTexture) {
        const size = 64, data = new Uint8Array(size * size * 4);
        for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
          const d = Math.hypot(i - size / 2 + 0.5, j - size / 2 + 0.5) / (size / 2);
          data[(j * size + i) * 4 + 3] = Math.round(255 * Math.max(0, 1 - d) ** 1.6);
        }
        this.blobTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
        this.blobTexture.magFilter = this.blobTexture.minFilter = THREE.LinearFilter;
        this.blobTexture.needsUpdate = true;
      }
      const geo = new THREE.PlaneGeometry(0.8, 0.5);
      geo.rotateX(-Math.PI / 2);
      m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000, map: this.blobTexture, transparent: true, opacity: 0.38, depthWrite: false }));
      m.renderOrder = 1;
      this.blobs.set(key, m);
      this.scene.add(m);
    }
    m.visible = visible;
    if (visible) m.position.set(x + 0.5, h + 0.015, y + 0.6);
  }
  private removeBlob(key: string): void {
    const m = this.blobs.get(key);
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
    this.blobs.delete(key);
  }

  private outside = false;
  private packOutside = false;
  private applySky(): void {
    if (this.pack) {
      const outside = this.packOutside;
      const fade = this.pack.uniforms.uFade.value as number;
      const toward = (c: THREE.Color) => c.clone().lerp(new THREE.Color(fade < 0 ? 0xffffff : 0x000000), Math.abs(fade));
      this.sky!.mesh.visible = outside;
      if (this.weather) this.weather.points.visible = (outside || !!this.weather.params.indoor) && !this.settings.reducedMotion;
      if (outside) {
        this.scene.background = null;
        const fog = this.pack.pack.fog ?? { near: 26, far: 60 };
        this.scene.fog = new THREE.Fog(toward(this.sky!.horizon()), fog.near, fog.far);
      } else {
        this.scene.background = toward(new THREE.Color().setStyle(this.pack.pack.indoorVoid));
        this.scene.fog = null;
      }
      return;
    }
    const sky = this.outside ? this.colors[0] : this.colors[3];
    const skyColor = new THREE.Color(`rgb(${sky[0]},${sky[1]},${sky[2]})`);
    this.scene.background = skyColor;
    this.scene.fog = this.outside ? new THREE.Fog(skyColor.getHex(), 24, 52) : null;
  }

  /** The palette before any rBGP/rOBP remap (the SGB palette, color-filtered) */
  private basePalette: RGB[] = [];
  /** rBGP and rOBP0 as color → shade maps (FadePal4 when normal) */
  private bgRemap = FADE_PALS_BGP[3];
  private objRemap = FADE_PALS_OBP0[3];
  /** Load FadePal1-8 into the palette registers */
  setFadePal(n: number): void {
    this.setPaletteRemap(FADE_PALS_BGP[n - 1], FADE_PALS_OBP0[n - 1]);
  }
  /** New rBGP/rOBP0 values: recolor tiles, sprites and the sky. */
  setPaletteRemap(bg: number[], obj: number[]): void {
    if ((String(bg) === String(this.bgRemap) && String(obj) === String(this.objRemap)) || !this.basePalette.length) return;
    this.bgRemap = bg;
    this.objRemap = obj;
    this.recolorTextures();
  }
  private recolorTextures(): void {
    this.colors = remapColors(this.atlasPalette(), this.bgRemap);
    this.pack?.setFade(this.bgRemap);
    this.atlas?.recolor(this.colors);
    for (const e of this.extra) e.atlas.recolor(this.colors);
    for (const [id, t] of this.spriteTextures) t.recolor(this.spritePaletteFor(id), this.objRemap);
    for (const t of this.bubbleTextures.values()) t.recolor(this.bubbleColors(), [0, 1, 2, 3]);
    this.grassTex?.recolor(this.grassColors(), [0, 1, 2, 3]);
    for (const a of this.actors.values()) a.refreshTexture();
    this.applySky();
  }

  /** Rebuild the map mesh after blocks changed (ReplaceTileBlock), keeping the camera. */
  rebuildBlocks(): void {
    const world = this.world;
    if (!world || !this.built || !this.atlas) return;
    this.scene.remove(this.built.mesh);
    this.built.dispose();
    const outside = isOutsideMap(world);
    const foreign = (sx: number, sy: number) => world.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2)) !== world.tileset;
    this.built = buildMapMesh(world, this.manifest, this.atlas, { margin: this.quality.margin, flatBorder: !outside, skip: foreign, waterMotion: this.waterMotion, pack: this.pack });
    this.scene.add(this.built.mesh);
    this.bakePackShadows();
  }

  /** Connected maps with their own tileset get their own mesh, translated into place. */
  private buildForeignConnections(world: WorldMap): void {
    const margin = this.quality.margin;
    for (const dir of ['north', 'south', 'west', 'east'] as const) {
      const conn = world.data.connections[dir];
      if (!conn) continue;
      const other = world.connected(dir);
      if (other.tileset === world.tileset) continue;
      // Offset of the other map's origin in our square coordinates.
      let ox = 0;
      let oy = 0;
      if (dir === 'north') [ox, oy] = [conn.offset * 2, -other.heightSquares];
      if (dir === 'south') [ox, oy] = [conn.offset * 2, world.heightSquares];
      if (dir === 'west') [ox, oy] = [-other.widthSquares, conn.offset * 2];
      if (dir === 'east') [ox, oy] = [world.widthSquares, conn.offset * 2];
      const region: [number, number, number, number] = [
        Math.max(0, -margin - ox),
        Math.max(0, -margin - oy),
        Math.min(other.widthSquares, world.widthSquares + margin - ox),
        Math.min(other.heightSquares, world.heightSquares + margin - oy),
      ];
      if (region[0] >= region[2] || region[1] >= region[3]) continue;
      const atlas = buildTileAtlas(other.tileset, this.colors);
      const built = buildMapMesh(other, this.manifest, atlas, { region, waterMotion: this.waterMotion, pack: this.pack });
      built.mesh.position.set(ox, 0, oy);
      this.scene.add(built.mesh);
      this.extra.push({ built, atlas });
    }
  }

  private disposeMap(): void {
    for (const e of this.extra) {
      this.scene.remove(e.built.mesh);
      e.built.dispose();
      e.atlas.texture.dispose();
    }
    this.extra = [];
    if (this.built) {
      this.scene.remove(this.built.mesh);
      this.built.dispose();
      this.atlas?.texture.dispose();
    }
    for (const a of this.actors.values()) {
      this.scene.remove(a.object);
      a.dispose();
    }
    this.actors.clear();
    for (const k of [...this.blobs.keys()]) this.removeBlob(k);
    for (const t of this.spriteTextures.values()) t.dispose();
    this.spriteTextures.clear();
    for (const m of this.shadows.values()) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.shadows.clear();
    this.shadowTexture = undefined;
    this.grassTex?.dispose();
    this.grassTex = undefined;
    for (const k of [...this.slides.keys()]) this.removeSlide(k);
  }

  private spriteTexture(id: number): THREE.Texture {
    let t = this.spriteTextures.get(id);
    if (!t) {
      const sp = this.bundle.sprites.find((s) => s.id === id);
      if (!sp) throw new MissingAssetError(`sprite ${id} not in bundle`);
      t = buildSpriteTexture(sp, this.spritePaletteFor(id), this.objRemap);
      this.spriteTextures.set(id, t);
    }
    return t;
  }

  /** Create/update an actor billboard. */
  syncActor(s: ActorState): void {
    let a = this.actors.get(s.key);
    if (a && a.sprite !== s.sprite) {
      // the sheet changed (bike, surf, fishing, Fly's bird): rebuild the actor
      this.scene.remove(a.object);
      a.dispose();
      a = undefined;
    }
    if (!a) {
      a = new SpriteActor(this.spriteTexture(s.sprite), this.manifest.sprite(s.sprite), s.sprite);
      if (this.pack?.pack.sprites?.tint) a.setTint(new THREE.Color().setStyle(this.pack.pack.sprites.tint));
      this.actors.set(s.key, a);
      this.scene.add(a.object);
    }
    a.facing = s.facing;
    a.animFrame = s.animFrame;
    const h = this.surfaceHeight(s.x, s.y);
    a.setPosition(s.x, s.y, h + s.lift);
    if (this.pack) this.syncBlob(s.key, s.x, s.y, h, s.visible && this.manifest.sprite(s.sprite).kind === 'billboard');
    a.setVisible(s.visible);
    a.setGrassOverlay(s.grass ? this.grassTexture() : undefined);
    a.updateFrame();
  }

  private grassTex?: SpriteTexture;
  /** The tileset's grass tile twice across the lower half of a 16x16 cell, color 0 clear */
  private grassTexture(): SpriteTexture | undefined {
    if (this.grassTex) return this.grassTex;
    const ts = this.world?.tileset;
    if (!ts || ts.grassTile === undefined || ts.grassTile < 0 || ts.grassTile === 0xff) return undefined;
    const px = new Array<number>(256).fill(0);
    for (let yy = 0; yy < 8; yy++)
      for (let xx = 0; xx < 16; xx++) px[(yy + 8) * 16 + xx] = ts.tilePixels[ts.grassTile * 64 + yy * 8 + (xx & 7)];
    this.grassTex = buildSpriteTexture({ id: -1, name: 'grass', tileCount: 4, pixels: px, frames: 1 }, this.grassColors(), [0, 1, 2, 3]);
    return this.grassTex;
  }

  /** LedgeHoppingShadow decals (the player's ledge jumps, Pikachu's hops), by key */
  private shadows = new Map<string, THREE.Mesh>();
  private shadowTexture?: SpriteTexture;
  setShadow(key: string, x: number, y: number, visible: boolean): void {
    let m = this.shadows.get(key);
    if (!m) {
      if (!visible) return;
      if (!this.shadowTexture) {
        // the tile and its x-flipped copy side by side, in a 16x16 cell's lower half
        const tile = this.bundle.misc.ledgeShadow;
        const px = new Array<number>(256).fill(0);
        for (let yy = 0; yy < 8; yy++)
          for (let xx = 0; xx < 8; xx++) {
            px[(yy + 4) * 16 + xx] = tile[yy * 8 + xx];
            px[(yy + 4) * 16 + 15 - xx] = tile[yy * 8 + xx];
          }
        this.shadowTexture = buildSpriteTexture({ id: -1, name: 'shadow', tileCount: 4, pixels: px, frames: 1 }, this.spritePalette, this.objRemap);
        this.spriteTextures.set(-2, this.shadowTexture);
      }
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, alphaTest: 0.5, depthWrite: false }));
      m.renderOrder = 1;
      this.shadows.set(key, m);
      this.scene.add(m);
    }
    m.visible = visible;
    if (visible) m.position.set(x + 0.5, this.surfaceHeight(x, y) + 0.02, y + 0.5);
  }

  /** Map regions drawn from a snapshot and slid sideways (the S.S. Anne leaving). */
  private slides = new Map<string, BuiltMap>();
  addSlide(key: string, world: WorldMap, region: [number, number, number, number]): void {
    if (!this.atlas || this.slides.has(key)) return;
    const built = buildMapMesh(world, this.manifest, this.atlas, { region, waterMotion: this.waterMotion, pack: this.pack });
    this.scene.add(built.mesh);
    this.slides.set(key, built);
  }
  moveSlide(key: string, dx: number, dy = 0): void {
    this.slides.get(key)?.mesh.position.set(dx, 0, dy);
  }
  removeSlide(key: string): void {
    const b = this.slides.get(key);
    if (!b) return;
    this.scene.remove(b.mesh);
    b.dispose();
    this.slides.delete(key);
  }

  /** Emotion bubble billboard above an actor (null hides it). */
  private bubble?: THREE.Mesh;
  private bubbleTextures = new Map<number, SpriteTexture>();
  setBubble(key: string | null, index = 0): void {
    if (!key) {
      if (this.bubble) this.bubble.visible = false;
      return;
    }
    const a = this.actors.get(key);
    if (!a) return;
    let tex = this.bubbleTextures.get(index);
    if (!tex) {
      const sheet = this.bundle.ui.emotionBubbles;
      const px = new Array<number>(256);
      for (let q = 0; q < 4; q++)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            px[((q >> 1) * 8 + y) * 16 + (q & 1) * 8 + x] = sheet.pixels[(index * 4 + q) * 64 + y * 8 + x];
      tex = buildSpriteTexture({ id: -1, name: 'bubble', tileCount: 4, pixels: px, frames: 1 }, this.bubbleColors(), [0, 1, 2, 3]);
      this.bubbleTextures.set(index, tex);
    }
    if (!this.bubble) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.translate(0, 0.5, 0);
      this.bubble = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
      this.bubble.renderOrder = 2;
      this.scene.add(this.bubble);
    }
    (this.bubble.material as THREE.MeshBasicMaterial).map = tex;
    (this.bubble.material as THREE.MeshBasicMaterial).needsUpdate = true;
    this.bubble.visible = true;
    this.bubble.position.copy(a.object.position).add(new THREE.Vector3(0, 1.05, 0));
    this.bubble.rotation.copy(a.object.rotation);
  }

  /** Remove actors whose keys are not in `keep`. */
  pruneActors(keep: Set<string>): void {
    for (const k of [...this.actors.keys()]) if (!keep.has(k)) this.removeActor(k);
  }

  removeActor(key: string): void {
    this.removeBlob(key);
    const a = this.actors.get(key);
    if (!a) return;
    this.scene.remove(a.object);
    a.dispose();
    this.actors.delete(key);
  }

  /** Interpolated ground height under a fractional square position. */
  surfaceHeight(x: number, y: number): number {
    if (!this.built) return 0;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const h0 = Math.max(0, this.built.heightAt(fx, fy));
    const h1 = Math.max(0, this.built.heightAt(Math.ceil(x), Math.ceil(y)));
    // Actors only ever stand on walkable squares (height 0 or a ledge lip).
    return Math.min(0.12, h0 + (h1 - h0) * Math.max(x - fx, y - fy));
  }

  /** Follow a point (the player) with a smoothed third-person camera. */
  follow(x: number, y: number, dt: number): void {
    const player = { x: x + 0.5, z: y + 0.5 };
    const cue = this.cutscene;
    const pose = this.cameraDirector.sample(cue?.shot, cue?.focus ?? player, player, cue?.frame ?? 0, this.settings.reducedMotion);
    const target = new THREE.Vector3(pose.x, 0, pose.z);
    if (!this.camInit || this.settings.reducedMotion || this.cameraDirector.active) {
      this.camTarget.copy(target);
      this.camInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 10);
      this.camTarget.lerp(target, k);
    }
    const pitch = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(this.settings.cameraPitchDeg + pose.pitch, 25, 75));
    const yaw = THREE.MathUtils.degToRad(pose.yaw);
    const d = this.settings.cameraDistance * pose.zoom;
    this.camera.position.set(this.camTarget.x + Math.sin(yaw) * Math.cos(pitch) * d, this.camTarget.y + Math.sin(pitch) * d, this.camTarget.z + Math.cos(yaw) * Math.cos(pitch) * d);
    this.camera.position.y += this.shakeY;
    this.camera.lookAt(this.camTarget.x, 0.4 + this.shakeY, this.camTarget.z - 0.6);
    cutawayUniforms.uFocus.value.set(x + 0.5, 0.5, y + 0.5);
    cutawayUniforms.uCamPos.value.copy(this.camera.position);
    this.pack?.setPlayer(x + 0.5, 0.7, y + 0.5);
    this.weather?.follow(this.camTarget.x, this.camTarget.z);
  }

  private spinnerShown?: boolean;
  /**
   * LoadSpinnerArrowTiles: the four arrow tiles of the FACILITY or GYM tileset
   * from SpinnerArrowAnimTiles (true) or from the tileset itself (false).
   */
  setSpinnerArrows(animated: boolean | undefined): void {
    if (animated === this.spinnerShown || !this.world || !this.atlas) return;
    this.spinnerShown = animated;
    if (animated === undefined) return;
    const ts = this.world.tileset;
    const facility = ts.id === c('tileset', 'FACILITY');
    // (anim tile, tileset tile) per spinner_tiles.asm
    const pairs: [number, number][] = facility ? [[0, 0x20], [1, 0x21], [2, 0x30], [3, 0x31]] : [[1, 0x3c], [3, 0x3d], [0, 0x4c], [2, 0x4d]];
    for (const [src, dest] of pairs)
      this.atlas.drawTile(dest, animated ? this.bundle.misc.spinnerTiles[src] : ts.tilePixels.slice(dest * 64, dest * 64 + 64));
  }

  /** Advance tile animations by GB frames. */
  tickFrames(frames: number): void {
    this.animator?.tick(frames);
    this.waterMotion.advance(frames, this.settings.reducedMotion);
    if (this.pack && !this.settings.reducedMotion) {
      this.packTime = (this.packTime + frames / 59.7275) % 3600;
      this.pack.setTime(this.packTime);
    }
  }

  render(): void {
    if (this.battleStage) return this.battleStage.render(this.renderer);
    for (const a of this.actors.values()) a.faceCamera(this.camera);
    this.sky?.follow(this.camera);
    if (this.post) this.post.render(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  get currentWorld(): WorldMap | undefined {
    return this.world;
  }
}
