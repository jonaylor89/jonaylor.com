/**
 * Cut: UsedCut, ReplaceTreeTileBlock (engine/overworld/cut.asm) and AnimCut
 * (engine/overworld/cut2.asm). The tree or grass in front of the player is cut
 * and its block replaced by CutTreeBlockSwaps (until the map is loaded again).
 */
import type { Co, Engine } from '../engine/Engine';
import type { PartyMon } from '../game/state';
import { c } from '../rom/constants';
import { tileInFrontOfPlayer } from './surf';

/** Cuttable tiles: the overworld tree ($3d) and tall grass ($52); the gym tree ($50). */
const OVERWORLD_TREE = 0x3d;
const OVERWORLD_GRASS = 0x52;
const GYM_TREE = 0x50;

/** UsedCut: true when something was cut (wActionResultOrTookBattleTurn). */
export function* usedCut(e: Engine, mon: PartyMon): Co<boolean> {
  const ts = e.world.data.tileset;
  const tile = tileInFrontOfPlayer(e);
  const ok =
    ts === c('tileset', 'OVERWORLD') ? tile === OVERWORLD_TREE || tile === OVERWORLD_GRASS : ts === c('tileset', 'GYM') && tile === GYM_TREE;
  if (!ok) {
    yield* e.printText('_NothingToCutText');
    return false;
  }
  e.ram.nameBuffer = mon.nickname;
  e.ram.noTextDelay = true;
  e.screen.clear();
  yield* e.delayFrames(3);
  yield* e.printText('_UsedCutText');
  e.ram.noTextDelay = false;
  e.closeTextDisplay();
  replaceTreeTileBlock(e);
  // AnimCut: the tree halves slide apart for 8 frames, or the leaves scatter for 2 x 16 frames
  const [fx, fy] = e.frontOfPlayer();
  const grass = tile === OVERWORLD_GRASS;
  const frames = grass ? 32 : 8;
  for (let t = 0; t < frames; t++) {
    e.ram.fieldEffect = { kind: grass ? 'cutGrass' : 'cutTree', x: fx, y: fy, t, frames };
    yield;
  }
  e.ram.fieldEffect = undefined;
  e.env.playSound('cut');
  e.updateSprites();
  return true;
}

/** ReplaceTreeTileBlock: the block holding the square in front, via CutTreeBlockSwaps. */
export function replaceTreeTileBlock(e: Engine): void {
  const [fx, fy] = e.frontOfPlayer();
  const bx = fx >> 1;
  const by = fy >> 1;
  const block = e.world.blockAt(bx, by);
  const swap = e.bundle.tileTables.cutTreeBlocks.find((s) => s.from === block);
  if (swap) e.world.replaceBlock(bx, by, swap.to);
}

export function registerCut(e: Engine): void {
  e.fieldMoves.CUT = function* (e, party, which) {
    return (yield* usedCut(e, party[which])) ? 'close' : 'back';
  };
}
