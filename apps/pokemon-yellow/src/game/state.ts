/**
 * Deterministic game-state store.
 *
 * - GameState is plain JSON (no classes, no functions): trivially serializable.
 * - All mutations go through `dispatch(action)`; the reducer is pure with
 *   respect to (state, action), so replaying the action log from a snapshot
 *   reproduces the exact same state (RNG state lives inside GameState too).
 * - A bounded undo stack of snapshots supports debug "undo" and tests.
 */
import { c } from '../rom/constants';
import type { Facing } from '../world/movement';
import type { GameBundle } from '../data/schema';

export const STATE_VERSION = 2;

/** Gen 1 party/box Pokémon, field-for-field with the original party struct (trade-compatible). */
export interface PartyMon {
  species: number;
  hp: number;
  /** Box level byte (kept for struct fidelity). */
  boxLevel: number;
  status: number;
  types: [number, number];
  catchRate: number;
  moves: [number, number, number, number];
  otId: number;
  exp: number;
  statExp: { hp: number; atk: number; def: number; spd: number; spc: number };
  /** 16-bit DV word: atk<<12 | def<<8 | spd<<4 | spc */
  dvs: number;
  /** PP per move; upper 2 bits = PP Ups applied. */
  pp: [number, number, number, number];
  level: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number;
  nickname: string;
  otName: string;
}

export interface ItemSlot {
  item: number;
  qty: number;
}

export interface GameState {
  version: number;
  /** Frames elapsed (60 Hz), drives play time. */
  frames: number;
  player: {
    name: string;
    rivalName: string;
    id: number;
    map: number;
    x: number;
    y: number;
    facing: Facing;
    mode: 'walk' | 'bike' | 'surf';
    /** wLastMap: the outdoor map used by LAST_MAP warps. */
    lastMap: number;
  };
  money: number;
  coins: number;
  badges: number;
  /** wEventFlags as a bit array (NUM_EVENTS bits). */
  eventFlags: number[];
  /** Visibility of toggleable objects, indexed like bundle.toggleableObjects. */
  objectVisible: boolean[];
  /** Per-map script index (the W<Map>CurScript variables). */
  mapScripts: Record<number, number>;
  bag: ItemSlot[];
  pcItems: ItemSlot[];
  party: PartyMon[];
  boxes: PartyMon[][];
  currentBox: number;
  pokedex: { owned: number[]; seen: number[] };
  options: {
    textSpeed: 'fast' | 'medium' | 'slow';
    battleAnimation: boolean;
    battleStyle: 'shift' | 'set';
    /** Yellow's SOUND option (0 mono, 1-3 earphone modes) and GB Printer brightness (0-4). */
    sound?: number;
    printer?: number;
  };
  pikachu: { happiness: number; mood: number };
  /** RNG state (hRandomAdd / hRandomSub + our deterministic generator seed). */
  rng: { seed: number; add: number; sub: number };
  /** Hidden items/coins already found (bitsets by index). */
  hiddenItems: number[];
  hiddenCoins: number[];
  /** Script variables kept in the save (wOakWalkedToPlayer, wRivalStarter, ...). */
  vars: Record<string, number>;
  /** The Day Care mon (wDayCareInUse / wDayCareMon); its exp grows by one per step. */
  daycare?: PartyMon;
  /** sHallOfFame: up to HOF_TEAM_CAPACITY teams, oldest first (wNumHoFTeams is a var). */
  hallOfFame?: HallOfFameMon[][];
  /** Player's party nickname/OT data lives in PartyMon; this is wPlayerStarter etc. */
}

export interface HallOfFameMon {
  species: number;
  level: number;
  nick: string;
}

export type Action =
  | { type: 'tick'; frames: number }
  | { type: 'setPosition'; map: number; x: number; y: number; facing?: Facing; lastMap?: number }
  | { type: 'face'; facing: Facing }
  | { type: 'setMode'; mode: GameState['player']['mode'] }
  | { type: 'setEvent'; flag: number; value: boolean }
  | { type: 'setObjectVisible'; toggle: number; visible: boolean }
  | { type: 'setMapScript'; map: number; script: number }
  | { type: 'giveItem'; item: number; qty: number }
  | { type: 'takeItem'; item: number; qty: number }
  | { type: 'addMoney'; amount: number }
  | { type: 'setNames'; player?: string; rival?: string }
  | { type: 'addPartyMon'; mon: PartyMon }
  | { type: 'setPokedex'; dex: number; seen?: boolean; owned?: boolean }
  | { type: 'setBadge'; badge: number; value: boolean }
  | { type: 'setOptions'; options: Partial<GameState['options']> }
  | { type: 'rng'; seed: number; add: number; sub: number }
  | { type: 'setVar'; name: string; value: number }
  | { type: 'setParty'; party: PartyMon[] }
  | { type: 'setBag'; bag: ItemSlot[] }
  | { type: 'setPikachu'; happiness?: number; mood?: number }
  | { type: 'addBoxMon'; mon: PartyMon }
  | { type: 'setDaycare'; mon: PartyMon | undefined }
  | { type: 'setBoxes'; boxes: PartyMon[][]; currentBox?: number }
  | { type: 'setPcItems'; items: ItemSlot[] }
  | { type: 'setHiddenFound'; kind: 'item' | 'coins'; index: number }
  | { type: 'addCoins'; amount: number }
  | { type: 'setLastMap'; map: number }
  | { type: 'addHallOfFameTeam'; team: HallOfFameMon[] }
  | { type: 'replaceState'; state: GameState };

export const BAG_CAPACITY = 20;
export const PC_ITEM_CAPACITY = 50;

export function newGameState(bundle: GameBundle, seed = 0x1234): GameState {
  const numEvents = c('event', 'NUM_EVENTS');
  return {
    version: STATE_VERSION,
    frames: 0,
    player: {
      name: 'YELLOW',
      rivalName: 'BLUE',
      id: seed & 0xffff,
      // New games start in Red's bedroom (REDS_HOUSE_2F), as set by PrepareForSpecialWarp.
      map: c('map', 'REDS_HOUSE_2F'),
      x: 3,
      y: 6,
      facing: 'up',
      mode: 'walk',
      lastMap: c('map', 'PALLET_TOWN'),
    },
    money: 3000,
    coins: 0,
    badges: 0,
    eventFlags: new Array(Math.ceil(numEvents / 8)).fill(0),
    objectVisible: bundle.toggleableObjects.map((t) => t.initiallyVisible),
    mapScripts: {},
    bag: [],
    // The PC starts with a Potion (InitPlayerData: wNumBoxItems = 1, POTION).
    pcItems: [{ item: c('item', 'POTION'), qty: 1 }],
    party: [],
    boxes: Array.from({ length: c('pokemon_data', 'NUM_BOXES') }, () => []),
    currentBox: 0,
    pokedex: { owned: new Array(19).fill(0), seen: new Array(19).fill(0) },
    options: { textSpeed: 'medium', battleAnimation: true, battleStyle: 'shift' },
    pikachu: { happiness: 90, mood: 0x80 },
    rng: { seed, add: 0, sub: 0 },
    hiddenItems: new Array(Math.ceil(c('item', 'MAX_HIDDEN_ITEMS') / 8)).fill(0),
    hiddenCoins: new Array(Math.ceil(c('item', 'MAX_HIDDEN_COINS') / 8)).fill(0),
    vars: {},
  };
}

/** Upgrade older saved states in place. */
export function migrateState(s: GameState & { version: number }): GameState {
  if (s.version < 2) {
    s.vars ??= {};
    s.version = 2;
  }
  return s;
}

export function getBit(bits: number[], i: number): boolean {
  return ((bits[i >> 3] >> (i & 7)) & 1) === 1;
}
function setBit(bits: number[], i: number, v: boolean): void {
  if (v) bits[i >> 3] |= 1 << (i & 7);
  else bits[i >> 3] &= ~(1 << (i & 7));
}

/**
 * AddItemToInventory_: add to the first stack of the item; a stack that would
 * reach 100 is topped up to 99 and the rest goes to the next stack of the item
 * (or a new slot). Fails without changes when a new slot is needed and the
 * list is full.
 */
export function addItem(list: ItemSlot[], item: number, qty: number, cap: number): boolean {
  const room = list.length < cap;
  let left = qty;
  for (const slot of list) {
    if (slot.item !== item) continue;
    if (slot.qty + left < 100) {
      slot.qty += left;
      return true;
    }
    if (!room) return false;
    left = slot.qty + left - 99;
    slot.qty = 99;
  }
  if (!room) return false;
  list.push({ item, qty: left });
  return true;
}

/** Applies an action to a state (mutating). Must stay deterministic. */
export function reduce(s: GameState, a: Action): void {
  switch (a.type) {
    case 'tick':
      s.frames += a.frames;
      break;
    case 'setPosition':
      s.player.map = a.map;
      s.player.x = a.x;
      s.player.y = a.y;
      if (a.facing) s.player.facing = a.facing;
      if (a.lastMap !== undefined) s.player.lastMap = a.lastMap;
      break;
    case 'face':
      s.player.facing = a.facing;
      break;
    case 'setMode':
      s.player.mode = a.mode;
      break;
    case 'setEvent':
      setBit(s.eventFlags, a.flag, a.value);
      break;
    case 'setObjectVisible':
      s.objectVisible[a.toggle] = a.visible;
      break;
    case 'setMapScript':
      s.mapScripts[a.map] = a.script;
      break;
    case 'giveItem':
      if (!addItem(s.bag, a.item, a.qty, BAG_CAPACITY)) throw new StateError('bag full');
      break;
    case 'takeItem': {
      const i = s.bag.findIndex((x) => x.item === a.item);
      if (i < 0 || s.bag[i].qty < a.qty) throw new StateError('not enough items');
      s.bag[i].qty -= a.qty;
      if (!s.bag[i].qty) s.bag.splice(i, 1);
      break;
    }
    case 'addMoney':
      s.money = Math.max(0, Math.min(999999, s.money + a.amount));
      break;
    case 'setNames':
      if (a.player) s.player.name = a.player;
      if (a.rival) s.player.rivalName = a.rival;
      break;
    case 'addPartyMon':
      if (s.party.length >= 6) throw new StateError('party full');
      s.party.push(structuredClone(a.mon));
      break;
    case 'setPokedex':
      if (a.seen !== undefined) setBit(s.pokedex.seen, a.dex - 1, a.seen);
      if (a.owned !== undefined) setBit(s.pokedex.owned, a.dex - 1, a.owned);
      break;
    case 'setBadge':
      s.badges = a.value ? s.badges | (1 << a.badge) : s.badges & ~(1 << a.badge);
      break;
    case 'addHallOfFameTeam': {
      // SaveHallOfFameTeams: when full, the oldest team is shifted out
      const teams = (s.hallOfFame ??= []);
      if (teams.length >= c('pokemon_data', 'HOF_TEAM_CAPACITY')) teams.shift();
      teams.push(a.team);
      break;
    }
    case 'setOptions':
      Object.assign(s.options, a.options);
      break;
    case 'rng':
      s.rng = { seed: a.seed, add: a.add, sub: a.sub };
      break;
    case 'setVar':
      s.vars[a.name] = a.value;
      break;
    case 'setPikachu':
      if (a.happiness !== undefined) s.pikachu.happiness = a.happiness & 0xff;
      if (a.mood !== undefined) s.pikachu.mood = a.mood & 0xff;
      break;
    case 'setDaycare':
      if (a.mon) s.daycare = structuredClone(a.mon);
      else delete s.daycare;
      break;
    case 'addBoxMon': {
      const box = (s.boxes[s.currentBox] ??= []);
      if (box.length >= 20) throw new StateError('box full');
      box.unshift(structuredClone(a.mon)); // SendNewMonToBox inserts at the front
      break;
    }
    case 'setParty':
      s.party = structuredClone(a.party);
      break;
    case 'setBoxes':
      s.boxes = structuredClone(a.boxes);
      if (a.currentBox !== undefined) s.currentBox = a.currentBox;
      break;
    case 'setPcItems':
      s.pcItems = structuredClone(a.items);
      break;
    case 'setHiddenFound':
      setBit(a.kind === 'item' ? s.hiddenItems : s.hiddenCoins, a.index, true);
      break;
    case 'setLastMap':
      s.player.lastMap = a.map;
      break;
    case 'addCoins':
      s.coins = Math.max(0, Math.min(9999, s.coins + a.amount));
      break;
    case 'setBag':
      s.bag = structuredClone(a.bag);
      break;
    case 'replaceState':
      Object.assign(s, structuredClone(a.state));
      break;
  }
}

export class StateError extends Error {}

export type Listener = (state: GameState, action: Action) => void;

export class Store {
  private undoStack: GameState[] = [];
  readonly log: Action[] = [];
  private listeners = new Set<Listener>();

  constructor(
    public state: GameState,
    private readonly maxUndo = 64,
    private readonly maxLog = 5000,
  ) {}

  dispatch(action: Action, opts: { undoable?: boolean } = {}): void {
    if (opts.undoable ?? action.type !== 'tick') {
      this.undoStack.push(structuredClone(this.state));
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    }
    reduce(this.state, action);
    if (action.type !== 'tick') {
      this.log.push(action);
      if (this.log.length > this.maxLog) this.log.shift();
    }
    for (const l of this.listeners) l(this.state, action);
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.state = prev;
    for (const l of this.listeners) l(this.state, { type: 'replaceState', state: prev });
    return true;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  event(flag: number | string): boolean {
    const i = typeof flag === 'number' ? flag : c('event', flag);
    return getBit(this.state.eventFlags, i);
  }

  snapshot(): GameState {
    return structuredClone(this.state);
  }
}

/** Replays actions on a copy of `from` (used by tests and the debug overlay). */
export function replay(from: GameState, actions: Action[]): GameState {
  const s = structuredClone(from);
  for (const a of actions) reduce(s, a);
  return s;
}
