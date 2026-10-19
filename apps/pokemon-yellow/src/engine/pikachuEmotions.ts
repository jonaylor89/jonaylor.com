/**
 * Talking to Pikachu (engine/pikachu/pikachu_emotions.asm): the map-specific
 * and mood/happiness-based choice of emotion, the PIKAEMOTION_* command
 * interpreter, and the Pikachu picture animation it shows
 * (engine/pikachu/pikachu_pic_animation.asm), drawn in a 5x5 window with the
 * animation's tiles loaded over the font tiles ($80 and up).
 */
import type { Co, Engine } from './Engine';
import { c } from '../rom/constants';
import { isPlayerPikachuAsleepInParty, isStarterPikachu } from '../game/pikachu';
import { PIKA_NOT_FOLLOWING } from './pikachu';
import { PAD_A, PAD_B } from './pad';
import { LowSensitivity } from '../ui/menus';

/** T-states PlayPikachuPCM spends per sample byte, and per frame. */
const PCM_TSTATES_PER_BYTE = 1440;
const TSTATES_PER_FRAME = 70224;

/** ldpikacry: PikachuCryN is entry N - 1 of PikachuCriesPointerTable. */
export const pikachuCry = (n: number): number => n - 1;

/** PlayPikachuSoundClip: three frames, then the CPU plays the samples (blocking). */
export function pikachuCryFrames(e: Engine, id: number): number {
  const cry = e.bundle.pikachuEmotions.cries[id];
  if (!cry) return 0;
  return 3 + Math.ceil((cry.length * PCM_TSTATES_PER_BYTE) / TSTATES_PER_FRAME);
}

export function* playPikachuCry(e: Engine, id: number): Co {
  if (id === 0xff) return;
  const cry = e.bundle.pikachuEmotions.cries[id];
  e.hooks.playPikachuCry?.(id);
  yield* e.delayFrames(3);
  if (!cry) return;
  // with interrupts off: wave RAM all $ff on full volume, then NR32 toggled per sample bit
  const writes: [number, number, number][] = [
    [0, 0xff26, 0x80],
    [0, 0xff24, 0x77],
    [0, 0xff1a, 0x00],
  ];
  for (let i = 0; i < 16; i++) writes.push([0, 0xff30 + i, 0xff]);
  const nr51 = e.sound.regs[0x15] | 0x44;
  writes.push([0, 0xff1a, 0x80], [0, 0xff25, nr51], [0, 0xff1b, 0xff], [0, 0xff1c, 0x20], [0, 0xff1d, 0xff], [0, 0xff1e, 0x87]);
  const bin = atob(cry.data);
  const T = PCM_TSTATES_PER_BYTE / 8;
  let t = 0;
  let last = -1;
  for (let k = 0; k < cry.length; k++) {
    const d = k < bin.length ? bin.charCodeAt(k) : 0;
    for (let j = 0; j < 8; j++, t += T) {
      const v = (d << j) & 0x80 ? 0x20 : 0;
      if (v !== last) writes.push([t, 0xff1c, v]);
      last = v;
    }
  }
  writes.push([t, 0xff26, 0x80], [t, 0xff1a, 0x00]);
  e.timedSoundWrites(writes);
  // the registers the sound engine reads back
  e.sound.pokeRegs([[0xff24, 0x77], [0xff25, nr51], [0xff1a, 0], [0xff1c, last]]);
  const frames = Math.ceil(t / TSTATES_PER_FRAME);
  e.audioSuspend = frames;
  yield* e.delayFrames(frames);
}

/** TalkToPikachu: after the player pressed A facing Pikachu (DisplayTextID TEXT_PIKACHU_ANIM). */
export function* talkToPikachu(e: Engine): Co {
  e.ram.playerMovingDirection = 0;
  e.ram.autoTextBoxControl = 1;
  e.ram.fontLoaded = true;
  e.updateSprites();
  const special = mapSpecificPikachuExpression(e);
  yield* playPikachuEmotion(e, special ?? pikaPicAnimationScriptIndex(e));
  e.closeTextDisplay();
  e.ram.autoTextBoxControl = 0;
}

/** MapSpecificPikachuExpression */
function mapSpecificPikachuExpression(e: Engine): number | undefined {
  const map = e.world.data.id;
  const M = (n: string) => c('map', n);
  const following = !(e.ram.pikachuOverworldStateFlags & PIKA_NOT_FOLLOWING);
  if (map === M('POKEMON_FAN_CLUB')) {
    if (!e.ram.pikachuMapScriptActive) return 29;
    if (!following) return 30;
  } else if (map === M('PEWTER_POKECENTER')) {
    if (!following) return 26;
  } else if (map === M('BILLS_HOUSE') && !following) {
    // BillsHouse_CheckPikachuEmotion
    const S = (n: string) => c('map_script', `SCRIPT_BILLSHOUSE_${n}`);
    const cur = e.state.mapScripts[map] ?? 0;
    if (cur === S('SCRIPT5')) return 27;
    if (cur === S('SCRIPT0')) return 23;
    return e.event('EVENT_MET_BILL_2') ? 31 : 32;
  }
  // .check_pikachu_status
  if (isPlayerPikachuAsleepInParty(e.state)) return 11;
  const pika = e.state.party.find((m) => isStarterPikachu(e.state, m));
  if (pika && (pika.status || !pika.hp)) return 28; // CheckPikachuStatusCondition
  if (map >= M('POKEMON_TOWER_1F') && map <= M('POKEMON_TOWER_7F')) return 22;
  const mod = e.ram.pikachuEmotionModifier;
  if (mod) return [18, 21, 23, 24, 25][mod - 1];
  return undefined;
}

/** GetPikaPicAnimationScriptIndex: a column by mood, a row by happiness. */
function pikaPicAnimationScriptIndex(e: Engine): number {
  const t = e.bundle.pikachuEmotions;
  const { mood, happiness } = e.state.pikachu;
  let col = t.moods[t.moods.length - 1][1];
  for (const [threshold, column] of t.moods)
    if (threshold >= mood) {
      col = column;
      break;
    }
  const row = t.happiness.find((r) => r[0] >= happiness) ?? t.happiness[t.happiness.length - 1];
  return row[col];
}

/** PlaySpecificPikachuEmotion / load_expression: run a PikachuEmotionTable script. */
export function* playPikachuEmotion(e: Engine, index: number): Co {
  e.ram.expressionNumber = index;
  const script = e.bundle.pikachuEmotions.emotions[index];
  if (!script) throw new Error(`no Pikachu emotion ${index}`);
  for (const cmd of script) {
    switch (cmd.op) {
      case 1:
        yield* e.printText(cmd.text!);
        break;
      case 2:
        yield* playPikachuCry(e, cmd.arg!);
        break;
      case 3: {
        // ShowPikachuEmoteBubble
        e.ram.emotionBubble = { slot: e.pikachuSlot, bubble: cmd.arg! };
        yield* e.delayFrames(60);
        e.ram.emotionBubble = undefined;
        break;
      }
      case 4:
        yield* e.pikachu.applyMovementData(cmd.movement!);
        break;
      case 5:
        yield* pikaPic(e, cmd.arg!);
        break;
      case 6:
        yield* emotionSubcommand(e, cmd.arg!);
        break;
      case 7:
        yield* e.delayFrames(cmd.arg!);
        break;
      case 9:
        turnAwayFromPlayer(e);
        e.updateSprites();
        break;
    }
  }
}

/** StarterPikachuEmotionCommand_turnawayfromplayer */
function turnAwayFromPlayer(e: Engine): void {
  const f = { down: 0, up: 4, left: 8, right: 12 }[e.state.player.facing];
  e.pikachu.facing = f ^ 4;
  e.pikachu.renderDir = f ^ 4;
  e.pikachu.sync();
}

function* emotionSubcommand(e: Engine, n: number): Co {
  switch (n) {
    case 0: // LoadPikachuSpriteIntoVRAM
      return;
    case 1: // LoadFontTilePatterns
      e.screen.clearGlyphOverrides();
      return;
    case 2: // Pikachu_LoadCurrentMapViewUpdateSpritesAndDelay3
      e.screen.fill(0, 0, 20, 18, -1);
      e.updateSprites();
      yield* e.delayFrames(3);
      return;
    case 3:
      yield* e.waitForTextScrollButtonPress();
      return;
    case 4: // PikachuPewterPokecenterCheck
      if (e.world.data.id !== c('map', 'PEWTER_POKECENTER')) return;
      e.ram.pikachuOverworldStateFlags &= ~PIKA_NOT_FOLLOWING;
      turnAwayFromPlayer(e);
      return;
    case 5: // PikachuFanClubCheck
      if (e.world.data.id !== c('map', 'POKEMON_FAN_CLUB')) return;
      e.ram.pikachuOverworldStateFlags &= ~PIKA_NOT_FOLLOWING;
      turnAwayFromPlayer(e);
      return;
    case 6: // PikachuBillsHouseCheck
      if (e.world.data.id !== c('map', 'BILLS_HOUSE')) return;
      e.ram.pikachuOverworldStateFlags &= ~PIKA_NOT_FOLLOWING;
      return;
    default:
      throw new Error(`Pikachu emotion subcommand ${n}`);
  }
}

// ------------------------------------------------------------------ the Pikachu picture animation
interface PicObject {
  id: number;
  frameset: number;
  frameIdx: number;
  frameTimer: number;
  vtile: number;
  x: number;
  y: number;
}

const decode2bpp = (b64: string): number[][] => {
  const bin = atob(b64);
  const tiles: number[][] = [];
  for (let t = 0; t * 16 < bin.length; t++) {
    const px = new Array<number>(64);
    for (let y = 0; y < 8; y++) {
      const lo = bin.charCodeAt(t * 16 + y * 2);
      const hi = bin.charCodeAt(t * 16 + y * 2 + 1);
      for (let x = 0; x < 8; x++) px[y * 8 + x] = ((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1);
    }
    tiles.push(px);
  }
  return tiles;
};

/** StarterPikachuEmotionCommand_pikapic */
export function* pikaPic(e: Engine, number: number): Co {
  const P = e.bundle.pikachuEmotions.pikapic;
  const s = e.screen;
  const placeBorder = function* () {
    s.box(6, 5, 5, 5);
    yield* e.delayFrames(3);
    e.updateSprites();
    yield* e.delayFrames(3);
  };
  yield* placeBorder();
  // ResetPikaPicAnimBuffer
  const objects: (PicObject | undefined)[] = [undefined, undefined, undefined, undefined];
  let objectCount = 0;
  const used: { id: number; offset: number }[] = [];
  let usedTiles = 0;
  let timer = 100;
  let delay = 0;
  const drawX = 7;
  const drawY = 6;
  const script = P.scripts[number < 0x1d ? number : 0];
  let pc = script.entry;
  const joy = new LowSensitivity(e);

  const loadGfx = (id: number) => {
    const g = P.gfx[id];
    if (!g) throw new Error(`no pikapic graphic ${id}`);
    if (used.some((u) => u.id === id) || used.length >= 8) return; // the original crashes here
    const size = g.size === 0xff ? 25 : g.size;
    const offset = 0x80 + usedTiles;
    used.push({ id, offset });
    usedTiles += size;
    if (usedTiles > 0x80) return;
    decode2bpp(g.data).forEach((px, i) => s.setGlyphOverride(offset + i, px));
  };

  const drawTilemap = (tm: number, o: PicObject) => {
    if (!tm) return;
    const map = P.tilemaps[tm];
    if (!map) throw new Error(`no pikapic tilemap ${tm}`);
    for (let r = 0; r < map.rows; r++)
      for (let col = 0; col < map.cols; col++) {
        const t = map.tiles[r * map.cols + col];
        if (t === 0xff) continue;
        s.put(drawX + o.x + col, drawY + o.y + r, (t + o.vtile) & 0xff);
      }
  };

  const thunderbolt = function* () {
    // the music paused; MoveSoundTable's entry at index THUNDERBOLT (one past Thunderbolt's own) from the battle SFX bank
    const snd = e.sound;
    snd.setMute(1);
    yield;
    const bank = snd.audioBank;
    snd.setBanks(e.bundle.audio.engineBanks[1], e.bundle.audio.engineBanks[1]);
    const t = e.bundle.audio.moveSounds;
    const i = c('move', 'THUNDERBOLT') * 3;
    snd.setModifiers(t[i + 1], t[i + 2]);
    snd.playSound(t[i]);
    for (const [frames, bgp] of P.thunderboltPals) {
      const sum = (bgp & 3) + ((bgp >> 2) & 3) + ((bgp >> 4) & 3) + ((bgp >> 6) & 3);
      e.hooks.fade?.(sum >= 6 ? 0 : (6 - sum) / 6, 'white');
      yield* e.delayFrames(frames);
    }
    e.hooks.fade?.(0);
    yield* e.waitForSoundToFinish();
    snd.setBanks(bank, bank);
    snd.setMute(0);
  };

  for (;;) {
    // RunPikaPicAnimSetupScript
    if (delay) delay--;
    else {
      for (let done = false; !done; ) {
        const cmd = script.cmds[pc];
        if (!cmd) throw new Error(`pikapic script ${number} ran off its end`);
        let next = cmd.next;
        switch (cmd.op) {
          case 1:
            delay = cmd.args[0];
            break;
          case 2:
            loadGfx(cmd.args[0]);
            break;
          case 3: {
            const slot = objects.findIndex((o) => !o);
            if (slot >= 0) {
              objectCount = (objectCount + 1) & 0xff;
              const [frameset, , vtile, x, y] = cmd.args;
              objects[slot] = { id: objectCount, frameset, frameIdx: 0, frameTimer: 0, vtile, x, y };
            }
            break;
          }
          case 6: {
            const slot = objects.findIndex((o) => o?.id === cmd.args[0]);
            if (slot >= 0) objects[slot] = undefined;
            break;
          }
          case 9:
            next = cmd.args[0];
            break;
          case 0x0a:
            timer = cmd.args[0] | (cmd.args[1] << 8);
            break;
          case 0x0b:
            if (cmd.args[0] !== 0xff) yield* playPikachuCry(e, cmd.args[0]);
            break;
          case 0x0c:
            yield* thunderbolt();
            break;
          case 0x0d:
            done = true;
            break;
          case 0x0e:
            timer = 1;
            done = true;
            break;
        }
        pc = next;
      }
    }
    // AnimateCurrentPikaPicAnimFrame
    for (const o of objects) {
      if (!o) continue;
      const fs = P.frames[o.frameset < 0x23 ? o.frameset : 4];
      for (let guard = 0; guard < 2; guard++) {
        if (o.frameIdx * 2 >= fs.length) {
          // $e0: back to the first frame
          o.frameIdx = 0;
          o.frameTimer = 0;
          continue;
        }
        const tm = fs[o.frameIdx * 2];
        const duration = fs[o.frameIdx * 2 + 1];
        drawTilemap(tm, o);
        if (duration) {
          o.frameTimer++;
          if (o.frameTimer === duration) {
            o.frameTimer = 0;
            o.frameIdx++;
          }
        }
        break;
      }
    }
    // PikaPicAnimTimerAndJoypad
    yield* e.delayFrames(3);
    const lo = (timer & 0xff) - 1;
    let hi = timer >> 8;
    let expired = false;
    if (lo & 0xff) timer = (hi << 8) | (lo & 0xff);
    else if (!hi) expired = true;
    else {
      hi--;
      timer = hi << 8;
    }
    if (expired) break;
    if (joy.read(e) & (PAD_A | PAD_B)) break;
  }
  yield* placeBorder();
}

/** For tests: the emotion talking to Pikachu would play now. */
export function pikachuEmotionIndex(e: Engine): number {
  return mapSpecificPikachuExpression(e) ?? pikaPicAnimationScriptIndex(e);
}

