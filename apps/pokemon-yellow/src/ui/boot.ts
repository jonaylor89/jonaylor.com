import type { GameBundle } from '../data/schema';
import { loadHostedBundle } from '../data/hosted';

export async function obtainBundle(root: HTMLElement): Promise<GameBundle> {
  const el = document.createElement('div');
  el.className = 'account-boot';
  el.innerHTML = '<section class="trainer-card"><p class="trainer-eyebrow">POKéMON YELLOW / WEB EDITION</p><h1>Your adventure<br>is waiting.</h1><p role="status">Preparing game data…</p><button type="button" hidden>Retry download</button><p class="trainer-note">Game data downloads automatically. No ROM upload needed.</p></section>';
  root.append(el);
  const status = el.querySelector<HTMLElement>('[role=status]')!;
  const retry = el.querySelector<HTMLButtonElement>('button')!;
  const progress = (message: string) => { status.textContent = message; };
  for (;;) {
    try {
      let bundle: GameBundle | undefined;
      if (import.meta.env.DEV) {
        const devRom = new URLSearchParams(location.search).get('rom');
        if (devRom) bundle = await (await import('./devBundle')).loadDeveloperRom(devRom, progress);
      }
      bundle ??= await loadHostedBundle(new URL(import.meta.env.VITE_GAME_MANIFEST_URL || 'game-data/manifest.json', document.baseURI).href, progress);
      el.remove();
      return bundle;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      retry.hidden = false;
      await new Promise<void>(resolve => retry.addEventListener('click', () => resolve(), { once: true }));
      retry.hidden = true;
    }
  }
}
