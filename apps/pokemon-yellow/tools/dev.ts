/** Local-only orchestration. Never invokes a remote D1 command or deployment. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const preview = process.argv.includes('--preview');
function portOption(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid ' + name);
  return value;
}
const appPort = portOption('--port', preview ? 8787 : 5173);
const workerPort = preview ? appPort : portOption('--worker-port', 8787);
const origin = 'http://localhost:' + appPort;
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, WRANGLER_SEND_METRICS: 'false', WORKER_ORIGIN: 'http://127.0.0.1:' + workerPort };
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const persist = resolve('.wrangler/state/local');
mkdirSync('dist', { recursive: true });
execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--env', 'local', '--local', '--persist-to', persist], { env, stdio: 'inherit', timeout: 60_000 });
const children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
function run(args: string[]) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' }); children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
run([wrangler, 'dev', '--env', 'local', '--local', '--port', String(workerPort), '--persist-to', persist, '--var', 'APP_ORIGIN:' + origin]);
if (!preview) run([resolve('node_modules/vite/bin/vite.js'), '--host', 'localhost', '--port', String(appPort), '--strictPort']);
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
console.log('Game: ' + origin + ' · local auth inbox: ' + origin + '/__dev/mail');
