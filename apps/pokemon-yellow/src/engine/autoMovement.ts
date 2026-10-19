/**
 * NPC movement script tables (engine/overworld/auto_movement.asm):
 * the NPC walks in lockstep with simulated player input.
 */
import type { Engine } from './Engine';
import { NPC_CHANGE_FACING, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP } from './sprites';
import { PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP, PAD_SELECT, PAD_START, PAD_CTRL_PAD } from './pad';

type Fn = (e: Engine) => void;

const rle = (pairs: number[]) => {
  const out: number[] = [];
  for (let i = 0; i < pairs.length; i += 2) for (let k = 0; k < pairs[i + 1]; k++) out.push(pairs[i]);
  return out;
};

const NPC_TO_PAD: Record<number, number> = {
  [NPC_MOVEMENT_UP]: PAD_UP,
  [NPC_MOVEMENT_DOWN]: PAD_DOWN,
  [NPC_MOVEMENT_LEFT]: PAD_LEFT,
  [NPC_MOVEMENT_RIGHT]: PAD_RIGHT,
};

// --- PalletMovementScriptPointerTable
const RLE_ProfOakWalkToLab = [NPC_MOVEMENT_DOWN, 6, NPC_MOVEMENT_LEFT, 1, NPC_MOVEMENT_DOWN, 5, NPC_MOVEMENT_RIGHT, 3, NPC_MOVEMENT_UP, 1, NPC_CHANGE_FACING, 1];
const RLE_PlayerWalkToLab = [PAD_UP, 2, PAD_RIGHT, 3, PAD_DOWN, 5, PAD_LEFT, 1, PAD_DOWN, 7];

const pallet: Fn[] = [
  // PalletMovementScript_OakMoveLeft
  (e) => {
    const n = (e.state.player.x - 10) & 0xff;
    e.ram.numStepsToTake = n;
    if (n) {
      // Oak is below the player on the right tile: step him left.
      const dirs = new Array(n).fill(NPC_MOVEMENT_LEFT);
      e.moveSprite(e.ram.npcMovementScriptSprite, dirs);
      e.ram.npcMovementScriptFunction = 1;
    } else {
      e.ram.npcMovementScriptFunction = 3;
    }
    e.playMusic('MUSIC_MUSEUM_GUY');
    e.ram.noMapMusic = true;
    e.ram.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
  },
  // PalletMovementScript_PlayerMoveLeft
  (e) => {
    if (e.scripted.active) return;
    const n = e.ram.numStepsToTake;
    // ConvertNPCMovementDirectionsToJoypadMasks over the n LEFT moves
    e.ram.simulatedJoypad = new Array(n).fill(NPC_TO_PAD[NPC_MOVEMENT_LEFT]);
    e.ram.simulatedIndex = n;
    e.startSimulatingJoypadStates();
    e.ram.npcMovementScriptFunction = 2;
  },
  // PalletMovementScript_WaitAndWalkToLab (falls through to WalkToLab)
  (e) => {
    if (e.ram.simulatedIndex) return;
    walkToLab(e);
  },
  // PalletMovementScript_WalkToLab
  (e) => walkToLab(e),
  // PalletMovementScript_Done
  (e) => {
    if (e.ram.simulatedIndex) return;
    e.setObjectVisible('TOGGLE_PALLET_TOWN_OAK', false);
    e.ram.scriptedMovementState = false;
    e.ram.synced.initialized = false;
    e.endNpcMovementScript();
  },
];

function walkToLab(e: Engine): void {
  e.ram.overrideSimulatedMask = 0;
  e.sprites[0].movementByte1 = 0;
  const player = rle(RLE_PlayerWalkToLab);
  e.ram.simulatedJoypad = player;
  e.ram.simulatedIndex = player.length; // DecodeRLEList count (incl. $ff) then dec a
  e.ram.synced = { directions: [...rle(RLE_ProfOakWalkToLab), 0xff], index: 0, walkCounter: 8, initialized: false };
  e.ram.scriptedMovementState = true;
  e.ram.npcMovementScriptFunction = 4;
}

// --- PewterMuseumGuyMovementScriptPointerTable / PewterGymGuyMovementScriptPointerTable
const RLE_PewterMuseumPlayer = [0, 1, PAD_UP, 3, PAD_LEFT, 13, PAD_UP, 6];
const RLE_PewterMuseumGuy = [NPC_MOVEMENT_UP, 6, NPC_MOVEMENT_LEFT, 13, NPC_MOVEMENT_UP, 3, NPC_MOVEMENT_LEFT, 1];
const RLE_PewterGymPlayer = [0, 1, PAD_RIGHT, 2, PAD_DOWN, 5, PAD_LEFT, 11, PAD_UP, 5, PAD_LEFT, 15];
const RLE_PewterGymGuy = [NPC_MOVEMENT_DOWN, 2, NPC_MOVEMENT_LEFT, 15, NPC_MOVEMENT_UP, 5, NPC_MOVEMENT_LEFT, 11, NPC_MOVEMENT_DOWN, 5, NPC_MOVEMENT_RIGHT, 3];

const pewterDone: Fn = (e) => {
  if (e.ram.simulatedIndex) return;
  e.ram.scriptedMovementState = false;
  e.ram.synced.initialized = false;
  e.endNpcMovementScript();
};

function pewterWalk(e: Engine, player: number[], guy: number[]): void {
  e.playMusic('MUSIC_MUSEUM_GUY');
  e.sprites[0].movementByte1 = 0;
  const p = rle(player);
  e.ram.simulatedJoypad = p;
  e.ram.simulatedIndex = p.length;
  e.ram.synced = { directions: [...rle(guy), 0xff], index: 0, walkCounter: 8, initialized: false };
  e.ram.scriptedMovementState = true;
  e.ram.npcMovementScriptFunction = 1;
}

const pewterMuseum: Fn[] = [(e) => pewterWalk(e, RLE_PewterMuseumPlayer, RLE_PewterMuseumGuy), pewterDone];
const pewterGym: Fn[] = [(e) => pewterWalk(e, RLE_PewterGymPlayer, RLE_PewterGymGuy), pewterDone];

/** RunNPCMovementScript.NPCMovementScriptPointerTables (1-based table numbers). */
export const NPC_MOVEMENT_SCRIPTS: Fn[][] = [pallet, pewterMuseum, pewterGym];
