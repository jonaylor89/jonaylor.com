/** Mobile input/layout smoke checks, using the user's ROM via the dev server. */
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
mkdirSync('extracted', { recursive: true });
try {
  for (const [name, width, height] of [['portrait', 390, 844], ['landscape', 844, 390]] as const) {
    const page = await browser.newPage();
    // tsx/esbuild may preserve local function names in serialized page callbacks.
    await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
    await page.setViewport({ width, height, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${process.env.PORT ?? 5173}/?rom=/roms/pokeyellow.gbc&new&map=ROUTE_1&x=10&y=20&party=CHARMANDER:20`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.pyw');
    await page.evaluate(() => { (window as any).pyw.engine.ram.debugNoWildEncounters = true; });
    const cdp = await page.createCDPSession();
    const insets = name === 'portrait' ? { top: 44, bottom: 34, left: 0, right: 0 } : { top: 0, bottom: 21, left: 44, right: 44 };
    // @ts-expect-error Chrome's experimental command is newer than the bundled CDP types.
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.evaluate(() => { (window as any).vibrations = []; Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (ms: number) => { (window as any).vibrations.push(ms); return true; } }); });
    await page.click('.settings-open');
    const dialog = await page.$eval('.web-settings', (e) => { const r = e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; });
    assert(dialog.left >= insets.left && dialog.right <= width-insets.right && dialog.top >= insets.top && dialog.bottom <= height-insets.bottom, JSON.stringify({dialog,insets}));
    await page.$eval('#web-haptics', (el) => { if (!(el as HTMLInputElement).checked) (el as HTMLElement).click(); });
    await page.click('.settings-done');
    await new Promise((r) => setTimeout(r, 100));
    await page.evaluate(() => { (window as any).pointerTrace = []; for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(type, (e) => { const p = e as PointerEvent; (window as any).pointerTrace.push([type, p.pointerId, (p.target as HTMLElement).className]); }, true); });
    const center = async (button: string) => page.$eval(`.touch-controls [data-b=${button}]`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const held = () => page.evaluate(() => [...(window as any).pyw.input.poll().held].sort());
    const a = await center('a'), left = await center('left'), up = await center('up');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }, { ...a, id: 2 }] });
    assert.deepEqual(await held(), ['a']);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...a, id: 2 }] });
    assert.deepEqual(await held(), ['a']);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.deepEqual(await held(), []);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...left, id: 3 }] });
    assert.deepEqual(await held(), ['left']);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: width / 2, y: 10, id: 3 }] });
    assert.deepEqual(await held(), []);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...up, id: 3 }] });
    await new Promise((r) => setTimeout(r, 50)); // Chrome coalesces pointermove until the next display frame.
    assert.deepEqual(await held(), ['up'], JSON.stringify(await page.evaluate(() => (window as any).pointerTrace)));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.deepEqual(await held(), []);
    assert((await page.evaluate(() => (window as any).vibrations.length)) > 0);
    await page.evaluate(() => {
      const e = (window as any).pyw.engine, step = e.frame.bind(e);
      e.ram.curOpponent = 177; e.ram.curEnemyLevel = 5;
      for (let i = 0; i < 4000; i++) {
        step({ held: new Set(i % 20 < 5 ? ['a'] : []), pressed: new Set(i % 20 === 0 ? ['a'] : []) });
        if (e.screen.get(10, 14) === 0x85 && e.screen.get(11, 14) === 0x88 && e.battleHost.current?.player.mon.species) break;
      }
      e.debugPaused = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    const layout = await page.evaluate((insets) => {
      const panel = document.querySelector('.gb-screen')!.getBoundingClientRect();
      return [...document.querySelectorAll('.touch-controls button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { button: b.getAttribute('data-b'), inside: r.left >= insets.left && r.top >= insets.top && r.right <= innerWidth-insets.right && r.bottom <= innerHeight-insets.bottom, overlaps: r.left < panel.right && r.right > panel.left && r.top < panel.bottom && r.bottom > panel.top };
      });
    }, insets);
    assert(layout.every((b) => b.inside && !b.overlaps), JSON.stringify(layout));
    await page.screenshot({ path: `extracted/mobile-${name}.png` });
    assert.equal(errors.length, 0, errors.join('\n'));
    const quality = await page.evaluate(() => (window as any).pyw.view.quality);
    assert.equal(quality.pixelRatio, 1.5); assert.equal(quality.margin, 4);
    console.log(JSON.stringify({ scenario: name, insets, dialog, layout, quality, errors }));
    await page.close();
  }
} finally { await browser.close(); }
