/** New Game rules: pick web mods (see game/mods.ts) and a World look before Oak's speech. */
import { formatSeed, MOD_INFO, parseSeed, type GameMods } from '../game/mods';
import { WORLD_LOOKS } from '../render/themes';

/** The device's World look; unlike mods it is not stored with the save and can change anytime. */
export interface LookChoice { current(): string; set(id: string): void }

export function chooseMods(root: HTMLElement, look?: LookChoice): Promise<GameMods | undefined> {
  const dialog = document.createElement('dialog');
  dialog.className = 'web-settings mod-picker';
  dialog.setAttribute('aria-labelledby', 'mod-picker-title');
  let seed = (Math.random() * 0xffffffff) >>> 0;
  dialog.innerHTML = `
    <header class="settings-header">
      <div><p class="settings-eyebrow">NEW GAME / OPTIONAL MODS</p><h1 id="mod-picker-title">Choose your rules.</h1></div>
    </header>
    <div class="mod-cards">
      ${MOD_INFO.map((m) => `
        <label class="mod-card" for="mod-${m.id}">
          <input type="checkbox" id="mod-${m.id}" data-mod="${m.id}">
          <span class="mod-card-head"><strong>${m.name}</strong><span class="mod-badge" aria-hidden="true"></span></span>
          <span class="mod-summary">${m.summary}</span>
          <span class="mod-details">${m.details.map((d) => `<span>${d}</span>`).join('')}</span>
        </label>`).join('')}
      <div class="mod-seed" hidden>
        <label class="settings-field" for="mod-seed"><span>Randomizer seed</span>
          <span class="mod-seed-row"><input id="mod-seed" autocomplete="off" spellcheck="false" maxlength="7" inputmode="text"><button type="button" class="mod-reroll">Reroll</button></span></label>
        <p class="settings-hint">Letters and numbers. The same seed gives the same Kanto.</p>
      </div>
      ${look ? `<div class="mod-look">
        <label class="settings-field" for="mod-look"><span>World look</span><select id="mod-look">${WORLD_LOOKS.map((l) => `<option value="${l.id}">${l.label}</option>`).join('')}</select></label>
        <p class="settings-hint mod-look-hint"></p>
      </div>` : ''}
    </div>
    <footer class="settings-footer"><p role="status" aria-live="polite"></p><div><span></span><button type="button" class="settings-done">Start adventure</button></div></footer>`;
  root.append(dialog);
  const get = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const comfort = get<HTMLInputElement>('#mod-comfort');
  const random = get<HTMLInputElement>('#mod-randomizer');
  const seedBox = get<HTMLDivElement>('.mod-seed');
  const seedInput = get<HTMLInputElement>('#mod-seed');
  const status = get<HTMLParagraphElement>('[role=status]');
  const start = get<HTMLButtonElement>('.settings-done');
  seedInput.value = formatSeed(seed);
  const lookSelect = dialog.querySelector<HTMLSelectElement>('#mod-look');
  const renderLook = () => {
    if (!look || !lookSelect) return;
    lookSelect.value = look.current();
    const info = WORLD_LOOKS.find((l) => l.id === lookSelect.value);
    get<HTMLParagraphElement>('.mod-look-hint').textContent = `${info?.description ?? ''} Change it anytime in WEB SETTINGS.`;
  };
  lookSelect?.addEventListener('change', () => { look!.set(lookSelect.value); renderLook(); });
  renderLook();
  const render = () => {
    seedBox.hidden = !random.checked;
    const valid = !random.checked || parseSeed(seedInput.value) !== undefined;
    seedInput.setAttribute('aria-invalid', String(!valid));
    start.disabled = !valid;
    const on = [comfort.checked && 'Comfort', random.checked && 'Randomizer'].filter(Boolean);
    status.textContent = !valid ? 'Seeds use letters and numbers only (up to 7).'
      : on.length ? `${on.join(' + ')}. Locked in for this save.` : 'No mods: the original Pokémon Yellow.';
  };
  comfort.addEventListener('change', render);
  random.addEventListener('change', render);
  seedInput.addEventListener('input', render);
  get<HTMLButtonElement>('.mod-reroll').addEventListener('click', () => {
    seed = (Math.random() * 0xffffffff) >>> 0;
    seedInput.value = formatSeed(seed);
    render();
  });
  render();
  return new Promise((resolve) => {
    // The choice is required: Escape does not skip it.
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    start.addEventListener('click', () => {
      const mods: GameMods = {};
      if (comfort.checked) mods.comfort = true;
      const s = parseSeed(seedInput.value);
      if (random.checked && s !== undefined) mods.randomizer = { seed: s };
      dialog.close();
      dialog.remove();
      root.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true });
      resolve(mods.comfort || mods.randomizer ? mods : undefined);
    });
    dialog.showModal();
    comfort.focus();
  });
}
