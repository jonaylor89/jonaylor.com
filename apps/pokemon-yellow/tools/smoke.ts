/**
 * Browser smoke test / screenshot tool (dev only). Requires a running dev
 * server (`npm run dev`) and a local Chrome. Loads the ROM via the dev-only
 * `?rom=` parameter, optionally presses keys, and writes screenshots.
 *   npx tsx tools/smoke.ts "<query>" "<keys>" out.png
 * keys: comma-separated "Code:frames" pairs, e.g. "ArrowDown:40,KeyZ:2".
 */
import puppeteer from 'puppeteer-core';

const [query = '', keys = '', out = 'extracted/smoke.png'] = process.argv.slice(2);
const url = `http://localhost:${process.env.PORT ?? 5173}/?rom=/roms/pokeyellow.gbc&${query}`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const logs: string[] = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.pyw !== undefined', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));
const frameMs = 1000 / 60;
for (const k of keys.split(',').filter(Boolean)) {
  const [code, frames] = k.split(':');
  if (code === 'wait') {
    await new Promise((r) => setTimeout(r, Number(frames) * frameMs));
    continue;
  }
  await page.keyboard.down(code as never);
  await new Promise((r) => setTimeout(r, Number(frames ?? 2) * frameMs));
  await page.keyboard.up(code as never);
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: out });
const state = await page.evaluate(() => {
  const s = (window as any).pyw.store.state;
  return { map: s.player.map, x: s.player.x, y: s.player.y, facing: s.player.facing };
});
console.log(JSON.stringify(state));
console.log(logs.slice(-20).join('\n'));
await browser.close();
