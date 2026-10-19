import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Generate a release-pinned app-shell worker. Never cache auth/API responses. */
export function offlinePlugin(): Plugin {
  return {
    name: 'pokeyellow-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(name => !name.endsWith('.map'));
      const version = createHash('sha256');
      version.update('shell-v2-canonical-navigation');
      for (const name of files) {
        const file = bundle[name];
        version.update(name);
        version.update(file.type === 'chunk' ? file.code : file.source);
      }
      const cacheName = 'pokeyellow-shell-' + version.digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const CACHE = ${JSON.stringify(cacheName)};
const FILES = ${JSON.stringify(files)};
// Cloudflare Assets redirects /index.html to /. Cache the canonical root response.
const urls = FILES.map(file => new URL(file === 'index.html' ? './' : file, self.registration.scope).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(urls)));
  // No skipWaiting: a new release must not replace the app beneath a running game.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pokeyellow-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && url.pathname === new URL(self.registration.scope).pathname) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(self.registration.scope)).then(response => response ? new Response(response.body, { status: 200, headers: response.headers }) : fetch(event.request)));
  } else if (urls.includes(url.href)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(response => response || fetch(event.request)));
  }
});
` });
    },
  };
}
