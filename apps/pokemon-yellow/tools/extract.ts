/**
 * Node CLI: extract a GameBundle from your own ROM for development/testing.
 *   npm run extract -- path/to/pokeyellow.gbc [out-dir]
 * Output goes to ./extracted/ (git-ignored). Never commit it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractBundle } from '../src/rom/extract';

const [romPath, outDir = 'extracted'] = process.argv.slice(2);
if (!romPath) {
  console.error('usage: npm run extract -- <rom.gbc> [out-dir]');
  process.exit(1);
}
const t0 = performance.now();
const { bundle, warnings } = await extractBundle(new Uint8Array(readFileSync(romPath)), (s, d, t) =>
  process.stdout.write(`\r[${d}/${t}] ${s.padEnd(24)}`),
);
process.stdout.write('\n');
mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(bundle);
writeFileSync(join(outDir, 'bundle.json'), json);
writeFileSync(join(outDir, 'NOTICE.txt'), bundle.meta.notice + '\n');
console.log(`maps=${Object.keys(bundle.maps).length} tilesets=${bundle.tilesets.length} sprites=${bundle.sprites.length} ` +
  `species=${Object.keys(bundle.species).length} moves=${bundle.moves.length} items=${bundle.items.length} ` +
  `trainers=${bundle.trainers.length} texts=${Object.keys(bundle.texts).length}`);
console.log(`bundle ${(json.length / 1024 / 1024).toFixed(2)} MiB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (warnings.length) console.log(`${warnings.length} warnings:\n  ` + warnings.slice(0, 30).join('\n  '));
