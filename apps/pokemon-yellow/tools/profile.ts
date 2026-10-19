/** Reproducible rendering audit; requires Vite and the developer's own ROM.
 * Run with --software to identify software-renderer results explicitly.
 * Phone runs emulate viewport/DPR/touch, NOT the GPU of a physical phone.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { RENDER_BUDGET } from '../src/render/quality';

const seconds = Number(process.env.PROFILE_SECONDS ?? 6);
const software = process.argv.includes('--software');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
});
const reports: unknown[] = [];
try {
  for (const scenario of [
    { name: 'desktop-town', map: 'PALLET_TOWN', x: 10, y: 10, mobile: false, battle: false },
    { name: 'desktop-forest', map: 'VIRIDIAN_FOREST', x: 16, y: 40, mobile: false, battle: false },
    { name: 'desktop-battle', map: 'ROUTE_1', x: 10, y: 20, mobile: false, battle: true },
    { name: 'phone-town', map: 'PALLET_TOWN', x: 10, y: 10, mobile: true, battle: false },
    { name: 'phone-forest', map: 'VIRIDIAN_FOREST', x: 16, y: 40, mobile: true, battle: false },
    { name: 'phone-battle', map: 'ROUTE_1', x: 10, y: 20, mobile: true, battle: true },
  ]) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
    await page.setViewport(scenario.mobile ? { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { width: 1280, height: 800, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${process.env.PORT ?? 5173}/?rom=/roms/pokeyellow.gbc&new&map=${scenario.map}&x=${scenario.x}&y=${scenario.y}&party=CHARMANDER:20`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.pyw !== undefined');
    await page.evaluate((battle) => {
      const { engine: e, input } = (window as any).pyw;
      e.ram.debugNoWildEncounters = true;
      if (!battle) { input.simulate(['b']); return; }
      const step = e.frame.bind(e);
      e.ram.curOpponent = 177; e.ram.curEnemyLevel = 5;
      for (let i = 0; i < 4000; i++) {
        step({ held: new Set(i % 20 < 5 ? ['a'] : []), pressed: new Set(i % 20 === 0 ? ['a'] : []) });
        if (e.screen.get(10, 14) === 0x85 && e.screen.get(11, 14) === 0x88 && e.battleHost.current?.player.mon.species) break;
      }
    }, scenario.battle);
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => (window as any).pyw.view.profiler.reset());
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const metrics = await page.evaluate(() => {
      const v = (window as any).pyw.view;
      const gl = v.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { ...v.diagnostics(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    });
    const location = await page.evaluate(() => ({map:(window as any).pyw.engine.world.data.constName,battle:!!(window as any).pyw.engine.ram.isInBattle}));
    if(location.map!==scenario.map || location.battle!==scenario.battle) errors.push('Scenario changed unexpectedly: '+JSON.stringify(location));
    const budgetsPass = metrics.drawCalls <= RENDER_BUDGET.drawCalls && metrics.triangles <= RENDER_BUDGET.triangles && metrics.geometries <= RENDER_BUDGET.geometries && metrics.textures <= RENDER_BUDGET.textures;
    const report = { scenario: scenario.name, location, physicalPhone: false, softwareRequested: software, browser: await browser.version(), ...metrics, budgetsPass, target60FpsPass: metrics.fps >= 58 && metrics.p95Ms <= 18.5, errors };
    reports.push(report);
    if(!budgetsPass || errors.length || (!software && !scenario.mobile && !report.target60FpsPass)) process.exitCode=1;
    console.log(JSON.stringify(report));
    await page.close();
  }
} finally { await browser.close(); }
mkdirSync('extracted', { recursive: true });
writeFileSync('extracted/performance.json', JSON.stringify({ measuredAt: new Date().toISOString(), seconds, budgets: RENDER_BUDGET, reports }, null, 2));
