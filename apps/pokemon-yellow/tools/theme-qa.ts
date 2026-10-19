/**
 * Texture-pack browser QA: screenshots of representative maps in each world
 * look, contact sheets, shader errors and render budgets. Needs the dev server
 * (`pnpm --filter pokemon-yellow dev:ui`) and downloaded game data.
 *
 *   PORT=5173 pnpm exec tsx tools/theme-qa.ts --looks original,remastered --scenes pallet,forest
 *   … --phone (emulated phone viewport) --out extracted/themes
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RENDER_BUDGET } from '../src/render/quality';

const SCENES: Record<string, string> = {
  pallet: 'map=PALLET_TOWN&x=5&y=6',
  viridian: 'map=VIRIDIAN_CITY&x=17&y=26',
  route: 'map=ROUTE_1&x=10&y=20',
  forest: 'map=VIRIDIAN_FOREST&x=16&y=40',
  cerulean: 'map=CERULEAN_CITY&x=18&y=20',
  ocean: 'map=ROUTE_21&x=10&y=50',
  cave: 'map=MT_MOON_1F&x=14&y=30',
  house: 'map=REDS_HOUSE_1F&x=3&y=5',
  center: 'map=VIRIDIAN_POKECENTER&x=3&y=5',
  gym: 'map=VERMILION_GYM&x=5&y=12',
  plateau: 'map=INDIGO_PLATEAU&x=9&y=10',
};
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const looks = (arg('looks') ?? 'original,remastered').split(',');
const scenes = (arg('scenes') ?? 'pallet,route,forest,ocean,cave,house,center').split(',');
const phone = process.argv.includes('--phone');
const out = resolve(arg('out') ?? 'extracted/themes');
const port = process.env.PORT ?? '5173';
mkdirSync(out, { recursive: true });
for (const s of scenes) if (!SCENES[s]) throw new Error(`unknown scene ${s}; known: ${Object.keys(SCENES).join(', ')}`);

const browser = await puppeteer.launch({
  args: ['--allow-file-access-from-files', ...(process.argv.includes('--software') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const report: Record<string, unknown>[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  for (const scene of scenes) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
    await page.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1280, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || /Shader Error|WebGLProgram/.test(m.text())) errors.push(m.text().slice(0, 2000)); });
    await page.goto(`http://localhost:${port}/?new&${SCENES[scene]}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.pyw !== undefined', { timeout: 30_000 });
    await page.evaluate(() => { (window as any).pyw.engine.ram.debugNoWildEncounters = true; });
    await wait(1200);
    for (const look of looks) {
      errors.length = 0;
      await page.evaluate((look) => {
        const { view } = (window as any).pyw;
        view.settings.look = look;
        view.refreshSettings();
      }, look);
      await wait(900);
      const file = `${out}/${scene}-${look}${phone ? '-phone' : ''}.png`;
      await page.screenshot({ path: file });
      const d = await page.evaluate(() => (window as any).pyw.view.diagnostics());
      report.push({ scene, look, file, drawCalls: d.drawCalls, triangles: d.triangles, textures: d.textures, errors: [...errors],
        overBudget: d.drawCalls > RENDER_BUDGET.drawCalls || d.triangles > RENDER_BUDGET.triangles * 2 });
    }
    await page.close();
  }
  // Contact sheets: one per look (all scenes) for quick review.
  const sheet = await browser.newPage();
  for (const look of looks) {
    const files = scenes.map((s) => `${out}/${s}-${look}${phone ? '-phone' : ''}.png`);
    const cols = phone ? 4 : 3, w = phone ? 260 : 480;
    await sheet.setViewport({ width: cols * (w + 4), height: 800 });
    const html = `${out}/sheet-${look}${phone ? '-phone' : ''}.html`;
    writeFileSync(html, `<body style="margin:0;background:#222;color:#eee;font:13px monospace;display:grid;grid-template-columns:repeat(${cols},${w}px);gap:4px">${files.map((f, i) => `<div><img src="file://${f}" width=${w}><div>${scenes[i]} · ${look}</div></div>`).join('')}</body>`);
    await sheet.goto(`file://${html}`, { waitUntil: 'load' });
    await sheet.screenshot({ path: `${out}/sheet-${look}${phone ? '-phone' : ''}.png`, fullPage: true });
  }
} finally {
  await browser.close();
}
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
const failed = report.filter((r) => (r.errors as string[]).length || r.overBudget);
for (const r of report) console.log(`${String(r.scene).padEnd(9)} ${String(r.look).padEnd(12)} calls=${r.drawCalls} tris=${r.triangles}${(r.errors as string[]).length ? ' ERRORS' : ''}`);
if (failed.length) { console.error(JSON.stringify(failed.map((f) => ({ scene: f.scene, look: f.look, errors: f.errors })), null, 1)); process.exit(1); }
