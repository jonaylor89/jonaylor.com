/**
 * The API ported map scripts use. Method names follow the original routines
 * (DisplayTextID, MoveSprite, SetSpriteFacingDirectionAndDelay, ShowObject…)
 * so a port can be checked line by line against pokeyellow's scripts/*.asm.
 */
import { isStarterPikachuAliveInParty } from '../game/pikachu';
import type { Co, Engine } from './Engine';
import { PAD_A, PAD_B, PAD_DOWN, PAD_UP, PLAYER_DIR_DOWN, PLAYER_DIR_LEFT, PLAYER_DIR_RIGHT, PLAYER_DIR_UP } from './pad';
import { c } from '../rom/constants';
import { getBit } from '../game/state';
import type { Sprite } from './sprites';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT, FACING_UP, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP } from './sprites';
import { makePartyMon, healMon, species as speciesData } from '../game/pokemon';
import { encodePlain } from '../ui/TextPrinter';
import { twoOptionMenu, namingScreen } from '../ui/menus';

export type Facing = 'down' | 'up' | 'left' | 'right';
const FACING: Record<Facing, number> = { down: FACING_DOWN, up: FACING_UP, left: FACING_LEFT, right: FACING_RIGHT };
const PLAYER_DIR: Record<Facing, number> = { down: PLAYER_DIR_DOWN, up: PLAYER_DIR_UP, left: PLAYER_DIR_LEFT, right: PLAYER_DIR_RIGHT };

export class ScriptEnv {
  constructor(readonly e: Engine) {}

  // ---------------------------------------------------------------- state
  get ram() {
    return this.e.ram;
  }
  get vars(): Record<string, number> {
    return this.e.state.vars;
  }
  getVar(name: string): number {
    return this.e.state.vars[name] ?? 0;
  }
  setVar(name: string, value: number): void {
    this.e.store.dispatch({ type: 'setVar', name, value }, { undoable: false });
  }
  get curScript(): number {
    return this.e.curScript;
  }
  set curScript(n: number) {
    this.e.curScript = n;
  }
  /** Script index constant by name, e.g. s('SCRIPT_PALLETTOWN_DAISY'). */
  s(name: string): number {
    return c('map_script', name);
  }
  setMapScript(mapConst: string, scriptName: string): void {
    this.e.setMapScriptOf(mapConst, c('map_script', scriptName));
  }
  /** An event flag by number (EVENT_* + offset arithmetic). */
  checkEventFlag(flag: number): boolean {
    return getBit(this.e.state.eventFlags, flag);
  }
  checkEvent(name: string): boolean {
    return this.e.event(name);
  }
  setEvent(name: string): void {
    this.e.setEvent(name, true);
  }
  resetEvent(name: string): void {
    this.e.setEvent(name, false);
  }
  /** CheckAndSetEvent: returns the previous value. */
  checkAndSetEvent(name: string): boolean {
    const was = this.e.event(name);
    this.e.setEvent(name, true);
    return was;
  }
  get x(): number {
    return this.e.state.player.x;
  }
  get y(): number {
    return this.e.state.player.y;
  }
  /** Writing wXCoord / wYCoord directly (a few scripts do this). */
  setPlayerCoords(x: number, y: number): void {
    const p = this.e.state.player;
    this.e.store.dispatch({ type: 'setPosition', map: p.map, x, y }, { undoable: false });
  }
  set joyIgnore(mask: number) {
    this.e.ram.joyIgnore = mask;
  }
  get joyHeld(): number {
    return this.e.ram.joyHeld;
  }
  set joyHeld(v: number) {
    this.e.ram.joyHeld = v;
  }
  /** wPlayerMovingDirection */
  setPlayerMovingDirection(f: Facing): void {
    this.e.ram.playerMovingDirection = PLAYER_DIR[f];
  }
  /** wSpritePlayerStateData1FacingDirection */
  setPlayerFacing(f: Facing): void {
    this.e.setPlayerFacing(f);
  }
  get playerFacing(): Facing {
    return this.e.state.player.facing;
  }
  /** wCurrentMapScriptFlags BIT_CUR_MAP_LOADED_2, cleared when read. */
  takeMapLoaded2(): boolean {
    const v = this.e.ram.curMapLoaded2;
    this.e.ram.curMapLoaded2 = false;
    return v;
  }
  /**
   * wPikachuSpawnStateFlags BIT_PIKACHU_SPAWN_STARTER: IsSurfingPikachuInParty runs every
   * overworld loop iteration, so this is "the starter Pikachu is alive in the party".
   */
  get pikachuSpawnStarter(): boolean {
    return isStarterPikachuAliveInParty(this.e.state);
  }
  /** wCurrentMapScriptFlags BIT_CUR_MAP_LOADED_1, cleared when read (CheckAndResetBit idiom). */
  takeMapLoaded1(): boolean {
    const v = this.e.ram.curMapLoaded1;
    this.e.ram.curMapLoaded1 = false;
    return v;
  }
  enableAutoTextBoxDrawing(): void {
    this.e.ram.autoTextBoxControl = 0;
    this.e.ram.doNotWaitForButtonPress = 0;
  }
  disableAutoTextBoxDrawing(): void {
    this.e.ram.autoTextBoxControl = 1;
    this.e.ram.doNotWaitForButtonPress = 0;
  }
  set doNotWaitForButtonPress(v: boolean) {
    this.e.ram.doNotWaitForButtonPress = v ? 1 : 0;
  }

  // ---------------------------------------------------------------- text
  /** DisplayTextID with a TEXT_* constant name or a numeric id / sprite index. */
  *displayTextID(id: string | number): Co {
    yield* this.e.displayTextID(typeof id === 'number' ? id : c('text_id', id));
  }
  /** PrintText with a text label (e.g. 'PalletTownOakText.WhewText'). */
  *printText(label: string): Co {
    yield* this.e.printText(label);
  }
  /** GetMonName → wNameBuffer (for {ram:wcd6d} in text). */
  getMonName(speciesIndex: number): void {
    this.e.ram.nameBuffer = speciesData(this.e.bundle, speciesIndex).name;
  }
  *yesNoChoice(): Co<boolean> {
    return (yield* twoOptionMenu(this.e, 'YES_NO_MENU', 14, 7)) === 0;
  }

  /** GBFadeOutToWhite / GBFadeInFromWhite */
  /** GBFadeOutToWhite: FadePal6-8, 8 frames each. */
  *fadeToWhite(): Co {
    yield* this.gbFade([1 / 3, 2 / 3, 1], 'white');
  }
  /** GBFadeInFromWhite: FadePal7-5. */
  *fadeFromWhite(): Co {
    yield* this.gbFade([2 / 3, 1 / 3, 0], 'white');
  }
  /** GBFadeOutToBlack: FadePal4-1. */
  *fadeToBlack(): Co {
    yield* this.gbFade([0, 1 / 3, 2 / 3, 1], 'black');
  }
  /** GBFadeInFromBlack: FadePal1-4. */
  *fadeFromBlack(): Co {
    yield* this.gbFade([1, 2 / 3, 1 / 3, 0], 'black');
  }
  private *gbFade(levels: number[], color: 'white' | 'black'): Co {
    for (const l of levels) {
      this.e.hooks.fade?.(l, color);
      yield* this.delayFrames(8);
    }
  }

  /** DisplayDexRating (engine/events/pokedex_rating.asm). */
  *displayDexRating(): Co {
    let seen = 0;
    let owned = 0;
    for (let i = 0; i < 151; i++) {
      if (getBit(this.e.state.pokedex.seen, i)) seen++;
      if (getBit(this.e.state.pokedex.owned, i)) owned++;
    }
    // hDexRatingNumMonsSeen / hDexRatingNumMonsOwned
    this.e.ram.mem.set(0xffdb, seen);
    this.e.ram.mem.set(0xffdc, owned);
    const rating = this.e.bundle.dexRatings.find((r) => owned < r.below) ?? this.e.bundle.dexRatings.at(-1)!;
    if (this.checkEvent('EVENT_HALL_OF_FAME_DEX_RATING')) {
      this.resetEvent('EVENT_HALL_OF_FAME_DEX_RATING');
      this.setVar('wDexRatingNumMonsSeen', seen);
      this.setVar('wDexRatingNumMonsOwned', owned);
      this.e.ram.dexRatingText = rating.textLabel;
      return;
    }
    yield* this.e.printText('DexCompletionText');
    yield* this.e.printText(rating.textLabel);
    this.playSound('pokedex_rating');
    yield* this.e.waitForTextScrollButtonPress();
  }

  /** Switch wCurMapTextPtr to an alternate table (or back with undefined). */
  setTextPointers(table: string | undefined): void {
    this.e.ram.textPointerOverride = table;
  }
  /** PlayCry + WaitForSoundToFinish */
  *playCry(species: string): Co {
    this.playSound(`cry:${species}`);
    yield* this.e.waitForSoundToFinish();
  }
  get spriteIndex(): number {
    return this.e.ram.spriteIndex;
  }

  // ---------------------------------------------------------------- timing
  *delay3(): Co {
    yield* this.e.delayFrames(3);
  }
  *delayFrame(): Co {
    yield;
  }
  *delayFrames(n: number): Co {
    yield* this.e.delayFrames(n);
  }

  // ---------------------------------------------------------------- sprites
  /** Object slot by object constant (e.g. 'OAKSLAB_RIVAL') or number. */
  slot(obj: string | number): number {
    return typeof obj === 'number' ? obj : c('object', obj);
  }
  sprite(obj: string | number): Sprite {
    const s = this.e.sprites[this.slot(obj)];
    if (!s) throw new Error(`no sprite ${obj} on ${this.e.world.data.constName}`);
    return s;
  }
  moveSprite(obj: string | number, directions: number[]): void {
    this.e.moveSprite(this.slot(obj), directions);
  }
  /** BIT_SCRIPTED_NPC_MOVEMENT */
  get npcMoving(): boolean {
    return this.e.scripted.active;
  }
  get numScriptedSteps(): number {
    return this.e.scripted.numSteps;
  }
  /** Overwrite one entry of wNPCMovementDirections (OaksLab rival exit). */
  setScriptedDirection(i: number, dir: number): void {
    this.e.scripted.directions[i] = dir;
  }
  setSpriteFacing(obj: string | number, f: Facing): void {
    this.sprite(obj).facing = FACING[f];
  }
  *setSpriteFacingDirectionAndDelay(obj: string | number, f: Facing): Co {
    this.setSpriteFacing(obj, f);
    yield* this.e.delayFrames(6);
  }
  /** wSpriteXXStateData1MovementStatus */
  setMovementStatus(obj: string | number, v: number): void {
    this.sprite(obj).movementStatus = v;
  }
  /** SPRITESTATEDATA2_MAPY/X (map coords without the +4). */
  setSpriteMapPosition(obj: string | number, x: number, y: number): void {
    const s = this.sprite(obj);
    s.mapX = x;
    s.mapY = y;
    s.offX = s.offY = 0;
  }
  /** Get/SetSpritePosition1 save and restore positions (used around battles). */
  getSpritePosition(obj: string | number): { x: number; y: number } {
    const s = this.sprite(obj);
    return { x: s.mapX, y: s.mapY };
  }
  showObject(toggle: string): void {
    this.e.setObjectVisible(toggle, true);
  }
  hideObject(toggle: string): void {
    this.e.setObjectVisible(toggle, false);
  }
  /** EmotionBubble: show for 60 frames above a sprite slot (0 = player). */
  *emotionBubble(obj: string | number, bubble: string): Co {
    this.e.ram.emotionBubble = { slot: this.slot(obj), bubble: c('script', bubble) };
    yield* this.e.delayFrames(60);
    this.e.ram.emotionBubble = undefined;
  }
  updateSprites(): void {
    this.e.updateSprites();
  }

  // ---------------------------------------------------------------- simulated input
  /** Write wSimulatedJoypadStatesEnd (in memory order) and wSimulatedJoypadStatesIndex. */
  setSimulatedJoypad(states: number[], index = states.length): void {
    // the buffer keeps whatever lies past the bytes written (some scripts rely on leftovers)
    const buf = [...this.e.ram.simulatedJoypad];
    states.forEach((v, i) => (buf[i] = v));
    this.e.ram.simulatedJoypad = buf;
    this.e.ram.simulatedIndex = index;
  }
  startSimulatingJoypadStates(): void {
    this.e.startSimulatingJoypadStates();
  }
  get simulatedIndex(): number {
    return this.e.ram.simulatedIndex;
  }
  /** DecodeRLEList: [value, count, value, count, ...]; returns the expanded list (count = length + terminator). */
  decodeRLE(pairs: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < pairs.length; i += 2) for (let k = 0; k < pairs[i + 1]; k++) out.push(pairs[i]);
    return out;
  }
  /** The common `ld de, RLE; call DecodeRLEList; dec a; ld [wSimulatedJoypadStatesIndex], a` idiom. */
  simulateRLE(pairs: number[]): void {
    const list = this.decodeRLE(pairs);
    this.setSimulatedJoypad(list, list.length);
  }
  setOverrideSimulatedMask(mask: number): void {
    this.e.ram.overrideSimulatedMask = mask;
  }
  /** Start an NPC movement script table (wNPCMovementScriptPointerTableNum = table). */
  startNpcMovementScript(table: number, obj: string | number): void {
    this.e.ram.npcMovementScriptTable = table;
    this.e.ram.npcMovementScriptFunction = 0;
    this.e.ram.npcMovementScriptSprite = this.slot(obj);
  }
  get npcMovementScriptActive(): boolean {
    return this.e.ram.npcMovementScriptTable !== 0;
  }
  get npcMovementScriptFunction(): number {
    return this.e.ram.npcMovementScriptFunction;
  }

  /**
   * CalcPositionOfPlayerRelativeToNPC + FindPathToPlayer: a straight-line
   * path (reducing the larger distance first) into wNPCMovementDirections2.
   * `adjustY` mirrors scripts that `dec [hNPCPlayerYDistance]` to stop one short.
   */
  findPathToPlayer(obj: string | number, adjustY = 0, perspectiveFromPlayer = false): number[] {
    const s = this.sprite(obj);
    let yDist = Math.abs(this.y - s.mapY);
    const xDist = Math.abs(this.x - s.mapX);
    let playerAbove = this.y < s.mapY;
    let playerLeft = this.x < s.mapX;
    if (perspectiveFromPlayer) {
      playerAbove = !playerAbove;
      playerLeft = !playerLeft;
    }
    yDist = (yDist + adjustY) & 0xff;
    const out: number[] = [];
    let yp = 0;
    let xp = 0;
    for (;;) {
      const d = Math.abs(yDist - yp);
      const e = Math.abs(xDist - xp);
      if (d === 0 && e === 0) break;
      if (e >= d) {
        out.push(playerLeft ? NPC_MOVEMENT_LEFT : NPC_MOVEMENT_RIGHT);
        xp++;
      } else {
        out.push(playerAbove ? NPC_MOVEMENT_UP : NPC_MOVEMENT_DOWN);
        yp++;
      }
    }
    this.e.ram.npcMovementDirections2 = [...out, 0xff];
    this.e.ram.npcMovementDirections2Index = out.length;
    return [...out, 0xff];
  }

  /** ArePlayerCoordsInArray with [y, x] pairs; returns 1-based index (wCoordIndex) or 0. */
  arePlayerCoordsInArray(coords: [number, number][]): number {
    const i = coords.findIndex(([y, x]) => y === this.y && x === this.x);
    return i + 1;
  }

  // ---------------------------------------------------------------- music
  playMusic(name: string): void {
    this.e.playMusic(name);
  }
  stopAllMusic(): void {
    this.e.stopAllMusic();
  }
  playDefaultMusic(): void {
    this.e.ram.music = -1;
    this.e.playDefaultMusic();
  }
  set noMapMusic(v: boolean) {
    this.e.ram.noMapMusic = v;
  }
  playSound(name: string): void {
    this.e.hooks.playSound?.(name);
  }
  /** WaitForSoundToFinish */
  *waitForSoundToFinish(): Co {
    yield* this.e.waitForSoundToFinish();
  }
  /** PlaySoundWaitForCurrent: WaitForSoundToFinish, then PlaySound */
  *playSoundWaitForCurrent(name: string): Co {
    yield* this.e.waitForSoundToFinish();
    this.playSound(name);
  }
  /** PlaySound + WaitForSoundToFinish */
  *playSoundAndWait(name: string): Co {
    this.playSound(name);
    yield* this.e.waitForSoundToFinish();
  }

  // ---------------------------------------------------------------- items / party
  giveItem(item: string, qty = 1): boolean {
    try {
      this.e.store.dispatch({ type: 'giveItem', item: c('item', item), qty }, { undoable: false });
      return true;
    } catch {
      return false;
    }
  }
  isItemInBag(item: string): boolean {
    return this.e.state.bag.some((s) => s.item === c('item', item) && s.qty > 0);
  }
  removeItem(item: string, qty = 1): void {
    this.e.store.dispatch({ type: 'takeItem', item: c('item', item), qty }, { undoable: false });
  }
  /** Number of owned Pokédex entries (CountSetBits over wPokedexOwned). */
  pokedexOwnedCount(): number {
    let n = 0;
    for (let i = 0; i < 151; i++) if (getBit(this.e.state.pokedex.owned, i)) n++;
    return n;
  }
  /**
   * AddPartyMon for the player's party: rolls DVs with two Random calls,
   * registers the Pokédex, and (when `askName`) offers a nickname.
   */
  *addPartyMon(speciesName: string | number, level: number, askName = true): Co<boolean> {
    const st = this.e.state;
    if (st.party.length >= 6) return false;
    const idx = typeof speciesName === 'number' ? speciesName : c('pokemon', speciesName);
    const b = this.e.random();
    const a = this.e.random();
    const mon = makePartyMon(this.e.bundle, {
      species: idx,
      level,
      dvs: (a << 8) | b,
      otId: st.player.id,
      otName: st.player.name,
    });
    const dex = this.e.bundle.dexOrder[idx];
    this.e.store.dispatch({ type: 'setPokedex', dex, seen: true, owned: true }, { undoable: false });
    if (askName) {
      this.getMonName(idx);
      yield* this.e.printText('DoYouWantToNicknameText');
      const yes = yield* this.yesNoChoice();
      if (yes) {
        const name = yield* namingScreen(this.e, 'mon', mon.nickname);
        if (name) mon.nickname = name;
      }
    }
    this.e.store.dispatch({ type: 'addPartyMon', mon }, { undoable: false });
    return true;
  }
  /**
   * GivePokemon (_GivePokemon): into the party with the nickname prompt, or into the
   * current PC box when the party is full ("was transferred to BILL's PC"). False when
   * the box is full too.
   */
  *givePokemon(speciesName: string | number, level: number): Co<boolean> {
    this.enableAutoTextBoxDrawing();
    const e = this.e;
    const st = e.state;
    const idx = typeof speciesName === 'number' ? speciesName : c('pokemon', speciesName);
    if (st.party.length < 6) {
      yield* this.addPartyMon(idx, level, true);
      this.doNotWaitForButtonPress = true;
      return true;
    }
    if ((st.boxes[st.currentBox]?.length ?? 0) >= 20) {
      yield* e.printText('BoxIsFullText');
      return false;
    }
    // LoadEnemyMonData rolls the DVs
    const b = e.random();
    const a = e.random();
    const mon = makePartyMon(e.bundle, { species: idx, level, dvs: (a << 8) | b, otId: st.player.id, otName: st.player.name });
    e.store.dispatch({ type: 'setPokedex', dex: e.bundle.dexOrder[idx], seen: true, owned: true }, { undoable: false });
    this.getMonName(idx);
    yield* e.printText('DoYouWantToNicknameText');
    if (yield* this.yesNoChoice()) {
      const name = yield* namingScreen(e, 'mon', mon.nickname);
      if (name) mon.nickname = name;
    }
    e.store.dispatch({ type: 'addBoxMon', mon }, { undoable: false });
    e.ram.nameBuffer = String(st.currentBox + 1); // wStringBuffer = the box number
    yield* e.printText('SentToBoxText');
    return true;
  }
  /** Overwrite a party member's catch rate byte (the starter Pikachu marker). */
  setPartyCatchRate(i: number, v: number): void {
    const party = structuredClone(this.e.state.party);
    party[i].catchRate = v;
    this.e.store.dispatch({ type: 'setParty', party }, { undoable: false });
  }
  /** Set hWarpDestinationMap / wDestinationWarpID (and optionally wLastMap) and BIT_WARP_FROM_CUR_SCRIPT. */
  warpFromCurScript(map: string, warpId: number, lastMap?: string): void {
    const r = this.e.ram;
    r.warpDestinationMap = c('map', map);
    r.destinationWarpId = warpId;
    if (lastMap) this.e.store.dispatch({ type: 'setLastMap', map: c('map', lastMap) }, { undoable: false });
    r.warpFromScript = true;
  }
  healParty(): void {
    const party = structuredClone(this.e.state.party);
    for (const m of party) healMon(this.e.bundle, m);
    this.e.store.dispatch({ type: 'setParty', party }, { undoable: false });
  }

  // ---------------------------------------------------------------- battles
  /** Set wCurOpponent (OPP_* or species), wTrainerNo and the end-of-battle texts. */
  startTrainerBattle(opp: string, trainerNo: number, winText?: string, loseText?: string): void {
    this.e.startTrainerBattle(c('opp', opp), trainerNo);
    this.e.ram.endBattleWinText = winText;
    this.e.ram.endBattleLoseText = loseText;
    this.e.ram.talkedToTrainer = true;
    this.e.ram.printEndBattleText = true;
  }
  startWildBattle(speciesName: string, level: number, battleType = 'BATTLE_TYPE_NORMAL'): void {
    this.e.ram.curOpponent = c('pokemon', speciesName);
    this.e.ram.curEnemyLevel = level;
    this.e.ram.battleType = c('battle', battleType);
  }
  /** wBattleResult: 0 = won */
  get battleResult(): number {
    return this.e.ram.battleResult;
  }
  set noBattles(v: boolean) {
    this.e.ram.noBattles = v;
  }

  // ---------------------------------------------------------------- Pikachu
  enablePikachuOverworldSpriteDrawing(): void {
    this.e.setPikachuDrawing(true);
  }
  disablePikachuOverworldSpriteDrawing(): void {
    this.e.setPikachuDrawing(false);
  }

  // ---------------------------------------------------------------- misc
  /** Encode a string for name buffers. */
  encode(s: string): number[] {
    return encodePlain(s);
  }
  readonly PAD = { A: PAD_A, B: PAD_B, UP: PAD_UP, DOWN: PAD_DOWN };
}
