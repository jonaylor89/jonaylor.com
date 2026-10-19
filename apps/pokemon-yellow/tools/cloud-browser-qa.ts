/**
 * Real production frontend + Better Auth + local Worker/D1 by default. No intercepted APIs,
 * anonymous cloud identities or IndexedDB save injection. Opt-in production mode creates
 * disposable blackhole test accounts; remove those exact users afterward (see DEPLOYMENT.md).
 */
import puppeteer, { type Page } from 'puppeteer-core';
import { randomBytes, randomUUID } from 'node:crypto';
import { postmarkTestLink } from './postmark-test-inbox';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startLocalBackend } from './localBackend';
import { enterGame, glyphTemplates, localRecord, saveThroughMenu, sleep } from './game-browser-input';
import type { GameBundle } from '../src/data/schema';
import type { LocalJournal } from '../src/cloud/types';

const production = process.env.PYW_PRODUCTION_ORIGIN;
if (production && production !== 'https://pokemon-yellow.jonaylor.com') throw new Error('Unexpected production QA origin.');
if (production && !process.env.POSTMARK_SERVER_TOKEN) throw new Error('Production QA requires Postmark access to its own blackhole messages.');
if (!existsSync('public/game-data/manifest.json')) throw new Error('Run prepare:assets with an authorized ROM and notice before browser QA.');
const manifest = JSON.parse(readFileSync('public/game-data/manifest.json', 'utf8'));
const bundle = JSON.parse(readFileSync('public/game-data/' + manifest.bundle.url, 'utf8')) as GameBundle;
const templates = glyphTemplates(bundle);
if (production) {
  const remote = await (await fetch(production + '/game-data/manifest.json')).json();
  assert.equal(remote.bundle?.sha256, manifest.bundle.sha256, 'Deployed release differs from local QA templates');
} else execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build'], { stdio: 'pipe', timeout: 60_000 });
const backend = production ? { baseURL: production, logPath: undefined, async close() {} } : await startLocalBackend();
const origin = backend.baseURL;
const password = production ? randomBytes(24).toString('base64url') : 'Browser-test-password-123';
const browserEnv = { ...process.env };
for (const key of ['POSTMARK_SERVER_TOKEN', 'CLOUDFLARE_API_TOKEN', 'BETTER_AUTH_SECRET']) delete browserEnv[key];
const browser = await puppeteer.launch({
  env: browserEnv,
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
let page: Page | undefined;
mkdirSync('extracted', { recursive: true });
const aliceEmail = production ? 'pokemon-qa-' + randomUUID() + '@blackhole.postmarkapp.com' : 'alice@example.test';
const bobEmail = production ? 'pokemon-qa-' + randomUUID() + '@blackhole.postmarkapp.com' : 'bob@example.test';
if (production) {
  const records = 'extracted/production-qa-users.json';
  const previous: string[] = existsSync(records) ? JSON.parse(readFileSync(records, 'utf8')) : [];
  writeFileSync(records, JSON.stringify([...previous, aliceEmail, bobEmail], null, 2));
}
async function emailLink(email: string, kind: string) {
  if (production) return postmarkTestLink(email, kind, origin);
  for (let i = 0; i < 80; i++) {
    const rows = await (await fetch(origin + '/__dev/mail.json')).json() as { recipient: string; subject: string; url: string }[];
    const mail = rows.find(row => row.recipient === email && row.subject.includes(kind));
    if (mail) return mail.url;
    await sleep(50);
  }
  throw new Error('No ' + kind + ' email for ' + email);
}
async function openLogin(page: Page) {
  await page.click('.account-open');
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.click('[data-action=signin]');
  await page.waitForSelector('dialog[open] form');
}
async function register(page: Page, email: string) {
  await page.type('[name=email]', email);
  await page.click('[data-action=register]');
  await page.type('[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] [role=status]')?.textContent?.includes('verify your account'));
  assert.equal((await fetch(await emailLink(email, 'Verify'), { redirect: 'manual' })).status, 302);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type=submit]')]);
}
async function chooseImport(page: Page, useGuest: boolean) {
  await page.waitForFunction(() => document.querySelector('dialog[open] h1')?.textContent === 'Bring your guest adventure?');
  await page.evaluate(useGuest => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog[open] button'));
    buttons.find(button => button.textContent?.includes(useGuest ? 'Import the guest save' : 'Keep my account save'))!.click();
  }, useGuest);
  await page.waitForSelector('.account-open');
}
async function cloud(page: Page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/auth/get-session')).json();
    const save = await (await fetch('/api/save', { headers: { 'X-Game-Account': session.user.id } })).json();
    return { owner: session.user.id as string, save };
  });
}
async function synced(page: Page, owner: string, revision: number) {
  for (let i = 0; i < 100; i++) {
    const journal = await localRecord<LocalJournal>(page, 'account:' + owner + ':slot1');
    if (!journal?.pending && journal && journal.revision >= revision) return journal;
    await sleep(100);
  }
  throw new Error('Checkpoint did not sync');
}
try {
  const firstContext = await browser.createBrowserContext();
  page = await firstContext.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const documentResponse = await page.goto(origin, { waitUntil: 'networkidle0' });
  assert.equal(documentResponse?.headers()['referrer-policy'], 'no-referrer');
  assert(documentResponse?.headers()['content-security-policy']?.includes("script-src 'self'"));
  await page.waitForSelector('.account-open');
  assert((await page.$eval('.account-open', element => element.textContent))?.includes('Guest'));
  assert.equal(await page.$('dialog[open]'), null);
  assert.equal(await page.$('input[type=file]'), null);
  assert.equal(await page.evaluate(() => 'pyw' in window), false);
  await enterGame(page, templates);
  const guestPayload = await saveThroughMenu(page, templates, 'guest:slot1') as string;
  await page.waitForSelector('.guest-save-suggestion:not([hidden])');
  await page.screenshot({ path: 'extracted/guest-save-phone.png' });
  await page.click('[data-action=dismiss]');
  // SAVE already succeeded; taking the optional suggestion never gates local persistence.
  await openLogin(page);
  await register(page, aliceEmail);
  await chooseImport(page, true);
  const firstCloud = await cloud(page);
  await synced(page, firstCloud.owner, 1);
  assert.equal((await cloud(page)).save.payload, guestPayload);
  assert.equal(await localRecord(page, 'guest:slot1'), guestPayload);
  await page.click('.account-open');
  await page.waitForFunction(() => document.querySelector('.trainer-offline-status')?.textContent?.startsWith('Offline ready'));
  await page.screenshot({ path: 'extracted/account-panel-phone.png' });
  await page.click('[data-action=close]');
  await enterGame(page, templates);
  await page.setOfflineMode(true);
  await saveThroughMenu(page, templates, 'account:' + firstCloud.owner + ':slot1');
  const offlineJournal = await localRecord<LocalJournal>(page, 'account:' + firstCloud.owner + ':slot1');
  assert(offlineJournal?.pending); const offlinePayload = offlineJournal.payload;
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.account-open');
  assert.equal((await localRecord<LocalJournal>(page, 'account:' + firstCloud.owner + ':slot1'))?.payload, offlinePayload);
  assert.equal(await page.$('input[type=file]'), null);

  const secondContext = await browser.createBrowserContext();
  const other = await secondContext.newPage(); other.on('pageerror', error => errors.push(String(error)));
  await other.goto(origin + '/api/health');
  const signInResult = await other.evaluate(async ({ email, password }) => {
    const response = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return response.status;
  }, { email: aliceEmail, password });
  assert.equal(signInResult, 200);
  await other.goto(origin, { waitUntil: 'networkidle0' }); await other.waitForSelector('.account-open');
  await enterGame(other, templates);
  await saveThroughMenu(other, templates, 'account:' + firstCloud.owner + ':slot1');
  const otherJournal = await synced(other, firstCloud.owner, 2);
  assert.notEqual(otherJournal.payload, offlinePayload);

  await page.bringToFront(); await page.setOfflineMode(false);
  await page.waitForFunction(() => document.querySelector('dialog[open] h1')?.textContent === 'Two adventures. Your choice.');
  await page.screenshot({ path: 'extracted/account-conflict-phone.png' });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('dialog[open] button')).find(button => button.textContent?.includes('Use the cloud save'))!.click()),
  ]);
  await page.waitForSelector('.account-open');
  const resolved = await localRecord<LocalJournal>(page, 'account:' + firstCloud.owner + ':slot1');
  assert.equal(resolved?.payload, otherJournal.payload);
  assert(resolved.backups.some(backup => backup.payload === offlinePayload));
  await page.click('.account-open'); await page.click('[data-action=recover]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h1')?.textContent === 'Recovery history');
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('dialog[open] button')!.click());
  page.once('dialog', dialog => { void dialog.accept(); });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('[data-action=signout]')]);
  await page.waitForSelector('.account-open');
  assert((await page.$eval('.account-open', element => element.textContent))?.includes('Guest'));
  assert.equal(await localRecord(page, 'guest:slot1'), guestPayload);
  assert.equal((await cloud(other)).save.revision, 2); // Sign-out did not revoke the other device.
  await openLogin(page); await register(page, bobEmail); await chooseImport(page, false);
  const bob = await cloud(page); assert.notEqual(bob.owner, firstCloud.owner); assert.equal(bob.save.revision, 0);
  assert.equal((await localRecord<LocalJournal>(page, 'account:' + firstCloud.owner + ':slot1'))?.payload, otherJournal.payload);

  await openLogin(page);
  await page.type('[name=email]', bobEmail); await page.click('[data-action=reset]');
  await page.waitForFunction(() => document.querySelector('dialog[open] [role=status]')?.textContent?.includes('password-reset'));
  const redirect = await fetch(await emailLink(bobEmail, 'Reset'), { redirect: 'manual' });
  await page.goto(new URL(redirect.headers.get('location')!, origin).href, { waitUntil: 'networkidle0' });
  await page.waitForSelector('dialog[open] input[autocomplete=new-password]');
  await page.type('[name=password]', 'New-browser-password-456'); await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] [role=status]')?.textContent?.includes('Password updated'));
  await page.type('[name=email]', bobEmail);
  await page.click('[name=password]', { clickCount: 3 }); await page.type('[name=password]', 'New-browser-password-456');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type=submit]')]);
  await page.waitForSelector('.account-open');
  const duplicate = await firstContext.newPage();
  await duplicate.goto(origin, { waitUntil: 'networkidle0' });
  await duplicate.waitForFunction(() => document.body.textContent?.includes('already playing in another tab'));
  await duplicate.close();
  const cachedApi = await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      if ((await cache.keys()).some(request => new URL(request.url).pathname.startsWith('/api/'))) return true;
    }
    return false;
  });
  assert.equal(cachedApi, false); assert.deepEqual(errors, []);
  console.log('Real backend browser QA passed: guest play and SAVE, optional registration/verification, explicit import, actual saves on two devices, offline reload, conflict/recovery, account isolation, reset/logout, tab locks and uncached APIs.');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'extracted/cloud-browser-failure.png' });
    writeFileSync('extracted/cloud-browser-failure.txt', await page.$eval('body', element => element.textContent ?? ''));
  }
  if (backend.logPath) writeFileSync('extracted/cloud-worker-failure.log', readFileSync(backend.logPath));
  throw error;
} finally { await browser.close(); await backend.close(); }
