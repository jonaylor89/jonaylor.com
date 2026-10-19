/**
 * The game engine: a port of the overworld control flow (home/overworld.asm)
 * written as one coroutine. Every `yield` is one DelayFrame, so blocking
 * routines (text boxes, delays, battles, fades) nest exactly where the
 * original calls them — including inside map scripts.
 */
import { SoundEngine } from '../audio/soundEngine';
import { persistCheckpoint } from '../ui/startMenu';
import { safariZoneCheck, safariZoneCheckSteps } from './safari';
import { NEXT_SPIN } from '../scripts/spinners';
import { markTownVisited } from '../ui/townMap';
import { enterMapAnim, handleFlyWarpOrDungeonWarp, leaveMapAnim, standingOnWarpPadOrHole } from '../field/warpAnims';
import { doBoulderDustAnimation, setStrengthActive, tryPushingBoulder } from '../field/strength';
import { registerFieldSystems } from '../field';
import { isNextTileShoreOrWater, stopSurfing } from '../field/surf';
import { isSurfingPikachuInParty } from '../game/pikachu';
import { applyOutOfBattlePoisonDamage } from './poison';
import type { GameBundle, MapTextEntry, TextOp } from '../data/schema';
import type { GameState, Store } from '../game/state';
import { getBit } from '../game/state';
import { applyMods, type GameMods } from '../game/mods';
import type { Button, InputFrame } from '../input/Input';
import { c, CONSTANTS, constName } from '../rom/constants';
import { WorldMap } from '../world/WorldMap';
import {
  DIR_VEC,
  extraWarpCheck,
  isOutsideMap,
  standingOnDoorOrWarpTile,
  standingOnDoorTile,
  tilePairBlocked,
  type Facing,
} from '../world/movement';
import { GbRandom } from './rng';
import { tryDoWildEncounter } from '../battle/wild';
import {
  doScriptedNpcMovement,
  FACING_DOWN,
  FACING_LEFT,
  FACING_RIGHT,
  FACING_UP,
  facingName,
  newSprite,
  spriteSquares,
  updateNpcSprite,
  STAY,
  NONE,
  type ScriptedMovement,
  type Sprite,
  type SpriteHost,
  type SyncedMovement,
  extraSheetId,
} from './sprites';
import { TileScreen } from '../ui/TileScreen';
import { LETTER_DELAY, TextPrinter, type TextContext, type Wait } from '../ui/TextPrinter';
import type { MapScript, ScriptRegistry } from '../scripts/types';
import { ScriptEnv } from './ScriptEnv';
import { NPC_MOVEMENT_SCRIPTS } from './autoMovement';
import type { BattleHost, BattleRequest, BattleResult } from './battle';
import { talkToTrainer, trainerMapScript } from './trainers';
import { startMenu } from '../ui/startMenu';

/** One emulated frame of a coroutine. */
export type Co<T = void> = Generator<void, T, void>;

export * from './pad';
import { checkForHiddenEventOrBookshelfOrCardKeyDoor } from './hiddenEvents';
import { runAsmProgram } from './asmProgram';
import { PikachuFollower, PIKA_HIDDEN, PIKA_NO_DRAWING, PIKA_NOT_FOLLOWING } from './pikachu';
import { talkToPikachu } from './pikachuEmotions';
import { inputToPad, PAD_A, PAD_B, PAD_SELECT, PAD_START, PAD_RIGHT, PAD_LEFT, PAD_UP, PAD_DOWN, PAD_CTRL_PAD, PAD_BUTTONS, PLAYER_DIR_RIGHT, PLAYER_DIR_LEFT, PLAYER_DIR_DOWN, PLAYER_DIR_UP } from './pad';

const DIR_FACING: Record<number, number> = {
  [PLAYER_DIR_RIGHT]: FACING_RIGHT,
  [PLAYER_DIR_LEFT]: FACING_LEFT,
  [PLAYER_DIR_DOWN]: FACING_DOWN,
  [PLAYER_DIR_UP]: FACING_UP,
};
const DIR_NAME: Record<number, Facing> = {
  [PLAYER_DIR_RIGHT]: 'right',
  [PLAYER_DIR_LEFT]: 'left',
  [PLAYER_DIR_DOWN]: 'down',
  [PLAYER_DIR_UP]: 'up',
};
const FACING_TO_DIR: Record<Facing, number> = {
  right: PLAYER_DIR_RIGHT,
  left: PLAYER_DIR_LEFT,
  down: PLAYER_DIR_DOWN,
  up: PLAYER_DIR_UP,
};


/** Non-persistent working RAM (WRAM/HRAM variables that are not part of the save). */
export class Ram {
  walkCounter = 0;
  playerDirection = PLAYER_DIR_DOWN;
  playerMovingDirection = 0;
  playerLastStopDirection = 0;
  checkFor180DegreeTurn = 1;
  turning = false;
  joyIgnore = 0;
  joyHeld = 0;
  joyPressed = 0;
  /** hJoyLast: the buttons held at the previous Joypad call */
  joyLast = 0;
  /** wSimulatedJoypadStatesEnd (consumed from the end) and wSimulatedJoypadStatesIndex. */
  simulatedJoypad: number[] = [];
  simulatedIndex = 0;
  overrideSimulatedMask = 0;
  /** wStatusFlags5 BIT_SCRIPTED_MOVEMENT_STATE */
  scriptedMovementState = false;
  /** wMovementFlags */
  standingOnWarp = false;
  standingOnDoor = false;
  exitingDoor = false;
  ledgeOrFishing = false;
  jumpIndex = 0;
  /** NPC movement script tables (wNPCMovementScriptPointerTableNum, ...FunctionNum, ...SpriteOffset). */
  npcMovementScriptTable = 0;
  npcMovementScriptFunction = 0;
  npcMovementScriptSprite = 0;
  synced: SyncedMovement = { directions: [], index: 0, walkCounter: 8, initialized: false };
  /** wNPCMovementDirections2 / Index, scratch for pathfinding and RLE lists. */
  npcMovementDirections2: number[] = [];
  npcMovementDirections2Index = 0;
  numStepsToTake = 0;
  /** Battle request (wCurOpponent etc.). */
  curOpponent = 0;
  trainerNo = 0;
  battleType = 0;
  curEnemyLevel = 0;
  /** wBattleResult: 0 win, 1 lose, 2 draw. */
  battleResult = 0;
  isInBattle = 0;
  endBattleWinText?: string;
  endBattleLoseText?: string;
  talkedToTrainer = false;
  printEndBattleText = false;
  noBattles = false;
  /** Text control. */
  doNotWaitForButtonPress = 0;
  autoTextBoxControl = 0;
  fontLoaded = false;
  noNpcFacePlayer = false;
  /** wStatusFlags3 BIT_WARP_FROM_CUR_SCRIPT and destination. */
  warpFromScript = false;
  destinationWarpId = 0;
  warpDestinationMap = 0;
  /** wCurrentMapScriptFlags BIT_CUR_MAP_LOADED_1/2 */
  curMapLoaded1 = false;
  curMapLoaded2 = false;
  /** Music the engine wants (consumed by the audio module). */
  music = 0;
  noMapMusic = false;
  /** wStatusFlags4 BIT_BATTLE_OVER_OR_BLACKOUT */
  battleOverOrBlackout = false;
  /** Emotion bubble currently shown above a sprite slot. */
  emotionBubble?: { slot: number; bubble: number };
  /** Named object for {ram:wNameBuffer}-style text (wNamedObjectIndex → wcd6d). */
  nameBuffer = '';
  /** wTilePlayerStandingOn */
  tilePlayerStandingOn = 0;
  /** Map text pointer table override (OaksLab_TextPointers2 etc.). */
  textPointerOverride?: string;
  /** wBattleAndStartSavedMenuItem */
  startMenuItem = 0;
  /** Trainer engine (wSpriteIndex, wEngagedTrainerClass/Set, wMiscFlags BIT_SEEN_BY_TRAINER, ...). */
  spriteIndex = 0;
  engagedTrainerClass = 0;
  engagedTrainerSet = 0;
  engagedHeader = -1;
  seenByTrainer = false;
  trainerBattle = false;
  gymLeaderNo = 0;
  /** Address-keyed scratch values read by text_decimal/text_ram (HRAM counters etc.). */
  mem = new Map<number, number | string>();
  /** wMenuCursorLocation / wTileBehindCursor (PlaceMenuCursor). */
  menuCursorLoc?: [number, number];
  tileBehindCursor = 0x7f;
  /** wListScrollOffset */
  listScrollOffset = 0;
  /** wBagSavedMenuItem (outside battle) and wPartyAndBillsPCSavedMenuItem. */
  bagSavedMenuItem = 0;
  partySavedMenuItem = 0;
  /** wStatusFlags6 BIT_ALWAYS_ON_BIKE */
  alwaysOnBike = false;
  /** wLowHealthAlarm */
  lowHealthAlarm = 0;
  /** wStatusFlags2 BIT_WILD_ENCOUNTER_COOLDOWN */
  wildEncounterCooldown = false;
  /** The mon using Softboiled from the field-move menu (wPseudoItemID path). */
  softboiledUser = 0;
  /** wStatusFlags5 BIT_NO_TEXT_DELAY */
  noTextDelay = false;
  /** wCardKeyDoorX/Y (blocks) of the door the Card Key just opened */
  cardKeyDoor?: { x: number; y: number };
  /** wCurrentMenuItem after a YES/NO in compiled text_asm (0 = YES) */
  currentMenuItem = 0;
  /** wPikachuMapScriptFlags BIT_PIKACHU_MAP_SCRIPT_ACTIVE */
  pikachuMapScriptActive = false;
  /** wHiddenEventFunctionArgument / wHiddenItemOrCoinsIndex / hBackupGymGateIndex */
  hiddenEventArg = 0;
  hiddenItemIndex = 0;
  backupGymGateIndex = 0;
  /** wd474 bit 7: a wrong Cinnabar Gym quiz answer calls a trainer */
  cinnabarQuizWrong = false;
  /** wStatusFlags3 BIT_INIT_TRADE_CENTER_FACING */
  initTradeCenterFacing = false;
  /** wDexRatingText: the rating text DisplayDexRating picked for the Hall of Fame */
  dexRatingText = '';
  /** wTrainerHeaderFlagBit (Cinnabar Gym's quiz trainers) */
  trainerHeaderFlagBit = 0;
  /** wBoughtOrSoldItemInMart */
  boughtOrSoldItemInMart = false;
  /** wd435: the player pressed A facing Pikachu */
  talkingToPikachu = false;
  /** wExpressionNumber: the last Pikachu emotion played */
  expressionNumber = 0;
  /** wPikachuSpawnStateFlags BIT_PIKACHU_SPAWN_FOLLOWING */
  pikachuSpawnFollowing = false;
  /** wPikachuCollisionCounter: frames the player bumps into Pikachu after turning toward it */
  pikachuCollisionCounter = 0;
  /** wPikachuOverworldStateFlags / wPikachuEmotionModifier */
  pikachuOverworldStateFlags = 0;
  pikachuEmotionModifier = 0;
  /** BIT_FLY_WARP + BIT_ESCAPE_WARP set by Escape Rope / Dig / Teleport: warp to wLastBlackoutMap. */
  /** wStatusFlags6 BIT_FLY_WARP / BIT_DUNGEON_WARP / BIT_ESCAPE_WARP, wStatusFlags7 BIT_USED_FLY */
  flyWarp = false;
  dungeonWarp = false;
  escapeWarp = false;
  usedFly = false;
  /** wDestinationMap (Fly) */
  destinationMap = 0;
  /** wStatusFlags3 BIT_ON_DUNGEON_WARP, wWhichDungeonWarp, wDungeonWarpDestinationMap */
  onDungeonWarp = false;
  whichDungeonWarp = 0;
  dungeonWarpDestinationMap = 0;
  /**
   * Leave/EnterMapAnim's override of the player sprite: screen y/x (normally $3c/$40),
   * the spin facing, the bird (wings flapping), the hole's half/fully hidden sprite.
   */
  playerAnim?: { y: number; x: number; facing: Facing; bird?: boolean; flap?: boolean; hidden?: boolean; halfHidden?: boolean };
  /** wMapPalOffset (dark caves until Flash) and BIT_STRENGTH_ACTIVE */
  mapPalOffset = 0;
  /** wMiscFlags BIT_BOULDER_DUST / BIT_TRIED_PUSH_BOULDER / BIT_PUSHED_BOULDER, and wBoulderSpriteIndex */
  boulderDust = false;
  triedPushBoulder = false;
  pushedBoulder = false;
  boulderSpriteIndex = 0;
  /** An OAM field animation drawn over the world: Cut's tree/leaves, boulder dust. */
  fieldEffect?: { kind: 'cutTree' | 'cutGrass' | 'dust'; x: number; y: number; t: number; frames: number };
  /** Debug: no random wild encounters (DetermineWildOpponent's debug-mode B button). */
  debugNoWildEncounters = false;
  /** The rod hooked the opponent (wMoveMissed set before the battle). */
  fishingBattle = false;
  /** wRepelRemainingSteps */
  repelRemainingSteps = 0;
  /** wNumberOfNoRandomBattleStepsLeft */
  noRandomBattleSteps = 0;
  /** wStepCounter: decremented each step, cleared on map entry */
  stepCounter = 0;
  /** wSlotMachineAllowMatchesCounter */
  slotsAllowMatchesCounter = 0;
  /** wMovementFlags BIT_SPINNING (arrow tiles) */
  spinning = false;
  /** LoadSpinnerArrowTiles' last copy: true = SpinnerArrowAnimTiles, false = the tileset's own (undefined until a spin) */
  spinnerArrowsAnimated?: boolean;
  /** wStatusFlags7 BIT_FORCED_WARP (Seafoam's currents carry the player through edge warps) */
  forcedWarp = false;
  /** wWarpedFromWhichWarp / wWarpedFromWhichMap (elevators send the player back through them) */
  warpedFromWhichWarp = 0;
  warpedFromWhichMap = 0;
  /** hSCY offset of the overworld (ShakeElevator), in pixels */
  shakeY = 0;
  /** wCurrentMapScriptFlags BIT_CUR_MAP_USED_ELEVATOR */
  usedElevator = false;
  /** A map region drawn from a snapshot and slid by `dx` pixels (VermilionDockSSAnneLeavesScript). */
  slide?: { world: import('../world/WorldMap').WorldMap; region: [number, number, number, number]; dx: number; puffs: { x: number; y: number }[] };
  /** FishingAnim in progress: the fishing pose, the rod sprite, and the bite shake (0/1 px). */
  fishing?: { rod: boolean; shake: number };
}

export interface EngineHooks {
  fade?(amount: number, color?: 'black' | 'white'): void;
  /** A raw rBGP value in place of the fade's (undefined: back to the fade/LoadGBPal palette) */
  bgp?(value: number | undefined): void;
  /** RunPaletteCommand for the UI layer: an SGB palette id, or undefined for the map's own. */
  palette?(pal: number | undefined): void;
  /** An SGB PAL_SET + ATTR_BLK layout for the UI layer (palette ids; rectangles in tiles, applied in order). */
  paletteLayout?(pals: number[], blocks: { pal: number; x0: number; y0: number; x1: number; y1: number }[]): void;
  playSound?(name: string | number): void;
  /** Pokémon cry (PlayCry) by species index. */
  playCry?(species: number): void;
  /** Pikachu's PCM cries (PlayPikachuSoundClip) by clip number. */
  playPikachuCry?(clip: number): void;
  /** A move animation started (id = move or *_ANIM, turn = hWhoseTurn); the 3D stage may show it. */
  battleAnimation?(id: number, turn: number): void;
  /** Battle started/ended (the 3D view hides the overworld). */
  battleState?(active: boolean): void;
  /** Battle transition completed: the 3D stage and compact GB panel may be shown. */
  battleScene?(active: boolean): void;
  playMusic?(id: number): void;
  /** Whether a song is still playing (scripts that wait for a song to end, e.g. Jigglypuff). */
  isMusicPlaying?(): boolean;
  /** One frame's sound-register writes (and timed writes, offsets in CPU cycles) for the APU. */
  audioFrame?(writes: [number, number][], timed?: [number, number, number][]): void;
  /** Init (a soft reset): back to the title screen. */
  reset?(): void;
  onMapChanged?(world: WorldMap): void;
  /** New Game: let the player choose web mods before Oak's speech (none: the original game). */
  chooseMods?(): Promise<GameMods | undefined>;
  /** A ported routine was missing (text_asm/map script); shown in the debug overlay. */
  unported?(what: string): void;
}

export class Engine implements SpriteHost {
  world!: WorldMap;
  sprites: Sprite[] = [];
  ram = new Ram();
  /** The Pikachu that follows the player (sprite slot 15). */
  readonly pikachu: PikachuFollower;
  rng: GbRandom;
  input?: InputFrame;
  readonly screen: TileScreen;
  readonly scripted: ScriptedMovement;
  private main?: Co;
  private frameCount = 0;
  /** Debug-only frame gating; never serialized into a save. */
  debugPaused = false;
  traceEnabled = false;
  readonly debugTrace: { frame: number; kind: string; label: string }[] = [];
  private debugFrames = 0;
  private debugButtons: Button[] = [];
  private debugPressed = false;
  private debugUntilScript?: string;
  trace(kind: string, label: string): void {
    if (!this.traceEnabled) return;
    const last = this.debugTrace.at(-1);
    if (last?.kind === kind && last.label === label) return;
    this.debugTrace.push({ frame: this.state.frames, kind, label });
    if (this.debugTrace.length > 200) this.debugTrace.shift();
  }
  stepFrames(frames = 1, buttons: Button[] = []): void {
    this.debugPaused = true;
    this.debugButtons = [...buttons]; this.debugPressed = true;
    this.debugFrames = Math.max(1, Math.min(600, Math.floor(frames) || 1));
    this.debugUntilScript = undefined;
  }
  stepScript(buttons: Button[] = []): void {
    this.stepFrames(600, buttons);
    this.debugUntilScript = `${this.state.player.map}:${this.world ? this.curScript : 0}`;
  }
  readonly env: ScriptEnv;

  /** The ROM data; `bundle` is it with the save's mods applied. */
  readonly baseBundle: GameBundle;
  private moddedBundle: GameBundle;
  private modsKey = -1;
  get bundle(): GameBundle {
    const seed = this.store.state.mods?.randomizer?.seed ?? -1;
    if (seed !== this.modsKey) {
      this.modsKey = seed;
      this.moddedBundle = applyMods(this.baseBundle, this.store.state.mods);
    }
    return this.moddedBundle;
  }
  /** The save's Comfort mod. */
  get comfort(): boolean {
    return !!this.store.state.mods?.comfort;
  }

  constructor(
    bundle: GameBundle,
    readonly store: Store,
    uiRoot: HTMLElement | TileScreen | null,
    readonly scripts: ScriptRegistry,
    readonly battleHost: BattleHost,
    readonly hooks: EngineHooks = {},
  ) {
    this.baseBundle = this.moddedBundle = bundle;
    this.screen = uiRoot instanceof TileScreen ? uiRoot : new TileScreen(uiRoot ?? null, bundle);
    this.rng = new GbRandom(store.state.rng);
    this.scripted = {
      directions: [],
      numSteps: 0,
      active: false,
      onEnd: () => {
        // end of wNPCMovementDirections: also clears simulated joypad (UpdateNPCSprite)
        this.ram.simulatedIndex = 0;
      },
    };
    this.env = new ScriptEnv(this);
    this.pikachu = new PikachuFollower(this);
    this.sound = new SoundEngine(bundle.audio);
    // the game's sound calls go to the sound engine
    hooks.playSound = (id) => this.playSfx(id);
    hooks.playCry = (species) => this.sound.playCry(species);
    hooks.playMusic = (id) => this.playMusicId(id);
    hooks.isMusicPlaying = () => !!this.sound.soundId(0);
    registerFieldSystems(this);
  }

  // ------------------------------------------------------------ sound
  readonly sound: SoundEngine;
  /** Frames the sound engine is held (interrupts off while a Pikachu PCM cry plays) */
  audioSuspend = 0;
  private timedAudio: [number, number, number][] = [];
  private pendingDefaultMusic: boolean | undefined;
  private warnedSounds = new Set<string>();

  /** PlaySound by name ('go_inside', 'SFX_DENIED', 'cry:PIKACHU', …) or id. */
  playSfx(id: string | number): void {
    if (typeof id === 'number') return this.sound.playSound(id);
    if (id.startsWith('cry:')) {
      this.sound.playCry(c('pokemon', id.slice(4)));
      return;
    }
    if (id === 'MUSIC_POKE_FLUTE_IN_BATTLE') return this.pokeFluteInBattle();
    const v = sfxByName(id);
    if (v !== undefined) return this.sound.playSound(v);
    if (!this.warnedSounds.has(id)) {
      this.warnedSounds.add(id);
      this.hooks.unported?.(`sound ${id}`);
    }
  }

  /** Music_PokeFluteInBattle: the caught-mon jingle's channels pointed at the flute's */
  private pokeFluteInBattle(): void {
    this.sound.playSound(c('music', 'SFX_CAUGHT_MON'));
    this.sound.overwriteChannelPointer(4, 'SFX_Pokeflute_Ch5');
    this.sound.overwriteChannelPointer(5, 'SFX_Pokeflute_Ch6');
    this.sound.overwriteChannelPointer(6, 'SFX_Pokeflute_Ch7');
  }

  /** PlayMusic for a MUSIC_* id (0 stops) */
  private playMusicId(id: number): void {
    if (!id) return this.sound.stopAllMusic();
    const name = constName('music', id, (n) => n.startsWith('MUSIC_'));
    const bank = name ? this.bundle.audio.musicBanks[name] : undefined;
    if (bank === undefined) return this.sound.playSound(id);
    this.sound.playMusic(id, bank);
  }

  /** WaitForSoundToFinish */
  *waitForSoundToFinish(): Co {
    while (this.sound.sfxPlaying) yield;
  }

  /** VBlank's sound work and the hand-off to the APU */
  private soundFrame(): void {
    const snd = this.sound;
    snd.lowHealthAlarm = this.ram.lowHealthAlarm;
    snd.soundOption = this.state.options.sound ?? 0;
    if (this.audioSuspend > 0) this.audioSuspend--;
    else snd.frame();
    this.ram.lowHealthAlarm = snd.lowHealthAlarm;
    if (this.pendingDefaultMusic !== undefined && !snd.sfxPlaying) {
      const fade = this.pendingDefaultMusic;
      this.pendingDefaultMusic = undefined;
      this.playDefaultMusicNow(fade);
    }
    const writes = snd.takeWrites();
    const timed = this.timedAudio;
    this.timedAudio = [];
    this.hooks.audioFrame?.(writes, timed.length ? timed : undefined);
  }

  /** Queue register writes at cycle offsets from the start of the next frame (the Pikachu PCM). */
  timedSoundWrites(writes: [number, number, number][]): void {
    this.timedAudio.push(...writes);
  }

  // ------------------------------------------------------------ frame driver
  start(): void {
    this.main = this.mainLoop();
  }

  /** Advance the game by one Game Boy frame. */
  frame(input: InputFrame): boolean {
    if (this.debugPaused && !this.debugFrames) return false;
    if (this.debugFrames) this.debugFrames--;
    this.input = this.debugPaused ? { held: new Set(this.debugButtons), pressed: new Set(this.debugPressed ? this.debugButtons : []) } : input;
    this.debugPressed = false;
    this.rng.frames(1);
    this.rng.random(); // VBlank calls Random every frame
    this.frameCount++;
    this.store.state.frames++;
    if (!this.main) this.start();
    const r = this.main!.next();
    if (r.done) throw new Error('main loop exited');
    this.soundFrame();
    this.screen.draw();
    if (this.debugUntilScript && `${this.state.player.map}:${this.world ? this.curScript : 0}` !== this.debugUntilScript) {
      this.debugFrames = 0; this.debugUntilScript = undefined;
    }
    return true;
  }

  /** Cancel the old coroutine, including movie/battle finally blocks, before a debug restart. */
  private cancelScene(): void {
    this.main?.return();
    this.hooks.battleScene?.(false); this.hooks.battleState?.(false);
    this.screen.setPpu(undefined); this.screen.setObjects([]); this.screen.clearGlyphOverrides();
    this.screen.setShadeMap(undefined); this.screen.setLineScroll(undefined); this.screen.setScroll(0, 0);
    this.screen.backdrop = false; this.screen.clear();
    this.hooks.fade?.(0); this.hooks.palette?.(undefined);
    this.debugFrames = 0; this.debugUntilScript = undefined;
    this.audioSuspend = 0; this.timedAudio = []; this.pendingDefaultMusic = undefined;
    this.stopAllMusic();
  }

  /** Debug: jump to a map/position and restart the overworld loop there. */
  teleport(map: number, x: number, y: number): void {
    if (!this.bundle.maps[map]) throw new Error(`unknown map ${map}`);
    this.cancelScene();
    const lastMap = map < c('map', 'FIRST_INDOOR_MAP') ? map : this.state.player.lastMap;
    this.store.dispatch({ type: 'setPosition', map, x, y, lastMap });
    this.ram = new Ram();
    this.scripted.active = false;
    this.main = this.mainLoop();
  }

  /** Restart from the current state (after loading a save or undo). */
  reload(): void {
    this.cancelScene();
    this.rng = new GbRandom(this.store.state.rng);
    this.ram = new Ram();
    this.scripted.active = false;
    this.main = this.mainLoop();
  }

  /** Runs once before the overworld starts (the intro, title screen and main menu). */
  boot: ((e: Engine) => Co) | undefined;

  /** Take over a whole new game state (a loaded save or a new game) from inside a coroutine. */
  adoptState(state: GameState): void {
    this.store.dispatch({ type: 'replaceState', state }, { undoable: false });
    this.rng = new GbRandom(this.store.state.rng);
  }

  private *mainLoop(): Co {
    if (this.boot) {
      const boot = this.boot;
      this.boot = undefined;
      yield* boot(this);
    }
    yield* this.enterMap();
    yield* this.overworldLoop();
  }

  get state() {
    return this.store.state;
  }

  // ------------------------------------------------------------ RNG / host
  random(): number {
    return this.rng.random();
  }
  hRandomAdd(): number {
    return this.rng.hRandomAdd;
  }
  playerX(): number {
    return this.state.player.x;
  }
  playerY(): number {
    return this.state.player.y;
  }
  playerWalking(): boolean {
    return this.ram.walkCounter !== 0;
  }
  playerDirectionFacing(): number {
    // MakeNPCFacePlayer: face opposite to the player's direction.
    switch (this.ram.playerDirection) {
      case PLAYER_DIR_UP:
        return FACING_DOWN;
      case PLAYER_DIR_DOWN:
        return FACING_UP;
      case PLAYER_DIR_LEFT:
        return FACING_RIGHT;
      default:
        return FACING_LEFT;
    }
  }
  fontLoaded(): boolean {
    return this.ram.fontLoaded;
  }
  noNpcFacePlayer(): boolean {
    return this.ram.noNpcFacePlayer;
  }
  isTilePassable(x: number, y: number): boolean {
    return this.world.isSquarePassable(x, y);
  }
  occupiedByOther(self: Sprite, x: number, y: number): boolean {
    for (const s of this.sprites) {
      if (!s || s === self || !s.pictureId || s.hidden || (s.offscreen && s.slot !== 0)) continue;
      if (s.slot === 0) {
        const p = this.state.player;
        if (p.x === x && p.y === y) return true;
        if (this.ram.walkCounter) {
          const [dx, dy] = DIR_VEC[p.facing];
          if (p.x + dx === x && p.y + dy === y) return true;
        }
        continue;
      }
      if (spriteSquares(s).some(([sx, sy]) => sx === x && sy === y)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ events / vars
  event(name: string): boolean {
    return getBit(this.state.eventFlags, c('event', name));
  }
  setEvent(name: string, v = true): void {
    this.store.dispatch({ type: 'setEvent', flag: c('event', name), value: v }, { undoable: false });
  }
  get curScript(): number {
    return this.state.mapScripts[this.world.data.id] ?? 0;
  }
  set curScript(n: number) {
    this.store.dispatch({ type: 'setMapScript', map: this.world.data.id, script: n }, { undoable: false });
  }
  mapScriptOf(mapConst: string): number {
    return this.state.mapScripts[c('map', mapConst)] ?? 0;
  }
  setMapScriptOf(mapConst: string, n: number): void {
    this.store.dispatch({ type: 'setMapScript', map: c('map', mapConst), script: n }, { undoable: false });
  }

  // ------------------------------------------------------------ objects
  toggleIndex(name: string): number {
    return c('toggle', name);
  }
  /** ShowObject / HideObject (engine/overworld/toggleable_objects.asm). */
  setObjectVisible(toggleName: string | number, visible: boolean): void {
    const idx = typeof toggleName === 'number' ? toggleName : this.toggleIndex(toggleName);
    this.store.dispatch({ type: 'setObjectVisible', toggle: idx, visible }, { undoable: false });
    const t = this.bundle.toggleableObjects[idx];
    if (t.map === this.world.data.id) {
      const s = this.sprites[t.object];
      if (s) {
        s.hidden = !visible;
        if (visible) s.movementStatus = s.movementStatus || 0;
      }
    }
  }

  isObjectHidden(mapId: number, index: number): boolean {
    const toggles = this.bundle.toggleableObjects;
    for (let i = 0; i < toggles.length; i++)
      if (toggles[i].map === mapId && toggles[i].object === index) return !this.state.objectVisible[i];
    return false;
  }

  // ------------------------------------------------------------ joypad
  /** Joypad: read buttons and apply wJoyIgnore. */
  /** Joypad: hJoyPressed is what is held now but wasn't at the previous poll (hJoyLast). */
  joypad(): void {
    const ignore = this.ram.joyIgnore;
    const input = inputToPad(this.input, 'held');
    const pressed = input & ~this.ram.joyLast;
    this.ram.joyLast = input;
    this.ram.joyHeld = input & ~ignore & 0xff;
    this.ram.joyPressed = pressed & ~ignore & 0xff;
  }

  /** JoypadOverworld: RunMapScript, Joypad, ForceBikeDown, AreInputsSimulated. */
  private *joypadOverworld(): Co {
    yield* this.runMapScript();
    this.joypad();
    // ForceBikeDown: on Cycling Road the bike rolls down unless a button is held or a trainer saw you
    if (!this.ram.trainerBattle && this.world.data.id === c('map', 'ROUTE_17') && !(this.ram.joyHeld & (PAD_CTRL_PAD | PAD_A | PAD_B))) {
      this.ram.joyHeld = PAD_DOWN;
    }
    this.areInputsSimulated();
  }

  private areInputsSimulated(): void {
    const r = this.ram;
    if (!r.scriptedMovementState) return;
    if (r.joyHeld & r.overrideSimulatedMask) return;
    r.simulatedIndex = (r.simulatedIndex - 1) & 0xff;
    if (r.simulatedIndex !== 0xff) {
      const a = r.simulatedJoypad[r.simulatedIndex] ?? 0;
      r.joyHeld = a;
      if (!a) r.joyPressed = 0;
      return;
    }
    // done simulating
    r.simulatedIndex = 0;
    r.simulatedJoypad[0] = 0; // only wSimulatedJoypadStatesEnd itself is cleared
    r.joyIgnore = 0;
    r.joyHeld = 0;
    r.standingOnDoor = false;
    r.exitingDoor = false;
    r.scriptedMovementState = false;
  }

  startSimulatingJoypadStates(): void {
    this.ram.overrideSimulatedMask = 0;
    this.sprites[0].movementByte1 = 0;
    this.ram.scriptedMovementState = true;
  }

  /** Not zero while an NPC movement script runs, the player steps out of a door, or input is simulated. */
  isPlayerCharacterBeingControlledByGame(): boolean {
    return this.ram.npcMovementScriptTable !== 0 || this.ram.exitingDoor || this.ram.scriptedMovementState;
  }

  // ------------------------------------------------------------ map loading
  /** EnterMap: LoadMapData + map entry bookkeeping. */
  *enterMap(afterBattle = false): Co {
    this.ram.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
    this.loadMapData(afterBattle);
    this.ram.battleOverOrBlackout = false;
    // ClearVariablesOnEnterMap
    this.ram.gymLeaderNo = 0;
    this.ram.cardKeyDoor = undefined;
    this.ram.stepCounter = 0;
    if (this.ram.wildEncounterCooldown) this.ram.noRandomBattleSteps = 3;
    if (!afterBattle) setStrengthActive(this, false); // ResetUsingStrengthOutOfBattleBit
    if (this.ram.flyWarp || this.ram.dungeonWarp) {
      yield* enterMapAnim(this);
      this.updateSprites();
      this.ram.flyWarp = false;
      this.ram.noBattles = false;
    } else yield* this.fadeIn(afterBattle);
    this.checkForceBikeOrSurf();
    this.ram.dungeonWarp = false;
    this.updateSprites();
    this.ram.curMapLoaded1 = true;
    this.ram.curMapLoaded2 = true;
    this.ram.joyIgnore = 0;
  }

  /** LoadMapData: header, sprites, music; keeps the player position from the warp. */
  loadMapData(afterBattle = false): void {
    const id = this.state.player.map;
    this.world = new WorldMap(this.bundle, id);
    this.ram.textPointerOverride = undefined;
    this.ram.spinnerArrowsAnimated = undefined; // the tileset graphics are reloaded
    // LoadMapHeader: "battles don't destroy this data" — keep sprites after a battle.
    if (!afterBattle || !this.sprites.length) this.loadSprites();
    if (!afterBattle) this.pikachu.scheduleSpawnForAfterText();
    this.pikachu.sync();
    markTownVisited(this);
    if (!this.ram.noMapMusic && !this.ram.flyWarp && !this.ram.dungeonWarp) this.playDefaultMusic(true);
    this.hooks.onMapChanged?.(this.world);
  }

  /** InitMapSprites + toggleable object visibility. */
  loadSprites(): void {
    const p = this.state.player;
    const player = newSprite(0);
    player.pictureId = this.playerPictureId();
    player.facing = { down: FACING_DOWN, up: FACING_UP, left: FACING_LEFT, right: FACING_RIGHT }[p.facing];
    player.movementByte1 = STAY;
    player.movementByte2 = NONE;
    this.sprites = [player];
    for (const obj of this.world.data.objects) {
      const s = newSprite(obj.index, obj);
      s.hidden = this.isObjectHidden(this.world.data.id, obj.index);
      this.sprites[obj.index] = s;
    }
  }

  /**
   * PlayDefaultMusic / PlayDefaultMusicFadeOutCurrent. The original first busy-waits for
   * the sound effects to end (WaitForSoundToFinish); here the music starts once they have.
   */
  playDefaultMusic(fadeOutCurrent = false): void {
    if (this.sound.sfxPlaying) {
      this.pendingDefaultMusic = fadeOutCurrent;
      return;
    }
    this.playDefaultMusicNow(fadeOutCurrent);
  }

  private playDefaultMusicNow(fadeOutCurrent: boolean): void {
    const snd = this.sound;
    let cFade = 0;
    let dFade = 0;
    if (!fadeOutCurrent) snd.lastMusicSoundID = 0;
    else {
      cFade = 10;
      if (this.ram.battleOverOrBlackout) {
        snd.lastMusicSoundID = 0;
        cFade = dFade = 8;
      }
    }
    // PlayDefaultMusicCommon
    const mode = this.state.player.mode;
    const noBikeMusic = ['ROUTE_23', 'VICTORY_ROAD_1F', 'VICTORY_ROAD_2F', 'VICTORY_ROAD_3F', 'INDIGO_PLATEAU'].some(
      (n) => c('map', n) === this.world.data.id,
    );
    let b: number;
    let skipSameCheck = false;
    if (mode === 'surf' || (mode === 'bike' && !noBikeMusic)) {
      b = c('music', mode === 'surf' ? 'MUSIC_SURFING' : 'MUSIC_BIKE_RIDING');
      const bank = this.bundle.audio.musicBanks.MUSIC_BIKE_RIDING;
      if (!dFade) snd.setBanks(bank, bank);
      else snd.setBanks(snd.audioBank, bank);
    } else {
      b = this.world.data.music.id;
      // CompareMapMusicBankWithCurrentBank
      const mapBank = this.world.data.music.bank;
      if (mapBank === snd.audioBank) snd.setBanks(mapBank, mapBank);
      else {
        snd.setBanks(cFade ? snd.audioBank : mapBank, mapBank);
        skipSameCheck = true;
      }
    }
    if (!skipSameCheck && snd.lastMusicSoundID === b) return;
    snd.fadeOutControl = cFade;
    snd.lastMusicSoundID = b;
    snd.newSoundId(b);
    snd.playSound(b);
    this.ram.music = b;
  }

  playMusic(name: string): void {
    this.ram.music = c('music', name);
    const bank = this.bundle.audio.musicBanks[name];
    if (bank === undefined) this.sound.playSound(this.ram.music);
    else this.sound.playMusic(this.ram.music, bank);
  }

  /** Hidden event routines owned by map ports (slot machines, Mansion switches, ...). */
  hiddenEventHandlers: Record<string, import('./hiddenEvents').HiddenEventFn> = {};
  /** DisplayTownMap (Town Map module). */
  townMap?: (e: Engine) => Co;
  /**
   * Field item handlers registered by the field systems (surfing, fishing,
   * Escape Rope, Itemfinder, Town Map, Pokédex, Card Key) as they are ported.
   */
  fieldItems: Record<string, (x: import('../items/useItem').ItemContext) => Co> = {};
  /** Field moves registered by their systems (Cut, Fly, Surf): return 'close' to leave the START menu. */
  fieldMoves: Record<string, (e: Engine, party: import('../game/state').PartyMon[], which: number) => Co<'close' | 'back'>> = {};
  /** Pikachu follower checks used by the Poké Flute (Pikachu module). */
  isPikachuRightNextToPlayer = (): boolean => this.pikachu.isRightNextToPlayer();
  playPikachuEmotion?: (id: number) => void;

  /** CheckForceBikeOrSurf: Cycling Road's entrances and Seafoam's currents. */
  checkForceBikeOrSurf(): void {
    if (this.ram.alwaysOnBike) return;
    const p = this.state.player;
    const hit = this.bundle.tileTables.forcedBikeOrSurf.find((f) => f.map === p.map && f.x === p.x && f.y === p.y);
    if (!hit) return;
    const seafoam = (['SEAFOAM_ISLANDS_B3F', 'SEAFOAM_ISLANDS_B4F'] as const).find((m) => c('map', m) === p.map);
    if (seafoam) {
      // the current: the map's script moves the player (SCRIPT_..._MOVE_OBJECT)
      this.setMapScriptOf(seafoam, c('map_script', `SCRIPT_${seafoam.replace(/_/g, '')}_MOVE_OBJECT`));
      this.store.dispatch({ type: 'setMode', mode: 'surf' }, { undoable: false });
    } else {
      this.ram.alwaysOnBike = true;
      this.store.dispatch({ type: 'setMode', mode: 'bike' }, { undoable: false });
    }
    this.playDefaultMusic(); // ForceBikeOrSurf
  }

  /** IsBikeRidingAllowed: Route 23, Indigo Plateau, or a tileset in BikeRidingTilesets. */
  isBikeRidingAllowed(): boolean {
    const id = this.world.data.id;
    if (id === c('map', 'ROUTE_23') || id === c('map', 'INDIGO_PLATEAU')) return true;
    return this.bundle.tileTables.bikeRidingTilesets.includes(this.world.data.tileset);
  }

  /** StopMusic: fade the music out over `fade` frames per step, then wait for the fade to end */
  *stopMusic(fade: number): Co {
    this.ram.music = 0;
    this.sound.fadeOutControl = fade;
    this.sound.newSoundId(0xff);
    this.sound.playSound(0xff);
    while (this.sound.fadeOutControl) yield;
    this.stopAllMusic(); // StopAllSounds
  }

  stopAllMusic(): void {
    this.ram.music = 0;
    this.sound.stopAllMusic();
  }

  // ------------------------------------------------------------ the overworld loop
  private *overworldLoop(): Co {
    let lessDelay = false;
    for (;;) {
      yield;
      if (!lessDelay) yield;
      lessDelay = false;
      yield* this.handleMidJump();
      if (this.ram.walkCounter) {
        const r = yield* this.moveAhead(false);
        if (r === 'lessDelay') lessDelay = true;
        continue;
      }
      yield* this.joypadOverworld();
      if (yield* safariZoneCheck(this)) {
        yield* this.warpFound2(this.ram.destinationWarpId, this.ram.warpDestinationMap, -1);
        continue;
      }
      if (this.ram.warpFromScript) {
        this.ram.warpFromScript = false;
        yield* this.warpFound2(this.ram.destinationWarpId, this.ram.warpDestinationMap, -1);
        continue;
      }
      if (this.ram.flyWarp || this.ram.dungeonWarp) {
        yield* handleFlyWarpOrDungeonWarp(this);
        continue;
      }
      if (this.ram.curOpponent) {
        yield* this.newBattleAndAfter();
        continue;
      }
      const pressed = this.ram.scriptedMovementState ? this.ram.joyHeld : this.ram.joyPressed;
      if (pressed & PAD_START) {
        // DisplayTextID(TEXT_START_MENU) → DisplayStartMenu
        this.ram.fontLoaded = true;
        this.updateSprites();
        yield* startMenu(this);
        this.ram.fontLoaded = false;
        continue;
      }
      if (pressed & PAD_A) {
        if (this.isPlayerCharacterBeingControlledByGame()) continue;
        if (yield* checkForHiddenEventOrBookshelfOrCardKeyDoor(this)) continue;
        this.ram.talkingToPikachu = false;
        const textId = this.isSpriteOrSignInFrontOfPlayer();
        if (this.ram.talkingToPikachu) {
          this.ram.talkingToPikachu = false;
          yield* talkToPikachu(this);
          continue;
        }
        if (!textId) continue;
        this.updateSprites();
        if (this.ram.turning) continue;
        this.ram.tilePlayerStandingOn = this.world.collisionTile(this.state.player.x, this.state.player.y);
        yield* this.displayTextID(textId);
        if (this.ram.curOpponent) yield* this.newBattleAndAfter();
        continue;
      }
      const held = this.ram.joyHeld;
      let dir = 0;
      if (held & PAD_DOWN) dir = PLAYER_DIR_DOWN;
      else if (held & PAD_UP) dir = PLAYER_DIR_UP;
      else if (held & PAD_LEFT) dir = PLAYER_DIR_LEFT;
      else if (held & PAD_RIGHT) dir = PLAYER_DIR_RIGHT;
      if (!dir) {
        // .noDirectionButtonsPressed
        this.updateSprites();
        this.ram.turning = false;
        this.ram.pikachuCollisionCounter = 0;
        this.ram.checkFor180DegreeTurn = 1;
        if (this.ram.playerMovingDirection) {
          this.ram.playerLastStopDirection = this.ram.playerMovingDirection;
          this.ram.playerMovingDirection = 0;
        }
        continue;
      }
      this.ram.playerDirection = dir;
      if (!this.ram.scriptedMovementState && this.ram.checkFor180DegreeTurn && dir !== this.ram.playerLastStopDirection) {
        // Yellow turns in place before walking in a new direction.
        this.ram.pikachuCollisionCounter = 8;
        this.ram.turning = true;
        this.ram.checkFor180DegreeTurn = 0;
        this.ram.playerMovingDirection = dir;
        this.setPlayerFacing(DIR_NAME[dir]);
        this.updateSprites();
        continue;
      }
      this.ram.playerMovingDirection = dir;
      this.setPlayerFacing(DIR_NAME[dir]);
      this.updateSprites();
      if (this.state.player.mode === 'surf') {
        if (this.collisionCheckOnWater()) continue;
      } else if (this.collisionCheckOnLand()) {
        if (this.ram.standingOnWarp) {
          const w = this.world.warpAt(this.state.player.x, this.state.player.y);
          if (w >= 0 && extraWarpCheck(this.world, this.playerMover())) {
            yield* this.checkWarpsCollision();
          }
        }
        continue;
      }
      this.ram.walkCounter = 8;
      this.pikachu.onPlayerStep(); // Func_fcc08
      const r = yield* this.moveAhead(true);
      if (r === 'lessDelay') lessDelay = true;
    }
  }

  /** .moveAhead / .moveAhead2: advance the player sprite, then the end-of-step checks. */
  private *moveAhead(start: boolean): Co<'lessDelay' | void> {
    if (!start) {
      // .moveAhead: IsSpinning (LoadSpinnerArrowTiles turns the player), then UpdateSprites
      if (this.ram.spinning) this.setPlayerFacing(NEXT_SPIN[this.state.player.facing]);
      this.updateSprites();
    }
    this.ram.turning = false;
    this.ram.pikachuCollisionCounter = 0;
    // DoBikeSpeedup; the Comfort mod also runs at bike speed while B is held
    const running = this.comfort && this.state.player.mode === 'walk' && !!(this.ram.joyHeld & PAD_B) && !this.ram.npcMovementScriptTable && !this.ram.ledgeOrFishing && !this.scripted.active && !this.ram.simulatedIndex;
    if (running) this.advancePlayerSprite();
    else if (
      this.state.player.mode === 'bike' &&
      !this.ram.ledgeOrFishing &&
      !this.ram.npcMovementScriptTable &&
      !(this.world.data.id === c('map', 'ROUTE_17') && this.ram.joyHeld & (PAD_UP | PAD_LEFT | PAD_RIGHT))
    ) {
      this.advancePlayerSprite();
    }
    this.advancePlayerSprite();
    if (this.ram.walkCounter) return;
    // walking animation finished
    this.stepCountCheck();
    if (this.env.checkEvent('EVENT_IN_SAFARI_ZONE') && (yield* safariZoneCheckSteps(this))) {
      yield* this.warpFound2(this.ram.destinationWarpId, this.ram.warpDestinationMap, -1);
      return;
    }
    if (!this.ram.isInBattle && (yield* applyOutOfBattlePoisonDamage(this))) {
      yield* this.handleBlackOut();
      return;
    }
    if (yield* this.newBattleAndAfter(true)) return;
    this.ram.standingOnWarp = false;
    return yield* this.checkWarpsNoCollision();
  }

  private advancePlayerSprite(): void {
    if (!this.ram.walkCounter) return;
    const p = this.state.player;
    this.ram.walkCounter--;
    if (this.ram.walkCounter === 0) {
      const [dx, dy] = DIR_VEC[DIR_NAME[this.ram.playerMovingDirection] ?? p.facing];
      this.store.dispatch({ type: 'setPosition', map: p.map, x: p.x + dx, y: p.y + dy }, { undoable: false });
    }
  }

  /** StepCountCheck: the three no-encounter steps after a battle. */
  private stepCountCheck(): void {
    const r = this.ram;
    if (r.scriptedMovementState) return;
    r.stepCounter = (r.stepCounter - 1) & 0xff;
    if (!r.wildEncounterCooldown) return;
    r.noRandomBattleSteps = (r.noRandomBattleSteps - 1) & 0xff;
    if (!r.noRandomBattleSteps) r.wildEncounterCooldown = false;
  }

  private *handleMidJump(): Co {
    const r = this.ram;
    if (!r.ledgeOrFishing) return;
    const next = r.jumpIndex + 1;
    if (next < 0x10) { r.jumpIndex = next; return; }
    // _HandleMidJump waits for the landing step, then UpdateSprites / Delay3.
    // Ending the jump mid-step leaves simulated input alive and bypasses
    // CollisionCheckOnLand even after the player has regained control.
    if (r.walkCounter) return;
    this.updateSprites();
    yield* this.delayFrames(3);
    r.joyHeld = r.joyPressed = 0;
    r.jumpIndex = 0;
    r.ledgeOrFishing = false;
    r.scriptedMovementState = false;
    r.joyIgnore = 0;
  }

  /** Current ledge-hop height in pixels (for rendering). */
  get jumpLift(): number {
    if (this.ram.fishing) return -this.ram.fishing.shake;
    if (!this.ram.ledgeOrFishing) return 0;
    const t = this.bundle.tileTables.playerJumpingY;
    return 0x3c - (t[this.ram.jumpIndex] ?? 0x3c);
  }

  setPlayerFacing(f: Facing): void {
    if (this.state.player.facing !== f) this.store.dispatch({ type: 'face', facing: f }, { undoable: false });
    this.sprites[0].facing = { down: FACING_DOWN, up: FACING_UP, left: FACING_LEFT, right: FACING_RIGHT }[f];
  }

  playerMover() {
    const p = this.state.player;
    return { x: p.x, y: p.y, facing: p.facing, mode: p.mode };
  }

  frontOfPlayer(): [number, number] {
    const p = this.state.player;
    const [dx, dy] = DIR_VEC[p.facing];
    return [p.x + dx, p.y + dy];
  }

  /** CollisionCheckOnLand (+ HandleLedges, tile pair collisions). Returns true on collision. */
  private collisionCheckOnLand(): boolean {
    if (this.ram.ledgeOrFishing) return false;
    if (this.ram.simulatedIndex) return false; // movement controlled by the game
    const [fx, fy] = this.frontOfPlayer();
    if (this.spriteInFront(fx, fy)) return this.collide();
    if (this.pikachuBlocks(fx, fy)) return this.collide();
    // HandleLedges
    if (this.handleLedges()) return false;
    const standing = this.world.collisionTile(this.state.player.x, this.state.player.y);
    const ahead = this.world.collisionTile(fx, fy);
    this.ram.tilePlayerStandingOn = standing;
    if (tilePairBlocked(this.world, standing, ahead)) return this.collide();
    if (!this.world.isSquarePassable(fx, fy)) return this.collide();
    return false;
  }

  private collide(): boolean {
    this.hooks.playSound?.('collision');
    return true;
  }

  /**
   * CollisionCheckOnLand's Pikachu rule: an asleep Pikachu blocks; otherwise the player walks
   * through, after bumping into it for wPikachuCollisionCounter frames when they just turned
   * toward it (B skips the bump).
   */
  private pikachuBlocks(fx: number, fy: number): boolean {
    const s = this.sprites[this.pikachuSlot];
    if (!s || s.obj || s.hidden || s.mapX !== fx || s.mapY !== fy) return false;
    if (this.ram.pikachuOverworldStateFlags & PIKA_NOT_FOLLOWING) return true;
    if (inputToPad(this.input, 'held') & PAD_B) return false;
    if (!this.ram.pikachuCollisionCounter) return false;
    this.ram.pikachuCollisionCounter--;
    return this.ram.pikachuCollisionCounter !== 0;
  }

  /** A visible sprite (other than Pikachu) occupies or is walking onto the square in front. */
  spriteInFront(fx: number, fy: number): boolean {
    for (const s of this.sprites.slice(1)) {
      if (!s || s.hidden || !s.pictureId || s.slot === this.pikachuSlot) continue;
      if (spriteSquares(s).some(([x, y]) => x === fx && y === fy)) return true;
    }
    return false;
  }

  private handleLedges(): boolean {
    if (this.world.data.tileset !== c('tileset', 'OVERWORLD')) return false;
    const p = this.state.player;
    const standing = this.world.collisionTile(p.x, p.y);
    const [fx, fy] = this.frontOfPlayer();
    const ahead = this.world.collisionTile(fx, fy);
    const facing = { down: 0, up: 4, left: 8, right: 12 }[p.facing];
    const ledge = this.bundle.tileTables.ledges.find((l) => l.facing === facing && l.standing === standing && l.ledge === ahead);
    if (!ledge || !(this.ram.joyHeld & ledge.input)) return false;
    this.ram.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
    this.ram.ledgeOrFishing = true;
    this.ram.jumpIndex = 0;
    this.startSimulatingJoypadStates();
    this.ram.simulatedJoypad = [ledge.input, ledge.input];
    // This collision handler immediately starts the first step below, so its
    // input is already consumed; only the landing step remains in our queue.
    this.ram.simulatedIndex = 1;
    this.hooks.playSound?.('ledge');
    return true;
  }

  /** CollisionCheckOnWater: keep surfing over water/shore, step off onto passable land. */
  private collisionCheckOnWater(): boolean {
    if (this.ram.scriptedMovementState) return false;
    const [fx, fy] = this.frontOfPlayer();
    if (this.spriteInFront(fx, fy)) return this.collide();
    const standing = this.world.collisionTile(this.state.player.x, this.state.player.y);
    const ahead = this.world.collisionTile(fx, fy);
    if (tilePairBlocked(this.world, standing, ahead, true)) return this.collide();
    if (isNextTileShoreOrWater(this)) return false;
    if (!this.world.isSquarePassable(fx, fy)) return this.collide();
    stopSurfing(this); // .stopSurfing
    return false;
  }

  // ------------------------------------------------------------ warps & connections
  private *checkWarpsNoCollision(): Co<'lessDelay' | void> {
    const p = this.state.player;
    const warp = this.world.warpAt(p.x, p.y);
    if (warp >= 0) {
      this.ram.standingOnWarp = true;
      const w = this.world.warp(warp);
      if (standingOnDoorOrWarpTile(this.world, p.x, p.y)) {
        yield* this.warpFound2(w.destWarp, w.destMap, warp);
        return;
      }
      if (extraWarpCheck(this.world, this.playerMover())) {
        this.joypad();
        // BIT_FORCED_WARP, or a direction really held (Joypad re-reads the pad, ignoring simulation)
        if (this.ram.forcedWarp || inputToPad(this.input, 'held') & PAD_CTRL_PAD) {
          yield* this.warpFound2(w.destWarp, w.destMap, warp);
          return;
        }
      }
    }
    return this.checkMapConnections();
  }

  private *checkWarpsCollision(): Co {
    const p = this.state.player;
    const warp = this.world.warpAt(p.x, p.y);
    if (warp < 0) return;
    const w = this.world.warp(warp);
    yield* this.warpFound2(w.destWarp, w.destMap, warp);
  }

  /** WarpFound2: update wLastMap, change map, step out of doors, EnterMap. */
  *warpFound2(destWarp: number, destMap: number, _fromWarp: number): Co {
    const from = this.world;
    const p = this.state.player;
    let lastMap = p.lastMap;
    let target: number;
    if (isOutsideMap(from)) {
      lastMap = from.data.id;
      target = destMap;
      if (target === c('map', 'ROCK_TUNNEL_1F')) this.ram.mapPalOffset = 6; // dark until FLASH
      this.pikachu.setSpawnOutside(target);
    } else if (destMap === 0xff) {
      this.pikachu.setSpawnBackOutside(from.data.id);
      target = p.lastMap;
      this.ram.mapPalOffset = 0;
    } else {
      target = destMap;
      this.pikachu.setSpawnWarpPad(target);
    }
    const dest = this.bundle.maps[target];
    if (!dest) throw new Error(`warp to missing map ${target} from ${from.data.constName}`);
    const dw = dest.warps[destWarp];
    if (!dw) throw new Error(`warp to missing warp ${destWarp} of ${dest.constName}`);
    this.ram.destinationWarpId = destWarp; // wDestinationWarpID
    if (_fromWarp >= 0) this.ram.warpedFromWhichWarp = _fromWarp;
    this.ram.warpedFromWhichMap = from.data.id;
    if (!isOutsideMap(from) && destMap !== 0xff && standingOnWarpPadOrHole(this) === 1) {
      // a warp pad: spin away, and spin in on arrival (EnterMapAnim via BIT_FLY_WARP)
      yield* leaveMapAnim(this);
      this.ram.flyWarp = true;
    } else {
      this.hooks.playSound?.(standingOnDoorTile(from, p.x, p.y) ? 'go_inside' : 'go_outside');
      yield* this.fadeOut();
    }
    this.store.dispatch({ type: 'setPosition', map: target, x: dw.x, y: dw.y, lastMap }, { undoable: false });
    this.ram.standingOnDoor = true; // step out of the door if there is one
    this.ram.walkCounter = 0;
    yield* this.enterMap();
  }

  /** CheckMapConnections: walking off the edge loads the connected map. */
  private checkMapConnections(): 'lessDelay' | void {
    const p = this.state.player;
    const d = this.world.data;
    let dir: 'north' | 'south' | 'west' | 'east' | undefined;
    if (p.x === -1) dir = 'west';
    else if (p.x === this.world.widthSquares) dir = 'east';
    else if (p.y === -1) dir = 'north';
    else if (p.y === this.world.heightSquares) dir = 'south';
    if (!dir) return;
    const conn = d.connections[dir];
    if (!conn) return;
    const other = this.bundle.maps[conn.map];
    let x = p.x;
    let y = p.y;
    if (dir === 'west') [x, y] = [other.width * 2 - 1, p.y - conn.offset * 2];
    if (dir === 'east') [x, y] = [0, p.y - conn.offset * 2];
    if (dir === 'north') [x, y] = [p.x - conn.offset * 2, other.height * 2 - 1];
    if (dir === 'south') [x, y] = [p.x - conn.offset * 2, 0];
    const shift = { dx: x - p.x, dy: y - p.y };
    this.store.dispatch({ type: 'setPosition', map: conn.map, x, y }, { undoable: false });
    this.world = new WorldMap(this.bundle, conn.map);
    this.pikachu.onConnection();
    this.loadSprites();
    this.pikachu.scheduleSpawnForAfterText();
    this.pikachu.sync();
    this.playDefaultMusic(true);
    this.connectionShift = shift;
    this.hooks.onMapChanged?.(this.world);
    return 'lessDelay';
  }

  /** Set when the last map change was a connection (for a seamless camera hand-off). */
  connectionShift?: { dx: number; dy: number };

  /** PlayMapChangeSound's GBFadeOutToBlack: FadePal4-1, 8 frames each (none in a dark map) */
  private *fadeOut(): Co {
    if (this.ram.npcMovementScriptTable || this.ram.mapPalOffset) return;
    yield* this.env.fadeToBlack();
  }

  /**
   * The new map's palette: the overworld loop's LoadGBPal restores it at once, except
   * after a battle (MapEntryAfterBattle: GBFadeInFromWhite unless the map is dark).
   */
  private *fadeIn(afterBattle = false): Co {
    if (afterBattle && !this.ram.mapPalOffset) yield* this.env.fadeFromWhite();
    else this.hooks.fade?.(0);
  }

  // ------------------------------------------------------------ sprites
  /** UpdateSprites: player sprite + every NPC (or the NPC in a synced movement script). */
  /**
   * The player's sheet for wWalkBikeSurfState: LoadWalkingPlayerSpriteGraphics,
   * LoadBikePlayerSpriteGraphics, LoadSurfingPlayerSpriteGraphics2 (Seel, or Surfing
   * Pikachu when the starter knows SURF; wd472 1/2 force Seel/Pikachu).
   */
  playerPictureId(): number {
    const mode = this.state.player.mode;
    if (this.ram.fishing) return extraSheetId('RedFishingSprite');
    if (mode === 'bike') return extraSheetId('RedBikeSprite');
    if (mode === 'surf') {
      const forced = this.env.vars.wd472 ?? 0;
      const pikachu = forced === 2 || (forced !== 1 && isSurfingPikachuInParty(this.state));
      return pikachu ? extraSheetId('SurfingPikachuSprite') : c('sprite', 'SPRITE_SEEL');
    }
    return c('sprite', 'SPRITE_RED');
  }

  updateSprites(): void {
    const r = this.ram;
    if (this.sprites[0]) this.sprites[0].pictureId = this.playerPictureId();
    for (const s of this.sprites) {
      if (!s || s.slot === 0 || !s.pictureId) continue;
      if (s.slot === this.pikachuSlot) continue;
      if (r.scriptedMovementState && r.npcMovementScriptTable && s.slot === r.npcMovementScriptSprite) {
        doScriptedNpcMovement(s, r.synced);
        continue;
      }
      updateNpcSprite(s, this);
    }
    // UpdatePlayerSprite
    const ps = this.sprites[0];
    if (!ps) return; // no map entered yet (the title screen and Oak's speech)
    if (r.walkCounter) {
      ps.intraAnim = (ps.intraAnim + 1) & 3;
      if (!ps.intraAnim) ps.animFrame = (ps.animFrame + 1) & 3;
    } else {
      const f = DIR_NAME[r.playerMovingDirection];
      if (f) this.setPlayerFacing(f);
      ps.intraAnim = 0;
      ps.animFrame = 0;
    }
    // SpawnPikachu (sprite slot 15) unless a map object occupies the slot
    if (!this.sprites[this.pikachuSlot]?.obj) this.pikachu.update();
  }

  /**
   * MoveSprite: copy movement data and start scripted NPC movement.
   * MoveSprite_ (used by TrainerWalkUpToPlayer) keeps movement byte 2.
   */
  moveSprite(slot: number, directions: number[], keepMovementByte2 = false): void {
    const s = this.sprites[slot];
    if (!s) throw new Error(`moveSprite: no sprite ${slot} on ${this.world.data.constName}`);
    // SetSpriteMovementBytesToFF, then movement byte 1 = 0 (index)
    if (!keepMovementByte2) s.movementByte2 = NONE;
    s.movementByte1 = 0;
    const list = [...directions];
    if (list[list.length - 1] !== 0xff) list.push(0xff);
    this.scripted.directions = list;
    this.scripted.numSteps = list.length;
    this.scripted.active = true;
    this.ram.overrideSimulatedMask = 0;
    this.ram.simulatedJoypad = [];
    this.ram.joyIgnore = 0xff;
  }

  // ------------------------------------------------------------ Pikachu (follower)
  /** The Pikachu sprite slot (PIKACHU_SPRITE_INDEX). Full movement engine: TASKS.md. */
  get pikachuSlot(): number {
    return c('map_object', 'PIKACHU_SPRITE_INDEX');
  }

  /** EnablePikachuOverworldSpriteDrawing / DisablePikachuOverworldSpriteDrawing */
  setPikachuDrawing(on: boolean): void {
    if (on) this.ram.pikachuOverworldStateFlags &= ~PIKA_NO_DRAWING;
    else {
      this.ram.pikachuOverworldStateFlags |= PIKA_NO_DRAWING;
      this.pikachu.hidden = true;
      this.pikachu.sync();
    }
  }

  /** Func_1510 / Func_151d: hide Pikachu entirely (ShouldPikachuSpawn fails while set). */
  setPikachuHidden(on: boolean): void {
    if (on) {
      this.ram.pikachuOverworldStateFlags |= PIKA_HIDDEN;
      this.pikachu.hidden = true;
    } else this.ram.pikachuOverworldStateFlags &= ~PIKA_HIDDEN;
  }

  // ------------------------------------------------------------ interaction
  /** IsSpriteOrSignInFrontOfPlayer → text id (0 = nothing). Signs take priority. */
  isSpriteOrSignInFrontOfPlayer(): number {
    const [fx, fy] = this.frontOfPlayer();
    const sign = this.world.signAt(fx, fy);
    if (sign) return sign.textId;
    let range = 1;
    const ahead = this.world.collisionTile(fx, fy);
    if (this.world.tileset.counterTiles.includes(ahead)) range = 2;
    const p = this.state.player;
    const [dx, dy] = DIR_VEC[p.facing];
    this.ram.playerDirection = FACING_TO_DIR[p.facing];
    const tx = p.x + dx * range;
    const ty = p.y + dy * range;
    for (let slot = 1; slot < 16; slot++) {
      const s = this.sprites[slot];
      if (!s || !s.pictureId || s.hidden || s.offscreen) continue;
      // Must be standing exactly on the square (not mid-step).
      if (s.offX || s.offY || s.mapX !== tx || s.mapY !== ty) continue;
      s.facePlayer = true;
      if (slot === this.pikachuSlot && !s.obj) {
        // wd435: IsPlayerTalkingToPikachu runs instead of a text
        this.ram.talkingToPikachu = true;
        return 0;
      }
      return slot;
    }
    return 0;
  }

  // ------------------------------------------------------------ text
  /** Map text entry for a text id (after sprite-index resolution). */
  textEntry(textId: number): MapTextEntry | undefined {
    const alt = this.ram.textPointerOverride;
    if (alt) {
      const table = this.world.data.altTexts[alt];
      if (!table) throw new Error(`${this.world.data.constName} has no text table ${alt}`);
      return table[textId];
    }
    return this.world.data.texts[textId];
  }

  /** DisplayTextID (home/text_script.asm). `id` may be a sprite index or a text id. */
  *displayTextID(id: number, predef?: MapTextEntry): Co {
    // DisplayTextIDInit
    const r = this.ram;
    if (!(r.autoTextBoxControl & 1)) this.screen.box(0, 12, 4, 18);
    r.fontLoaded = true;
    this.updateSprites();
    for (const s of this.sprites.slice(1)) if (s) s.origFacing = s.facing;
    for (const s of this.sprites) if (s) s.animFrame = 0;

    let textId = id;
    this.ram.spriteIndex = id; // ldh a, [hTextID] / ld [wSpriteIndex], a
    const numSprites = this.world.data.objects.length;
    if (!predef && id <= numSprites && id > 0) textId = this.sprites[id]?.obj?.textId ?? id;
    const entry = predef ?? this.textEntry(textId);
    if (!entry) throw new Error(`${this.world.data.constName}: no text ${textId}`);
    let waitAfter = true;
    if (entry.kind === 'text') {
      const ops = this.bundle.texts[entry.label];
      if (!ops) throw new Error(`text ${entry.label} missing from bundle`);
      yield* this.textCommandProcessor(ops, 1, 14);
      waitAfter = !r.doNotWaitForButtonPress;
    } else {
      waitAfter = yield* this.specialTextScript(entry);
    }
    if (waitAfter) yield* this.waitForTextScrollButtonPress();
    // HoldTextDisplayOpen
    for (;;) {
      this.joypad();
      if (!(inputToPad(this.input, 'held') & PAD_A)) break;
      yield;
    }
    this.closeTextDisplay();
  }

  /** PrintPredefTextID: DisplayTextID on an entry of TextPredefs. */
  *printPredefTextID(id: number): Co {
    const entry = this.bundle.hidden.textPredefs[id];
    if (!entry) throw new Error(`no text predef ${id}`);
    yield* this.displayTextID(id, entry);
  }

  /** Special text scripts (marts, Pokécenter, PCs, ...). Returns whether to wait for a button afterwards. */
  private *specialTextScript(entry: MapTextEntry): Co<boolean> {
    const h = this.scripts.specials[entry.kind];
    if (!h) {
      this.hooks.unported?.(`text script ${entry.kind}`);
      return true;
    }
    return (yield* h(this.env, entry)) ?? true;
  }

  closeTextDisplay(): void {
    this.screen.fill(0, 0, 20, 18, -1);
    for (const s of this.sprites.slice(1)) if (s) s.facing = s.origFacing;
    this.ram.fontLoaded = false;
    this.ram.emotionBubble = undefined;
    this.updateSprites();
  }

  findTextHandler(label: string): ((env: ScriptEnv) => Co) | undefined {
    const m = this.mapScript();
    const h = m?.texts?.[label] ?? this.scripts.texts[label];
    if (h) return h;
    for (const [re, fn] of this.scripts.patterns ?? []) if (re.test(label)) return fn;
    const simple = this.bundle.simpleAsm[label];
    if (!simple) return undefined;
    return (env) => runAsmProgram(env, simple);
  }

  /** Hand-ported script, or a generic one for boilerplate scripts recognised in the ROM. */
  mapScript(): MapScript | undefined {
    const d = this.world.data;
    const ported = this.scripts.maps[d.constName];
    if (ported) return ported;
    const g = this.genericScripts;
    if (d.scriptKind === 'trainers') {
      // a few trainer maps disable automatic text boxes instead (SS Anne 2F rooms)
      if (d.scriptOps?.some((o) => o.op === 'autoTextBox' && !o.on))
        return (g.trainersNoAuto ??= trainerMapScript('*', [], {}, function* (env) {
          env.disableAutoTextBoxDrawing();
        }));
      return (g.trainers ??= trainerMapScript('*'));
    }
    if (d.scriptKind === 'simple') {
      const ops = d.scriptOps ?? [];
      return (g[`simple:${d.id}`] ??= {
        map: '*',
        *run(env) {
          for (const o of ops) {
            if (o.op === 'autoTextBox') {
              if (o.on) env.enableAutoTextBoxDrawing();
              else env.disableAutoTextBoxDrawing();
            } else if (o.op === 'autoTextBoxControl') env.e.ram.autoTextBoxControl = o.value;
            else if (o.op === 'lastMap') {
              if (env.e.state.player.lastMap !== o.map) env.e.store.dispatch({ type: 'setLastMap', map: o.map }, { undoable: false });
            } else env.e.ram.pikachuMapScriptActive = o.on;
          }
        },
      });
    }
    return undefined;
  }
  private genericScripts: Partial<Record<string, MapScript>> = {};

  /** WaitForTextScrollButtonPress with the blinking ▼ at (18,16). */
  *waitForTextScrollButtonPress(): Co {
    let blink = 0;
    for (;;) {
      yield;
      const pressed = inputToPad(this.input, 'pressed');
      if (pressed & (PAD_A | PAD_B)) break;
      blink = (blink + 1) % 64;
      if (this.screen.get(18, 16) === 0xee || this.screen.get(18, 16) === 0x7f)
        this.screen.put(18, 16, blink < 32 ? 0xee : 0x7f);
    }
  }

  /** PrintText: draw a message box, Delay3, then run the text at (1,14). */
  *printText(label: string, ctx?: Partial<TextContext>): Co {
    this.trace('text', label);
    const ops = this.bundle.texts[label];
    if (!ops) throw new Error(`printText: text ${label} missing from bundle`);
    yield* this.printOps(ops, ctx);
  }

  /** PrintText with already-decoded ops (battle text chains). */
  *printOps(ops: TextOp[], ctx?: Partial<TextContext>): Co {
    this.screen.box(0, 12, 4, 18);
    this.updateSprites();
    yield* this.delayFrames(3);
    yield* this.textCommandProcessor(ops, 1, 14, ctx);
  }

  /** TextCommandProcessor with the shared TextPrinter. */
  *textCommandProcessor(ops: TextOp[], x = 1, y = 14, ctx?: Partial<TextContext>): Co<string> {
    const s = this.state;
    const printer = new TextPrinter(this.screen, {
      ...this.defaultTextContext(),
      ...ctx,
    });
    void s;
    printer.cx = x;
    printer.cy = y;
    const r = yield* runWaits(this, printer.run(ops));
    return r;
  }

  defaultTextContext(): TextContext {
    const s = this.state;
    return {
      playerName: s.player.name,
      rivalName: s.player.rivalName,
      letterDelay: this.ram.noTextDelay ? 0 : LETTER_DELAY[s.options.textSpeed],
      ram: (label, addr) => this.ramValue(label, addr),
      asm: (label) => {
        const h = this.findTextHandler(label);
        if (!h) return undefined;
        return frameCoAsWaits(h(this.env));
      },
      missingAsm: (label) => this.hooks.unported?.(`text_asm ${label}`),
      sound: (cmd) => this.textCommandSound(cmd),
      soundBusy: () => this.sound.sfxPlaying,
    };
  }

  /** TextCommand_SOUND: TextCommandSounds' sound effect, or a cry */
  textCommandSound(cmd: number): void {
    const cries: Record<number, string> = { 0x14: 'PIKACHU', 0x15: 'PIDGEOT', 0x16: 'DEWGONG' };
    if (cries[cmd]) {
      this.sound.playCry(c('pokemon', cries[cmd]));
      return;
    }
    const sfx: Record<number, string> = {
      0x0b: 'SFX_GET_ITEM_1',
      0x0e: 'SFX_POKEDEX_RATING',
      0x0f: 'SFX_GET_ITEM_1',
      0x10: 'SFX_GET_ITEM_2',
      0x11: 'SFX_GET_KEY_ITEM',
      0x12: 'SFX_CAUGHT_MON',
      0x13: 'SFX_DEX_PAGE_ADDED',
    };
    if (sfx[cmd]) this.sound.playSound(c('music', sfx[cmd]));
  }

  ramValue(label: string, addr?: number): string | number | undefined {
    const s = this.state;
    if (addr !== undefined) {
      if (this.ram.mem.has(addr)) return this.ram.mem.get(addr);
      if (addr === 0xcd6d || addr === 0xcf4a) return this.ram.nameBuffer; // wNameBuffer / wStringBuffer
    }
    switch (label) {
      case 'wPlayerName':
        return s.player.name;
      case 'wRivalName':
        return s.player.rivalName;
      case 'wPlayerMoney':
        return s.money;
      case 'wPlayerCoins':
        return s.coins;
      case 'wBoxMon1Nick':
        return s.boxes[s.currentBox]?.[0]?.nickname;
      case 'wNameBuffer':
      case 'wcd6d':
      case 'wStringBuffer':
        return this.ram.nameBuffer;
      default:
        return this.env.vars[label];
    }
  }

  *delayFrames(n: number): Co {
    for (let i = 0; i < n; i++) yield;
  }

  /** SaveGameData (no prompt): write the save file. */
  *saveGameData(): Co {
    while (!(yield* persistCheckpoint(this))) yield* this.delayFrames(1);
  }

  /** Init: the soft reset; the overworld never resumes. */
  *softReset(): Co<never> {
    this.hooks.reset?.();
    for (;;) yield;
  }

  // ------------------------------------------------------------ scripts
  /** RunMapScript: boulders (TASKS), RunNPCMovementScript, then the map's script. */
  private *runMapScript(): Co {
    tryPushingBoulder(this);
    if (this.ram.boulderDust) yield* doBoulderDustAnimation(this);
    this.runNpcMovementScript();
    const m = this.mapScript();
    this.trace('map', `${this.world.data.constName}[${this.curScript}]`);
    if (m?.run) yield* m.run(this.env);
    else if (!m) this.hooks.unported?.(`map script ${this.world.data.constName}`);
  }

  /** RunNPCMovementScript: door step-out, or the active NPC movement script table. */
  private runNpcMovementScript(): void {
    const r = this.ram;
    if (r.standingOnDoor) {
      r.standingOnDoor = false;
      this.playerStepOutFromDoor();
      return;
    }
    if (!r.npcMovementScriptTable) return;
    const table = NPC_MOVEMENT_SCRIPTS[r.npcMovementScriptTable - 1];
    table[r.npcMovementScriptFunction]?.(this);
  }

  /** PlayerStepOutFromDoor (engine/overworld/auto_movement.asm). */
  private playerStepOutFromDoor(): void {
    const p = this.state.player;
    const r = this.ram;
    if (standingOnDoorTile(this.world, p.x, p.y)) {
      r.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
      r.exitingDoor = true;
      r.simulatedIndex = 1;
      r.simulatedJoypad = [PAD_DOWN];
      this.startSimulatingJoypadStates();
      return;
    }
    r.overrideSimulatedMask = 0;
    r.simulatedIndex = 0;
    r.simulatedJoypad = [];
    r.standingOnDoor = false;
    r.exitingDoor = false;
    r.scriptedMovementState = false;
  }

  /** _EndNPCMovementScript */
  endNpcMovementScript(): void {
    const r = this.ram;
    r.scriptedMovementState = false;
    r.synced.initialized = false;
    r.standingOnDoor = false;
    r.exitingDoor = false;
    r.npcMovementScriptSprite = 0;
    r.npcMovementScriptFunction = 0;
    r.npcMovementScriptTable = 0;
    r.simulatedIndex = 0;
    r.simulatedJoypad = [];
  }

  // ------------------------------------------------------------ battles
  /**
   * NewBattle → InitBattle (with DetermineWildOpponent / TryDoWildEncounter
   * when no opponent is set), then the .battleOccurred bookkeeping in
   * OverworldLoop and AllPokemonFainted / HandleBlackOut. Returns whether a
   * battle took place.
   */
  private *newBattleAndAfter(fromStep = false): Co<boolean> {
    const r = this.ram;
    if (fromStep && (this.isPlayerCharacterBeingControlledByGame() || r.noBattles)) return false;
    if (!r.curOpponent) {
      if (!fromStep) return false;
      // DetermineWildOpponent
      if (r.noRandomBattleSteps || r.debugNoWildEncounters) return false;
      const wild = yield* tryDoWildEncounter(this);
      if (!wild) return false;
      r.curOpponent = wild.species;
      r.curEnemyLevel = wild.level;
    }
    const req: BattleRequest =
      r.curOpponent >= 200
        ? { kind: 'trainer', trainerClass: r.curOpponent - 200, trainerNo: r.trainerNo, battleType: r.battleType, gymLeaderNo: r.gymLeaderNo }
        : { kind: 'wild', species: r.curOpponent, level: r.curEnemyLevel, battleType: r.battleType, fishing: r.fishingBattle };
    const result: BattleResult = yield* this.battleHost.run(this.env, req);
    if (req.kind === 'trainer' && result === 'win') this.setEnemyTrainerToStayAndFaceAnyDirection();
    r.curOpponent = 0;
    r.battleType = 0;
    r.fishingBattle = false;
    r.battleResult = result === 'win' ? 0 : result === 'lose' ? 1 : 2;
    // .battleOccurred
    r.talkedToTrainer = false;
    r.trainerBattle = false;
    r.curMapLoaded1 = true;
    r.curMapLoaded2 = true;
    r.joyHeld = 0;
    if (this.world.data.id === c('map', 'CINNABAR_GYM')) this.store.dispatch({ type: 'setEvent', flag: c('event', 'EVENT_2A7'), value: true }, { undoable: false });
    r.battleOverOrBlackout = true;
    // AnyPartyAlive with an empty party reads 256 entries of other WRAM and finds "HP" (Pikachu battle in Pallet Town)
    const party = this.state.party;
    if (this.world.data.id !== c('map', 'OAKS_LAB') && party.length && !party.some((m) => m.hp > 0)) {
      // AllPokemonFainted
      r.isInBattle = 0xff; // LOST_BATTLE
      yield* this.runMapScript();
      r.isInBattle = 0;
      yield* this.handleBlackOut();
      return true;
    }
    yield* this.delayFrames(10);
    yield* this.enterMap(true);
    return true;
  }

  /** HandleBlackOut + ResetStatusAndHalveMoneyOnBlackout: back to the last Pokémon Center's town. */
  *handleBlackOut(): Co {
    yield* this.fadeOut();
    this.ram.mapPalOffset = 0;
    yield* this.stopMusic(8);
    const r = this.ram;
    r.battleOverOrBlackout = false;
    r.npcMovementScriptFunction = 0;
    r.npcMovementScriptTable = 0;
    r.joyHeld = 0;
    this.store.dispatch({ type: 'setMode', mode: 'walk' }, { undoable: false });
    this.store.dispatch({ type: 'addMoney', amount: -(this.state.money - Math.floor(this.state.money / 2)) }, { undoable: false });
    this.env.healParty();
    const map = this.env.vars.wLastBlackoutMap ?? c('map', 'PALLET_TOWN');
    yield* this.specialWarp(map);
  }

  /** PrepareForSpecialWarp + SpecialEnterMap for a Fly/blackout destination. */
  *specialWarp(map: number): Co {
    const dest = this.bundle.specialWarps.fly[map];
    if (!dest) throw new Error(`no fly warp data for map ${map}`);
    this.store.dispatch({ type: 'setPosition', map, x: dest.x, y: dest.y, facing: 'down', lastMap: map }, { undoable: false });
    this.ram.walkCounter = 0;
    this.ram.standingOnDoor = false;
    yield* this.enterMap();
  }

  /** SetEnemyTrainerToStayAndFaceAnyDirection (engine/overworld/npc_movement_2.asm). */
  private setEnemyTrainerToStayAndFaceAnyDirection(): void {
    if (this.world.data.id === c('map', 'POKEMON_TOWER_7F')) return;
    const rivals = ['OPP_RIVAL1', 'OPP_RIVAL2', 'OPP_RIVAL3'].map((n) => c('opp', n));
    if (rivals.includes(this.ram.engagedTrainerClass)) return;
    const s = this.sprites[this.ram.spriteIndex];
    if (!s || !this.ram.spriteIndex) return;
    s.movementByte1 = STAY;
    s.movementByte2 = NONE;
  }

  startTrainerBattle(opp: number, trainerNo: number): void {
    this.ram.curOpponent = opp;
    this.ram.trainerNo = trainerNo;
  }

  // ------------------------------------------------------------ rendering helpers
  /** Fractional render position of a sprite slot in squares. */
  spriteRenderPos(s: Sprite): [number, number] {
    if (s.slot === 0) {
      const p = this.state.player;
      if (!this.ram.walkCounter) return [p.x, p.y];
      const [dx, dy] = DIR_VEC[DIR_NAME[this.ram.playerMovingDirection] ?? p.facing];
      const t = (8 - this.ram.walkCounter) / 8;
      return [p.x + dx * t, p.y + dy * t];
    }
    return [s.mapX + s.offX / 16, s.mapY + s.offY / 16];
  }

  facingOf(s: Sprite): Facing {
    return facingName(s.facing);
  }
}

/** Drive a Wait-yielding text coroutine on frame yields. */
export function* runWaits<R>(e: Engine, gen: Generator<Wait, R, InputFrame>): Co<R> {
  let r = gen.next(e.input!);
  let blink = 0;
  for (;;) {
    if (r.done) return r.value;
    const w = r.value;
    if ('frames' in w) {
      for (let i = 0; i < w.frames; i++) yield;
    } else if ('button' in w) {
      for (;;) {
        yield;
        const pressed = inputToPad(e.input, 'pressed');
        if (pressed & (PAD_A | PAD_B)) break;
        if (w.arrow) {
          blink = (blink + 1) % 64;
          e.screen.put(18, 16, blink < 32 ? 0xee : 0x7f);
        }
      }
      if (w.arrow) e.screen.put(18, 16, 0xee);
    } else {
      while (inputToPad(e.input, 'held') & PAD_A) yield;
    }
    r = gen.next(e.input!);
  }
}

/** Expose a frame coroutine to the text printer's Wait protocol. */
let sfxNames: Map<string, number> | undefined;
/** A sound constant by loose name: 'go_inside', 'SFX_GO_INSIDE', 'get_item2' and 'teleport_exit1' all resolve */
function sfxByName(name: string): number | undefined {
  const norm = (n: string) => n.toUpperCase().replace(/^SFX_/, '').replace(/[^A-Z0-9]/g, '');
  if (!sfxNames) {
    sfxNames = new Map();
    for (const [k, v] of Object.entries(CONSTANTS.music as Record<string, number>)) if (!sfxNames.has(norm(k))) sfxNames.set(norm(k), v);
  }
  return sfxNames.get(norm(name)) ?? sfxNames.get(norm(name) + '1');
}

export function* frameCoAsWaits(co: Co): Generator<Wait, void, InputFrame> {
  for (;;) {
    const r = co.next();
    if (r.done) return;
    yield { frames: 1 };
  }
}
