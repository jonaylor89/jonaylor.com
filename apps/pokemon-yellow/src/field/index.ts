/** Overworld field systems (Surf, fishing, Cut, Strength, Fly, ...), registered on the engine's hooks. */
import type { Engine } from '../engine/Engine';
import { registerSurf } from './surf';
import { registerFishing } from './fishing';
import { registerCut } from './cut';
import { registerFly } from './fly';
import { startSlotMachine } from '../ui/slots';

export function registerFieldSystems(e: Engine): void {
  registerSurf(e);
  registerFishing(e);
  registerCut(e);
  registerFly(e);
  e.hiddenEventHandlers.StartSlotMachine = startSlotMachine;
}
