/**
 * Debug overlay (toggle with the backquote key): warp to map, set flags,
 * grant items, inspect state, undo, save/load.
 */
import type { GameBundle } from '../data/schema';
import type { Store } from '../game/state';
import { getBit } from '../game/state';
import { constEntries } from '../rom/constants';
import { readSave, writeSave } from '../game/save';
import type { Engine } from '../engine/Engine';
import { clearCachedBundle } from '../data/cache';
import { decodeParty, encodeParty } from '../game/gen1';
import { STORY_PRESETS, CUTSCENE_PRESETS, applyPreset, spawnEncounter } from '../dev/presets';
import { BUTTONS, type Button } from '../input/Input';

export function mountDebugOverlay(root: HTMLElement, bundle: GameBundle, store: Store, engine: Engine, unported: Set<string>, diagnostics?: () => unknown): void {
  const el = document.createElement('aside');
  el.className = 'debug';
  el.hidden = true;
  const maps = Object.values(bundle.maps).sort((a, b) => a.id - b.id);
  const events = constEntries('event', 'EVENT_');
  el.innerHTML = `
    <h2>Debug</h2>
    <section><h3>Warp</h3>
      <select class="d-map">${maps.map((m) => `<option value="${m.id}">${m.id.toString(16).padStart(2, '0')} ${m.constName}</option>`).join('')}</select>
      <input class="d-x" type="number" value="0" min="0" aria-label="x"><input class="d-y" type="number" value="0" min="0" aria-label="y">
      <button class="d-warp">Go</button>
      <button class="d-warp0">Go (first warp)</button>
    </section>
    <section><h3>Event flags</h3>
      <input class="d-flag" list="d-events" placeholder="EVENT_..."><datalist id="d-events">${events.map(([n]) => `<option value="${n}">`).join('')}</datalist>
      <button class="d-set">Set</button><button class="d-clear">Clear</button> <span class="d-flagval"></span>
    </section>
    <section><h3>Items</h3>
      <select class="d-item">${bundle.items.map((i) => `<option value="${i.id}">${i.name} (${i.constName})</option>`).join('')}</select>
      <input class="d-qty" type="number" value="1" min="1" max="99" aria-label="quantity"><button class="d-give">Give</button>
    </section>
    <section><h3>Spawn a wild encounter</h3>
      <select class="d-species" aria-label="Encounter species">${Object.values(bundle.species).sort((a, b) => a.dex - b.dex).map((s) => `<option value="${s.index}">${s.name}</option>`).join('')}</select>
      <input class="d-level" aria-label="Encounter level" type="number" min="1" max="100" value="5"><button class="d-spawn">Spawn</button>
    </section>
    <section><h3>Destructive story fixtures / cutscene replay</h3>
      <p>Replaces the current game. Use Save or Undo to keep your progress. Fixtures use a strong QA party.</p>
      <select class="d-preset" aria-label="Story fixture">${STORY_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select><button class="d-apply">Apply fixture</button>
      <select class="d-replay" aria-label="Cutscene replay">${CUTSCENE_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select><button class="d-play">Replay</button>
    </section>
    <section><h3>Frame / script-state stepper</h3>
      <label><input class="d-pause" type="checkbox"> Pause game frames</label>
      <label><input class="d-trace" type="checkbox"> Trace scripts/text/compiled asm</label>
      <label>Hold <select class="d-hold"><option value="">nothing</option>${BUTTONS.map((b) => `<option value="${b}">${b.toUpperCase()}</option>`).join('')}</select> while stepping</label>
      <button class="d-step">1 frame</button><button class="d-step10">10 frames</button><button class="d-script">Next script state (≤600 frames)</button>
      <pre class="d-tracelog"></pre>
    </section>
    <section><h3>State</h3>
      <button class="d-undo">Undo</button><button class="d-save">Save</button><button class="d-load">Load</button>
      <button class="d-reextract">Forget ROM data</button>
      <button class="d-export">Export party (Gen 1)</button><label>Import party <input class="d-import" type="file" accept=".bin,.pk1,application/octet-stream"></label>
      <pre class="d-state"></pre><pre class="d-performance"></pre>
      <p class="d-error" role="status"></p>
    </section>`;
  root.appendChild(el);
  const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const refresh = () => {
    const s = store.state;
    q<HTMLInputElement>('.d-pause').checked = engine.debugPaused;
    q<HTMLInputElement>('.d-trace').checked = engine.traceEnabled;
    q('.d-tracelog').textContent = engine.debugTrace.slice(-25).map((t) => `${t.frame} ${t.kind}: ${t.label}`).join('\n');
    q('.d-performance').textContent = diagnostics ? JSON.stringify(diagnostics(), null, 1) : '';
    q('.d-state').textContent = JSON.stringify(
      {
        map: `${bundle.maps[s.player.map]?.constName} (${s.player.x},${s.player.y}) ${s.player.facing}`,
        lastMap: bundle.maps[s.player.lastMap]?.constName,
        money: s.money,
        badges: s.badges.toString(2),
        bag: s.bag.map((b) => `${bundle.items.find((i) => i.id === b.item)?.name} x${b.qty}`),
        frames: s.frames,
        setEvents: events.filter(([, v]) => getBit(s.eventFlags, v)).map(([n]) => n),
        mapScript: s.mapScripts[s.player.map] ?? 0,
        vars: s.vars,
        party: s.party.map((m) => `${m.nickname} L${m.level} ${m.hp}/${m.maxHp}`),
        unported: [...unported],
        actions: store.log.length,
      },
      null,
      1,
    );
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote' && !(e.target as HTMLElement)?.closest?.('input, select, textarea, dialog')) {
      el.hidden = !el.hidden;
      if (!el.hidden) refresh();
    }
  });
  setInterval(() => { if (!el.hidden) refresh(); }, 500);
  const report = (action: () => void) => {
    try { action(); q('.d-error').textContent = ''; refresh(); } catch (error) { q('.d-error').textContent = String(error); }
  };
  q('.d-spawn').onclick = () => report(() => spawnEncounter(engine, Number(q<HTMLSelectElement>('.d-species').value), Number(q<HTMLInputElement>('.d-level').value)));
  const replace = (id: string) => {
    if (!confirm('Replace the current game with a debug fixture? Save first, or use Undo afterwards.')) return;
    report(() => { applyPreset(engine, id); engine.debugPaused = false; });
  };
  q('.d-apply').onclick = () => replace(q<HTMLSelectElement>('.d-preset').value);
  q('.d-play').onclick = () => replace(q<HTMLSelectElement>('.d-replay').value);
  q<HTMLInputElement>('.d-pause').onchange = (e) => { engine.debugPaused = (e.target as HTMLInputElement).checked; refresh(); };
  q<HTMLInputElement>('.d-trace').onchange = (e) => { engine.traceEnabled = (e.target as HTMLInputElement).checked; refresh(); };
  const held = () => { const b = q<HTMLSelectElement>('.d-hold').value as Button; return b ? [b] : []; };
  const step = (frames: number) => { engine.traceEnabled = true; engine.stepFrames(frames, held()); refresh(); };
  q('.d-step').onclick = () => step(1);
  q('.d-step10').onclick = () => step(10);
  q('.d-script').onclick = () => { engine.traceEnabled = true; engine.stepScript(held()); refresh(); };
  let t = 0;
  store.subscribe((_, a) => {
    if (el.hidden || a.type === 'tick') return;
    cancelAnimationFrame(t);
    t = requestAnimationFrame(refresh);
  });
  q('.d-warp').onclick = () =>
    engine.teleport(Number(q<HTMLSelectElement>('.d-map').value), Number(q<HTMLInputElement>('.d-x').value), Number(q<HTMLInputElement>('.d-y').value));
  q('.d-warp0').onclick = () => {
    const m = bundle.maps[Number(q<HTMLSelectElement>('.d-map').value)];
    const w = m.warps[0] ?? { x: 1, y: 1 };
    engine.teleport(m.id, w.x, w.y);
  };
  const flagId = () => events.find(([n]) => n === q<HTMLInputElement>('.d-flag').value)?.[1];
  q('.d-set').onclick = () => {
    const f = flagId();
    if (f !== undefined) store.dispatch({ type: 'setEvent', flag: f, value: true });
  };
  q('.d-clear').onclick = () => {
    const f = flagId();
    if (f !== undefined) store.dispatch({ type: 'setEvent', flag: f, value: false });
  };
  q('.d-flag').oninput = () => {
    const f = flagId();
    q('.d-flagval').textContent = f === undefined ? '' : getBit(store.state.eventFlags, f) ? 'SET' : 'clear';
  };
  q('.d-give').onclick = () =>
    store.dispatch({ type: 'giveItem', item: Number(q<HTMLSelectElement>('.d-item').value), qty: Number(q<HTMLInputElement>('.d-qty').value) });
  q('.d-undo').onclick = () => {
    store.undo();
    engine.reload();
  };
  q('.d-save').onclick = () => writeSave('slot1', store.state).then(refresh);
  q('.d-load').onclick = async () => {
    const f = await readSave('slot1');
    if (f) {
      store.dispatch({ type: 'replaceState', state: f.state });
      engine.reload();
    }
  };
  // the party in its WRAM layout (wPartyCount … wPartyMonNicksEnd)
  q('.d-export').onclick = () => {
    const blob = new Blob([new Uint8Array(encodeParty(store.state.party))], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'party.bin';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  q<HTMLInputElement>('.d-import').onchange = async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const party = decodeParty(bundle, new Uint8Array(await file.arrayBuffer()));
      store.dispatch({ type: 'setParty', party });
      refresh();
    } catch (err) {
      alert(`not a Gen 1 party: ${String(err)}`);
    }
  };
  q('.d-reextract').onclick = async () => {
    await clearCachedBundle();
    location.reload();
  };
}
