/**
 * Script coverage report: for every map, whether its map script is handled
 * (hand-ported or recognised boilerplate) and which text_asm routines in its
 * texts have no handler yet.
 *   npx tsx tools/coverage.ts [--all]
 */
import { readFileSync } from 'node:fs';
import type { GameBundle, TextOp } from '../src/data/schema';
import { SCRIPTS } from '../src/scripts';
import { walkTextOps } from '../src/rom/text';

const bundle = JSON.parse(readFileSync('extracted/bundle.json', 'utf8')) as GameBundle;
const all = process.argv.includes('--all');

function asmLabels(ops: TextOp[] | undefined): string[] {
  return [...walkTextOps(ops ?? [])].filter((o) => o.t === 'asm').map((o) => (o as { label: string }).label);
}

let full = 0;
let total = 0;
const rows: string[] = [];
for (const m of Object.values(bundle.maps).sort((a, b) => a.id - b.id)) {
  total++;
  const ported = SCRIPTS.maps[m.constName];
  const scriptOk = !!ported || m.scriptKind !== 'custom';
  const missing: string[] = [];
  const tables = [m.texts, ...Object.values(m.altTexts ?? {})];
  for (const t of tables)
    for (const entry of Object.values(t)) {
      if (entry.kind !== 'text') continue;
      for (const l of asmLabels(bundle.texts[entry.label])) {
        const ok =
          ported?.texts?.[l] ||
          SCRIPTS.texts[l] ||
          SCRIPTS.patterns?.some(([re]) => re.test(l)) ||
          bundle.simpleAsm[l];
        if (!ok && !missing.includes(l)) missing.push(l);
      }
    }
  if (scriptOk && !missing.length) {
    full++;
    if (!all) continue;
  }
  rows.push(`${String(m.id).padStart(3)} ${m.constName.padEnd(30)} ${scriptOk ? (ported ? 'ported ' : m.scriptKind.slice(0, 7).padEnd(7)) : 'SCRIPT '} ${missing.join(' ')}`);
}
console.log(rows.join('\n'));
console.log(`\n${full}/${total} maps fully covered`);
