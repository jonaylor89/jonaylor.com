/** Assets live in IndexedDB; the service worker keeps only the versioned app shell. */
export async function prepareOfflineShell(): Promise<boolean> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return false;
  await navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './', updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  return true;
}
