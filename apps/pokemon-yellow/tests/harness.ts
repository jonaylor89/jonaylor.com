/**
 * Headless driver for the real engine: feeds input frame by frame, with
 * helpers to walk to coordinates (BFS over passable squares) and advance text.
 */
import { Engine } from '../src/engine/Engine';
import type { BattleHost } from '../src/engine/battle';
import { GbBattleHost } from '../src/battle/host';
import { SCRIPTS } from '../src/scripts';
import { newGameState, Store, type GameState } from '../src/game/state';
import type { Button, InputFrame } from '../src/input/Input';
import type { GameBundle } from '../src/data/schema';
import { decodeCodes } from '../src/ui/menus';
import { DIR_VEC, type Facing } from '../src/world/movement';

export class Harness {
  engine: Engine;
  store: Store;
  frames = 0;
  private prev = new Set<Button>();
  log: string[] = [];

  constructor(
    readonly bundle: GameBundle,
    state?: GameState,
    battle: BattleHost = new GbBattleHost(),
  ) {
    this.store = new Store(state ?? newGameState(bundle, 0xc0ffee));
    this.engine = new Engine(bundle, this.store, null, SCRIPTS, battle, {
      unported: (w) => this.log.push(`unported: ${w}`),
    });
  }

  step(held: Button[] = []): void {
    const h = new Set(held);
    const pressed = new Set([...h].filter((b) => !this.prev.has(b)));
    this.prev = h;
    const f: InputFrame = { held: h, pressed };
    this.engine.frame(f);
    this.frames++;
  }

  run(n: number, held: Button[] = []): void {
    for (let i = 0; i < n; i++) this.step(held);
  }

  press(b: Button, holdFrames = 2, after = 4): void {
    this.run(holdFrames, [b]);
    this.run(after);
  }

  get p() {
    return this.store.state.player;
  }

  get mapName(): string {
    return this.bundle.maps[this.p.map].constName;
  }

  screenText(): string {
    return this.engine.screen
      .textRows((code) => decodeCodes([code]) || (code === 0x7f ? ' ' : '·'))
      .join('\n');
  }

  textBoxOpen(): boolean {
    return this.engine.screen.get(0, 12) === 0x79;
  }

  /** Press A until the text box closes (or a predicate holds). */
  advanceText(maxPresses = 60, until?: () => boolean): string {
    let seen = '';
    for (let i = 0; i < maxPresses; i++) {
      if (until?.()) break;
      this.run(10);
      seen += this.screenText().split('\n').slice(13, 17).join(' ') + '\n';
      if (!this.textBoxOpen() && i > 0) {
        this.run(20);
        if (!this.textBoxOpen()) break;
      }
      this.press('a', 2, 6);
    }
    return seen;
  }

  waitUntil(pred: () => boolean, max = 3000, held: Button[] = []): boolean {
    for (let i = 0; i < max; i++) {
      if (pred()) return true;
      this.step(held);
    }
    return pred();
  }

  get inBattle(): boolean {
    return this.engine.ram.isInBattle !== 0;
  }

  /** Fight through a battle by pressing A (FIGHT, the first move, every prompt). Returns frames used. */
  finishBattle(max = 20000): number {
    const start = this.frames;
    while (this.inBattle && this.frames - start < max) {
      // put the move cursor on the strongest move that still has PP
      const b = (this.engine.battleHost as GbBattleHost).current;
      if (b) {
        const m = b.player.mon;
        let best = 0;
        let bestPower = -1;
        m.moves.forEach((mv, i) => {
          const power = mv ? this.bundle.moves[mv - 1].power : -1;
          if (mv && m.pp[i] & 0x3f && power > bestPower) [best, bestPower] = [i, power];
        });
        b.player.moveListIndex = best;
      }
      this.press('a', 2, 8);
    }
    this.run(30);
    return this.frames - start;
  }

  /** Walk one square in a direction (hold until the position changes or a map change). */
  walk(dir: Facing, max = 60): boolean {
    const start = { ...this.p };
    for (let i = 0; i < max; i++) {
      this.step([dir]);
      if (this.inBattle) {
        this.finishBattle();
        return this.p.map !== start.map || this.p.x !== start.x || this.p.y !== start.y;
      }
      if (this.p.map !== start.map || this.p.x !== start.x || this.p.y !== start.y) {
        this.run(1);
        return true;
      }
    }
    this.run(2);
    return false;
  }

  /** BFS path over passable squares on the current map, then walk it. */
  walkTo(tx: number, ty: number, opts: { maxSteps?: number } = {}): boolean {
    for (let guard = 0; guard < (opts.maxSteps ?? 200); guard++) {
      if (this.p.x === tx && this.p.y === ty) return true;
      const path = this.findPath(tx, ty);
      if (!path || !path.length) return false;
      const mapBefore = this.p.map;
      this.walk(path[0]);
      if (this.p.map !== mapBefore) return this.p.x === tx && this.p.y === ty;
    }
    return false;
  }

  findPath(tx: number, ty: number): Facing[] | undefined {
    const w = this.engine.world;
    const occupied = (x: number, y: number) =>
      this.engine.sprites.some((s) => s && s.slot !== 0 && s.slot !== this.engine.pikachuSlot && !s.hidden && s.pictureId && s.mapX === x && s.mapY === y);
    const key = (x: number, y: number) => `${x},${y}`;
    const start = [this.p.x, this.p.y];
    const prev = new Map<string, [string, Facing]>();
    const q: [number, number][] = [[start[0], start[1]]];
    const seen = new Set([key(start[0], start[1])]);
    while (q.length) {
      const [x, y] = q.shift()!;
      if (x === tx && y === ty) {
        const out: Facing[] = [];
        let k = key(x, y);
        while (prev.has(k)) {
          const [pk, d] = prev.get(k)!;
          out.unshift(d);
          k = pk;
        }
        return out;
      }
      for (const d of ['up', 'down', 'left', 'right'] as Facing[]) {
        const [dx, dy] = DIR_VEC[d];
        const nx = x + dx;
        const ny = y + dy;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        const target = nx === tx && ny === ty;
        if (!w.inBounds(nx, ny) && !target) continue;
        if (!target && (!w.isSquarePassable(nx, ny) || occupied(nx, ny))) continue;
        if (target && !w.isSquarePassable(nx, ny) && w.inBounds(nx, ny)) continue;
        seen.add(k);
        prev.set(k, [key(x, y), d]);
        q.push([nx, ny]);
      }
    }
    return undefined;
  }
}

/** Walk off a map edge into the connected map (repeatedly stepping toward it). */
export function crossEdge(h: Harness, dir: 'up' | 'down' | 'left' | 'right', max = 20): boolean {
  const start = h.p.map;
  for (let i = 0; i < max && h.p.map === start; i++) h.walk(dir);
  h.run(4);
  return h.p.map !== start;
}

/** Press A through any open text (and B on YES/NO menus when `declineMenus`). */
export function clearText(h: Harness, max = 80, declineMenus = true): void {
  for (let i = 0; i < max; i++) {
    h.run(6);
    const t = h.screenText();
    const menu = t.includes('YES') && t.includes('NO');
    if (!h.textBoxOpen() && !menu) {
      h.run(30);
      if (!h.textBoxOpen()) return;
    }
    h.press(menu && declineMenus ? 'b' : 'a', 2, 6);
  }
}

/** Keep pressing A (B on YES/NO menus if `decline`) until `pred` holds. */
export function pressUntil(h: Harness, pred: () => boolean, max = 300, decline = true): boolean {
  for (let i = 0; i < max && !pred(); i++) {
    if (h.inBattle) h.finishBattle();
    h.run(6);
    const t = h.screenText();
    const menu = t.includes('YES') && t.includes('NO');
    h.press(menu && decline ? 'b' : 'a', 2, 6);
  }
  return pred();
}

/** Walk to a reachable edge square that leads into the connected map, then cross. */
export function exitVia(h: Harness, dir: 'up' | 'down' | 'left' | 'right'): boolean {
  const w = h.engine.world;
  const W = w.widthSquares;
  const H = w.heightSquares;
  const cands: [number, number, number, number][] = [];
  if (dir === 'up' || dir === 'down') {
    const y = dir === 'up' ? 0 : H - 1;
    const ny = dir === 'up' ? -1 : H;
    for (let x = 0; x < W; x++) cands.push([x, y, x, ny]);
  } else {
    const x = dir === 'left' ? 0 : W - 1;
    const nx = dir === 'left' ? -1 : W;
    for (let y = 0; y < H; y++) cands.push([x, y, nx, y]);
  }
  const ok = cands.filter(
    ([x, y, nx, ny]) => w.isSquarePassable(x, y) && w.isSquarePassable(nx, ny) && w.connectionFor(Math.floor(nx / 2), Math.floor(ny / 2)),
  );
  const best = ok
    .map(([x, y]) => ({ x, y, path: h.findPath(x, y) }))
    .filter((c) => c.path)
    .sort((a, b) => a.path!.length - b.path!.length)[0];
  if (!best) return false;
  if (!h.walkTo(best.x, best.y)) return false;
  return crossEdge(h, dir);
}
