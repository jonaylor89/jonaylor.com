/**
 * BattleTransition (engine/battle/battle_transitions.asm). The transition
 * is chosen exactly like the original (trainer/wild, enemy at least 3 levels
 * above the first healthy party mon, dungeon map); the black tiles are drawn
 * on the tile layer over the 3D world, and the BG palette flashes go to the
 * renderer through the fade hook.
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { EMPTY, SCREEN_H, SCREEN_W } from '../ui/TileScreen';

const BLACK = 0x3ff;

export function* battleTransition(b: Battle): Co {
  const e = b.e;
  const s = e.screen;
  s.setGlyphOverride(BLACK, new Array<number>(64).fill(3));
  yield* b.delay(3);
  yield;
  yield* b.delay(3);
  const t = b.bundle.battle.transitions;
  let id = 0;
  if (b.req.kind === 'trainer') id |= 1;
  const lead = b.party.find((m) => m.hp);
  const enemyLevel = b.req.kind === 'trainer' ? b.curEnemyLevel : (b.req.level ?? 0);
  // wBattleTransitionSpiralDirection: 1 (inward) unless the enemy is stronger
  let inward = true;
  if (lead && enemyLevel - ((lead.level + 3) & 0xff) >= 0) {
    id |= 2;
    inward = false;
  }
  const map = e.world.data.id;
  if (t.dungeon1.includes(map) || t.dungeon2.some(([lo, hi]) => map >= lo && map <= hi)) id |= 4;
  const T = [doubleCircle, spiral, circle, spiral, horizontalStripes, shrink, verticalStripes, split][id];
  yield* T(b, inward);
  // BattleTransition_BlackScreen
  e.hooks.fade?.(1, 'black');
  s.fill(0, 0, SCREEN_W, SCREEN_H, BLACK);
}

function put(b: Battle, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return;
  b.e.screen.put(x, y, BLACK);
}

function get(b: Battle, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return BLACK;
  return b.e.screen.get(x, y);
}

/** BattleTransition_FlashScreen: three passes over the flash palettes, 2 frames each. */
function* flashScreen(b: Battle): Co {
  const pals = b.bundle.battle.transitions.flash;
  for (let pass = 0; pass < 3; pass++)
    for (const bgp of pals) {
      const sum = (bgp & 3) + ((bgp >> 2) & 3) + ((bgp >> 4) & 3) + ((bgp >> 6) & 3);
      if (sum >= 6) b.e.hooks.fade?.((sum - 6) / 6, 'black');
      else b.e.hooks.fade?.((6 - sum) / 6, 'white');
      yield* b.delay(2);
    }
  b.e.hooks.fade?.(0);
}

/** BattleTransition_Spiral: inward (weaker enemy) or outward from (10,10), 3 tiles per frame for 120 frames. */
function* spiral(b: Battle, inward: boolean): Co {
  if (inward) {
    let counter = 7;
    let x = 0;
    let y = 0;
    const run = function* (n: number, dx: number, dy: number) {
      for (let i = 0; i < n; i++) {
        put(b, x, y);
        x += dx;
        y += dy;
        if (--counter === 0) {
          yield* b.delay(3);
          counter = 7;
        }
      }
    };
    let c = SCREEN_H - 1;
    yield* run(c, 0, 1);
    c++;
    let first = true;
    for (;;) {
      if (!first) yield* run(c, 0, 1);
      first = false;
      c++;
      yield* run(c, 1, 0);
      c -= 2;
      yield* run(c, 0, -1);
      c++;
      yield* run(c, -1, 0);
      c -= 2;
      if (c <= 0) break;
    }
    return;
  }
  // outward: BattleTransition_OutwardSpiral_ from (10,10), turning whenever the turn-side tile isn't black yet
  let x = 10;
  let y = 10;
  let dir = 3;
  const turnSide = [
    [-1, 0],
    [0, 1],
    [1, 0],
    [0, -1],
  ];
  const ahead = [
    [0, -1],
    [-1, 0],
    [0, 1],
    [1, 0],
  ];
  for (let f = 0; f < 120; f++) {
    for (let k = 0; k < 3; k++) {
      const [tx, ty] = turnSide[dir];
      if (get(b, x + tx, y + ty) !== BLACK) {
        x += tx;
        y += ty;
        put(b, x, y);
        dir = (dir + 1) & 3;
      } else {
        const [ax, ay] = ahead[dir];
        x += ax;
        y += ay;
        put(b, x, y);
      }
    }
    yield;
  }
}

/** Shrink: the picture collapses toward the center from all four sides. */
function* shrink(b: Battle): Co {
  for (let i = 0; i < SCREEN_H / 2; i++) {
    shiftRows(b, 7, 8, -1);
    shiftRows(b, 10, 9, 1);
    shiftCols(b, 8, 9, -1);
    shiftCols(b, 11, 10, 1);
    yield* b.delay(6);
  }
  yield* b.delay(10);
}

/** Split: the picture splits outward toward the edges. */
function* split(b: Battle): Co {
  for (let i = 0; i < SCREEN_H / 2; i++) {
    shiftRows(b, 16, 17, -1);
    shiftRows(b, 1, 0, 1);
    shiftCols(b, 18, 19, -1);
    shiftCols(b, 1, 0, 1);
    yield* b.delay(6);
  }
  yield* b.delay(10);
}

/** BattleTransition_CopyTiles1: copy 8 rows stepping by `step` rows, then blacken the source row. */
function shiftRows(b: Battle, srcY: number, dstY: number, step: number): void {
  const s = b.e.screen;
  let src = srcY;
  let dst = dstY;
  for (let i = 0; i < 8; i++) {
    for (let x = 0; x < SCREEN_W; x++) if (src >= 0 && src < SCREEN_H && dst >= 0 && dst < SCREEN_H) s.put(x, dst, s.get(x, src));
    dst = src;
    src += step * 2;
  }
  for (let x = 0; x < SCREEN_W; x++) put(b, x, dst);
}

/** BattleTransition_CopyTiles2 */
function shiftCols(b: Battle, srcX: number, dstX: number, step: number): void {
  const s = b.e.screen;
  let src = srcX;
  let dst = dstX;
  for (let i = 0; i < SCREEN_H / 2; i++) {
    for (let y = 0; y < SCREEN_H; y++) if (src >= 0 && src < SCREEN_W && dst >= 0 && dst < SCREEN_W) s.put(dst, y, s.get(src, y));
    dst = src;
    src += step * 2;
  }
  for (let y = 0; y < SCREEN_H; y++) put(b, dst, y);
}

function* verticalStripes(b: Battle): Co {
  let topY = 0;
  let botY = 17;
  for (let i = 0; i < SCREEN_H; i++) {
    for (let x = 0; x < SCREEN_W; x += 2) put(b, x, topY);
    for (let x = 1; x < SCREEN_W; x += 2) put(b, x, botY);
    yield* b.delay(3);
    topY++;
    botY--;
  }
}

function* horizontalStripes(b: Battle): Co {
  let leftX = 0;
  let rightX = 19;
  for (let i = 0; i < SCREEN_W; i++) {
    for (let y = 0; y < SCREEN_H; y += 2) put(b, leftX, y);
    for (let y = 1; y < SCREEN_H; y += 2) put(b, rightX, y);
    yield* b.delay(3);
    leftX++;
    rightX--;
  }
}

/** BattleTransition_Circle_Sub3: blacken one slice; rows go down for the top half, up for the bottom half. */
function circleSlice(b: Battle, entry: { right: boolean; data: number; x: number; y: number }, bottom: boolean): void {
  const data = b.bundle.battle.transitions.circleData[entry.data];
  let x = entry.x;
  let y = entry.y;
  let i = 0;
  for (;;) {
    const n = data[i++];
    for (let k = 0; k < n; k++) put(b, x + (entry.right ? k : -k), y);
    y += bottom ? -1 : 1;
    if (i >= data.length) return;
    const shift = data[i++];
    x += entry.right ? -shift : shift;
  }
}

function* circle(b: Battle): Co {
  yield* flashScreen(b);
  const t = b.bundle.battle.transitions;
  for (const en of t.halfCircle1) {
    circleSlice(b, en, false);
    yield* b.delay(3);
  }
  for (const en of t.halfCircle2) {
    circleSlice(b, en, true);
    yield* b.delay(3);
  }
}

function* doubleCircle(b: Battle): Co {
  yield* flashScreen(b);
  const t = b.bundle.battle.transitions;
  for (let i = 0; i < 10; i++) {
    circleSlice(b, t.halfCircle1[i], false);
    circleSlice(b, t.halfCircle2[i], true);
    yield* b.delay(3);
  }
}

export { EMPTY };
