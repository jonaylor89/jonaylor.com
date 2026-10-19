/**
 * Battle interface between the overworld and the battle engine.
 *
 * The full Gen 1 battle engine is the next milestone (TASKS.md §5). Until it
 * lands, `PendingBattleHost` stands in: it announces the battle in a text box
 * and resolves it as a player win so story scripts can be exercised end to
 * end. It is clearly labelled in-game and is not a substitute for battles.
 */
import type { Co } from './Engine';
import type { ScriptEnv } from './ScriptEnv';
import { encodePlain } from '../ui/TextPrinter';

export interface BattleRequest {
  kind: 'wild' | 'trainer';
  species?: number;
  level?: number;
  trainerClass?: number;
  trainerNo?: number;
  battleType: number;
  /** wMoveMissed set by the rod: "The hooked POKéMON attacked!" */
  fishing?: boolean;
  /** wGymLeaderNo (= wLoneAttackNo): gym leader music, PIKAHAPPY_GYMLEADER */
  gymLeaderNo?: number;
}

export type BattleResult = 'win' | 'lose' | 'draw' | 'caught' | 'ran';

export interface BattleHost {
  run(env: ScriptEnv, req: BattleRequest): Co<BattleResult>;
}

export class PendingBattleHost implements BattleHost {
  constructor(private readonly result: BattleResult = 'win') {}

  *run(env: ScriptEnv, req: BattleRequest): Co<BattleResult> {
    const e = env.e;
    const b = e.bundle;
    const who =
      req.kind === 'trainer'
        ? `${b.trainers[(req.trainerClass ?? 1) - 1]?.name ?? "?"} ${req.trainerNo}`
        : `${b.species[req.species ?? 0]?.name ?? '?'} L${req.level}`;
    e.screen.box(0, 12, 4, 18);
    const lines = ['BATTLE ENGINE', 'PENDING:', who.slice(0, 18)];
    lines.forEach((l, i) => encodePlain(l).forEach((code, j) => e.screen.put(1 + j, 13 + i, code)));
    yield* e.waitForTextScrollButtonPress();
    // PrintEndBattleText (trainer's closing line) on a win
    if (req.kind === 'trainer' && this.result === 'win' && e.ram.endBattleWinText) {
      yield* e.printText(e.ram.endBattleWinText);
      yield* e.waitForTextScrollButtonPress();
    }
    e.closeTextDisplay();
    return this.result;
  }
}
