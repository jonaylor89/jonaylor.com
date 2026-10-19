import './homeScreen.css';
import type { GameBundle } from '../data/schema';
import type { SaveFile } from '../game/save';
import type { KeyMap } from '../input/Input';
import type { SyncStatus } from '../cloud/types';
import { applyFilter, paletteColors, type ColorFilter } from '../render/palette';
import { WORLD_LOOKS } from '../render/themes';
import { c } from '../rom/constants';

export interface HomeSaveStatus { account: boolean; status?: SyncStatus; failed?: boolean }
export function homeSaveStatus(save: HomeSaveStatus, online: boolean): string {
  if (save.failed) return 'Save was NOT written · Open Account for details';
  if (save.status === 'conflict') return 'Choose a save to continue';
  if (!online) return save.account ? 'Saved on this device · Sync when online' : 'Offline · Playing from this device';
  if (!save.account) return 'Saved on this device';
  return ({ synced: 'Cloud save up to date', syncing: 'Checking cloud saves…', pending: 'Saved on this device · Sync pending', error: 'Saved on this device · Cloud unavailable', local: 'Saved on this device' })[save.status ?? 'local'];
}
export function homeSaveSummary(bundle: GameBundle, file: SaveFile) {
  const s = file.state;
  const minutes = Math.floor(s.frames / 3600);
  const location = bundle.maps[s.player.map]?.constName ?? 'Kanto';
  return { trainer: `${s.player.name} · ${location.replaceAll('_', ' ')}`, progress: `${(s.badges & 255).toString(2).replaceAll('0', '').length} badges · ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} played` };
}

interface HomeHost {
  bundle: GameBundle;
  save?: SaveFile;
  account: boolean;
  keymap(): KeyMap;
  filter(): ColorFilter;
  /** The World look (texture pack) id; changing it repaints the town behind the menu. */
  look(): string;
  setLook(id: string): void;
  status(): HomeSaveStatus;
  subscribe(listener: () => void): () => void;
  prepareNewGame(): Promise<void>;
  start(choice: 'continue' | 'new'): void;
  settings(): void;
  openAccount(): void;
}

/** Original extracted logo: no remote fonts, image downloads, or mandatory start gate. */
function drawLogo(canvas: HTMLCanvasElement, bundle: GameBundle, filter: ColorFilter) {
  canvas.width = 128; canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(128, 48);
  const title = bundle.ui.title;
  const colors = applyFilter(paletteColors(bundle, c('palette', 'PAL_LOGO2')), filter);
  title.logoTilemap.slice(0, 16 * 6).forEach((tile, i) => {
    const pixels = tile === 0xfd ? title.pokemonLogoCorner : title.pokemonLogo;
    const start = tile === 0xfd ? 0 : tile * 64;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const shade = pixels[start + y * 8 + x] ?? 0;
      if (!shade) continue;
      const at = (((i >> 4) * 8 + y) * 128 + (i % 16) * 8 + x) * 4;
      image.data.set([...colors[shade], 255], at);
    }
  });
  ctx.putImageData(image, 0, 0);
}

export function mountHomeScreen(root: HTMLElement, host: HomeHost) {
  root.classList.add('on-title');
  const screen = document.createElement('section'); screen.className = 'home-screen';
  screen.setAttribute('aria-labelledby', 'home-title');
  screen.innerHTML = `<div class="home-content">
    <header class="home-brand"><p class="home-eyebrow">A LITTLE PARTNER. A GRAND ADVENTURE.</p>
      <h1 id="home-title"><canvas class="home-logo" aria-hidden="true"></canvas><span class="home-sr">Pokémon Yellow — 3D Adventure</span></h1>
      <p class="home-edition">YELLOW <span>3D ADVENTURE</span></p>
    </header>
    <nav class="home-menu" aria-label="Main menu"></nav>
    <footer class="home-footer"><p class="home-identity"></p><p class="home-status" role="status"></p><p class="home-offline"></p></footer>
    <p class="home-hints home-keyboard">↑ ↓ Choose <span>Enter / Confirm Select</span></p>
    <p class="home-hints home-gamepad">D-pad Choose <span>A Select · B Back</span></p>
    <p class="home-hints home-touch">Touch an option to begin</p>
  </div><div class="home-place" aria-hidden="true"><span>01 / WHERE IT ALL BEGINS</span><strong>PALLET TOWN</strong><i>A world of adventure awaits.</i></div>
  <p class="home-unofficial">Unofficial fan project · Not affiliated with Nintendo, Game Freak, or The Pokémon Company.</p>`;
  root.append(screen);
  const q = <T extends HTMLElement>(selector: string) => screen.querySelector<T>(selector)!;
  const menu = q<HTMLElement>('.home-menu');
  const buttons: HTMLButtonElement[] = [];
  let disposed = false;
  let busy = false;
  let confirmation: HTMLDialogElement | undefined;
  let selected: HTMLButtonElement;
  let offlineReady = false;
  const summary = host.save ? homeSaveSummary(host.bundle, host.save) : undefined;
  const add = (label: string, action: () => void, detail?: string) => {
    const button = document.createElement('button'); button.type = 'button';
    const text = document.createElement('strong'); text.textContent = label; button.append(text);
    if (detail) { const sub = document.createElement('span'); sub.textContent = detail; button.append(sub); }
    button.onclick = action;
    button.onfocus = () => { selected = button; for (const b of buttons) b.classList.toggle('is-selected', b === button); };
    menu.append(button); buttons.push(button); return button;
  };
  function start(choice: 'continue' | 'new') {
    if (host.status().status === 'conflict') { host.openAccount(); return; }
    dispose(); host.start(choice);
  }
  if (host.save && summary) {
    const resume = add('CONTINUE', () => start('continue'));
    resume.classList.add('home-continue');
    for (const line of [summary.trainer, summary.progress]) { const span = document.createElement('span'); span.textContent = line; resume.append(span); }
  }
  add('NEW GAME', () => { if (host.save) confirmNewGame(); else start('new'); }, host.save ? undefined : 'Your adventure starts here.');
  const lookRow = add('WORLD LOOK', () => stepLook(1));
  lookRow.classList.add('home-look');
  lookRow.dataset.steps = '';
  lookRow.setAttribute('aria-roledescription', 'option cycler');
  lookRow.addEventListener('step', event => stepLook((event as CustomEvent<number>).detail));
  const lookName = document.createElement('span'); lookName.className = 'home-look-name';
  const lookNote = document.createElement('span'); lookNote.className = 'home-look-note';
  lookRow.append(lookName, lookNote);
  function stepLook(direction: number) {
    const i = WORLD_LOOKS.findIndex(l => l.id === host.look());
    host.setLook(WORLD_LOOKS[(Math.max(0, i) + direction + WORLD_LOOKS.length) % WORLD_LOOKS.length].id);
    render();
  }
  add('SETTINGS', host.settings);
  add('ACCOUNT', host.openAccount, host.account ? 'Cloud saves & recovery' : 'Optional cloud saves across devices');
  function confirmNewGame() {
    if (confirmation?.open || busy) return;
    const dialog = document.createElement('dialog'); confirmation = dialog;
    dialog.className = 'trainer-dialog home-confirm'; dialog.setAttribute('aria-labelledby', 'home-new-title');
    dialog.innerHTML = `<p class="trainer-eyebrow">A NEW CHAPTER</p><h1 id="home-new-title">Start a new adventure?</h1>
      <p class="home-replace-summary"></p><p class="home-replace-note"></p>
      <div class="trainer-choices"><button type="button" data-home="keep" autofocus>Keep existing adventure</button><button type="button" data-home="export">Export existing save</button><button type="button" data-home="replace">Start new adventure</button></div><p role="status"></p>`;
    dialog.querySelector('.home-replace-summary')!.textContent = `${summary!.trainer} · ${summary!.progress}`;
    dialog.querySelector('.home-replace-note')!.textContent = `Your first SAVE in the new adventure will replace your ${host.account ? 'account' : 'guest'} checkpoint${host.account ? ' and sync it to the cloud' : ' on this device'}. A recovery copy will be kept in Account → Recovery history. Until then, your existing checkpoint stays intact.`;
    const get = (name: string) => dialog.querySelector<HTMLButtonElement>(`[data-home=${name}]`)!;
    get('keep').onclick = () => dialog.close();
    get('export').onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(host.save)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'pokeyellow-previous-adventure.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    get('replace').onclick = async () => {
      if (busy) return;
      busy = true;
      for (const b of dialog.querySelectorAll('button')) b.disabled = true;
      try { await host.prepareNewGame(); start('new'); }
      catch (error) { dialog.querySelector('[role=status]')!.textContent = `Could not preserve your save. Nothing was replaced. ${error instanceof Error ? error.message : error}`; }
      finally { busy = false; for (const b of dialog.querySelectorAll('button')) b.disabled = false; }
    };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); confirmation = undefined; if (!disposed) selected.focus(); });
    root.append(dialog); dialog.showModal();
  }
  function render() {
    if (disposed) return;
    q('.home-identity').textContent = host.account ? 'Playing with your account save' : 'Playing as guest · No account needed';
    q('.home-status').textContent = !host.save && !host.account ? 'Progress saves in this browser via START → SAVE.' : homeSaveStatus(host.status(), navigator.onLine);
    q('.home-offline').textContent = !navigator.onLine ? 'Offline · Account services need a connection.' : offlineReady ? 'Ready to reopen offline on this device.' : 'Keep browser data to keep local saves.';
    drawLogo(q<HTMLCanvasElement>('.home-logo'), host.bundle, host.filter());
    const look = WORLD_LOOKS.find(l => l.id === host.look()) ?? WORLD_LOOKS[0];
    lookName.textContent = `‹ ${look.label} ›`;
    lookNote.textContent = look.description;
    lookRow.setAttribute('aria-label', `World look: ${look.label}. ${look.description} Press to change.`);
  }
  function onKey(event: KeyboardEvent) {
    if (disposed || root.querySelector('dialog[open]') || event.ctrlKey || event.metaKey || event.altKey) return;
    const map = host.keymap();
    if (event.code === 'ArrowUp' || map.up.includes(event.code) || event.code === 'ArrowDown' || map.down.includes(event.code)) {
      event.preventDefault(); event.stopImmediatePropagation();
      const direction = event.code === 'ArrowUp' || map.up.includes(event.code) ? -1 : 1;
      buttons[(buttons.indexOf(selected) + direction + buttons.length) % buttons.length].focus();
    } else if (selected === lookRow && (event.code === 'ArrowLeft' || map.left.includes(event.code) || event.code === 'ArrowRight' || map.right.includes(event.code))) {
      event.preventDefault(); event.stopImmediatePropagation();
      stepLook(event.code === 'ArrowLeft' || map.left.includes(event.code) ? -1 : 1);
    } else if (event.code === 'Enter' || map.a.includes(event.code) || map.start.includes(event.code)) {
      event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) selected.click();
    }
  }
  // Existing panels return focus to the game canvas; on the title, return to the selected row instead.
  function onFocus(event: FocusEvent) {
    if (!disposed && !root.querySelector('dialog[open]') && (event.target as HTMLElement)?.tagName === 'CANVAS') { render(); selected.focus({ preventScroll: true }); }
  }
  const unsubscribe = host.subscribe(render);
  window.addEventListener('online', render); window.addEventListener('offline', render);
  window.addEventListener('keydown', onKey, true); root.addEventListener('focusin', onFocus);
  selected = buttons[0]; selected.focus({ preventScroll: true }); render();
  function dispose() {
    disposed = true; unsubscribe(); confirmation?.close(); confirmation?.remove();
    window.removeEventListener('online', render); window.removeEventListener('offline', render);
    window.removeEventListener('keydown', onKey, true); root.removeEventListener('focusin', onFocus);
    root.classList.remove('on-title'); screen.remove();
  }
  return { dispose, offlineReady(value: boolean) { offlineReady = value; render(); } };
}
