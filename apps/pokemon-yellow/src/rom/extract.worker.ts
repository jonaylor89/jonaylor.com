/// <reference lib="webworker" />
/** Runs ROM extraction off the main thread. */
import { extractBundle } from './extract';

self.onmessage = async (e: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const { bundle, warnings } = await extractBundle(new Uint8Array(e.data.bytes), (step, done, total) =>
      self.postMessage({ type: 'progress', step, done, total }),
    );
    self.postMessage({ type: 'done', bundle, warnings });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
