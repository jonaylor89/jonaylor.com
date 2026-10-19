/** Explicit developer-only automation path, never part of the player boot flow. */
import type { GameBundle } from '../data/schema';
import { storeBundle } from '../data/cache';
export async function loadDeveloperRom(url: string, progress: (text: string) => void): Promise<GameBundle> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Developer ROM fetch failed: ' + response.status);
  const bytes = await response.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../rom/extract.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    worker.onmessage = async ({ data }) => {
      if (data.type === 'progress') progress('Extracting ' + data.step + '…');
      if (data.type === 'error') { worker.terminate(); reject(new Error(data.message)); }
      if (data.type === 'done') {
        worker.terminate();
        await storeBundle(data.bundle).catch(() => undefined);
        resolve(data.bundle);
      }
    };
    worker.postMessage({ bytes }, [bytes]);
  });
}
