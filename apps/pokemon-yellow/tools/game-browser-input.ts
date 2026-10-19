/** Drive production game input; decode displayed 8x8 glyph pixels, not private engine globals. */
import type { Page, KeyInput } from 'puppeteer-core';
import type { GameBundle } from '../src/data/schema';
import { encodePlain } from '../src/ui/TextPrinter';

export function glyphTemplates(bundle: GameBundle): Record<string, string> {
  const templates: Record<string, string> = {};
  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?!.,/-') {
    const code = encodePlain(char)[0];
    for (const font of [bundle.ui.font, bundle.ui.fontExtra]) {
      const index = code - font.firstChar!;
      if (index < 0 || index >= font.count) continue;
      templates[font.pixels.slice(index * 64, index * 64 + 64).map(pixel => pixel === 3 ? '1' : '0').join('')] = char;
    }
  }
  return templates;
}
export async function screenText(page: Page, templates: Record<string, string>): Promise<string> {
  return page.evaluate(templates => {
    const canvas = document.querySelector<HTMLCanvasElement>('.gb-screen');
    if (!canvas) return '';
    const ctx = canvas.getContext('2d'); if (!ctx) return '';
    const data = ctx.getImageData(0, 0, 160, 144).data;
    const rows: string[] = [];
    for (let y = 0; y < 18; y++) {
      let row = '';
      for (let x = 0; x < 20; x++) {
        const brightness: number[] = [];
        for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
          const offset = ((y * 8 + py) * 160 + x * 8 + px) * 4;
          brightness.push(data[offset + 3] ? data[offset] + data[offset + 1] + data[offset + 2] : 765);
        }
        const min = Math.min(...brightness); const max = Math.max(...brightness);
        const signature = brightness.map(value => value < (min + max) / 2 ? '1' : '0').join('');
        row += max === min ? ' ' : templates[signature] ?? ' ';
      }
      rows.push(row);
    }
    return rows.join('\n');
  }, templates);
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function tap(page: Page, key: KeyInput) {
  await page.evaluate(() => document.querySelector<HTMLCanvasElement>('#view')?.focus());
  await page.keyboard.press(key, { delay: 120 }); await sleep(120);
}
async function until(page: Page, templates: Record<string, string>, predicate: (text: string) => boolean, timeout = 25_000, advance = true) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const text = await screenText(page, templates);
    if (predicate(text)) return text;
    if (advance) await tap(page, 'z'); else await sleep(100);
  }
  throw new Error('Game screen did not reach expected state:\n' + await screenText(page, templates));
}
async function settledOverworld(page: Page, templates: Record<string, string>) {
  let blankSince: number | undefined;
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const text = await screenText(page, templates);
    const transparent = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.gb-screen');
      if (!canvas) return false;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, 160, 144).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return false;
      return true;
    });
    if (transparent) {
      blankSince ??= Date.now();
      if (Date.now() - blankSince > 1000) return;
    } else blankSince = undefined;
    if (text.trim()) await tap(page, 'z'); else await sleep(100);
  }
  throw new Error('Game did not return to its transparent overworld UI');
}
export async function enterGame(page: Page, templates: Record<string, string>) {
  await page.bringToFront();
  const home = await page.$('.home-screen');
  if (home) {
    const resume = await page.$('.home-continue');
    if (resume) { await resume.click(); await settledOverworld(page, templates); return; }
    await page.click('.home-menu button:first-child');
  } else {
    // Also supports the deployed legacy title until this change is published.
    const text = await until(page, templates, text => text.includes('NEW GAME') || text.includes('CONTINUE'));
    if (text.includes('CONTINUE')) {
      await tap(page, 'z'); await settledOverworld(page, templates); return;
    }
    await tap(page, 'z');
  }
  // New Game rules: preserve main's optional mod selection, defaulting to no mods.
  await page.waitForSelector('dialog.mod-picker[open]', { timeout: 25_000 });
  await page.click('dialog.mod-picker .settings-done');
  await until(page, templates, text => text.includes('NEW NAME'));
  await tap(page, 'ArrowDown'); await tap(page, 'ArrowDown'); await tap(page, 'z');
  await sleep(500);
  await until(page, templates, text => text.includes('NEW NAME'));
  await tap(page, 'ArrowDown'); await tap(page, 'ArrowDown'); await tap(page, 'z');
  await sleep(500);
  await settledOverworld(page, templates);
}
export async function localRecord<T>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open('pokeyellow-web');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('saves')) { db.close(); resolve(undefined); return; }
      const request = db.transaction('saves').objectStore('saves').get(key);
      request.onsuccess = () => { const result = request.result; db.close(); resolve(result); };
      request.onerror = () => reject(request.error);
    };
  }), key) as Promise<T | undefined>;
}
export async function saveThroughMenu(page: Page, templates: Record<string, string>, key: string) {
  await page.bringToFront();
  const before = JSON.stringify(await localRecord(page, key));
  await tap(page, 'Enter');
  await until(page, templates, text => text.includes('SAVE'), 5_000, false);
  for (let i = 0; i < 3; i++) await tap(page, 'ArrowDown'); // No Pokédex yet: SAVE is item 3.
  await tap(page, 'z');
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    await tap(page, 'z');
    const record = await localRecord(page, key);
    if (record !== undefined && JSON.stringify(record) !== before) {
      // Let the original save animation and confirmation finish before later menu input.
      await settledOverworld(page, templates);
      return record;
    }
  }
  throw new Error('SAVE did not persist a checkpoint:\n' + await screenText(page, templates));
}
