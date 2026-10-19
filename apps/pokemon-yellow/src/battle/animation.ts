/**
 * MoveAnimation (engine/battle/animations.asm): the move's own animation
 * (`MoveAnimator`, or a 30-frame pause with BATTLE ANIMATION set to OFF), then
 * PlayApplyingAttackAnimation (the screen shakes and the target blink that show
 * damage). Poké Ball tosses take TossBallAnimation whatever the setting.
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { c } from '../rom/constants';

export const ANIM_TYPE = {
  SHAKE_SCREEN_VERTICALLY: c('battle_anim', 'ANIMATIONTYPE_SHAKE_SCREEN_VERTICALLY'),
  SHAKE_SCREEN_HORIZONTALLY_HEAVY: c('battle_anim', 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_HEAVY'),
  SHAKE_SCREEN_HORIZONTALLY_SLOW: c('battle_anim', 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_SLOW'),
  BLINK_ENEMY_MON_SPRITE: c('battle_anim', 'ANIMATIONTYPE_BLINK_ENEMY_MON_SPRITE'),
  SHAKE_SCREEN_HORIZONTALLY_LIGHT: c('battle_anim', 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_LIGHT'),
  SHAKE_SCREEN_HORIZONTALLY_SLOW_2: c('battle_anim', 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_SLOW_2'),
};

/** PlayMoveAnimation: wAnimationID = id, wAnimationType = type. */
export function* playMoveAnimation(b: Battle, id: number, type: number): Co {
  yield* b.delay(3);
  yield* moveAnimation(b, id, type);
}

/** MoveAnimation */
export function* moveAnimation(b: Battle, id: number, type: number): Co {
  yield* b.e.waitForSoundToFinish();
  const anim = b.anim;
  anim.animationId = id;
  anim.setAnimationPalette();
  if (id) {
    b.e.hooks.battleAnimation?.(id, b.whoseTurn);
    if (id === c('move', 'TOSS_ANIM')) yield* anim.tossBall(anim.pokeBallAnimData, anim.curItem);
    else {
      if (b.e.state.options.battleAnimation) {
        anim.shareMoveAnimations();
        yield* anim.playAnimation();
      } else yield* b.delay(30);
      yield* playApplyingAttackAnimation(b, type);
    }
  }
  yield* b.e.waitForSoundToFinish();
  anim.animSoundId = 0xff;
}

/** PlayCurrentMoveAnimation: the user's move animation with wAnimationType 0. */
export function* playCurrentMoveAnimation(b: Battle): Co {
  const id = b.att.move.num;
  if (!id) return;
  yield* moveAnimation(b, id, 0);
}

/** PlayCurrentMoveAnimation2: as above, with the slow horizontal shake as the type. */
export function* playCurrentMoveAnimation2(b: Battle): Co {
  const id = b.att.move.num;
  if (!id) return;
  yield* playBattleAnimation2(b, id);
}

/** PlayBattleAnimation: wAnimationType is left as set by the caller (0 by default). */
export function* playBattleAnimation(b: Battle, id: number, type = 0): Co {
  yield* moveAnimation(b, id, type);
}

/** PlayBattleAnimation2 */
export function* playBattleAnimation2(b: Battle, id: number): Co {
  const type = b.whoseTurn ? ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_SLOW : ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_SLOW_2;
  yield* moveAnimation(b, id, type);
}

/** PlayApplyingAttackSound: damage, super- or not-very-effective, by wDamageMultipliers */
function* playApplyingAttackSound(b: Battle): Co {
  yield* b.e.waitForSoundToFinish();
  const m = b.damageMultipliers & 0x7f;
  if (!m) return;
  const [freq, tempo, sfx] = m === 10 ? [0x20, 0x30, 'SFX_DAMAGE'] : m > 10 ? [0xe0, 0xff, 'SFX_SUPER_EFFECTIVE'] : [0x50, 0x01, 'SFX_NOT_VERY_EFFECTIVE'];
  b.e.sound.setModifiers(freq, tempo);
  b.sound(sfx);
}

/** PlayApplyingAttackAnimation */
export function* playApplyingAttackAnimation(b: Battle, type: number): Co {
  const ui = b.ui;
  switch (type) {
    case ANIM_TYPE.SHAKE_SCREEN_VERTICALLY:
      yield* playApplyingAttackSound(b);
      yield* ui.shakeScreenVertically(8);
      break;
    case ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_HEAVY:
      yield* playApplyingAttackSound(b);
      yield* ui.shakeScreenHorizontally(8);
      break;
    case ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_SLOW:
      yield* ui.shakeScreenHorizontallySlow(6, 2);
      break;
    case ANIM_TYPE.BLINK_ENEMY_MON_SPRITE:
      yield* playApplyingAttackSound(b);
      yield* ui.blinkMonPic(12, 0);
      break;
    case ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_LIGHT:
      yield* playApplyingAttackSound(b);
      yield* ui.shakeScreenHorizontally(2);
      break;
    case ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_SLOW_2:
      yield* ui.shakeScreenHorizontallySlow(3, 2);
      break;
  }
}
