/**
 * Learning moves and evolving: LearnMove (engine/pokemon/learn_move.asm),
 * LearnMoveFromLevelUp and EvolutionAfterBattle (engine/pokemon/evos_moves.asm)
 * and EvolveMon (engine/movie/evolution.asm).
 */
import { withoutTextAsm } from '../rom/text';
import type { Co, Engine } from '../engine/Engine';
import type { PartyMon } from './state';
import type { TextOp } from '../data/schema';
import type { Battle } from '../battle/Battle';
import { c } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { calcStats, movePP, species } from './pokemon';
import { encodePlain, type TextContext } from '../ui/TextPrinter';
import { handleMenuInput, twoOptionMenu, LowSensitivity } from '../ui/menus';
import { PAD_A, PAD_B } from '../engine/pad';
import { picPixels } from '../rom/extract/pics';
import { isStarterPikachu } from './pikachu';

export interface LearnContext {
  battle?: Battle;
  /** Address-keyed text buffers (wStringBuffer, wNameBuffer, wLearnMoveMonName). */
  mem: Map<number, string | number>;
}

function setMem(ctx: LearnContext, name: string, v: string | number): void {
  ctx.mem.set(ramSym(name), v);
}

function ops(e: Engine, labels: string[]): TextOp[] {
  return labels.flatMap((l): TextOp[] => {
    if (l === '<pause>') return [{ t: 'pause' }];
    if (l === '<promptbutton>') return [{ t: 'promptbutton' }];
    const t = e.bundle.texts[l];
    if (!t) throw new Error(`text ${l} missing from bundle`);
    return withoutTextAsm(t);
  });
}

/** Stands for OneTwoAndText's text_asm (SFX_SWAP) inside a print */
const SWAP_SFX_OP = '<swap-sfx>';
const SWAP_SFX_CMD = 0x100;

function* print(e: Engine, ctx: LearnContext, ...labels: string[]): Co {
  const i = labels.indexOf(SWAP_SFX_OP);
  const list = i < 0 ? ops(e, labels) : [...ops(e, labels.slice(0, i)), { t: 'sound' as const, id: SWAP_SFX_CMD }, ...ops(e, labels.slice(i + 1))];
  const base: Partial<TextContext> = ctx.battle
    ? ctx.battle.textContext()
    : { ram: (label, addr) => (addr !== undefined && ctx.mem.has(addr) ? ctx.mem.get(addr) : e.ramValue(label, addr)) };
  if (ctx.battle) for (const [k, v] of ctx.mem) ctx.battle.mem.set(k, v);
  if (i < 0) {
    yield* e.printOps(list, base);
    return;
  }
  // SFX_SWAP from Audio Engine 1's bank with the music paused, then everything restored
  let restore: (() => void) | undefined;
  yield* e.printOps(list, {
    ...base,
    sound: (cmd) => {
      if (cmd !== SWAP_SFX_CMD) return e.textCommandSound(cmd);
      const snd = e.sound;
      const bank = snd.audioBank;
      snd.setMute(1);
      snd.setBanks(e.bundle.audio.engineBanks[0], e.bundle.audio.engineBanks[0]);
      e.hooks.playSound?.('SFX_SWAP');
      restore = () => {
        snd.setBanks(bank, bank);
        snd.setMute(0);
      };
    },
    soundBusy: () => {
      if (e.sound.sfxPlaying) return true;
      restore?.();
      restore = undefined;
      return false;
    },
  });
}

/** LearnMoveFromLevelUp: only the first learnset entry for this exact level is considered. */
export function* learnMoveFromLevelUp(e: Engine, party: PartyMon[], which: number, level: number, ctx: LearnContext): Co {
  const pm = party[which];
  const sp = species(e.bundle, pm.species);
  const entry = sp.learnset.find((l) => l.level === level);
  if (!entry) return;
  if (pm.moves.includes(entry.move)) return;
  setMem(ctx, 'wStringBuffer', e.bundle.moves[entry.move - 1].name);
  const learned = yield* learnMove(e, party, which, entry.move, ctx);
  if (!learned) return;
  if (isStarterPikachu(e.state, pm) && (entry.move === c('move', 'THUNDERBOLT') || entry.move === c('move', 'THUNDER'))) {
    e.store.dispatch({ type: 'setPikachu', mood: 0x85 }, { undoable: false });
    e.ram.pikachuEmotionModifier = 5;
  }
}

/** LearnMove: returns true if the move was learned. */
export function* learnMove(e: Engine, party: PartyMon[], which: number, move: number, ctx: LearnContext): Co<boolean> {
  const pm = party[which];
  const saved = e.screen.cells.slice();
  setMem(ctx, 'wLearnMoveMonName', pm.nickname);
  setMem(ctx, 'wStringBuffer', e.bundle.moves[move - 1].name);
  for (;;) {
    // DontAbandonLearning
    let slot = pm.moves.indexOf(0);
    if (slot < 0) {
      const forget = yield* tryingToLearn(e, pm, ctx, saved);
      if (forget === undefined) {
        // AbandonLearning
        yield* print(e, ctx, '_AbandonLearningText');
        const choice = yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7);
        if (choice !== 0) continue;
        yield* print(e, ctx, '_DidNotLearnText');
        return false;
      }
      slot = forget;
      setMem(ctx, 'wNameBuffer', e.bundle.moves[pm.moves[slot] - 1].name);
      yield* print(e, ctx, '_OneTwoAndText', '<pause>', SWAP_SFX_OP, '_PoofText', '<pause>', '_ForgotAndText');
    }
    pm.moves[slot] = move;
    pm.pp[slot] = movePP(e.bundle, move);
    const b = ctx.battle;
    if (b && which === b.playerMonNumber) {
      b.player.mon.moves = [...pm.moves];
      b.player.mon.pp = [...pm.pp];
    }
    // PrintLearnedMove (sound_get_item_1 plays SFX_LEVEL_UP in battle)
    e.hooks.playSound?.(b ? 'SFX_LEVEL_UP' : 'SFX_GET_ITEM_1');
    yield* print(e, ctx, '_LearnedMove1Text', '<promptbutton>');
    return true;
  }
}

/** TryingToLearn: returns the slot to forget, or undefined if the player declined. */
function* tryingToLearn(e: Engine, pm: PartyMon, ctx: LearnContext, saved: Int16Array): Co<number | undefined> {
  yield* print(e, ctx, '_TryingToLearnText');
  const choice = yield* twoOptionMenu(e, 'YES_NO_MENU', 14, 7);
  if (choice !== 0) return undefined;
  for (;;) {
    yield* print(e, ctx, '_WhichMoveToForgetText');
    e.screen.box(4, 7, 4, 14);
    for (let i = 0; i < 4; i++) {
      const m = pm.moves[i];
      encodePlain(m ? e.bundle.moves[m - 1].name : '-').forEach((code, j) => e.screen.put(6 + j, 8 + i, code));
    }
    const numMoves = pm.moves.filter((m) => m).length;
    const [item, key] = yield* handleMenuInput(e, {
      topX: 5,
      topY: 8,
      maxItem: numMoves - 1,
      current: 0,
      spacing: 1,
      watchedKeys: PAD_A | PAD_B,
    });
    e.screen.cells.set(saved);
    e.screen.markDirty();
    if (key & PAD_B) return undefined;
    const m = pm.moves[item];
    if (isHM(e, m)) {
      yield* print(e, ctx, '_HMCantDeleteText');
      continue;
    }
    return item;
  }
}

/** IsMoveHM */
export function isHM(e: Engine, move: number): boolean {
  return ['CUT', 'FLY', 'SURF', 'STRENGTH', 'FLASH'].some((n) => c('move', n) === move);
}

// ------------------------------------------------------------------ evolution
/**
 * EvolutionAfterBattle: evolve every party mon whose wCanEvolveFlags bit is
 * set. `item` is wCurItem for stone evolutions (0 otherwise). Returns true if
 * a mon evolved.
 */
export function* evolutionAfterBattle(
  e: Engine,
  canEvolveFlags: number,
  force: boolean,
  item = 0,
  party?: PartyMon[],
  /** wLinkState == LINK_STATE_TRADING: trade evolutions apply (in-game trades) */
  trading = false,
): Co<boolean> {
  const p = party ?? structuredClone(e.state.party);
  const ctx: LearnContext = { mem: new Map() };
  let occurred = false;
  const inBattle = false; // EndOfBattle runs this after wIsInBattle has been read as 0 for item evolutions only
  for (let i = 0; i < p.length; i++) {
    if (!((canEvolveFlags >> i) & 1)) continue;
    const pm = p[i];
    const sp = species(e.bundle, pm.species);
    for (const evo of sp.evolutions) {
      if (evo.method === 'trade') {
        // only while trading
        if (!trading || pm.level < (evo.minLevel ?? 1)) continue;
      } else if (evo.method === 'item') {
        if (inBattle || item !== evo.item) continue;
        if (pm.level < evo.minLevel) continue;
      } else {
        if (force) break; // wForceEvolution skips level evolutions
        if (pm.level < evo.level) continue;
      }
      // .doEvolution
      occurred = true;
      const oldName = sp.name;
      ctx.mem.set(ramSym('wStringBuffer'), pm.nickname);
      yield* print(e, ctx, '_IsEvolvingText');
      yield* e.delayFrames(50);
      const cancelled = yield* evolveMon(e, pm.species, evo.species, force);
      if (cancelled) {
        yield* print(e, ctx, '_StoppedEvolvingText');
        e.screen.clear();
        break;
      }
      const ns = species(e.bundle, evo.species);
      yield* print(e, ctx, '_EvolvedText');
      ctx.mem.set(ramSym('wNameBuffer'), ns.name);
      yield* e.textCommandProcessor(ops(e, ['_IntoText']), 1, 14, {
        ram: (label, addr) => (addr !== undefined && ctx.mem.has(addr) ? ctx.mem.get(addr) : e.ramValue(label, addr)),
      });
      yield* e.env.playSoundWaitForCurrent('SFX_GET_ITEM_2');
      yield* e.waitForSoundToFinish();
      yield* e.delayFrames(40);
      e.screen.clear();
      // RenameEvolvedMon: only if the nickname is the old species name
      if (pm.nickname === oldName) pm.nickname = ns.name;
      const oldMax = pm.maxHp;
      pm.species = evo.species;
      Object.assign(pm, calcStats(ns, pm.dvs, pm.statExp, pm.level, true));
      pm.hp = (pm.hp + pm.maxHp - oldMax) & 0xffff;
      yield* learnMoveFromLevelUp(e, p, i, pm.level, ctx);
      pm.types = [...ns.types] as [number, number];
      e.store.dispatch({ type: 'setPokedex', dex: ns.dex, seen: true, owned: true }, { undoable: false });
      break;
    }
  }
  e.store.dispatch({ type: 'setParty', party: p }, { undoable: false });
  if (occurred) e.playDefaultMusic?.();
  return occurred;
}

/** EvolveMon: the back-and-forth pic animation; B cancels unless forced. Returns true if cancelled. */
function* evolveMon(e: Engine, oldSpecies: number, newSpecies: number, force: boolean): Co<boolean> {
  e.stopAllMusic();
  e.hooks.playSound?.('SFX_TINK');
  yield* e.delayFrames(3);
  const s = e.screen;
  s.fill(0, 0, 20, 12, 0x7f);
  const place = (sp: number, base: number) => {
    const pic = e.bundle.pics.front[sp];
    if (!pic) return;
    // LoadFlippedFrontSpriteByMonIndex at (7,2)
    const W = pic.width * 8;
    const src = picPixels(pic);
    const ox = (7 - pic.width) >> 1;
    const oy = 7 - pic.width;
    for (let ty = 0; ty < 7; ty++)
      for (let tx = 0; tx < 7; tx++) {
        const tile = new Array<number>(64).fill(0);
        for (let yy = 0; yy < 8; yy++)
          for (let xx = 0; xx < 8; xx++) {
            const px = tx * 8 + xx - ox * 8;
            const py = ty * 8 + yy - oy * 8;
            if (px >= 0 && py >= 0 && px < W && py < W) tile[yy * 8 + xx] = src[py * W + (W - 1 - px)];
          }
        s.setGlyphOverride(base + ty * 7 + tx, tile);
        s.put(7 + tx, 2 + ty, base + ty * 7 + tx);
      }
  };
  place(oldSpecies, 0x100);
  e.hooks.playCry?.(oldSpecies);
  yield* e.waitForSoundToFinish();
  e.playMusic('MUSIC_SAFARI_ZONE');
  yield* e.delayFrames(80);
  const js = new LowSensitivity(e);
  let cancelled = false;
  let bCount = 1;
  for (let cCount = 0x10; cCount > 0; cCount -= 2) {
    // Evolution_CheckForCancel
    for (let i = 0; i < cCount; i++) {
      yield;
      if (js.read(e) & PAD_B && !force) {
        cancelled = true;
        break;
      }
    }
    if (cancelled) break;
    for (let k = 0; k < bCount; k++) {
      place(newSpecies, 0x100);
      yield* e.delayFrames(3);
      place(oldSpecies, 0x100);
      yield* e.delayFrames(3);
    }
    bCount++;
  }
  const shown = cancelled ? oldSpecies : newSpecies;
  place(shown, 0x100);
  e.stopAllMusic();
  e.hooks.playCry?.(shown);
  return cancelled;
}
