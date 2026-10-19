import './account.css';
import { AudioOutput } from './audio/output';
import { obtainBundle } from './ui/boot';
import { OverworldView } from './render/OverworldView';
import { mountWebSettings } from './ui/webSettings';
import { defaultWebSettings, loadWebSettings, saveWebSettings } from './ui/webSettingsData';
import { attachView } from './render/syncView';
import { Engine } from './engine/Engine';
import { GbBattleHost } from './battle/host';
import { makePartyMon } from './game/pokemon';
import { SCRIPTS } from './scripts';
import { Input, mountTouchControls } from './input/Input';
import { newGameState, Store } from './game/state';
import { readSave } from './game/save';
import { mountDebugOverlay } from './ui/debug';
import { bootSequence } from './ui/titleFlow';
import { c, CONSTANTS } from './rom/constants';
import { bootstrapPlayer } from './cloud/bootstrap';
import { prepareOfflineShell } from './cloud/offline';
import { mountAccountPanel } from './ui/accountPanel';

/** Game Boy frame rate. */
const GB_FPS = 59.7275;

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Pokémon game view');

  const player = await bootstrapPlayer(app);
  const bundle = await obtainBundle(app);
  const offlineShell = prepareOfflineShell().catch(error => { console.warn('Offline shell unavailable', error); return false; });

  const params = new URLSearchParams(location.search);
  const save = import.meta.env.DEV && params.has('new')
    ? undefined
    : await readSave('slot1').catch((e) => {
        throw e; // Never replace an unreadable checkpoint with a new game.
      });
  const seedParam = import.meta.env.DEV ? params.get('seed') : null;
  const state = save?.state ?? newGameState(bundle, seedParam ? Number(seedParam) : (Math.random() * 0xffffffff) >>> 0);

  // Debug start position: ?map=PALLET_TOWN&x=5&y=6
  const mapParam = import.meta.env.DEV ? params.get('map') : null;
  if (mapParam) {
    const id = /^\d+$/.test(mapParam) ? Number(mapParam) : CONSTANTS.map[mapParam];
    if (bundle.maps[id]) {
      state.player.map = id;
      state.player.x = Number(params.get('x') ?? bundle.maps[id].warps[0]?.x ?? 0);
      state.player.y = Number(params.get('y') ?? bundle.maps[id].warps[0]?.y ?? 0);
      if (id < c('map', 'FIRST_INDOOR_MAP')) state.player.lastMap = id;
    }
  }

  // Debug party: ?party=CHARMANDER:20,PIDGEY:5 (dev builds)
  const partyParam = import.meta.env.DEV ? params.get('party') : null;
  if (partyParam) {
    state.party = partyParam.split(',').map((entry) => {
      const [name, lvl] = entry.split(':');
      return makePartyMon(bundle, { species: c('pokemon', name), level: Number(lvl ?? 5), dvs: 0xffff, otId: state.player.id, otName: state.player.name });
    });
  }

  const store = new Store(state);
  const view = new OverworldView(canvas, bundle);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let preferences = defaultWebSettings(reduced);
  try { preferences = loadWebSettings(localStorage, reduced); } catch { /* storage disabled */ }
  view.settings = structuredClone(preferences.view);
  const input = new Input(preferences.keymap);
  mountTouchControls(app, input, () => preferences.haptics);
  const unported = new Set<string>();
  const audio = new AudioOutput();
  audio.setVolume(preferences.volume);
  let settingsOpen = false;
  const pauseReasons = new Set<string>();
  const pause = (reason: string, value: boolean) => {
    if (value) pauseReasons.add(reason); else pauseReasons.delete(reason);
    settingsOpen = pauseReasons.size > 0;
    input.setSuspended(settingsOpen);
    audio.suspend(document.hidden || settingsOpen);
  };
  document.addEventListener('visibilitychange', () => audio.suspend(document.hidden || settingsOpen));
  const engine = new Engine(bundle, store, ui, SCRIPTS, new GbBattleHost(), {
    audioFrame: (writes, timed) => audio.frame(writes, timed),
    battleState: (active) => {
      ui.classList.toggle('in-battle', active);
      if (!active) ui.classList.remove('battle-stage');
    },
    battleScene: (active) => ui.classList.toggle('battle-stage', active),
    // Init: restart from the save (there is no title screen yet)
    reset: () => {
      const url = new URL(location.href);
      url.searchParams.delete('new');
      location.href = url.toString();
    },
    unported: (what) => {
      if (unported.has(what)) return;
      unported.add(what);
      console.warn(`[unported] ${what}`);
    },
  });
  // Power-on: title screen and main menu, unless a debug start position or ?new was given
  if (!(import.meta.env.DEV && params.has('new')) && !mapParam) engine.boot = bootSequence;
  const sync = attachView(engine, view);
  if (import.meta.env.DEV) mountDebugOverlay(app, bundle, store, engine, unported, () => view.diagnostics());
  mountWebSettings(app, {
    engine, settings: () => preferences,
    apply: (next) => {
      preferences = next;
      view.settings = structuredClone(next.view);
      input.keymap = structuredClone(next.keymap);
      audio.setVolume(next.volume);
      sync.refreshSettings();
    },
    pause: (paused) => pause('settings', paused),
  });
  player.saves.startPlaying();
  const panel = mountAccountPanel(app, player.saves, player.client, player.identity, {
    pause: value => pause('account', value), restart: () => location.reload(),
  });
  void offlineShell.then(ready => panel.offlineReady(ready));

  window.addEventListener('resize', () => view.resize());
  window.visualViewport?.addEventListener('resize', () => view.resize());
  window.addEventListener('keydown', (e) => {
    if (settingsOpen || (e.target as HTMLElement)?.closest?.('input, select, textarea, button, dialog') || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Equal' || e.code === 'Minus') {
      view.settings.cameraDistance = Math.max(4, Math.min(24, view.settings.cameraDistance + (e.code === 'Equal' ? -1 : 1)));
      preferences.view = structuredClone(view.settings);
      try { saveWebSettings(localStorage, preferences); } catch { /* storage disabled */ }
    }
  });

  let acc = 0;
  let last = performance.now();
  const loop = (now: number) => {
    const cpuStart = performance.now();
    const interval = now - last;
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (settingsOpen || document.hidden) acc = 0;
    else acc += dt;
    let n = 0;
    while (acc >= 1 / GB_FPS && n < 4) {
      if (engine.frame(input.poll())) view.tickFrames(1);
      acc -= 1 / GB_FPS;
      n++;
    }
    if (n === 4) acc = 0;
    sync();
    engine.screen.draw(); // filters can change while the game is paused
    const p = engine.sprites[0];
    if (p) {
      const [px, py] = engine.spriteRenderPos(p);
      view.follow(px, py, dt);
    }
    view.render();
    if (!document.hidden && !settingsOpen) view.profiler.add(interval, performance.now() - cpuStart);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  if (import.meta.env.DEV) Object.assign(window, { pyw: { bundle, store, view, engine, input, audio } });
}

main().catch((e) => {
  console.error(e);
  const error = document.createElement('div');
  error.className = 'account-boot';
  const card = document.createElement('section'); card.className = 'trainer-card';
  const title = document.createElement('h1'); title.textContent = 'Adventure on hold.';
  const message = document.createElement('p'); message.textContent = e instanceof Error ? e.message : String(e);
  const retry = document.createElement('button'); retry.textContent = 'Reload'; retry.onclick = () => location.reload();
  card.append(title, message, retry); error.append(card); document.body.append(error);
});
