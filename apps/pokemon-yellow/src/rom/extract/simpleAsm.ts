/**
 * Recognises text_asm routines built only from a small set of idioms and
 * compiles them into a node graph the engine interprets. The SM83 code is
 * executed symbolically along every path:
 *   ld hl/a/b/c/bc,n · xor a · ld a,[nn] · ld [nn],a (toggle index, no-wait flag)
 *   and a · cp n · bit b,a · bit/set/res b,[hl] (event flags and a few WRAM bytes)
 *   jr/jp (conditional or not) within the bank · farcall/callfar via Bankswitch
 *   call PrintText | TalkToTrainer | PlayCry | WaitForSoundToFinish | YesNoChoice |
 *        GiveItem | Predef (Hide/ShowObject, DoInGameTradeDialogue, OaksAideScript) | DelayFrames | PlaySound(WaitForCurrent) |
 *        StopAllMusic | PlayDefaultMusic | EnableAutoTextBoxDrawing
 *   jp TextScriptEnd / ret (from a farcalled routine, or with hl = the text to go on with)
 * Anything else bails out: such routines need a hand-ported handler in src/scripts.
 */
import type { Rom } from '../Rom';
import type { AsmNode, GameBundle, SimpleAsm } from '../../data/schema';
import { sym, toOffset, fromOffset, ramSym, ramLabelAt } from '../symbols';
import { labelFor, walkTextOps } from '../text';
import type { TextCollector } from './texts';
import { TRAINER_HEADER_AT } from './maps';

class Bail extends Error {}

/** Why routines were not compiled (filled when `ASM_BAIL_STATS` is set; for tools/coverage.ts). */
export const bailStats = new Map<string, number>();
const bail = (why: string): Bail => {
  if (typeof process !== 'undefined' && process.env?.ASM_BAIL_STATS) bailStats.set(why, (bailStats.get(why) ?? 0) + 1);
  return new Bail(why);
};

/** WRAM bytes a compiled routine may read (the engine maps each to game state). */
export const ASM_READABLE = [
  'wCurrentMenuItem',
  'wPikachuHappiness',
  'wPikachuSpawnStateFlags',
  'wObtainedBadges',
  'wBeatGymFlags',
  'wPikachuMood',
  'wSpritePlayerStateData1FacingDirection',
  'wCurMapScript',
  'hRandomAdd',
  'hRandomSub',
  'hOaksAideResult',
  'wStatusFlags1',
  'hTextID',
] as const;

/** WRAM bytes a compiled routine may set/reset bits in (kept as save variables of the same name). */
export const ASM_BIT_WRITABLE = ['wStatusFlags1'] as const;

export function analyzeSimpleAsm(rom: Rom, bundle: Pick<GameBundle, 'texts'>, texts: TextCollector): Record<string, SimpleAsm> {
  const F = {
    printText: sym('PrintText'),
    textScriptEnd: sym('TextScriptEnd'),
    talkToTrainer: sym('TalkToTrainer'),
    bankswitch: sym('Bankswitch'),
    playCry: sym('PlayCry'),
    waitForSound: sym('WaitForSoundToFinish'),
    yesNo: sym('YesNoChoice'),
    giveItem: sym('GiveItem'),
    predef: sym('Predef'),
    delayFrames: sym('DelayFrames'),
    playSound: sym('PlaySound'),
    playSoundWait: sym('PlaySoundWaitForCurrent'),
    stopAllMusic: sym('StopAllMusic'),
    playDefaultMusic: sym('PlayDefaultMusic'),
    autoTextBox: sym('EnableAutoTextBoxDrawing'),
    isItemInBag: sym('IsItemInBag'),
    displayPokedex: sym('DisplayPokedex'),
    getItemName: sym('GetItemName'),
    removeItemByID: sym('RemoveItemByID'),
    copyData: sym('CopyData'),
  };
  const predefId = (name: string) => (sym(`${name}Predef`) - sym('PredefPointers')) / 3;
  const HIDE = predefId('HideObject');
  const SHOW = predefId('ShowObject');
  const SHOW2 = predefId('ShowObject2');
  const TRADE = predefId('DoInGameTradeDialogue');
  const whichTrade = ramSym('wWhichTrade');
  const OAKS_AIDE = predefId('OaksAideScript');
  const aideRequirement = ramSym('hOaksAideRequirement');
  const aideItem = ramSym('hOaksAideRewardItem');
  const namedObject = ramSym('wNamedObjectIndex');
  const itemToRemove = ramSym('hItemToRemoveID');
  const events = ramSym('wEventFlags');
  const eventsEnd = events + 0x140;
  const readable = new Set<number>(ASM_READABLE.map((n) => ramSym(n)));
  const bitWritable = new Set<number>(ASM_BIT_WRITABLE.map((n) => ramSym(n)));
  const toggleIndex = ramSym('wToggleableObjectIndex');
  const noWait = ramSym('wDoNotWaitForButtonPressAfterDisplayingText');
  const curMapScript = ramSym('wCurMapScript');
  const movingDir = ramSym('wPlayerMovingDirection');
  const joy = new Set([ramSym('hJoyHeld'), ramSym('hJoyPressed'), ramSym('hJoyReleased')]);
  const isEvent = (a: number) => a >= events && a < eventsEnd;
  const out: Record<string, SimpleAsm> = {};

  interface Regs {
    hl: number;
    a: number;
    /** address [nn] the value in a was loaded from */
    aSrc: number;
    b: number;
    c: number;
    toggle: number;
    trade: number;
    /** OaksAideScript's hOaksAideRequirement / hOaksAideRewardItem */
    aideReq: number;
    aideItem: number;
    /** hItemToRemoveID */
    remove: number;
  }
  const fresh = (): Regs => ({ hl: -1, a: -1, aSrc: -1, b: -1, c: -1, toggle: -1, trade: -1, aideReq: -1, aideItem: -1, remove: -1 });

  const compile = (start: number, bank: number): SimpleAsm => {
    const nodes: AsmNode[] = [];
    const emit = (n: AsmNode): number => {
      if (nodes.length > 400) throw new Bail();
      nodes.push(n);
      return nodes.length - 1;
    };
    /**
     * Walk one path. `cont` builds what follows a `ret` of a farcalled routine.
     * Returns the index of the path's first node.
     */
    const walk = (p0: number, bank: number, r0: Regs, depth: number, cont: (() => number) | undefined, budget: number): number => {
      let p = p0;
      const r = { ...r0 };
      let first = -1;
      let last = -1;
      const link = (i: number) => {
        if (last >= 0) (nodes[last] as { next: number }).next = i;
        else first = i;
        last = i;
      };
      const finish = (i: number) => {
        link(i);
        return first;
      };
      for (let steps = 0; steps < 128; steps++) {
        if (--budget <= 0) throw new Bail();
        const op = rom.u8(p);
        const n8 = rom.u8(p + 1);
        const nn = rom.u16(p + 1);
        const local = (addr: number) => {
          if (addr < 0x4000) return addr;
          if (addr >= 0x8000) throw new Bail();
          return toOffset(bank, addr);
        };
        const branch = (cond: 'z' | 'nz' | 'c' | 'nc', target: number, fall: number) => {
          const i = emit({ op: 'branch', cond, to: -1, next: -1 });
          link(i);
          const to = walk(target, bank, r, depth, cont, budget);
          const next = walk(fall, bank, r, depth, cont, budget);
          (nodes[i] as { to: number }).to = to;
          (nodes[i] as { next: number }).next = next;
          return first;
        };
        switch (op) {
          case 0x00: // nop
            p += 1;
            break;
          case 0x21:
            r.hl = nn;
            p += 3;
            break;
          case 0x3e:
            r.a = n8;
            r.aSrc = -1;
            p += 2;
            break;
          case 0xaf:
            r.a = 0;
            r.aSrc = -1;
            p += 1;
            break;
          case 0x06:
            r.b = n8;
            p += 2;
            break;
          case 0x0e:
            r.c = n8;
            p += 2;
            break;
          case 0x01:
            r.c = rom.u8(p + 1);
            r.b = rom.u8(p + 2);
            p += 3;
            break;
          case 0xfa: // ld a, [nn]
            if (!isEvent(nn) && !readable.has(nn)) throw bail(`read ${ramLabelAt(nn) ?? nn.toString(16)}`);
            r.a = -1;
            r.aSrc = nn;
            p += 3;
            break;
          case 0xea: // ld [nn], a
            if (nn === toggleIndex && r.a >= 0) r.toggle = r.a;
            else if (nn === whichTrade && r.a >= 0) r.trade = r.a;
            else if (nn === namedObject && r.a >= 0 && r.a === r.aideItem) {
              /* GetItemName argument for the aide's reward name */
            }
            else if (nn === noWait && r.a >= 0) link(emit({ op: 'noWait', value: r.a !== 0, next: -1 }));
            else if (nn === curMapScript && r.a >= 0) link(emit({ op: 'setScript', value: r.a, next: -1 }));
            else if (/^w\w+CurScript$/.test(ramLabelAt(nn) ?? '') && (r.a >= 0 || r.aSrc === curMapScript)) {
              // another map's script index: a constant, or a copy of wCurMapScript
              const map = ramLabelAt(nn)!.slice(1, -'CurScript'.length);
              link(emit({ op: 'mapScript', map, value: r.a >= 0 ? r.a : undefined, next: -1 }));
            }
            else if (nn === movingDir && r.a >= 0) link(emit({ op: 'movingDir', value: r.a, next: -1 }));
            else throw bail(`write ${ramLabelAt(nn) ?? nn.toString(16)}`);
            p += 3;
            break;
          case 0xf0: // ldh a, [n]
            if (!readable.has(0xff00 + n8)) throw bail(`read ${ramLabelAt(0xff00 + n8) ?? n8.toString(16)}`);
            r.a = -1;
            r.aSrc = 0xff00 + n8;
            p += 2;
            break;
          case 0xe0: // ldh [n], a
            // hOaksAideRequirement and hItemToRemoveID share $FFDB
            if ((0xff00 + n8 === aideRequirement || 0xff00 + n8 === itemToRemove) && r.a >= 0) {
              if (0xff00 + n8 === aideRequirement) r.aideReq = r.a;
              if (0xff00 + n8 === itemToRemove) r.remove = r.a;
              p += 2;
              break;
            }
            if (0xff00 + n8 === aideItem && r.a >= 0) {
              r.aideItem = r.a;
              p += 2;
              break;
            }
            if (!joy.has(0xff00 + n8) || r.a !== 0) throw bail(`write ${ramLabelAt(0xff00 + n8) ?? n8.toString(16)}`);
            link(emit({ op: 'clearJoy', next: -1 }));
            p += 2;
            break;
          case 0x62: // ld h, d / ld l, e: only around the aide's GetItemName/CopyData
          case 0x6b:
          case 0x11: // ld de, nn
            if (r.aideItem < 0) throw bail(`op ${op.toString(16)}`);
            r.hl = -1;
            p += op === 0x11 ? 3 : 1;
            break;
          case 0x3d: // dec a: Z when a was 1 (C is left alone)
            if (r.aSrc < 0) throw new Bail();
            link(emit({ op: 'test', addr: r.aSrc, cmp: 1, zOnly: true, next: -1 }));
            r.a = r.aSrc = -1;
            p += 1;
            break;
          case 0x0f: // rrca ×(bit+1) / add a: CheckEvent's carry form (C = the flag)
          case 0x87: {
            if (r.aSrc < 0) throw new Bail();
            let k = 0;
            if (op === 0x87) {
              k = 8;
              p += 1;
            } else while (rom.u8(p) === 0x0f) (k++, p++);
            link(emit({ op: 'test', addr: r.aSrc, bit: k - 1, toCarry: true, next: -1 }));
            r.a = r.aSrc = -1;
            break;
          }
          case 0xa7: // and a
            if (r.aSrc < 0) throw new Bail();
            link(emit({ op: 'test', addr: r.aSrc, cmp: 0, next: -1 }));
            p += 1;
            break;
          case 0xfe: // cp n
            if (r.aSrc < 0) throw new Bail();
            link(emit({ op: 'test', addr: r.aSrc, cmp: n8, next: -1 }));
            p += 2;
            break;
          case 0xcb: {
            const x = n8;
            const bit = (x >> 3) & 7;
            if ((x & 0xc7) === 0x47) {
              // bit b, a
              if (r.aSrc < 0) throw new Bail();
              link(emit({ op: 'test', addr: r.aSrc, bit, next: -1 }));
            } else if ((x & 0xc7) === 0x46) {
              // bit b, [hl]
              if (!isEvent(r.hl) && !readable.has(r.hl)) throw new Bail();
              link(emit({ op: 'test', addr: r.hl, bit, next: -1 }));
            } else if ((x & 0xc7) === 0xc6 || (x & 0xc7) === 0x86) {
              // set/res b, [hl]
              if (!isEvent(r.hl) && !bitWritable.has(r.hl)) throw new Bail();
              link(emit({ op: 'setbit', addr: r.hl, bit, value: (x & 0xc7) === 0xc6, next: -1 }));
            } else throw new Bail();
            p += 2;
            break;
          }
          case 0x18:
            p = p + 2 + rom.s8(p + 1);
            break;
          case 0x20:
          case 0x28:
          case 0x30:
          case 0x38: {
            const cond = ({ 0x20: 'nz', 0x28: 'z', 0x30: 'nc', 0x38: 'c' } as const)[op];
            return branch(cond, p + 2 + rom.s8(p + 1), p + 2);
          }
          case 0xc2:
          case 0xca:
          case 0xd2:
          case 0xda: {
            const cond = ({ 0xc2: 'nz', 0xca: 'z', 0xd2: 'nc', 0xda: 'c' } as const)[op];
            if (nn === F.textScriptEnd) throw new Bail();
            return branch(cond, local(nn), p + 3);
          }
          case 0xc9: // ret: end of a farcalled routine
            if (depth === 0) {
              // back to TextCommandProcessor, which goes on with the text at hl
              if (r.hl < 0x4000 || r.hl >= 0x8000) throw new Bail();
              const t = toOffset(bank, r.hl);
              if (rom.u8(t) === 0x50) return finish(emit({ op: 'end' })); // text_end
              const label = labelFor(t);
              if (!texts.add(label, t)) throw new Bail();
              link(emit({ op: 'print', text: label, next: -1 }));
              return finish(emit({ op: 'end' }));
            }
            if (!cont) throw new Bail();
            return finish(cont());
          case 0xc3:
            if (nn === F.textScriptEnd) {
              if (depth !== 0) throw new Bail();
              return finish(emit({ op: 'end' }));
            }
            p = local(nn);
            break;
          case 0xcd: {
            const target = nn < 0x4000 ? nn : toOffset(bank, nn);
            p += 3;
            if (target === F.printText) {
              if (r.hl < 0) throw new Bail();
              const t = toOffset(r.hl < 0x4000 ? 0 : bank, r.hl);
              const label = labelFor(t);
              if (!texts.add(label, t)) throw new Bail();
              link(emit({ op: 'print', text: label, next: -1 }));
            } else if (target === F.talkToTrainer) {
              const h = TRAINER_HEADER_AT.get(toOffset(bank, r.hl));
              if (!h) throw new Bail();
              link(emit({ op: 'trainer', header: h.header, next: -1 }));
            } else if (target === F.playCry) {
              if (r.a < 0) throw new Bail();
              link(emit({ op: 'cry', species: r.a, next: -1 }));
            } else if (target === F.waitForSound) {
              link(emit({ op: 'waitSound', next: -1 }));
            } else if (target === F.autoTextBox) {
              /* no node */
            } else if (target === F.isItemInBag) {
              if (r.b < 0) throw new Bail();
              link(emit({ op: 'testItem', item: r.b, next: -1 }));
            } else if (target === F.displayPokedex) {
              if (r.a < 0) throw new Bail();
              link(emit({ op: 'pokedex', species: r.a, next: -1 }));
            } else if (target === F.yesNo) {
              link(emit({ op: 'yesno', next: -1 }));
            } else if (target === F.giveItem) {
              if (r.b < 0 || r.c < 0) throw new Bail();
              link(emit({ op: 'give', item: r.b, qty: r.c, next: -1 }));
            } else if ((target === F.getItemName || target === F.copyData) && r.aideItem >= 0) {
              /* the aide's reward name into wOaksAideRewardItemName */
            } else if (target === F.predef && r.a === OAKS_AIDE) {
              if (r.aideReq < 0 || r.aideItem < 0) throw new Bail();
              link(emit({ op: 'oaksAide', requirement: r.aideReq, item: r.aideItem, next: -1 }));
            } else if (target === F.predef && r.a === TRADE) {
              if (r.trade < 0) throw new Bail();
              link(emit({ op: 'trade', which: r.trade, next: -1 }));
            } else if (target === F.predef) {
              if (r.toggle < 0 || ![HIDE, SHOW, SHOW2].includes(r.a)) throw new Bail();
              link(emit({ op: 'toggle', toggle: r.toggle, visible: r.a !== HIDE, next: -1 }));
            } else if (target === F.delayFrames) {
              if (r.c < 0) throw new Bail();
              link(emit({ op: 'delay', frames: r.c, next: -1 }));
            } else if (target === F.playSound || target === F.playSoundWait) {
              if (r.a < 0) throw new Bail();
              link(emit({ op: 'sound', id: r.a, waitForCurrent: target === F.playSoundWait, next: -1 }));
            } else if (target === F.stopAllMusic) {
              link(emit({ op: 'music', stop: true, next: -1 }));
            } else if (target === F.playDefaultMusic) {
              link(emit({ op: 'music', stop: false, next: -1 }));
            } else if (target === F.bankswitch && r.b >= 0 && r.hl >= 0 && toOffset(r.b, r.hl) === F.removeItemByID) {
              if (r.remove < 0) throw new Bail();
              link(emit({ op: 'take', item: r.remove, next: -1 }));
            } else if (target === F.bankswitch) {
              if (r.b < 0 || r.hl < 0 || depth > 0) throw new Bail();
              const after = p;
              const sub = walk(toOffset(r.b, r.hl), r.b, fresh(), depth + 1, () => walk(after, bank, fresh(), depth, cont, budget), budget);
              return finish(sub);
            } else throw bail(`call ${labelFor(target)}`);
            // calls clobber the registers we track
            r.hl = r.a = r.aSrc = r.b = r.c = -1;
            break;
          }
          default:
            throw bail(`op ${op.toString(16)}`);
        }
      }
      throw new Bail();
    };
    const entry = walk(start, bank, fresh(), 0, undefined, 2000);
    return { entry, nodes };
  };

  for (const ops of Object.values(bundle.texts)) {
    for (const op of walkTextOps(ops)) {
      if (op.t !== 'asm' || op.at === undefined || out[op.label]) continue;
      const [bank] = fromOffset(op.at);
      try {
        const prog = compile(op.at, bank);
        if (prog.nodes.some((n) => n.op !== 'end')) out[op.label] = prog;
      } catch (e) {
        if (!(e instanceof Bail)) throw e;
      }
    }
  }
  return out;
}
