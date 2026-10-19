/**
 * Operator release tool. Only use with authorization to distribute all included data.
 * npm run prepare:assets -- roms/pokeyellow.gbc --notice-file /path/to/approved-notice.txt
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractBundle } from '../src/rom/extract';
import { SCHEMA_VERSION } from '../src/data/schema';
import type { AssetManifest } from '../src/data/hosted';

const args = process.argv.slice(2);
const rom = args[0];
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const noticeFile = option('--notice-file');
if (!rom || !noticeFile) {
  throw new Error('Usage: prepare:assets <rom.gbc> --notice-file <approved-notice.txt> [--out public/game-data]');
}
const notice = readFileSync(noticeFile, 'utf8').trim();
if (!notice) throw new Error('The distribution notice must not be empty.');
const out = resolve(option('--out') ?? 'public/game-data');
const { bundle, warnings } = await extractBundle(new Uint8Array(readFileSync(rom)));
bundle.meta.derivedFromUserRom = false;
bundle.meta.notice = notice;
const bytes = Buffer.from(JSON.stringify(bundle));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const name = 'bundle-' + sha256 + '.json';
const manifest: AssetManifest = {
  format: 'pokeyellow-web-assets', release: sha256.slice(0, 16), schemaVersion: SCHEMA_VERSION,
  bundle: { url: name, sha256, bytes: bytes.length },
};
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, name), bytes);
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(out, 'NOTICE.txt'), notice + '\n');
console.log('Prepared schema ' + SCHEMA_VERSION + ' release ' + manifest.release + ' (' + bytes.length + ' bytes) in ' + out);
if (warnings.length) console.warn(warnings.length + ' extraction warnings (same extractor as developer tests).');
