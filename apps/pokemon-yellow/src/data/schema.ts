/**
 * Schema for extracted game data. Repository assets remain excluded from VCS.
 * Hosted releases require the operator's distribution authorization and notices.
 * Bump SCHEMA_VERSION whenever the shape changes.
 */
export const SCHEMA_VERSION = 57;

export interface BundleMeta {
  schemaVersion: number;
  extractorVersion: string;
  /** SHA-1 of the ROM the bundle was derived from. */
  sourceSha1: string;
  romTitle: string;
  extractedAt: string;
  /** False for operator-provisioned hosted releases; true for developer extraction. */
  derivedFromUserRom: boolean;
  notice: string;
}

// ------------------------------------------------------------------ text
export type TextOp =
  /** TextCommand_FAR calls another processor: DONE/PROMPT return to its caller. */
  | { t: 'far'; ops: TextOp[] }
  | { t: 'text'; v: string }
  | { t: 'ram'; addr: string; a?: number }
  | { t: 'bcd'; addr: string; flags: number; a?: number }
  | { t: 'num'; addr: string; bytes: number; digits: number; a?: number }
  | { t: 'move'; coord: number }
  | { t: 'box'; coord: number; h: number; w: number }
  | { t: 'low' }
  | { t: 'promptbutton' }
  | { t: 'scroll' }
  | { t: 'pause' }
  | { t: 'waitbutton' }
  | { t: 'dots'; n: number }
  | { t: 'sound'; id: number }
  /** Game Boy code takes over here; handled by the ported script for `label`. `at` = ROM offset of the code. */
  | { t: 'asm'; label: string; at?: number };

/**
 * text_asm routines that are pure data in disguise, recognised from their
 * exact instruction bytes (see src/rom/extract/simpleAsm.ts):
 *  - print: `ld hl, Text / call PrintText / jp TextScriptEnd` (directly or via farcall/callfar)
 *  - trainer: `ld hl, <Map>TrainerHeaderN / call TalkToTrainer / jp TextScriptEnd`
 */
/**
 * A text_asm routine compiled from the ROM (src/rom/extract/simpleAsm.ts). Nodes
 * run from `entry`, each naming the node that follows; `test`, `give` and the
 * branches use the Z/C flags as the SM83 code does.
 */
export type AsmNode =
  | { op: 'print'; text: string; next: number }
  | { op: 'trainer'; header: number; next: number }
  | { op: 'cry'; species: number; next: number }
  | { op: 'yesno'; next: number }
  /**
   * Read a WRAM byte: `cmp` sets Z (equal) and C (less than; not with `zOnly`, as for `dec a`),
   * `bit` sets Z when the bit is clear, or C when it is set with `toCarry` (rrca/add a).
   */
  | { op: 'test'; addr: number; cmp?: number; bit?: number; zOnly?: boolean; toCarry?: boolean; next: number }
  | { op: 'setbit'; addr: number; bit: number; value: boolean; next: number }
  | { op: 'branch'; cond: 'z' | 'nz' | 'c' | 'nc'; to: number; next: number }
  /** GiveItem: C on success (the item name goes to wStringBuffer). */
  | { op: 'give'; item: number; qty: number; next: number }
  /** RemoveItemByID (hItemToRemoveID = item): one of the item leaves the bag */
  | { op: 'take'; item: number; next: number }
  | { op: 'toggle'; toggle: number; visible: boolean; next: number }
  | { op: 'noWait'; value: boolean; next: number }
  | { op: 'delay'; frames: number; next: number }
  | { op: 'sound'; id: number; waitForCurrent?: boolean; next: number }
  | { op: 'waitSound'; next: number }
  | { op: 'music'; stop: boolean; next: number }
  /** IsItemInBag: Z when the item is not in the bag. */
  | { op: 'testItem'; item: number; next: number }
  | { op: 'pokedex'; species: number; next: number }
  /** OaksAideScript; the OAKS_AIDE_* result goes to hOaksAideResult */
  | { op: 'oaksAide'; requirement: number; item: number; next: number }
  /** DoInGameTradeDialogue for wWhichTrade = which */
  | { op: 'trade'; which: number; next: number }
  /** w<map>CurScript = value (map by its label); without a value, a copy of wCurMapScript */
  | { op: 'mapScript'; map: string; value?: number; next: number }
  /** wCurMapScript = value */
  | { op: 'setScript'; value: number; next: number }
  | { op: 'movingDir'; value: number; next: number }
  /** hJoyHeld/hJoyPressed/hJoyReleased = 0 */
  | { op: 'clearJoy'; next: number }
  | { op: 'end' };
export interface SimpleAsm {
  entry: number;
  nodes: AsmNode[];
}

/** One step of a straight-line map script (Pokémon Centers, marts, gates, underground paths…). */
export type MapScriptOp =
  | { op: 'autoTextBox'; on: boolean }
  | { op: 'autoTextBoxControl'; value: number }
  | { op: 'lastMap'; map: number }
  | { op: 'pikachuMapScript'; on: boolean };

/** A map text-pointer target: either a text stream or a special text script. */
export type MapTextEntry =
  | { kind: 'text'; label: string }
  | { kind: 'pokecenter_nurse' }
  | { kind: 'mart'; items: number[] }
  | { kind: 'bills_pc' }
  | { kind: 'players_pc' }
  | { kind: 'pokecenter_pc' }
  | { kind: 'prize_vendor' }
  | { kind: 'cable_club_receptionist' }
  | { kind: 'vending_machine' };

// ------------------------------------------------------------------ maps
export type Direction = 'north' | 'south' | 'west' | 'east';

export interface MapConnection {
  map: number;
  /** Offset of the target map relative to this one, in blocks (as in the disassembly's `connection` macro). */
  offset: number;
}

export interface WarpEvent {
  x: number;
  y: number;
  /** Destination map id; 255 = LAST_MAP (the outdoor map the player came from). */
  destMap: number;
  /** 0-based destination warp index. */
  destWarp: number;
}

export interface BgEvent {
  x: number;
  y: number;
  textId: number;
}

export type ObjectKind = 'npc' | 'item' | 'trainer' | 'pokemon';

export interface ObjectEvent {
  /** 1-based object index on the map (matches the map's object constants). */
  index: number;
  sprite: number;
  x: number;
  y: number;
  /** $FE = WALK, $FF = STAY */
  movement: number;
  /** Range (ANY_DIR/UP_DOWN/LEFT_RIGHT) for WALK, facing direction for STAY. */
  rangeOrDirection: number;
  textId: number;
  kind: ObjectKind;
  item?: number;
  trainerClass?: number;
  trainerIndex?: number;
  species?: number;
  level?: number;
}

/** A trainer header (the `trainer` macro): sight, defeat flag and texts. */
export interface TrainerHeader {
  /** Object index of the trainer sprite (also the flag bit within its byte). */
  spriteIndex: number;
  /** Sight range in squares. */
  engageDistance: number;
  /** Event flag index set when the trainer is beaten. */
  eventFlag: number;
  beforeText: string;
  afterText: string;
  endBattleText: string;
}

export interface MapData {
  id: number;
  /** Constant name, e.g. PALLET_TOWN. */
  constName: string;
  /** Label stem, e.g. PalletTown. */
  label: string;
  tileset: number;
  /** Size in blocks (each block = 2x2 walkable squares = 4x4 tiles). */
  width: number;
  height: number;
  blocks: number[];
  borderBlock: number;
  connections: Partial<Record<Direction, MapConnection>>;
  warps: WarpEvent[];
  signs: BgEvent[];
  objects: ObjectEvent[];
  /** Text ID (1-based) -> entry. */
  texts: Record<number, MapTextEntry>;
  /** Label of the map's script routine (ported by hand in src/script/maps). */
  scriptLabel: string;
  music: { id: number; bank: number };
  trainerHeaders: TrainerHeader[];
  /**
   * Shape of <Map>_Script recognised from its bytes:
   *  'auto' = only EnableAutoTextBoxDrawing; 'trainers' = the standard
   *  CheckFightingMapTrainers / DisplayEnemyTrainerTextAndStartBattle /
   *  EndTrainerBattle table; 'custom' = needs a hand-ported script.
   */
  /**
   * Boilerplate map scripts recognised from their bytes: `simple` (straight-line setup, see
   * `scriptOps`), `trainers` (the standard trainer script table) or `custom` (hand-ported).
   */
  scriptKind: 'simple' | 'trainers' | 'custom';
  scriptOps?: MapScriptOp[];
  /** Alternate text pointer tables scripts switch to (label -> text id -> entry). */
  altTexts: Record<string, Record<number, MapTextEntry>>;
}

// --------------------------------------------------------------- tilesets
export interface TilesetData {
  id: number;
  name: string;
  /** 2bpp pixel indices (0-3), 8x8 per tile, row-major: tiles[t*64 + y*8 + x]. */
  tilePixels: number[];
  tileCount: number;
  /** 16 tile ids per block, row-major 4x4. */
  blocks: number[][];
  /** Tile ids the player can stand on. */
  passable: number[];
  counterTiles: number[];
  grassTile: number;
  animation: number;
  warpTiles: number[];
  doorTiles: number[];
}

export interface TileTables {
  ledges: { facing: number; standing: number; ledge: number; input: number }[];
  pairCollisionsLand: { tileset: number; a: number; b: number }[];
  pairCollisionsWater: { tileset: number; a: number; b: number }[];
  waterTilesets: number[];
  shoreTiles: number[];
  waterTile: number;
  cutTreeBlocks: { from: number; to: number }[];
  bookshelves: { tileset: number; tile: number; textLabel: string }[];
  warpPadsAndHoles: { tileset: number; tile: number; kind: number }[];
  dungeonTilesets: number[];
  escapeRopeTilesets: number[];
  bikeRidingTilesets: number[];
  /** ForcedBikeOrSurfMaps: entering these squares puts the player on the bike (Cycling Road) or surfing (Seafoam). */
  forcedBikeOrSurf: { map: number; x: number; y: number }[];
  warpCarpets: Record<'down' | 'up' | 'left' | 'right', number[]>;
  /** FlowerTile1-3 (2bpp pixels, 64 each) cycled into tile $03 by UpdateMovingBgTiles. */
  flowerTiles: number[][];
  /** PlayerJumpingYScreenCoords: player sprite Y per loop iteration of a ledge hop (normal = $3C). */
  playerJumpingY: number[];
}

// ----------------------------------------------------------------- sprites
/**
 * Player sheets outside SpriteSheetPointerTable, stored as sprite ids NUM_SPRITES + 1 + index:
 * the bike and Surfing Pikachu sheets, the fishing pose (RedSprite's standing frames with
 * RedFishingTilesFront/Back/Side over their lower halves, as FishingAnim loads them) and the
 * rod (RedFishingRodTiles $fd/$fe placed per FishingRodOAM: down, up, left frames).
 */
export const EXTRA_SHEETS = [
  'RedBikeSprite',
  'SurfingPikachuSprite',
  'RedFishingSprite',
  'FishingRod',
  /** InitCutAnimOAM's tree (Overworld_GFX $2d/$2e over $3d/$3e): frame 0 left column, frame 1 right */
  'CutTree',
  /** LoadCutGrassAnimationTilePattern: MoveAnimationTiles1 tile 6, centred */
  'CutLeaf',
  /** LoadSmokeTileFourTimes: SSAnneSmokePuffTile in a 2x2 block */
  'BoulderDust',
] as const;

export interface OverworldSprite {
  id: number;
  name: string;
  /** Number of 8x8 tiles (4 = single still frame, 12 = 3 standing frames, 24 = with walking frames). */
  tileCount: number;
  /** 2bpp pixel indices, frames of 16x16, frame-major then row-major: px[f*256 + y*16 + x]. */
  pixels: number[];
  frames: number;
}

export interface PaletteData {
  /** SGB "super palettes": 4 colors each as [r,g,b] 0-31. Indexed by PAL_* constant. */
  superPalettes: [number, number, number][][];
  /** Per species (dex order index, 0 = MissingNo) palette id. */
  monsterPalettes: number[];
}

export interface TileSheet {
  firstChar?: number;
  count: number;
  /** Pixel indices 0-3, 64 per 8x8 tile. */
  pixels: number[];
}

export interface UiGraphics {
  /** Main font, chars $80-$FF. */
  font: TileSheet;
  /** Box borders, quotes, etc., chars $60-$7F. */
  fontExtra: TileSheet;
  hpBarAndStatus: TileSheet;
  pokeballs: TileSheet;
  pokedexTiles: TileSheet;
  /** vSprites tiles 0-127 after LoadMonPartySpriteGfx, and each dex number's ICON_* id. */
  partyIcons: { tiles: number[]; byDex: number[] };
  emotionBubbles: TileSheet;
  /** 1bpp "ED" glyph used by the naming screen (shown as char $F0). */
  edTile: number[];
  /** The printer stat card's HP and Lv glyphs (1bpp as color 3). */
  printerGlyphs: { hp: number[]; lv: number[] };
  /** The slot machine (engine/slots/slot_machine.asm): tiles, the 20x12 tilemap, the three wheels' bytes. */
  slots: { tiles1: number[]; tiles2: number[]; map: number[]; wheels: number[][]; multiplier: string; rewards: string[] };
  /** The diploma's tiles (at $00), its Pikachu/Mew tilemaps, CONGRATULATIONS! tiles and strings. */
  /** The title screen's graphics, tilemaps, the eyes' OAM, the logo bounce table and the copyright tiles. */
  title: {
    copyrightLogo: number[];
    nine: number[];
    gameFreakLogo: number[];
    pokemonLogo: number[];
    pokemonLogoCorner: number[];
    pikachuBG: number[];
    pikachuOB: number[];
    logoTilemap: number[];
    bubbleTilemap: number[];
    pikachuTilemap: number[];
    eyes: [number, number, number, number][];
    bounce: [number, number][];
    copyright: number[];
  };
  /** The trainer card's tiles (text box frame + background, leader-name blanks + circle, badge numbers, faces/badges) and ◯BADGES◯. */
  trainerCard: { infoTiles: number[]; blankNames: number[]; badgeNumbers: number[]; facesAndBadges: number[]; badgesText: number[] };
  /** The credits roll: CreditsOrder (CRED_* ids, negative = commands), texts by CRED id (x offset from column 9), mons, THE END and copyright tiles. */
  credits: {
    order: number[];
    texts: { dx: number; text: string }[];
    mons: number[];
    theEnd: number[];
    copyrightTiles: number[];
    copyrightRows: number[][];
  };
  diploma: {
    tiles: number[];
    pikachuMap: number[];
    congratulations: number[];
    mewMap: number[];
    /** DiplomaText as raw codes (the circle tile $10 around "Diploma") */
    title: number[];
    player: string;
    congrats: string;
    gameFreak: string;
    playTime: string;
  };
  /** Naming screen alphabets: 45 raw char codes (5 rows × 9) + the case-switch label. */
  alphabets: { upper: number[]; lower: number[]; upperSwitch: string; lowerSwitch: string };
  /** TwoOptionMenuStrings, indexed by *_MENU (YES_NO_MENU = 0 ...). */
  twoOptionMenus: { width: number; height: number; blankLine: boolean; text: string }[];
}

// ----------------------------------------------------------------- pokemon
export interface SpeciesData {
  /** Internal index (1-190). */
  index: number;
  constName: string;
  name: string;
  dex: number;
  baseStats: { hp: number; atk: number; def: number; spd: number; spc: number };
  types: [number, number];
  catchRate: number;
  baseExp: number;
  frontSpriteDims: number;
  level1Moves: number[];
  growthRate: number;
  /** TM/HM learnability, by TM number 1-55 (51-55 = HM01-05). */
  tmhm: number[];
  evolutions: Evolution[];
  learnset: { level: number; move: number }[];
}

export type Evolution =
  | { method: 'level'; level: number; species: number }
  | { method: 'item'; item: number; minLevel: number; species: number }
  | { method: 'trade'; minLevel: number; species: number };

export interface DexEntry {
  dex: number;
  category: string;
  heightFeet: number;
  heightInches: number;
  weightTenthsLb: number;
  textLabel: string;
}

export interface MoveData {
  id: number;
  constName: string;
  name: string;
  animation: number;
  effect: number;
  power: number;
  type: number;
  /** Accuracy as a 0-255 value (as stored in ROM). */
  accuracy: number;
  pp: number;
}

export interface TypeData {
  /** Type id -> display name ('' for unused ids). */
  names: Record<number, string>;
  /** Attacker type, defender type, multiplier x10 (0, 5, 20). Order is significant (Gen 1 applies sequentially). */
  chart: [number, number, number][];
}

export interface ItemData {
  id: number;
  constName: string;
  name: string;
  price: number;
  /** Key item (IsKeyItem): can't be sold or tossed and shows no quantity. */
  isKey: boolean;
}

// -------------------------------------------------------------- encounters
export interface WildTable {
  rate: number;
  slots: { level: number; species: number }[];
}

export interface WildData {
  grass: Record<number, WildTable>;
  water: Record<number, WildTable>;
  /** Cumulative slot thresholds (0-255). */
  slotChances: number[];
  oldRod: { species: number; level: number };
  goodRod: { species: number; level: number }[];
  superRod: Record<number, { species: number; level: number }[]>;
}

// ---------------------------------------------------------------- trainers
export interface TrainerParty {
  /** Pokémon in the party (species internal id, level). */
  mons: { species: number; level: number }[];
}

export interface TrainerClassData {
  id: number;
  constName: string;
  name: string;
  /** The first two BCD bytes copied by GetTrainerInformation; prize = base * last mon level. */
  baseMoney: number;
  picLabel: string;
  parties: TrainerParty[];
  aiMoveChoiceModifications: number[];
}

/** A decompressed pic: width×width tiles of 2bpp data, base64-encoded. */
export interface Pic {
  width: number;
  data: string;
}

// ------------------------------------------------------------------ bundle
/** The Surfing Pikachu minigame (bundle.surfing, see src/rom/extract/surfing.ts). */
/** Battle animations (engine/battle/animations.asm and its data) */
export interface BattleAnimData {
  /** AttackAnimationPointers (animation id - 1): 3-byte subanimation commands (tileset << 6 | delay, sound, subanim) or 2-byte special effects (id, sound) */
  attacks: number[][];
  /** SubanimationPointers: type (SUBANIMTYPE_*) and (frame block, base coord, frame block mode) entries */
  subanims: { type: number; entries: [number, number, number][] }[];
  /** FrameBlockPointers: (y, x, tile, OAM attributes) per tile */
  frameBlocks: [number, number, number, number][][];
  /** FrameBlockBaseCoords: (y, x) */
  baseCoords: [number, number][];
  /** MoveAnimationTiles0/1/2 (loaded at OBJ tile $31) */
  tilesets: number[][];
  /** TileIDListPointerTable's pic tilemaps (tile IDs, row-major) */
  tilemaps: { mon: number[]; slideDown7x5: number[]; slideDown7x3: number[] };
  /** FlashScreenLongSGB rBGP values */
  flashScreenLong: number[];
  /** SpiralBallAnimationCoordinates (y, x pairs) */
  spiralBalls: number[];
  /** WavyScreenLineOffsets (signed) */
  wavyScreen: number[];
  fallingDeltaXs: number[];
  fallingXs: number[];
  fallingMovement: number[];
  /** MinimizedMonSprite: 5 rows of 1bpp */
  minimized: number[];
  ballMoveDistances1: number[];
  ballMoveDistances2: number[];
  /** AnimationIdSpecialEffects: animation id, routine name */
  specialEffectsById: [number, string][];
}

export interface SurfingData {
  graphics1: number[];
  graphics2: number[];
  graphics3: number[];
  highScoreGraphics: number[];
  beachIntro: number[];
  useControlPad: number[];
  toSurfRad: number[];
  title: number[];
  beachOutro: number[];
  statusBar: number[];
  /** 2x2-tile metatiles, 4 bytes each */
  metatiles: number[];
  waveSequenceStarts: number[];
  waveFunctions: ({ kind: 'choose' } | { kind: 'pattern'; heights: [number, number]; pattern: number[]; next: 'advance' | 'reset' | 'stay' })[];
  lyInitialSine: number[];
  sine: number[];
  tempos: number[];
  spawn: [number, number, number][];
  frames: number[][];
  oam: { tile: number; sprites: [number, number, number, number][] }[];
  strings: { hiScore: number[]; hpLeft: number[]; radness: number[]; total: number[] };
  highScore: { tilemap1: number[]; tilemap2: number[]; pikachusBeach: string; hiScore: string; points: string };
}

/** The intro before the title screen (bundle.intro, see src/rom/extract/intro.ts). */
export interface IntroData {
  gameFreak: number[];
  starTiles: number[];
  fallingStar: number[];
  logoOam: [number, number, number, number][];
  shootingStarOam: [number, number, number, number][];
  smallStarOam: [number, number, number, number];
  smallStarWaves: [number, number, number][][];
  graphics1: number[];
  graphics2: number[];
  clouds: number[];
  tilemapSky: number[];
  tilemapCloud: number[];
  tilemapSmall: number[];
  speedBars: [number, number, number][];
  thunderPals: number[];
  fadePals: number[];
  sineWave: number[];
  sine: number[];
  anim: import('../gb/animatedObjects').AnimObjectData;
}

/** The sound engine's ROM data (bundle.audio, see src/rom/extract/audio.ts). */
export interface AudioData {
  /** BANK(Audio1_PlaySound) … BANK(Audio4_PlaySound) */
  engineBanks: number[];
  /** Each audio bank's 16 KB, base64 */
  banks: Record<number, string>;
  /** In-bank addresses of SFX_Headers_1-4 and Audio1-4_CryRet */
  sfxHeaders: number[];
  cryRet: number[];
  /** Audio1_Pitches (C..B at octave 7), the hardware channel tables, Audio1_WavePointers */
  pitches: number[];
  hwBase: number[];
  disableMasks: number[];
  enableMasks: number[];
  wavePointers: number[];
  /** BANK(Music_*) per MUSIC_* constant */
  musicBanks: Record<string, number>;
  /** CryData by species index - 1: [base cry, pitch, length] */
  cryData: [number, number, number][];
  /** In-bank addresses of labels special routines point channels at */
  labels: Record<string, number>;
  /** PokedexRatingSfxPointers: [sound id, bank] */
  pokedexRatingSfx: [number, number][];
  /** Music_DoLowHealthAlarm's tone data (hi, lo, silence; 4 bytes each) */
  /** MoveSoundTable: 3 bytes per entry (sound ID, pitch modifier, tempo modifier) */
  moveSounds: number[];
  lowHealthTones: number[];
}

export interface GameBundle {
  meta: BundleMeta;
  maps: Record<number, MapData>;
  /** Global list indexed by toggle id (HideObject/ShowObject). */
  toggleableObjects: { map: number; object: number; initiallyVisible: boolean }[];
  tilesets: TilesetData[];
  tileTables: TileTables;
  sprites: OverworldSprite[];
  palettes: PaletteData;
  ui: UiGraphics;
  species: Record<number, SpeciesData>;
  /** Internal index -> dex number. */
  dexOrder: number[];
  dexEntries: Record<number, DexEntry>;
  /** GrowthRateTable: exp(n) = a/b·n³ + c·n² + d·n − e, indexed by GROWTH_* */
  growthRates: { a: number; b: number; c: number; d: number; e: number }[];
  /** DexRatingsTable: first entry whose `below` exceeds the owned count applies. */
  dexRatings: { below: number; textLabel: string }[];
  moves: MoveData[];
  types: TypeData;
  items: ItemData[];
  wild: WildData;
  trainers: TrainerClassData[];
  texts: Record<string, TextOp[]>;
  /** Fly/blackout destinations by map, dungeon warps, Safari Zone rest houses (special_warps.asm). */
  specialWarps: {
    fly: Record<number, { x: number; y: number }>;
    dungeon: { map: number; warp: number; x: number; y: number }[];
    restHouses: number[];
  };
  /** Small event tables: GuardDrinksList (Saffron gate guards). */
  misc: {
    guardDrinks: number[];
    roofDrinks: number[];
    /** <Elevator>Floors (FLOOR_* items) and <Elevator>WarpMaps by elevator label */
    elevators: Record<string, { floors: number[]; warps: { warp: number; map: number }[] }>;
    /** <Map>ArrowTilePlayerMovement: spinner squares and their RLE joypad lists (pad, count pairs) */
    /** LedgeHoppingShadow's 8x8 tile (color indices; drawn with its x-flipped copy beside it) */
    ledgeShadow: number[];
    /** SpinnerArrowAnimTiles (LoadSpinnerArrowTiles) */
    spinnerTiles: number[][];
    arrowTiles: Record<string, { x: number; y: number; rle: number[] }[]>;
    /** The Oak-speech name menus and the names they pick (NEW NAME first) */
    defaultNames: Record<'player' | 'rival', { menu: string; names: string[] }>;
    /** Toggleable objects hidden/shown when Team Rocket leaves Silph Co. */
    silphRocketsLeave: { hide: number[]; show: number[] };
    /** PrizeDifferentMenuPtrs (two Pokémon windows, then TMs) and PrizeMonLevelDictionary */
    prizes: { entries: number[]; costs: number[] }[];
    prizeMonLevels: Record<number, number>;
  };
  /** The Town Map (engine/items/town_map.asm). */
  surfing: SurfingData;
  battleAnims: BattleAnimData;
  intro: IntroData;
  audio: AudioData;
  townMap: {
    /** WorldMapTileGraphics, loaded at tile $60 (2bpp pixels). */
    tiles: number[];
    /** 20x18 tile codes decoded from CompressedMap. */
    tilemap: number[];
    /** TownMapCursor (4 tiles), TownMapUpArrow, MonNestIcon: 1bpp as color 3. */
    cursor: number[];
    upArrow: number[];
    nestIcon: number[];
    /** BirdSprite's first frame (4 tiles, 2bpp). */
    bird: number[];
    /** ExternalMapEntries by map id (outdoor maps), then InternalMapEntries groups: maps below `below` use it. */
    external: { x: number; y: number; name: string }[];
    internal: { below: number; x: number; y: number; name: string }[];
    /** TownMapOrder: the maps the cursor steps through. */
    order: number[];
    strings: { to: string; nest: string; areaUnknown: string };
  };
  /** Move taught by TM01-TM50 then HM01-HM05 (TechnicalMachines). */
  tmMoves: number[];
  /** In-game trades: TradeMons, the dialog text sets (wanna trade, no, wrong mon, thanks, after) and the OT name. */
  trades: {
    mons: { give: number; get: number; dialog: number; nick: string }[];
    texts: string[][];
    otName: string;
    /** The trade animation: TradingAnimationGraphics (BG tiles $31+), TradingAnimationGraphics2 (OBJ tiles $7C+), the Game Boy (6x8) and link cable (12x3) tilemaps */
    anim: { gfx: number[]; gfx2: number[]; gameBoy: number[]; linkCable: number[] };
  };
  /** Talking to Pikachu: emotion scripts and the Pikachu picture animations. */
  pikachuEmotions: {
    /** PikachuEmotionTable: PIKAEMOTION_* commands (text label, movement bytes or one-byte argument). */
    emotions: { op: number; arg?: number; text?: string; movement?: number[] }[][];
    /** PikachuMoodLookupTable: [mood threshold, column]. */
    moods: [number, number][];
    /** PikaPicAnimationScriptPointerLookupTable rows: happiness threshold, then a pikapic id per column. */
    happiness: number[][];
    pikapic: {
      /** PikaPicAnimPointers: commands with their arguments; `next`/jump arguments are command indices. */
      scripts: { entry: number; cmds: { op: number; args: number[]; next: number }[] }[];
      /** PikaPicAnimBGFramesPointers: tilemap id, duration pairs. */
      frames: number[][];
      tilemaps: { rows: number; cols: number; tiles: number[] }[];
      /** PikaPicAnimGFXHeaders: tile count ($ff = a compressed pic, loaded as 49 tiles) and the 2bpp data (base64). */
      gfx: { size: number; data: string }[];
      /** PikaPicAnimThunderboltPals: frames, BGP */
      thunderboltPals: [number, number][];
    };
    /** Pikachu's PCM cries (PikachuCriesPointerTable): sample byte count and 1-bit samples (base64). */
    cries: { length: number; data: string }[];
  };
  /** Hidden events (CheckForHiddenEvent) and the tables their routines use. */
  hidden: {
    /** Per map: the square, the function argument and the routine's label. */
    events: Record<number, { x: number; y: number; arg: number; fn: string }[]>;
    /** TextPredefs by id (1-based). */
    textPredefs: Record<number, MapTextEntry>;
    /** TextPredefs id of each text label (<label>_id). */
    predefIds: Record<string, number>;
    bookshelves: { tileset: number; tile: number; predef: number }[];
    /** Index = the bit in wObtainedHiddenItemsFlags / wObtainedHiddenCoinsFlags. */
    itemCoords: { map: number; x: number; y: number }[];
    coinCoords: { map: number; x: number; y: number }[];
    benchGuys: { map: number; facing: number; predef: number }[];
    mapBadgeFlags: { map: number; mask: number }[];
    /** GymTrashCans3c bytes (9 per can: count, four can pairs) plus the bytes after it the sampling bug can reach. */
    trashCans: number[];
    cinnabarGates: { x: number; y: number; block: number }[];
    vendingPrices: { item: number; price: number }[];
    /** PikachuMovementDatabase: func1, param1 ($80 = from script), func2, param2 per command. */
    pikachuMovement: number[];
    /** SineWave_3f used by the Pikachu hop animation. */
    pikachuSine: number[];
    silphCoMaps: number[];
  };
  battle: {
    /** FieldMoveDisplayData with FieldMoveNames: move, menu name, leftmost menu column. */
    fieldMoves: { move: number; name: string; x: number }[];
    /** UsableItems_PartyMenu / UsableItems_CloseMenu (START → ITEM). */
    usableParty: number[];
    usableCloseMenu: number[];
    /** gfx/font/P.1bpp (status screen "PP"). */
    pTile: number[];
    /** BattleTransition data: dungeon map lists, circle shapes and the flash palettes. */
    transitions: {
      dungeon1: number[];
      dungeon2: [number, number][];
      circleData: number[][];
      halfCircle1: { right: boolean; data: number; x: number; y: number }[];
      halfCircle2: { right: boolean; data: number; x: number; y: number }[];
      flash: number[];
    };
    /** MonsterSprite tiles 0-7 (front: 0-3, back: 4-7), used for the Substitute doll. */
    substituteTiles: number[];
    /** HappinessChangeTable rows (unsigned bytes; >= 100 means negative) by PIKAHAPPY_* - 1, columns by happiness bracket. */
    happinessChange: number[][];
    /** PikachuMoods by PIKAHAPPY_* - 1. */
    pikachuMoods: number[];
    /** MoveGrammar groups (index = grammar id used by UsedMoveText). */
    moveGrammar: number[][];
    /** TrainerAIPointers by trainer class id - 1: uses per mon and the AI routine label. */
    trainerAI: { count: number; routine: string }[];
    residualEffects1: number[];
    residualEffects2: number[];
    specialEffects: number[];
    specialEffectsCont: number[];
    alwaysHappenSideEffects: number[];
    setDamageEffects: number[];
    highCriticalMoves: number[];
    /** StatModifierRatios: [numerator, denominator] for stages 1..13 (7 = neutral). */
    statModifierRatios: [number, number][];
    specialTrainerMoves: { trainerClass: number; trainerNo: number; moves: { mon: number; slot: number; move: number }[] }[];
    /** BattleHudTiles1 (3 tiles at $6D) and BattleHudTiles2+3 (6 tiles at $73), 1bpp expanded. */
    hudTiles1: number[];
    hudTiles23: number[];
  };
  pics: {
    /** By species index. */
    front: Record<number, Pic>;
    back: Record<number, Pic>;
    /** By trainer class id. */
    trainers: Record<number, Pic>;
    /** RedPicFront, RedPicBack, OldManPicBack, ProfOakPicBack, GhostPic, Fossil*Pic */
    special: Record<string, Pic>;
  };
  /** Menu/UI strings ("@"-terminated, may contain {next}) by ROM label. */
  strings: Record<string, string>;
  /** Recognised trivial text_asm routines keyed by the asm op's label. */
  simpleAsm: Record<string, SimpleAsm>;
}
