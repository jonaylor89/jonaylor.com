/** Joypad bits (constants/hardware.inc) and PLAYER_DIR_* values. No imports: safe for any module. */
import type { InputFrame } from '../input/Input';

export const PAD_A = 0x01;
export const PAD_B = 0x02;
export const PAD_SELECT = 0x04;
export const PAD_START = 0x08;
export const PAD_RIGHT = 0x10;
export const PAD_LEFT = 0x20;
export const PAD_UP = 0x40;
export const PAD_DOWN = 0x80;
export const PAD_CTRL_PAD = 0xf0;
export const PAD_BUTTONS = 0x0f;

export const PLAYER_DIR_RIGHT = 1;
export const PLAYER_DIR_LEFT = 2;
export const PLAYER_DIR_DOWN = 4;
export const PLAYER_DIR_UP = 8;

export function inputToPad(input: InputFrame | undefined, set: 'held' | 'pressed'): number {
  if (!input) return 0;
  const s = input[set];
  return (
    (s.has('a') ? PAD_A : 0) |
    (s.has('b') ? PAD_B : 0) |
    (s.has('select') ? PAD_SELECT : 0) |
    (s.has('start') ? PAD_START : 0) |
    (s.has('right') ? PAD_RIGHT : 0) |
    (s.has('left') ? PAD_LEFT : 0) |
    (s.has('up') ? PAD_UP : 0) |
    (s.has('down') ? PAD_DOWN : 0)
  );
}
