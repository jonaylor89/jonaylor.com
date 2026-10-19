/** Browser title QA against `pnpm dev:ui`; auth is deliberately mocked as guest. No worker or ROM needed. */
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = process.env.PYW_QA_DIR ?? mkdtempSync(join(tmpdir(), 'pokemon-home-'));
mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const delay = (ms = 120) => new Promise(r => setTimeout(r, ms));
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['portrait', 390, 844], ['landscape', 844, 390], ['small', 320, 568]] as const) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: name !== 'desktop', hasTouch: name !== 'desktop' });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().includes('/api/auth/')) void request.respond({ status: 200, contentType: 'application/json', body: 'null' });
      else void request.continue();
    });
    await page.goto(`http://localhost:${process.env.PORT ?? 5173}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.home-screen');
    const labels = () => page.$$eval('.home-menu strong', nodes => nodes.map(n => n.textContent));
    assert.deepEqual(await labels(), ['NEW GAME', 'SETTINGS', 'ACCOUNT']);
    assert.equal(await page.$eval('.touch-controls', e => getComputedStyle(e).display), 'none');
    assert.equal(await page.evaluate(() => (window as any).pyw.store.state.frames), 0);
    await page.screenshot({ path: join(output, `${name}-first.png`) });
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForSelector('.web-settings[open]');
    await page.select('#web-text-speed', 'fast');
    await page.click('.settings-done');
    await page.waitForFunction(() => document.activeElement?.textContent === 'SETTINGS');
    await page.keyboard.press('F2'); await page.waitForSelector('.web-settings[open]');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.click('.home-menu button:last-child');
    await page.waitForSelector('.trainer-dialog[open]');
    assert.match(await page.$eval('.trainer-identity', e => e.textContent!), /Guest/);
    await page.click('[data-action=close]');
    // Simulate the remapped keyboard without leaking input into the paused game.
    await page.evaluate(() => { (window as any).pyw.input.keymap.a = ['KeyQ']; });
    // Main preferences are normally changed through Settings; exercise that real route.
    await page.keyboard.press('F2');
    await page.click('[data-button=a]'); await page.keyboard.press('KeyQ');
    await page.click('.settings-done');
    await page.keyboard.press('ArrowUp'); // Account -> Settings
    await page.keyboard.press('KeyQ'); await page.waitForSelector('.web-settings[open]');
    await page.click('.settings-done');
    // Seed a valid checkpoint through the actual guest backend and return to title.
    await page.evaluate(async () => {
      const p = (window as any).pyw; const state = structuredClone(p.store.state);
      state.player.name = 'ASH'; state.player.map = 0; state.player.x = 5; state.player.y = 6;
      state.badges = 3; state.frames = 402 * 3600;
      const saves = await (new Function('return import("/src/game/save.ts")'))();
      await saves.writeSave('slot1', state);
    });
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.home-screen');
    assert.deepEqual(await labels(), ['CONTINUE', 'NEW GAME', 'SETTINGS', 'ACCOUNT']);
    assert.match(await page.$eval('.home-continue', e => e.textContent!), /ASH · PALLET TOWN.*2 badges · 06:42 played/);
    await page.screenshot({ path: join(output, `${name}-returning.png`) });
    // Keyboard cancellation is non-destructive and defaults to Keep.
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForSelector('.home-confirm[open]');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.home), 'keep');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.home-confirm'));
    // Standard gamepad handles title, settings and the overwrite dialog.
    await page.evaluate(() => {
      (window as any).qaPad = [];
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [{ mapping: 'standard', axes: [0, 0], buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: (window as any).qaPad.includes(i) })) }] });
    });
    const pad = async (index: number) => { await page.evaluate(i => { (window as any).qaPad = [i]; }, index); await delay(); await page.evaluate(() => { (window as any).qaPad = []; }); await delay(); };
    await delay(); await pad(13); // New Game -> Settings
    await pad(0); await page.waitForSelector('.web-settings[open]');
    await pad(1); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await pad(12); await pad(0); await page.waitForSelector('.home-confirm[open]');
    await pad(1); await page.waitForFunction(() => !document.querySelector('.home-confirm'));
    // Switching offline updates status without disabling local play.
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
    assert.match(await page.$eval('.home-status', e => e.textContent!), /Offline/);
    if (name === 'desktop') {
      await page.click('.home-menu button:nth-child(2)');
      await page.evaluate(() => {
        (window as any).originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new Error('QA storage full'); };
      });
      await page.click('[data-home=replace]');
      await page.waitForFunction(() => document.querySelector('.home-confirm [role=status]')?.textContent?.includes('Nothing was replaced'));
      await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).originalPut; });
      assert(await page.$('.home-screen'));
      await page.click('[data-home=replace]');
      await page.waitForFunction(() => !document.querySelector('.home-screen'));
      assert.equal(await page.evaluate(async () => {
        const saves = await (new Function('return import("/src/game/save.ts")'))(); return (await saves.readSave('slot1')).state.player.name;
      }), 'ASH');
      assert.equal(await page.evaluate(async () => {
        const saves = await (new Function('return import("/src/game/save.ts")'))(); return (await saves.readLegacySave('guest:before-new-game')).state.player.name;
      }), 'ASH');
      // Reloading before SAVE still offers the previous adventure.
      await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.home-continue');
    }
    await page.click('.home-continue');
    await page.waitForFunction(() => !document.querySelector('.home-screen') && (window as any).pyw.engine.world);
    assert.equal(await page.evaluate(() => (window as any).pyw.engine.state.player.map), 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ scenario: name, passed: true, errors }));
    await context.close();
  }
} finally {
  await browser.close();
  if (!process.env.PYW_QA_DIR) rmSync(output, { recursive: true, force: true });
}
