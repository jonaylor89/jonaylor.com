/**
 * Runs a text_asm routine compiled from the ROM by src/rom/extract/simpleAsm.ts:
 * prints, yes/no menus, event flag tests and writes, GiveItem, Hide/ShowObject,
 * delays and sounds, with the SM83's Z/C flags driving the branches.
 */
import type { Co } from './Engine';
import type { ScriptEnv } from './ScriptEnv';
import type { SimpleAsm } from '../data/schema';
import { c, constName } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { getBit } from '../game/state';
import { talkToTrainer } from './trainers';
import { isStarterPikachuAliveInParty } from '../game/pikachu';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT, FACING_UP } from './sprites';
import { displayPokedex } from './hiddenEvents';
import { inGameTrade, oaksAide } from '../scripts/events';

let addrs: Record<string, number> | undefined;
const A = () =>
  (addrs ??= {
    events: ramSym('wEventFlags'),
    menu: ramSym('wCurrentMenuItem'),
    happiness: ramSym('wPikachuHappiness'),
    mood: ramSym('wPikachuMood'),
    spawn: ramSym('wPikachuSpawnStateFlags'),
    badges: ramSym('wObtainedBadges'),
    beatGym: ramSym('wBeatGymFlags'),
    facing: ramSym('wSpritePlayerStateData1FacingDirection'),
    curMapScript: ramSym('wCurMapScript'),
    randomAdd: ramSym('hRandomAdd'),
    randomSub: ramSym('hRandomSub'),
    aideResult: ramSym('hOaksAideResult'),
    statusFlags1: ramSym('wStatusFlags1'),
    textId: ramSym('hTextID'),
  });

/** The WRAM bytes compiled routines read, from the game state. */
export function readAsmByte(env: ScriptEnv, addr: number): number {
  const a = A();
  const e = env.e;
  const s = e.state;
  if (addr >= a.events && addr < a.events + 0x140) {
    let v = 0;
    const base = (addr - a.events) * 8;
    for (let b = 0; b < 8; b++) if (getBit(s.eventFlags, base + b)) v |= 1 << b;
    return v;
  }
  if (addr === a.menu) return e.ram.currentMenuItem;
  if (addr === a.happiness) return s.pikachu.happiness;
  if (addr === a.mood) return s.pikachu.mood;
  if (addr === a.badges) return s.badges;
  if (addr === a.beatGym) return s.vars.wBeatGymFlags ?? 0;
  if (addr === a.facing) return { down: FACING_DOWN, up: FACING_UP, left: FACING_LEFT, right: FACING_RIGHT }[s.player.facing];
  if (addr === a.curMapScript) return env.curScript;
  if (addr === a.randomAdd) return e.rng.hRandomAdd;
  if (addr === a.randomSub) return e.rng.hRandomSub;
  if (addr === a.aideResult) return Number(e.ram.mem.get(addr) ?? 0);
  if (addr === a.statusFlags1) return s.vars.wStatusFlags1 ?? 0;
  if (addr === a.textId) return e.ram.spriteIndex; // DisplayTextID keeps the id in hTextID (= hSpriteIndex)
  if (addr === a.spawn) {
    // IsSurfingPikachuInParty runs every overworld loop iteration
    let v = 0;
    const surf = c('move', 'SURF');
    if (s.party.some((m) => m.species === c('pokemon', 'STARTER_PIKACHU') && m.moves.includes(surf))) v |= 1 << c('pikachu_emotion', 'BIT_PIKACHU_SPAWN_SURFING');
    if (isStarterPikachuAliveInParty(s)) v |= 1 << c('pikachu_emotion', 'BIT_PIKACHU_SPAWN_STARTER');
    return v;
  }
  throw new Error(`compiled text_asm reads unsupported WRAM $${addr.toString(16)}`);
}

export function* runAsmProgram(env: ScriptEnv, prog: SimpleAsm): Co {
  const e = env.e;
  let z = false;
  let carry = false;
  let i = prog.entry;
  for (let steps = 0; steps < 10000; steps++) {
    const n = prog.nodes[i];
    e.trace('asm', `${i}: ${n.op}`);
    switch (n.op) {
      case 'end':
        return;
      case 'print':
        yield* env.printText(n.text);
        break;
      case 'trainer':
        yield* talkToTrainer(env, n.header);
        break;
      case 'cry':
        yield* env.playCry(e.bundle.species[n.species]?.constName ?? String(n.species));
        break;
      case 'yesno':
        e.ram.currentMenuItem = (yield* env.yesNoChoice()) ? 0 : 1;
        break;
      case 'test': {
        const v = readAsmByte(env, n.addr);
        if (n.bit !== undefined && n.toCarry) carry = !!((v >> n.bit) & 1);
        else if (n.bit !== undefined) z = !((v >> n.bit) & 1);
        else {
          z = v === n.cmp;
          if (!n.zOnly) carry = v < (n.cmp ?? 0);
        }
        break;
      }
      case 'setbit': {
        if (n.addr === A().statusFlags1) {
          const v = e.state.vars.wStatusFlags1 ?? 0;
          env.setVar('wStatusFlags1', n.value ? v | (1 << n.bit) : v & ~(1 << n.bit));
          break;
        }
        const flag = (n.addr - A().events) * 8 + n.bit;
        e.store.dispatch({ type: 'setEvent', flag, value: n.value }, { undoable: false });
        break;
      }
      case 'branch': {
        const take = n.cond === 'z' ? z : n.cond === 'nz' ? !z : n.cond === 'c' ? carry : !carry;
        if (take) {
          i = n.to;
          continue;
        }
        break;
      }
      case 'give': {
        const name = e.bundle.items.find((it) => it.id === n.item)?.constName;
        if (!name) throw new Error(`GiveItem: unknown item ${n.item}`);
        carry = env.giveItem(name, n.qty);
        break;
      }
      case 'take':
        e.store.dispatch({ type: 'takeItem', item: n.item, qty: 1 }, { undoable: false });
        break;
      case 'toggle':
        if (!e.bundle.toggleableObjects[n.toggle]) throw new Error(`toggleable object ${n.toggle} missing`);
        e.setObjectVisible(n.toggle, n.visible);
        break;
      case 'noWait':
        env.doNotWaitForButtonPress = n.value;
        break;
      case 'delay':
        yield* env.delayFrames(n.frames);
        break;
      case 'sound':
        if (n.waitForCurrent) yield* env.waitForSoundToFinish();
        e.sound.playSound(n.id);
        break;
      case 'waitSound':
        yield* env.waitForSoundToFinish();
        break;
      case 'music':
        if (n.stop) env.stopAllMusic();
        else env.playDefaultMusic();
        break;
      case 'testItem':
        z = !e.state.bag.some((sl) => sl.item === n.item);
        break;
      case 'pokedex':
        yield* displayPokedex(e, n.species);
        break;
      case 'oaksAide': {
        const item = e.bundle.items.find((it) => it.id === n.item)?.constName;
        if (!item) throw new Error(`OaksAideScript: unknown item ${n.item}`);
        const result = yield* oaksAide(env, n.requirement, item);
        const code = { got: 'OAKS_AIDE_GOT_ITEM', bagFull: 'OAKS_AIDE_BAG_FULL', notEnough: 'OAKS_AIDE_NOT_ENOUGH_MONS', refused: 'OAKS_AIDE_REFUSED' }[result];
        e.ram.mem.set(A().aideResult, c('script', code));
        break;
      }
      case 'trade':
        yield* inGameTrade(env, n.which);
        break;
      case 'mapScript': {
        const map = Object.values(e.bundle.maps).find((m) => m.label === n.map);
        if (!map) throw new Error(`no map labelled ${n.map}`);
        e.store.dispatch({ type: 'setMapScript', map: map.id, script: n.value ?? env.curScript }, { undoable: false });
        break;
      }
      case 'setScript':
        env.curScript = n.value;
        break;
      case 'movingDir':
        e.ram.playerMovingDirection = n.value;
        break;
      case 'clearJoy':
        e.ram.joyHeld = 0;
        e.ram.joyPressed = 0;
        break;
    }
    i = n.next;
  }
  throw new Error('compiled text_asm did not finish');
}
