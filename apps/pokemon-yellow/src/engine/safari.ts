/**
 * The Safari Game (engine/events/hidden_events/safari_game.asm): the overworld
 * checks for running out of Safari Balls or steps, and the PA announcement that
 * sends the player back to the gate.
 */
import type { Co, Engine } from './Engine';
import { c } from '../rom/constants';

const inSafariZone = (e: Engine) => e.env.checkEvent('EVENT_IN_SAFARI_ZONE');

/** SafariZoneCheck (every overworld loop iteration): true when the game is over. */
export function* safariZoneCheck(e: Engine): Co<boolean> {
  if (!inSafariZone(e) || (e.state.vars.wNumSafariBalls ?? 0)) return false;
  yield* safariZoneGameOver(e);
  return true;
}

/** SafariZoneCheckSteps (after each step in the Safari Zone): true when the game is over. */
export function* safariZoneCheckSteps(e: Engine): Co<boolean> {
  const steps = e.state.vars.wSafariSteps ?? 0;
  if (!steps) {
    yield* safariZoneGameOver(e);
    return true;
  }
  e.env.setVar('wSafariSteps', steps - 1);
  return false;
}

/** SafariZoneGameOver: the PA, then a warp to the gate's warp 3 (the caller runs WarpFound2). */
function* safariZoneGameOver(e: Engine): Co {
  const env = e.env;
  env.enableAutoTextBoxDrawing();
  e.stopAllMusic();
  env.playSound('safari_zone_pa'); // only waits for the PA to start
  yield* e.displayTextID(0, { kind: 'text', label: 'SafariGameOverText' });
  e.ram.playerMovingDirection = 0;
  e.ram.warpDestinationMap = c('map', 'SAFARI_ZONE_GATE');
  e.ram.destinationWarpId = 3;
  env.setMapScript('SAFARI_ZONE_GATE', 'SCRIPT_SAFARIZONEGATE_LEAVING_SAFARI');
  env.setEvent('EVENT_SAFARI_GAME_OVER');
}

/** SafariGameOverText (PrintSafariGameOverText resets wJoyIgnore first) */
export function* safariGameOverText(env: Engine['env']): Co {
  env.joyIgnore = 0;
  if (env.vars.wNumSafariBalls ?? 0) yield* env.printText('TimesUpText');
  yield* env.printText('GameOverText');
}
