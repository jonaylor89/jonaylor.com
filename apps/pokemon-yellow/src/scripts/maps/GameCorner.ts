/**
 * The Celadon Game Corner (scripts/GameCorner.asm, GameCorner_2.asm): the coin
 * clerk, the coin-giving regulars, the Rocket guarding the poster, and the
 * switch that opens the Rocket Hideout stairs.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_CTRL_PAD } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP, FACING_DOWN } from '../../engine/sprites';
import { c } from '../../rom/constants';
import { engageMapTrainer, initBattleEnemyParameters } from '../../engine/trainers';
import { encodePlain, formatBCD } from '../../ui/TextPrinter';

const S = (n: string) => c('map_script', `SCRIPT_GAMECORNER_${n}`);
const ROCKET = 'GAMECORNER_ROCKET';
const LOST_BATTLE = 0xff;

/** GameCornerDrawCoinBox */
export function drawCoinBox(e: ScriptEnv): void {
  const s = e.e.screen;
  const put = (x: number, y: number, str: string) => encodePlain(str).forEach((code, i) => s.put(x + i, y, code));
  e.e.ram.noTextDelay = true;
  s.box(11, 0, 5, 7);
  e.updateSprites();
  s.fill(12, 1, 7, 4, 0x7f);
  put(12, 2, e.e.bundle.strings.GameCornerMoneyText);
  put(12, 3, formatBCD(e.e.state.money, 3 | 0x20 | 0x80));
  put(12, 4, e.e.bundle.strings.GameCornerCoinText);
  put(15, 5, formatBCD(e.e.state.coins, 2 | 0x80));
  e.e.ram.noTextDelay = false;
}

/** Has9990Coins: carry (true) when the coin case holds fewer than 9990 */
const below9990 = (e: ScriptEnv) => e.e.state.coins < 9990;
const addCoins = (e: ScriptEnv, n: number) => e.e.store.dispatch({ type: 'addCoins', amount: n }, { undoable: false });

/** The three regulars who hand out coins once */
function coinGiver(label: string, event: string, amount: number, texts: [string, string, string, string], fullOnlyAtExactly9990 = false): ScriptFn {
  const [want, received, full, after] = texts;
  return function* (e): Co {
    const T = (n: string) => `${label}.${n}`;
    if (e.checkEvent(event)) return yield* e.printText(T(after));
    yield* e.printText(T(want));
    if (!e.isItemInBag('COIN_CASE')) return yield* e.printText('GameCornerOopsForgotCoinCaseText');
    // the Fishing Guru tests the Z flag instead of carry: "full" only at exactly 9990
    if (fullOnlyAtExactly9990 ? e.e.state.coins === 9990 : !below9990(e)) return yield* e.printText(T(full));
    addCoins(e, amount);
    e.setEvent(event);
    if (amount === 10) e.doNotWaitForButtonPress = true;
    yield* e.printText(T(received));
  };
}

const scripts: ScriptFn[] = [
  // GameCornerDefaultScript
  function* () {},
  // GameCornerRocketBattleScript
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      e.joyIgnore = 0;
      e.curScript = S('DEFAULT');
      return;
    }
    e.joyIgnore = PAD_CTRL_PAD;
    yield* e.displayTextID('TEXT_GAMECORNER_ROCKET_AFTER_BATTLE');
    const around = [NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT];
    const direct = new Array(5).fill(NPC_MOVEMENT_RIGHT);
    let path = around;
    if (e.y === 6 || e.x === 8) path = direct;
    else yield* e.e.pikachu.tryApplyMovementData(FACING_DOWN, [0x00, 0x20, 0x1e, 0x35, 0x3f]); // GameCornerPikachuMovementScript
    e.moveSprite(ROCKET, path);
    e.curScript = S('ROCKET_EXIT');
  },
  // GameCornerRocketExitScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    e.hideObject('TOGGLE_GAME_CORNER_ROCKET');
    e.ram.curMapLoaded1 = true;
    e.ram.curMapLoaded2 = true;
    e.curScript = S('DEFAULT');
  },
];

export const GameCorner: MapScript = {
  map: 'GAME_CORNER',
  *run(e) {
    // GameCornerSelectLuckySlotMachine
    if (e.takeMapLoaded2()) {
      e.e.random();
      let a = e.e.rng.hRandomAdd;
      if (a < 7) a = 8;
      e.setVar('wLuckySlotHiddenEventIndex', a >> 3);
    }
    // GameCornerSetRocketHideoutDoorTile: the stairs stay hidden until the poster switch
    if (e.takeMapLoaded1() && !e.checkEvent('EVENT_FOUND_ROCKET_HIDEOUT')) e.e.world.replaceBlock(8, 2, 0x2a);
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    *GameCornerClerkText(e) {
      const T = (n: string) => `GameCornerClerkText.${n}`;
      drawCoinBox(e);
      yield* e.printText(T('DoYouNeedSomeGameCoins'));
      if (!(yield* e.yesNoChoice())) return yield* e.printText(T('PleaseComePlaySometime'));
      if (!e.isItemInBag('COIN_CASE')) return yield* e.printText(T('DontHaveCoinCase'));
      if (!below9990(e)) return yield* e.printText(T('CoinCaseIsFull'));
      if (e.e.state.money < 1000) return yield* e.printText(T('CantAffordTheCoins'));
      e.e.store.dispatch({ type: 'addMoney', amount: -1000 }, { undoable: false });
      addCoins(e, 50);
      drawCoinBox(e);
      yield* e.printText(T('ThanksHereAre50Coins'));
    },
    GameCornerFishingGuru1Text: coinGiver('GameCornerFishingGuru1Text', 'EVENT_GOT_10_COINS', 10, ['WantToPlayText', 'Received10CoinsText', 'DontNeedMyCoinsText', 'WinsComeAndGoText']),
    GameCornerMiddleAgedMan2Text: coinGiver('GameCornerMiddleAgedMan2Text', 'EVENT_GOT_20_COINS_2', 20, ['WantSomeCoinsText', 'Received20CoinsText', 'YouHaveLotsOfCoinsText', 'INeedMoreCoinsText']),
    GameCornerFishingGuru2Text: coinGiver('GameCornerFishingGuru2Text', 'EVENT_GOT_20_COINS', 20, ['ThrowingMeOffText', 'Received20CoinsText', 'YouGotYourOwnCoinsText', 'CloselyWatchTheReelsText'], true),
    *GameCornerRocketText(e) {
      const T = (n: string) => `GameCornerRocketText.${n}`;
      yield* e.printText(T('ImGuardingThisPosterText'));
      const r = e.ram;
      r.talkedToTrainer = true;
      r.printEndBattleText = true;
      r.endBattleWinText = T('BattleEndText');
      r.endBattleLoseText = T('BattleEndText');
      engageMapTrainer(e, r.spriteIndex);
      initBattleEnemyParameters(e);
      e.joyHeld = 0;
      r.joyPressed = 0;
      e.curScript = S('ROCKET_BATTLE');
    },
    *GameCornerPosterText(e) {
      e.doNotWaitForButtonPress = true;
      yield* e.printText('GameCornerPosterText.SwitchBehindPosterText');
      yield* e.waitForSoundToFinish();
      yield* e.playSoundAndWait('go_inside');
      e.setEvent('EVENT_FOUND_ROCKET_HIDEOUT');
      e.e.world.replaceBlock(8, 2, 0x43);
    },
    // the text_asm inside SwitchBehindPosterText
    *'GameCornerPosterText.SwitchBehindPosterText'(e) {
      yield* e.playSoundAndWait('switch');
    },
  },
};
