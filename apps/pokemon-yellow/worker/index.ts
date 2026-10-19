import { createAuth } from './auth';
import { cleanupAuth } from './cleanup';
import { isLocal, type Env, type Context } from './env';
import { cloudHistory, readCloudSave, RequestReuseError, SaveRateError, validateSaveRequest, writeCloudSave } from './saves';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
async function boundedJson(request: Request, maximum = 2_200_000): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON body required');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function handleRequest(request: Request, env: Env, ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__dev/mail')) {
    if (!isLocal(request, env) || request.method !== 'GET') return json({ error: 'Not found' }, 404);
    const { results } = await env.DB.prepare('SELECT id, recipient, subject, url, created_at FROM local_mail ORDER BY id DESC LIMIT 100').all<{ id: number; recipient: string; subject: string; url: string; created_at: number }>();
    if (url.pathname === '/__dev/mail.json') return json(results);
    return new Response('<!doctype html><meta charset="utf-8"><title>Local authentication inbox</title><h1>Local auth inbox</h1><p>Development only. Refresh to see new mail.</p>' +
      results.map(mail => '<article><h2>' + escape(mail.subject) + '</h2><p>' + escape(mail.recipient) + '</p><a href="' + escape(mail.url) + '">Open authentication link</a></article>').join(''),
      { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
  }
  if (url.pathname === '/api/health') return json({ backend: 'workers-d1-better-auth' });
  if (url.pathname.startsWith('/api/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('origin') !== env.APP_ORIGIN) return json({ error: 'Origin not allowed' }, 403);
    let auth: ReturnType<typeof createAuth>;
    try { auth = createAuth(request, env, ctx); }
    catch { return json({ error: 'Authentication is not configured. See DEPLOYMENT.md.' }, 503); }
    if (url.pathname.startsWith('/api/auth/')) {
      if (Number(request.headers.get('content-length') ?? 0) > 16_384) return json({ error: 'Request too large' }, 413);
      if (request.method === 'POST') {
        try { request = new Request(request, { body: JSON.stringify(await boundedJson(request, 16_384)) }); }
        catch { return json({ error: 'Invalid or oversized authentication request' }, 400); }
      }
      const response = await auth.handler(request);
      const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store'); headers.set('Referrer-Policy', 'no-referrer');
      return new Response(response.body, { status: response.status, headers });
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.emailVerified) return json({ error: 'Sign in with a verified account to sync saves.' }, 401);
    const owner = session.user.id;
    // A consistency guard, NOT authorization: session identity always determines ownership.
    if (request.headers.get('x-game-account') !== owner) return json({ error: 'Account changed. Sign in to the original account to sync this checkpoint.' }, 409);
    if (url.pathname === '/api/save' && request.method === 'GET') return json(await readCloudSave(env.DB, owner));
    if (url.pathname === '/api/save/history' && request.method === 'GET') return json(await cloudHistory(env.DB, owner));
    if (url.pathname === '/api/save' && request.method === 'POST') {
      let input;
      try { input = validateSaveRequest(await boundedJson(request)); }
      catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid save' }, 400); }
      try { return json(await writeCloudSave(env.DB, owner, input)); }
      catch (error) {
        if (error instanceof RequestReuseError) return json({ error: error.message }, 409);
        if (error instanceof SaveRateError) return json({ error: error.message }, 429);
        throw error;
      }
    }
    return json({ error: 'Not found' }, 404);
  }
  if (!env.ASSETS) return new Response('Run the Vite dev server on port 5173, or build the app first.', { status: 404 });
  // Never SPA-fallback /api paths. Auth and save responses cannot enter the app-shell cache.
  return env.ASSETS.fetch(request);
}
export default {
  scheduled(_event: unknown, env: Env, ctx: Context) { ctx.waitUntil(cleanupAuth(env.DB)); },
  async fetch(request: Request, env: Env, ctx: Context) {
    try { return await handleRequest(request, env, ctx); }
    catch { console.error('Worker request failed'); return json({ error: 'Backend unavailable. Your local checkpoint is unchanged.' }, 500); }
  },
};
