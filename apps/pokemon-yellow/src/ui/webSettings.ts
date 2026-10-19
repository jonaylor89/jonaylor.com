/** Device-local web options, separate from Yellow's authentic OPTION menu. */
import type { Engine } from '../engine/Engine';
import { BUTTONS, type Button } from '../input/Input';
import { COLOR_FILTERS } from '../render/palette';
import { WORLD_LOOKS } from '../render/themes';
import { formatSeed } from '../game/mods';
import { defaultWebSettings, keyLabel, remapKey, saveWebSettings, type WebSettings } from './webSettingsData';

export interface WebSettingsHost {
  engine: Engine;
  settings(): WebSettings;
  apply(settings: WebSettings): void;
  pause(paused: boolean): void;
}
export function mountWebSettings(root: HTMLElement, host: WebSettingsHost) {
  let settings = structuredClone(host.settings());
  let capture: Button | undefined;
  const opener = document.createElement('button');
  opener.className = 'settings-open';
  opener.textContent = 'WEB SETTINGS';
  opener.title = 'Web settings (F2)';
  opener.setAttribute('aria-haspopup', 'dialog');
  const dialog = document.createElement('dialog');
  dialog.className = 'web-settings';
  dialog.setAttribute('aria-labelledby', 'web-settings-title');
  dialog.innerHTML = `
    <header class="settings-header">
      <div><p class="settings-eyebrow">POKéMON YELLOW / WEB EDITION</p><h1 id="web-settings-title">Make it yours.</h1></div>
      <button type="button" class="settings-close" aria-label="Close settings" autofocus>×</button>
    </header>
    <div class="settings-body">
      <section aria-labelledby="settings-game-title">
        <h2 id="settings-game-title"><span>01</span> Game & sound</h2>
        <label class="settings-field" for="web-text-speed"><span>Text speed</span>
          <select id="web-text-speed"><option value="fast">FAST</option><option value="medium">MEDIUM</option><option value="slow">SLOW</option></select></label>
        <p class="settings-hint">Applies to new messages. Stored with your game when you save.</p>
        <label class="settings-check" for="web-comfort"><input id="web-comfort" type="checkbox"><span>Comfort mod</span></label>
        <p class="settings-hint">Party Exp. Share, HM field moves without teaching them, hold B to run and type hints in battle. Stored with your game when you save.</p>
        <p class="settings-hint settings-randomizer"></p>
        <label class="settings-field" for="web-volume"><span>Volume <output id="web-volume-value"></output></span><input id="web-volume" type="range" min="0" max="100" step="1"></label>
        <p class="settings-hint">Zero mutes output, not the original sound engine.</p>
        <label class="settings-check" for="web-haptics"><input id="web-haptics" type="checkbox"><span>Touch haptics</span></label>
        <p class="settings-hint">A short vibration on touch buttons, on supported devices. Off by default.</p>
      </section>
      <section aria-labelledby="settings-camera-title">
        <h2 id="settings-camera-title"><span>02</span> Camera</h2>
        <label class="settings-field" for="web-distance"><span>Distance <output id="web-distance-value"></output></span><input id="web-distance" type="range" min="4" max="24" step="1"></label>
        <label class="settings-field" for="web-pitch"><span>Pitch <output id="web-pitch-value"></output></span><input id="web-pitch" type="range" min="25" max="75" step="1"></label>
      </section>
      <section aria-labelledby="settings-access-title">
        <h2 id="settings-access-title"><span>03</span> Display & motion</h2>
        <label class="settings-field" for="web-look"><span>World look</span><select id="web-look">${WORLD_LOOKS.map((l) => `<option value="${l.id}">${l.label}</option>`).join('')}</select></label>
        <p class="settings-hint settings-look-hint"></p>
        <label class="settings-field" for="web-filter"><span>Color palette</span><select id="web-filter">${COLOR_FILTERS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</select></label>
        <p class="settings-hint">Recolors the GB screen and the Original look. Texture packs keep each town's palette hue on roofs and signs.</p>
        <label class="settings-check" for="web-reduced"><input id="web-reduced" type="checkbox"><span>Reduced motion</span></label>
        <p class="settings-hint">Disables camera rails and stage lunges; snaps the follow camera. ROM battle effects keep their original timing.</p>
      </section>
      <section aria-labelledby="settings-keys-title">
        <h2 id="settings-keys-title"><span>04</span> Keyboard</h2>
        <p class="settings-hint">Select a button, then press its new key. Esc cancels. Gamepad and touch controls are unchanged.</p>
        <div class="settings-keymap"></div>
      </section>
    </div>
    <footer class="settings-footer"><p role="status" aria-live="polite">The game is paused. Web preferences save automatically.</p><div><button type="button" class="settings-reset">Reset web settings</button><button type="button" class="settings-done">Done</button></div></footer>`;
  root.append(opener, dialog);
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const status = get<HTMLParagraphElement>('[role=status]');
  const speed = get<HTMLSelectElement>('#web-text-speed');
  const comfort = get<HTMLInputElement>('#web-comfort');
  const volume = get<HTMLInputElement>('#web-volume');
  const distance = get<HTMLInputElement>('#web-distance');
  const haptics = get<HTMLInputElement>('#web-haptics');
  const pitch = get<HTMLInputElement>('#web-pitch');
  const filter = get<HTMLSelectElement>('#web-filter');
  const look = get<HTMLSelectElement>('#web-look');
  const reduced = get<HTMLInputElement>('#web-reduced');
  const keymap = get<HTMLDivElement>('.settings-keymap');
  const bindingButtons = new Map<Button, HTMLButtonElement>();
  for (const b of BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.button = b;
    button.addEventListener('click', () => {
      capture = b;
      renderBindings();
      status.textContent = `Press a key for ${b.toUpperCase()}. Escape cancels.`;
    });
    bindingButtons.set(b, button);
    keymap.append(button);
  }
  function renderBindings() {
    for (const b of BUTTONS) {
      const button = bindingButtons.get(b)!;
      button.replaceChildren();
      const label = document.createElement('span'); label.textContent = b.toUpperCase();
      const binding = document.createElement('kbd');
      binding.textContent = capture === b ? 'PRESS KEY…' : settings.keymap[b].map(keyLabel).join(' / ');
      button.append(label, binding);
      button.setAttribute('aria-label', `Remap ${b.toUpperCase()}: ${binding.textContent}`);
      button.setAttribute('aria-pressed', String(capture === b));
    }
  }
  function render() {
    speed.value = host.engine.state.options.textSpeed;
    comfort.checked = !!host.engine.state.mods?.comfort;
    const random = host.engine.state.mods?.randomizer;
    get<HTMLParagraphElement>('.settings-randomizer').textContent = random
      ? `Randomizer #${formatSeed(random.seed)} is locked for this save.`
      : 'Randomizer: off. It can only be chosen at New Game.';
    volume.value = String(Math.round(settings.volume * 100));
    distance.value = String(settings.view.cameraDistance);
    pitch.value = String(settings.view.cameraPitchDeg);
    filter.value = settings.view.colorFilter;
    look.value = settings.view.look;
    get<HTMLParagraphElement>('.settings-look-hint').textContent = WORLD_LOOKS.find((l) => l.id === settings.view.look)?.description ?? '';
    reduced.checked = settings.view.reducedMotion;
    haptics.checked = settings.haptics;
    get<HTMLOutputElement>('#web-volume-value').value = `${volume.value}%`;
    get<HTMLOutputElement>('#web-distance-value').value = distance.value;
    get<HTMLOutputElement>('#web-pitch-value').value = `${pitch.value}°`;
    renderBindings();
  }
  function apply() {
    host.apply(structuredClone(settings));
    let saved = false;
    try { saved = saveWebSettings(localStorage, settings); } catch { /* unavailable storage */ }
    status.textContent = saved ? 'Saved on this device. The game is paused.' : 'Applied for this session. Browser storage is unavailable.';
    render();
  }
  speed.addEventListener('change', () => {
    host.engine.store.dispatch({ type: 'setOptions', options: { textSpeed: speed.value as 'fast' | 'medium' | 'slow' } }, { undoable: false });
    status.textContent = 'Text speed updated. Save your game to keep this game option.';
  });
  comfort.addEventListener('change', () => {
    host.engine.store.dispatch({ type: 'setComfort', on: comfort.checked }, { undoable: false });
    status.textContent = `Comfort mod ${comfort.checked ? 'on' : 'off'}. Save your game to keep it.`;
  });
  volume.addEventListener('input', () => { settings.volume = Number(volume.value) / 100; apply(); });
  distance.addEventListener('input', () => { settings.view.cameraDistance = Number(distance.value); apply(); });
  pitch.addEventListener('input', () => { settings.view.cameraPitchDeg = Number(pitch.value); apply(); });
  filter.addEventListener('change', () => { settings.view.colorFilter = filter.value as WebSettings['view']['colorFilter']; apply(); });
  look.addEventListener('change', () => { settings.view.look = look.value; apply(); });
  reduced.addEventListener('change', () => { settings.view.reducedMotion = reduced.checked; apply(); });
  haptics.addEventListener('change', () => { settings.haptics = haptics.checked; apply(); });
  const close = () => dialog.close();
  const open = () => {
    if (dialog.open) return;
    capture = undefined;
    settings = structuredClone(host.settings());
    render();
    status.textContent = 'The game is paused. Web preferences save automatically.';
    host.pause(true);
    dialog.showModal();
  };
  opener.addEventListener('click', open);
  get<HTMLButtonElement>('.settings-close').addEventListener('click', close);
  get<HTMLButtonElement>('.settings-done').addEventListener('click', close);
  get<HTMLButtonElement>('.settings-reset').addEventListener('click', () => {
    capture = undefined;
    settings = defaultWebSettings(matchMedia('(prefers-reduced-motion: reduce)').matches);
    apply();
  });
  dialog.addEventListener('close', () => {
    capture = undefined;
    host.pause(false);
    root.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true });
  });
  const onKey = (event: KeyboardEvent) => {
    if (dialog.open && capture) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.code === 'Escape') {
        capture = undefined; renderBindings(); status.textContent = 'Key remapping cancelled.'; return;
      }
      try {
        if (event.ctrlKey || event.metaKey || event.altKey) throw new Error('Use a single key, not a modifier shortcut.');
        settings.keymap = remapKey(settings.keymap, capture, event.code);
        capture = undefined;
        apply();
      } catch (error) { status.textContent = (error as Error).message; }
    } else if (event.code === 'F2') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (dialog.open) close(); else open();
    }
  };
  window.addEventListener('keydown', onKey, true);
  render();
  return {
    open, close,
    dispose() {
      if (dialog.open) { dialog.close(); host.pause(false); }
      window.removeEventListener('keydown', onKey, true);
      opener.remove(); dialog.remove();
    },
  };
}
