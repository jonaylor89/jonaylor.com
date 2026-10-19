/** The battle engine behind the overworld's BattleHost interface. */
import type { Co } from '../engine/Engine';
import type { ScriptEnv } from '../engine/ScriptEnv';
import type { BattleHost, BattleRequest, BattleResult } from '../engine/battle';
import { Battle } from './Battle';

export class GbBattleHost implements BattleHost {
  /** The battle in progress (debug overlay and tests). */
  current?: Battle;

  *run(env: ScriptEnv, req: BattleRequest): Co<BattleResult> {
    const e = env.e;
    e.hooks.battleState?.(true);
    e.ram.isInBattle = req.kind === 'trainer' ? 2 : 1;
    try {
      const b = new Battle(e, req);
      this.current = b;
      return yield* b.run();
    } finally {
      this.current = undefined;
      e.ram.isInBattle = 0;
      e.hooks.battleScene?.(false);
      e.hooks.palette?.(undefined);
      e.hooks.battleState?.(false);
    }
  }
}
