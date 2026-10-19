/** Real local workerd + D1 harness shared by API tests and browser QA. No Docker or cloud login. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { createServer } from 'node:net';

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
}
export async function startLocalBackend(options: { port?: number; origin?: string } = {}) {
  const port = options.port ?? await freePort();
  const baseURL = 'http://localhost:' + port;
  const origin = options.origin ?? baseURL;
  const directory = mkdtempSync(join(tmpdir(), 'pokeyellow-worker-'));
  const persist = join(directory, 'state'); const logPath = join(directory, 'worker.log');
  const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, WRANGLER_SEND_METRICS: 'false' };
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  mkdirSync('dist', { recursive: true });
  try {
    execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--env', 'local', '--local', '--persist-to', persist], { env, stdio: 'pipe', timeout: 60_000 });
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [wrangler, 'dev', '--env', 'local', '--local', '--port', String(port), '--persist-to', persist, '--var', 'APP_ORIGIN:' + origin], { env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const close = async () => {
    killTree(child);
    if (child.exitCode === null) await Promise.race([new Promise<void>(r => child.once('exit', () => r())), new Promise<void>(r => setTimeout(r, 3000))]);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error('Worker exited: ' + readFileSync(logPath, 'utf8'));
      try {
        const response = await fetch(baseURL + '/api/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) return { baseURL, origin, close, logPath };
      } catch { /* Startup in progress. */ }
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('Local Worker did not start: ' + readFileSync(logPath, 'utf8'));
  } catch (error) { await close(); throw error; }
}
