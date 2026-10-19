import { c } from '../rom/constants';
import { cutsceneCamera } from './cutscenes';
/** Mirrors engine state into the Three.js view every display frame. */
import type { Engine } from '../engine/Engine';
import type { OverworldView } from './OverworldView';
import { ROD_OFFSET } from '../field/fishing';
import { BIRD_SPRITE } from '../field/warpAnims';

const NORMAL_X = 0x40;
const NORMAL_Y = 0x3c;
import { extraSheetId } from '../engine/sprites';
import { overworldPaletteId, paletteColors, applyFilter, FADE_PALS_BGP, FADE_PALS_OBP0, fadePalForLevel, loadGBPalIndex } from './palette';

export interface ViewSync { (): void; refreshSettings(): void }
export function attachView(engine: Engine, view: OverworldView): ViewSync {
  const previousBattleScene = engine.hooks.battleScene;
  engine.hooks.battleScene = (active) => { previousBattleScene?.(active); view.setBattleScene(active); };
  const previousBattleAnimation = engine.hooks.battleAnimation;
  engine.hooks.battleAnimation = (id, turn) => {
    previousBattleAnimation?.(id, turn);
    view.battleAnimation(id, turn, engine.state.frames);
  };
  let loadedMap = -1;
  const grassPriority = new Map<number, boolean>();
  let blockVersion = 0;
  // palette fades: the FadePal in the palette registers (LoadGBPal's when no fade is on)
  let fade: { level: number; color: 'black' | 'white' } = { level: 0, color: 'black' };
  const fadePal = () => fadePalForLevel(fade.level, fade.color, loadGBPalIndex(engine.ram.mapPalOffset));
  // a raw rBGP written over the fade's (ChangeBGPalColor0_4Frames)
  let bgpOverride: number | undefined;
  const applyFade = () => {
    const n = fadePal();
    if (bgpOverride !== undefined) {
      const m = [0, 1, 2, 3].map((i) => (bgpOverride! >> (i * 2)) & 3);
      view.setPaletteRemap(m, FADE_PALS_OBP0[n - 1]);
      engine.screen.setFadeMap(m);
      return;
    }
    view.setFadePal(n);
    // the text layer: only real fades (a dark cave's LoadGBPal leaves the menus readable)
    engine.screen.setFadeMap(fade.level > 0 ? FADE_PALS_BGP[n - 1] : undefined);
  };
  engine.hooks.bgp = (v) => {
    bgpOverride = v;
    applyFade();
  };
  const prevFade = engine.hooks.fade;
  engine.hooks.fade = (level, color = 'black') => {
    prevFade?.(level, color);
    fade = { level, color };
    applyFade();
  };
  let palOffset = 0;
  let uiPalette: number | undefined;
  let uiLayout: Parameters<NonNullable<Engine['hooks']['paletteLayout']>> | undefined;
  const applyUiPalette = () => {
    const f = view.settings.colorFilter;
    if (uiLayout) {
      engine.screen.setPaletteLayout(uiLayout[0].map((id) => applyFilter(paletteColors(engine.bundle, id), f)), uiLayout[1]);
    } else {
      const w = engine.world;
      const id = uiPalette ?? (w ? overworldPaletteId(w.data.id, w.data.tileset, engine.state.player.lastMap) : c('palette', 'PAL_PALLET'));
      engine.screen.setPalette(applyFilter(paletteColors(engine.bundle, id), f));
    }
  };
  const onMapChanged = () => {
    const w = engine.world;
    const pal = overworldPaletteId(w.data.id, w.data.tileset, engine.state.player.lastMap);
    const shift = engine.connectionShift;
    engine.connectionShift = undefined;
    palOffset = engine.ram.mapPalOffset;
    grassPriority.clear();
    view.loadMap(w, pal, shift, fadePal());
    uiPalette = undefined; uiLayout = undefined;
    applyUiPalette();
    loadedMap = w.data.id;
    blockVersion = w.blockVersion;
  };
  engine.hooks.palette = (pal) => { uiPalette = pal; uiLayout = undefined; applyUiPalette(); };
  engine.hooks.paletteLayout = (pals, blocks) => { uiLayout = [pals, blocks]; applyUiPalette(); };
  const prev = engine.hooks.onMapChanged;
  engine.hooks.onMapChanged = (w) => {
    prev?.(w);
    onMapChanged();
  };
  const sync = () => {
    if (!engine.world) return;
    if (loadedMap !== engine.world.data.id || palOffset !== engine.ram.mapPalOffset) onMapChanged();
    else if (blockVersion !== engine.world.blockVersion) {
      blockVersion = engine.world.blockVersion;
      view.rebuildBlocks();
    }
    const keep = new Set<string>();
    // grass priority: the player's from the tile it stands on every frame; other
    // sprites' only while the player isn't walking (CheckSpriteAvailability)
    const grassTile = engine.world.tileset.grassTile;
    const inGrass = (s: (typeof engine.sprites)[number]): boolean => {
      if (s.slot === 0) return engine.ram.tilePlayerStandingOn === grassTile;
      if (!engine.ram.walkCounter) grassPriority.set(s.slot, engine.world.collisionTile(s.mapX, s.mapY) === grassTile);
      return grassPriority.get(s.slot) ?? false;
    };
    for (const s of engine.sprites) {
      if (!s || !s.pictureId) continue;
      const key = `s${s.slot}`;
      keep.add(key);
      const [x, y] = engine.spriteRenderPos(s);
      const pa = s.slot === 0 ? engine.ram.playerAnim : undefined;
      if (pa) {
        // Leave/EnterMapAnim: screen y/x offsets from the normal $3c/$40, the spin, the bird
        const dy = ((NORMAL_Y - pa.y + 128) & 0xff) - 128;
        view.syncActor({
          key,
          sprite: pa.bird ? BIRD_SPRITE() : s.pictureId,
          x: x + (pa.x - NORMAL_X) / 16,
          y,
          facing: pa.facing,
          animFrame: pa.flap ? 1 : 0,
          lift: dy / 16,
          visible: !pa.hidden,
        });
        continue;
      }
      view.syncActor({
        key,
        sprite: s.pictureId,
        x,
        y,
        facing: engine.facingOf(s),
        animFrame: s.animFrame,
        lift: s.slot === 0 ? engine.jumpLift / 16 : s.slot === engine.pikachuSlot && !s.obj ? engine.pikachu.lift / 16 : 0,
        visible: !s.hidden,
        grass: inGrass(s),
      });
      // LoadHoppingShadowOAM / AnimatePikachuShadow: the shadow on the ground under a hop
      if (s.slot === 0) view.setShadow('player', x, y, engine.ram.ledgeOrFishing && !engine.ram.fishing && !s.hidden);
      else if (s.slot === engine.pikachuSlot && !s.obj) view.setShadow('pikachu', x, y, engine.pikachu.shadow && !s.hidden);
    }
    // FishingAnim's rod (OAM sprite 39) next to the player
    const fishing = engine.ram.fishing;
    const player = engine.sprites[0];
    if (fishing?.rod && player) {
      const [x, y] = engine.spriteRenderPos(player);
      const facing = engine.facingOf(player);
      const [dx, dy, lift] = ROD_OFFSET[facing];
      keep.add('rod');
      view.syncActor({ key: 'rod', sprite: extraSheetId('FishingRod'), x: x + dx, y: y + dy, facing, animFrame: 0, lift: lift - fishing.shake / 16, visible: true });
    }
    // Cut / boulder dust OAM animations
    const fx = engine.ram.fieldEffect;
    if (fx) {
      const actor = (key: string, sheet: Parameters<typeof extraSheetId>[0], x: number, y: number, facing: 'down' | 'up' = 'down', lift = 0) => {
        keep.add(key);
        view.syncActor({ key, sprite: extraSheetId(sheet), x, y, facing, animFrame: 0, lift, visible: true });
      };
      const px = fx.t / 16;
      if (fx.kind === 'cutTree') {
        // AnimCut: the left column drifts right and the right column left, 1 px per frame
        actor('fx0', 'CutTree', fx.x + px, fx.y, 'down');
        actor('fx1', 'CutTree', fx.x - px, fx.y, 'up');
      } else if (fx.kind === 'cutGrass') {
        // the four leaves spread out and fall
        const d = (fx.t / fx.frames) * 0.75;
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy], i) => actor(`fx${i}`, 'CutLeaf', fx.x + sx * d * 0.5, fx.y, 'down', 0.5 - sy * d * 0.5 - d));
      } else {
        // AnimateBoulderDust: the smoke drifts back toward the player 1 px per step
        const [dx, dy] = { down: [0, -1], up: [0, 1], left: [1, 0], right: [-1, 0] }[engine.state.player.facing];
        actor('fx0', 'BoulderDust', fx.x + (dx * fx.t) / 16, fx.y + (dy * fx.t) / 16);
      }
    }
    // a sliding map region (the S.S. Anne sailing away)
    const slide = engine.ram.slide;
    if (slide) {
      view.addSlide('slide', slide.world, slide.region);
      view.moveSlide('slide', slide.dx / 16);
      // smoke puffs at screen coords, relative to the player's $40/$3c
      const [px, py] = engine.spriteRenderPos(engine.sprites[0]);
      slide.puffs.forEach((p, i) => {
        keep.add(`puff${i}`);
        view.syncActor({ key: `puff${i}`, sprite: extraSheetId('BoulderDust'), x: px + (p.x - NORMAL_X) / 16, y: py + (p.y - NORMAL_Y) / 16, facing: 'down', animFrame: 0, lift: 0.75, visible: true });
      });
    } else view.removeSlide('slide');
    view.pruneActors(keep);
    view.shakeY = engine.ram.shakeY / 16;
    const b = engine.ram.emotionBubble;
    view.setBubble(b ? `s${b.slot}` : null, b?.bubble ?? 0);
    view.setSpinnerArrows(engine.ram.spinnerArrowsAnimated);
    const cue = cutsceneCamera(engine);
    view.setCutscene(cue.shot, cue.focus, engine.state.frames);
    view.syncBattleScene(engine.screen, engine.state.frames);
  };
  return Object.assign(sync, { refreshSettings: () => { view.refreshSettings(); applyUiPalette(); applyFade(); } });
}
