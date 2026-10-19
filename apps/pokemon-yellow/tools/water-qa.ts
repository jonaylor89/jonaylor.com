/** Browser audit for water shaders, animation, reduced motion and palette fades.
 * Requires Vite and a locally supplied ROM. Phone viewports emulate layout/DPR,
 * not a physical phone GPU. PORT=5175 npx tsx tools/water-qa.ts --software
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { RENDER_BUDGET } from '../src/render/quality';

const software = process.argv.includes('--software');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
});
mkdirSync('extracted/water', { recursive: true });
const reports: unknown[] = [];
try {
  for (const s of [
    { name: 'pool', map: 'CERULEAN_GYM', x: 5, y: 12, phone: false },
    { name: 'ocean', map: 'ROUTE_21', x: 10, y: 50, phone: false },
    { name: 'harbor', map: 'VERMILION_DOCK', x: 9, y: 6, phone: false },
    { name: 'cave', map: 'SEAFOAM_ISLANDS_B4F', x: 9, y: 14, phone: false },
    { name: 'phone-ocean', map: 'ROUTE_21', x: 10, y: 50, phone: true },
    { name: 'phone-pool', map: 'CERULEAN_GYM', x: 5, y: 12, phone: true },
  ]) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
    await page.setViewport(s.phone ? { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { width: 1280, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://localhost:${process.env.PORT ?? 5173}/?rom=/roms/pokeyellow.gbc&new&map=${s.map}&x=${s.x}&y=${s.y}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.pyw !== undefined');
    await page.evaluate(() => {
      const { engine, view } = (window as any).pyw;
      engine.ram.debugNoWildEncounters = true;
      view.profiler.reset();
    });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `extracted/water/${s.name}.png` });
    const metrics = await page.evaluate(() => (window as any).pyw.view.diagnostics());
    const visualChecks = s.name === 'pool' ? await page.evaluate(() => {
      const v = (window as any).pyw.view;
      const render = v.render.bind(v), tick = v.tickFrames.bind(v);
      // Compare only the map canvas in a single JS turn: NPC/DOM animation
      // cannot accidentally make the animated/frozen-image checks pass.
      const visibility = v.scene.children.map((o: any) => [o, o.visible]);
      for (const [o] of visibility) o.visible = o.name.startsWith('map:');
      v.settings.reducedMotion = false;
      render(); const before = v.canvas.toDataURL();
      tick(97); render(); const animated = v.canvas.toDataURL();
      const phase = v.waterMotion.time.value;
      v.settings.reducedMotion = true;
      tick(97); render(); const frozen = v.canvas.toDataURL();
      const reducedMotion = frozen === animated && v.waterMotion.time.value === phase;
      v.settings.colorFilter = 'dmg'; v.refreshSettings(); render();
      const filter = v.canvas.toDataURL() !== frozen;
      v.settings.colorFilter = 'gbc'; v.refreshSettings();
      v.setPaletteRemap([3, 3, 3, 3], [3, 3, 3, 3]); render();
      const gl = v.renderer.getContext(), pixels = new Uint8Array(v.canvas.width * v.canvas.height * 4);
      gl.readPixels(0, 0, v.canvas.width, v.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // The ROM's darkest colour may be charcoal, not RGB zero. Shaded land
      // can be darker, but no water highlight may exceed that palette colour.
      const darkest = v.colors[0];
      const blackFade = pixels.every((p, i) => i % 4 === 3 || p <= darkest[i % 4] + 1);
      v.setPaletteRemap([0, 0, 0, 0], [0, 0, 0, 0]); render();
      // Sample projected water-triangle interiors, not the white sky/UI.
      const mesh = v.scene.children.find((o: any) => o.name === 'map:CERULEAN_GYM');
      const geo = mesh.geometry, info = geo.getAttribute('waterInfo'), pos = geo.getAttribute('position');
      const point = mesh.position.clone(), pixel = new Uint8Array(4), expected = v.colors[0];
      let whiteSamples = 0;
      for (let i = 0; i < geo.index.count; i += 3) {
        const ids = [geo.index.getX(i), geo.index.getX(i + 1), geo.index.getX(i + 2)];
        if (!ids.every((n) => info.getX(n) === 1 && info.getY(n) > 0.1)) continue;
        point.set(0, 0, 0);
        for (const n of ids) { point.x += pos.getX(n) / 3; point.y += pos.getY(n) / 3; point.z += pos.getZ(n) / 3; }
        point.applyMatrix4(mesh.matrixWorld).project(v.camera);
        if (Math.abs(point.x) > 0.95 || Math.abs(point.y) > 0.95 || point.z > 1) continue;
        gl.readPixels(Math.floor((point.x * 0.5 + 0.5) * v.canvas.width), Math.floor((point.y * 0.5 + 0.5) * v.canvas.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (expected.every((value: number, channel: number) => Math.abs(pixel[channel] - value) <= 1)) whiteSamples++;
      }
      const whiteFade = whiteSamples >= 10;
      v.setPaletteRemap([0, 1, 2, 3], [0, 0, 1, 3]);
      v.settings.reducedMotion = false;
      for (const [o, visible] of visibility) o.visible = visible;
      render();
      return { animated: before !== animated, reducedMotion, filter, blackFade, whiteFade };
    }) : undefined;
    const budgetsPass = metrics.triangles <= RENDER_BUDGET.triangles && metrics.drawCalls <= RENDER_BUDGET.drawCalls;
    const report = { scenario: s.name, software, physicalPhone: false, ...metrics, budgetsPass, visualChecks, errors };
    console.log(JSON.stringify(report)); reports.push(report);
    if (!budgetsPass || errors.length || (visualChecks && Object.values(visualChecks).some((v) => !v))) process.exitCode = 1;
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync('extracted/water/report.json', JSON.stringify({ browserAudit: true, reports }, null, 2));
