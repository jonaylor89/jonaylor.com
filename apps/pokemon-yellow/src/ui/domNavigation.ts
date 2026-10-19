/** Standard gamepads navigate native title/account/settings controls, not the game beneath them. */
import { gamepadButtons, type Button } from '../input/Input';

export function mountDomNavigation(root: HTMLElement) {
  let previous = new Set<Button>();
  let surface: HTMLElement | null = null;
  let guarded = true;
  let frame = 0;
  const tick = () => {
    const dialogs = [...root.querySelectorAll<HTMLDialogElement>('dialog[open]')];
    const current = dialogs.at(-1) ?? root.querySelector<HTMLElement>('.home-screen');
    const held = gamepadButtons(navigator.getGamepads?.() ?? []);
    if (surface !== current || document.hidden) { surface = current; guarded = true; }
    if (!held.size) guarded = false;
    if (surface && !guarded && !document.hidden) {
      const pressed = new Set([...held].filter(b => !previous.has(b)));
      if (pressed.size) root.dataset.menuInput = 'gamepad';
      const controls = [...surface.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
        .filter(el => el.getClientRects().length > 0 && !el.closest('[hidden]'));
      const active = document.activeElement as HTMLElement;
      const index = controls.indexOf(active);
      if (pressed.has('up') || pressed.has('down')) {
        const direction = pressed.has('up') ? -1 : 1;
        const next = index < 0 ? (direction < 0 ? controls.length - 1 : 0) : (index + direction + controls.length) % controls.length;
        controls[next]?.focus();
      } else if (pressed.has('left') || pressed.has('right')) {
        const direction = pressed.has('left') ? -1 : 1;
        if (active instanceof HTMLInputElement && active.type === 'range') {
          if (direction < 0) active.stepDown(); else active.stepUp();
          active.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (active instanceof HTMLSelectElement) {
          active.selectedIndex = Math.max(0, Math.min(active.options.length - 1, active.selectedIndex + direction));
          active.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (pressed.has('a') || pressed.has('start')) {
        if (controls.includes(active)) active.click(); else controls[0]?.focus();
      } else if (pressed.has('b') && surface instanceof HTMLDialogElement) {
        if (surface.dispatchEvent(new Event('cancel', { cancelable: true }))) surface.close();
      }
    }
    previous = held;
    frame = requestAnimationFrame(tick);
  };
  const keyboard = () => { root.dataset.menuInput = 'keyboard'; };
  const pointer = () => { root.dataset.menuInput = 'touch'; };
  window.addEventListener('keydown', keyboard);
  root.addEventListener('pointerdown', pointer);
  frame = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', keyboard); root.removeEventListener('pointerdown', pointer); };
}
