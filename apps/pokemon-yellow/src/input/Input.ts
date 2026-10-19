/**
 * Unified input: keyboard (remappable), gamepads (standard mapping) and an
 * on-screen touch pad, all reduced to the eight Game Boy buttons.
 * `poll()` is called once per emulated frame and yields held + newly pressed.
 */
export type Button = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'start' | 'select';
export const BUTTONS: Button[] = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'];

export type KeyMap = Record<Button, string[]>;

export const DEFAULT_KEYMAP: KeyMap = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  a: ['KeyZ', 'KeyJ', 'Space'],
  b: ['KeyX', 'KeyK', 'Backspace'],
  start: ['Enter'],
  select: ['ShiftRight', 'ShiftLeft'],
};

export interface InputFrame {
  held: Set<Button>;
  pressed: Set<Button>;
}

export class Input {
  keymap: KeyMap;
  private keys = new Set<string>();
  private touch = new Set<Button>();
  private prev = new Set<Button>();
  /** Buttons injected by scripts/tests (simulated joypad). */
  private simulated = new Set<Button>();
  private suspended = false;
  private resumeGuard = false;
  setSuspended(value: boolean): void {
    this.suspended = value;
    this.resumeGuard = !value;
    this.keys.clear(); this.touch.clear(); this.prev.clear(); this.simulated.clear();
  }
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (this.suspended || (e.target as HTMLElement)?.closest?.('input, select, textarea, button, dialog')) return;
    if (this.isMapped(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private readonly onBlur = () => this.keys.clear();

  constructor(keymap: KeyMap = DEFAULT_KEYMAP) {
    this.keymap = structuredClone(keymap);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private isMapped(code: string): boolean {
    return BUTTONS.some((b) => this.keymap[b].includes(code));
  }

  setTouch(b: Button, down: boolean): void {
    if (this.suspended) return;
    if (down) this.touch.add(b);
    else this.touch.delete(b);
  }

  simulate(buttons: Button[]): void {
    this.simulated = new Set(buttons);
  }

  poll(): InputFrame {
    if (this.suspended) return { held: new Set(), pressed: new Set() };
    const held = new Set<Button>();
    for (const b of BUTTONS) if (this.keymap[b].some((k) => this.keys.has(k))) held.add(b);
    for (const b of this.touch) held.add(b);
    for (const b of this.simulated) held.add(b);
    for (const b of gamepadButtons(navigator.getGamepads?.() ?? [])) held.add(b);
    if (this.resumeGuard) {
      if (!held.size) this.resumeGuard = false;
      return { held: new Set(), pressed: new Set() };
    }
    const pressed = new Set<Button>();
    for (const b of held) if (!this.prev.has(b)) pressed.add(b);
    this.prev = held;
    return { held, pressed };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}

/** Shared standard mapping for gameplay and browser menus. */
export function gamepadButtons(pads: readonly (Gamepad | null)[]): Set<Button> {
  const held = new Set<Button>();
  for (const pad of pads) {
    if (!pad || pad.mapping !== 'standard') continue;
    const btn = (i: number) => pad.buttons[i]?.pressed;
    if (btn(12) || pad.axes[1] < -0.5) held.add('up');
    if (btn(13) || pad.axes[1] > 0.5) held.add('down');
    if (btn(14) || pad.axes[0] < -0.5) held.add('left');
    if (btn(15) || pad.axes[0] > 0.5) held.add('right');
    if (btn(0)) held.add('a');
    if (btn(1) || btn(2)) held.add('b');
    if (btn(9)) held.add('start');
    if (btn(8)) held.add('select');
  }
  return held;
}

/** Build the on-screen touch controls (shown on touch devices). */
export function mountTouchControls(root: HTMLElement, input: Input, haptics: () => boolean = () => false): HTMLElement {
  const el = document.createElement('div');
  el.className = 'touch-controls';
  el.innerHTML = `
    <div class="dpad">
      <button data-b="up" aria-label="Up">▲</button>
      <button data-b="left" aria-label="Left">◀</button>
      <button data-b="right" aria-label="Right">▶</button>
      <button data-b="down" aria-label="Down">▼</button>
    </div>
    <div class="ab">
      <button data-b="b" aria-label="B">B</button>
      <button data-b="a" aria-label="A">A</button>
    </div>
    <div class="ss">
      <button data-b="select" aria-label="Select">SELECT</button>
      <button data-b="start" aria-label="Start">START</button>
    </div>`;
  const active = new Map<number, Button>();
  const pointers = new Set<number>();
  const update = (e: PointerEvent, down: boolean) => {
    const prev = active.get(e.pointerId);
    active.delete(e.pointerId);
    const target = down ? document.elementFromPoint(e.clientX, e.clientY) : null;
    const b = target?.closest('button')?.getAttribute('data-b') as Button | undefined;
    if (b && el.contains(target)) {
      active.set(e.pointerId, b);
      if (b !== prev && haptics() && navigator.vibrate) {
        try { navigator.vibrate(12); } catch { /* unsupported or denied */ }
      }
    }
    // Multiple fingers may hold the same button; releasing one must not release it.
    const held = new Set(active.values());
    for (const button of BUTTONS) input.setTouch(button, held.has(button));
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointers.add(e.pointerId);
    el.setPointerCapture(e.pointerId);
    update(e, true);
  });
  el.addEventListener('pointermove', (e) => { if (pointers.has(e.pointerId)) { e.preventDefault(); update(e, true); } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) el.addEventListener(ev, (e) => {
    pointers.delete(e.pointerId);
    update(e, false);
  });
  const release = () => { pointers.clear(); active.clear(); for (const b of BUTTONS) input.setTouch(b, false); };
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  root.appendChild(el);
  return el;
}
