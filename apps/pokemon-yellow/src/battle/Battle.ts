/**
 * The battle engine: a port of engine/battle/core.asm (StartBattle,
 * MainInBattleLoop, fainting, send-outs, running), init_battle.asm,
 * read_trainer_party.asm and end_of_battle.asm. Move execution lives in
 * moves.ts, move effects in effects.ts, the trainer AI in ai.ts, experience
 * in experience.ts and item use in ../items.
 *
 * Every routine is a frame coroutine (`Co`), so delays, text and menus run on
 * emulated frames like the original. Variables mirror the WRAM battle
 * variables; comments name the original labels.
 */
import { withoutTextAsm } from '../rom/text';
import { MoveAnimator } from './moveAnims';
import { BATTLE_PALETTE_BLOCKS, battlePaletteIds, healthBarColor } from './palettes';
import type { Co, Engine } from '../engine/Engine';
import type { BattleRequest, BattleResult } from '../engine/battle';
import type { ItemSlot, PartyMon } from '../game/state';
import type { TextOp } from '../data/schema';
import type { TextContext } from '../ui/TextPrinter';
import { c } from '../rom/constants';
import { ramSym } from '../rom/symbols';
import { calcStats, makePartyMon, initialMoves, movePP, ZERO_STAT_EXP, species as speciesData } from '../game/pokemon';
import { BattleUI, type HudMon } from './BattleUI';
import { CANNOT_MOVE, M, newSide, pct, S1, S2, S3, ST, type BattleMon, type Side } from './state';
import { applyBadgeStatBoosts, applyBurnAndParalysisPenalties, executeEnemyMove, executePlayerMove, getCurrentMove } from './moves';
import { selectEnemyMove, trainerAI } from './ai';
import { gainExperience } from './experience';
import { playMoveAnimation, playApplyingAttackAnimation } from './animation';
import { battleMenu, moveSelectionMenu } from './menus';
import { partyMenu, type PartyMenuMode } from '../ui/partyMenu';
import { evolutionAfterBattle } from '../game/evolution';
import { isPlayerPikachuAsleepInParty, isStarterPikachu, modifyPikachuHappiness, moodAfterBattle } from '../game/pikachu';
import { twoOptionMenu } from '../ui/menus';
import { battleTransition } from './transition';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';

export const WILD_BATTLE = 1;
export const TRAINER_BATTLE = 2;

export class Battle {
  readonly ui: BattleUI;
  readonly player: Side = newSide();
  readonly enemy: Side = newSide();
  /** Working copies committed to the store at the end of the battle (and on capture/blackout). */
  party: PartyMon[];
  bag: ItemSlot[];
  enemyParty: PartyMon[] = [];

  // --- wIsInBattle, wBattleType, trainer info
  isInBattle = WILD_BATTLE;
  battleType: number;
  trainerClass = 0;
  trainerNo = 0;
  trainerName = '';
  trainerBaseMoney = 0;
  amountMoneyWon = 0;
  gymLeaderNo = 0;
  curEnemyLevel = 0;
  enemySpecies2 = 0;
  /** wEnemyMonBaseStats.. wEnemyMonBaseExp (halved by Exp. All, divided by GainExperience). */
  enemyBaseStats = { hp: 0, atk: 0, def: 0, spd: 0, spc: 0 };
  enemyBaseCatchRate = 0;
  enemyBaseExp = 0;

  // --- turn state
  whoseTurn = 0;
  damage = 0;
  moveMissed = 0;
  criticalHitOrOHKO = 0;
  damageMultipliers = 10;
  moveDidntMiss = 0;
  monIsDisobedient = 0;
  actionResult = 0; // wActionResultOrTookBattleTurn
  escapedFromBattle = 0;
  battleResult = 0;
  numRunAttempts = 0;
  forcePlayerToChooseMon = 0;
  inHandlePlayerMonFainted = 0;
  firstMonsNotOutYet = 1;
  playerMonNumber = 0;
  enemyMonPartyPos = 0xff;
  whichPokemon = 0;
  partyGainExpFlags = 0;
  partyFoughtCurrentEnemyFlags = 0;
  aiCount = 0xff;
  aiLayer2Encouragement = 0;
  lastSwitchInEnemyMonHP = 0;
  totalPayDayMoney = 0;
  transformedEnemyMonOriginalDVs = 0;
  capturedMonSpecies = 0;
  boostExpByExpAll = 0;
  gainBoostedExp = 0;
  lowHealthAlarmDisabled = 0;
  /** The battle animation engine and its state (wAnimationID, wPokeBallAnimData, ...) */
  readonly anim = new MoveAnimator(this);
  numSafariBalls = 0;
  safariBaitFactor = 0;
  safariEscapeFactor = 0;
  /** Set by AIIncreaseStat & co: the item the AI used (wAIItem). */
  aiItem = 0;

  // --- menu memory
  battleAndStartSavedMenuItem = 0;
  bagSavedMenuItem = 0;
  currentMenuItem = 0;
  maxMenuItem = 0;
  menuItemToSwap = 0;
  moveMenuType = 0;

  /** Text buffers addressed by text_ram / text_decimal (aliases resolved like RAM: last write wins). */
  readonly mem = new Map<number, string | number>();

  screenBuf1?: Int16Array;
  screenBuf2?: Int16Array;

  constructor(
    readonly e: Engine,
    readonly req: BattleRequest,
  ) {
    this.ui = new BattleUI(e);
    this.party = structuredClone(e.state.party);
    this.bag = structuredClone(e.state.bag);
    this.battleType = req.battleType;
    this.gymLeaderNo = req.gymLeaderNo ?? 0;
    this.numSafariBalls = e.state.vars.wNumSafariBalls ?? 0;
  }

  get bundle() {
    return this.e.bundle;
  }

  // ------------------------------------------------------------ helpers
  random(): number {
    // BattleRandom = Random outside link battles
    return this.e.random();
  }

  side(turn: number): Side {
    return turn ? this.enemy : this.player;
  }
  /** The side whose turn it is (attacker) and the other one. */
  get att(): Side {
    return this.side(this.whoseTurn);
  }
  get def(): Side {
    return this.side(this.whoseTurn ^ 1);
  }

  setMem(name: string, value: string | number): void {
    this.mem.set(ramSym(name), value);
  }

  textContext(): Partial<TextContext> {
    const enemyName = `Enemy ${this.enemy.mon.nick}`;
    const user = this.whoseTurn ? enemyName : this.player.mon.nick;
    const target = this.whoseTurn ? this.player.mon.nick : enemyName;
    return {
      user,
      target,
      ...(this.simulatedTrainerName ? { playerName: this.simulatedTrainerName } : {}),
      ram: (label: string, addr?: number) => {
        if (addr === ramSym('wEnemyMonNick')) return this.enemy.mon.nick;
        if (addr === ramSym('wBattleMonNick')) return this.player.mon.nick;
        if (addr === ramSym('wTrainerName')) return this.trainerName;
        if (addr === ramSym('wPlayerNumHits')) return this.player.numHits;
        if (addr === ramSym('wEnemyNumHits')) return this.enemy.numHits;
        if (addr === ramSym('wCurEnemyLevel')) return this.curEnemyLevel;
        if (addr === ramSym('wAmountMoneyWon')) return this.amountMoneyWon;
        if (addr === ramSym('wTotalPayDayMoney')) return this.totalPayDayMoney;
        if (addr !== undefined && this.mem.has(addr)) return this.mem.get(addr);
        return this.e.ramValue(label, addr);
      },
    };
  }

  /** Concatenate text streams (text_far chains) without their text_asm hand-offs. */
  ops(...labels: string[]): TextOp[] {
    return labels.flatMap((l): TextOp[] => {
      if (l === '<pause>') return [{ t: 'pause' }];
      const t = this.bundle.texts[l];
      if (!t) throw new Error(`battle text ${l} missing from bundle`);
      return withoutTextAsm(t);
    });
  }

  /** PrintText with one or more chained text labels. */
  *print(...labels: string[]): Co {
    yield* this.e.printOps(this.ops(...labels), this.textContext());
  }

  /** PrintEmptyString */
  *printEmptyString(): Co {
    yield* this.e.printOps([], this.textContext());
  }

  *delay(n: number): Co {
    yield* this.e.delayFrames(n);
  }

  sound(id: string | number): void {
    this.e.hooks.playSound?.(id);
  }

  /** PrintBeginningBattleText.playSFX */
  private *trainerAppearedSfx(): Co {
    this.e.sound.setModifiers(0, 0x80);
    this.sound('SFX_TRAINER_APPEARED');
    yield* this.e.waitForSoundToFinish();
  }

  /** PlayCry: the cry, then WaitForSoundToFinish */
  *playCry(species: number): Co {
    this.e.hooks.playCry?.(species);
    yield* this.e.waitForSoundToFinish();
  }

  saveScreen1(): void {
    this.screenBuf1 = this.ui.save();
  }
  loadScreen1(): void {
    if (this.screenBuf1) this.ui.restore(this.screenBuf1);
    this.setBattlePalette();
  }
  saveScreen2(): void {
    this.screenBuf2 = this.ui.save();
  }
  loadScreen2(): void {
    if (this.screenBuf2) this.ui.restore(this.screenBuf2);
    this.setBattlePalette();
  }

  hud(m: BattleMon): HudMon {
    return { nick: m.nick, level: m.level, hp: m.hp, maxHp: m.maxHp, status: m.status };
  }
  /** wPlayerHPBarColor / wEnemyHPBarColor (green at battle init). */
  hpBarColors = [0, 0];
  /** SetPal_Battle uses the original party species, even while transformed. */
  setBattlePalette(black = false): void {
    const playerSpecies = this.player.mon.species ? (this.party[this.playerMonNumber]?.species ?? 0) : 0;
    const pals = black ? Array(4).fill(c('palette', 'PAL_BLACK')) : battlePaletteIds(this.bundle, playerSpecies, this.enemySpecies2, this.hpBarColors[0], this.hpBarColors[1]);
    this.e.hooks.paletteLayout?.(pals, BATTLE_PALETTE_BLOCKS);
  }
  private updateBarColor(turn: number): void {
    const mon = this.side(turn).mon;
    const color = healthBarColor(BattleUI.barPixels(mon.hp, mon.maxHp));
    if (this.hpBarColors[turn] !== color) { this.hpBarColors[turn] = color; this.setBattlePalette(); }
  }
  drawPlayerHUDAndHPBar(): void {
    const mon = this.player.mon;
    this.ui.drawPlayerHUD(this.hud(mon));
    this.updateBarColor(0);
    // the low health alarm follows the red HP bar (GetBattleHealthBarColor)
    const r = this.e.ram;
    if (mon.hp) {
      if (this.lowHealthAlarmDisabled) return;
      let px = Math.floor((mon.hp * 48) / Math.max(1, mon.maxHp));
      if (!px) px = 1;
      if (px < 10) {
        r.lowHealthAlarm |= 0x80;
        return;
      }
    }
    const was = r.lowHealthAlarm & 0x80;
    r.lowHealthAlarm = 0;
    if (was) this.e.sound.clearChannel(4);
  }
  drawEnemyHUDAndHPBar(): void {
    this.ui.drawEnemyHUD(this.hud(this.enemy.mon));
    this.updateBarColor(1);
  }
  drawHUDsAndHPBars(): void {
    this.drawPlayerHUDAndHPBar();
    this.drawEnemyHUDAndHPBar();
  }

  /** UpdateHPBar2 for the side whose turn it is (UpdateCurMonHPBar). */
  *updateHPBar(turn: number, oldHp: number): Co {
    const s = this.side(turn);
    yield* this.ui.animateHPBar(turn === 0, this.hud(s.mon), oldHp);
    this.updateBarColor(turn);
  }

  hasItem(item: number): boolean {
    return this.bag.some((s) => s.item === item && s.qty > 0);
  }

  isTrainerBattle(): boolean {
    return this.isInBattle === TRAINER_BATTLE;
  }

  // ------------------------------------------------------------ entry point
  *run(): Co<BattleResult> {
    yield* this.initBattle();
    yield* this.startBattle();
    yield* this.endOfBattle();
    return this.result();
  }

  result(): BattleResult {
    if (this.capturedMonSpecies || this.battleResult === 2 && this.caught) return 'caught';
    if (this.escapedFromBattle) return 'ran';
    if (this.battleResult === 1) return 'lose';
    if (this.battleResult === 2) return 'ran';
    return 'win';
  }
  caught = false;

  /** InitBattle / InitBattleCommon / InitWildBattle / InitOpponent. */
  *initBattle(): Co {
    const req = this.req;
    if (req.kind === 'trainer') {
      this.trainerClass = req.trainerClass ?? 0;
      this.trainerNo = req.trainerNo ?? 1;
      this.getTrainerInformation();
      this.readTrainer();
      yield* this.doBattleTransition();
      this.enemySpecies2 = 0;
      this.aiCount = 0xff;
      this.ui.setTrainerPic(this.trainerPic());
      this.enemyMonPartyPos = 0xff;
      this.isInBattle = TRAINER_BATTLE;
      // a major story battle (wLoneAttackNo)
      if (this.gymLeaderNo) this.happiness('PIKAHAPPY_GYMLEADER', undefined);
    } else {
      this.isInBattle = WILD_BATTLE;
      this.enemySpecies2 = req.species ?? 0;
      this.curEnemyLevel = req.level ?? 1;
      this.loadEnemyMonData();
      yield* this.doBattleTransition();
      const ghost = this.enemySpecies2 === c('pokemon', 'RESTLESS_SOUL') || this.isGhostBattle();
      if (ghost) {
        this.enemy.mon.nick = 'GHOST';
        this.ui.setEnemyPic(this.bundle.pics.special.GhostPic);
      } else {
        this.ui.setEnemyPic(this.bundle.pics.front[this.enemySpecies2]);
      }
      this.trainerClass = 0;
    }
    yield* this.slideSilhouettesOnScreen();
    if (this.isInBattle === WILD_BATTLE) this.drawEnemyHUDAndHPBar();
  }

  /** DoBattleTransitionAndInitBattleVariables (the transition itself is a short flash). */
  *doBattleTransition(): Co {
    yield;
    yield* battleTransition(this);
    this.ui.enter();
    this.setBattlePalette(true); // SET_PAL_BATTLE_BLACK: the initial silhouettes
    this.e.hooks.fade?.(0); // the battle screen is drawn over the black screen; palettes back to normal
    this.player.s1 = this.player.s2 = this.player.s3 = 0;
    this.player.disabledMove = 0;
    // InitBattleVariables
    const map = this.e.world.data.id;
    if (map >= c('map', 'SAFARI_ZONE_EAST') && map < c('map', 'SAFARI_ZONE_CENTER_REST_HOUSE')) this.battleType = c('battle', 'BATTLE_TYPE_SAFARI');
    this.playBattleMusic();
  }

  /** PlayBattleMusic (audio/play_battle_music.asm) */
  playBattleMusic(): void {
    this.e.stopAllMusic();
    const opp = this.req.kind === 'trainer' ? (this.req.trainerClass ?? 0) + 200 : 0;
    let music = 'MUSIC_WILD_BATTLE';
    if (this.gymLeaderNo) music = 'MUSIC_GYM_LEADER_BATTLE';
    else if (opp) {
      if (opp === c('opp', 'OPP_RIVAL3')) music = 'MUSIC_FINAL_BATTLE';
      else if (opp === c('opp', 'OPP_LANCE')) music = 'MUSIC_GYM_LEADER_BATTLE';
      else music = 'MUSIC_TRAINER_BATTLE';
    }
    this.e.playMusic(music);
  }

  /** SlidePlayerAndEnemySilhouettesOnScreen + PrintBeginningBattleText. */
  *slideSilhouettesOnScreen(): Co {
    const backPic =
      this.battleType === c('battle', 'BATTLE_TYPE_OLD_MAN')
        ? this.bundle.pics.special.OldManPicBack
        : this.battleType === c('battle', 'BATTLE_TYPE_PIKACHU')
          ? this.bundle.pics.special.ProfOakPicBack
          : this.bundle.pics.special.RedPicBack;
    this.ui.textBox();
    const enemySnapshot = this.ui.save();
    // 72 frames: both pics slide 2px per frame toward their places (in tile steps here).
    for (let step = 18; step >= 0; step--) {
      this.ui.restore(enemySnapshot);
      this.ui.shiftArea(12, 0, 7, 7, -step);
      this.ui.setPlayerBackPic(backPic, step);
      for (let i = 0; i < 4; i++) yield;
    }
    this.ui.restore(enemySnapshot);
    this.ui.setPlayerBackPic(backPic);
    yield* this.delay(3);
    this.setBattlePalette();
    yield* this.printBeginningBattleText();
  }

  trainerPic() {
    // IsFightingJessieJames: ROCKET trainers $2A and up are Jessie & James
    if (this.trainerClass === c('trainer', 'ROCKET') && this.trainerNo >= 0x2a) return this.bundle.pics.special.JessieJamesPic;
    return this.bundle.pics.trainers[this.trainerClass];
  }

  /** IsGhostBattle: a wild battle in Pokémon Tower without the Silph Scope. */
  isGhostBattle(): boolean {
    if (this.isInBattle !== WILD_BATTLE) return false;
    const map = this.e.world.data.id;
    if (map < c('map', 'POKEMON_TOWER_1F') || map > c('map', 'POKEMON_TOWER_7F')) return false;
    return !this.hasItem(c('item', 'SILPH_SCOPE'));
  }

  /** PrintBeginningBattleText (engine/battle/common_text.asm). */
  *printBeginningBattleText(): Co {
    if (this.isTrainerBattle()) {
      yield* this.trainerAppearedSfx();
      yield* this.delay(20);
      this.ui.drawAllPokeballs(this);
      yield* this.print('_TrainerWantsToFightText');
      return;
    }
    const map = this.e.world.data.id;
    const inTower = map >= c('map', 'POKEMON_TOWER_3F') && map <= c('map', 'POKEMON_TOWER_7F');
    if (inTower) {
      const scope = this.hasItem(c('item', 'SILPH_SCOPE'));
      if (this.enemySpecies2 === c('pokemon', 'RESTLESS_SOUL')) {
        if (!scope) {
          yield* this.print('_EnemyAppearedText');
          yield* this.print('_GhostCantBeIDdText');
          return;
        }
        yield* this.print('_EnemyAppearedText');
        yield* this.print('_UnveiledGhostText');
        this.loadEnemyMonData();
        this.ui.setEnemyPic(this.bundle.pics.front[this.enemySpecies2]);
        yield* this.print('_WildMonAppearedText');
        yield* this.trainerAppearedSfx();
        return;
      }
      if (!scope) {
        yield* this.print('_EnemyAppearedText');
        yield* this.print('_GhostCantBeIDdText');
        return;
      }
      this.loadEnemyMonData();
    }
    if (this.battleType === c('battle', 'BATTLE_TYPE_PIKACHU')) yield* playPikachuCry(this.e, pikachuCry(isPlayerPikachuAsleepInParty(this.e.state, this.party) ? 37 : 11));
    else yield* this.playCry(this.enemySpecies2);
    if (!this.battleType) this.ui.drawAllPokeballs(this);
    yield* this.print(this.req.fishing ? '_HookedMonAttackedText' : '_WildMonAppearedText');
  }

  // ------------------------------------------------------------ trainer data
  /** GetTrainerInformation / GetTrainerName_ */
  getTrainerInformation(): void {
    const cls = this.bundle.trainers[this.trainerClass - 1];
    if (!cls) throw new Error(`unknown trainer class ${this.trainerClass}`);
    const rivals = ['RIVAL1', 'RIVAL2', 'RIVAL3'].map((n) => c('trainer', n));
    this.trainerName = rivals.includes(this.trainerClass) ? this.e.state.player.rivalName : cls.name;
    this.trainerBaseMoney = cls.baseMoney;
  }

  /** ReadTrainer (engine/battle/read_trainer_party.asm) + AddPartyMon for the enemy party. */
  readTrainer(): void {
    const cls = this.bundle.trainers[this.trainerClass - 1];
    const party = cls.parties[this.trainerNo - 1];
    if (!party) throw new Error(`trainer ${cls.constName} #${this.trainerNo} has no party`);
    const dvs = (c('battle', 'ATKDEFDV_TRAINER') << 8) | c('battle', 'SPDSPCDV_TRAINER');
    this.enemyParty = party.mons.map((m) =>
      makePartyMon(this.bundle, { species: m.species, level: m.level, dvs, otId: 0, otName: this.trainerName }),
    );
    for (const sp of this.bundle.battle.specialTrainerMoves) {
      if (sp.trainerClass !== this.trainerClass || sp.trainerNo !== this.trainerNo) continue;
      for (const { mon, slot, move } of sp.moves) {
        const pm = this.enemyParty[mon - 1];
        pm.moves[slot - 1] = move;
        // LoadEnemyMonData reloads PP from the move table when the mon is sent out.
      }
    }
    const last = party.mons[party.mons.length - 1];
    this.curEnemyLevel = last?.level ?? 0;
    // wAmountMoneyWon = base money (BCD) added wCurEnemyLevel times
    this.amountMoneyWon = this.trainerBaseMoney * this.curEnemyLevel;
  }

  /** LoadEnemyMonData */
  loadEnemyMonData(): void {
    const en = this.enemy;
    const sp = speciesData(this.bundle, this.enemySpecies2);
    en.mon.species = this.enemySpecies2;
    let dvs: number;
    if (en.s3 & S3.TRANSFORMED) dvs = this.transformedEnemyMonOriginalDVs;
    else if (this.isTrainerBattle()) dvs = (c('battle', 'ATKDEFDV_TRAINER') << 8) | c('battle', 'SPDSPCDV_TRAINER');
    else {
      const spdSpc = this.random();
      const atkDef = this.random();
      dvs = (atkDef << 8) | spdSpc;
    }
    en.mon.dvs = dvs;
    en.mon.level = this.curEnemyLevel;
    const st = calcStats(sp, dvs, ZERO_STAT_EXP, this.curEnemyLevel, false);
    Object.assign(en.mon, { maxHp: st.maxHp, atk: st.atk, def: st.def, spd: st.spd, spc: st.spc });
    if (this.isTrainerBattle()) {
      const pm = this.enemyParty[this.whichPokemon];
      en.mon.hp = pm.hp;
      this.enemyMonPartyPos = this.whichPokemon;
      en.mon.status = pm.status;
    } else if (!(en.s3 & S3.TRANSFORMED)) {
      en.mon.hp = en.mon.maxHp;
      en.mon.status = 0;
    }
    en.mon.types = [...sp.types] as [number, number];
    en.mon.catchRate = sp.catchRate;
    en.mon.moves = this.isTrainerBattle() ? [...this.enemyParty[this.whichPokemon].moves] : [...initialMoves(sp, this.curEnemyLevel)];
    // LoadMovePPs: base PP only
    en.mon.pp = en.mon.moves.map((m) => movePP(this.bundle, m));
    this.enemyBaseStats = { ...sp.baseStats };
    this.enemyBaseCatchRate = sp.catchRate;
    this.enemyBaseExp = sp.baseExp;
    en.mon.nick = sp.name;
    this.e.store.dispatch({ type: 'setPokedex', dex: sp.dex, seen: true }, { undoable: false });
    en.unmod = { level: en.mon.level, maxHp: en.mon.maxHp, atk: en.mon.atk, def: en.mon.def, spd: en.mon.spd, spc: en.mon.spc };
    en.mods = [7, 7, 7, 7, 7, 7];
  }

  /** LoadBattleMonFromParty */
  loadBattleMonFromParty(): void {
    const pm = this.party[this.whichPokemon];
    const p = this.player;
    p.mon = {
      species: pm.species, hp: pm.hp, partyPos: pm.boxLevel, status: pm.status, types: [...pm.types] as [number, number],
      catchRate: pm.catchRate, moves: [...pm.moves], dvs: pm.dvs, level: pm.level, maxHp: pm.maxHp, atk: pm.atk,
      def: pm.def, spd: pm.spd, spc: pm.spc, pp: [...pm.pp], nick: pm.nickname,
    };
    p.unmod = { level: pm.level, maxHp: pm.maxHp, atk: pm.atk, def: pm.def, spd: pm.spd, spc: pm.spc };
    applyBurnAndParalysisPenalties(this, 1);
    applyBadgeStatBoosts(this);
    p.mods = [7, 7, 7, 7, 7, 7];
  }

  /** LoadEnemyMonFromParty is only used by link battles; trainer battles use LoadEnemyMonData. */

  /** ReadPlayerMonCurHPAndStatus: copy HP, party pos byte and status back to the party struct. */
  readPlayerMonCurHPAndStatus(): void {
    const pm = this.party[this.playerMonNumber];
    if (!pm) return;
    pm.hp = this.player.mon.hp;
    pm.boxLevel = this.player.mon.partyPos;
    pm.status = this.player.mon.status;
  }

  /** AnyPartyAlive (an empty party counts as alive: the original scans 256 entries of WRAM). */
  anyPartyAlive(): boolean {
    if (!this.party.length) return true;
    return this.party.some((m) => m.hp > 0);
  }

  anyEnemyPokemonAlive(): boolean {
    return this.enemyParty.some((m) => m.hp > 0);
  }

  /** HasMonFainted: prints "There's no will to fight!" unless sending out the first mon. */
  *hasMonFainted(): Co<boolean> {
    if (this.party[this.whichPokemon].hp) return false;
    if (!this.firstMonsNotOutYet) yield* this.print('_NoWillText');
    return true;
  }

  // ------------------------------------------------------------ StartBattle
  *startBattle(): Co {
    this.partyGainExpFlags = 0;
    this.partyFoughtCurrentEnemyFlags = 0;
    this.actionResult = 0;
    this.firstMonsNotOutYet = 1;
    if (this.isTrainerBattle()) yield* this.enemySendOutFirstMon();
    yield* this.delay(40);
    this.saveScreen1();
    const BT = (n: string) => c('battle', n);
    for (;;) {
      // .checkAnyPartyAlive
      if (this.battleType !== BT('BATTLE_TYPE_RUN') && this.battleType !== BT('BATTLE_TYPE_PIKACHU')) {
        if (!this.anyPartyAlive()) {
          yield* this.handlePlayerBlackOut();
          return;
        }
      }
      this.loadScreen1();
      if (!this.battleType) break;
      // Safari Zone and the scripted battles
      for (;;) {
        const ran = yield* battleMenu(this);
        if (ran) return;
        if (this.actionResult) break;
      }
      if (!this.numSafariBalls) {
        this.loadScreen1();
        yield* this.print('_OutOfSafariBallsText');
        return;
      }
      yield* this.printSafariZoneBattleText();
      let b = (this.enemy.mon.spd & 0xff) * 2;
      if (b > 0xff) {
        yield* this.enemyRan();
        return;
      }
      if (this.safariBaitFactor) b >>= 2;
      if (this.safariEscapeFactor) b = Math.min(0xff, b * 2);
      if (this.random() < b) {
        yield* this.enemyRan();
        return;
      }
    }
    // .playerSendOutFirstMon
    this.whichPokemon = 0;
    while (yield* this.hasMonFainted()) this.whichPokemon++;
    this.playerMonNumber = this.whichPokemon;
    this.loadScreen1();
    yield* this.slideTrainerPicOffScreen(true);
    this.saveScreen1();
    this.partyGainExpFlags |= 1 << this.whichPokemon;
    this.partyFoughtCurrentEnemyFlags |= 1 << this.whichPokemon;
    this.loadBattleMonFromParty();
    this.loadScreen1();
    yield* this.sendOutMon();
    yield* this.mainInBattleLoop();
  }

  /** PrintSafariZoneBattleText (engine/battle/safari_zone.asm). */
  *printSafariZoneBattleText(): Co {
    let text = '_SafariZoneEatingText';
    if (this.safariBaitFactor) {
      this.safariBaitFactor--;
      if (!this.safariBaitFactor) {
        this.enemyBaseCatchRate = this.enemy.mon.catchRate = this.enemyBaseCatchRateOriginal();
        text = '_SafariZoneAngryText';
      }
    } else if (this.safariEscapeFactor) {
      this.safariEscapeFactor--;
      text = '_SafariZoneAngryText';
      if (!this.safariEscapeFactor) {
        this.enemy.mon.catchRate = this.enemyBaseCatchRateOriginal();
        text = '';
      }
    } else text = '';
    if (text) yield* this.print(text);
  }

  enemyBaseCatchRateOriginal(): number {
    return speciesData(this.bundle, this.enemy.mon.species).catchRate;
  }

  /** EnemyRan */
  *enemyRan(): Co {
    this.loadScreen1();
    yield* this.print('_WildRanText');
    yield* this.e.env.playSoundWaitForCurrent('SFX_RUN');
    this.whoseTurn = 0;
    yield* this.ui.slideEnemyPicOff();
    this.escapedFromBattle = 1;
    this.battleResult = 2;
  }

  // ------------------------------------------------------------ MainInBattleLoop
  *mainInBattleLoop(): Co {
    const BS = this;
    for (;;) {
      this.readPlayerMonCurHPAndStatus();
      if (!this.player.mon.hp) {
        if (!(yield* this.handlePlayerMonFainted())) return;
        continue;
      }
      if (!this.enemy.mon.hp) {
        if (!(yield* this.handleEnemyMonFainted())) return;
        continue;
      }
      this.saveScreen1();
      this.firstMonsNotOutYet = 0;
      const p = this.player;
      let selectEnemyOnly = false;
      if (p.s2 & (S2.NEEDS_TO_RECHARGE | S2.USING_RAGE)) selectEnemyOnly = true;
      else {
        this.enemy.s1 &= ~S1.FLINCHED;
        p.s1 &= ~S1.FLINCHED;
        if (p.s1 & (S1.THRASHING_ABOUT | S1.CHARGING_UP)) selectEnemyOnly = true;
      }
      if (!selectEnemyOnly) {
        const ran = yield* battleMenu(this);
        if (ran) return;
        if (this.escapedFromBattle) return;
        if (p.mon.status & (ST.FRZ | ST.SLP_MASK)) selectEnemyOnly = true;
        else if (p.s1 & (S1.STORING_ENERGY | S1.USING_TRAPPING_MOVE)) selectEnemyOnly = true;
        else if (this.enemy.s1 & S1.USING_TRAPPING_MOVE) {
          p.selectedMove = CANNOT_MOVE;
          selectEnemyOnly = true;
        }
      }
      if (!selectEnemyOnly && !this.actionResult) {
        // .selectPlayerMove
        this.moveMenuType = 0;
        this.menuItemToSwap = 0;
        const chose = yield* moveSelectionMenu(this);
        this.loadScreen1();
        this.drawHUDsAndHPBars();
        if (!chose) continue;
      }
      // .selectEnemyMove
      selectEnemyMove(this);
      // turn order
      const pm = p.selectedMove;
      const em = this.enemy.selectedMove;
      let playerFirst: boolean | undefined;
      if (pm === M.QUICK_ATTACK) playerFirst = em === M.QUICK_ATTACK ? undefined : true;
      else if (em === M.QUICK_ATTACK) playerFirst = false;
      else if (pm === M.COUNTER) playerFirst = em === M.COUNTER ? undefined : false;
      else if (em === M.COUNTER) playerFirst = true;
      if (playerFirst === undefined) {
        if (p.mon.spd !== this.enemy.mon.spd) playerFirst = p.mon.spd > this.enemy.mon.spd;
        else playerFirst = this.random() < pct(50) + 1;
      }
      const r = playerFirst ? yield* this.playerMovesFirst() : yield* this.enemyMovesFirst();
      if (r === 'end') return;
      void BS;
    }
  }

  /** .enemyMovesFirst */
  private *enemyMovesFirst(): Co<'end' | 'loop'> {
    this.whoseTurn = 1;
    const aiUsed = yield* trainerAI(this);
    if (!aiUsed) {
      const b = yield* executeEnemyMove(this);
      if (this.escapedFromBattle) return 'end';
      if (!b) return (yield* this.handlePlayerMonFainted()) ? 'loop' : 'end';
    }
    if (yield* this.handlePoisonBurnLeechSeed()) return (yield* this.handleEnemyMonFainted()) ? 'loop' : 'end';
    this.drawHUDsAndHPBars();
    const b = yield* executePlayerMove(this);
    if (this.escapedFromBattle) return 'end';
    if (!b) return (yield* this.handleEnemyMonFainted()) ? 'loop' : 'end';
    if (yield* this.handlePoisonBurnLeechSeed()) return (yield* this.handlePlayerMonFainted()) ? 'loop' : 'end';
    this.drawHUDsAndHPBars();
    this.checkNumAttacksLeft();
    return 'loop';
  }

  /** .playerMovesFirst */
  private *playerMovesFirst(): Co<'end' | 'loop'> {
    const b = yield* executePlayerMove(this);
    if (this.escapedFromBattle) return 'end';
    if (!b) return (yield* this.handleEnemyMonFainted()) ? 'loop' : 'end';
    if (yield* this.handlePoisonBurnLeechSeed()) return (yield* this.handlePlayerMonFainted()) ? 'loop' : 'end';
    this.drawHUDsAndHPBars();
    this.whoseTurn = 1;
    const aiUsed = yield* trainerAI(this);
    if (!aiUsed) {
      const b2 = yield* executeEnemyMove(this);
      if (this.escapedFromBattle) return 'end';
      if (!b2) return (yield* this.handlePlayerMonFainted()) ? 'loop' : 'end';
    }
    if (yield* this.handlePoisonBurnLeechSeed()) return (yield* this.handleEnemyMonFainted()) ? 'loop' : 'end';
    this.drawHUDsAndHPBars();
    this.checkNumAttacksLeft();
    return 'loop';
  }

  /** HandlePoisonBurnLeechSeed: returns true if the mon whose turn it is fainted. */
  *handlePoisonBurnLeechSeed(): Co<boolean> {
    const s = this.att;
    if (s.mon.status & (ST.BRN | ST.PSN)) {
      yield* this.print(s.mon.status & ST.BRN ? '_HurtByBurnText' : '_HurtByPoisonText');
      yield* playMoveAnimation(this, c('move', 'BURN_PSN_ANIM'), 0);
      yield* this.decreaseOwnHP();
    }
    if (s.s2 & S2.SEEDED) {
      this.whoseTurn ^= 1;
      yield* playMoveAnimation(this, M.ABSORB, 0);
      this.whoseTurn ^= 1;
      const dealt = yield* this.decreaseOwnHP();
      yield* this.increaseEnemyHP(dealt);
      yield* this.print('_HurtByLeechSeedText');
    }
    if (s.mon.hp) return false;
    this.drawHUDsAndHPBars();
    yield* this.delay(20);
    return true;
  }

  /**
   * HandlePoisonBurnLeechSeed_DecreaseOwnHP: 1/16 max HP (min 1), times the
   * Toxic counter if badly poisoned — also applied to Leech Seed damage.
   * Returns the damage that the leech seed heal adds (not capped by overkill).
   */
  private *decreaseOwnHP(): Co<number> {
    const s = this.att;
    let dmg = (s.mon.maxHp >> 4) & 0xff; // assumes HP < 1024, as the original does
    if (!dmg) dmg = 1;
    if (s.s3 & S3.BADLY_POISONED) {
      s.toxicCounter = (s.toxicCounter + 1) & 0xff;
      dmg = (dmg * s.toxicCounter) & 0xffff;
    }
    const old = s.mon.hp;
    s.mon.hp = Math.max(0, old - dmg);
    yield* this.updateHPBar(this.whoseTurn, old);
    return dmg;
  }

  /** HandlePoisonBurnLeechSeed_IncreaseEnemyHP */
  private *increaseEnemyHP(amount: number): Co {
    const t = this.def;
    const old = t.mon.hp;
    t.mon.hp = Math.min(t.mon.maxHp, (old + amount) & 0xffff);
    yield* this.updateHPBar(this.whoseTurn ^ 1, old);
  }

  /** CheckNumAttacksLeft */
  checkNumAttacksLeft(): void {
    if (!this.player.numAttacksLeft) this.player.s1 &= ~S1.USING_TRAPPING_MOVE;
    if (!this.enemy.numAttacksLeft) this.enemy.s1 &= ~S1.USING_TRAPPING_MOVE;
  }

  // ------------------------------------------------------------ fainting
  /** HandleEnemyMonFainted: returns true to continue the battle loop. */
  *handleEnemyMonFainted(): Co<boolean> {
    this.inHandlePlayerMonFainted = 0;
    yield* this.faintEnemyPokemon();
    if (!this.anyPartyAlive()) {
      yield* this.handlePlayerBlackOut();
      return false;
    }
    if (this.player.mon.hp) this.drawPlayerHUDAndHPBar();
    if (!this.isTrainerBattle()) return false;
    if (!this.anyEnemyPokemonAlive()) {
      yield* this.trainerBattleVictory();
      return false;
    }
    if (!this.player.mon.hp) {
      if (yield* this.doUseNextMonDialogue()) return false;
      yield* this.chooseNextMon();
    }
    this.actionResult = 1;
    yield* this.replaceFaintedEnemyMon();
    this.actionResult = 0;
    return true;
  }

  /** FaintEnemyPokemon */
  *faintEnemyPokemon(): Co {
    this.readPlayerMonCurHPAndStatus();
    if (this.isTrainerBattle()) {
      const pm = this.enemyParty[this.enemyMonPartyPos];
      if (pm) pm.hp = 0;
    }
    this.player.s1 &= ~S1.ATTACKING_MULTIPLE_TIMES;
    // Only the high byte of the accumulated damage is cleared (it doubles as wPlayerNumHits).
    this.player.bideDamage &= 0xff;
    this.player.numHits = 0;
    const en = this.enemy;
    en.s1 = en.s2 = en.s3 = 0;
    en.disabledMove = 0;
    en.disabledMoveNumber = 0;
    en.minimized = 0;
    this.player.usedMove = 0;
    this.enemy.usedMove = 0;
    yield* this.ui.slideDownPic(12, 0);
    this.ui.clearArea(0, 0, 4, 11);
    if (this.isTrainerBattle()) {
      this.e.sound.setModifiers(0, 0);
      yield* this.e.env.playSoundWaitForCurrent('SFX_FAINT_FALL');
      while (this.e.sound.soundId(4) === c('music', 'SFX_FAINT_FALL')) yield;
      this.sound('SFX_FAINT_THUD');
      yield* this.e.waitForSoundToFinish();
    } else {
      this.lowHealthAlarmDisabled = 1;
      this.playBattleVictoryMusic('MUSIC_DEFEATED_WILD_MON');
    }
    if (!this.player.mon.hp && !this.inHandlePlayerMonFainted) yield* this.removeFaintedPlayerMon();
    if (!this.anyPartyAlive()) return;
    yield* this.print('_EnemyMonFaintedText');
    yield* this.printEmptyString();
    this.saveScreen1();
    this.battleResult = 0;
    const expAll = this.hasItem(c('item', 'EXP_ALL'));
    if (expAll) {
      const b = this.enemyBaseStats;
      for (const k of ['hp', 'atk', 'def', 'spd', 'spc'] as const) b[k] >>= 1;
      this.enemyBaseCatchRate >>= 1;
      this.enemyBaseExp >>= 1;
    }
    this.boostExpByExpAll = 0;
    yield* gainExperience(this);
    if (!expAll) return;
    this.boostExpByExpAll = 1;
    this.partyGainExpFlags = (1 << this.party.length) - 1;
    yield* gainExperience(this);
  }

  playBattleVictoryMusic(name: string): void {
    this.e.stopAllMusic();
    this.e.playMusic(name);
  }

  /** ReplaceFaintedEnemyMon */
  *replaceFaintedEnemyMon(): Co {
    this.ui.drawEnemyPokeballs(this);
    yield* this.enemySendOut();
    this.enemy.move.num = 0;
    this.actionResult = 0;
    this.aiLayer2Encouragement = 0;
  }

  /** TrainerBattleVictory */
  *trainerBattleVictory(): Co {
    this.lowHealthAlarmDisabled = 1;
    let music = this.gymLeaderNo ? 'MUSIC_DEFEATED_GYM_LEADER' : 'MUSIC_DEFEATED_TRAINER';
    if (this.trainerClass === c('trainer', 'RIVAL3')) {
      music = 'MUSIC_DEFEATED_GYM_LEADER';
      this.e.ram.noMapMusic = true;
    }
    this.playBattleVictoryMusic(music);
    yield* this.print('_TrainerDefeatedText');
    yield* this.scrollTrainerPicAfterBattle();
    yield* this.delay(40);
    yield* this.printEndBattleText();
    yield* this.print('_MoneyForWinningText');
    this.moneyWon = this.amountMoneyWon;
  }
  moneyWon = 0;

  /** PrintEndBattleText (home/trainers.asm): the trainer's closing line. */
  *printEndBattleText(): Co {
    const label = this.e.ram.endBattleWinText;
    if (!label) return;
    yield* this.e.printText(label);
    yield* this.e.waitForTextScrollButtonPress?.();
    yield* this.e.waitForSoundToFinish();
  }

  /** _ScrollTrainerPicAfterBattle: the trainer pic slides back in from the right. */
  *scrollTrainerPicAfterBattle(): Co {
    this.ui.clearArea(0, 0, 8, 20);
    const pic = this.trainerPic();
    for (let x = 20; x >= 12; x--) {
      this.ui.clearArea(0, 0, 7, 20);
      this.ui.setEnemyPic(pic, x, 0);
      yield;
    }
  }

  /** HandlePlayerMonFainted: returns true to continue the battle loop. */
  *handlePlayerMonFainted(): Co<boolean> {
    this.inHandlePlayerMonFainted = 1;
    yield* this.removeFaintedPlayerMon();
    if (!this.anyPartyAlive()) {
      yield* this.handlePlayerBlackOut();
      return false;
    }
    if (!this.enemy.mon.hp) {
      yield* this.faintEnemyPokemon();
      if (!this.isTrainerBattle()) return false;
      if (!this.anyEnemyPokemonAlive()) {
        yield* this.trainerBattleVictory();
        return false;
      }
    }
    if (yield* this.doUseNextMonDialogue()) return false;
    const enemyAlive = yield* this.chooseNextMon();
    if (enemyAlive) return true;
    this.actionResult = 1;
    yield* this.replaceFaintedEnemyMon();
    this.actionResult = 0;
    return true;
  }

  /** RemoveFaintedPlayerMon */
  *removeFaintedPlayerMon(): Co {
    this.partyGainExpFlags &= ~(1 << this.playerMonNumber);
    this.enemy.s1 &= ~S1.ATTACKING_MULTIPLE_TIMES;
    this.enemy.bideDamage = 0;
    this.enemy.numHits = 0;
    this.player.mon.status = 0;
    this.readPlayerMonCurHPAndStatus();
    this.ui.clearArea(9, 7, 5, 11);
    yield* this.ui.slideDownPic(1, 5);
    this.battleResult = 1;
    if (!this.inHandlePlayerMonFainted) return;
    this.whichPokemon = this.playerMonNumber;
    if (isStarterPikachu(this.e.state, this.party[this.playerMonNumber])) yield* playPikachuCry(this.e, pikachuCry(4));
    else yield* this.playCry(this.player.mon.species);
    yield* this.print('_PlayerMonFaintedText');
    const diff = this.enemy.mon.level - this.player.mon.level;
    this.happiness(diff >= 0 && diff >= 30 ? 'PIKAHAPPY_CARELESSTRAINER' : 'PIKAHAPPY_FAINTED', this.party[this.playerMonNumber]);
  }

  /** DoUseNextMonDialogue: returns true if the player ran. */
  *doUseNextMonDialogue(): Co<boolean> {
    yield* this.printEmptyString();
    this.saveScreen1();
    if (this.isInBattle !== WILD_BATTLE) return false;
    yield* this.print('_UseNextMonText');
    for (;;) {
      const choice = yield* twoOptionMenu(this.e, 'YES_NO_MENU', 13, 9);
      if (choice === 0) return false;
      // .tryRunning (uses the first party mon's speed)
      return yield* this.tryRunningFromBattle(this.party[0].spd, this.enemy.mon.spd);
    }
  }

  /** ChooseNextMon: returns true if the enemy mon still has HP. */
  *chooseNextMon(): Co<boolean> {
    for (;;) {
      const chosen = yield* this.displayPartyMenu('battle');
      if (chosen === undefined) continue;
      this.whichPokemon = chosen;
      if (yield* this.hasMonFainted()) continue;
      break;
    }
    this.actionResult = 0;
    this.playerMonNumber = this.whichPokemon;
    this.partyGainExpFlags |= 1 << this.whichPokemon;
    this.partyFoughtCurrentEnemyFlags |= 1 << this.whichPokemon;
    this.loadBattleMonFromParty();
    this.ui.reloadHudTiles();
    this.loadScreen1();
    yield* this.sendOutMon();
    return this.enemy.mon.hp > 0;
  }

  /** DisplayPartyMenu in battle: returns the chosen party index, or undefined on B. */
  *displayPartyMenu(mode: PartyMenuMode): Co<number | undefined> {
    const r = yield* partyMenu(this.e, { party: this.party, mode, battle: this });
    this.ui.reloadHudTiles();
    return r;
  }

  /** HandlePlayerBlackOut */
  *handlePlayerBlackOut(): Co {
    if (this.e.ram.curOpponent === c('opp', 'OPP_RIVAL1')) {
      this.ui.clearArea(0, 0, 8, 21 > 20 ? 20 : 21);
      yield* this.scrollTrainerPicAfterBattle();
      yield* this.delay(40);
      yield* this.print('_Rival1WinText');
      if (this.e.world.data.id === c('map', 'OAKS_LAB')) {
        this.battleResult = 1;
        this.blackedOut = false;
        return;
      }
    }
    yield* this.print('_PlayerBlackedOutText2');
    this.e.ram.alwaysOnBike = false;
    this.ui.clearScreen();
    this.battleResult = 1;
    this.blackedOut = true;
  }
  blackedOut = false;

  // ------------------------------------------------------------ send-outs
  /** EnemySendOut (also clears the exp flags for mons that didn't face the new enemy). */
  *enemySendOut(): Co {
    this.partyGainExpFlags = 1 << this.playerMonNumber;
    this.partyFoughtCurrentEnemyFlags = 1 << this.playerMonNumber;
    yield* this.enemySendOutFirstMon();
  }

  /** EnemySendOutFirstMon */
  *enemySendOutFirstMon(): Co {
    const en = this.enemy;
    en.s1 = en.s2 = en.s3 = 0;
    en.disabledMove = 0;
    en.disabledMoveNumber = 0;
    en.minimized = 0;
    this.player.usedMove = 0;
    this.enemy.usedMove = 0;
    this.aiCount = 0xff;
    this.player.s1 &= ~S1.USING_TRAPPING_MOVE;
    yield* this.slideTrainerPicOffScreen(false);
    yield* this.printEmptyString();
    this.saveScreen1();
    // pick the next mon that isn't the current one and has HP
    let b = -1;
    for (;;) {
      b++;
      if (b === this.enemyMonPartyPos) continue;
      if (b >= this.enemyParty.length) throw new Error('EnemySendOut: no enemy mon left');
      if (this.enemyParty[b].hp) break;
    }
    this.whichPokemon = b;
    this.curEnemyLevel = this.enemyParty[b].level;
    this.enemySpecies2 = this.enemyParty[b].species;
    this.loadEnemyMonData();
    this.lastSwitchInEnemyMonHP = en.mon.hp;
    this.currentMenuItem = 1;
    let shifting = false;
    if (this.firstMonsNotOutYet !== 1 && this.party.length > 1 && this.e.state.options.battleStyle === 'shift') {
      yield* this.print('_TrainerAboutToUseText');
      const choice = yield* twoOptionMenu(this.e, 'YES_NO_MENU', 0, 7);
      if (choice === 0) {
        for (;;) {
          const chosen = yield* this.displayPartyMenu('battle');
          this.currentMenuItem = 1;
          if (chosen === undefined) break;
          this.whichPokemon = chosen;
          if (chosen === this.playerMonNumber) {
            yield* this.print('_AlreadyOutText');
            continue;
          }
          if (yield* this.hasMonFainted()) continue;
          this.currentMenuItem = 0;
          shifting = true;
          break;
        }
        this.ui.reloadHudTiles();
        this.loadScreen1();
        if (!shifting) this.whichPokemon = this.playerMonNumber;
      } else this.whichPokemon = this.playerMonNumber;
    }
    this.ui.clearSprites();
    this.ui.clearArea(0, 0, 4, 11);
    this.setBattlePalette();
    yield* this.print('_TrainerSentOutText');
    yield* this.ui.animateSendingOutMon(this.bundle.pics.front[this.enemySpecies2], 15, 6);
    yield* this.playCry(this.enemySpecies2);
    this.drawEnemyHUDAndHPBar();
    if (this.currentMenuItem) return;
    this.partyGainExpFlags = 0;
    this.partyFoughtCurrentEnemyFlags = 0;
    this.saveScreen1();
    yield* this.switchPlayerMon();
  }

  /** SlideTrainerPicOffScreen: player (left, 9 tiles) or enemy trainer (right, 8 tiles). */
  *slideTrainerPicOffScreen(player: boolean): Co {
    for (let i = 0; i < (player ? 9 : 8); i++) {
      if (player) this.ui.shiftArea(1, 5, 7, 9, -1);
      else this.ui.shiftArea(12, 0, 7, 8, 1);
      yield;
      yield;
    }
  }

  /** SendOutMon */
  *sendOutMon(): Co {
    this.ui.clearSprites(); // the party balls go away when the first mon comes out
    yield* this.printSendOutMonMessage();
    if (this.enemy.mon.hp) this.drawEnemyHUDAndHPBar();
    this.drawPlayerHUDAndHPBar();
    this.battleAndStartSavedMenuItem = 0;
    this.boostExpByExpAll = 0;
    this.damageMultipliers = 0;
    const p = this.player;
    p.move.num = 0;
    p.usedMove = 0;
    this.enemy.usedMove = 0;
    p.s1 = p.s2 = p.s3 = 0;
    p.disabledMove = 0;
    p.disabledMoveNumber = 0;
    p.minimized = 0;
    this.enemy.s1 &= ~S1.USING_TRAPPING_MOVE;
    this.setBattlePalette();
    const pikachu = isStarterPikachu(this.e.state, this.party[this.playerMonNumber]);
    this.whoseTurn = pikachu ? 0 : 1;
    if (!pikachu) yield* playMoveAnimation(this, c('move', 'POOF_ANIM'), 0);
    yield* this.ui.animateSendingOutMon(this.bundle.pics.back[p.mon.species], 4, 11, true);
    if (pikachu) yield* playPikachuCry(this.e, pikachuCry(isPlayerPikachuAsleepInParty(this.e.state, this.party) ? 37 : 11));
    else yield* this.playCry(p.mon.species);
    yield* this.printEmptyString();
    this.saveScreen1();
  }

  /** PrintSendOutMonMessage: Go!/Do it!/Get'm!/The enemy's weak! by the enemy's HP. */
  *printSendOutMonMessage(): Co {
    let text = '_GoText';
    const en = this.enemy.mon;
    if (en.hp) {
      this.lastSwitchInEnemyMonHP = en.hp;
      const div = (en.maxHp >> 2) & 0xff;
      const q = div ? Math.floor((en.hp * 25) / div) & 0xff : 0xff;
      if (q >= 70) text = '_GoText';
      else if (q >= 40) text = '_DoItText';
      else if (q >= 10) text = '_GetmText';
      else text = '_EnemysWeakText';
    }
    yield* this.print(text, '_PlayerMon1Text');
  }

  /** RetreatMon: Come back! / Good! / OK! / That's enough! by damage dealt since switch-in. */
  *retreatMon(): Co {
    const en = this.enemy.mon;
    const div = (en.maxHp >> 2) & 0xff;
    const diff = (this.lastSwitchInEnemyMonHP - en.hp) & 0xffff;
    const q = div ? Math.floor((diff * 25) / div) & 0xff : 0;
    let text = '_EnoughText';
    if (q === 0) text = '_EnoughText';
    else if (q < 30) text = '';
    else if (q < 70) text = '_OKExclamationText';
    else text = '_GoodText';
    const labels = ['_PlayerMon2Text'];
    if (text) labels.push(text);
    labels.push('_ComeBackText');
    yield* this.print(...labels);
  }

  /** SwitchPlayerMon */
  *switchPlayerMon(): Co {
    yield* this.retreatMon();
    yield* this.delay(50);
    yield* this.ui.animateRetreatingPlayerMon();
    this.playerMonNumber = this.whichPokemon;
    this.partyGainExpFlags |= 1 << this.whichPokemon;
    this.partyFoughtCurrentEnemyFlags |= 1 << this.whichPokemon;
    this.loadBattleMonFromParty();
    yield* this.sendOutMon();
    this.saveScreen1();
    this.currentMenuItem = 2;
  }

  // ------------------------------------------------------------ running
  /** TryRunningFromBattle: returns true (carry) if the player escaped. */
  *tryRunningFromBattle(playerSpeed: number, enemySpeed: number): Co<boolean> {
    const BT = (n: string) => c('battle', n);
    let escape = false;
    if (this.isGhostBattle() || this.battleType === BT('BATTLE_TYPE_SAFARI') || this.battleType === BT('BATTLE_TYPE_RUN')) escape = true;
    else if (this.isTrainerBattle()) {
      yield* this.print('_NoRunningText');
      this.forcePlayerToChooseMon = 1;
      this.saveScreen1();
      return false;
    } else {
      this.numRunAttempts = (this.numRunAttempts + 1) & 0xff;
      this.loadScreen1();
      if (playerSpeed >= enemySpeed) escape = true;
      else {
        const divisor = (enemySpeed >> 2) & 0xff;
        if (!divisor) escape = true;
        else {
          const q = Math.floor(((playerSpeed * 32) & 0xffff) / divisor);
          if (q > 0xff) escape = true;
          else {
            let v = q;
            for (let i = 1; i < this.numRunAttempts && !escape; i++) {
              v += 30;
              if (v > 0xff) escape = true;
            }
            if (!escape && v >= this.random()) escape = true;
          }
        }
      }
      if (!escape) {
        this.actionResult = 1;
        yield* this.print('_CantEscapeText');
        this.forcePlayerToChooseMon = 1;
        this.saveScreen1();
        return false;
      }
    }
    this.battleResult = 2;
    yield* this.e.env.playSoundWaitForCurrent('SFX_RUN');
    yield* this.print('_GotAwayText');
    yield* this.e.waitForSoundToFinish();
    this.saveScreen1();
    return true;
  }

  // ------------------------------------------------------------ end of battle
  /** EndOfBattle (engine/battle/end_of_battle.asm) + committing the battle's results. */
  *endOfBattle(): Co {
    if (!this.battleResult && !this.escapedFromBattle) {
      if (this.totalPayDayMoney) {
        this.e.store.dispatch({ type: 'addMoney', amount: this.totalPayDayMoney }, { undoable: false });
        yield* this.print('_PickUpPayDayMoneyText');
      }
    }
    if (this.moneyWon) this.e.store.dispatch({ type: 'addMoney', amount: this.moneyWon }, { undoable: false });
    this.commit();
    if (!this.battleResult || this.escapedFromBattle) {
      if (!this.battleResult) {
        // .evolution: EvolutionAfterBattle, then UpdatePikachuMoodAfterBattle
        yield* evolutionAfterBattle(this.e, this.canEvolveFlags, false);
        const mood = moodAfterBattle(this.e.state, 0x82);
        if (mood !== undefined) this.e.store.dispatch({ type: 'setPikachu', mood }, { undoable: false });
      }
    }
    this.e.ram.lowHealthAlarm = 0;
    this.e.ram.wildEncounterCooldown = true;
    yield* this.e.waitForSoundToFinish();
    this.ui.leave();
  }

  /** wCanEvolveFlags: set for each mon that leveled up. */
  canEvolveFlags = 0;

  /** ModifyPikachuHappiness for a party mon (wWhichPokemon). */
  happiness(event: string, mon: PartyMon | undefined): void {
    const r = modifyPikachuHappiness(this.bundle, this.e.state, event, mon, this.party, this.e.ram.pikachuEmotionModifier);
    if (r) this.e.store.dispatch({ type: 'setPikachu', happiness: r.happiness, mood: r.mood }, { undoable: false });
  }

  /** The player's name while the Old Man / Prof. Oak "plays" the battle (DisplayBattleMenu swaps wPlayerName). */
  simulatedTrainerName?: string;

  /** Write the working party/bag back to the game state. */
  commit(): void {
    // Old Man / Oak / Safari battles never load a player battle mon. The
    // original only copies HP/status along paths that sent a Pokémon out;
    // flushing our zero-initialized scratch mon here would faint party slot 0.
    if (this.player.mon.species) this.readPlayerMonCurHPAndStatus();
    this.e.store.dispatch({ type: 'setParty', party: this.party }, { undoable: false });
    this.e.store.dispatch({ type: 'setBag', bag: this.bag }, { undoable: false });
    if (this.battleType === c('battle', 'BATTLE_TYPE_SAFARI'))
      this.e.store.dispatch({ type: 'setVar', name: 'wNumSafariBalls', value: this.numSafariBalls }, { undoable: false });
  }

  // ------------------------------------------------------------ misc used by other modules
  /** GetCurrentMove for the side whose turn it is. */
  getCurrentMove(): void {
    getCurrentMove(this);
  }

  *playApplyingAttackAnimation(type: number): Co {
    yield* playApplyingAttackAnimation(this, type);
  }

  /** The species' base data (GetMonHeader). */
  header(speciesId: number) {
    return speciesData(this.bundle, speciesId);
  }
}
