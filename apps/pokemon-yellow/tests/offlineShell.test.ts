import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { offlinePlugin } from '../tools/offline-plugin';

describe('production app-shell worker', () => {
  it('caches canonical HTML and never handles auth/save requests', async () => {
    let source = '';
    const plugin = offlinePlugin();
    const hook = plugin.generateBundle as Function;
    hook.call({ emitFile(asset: { source: string }) { source = asset.source; } }, {}, {
      'index.html': { type: 'asset', source: '<html>test</html>' },
      'assets/app.js': { type: 'chunk', code: 'console.log("test")' },
    });
    const handlers = new Map<string, Function>();
    let installed: Promise<unknown> | undefined;
    const added: string[] = [];
    const cachedResponse = Response.redirect('https://game.example/', 307);
    runInNewContext(source, {
      URL, Response,
      self: { location: { origin: 'https://game.example' }, registration: { scope: 'https://game.example/' }, addEventListener(name: string, fn: Function) { handlers.set(name, fn); } },
      caches: { async open() { return { async addAll(urls: string[]) { added.push(...urls); }, async match(url: string) { return url === 'https://game.example/' ? cachedResponse : undefined; } }; } },
      fetch() { throw new Error('Unexpected network access'); },
    });
    handlers.get('install')!({ waitUntil(promise: Promise<unknown>) { installed = promise; } });
    await installed;
    expect(added).toContain('https://game.example/');
    expect(added).not.toContain('https://game.example/index.html');
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://game.example/?account=recovery' }, respondWith(promise: Promise<Response>) { response = promise; } });
    expect((await response!).status).toBe(200);
    expect((await response!).redirected).toBe(false);
    for (const path of ['/api/auth/get-session', '/api/save', '/__dev/mail.json']) {
      let handled = false;
      handlers.get('fetch')!({ request: { method: 'GET', mode: 'cors', url: 'https://game.example' + path }, respondWith() { handled = true; } });
      expect(handled).toBe(false);
    }
  });
});
