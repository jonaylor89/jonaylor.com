/**
 * Generates the *reference tables* the ROM extractor uses to find data inside
 * a user-supplied Pokémon Yellow ROM.
 *
 * Input: a built checkout of https://github.com/pret/pokeyellow (run `make`
 * there first so `pokeyellow.sym` exists, and have `rgbasm` on PATH).
 *
 * Output (committed to this repo; contains NO game data, only names/addresses):
 *   src/rom/generated/symbols.json   label -> (bank << 16 | address)
 *   src/rom/generated/constants.json group -> { CONSTANT_NAME: value }
 *
 * Usage: npm run gen:reference -- /path/to/pokeyellow
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: gen-reference <path-to-built-pokeyellow-checkout>');
  process.exit(1);
}
const outDir = join(import.meta.dirname, '..', 'src', 'rom', 'generated');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- symbols
const sym = readFileSync(join(repo, 'pokeyellow.sym'), 'utf8');
const rom: Record<string, number> = {};
const ram: Record<string, number> = {};
for (const line of sym.split('\n')) {
  const m = /^([0-9a-f]{2}):([0-9a-f]{4}) (\S+)$/i.exec(line.trim());
  if (!m) continue;
  const bank = parseInt(m[1], 16);
  const addr = parseInt(m[2], 16);
  const name = m[3];
  if (addr < 0x8000) rom[name] = (bank << 16) | addr;
  else if ((addr >= 0xa000 && addr < 0xe000) || addr >= 0xff80) ram[name] = (bank << 16) | addr; // WRAM/SRAM and HRAM
}
// Labels that live in the dedicated text banks (from the linker map).
const mapFile = readFileSync(join(repo, "pokeyellow.map"), "utf8");
const textLabels: string[] = [];
let inText = false;
for (const line of mapFile.split("\n")) {
  const sec = /SECTION: .*\["(.+)"\]/.exec(line);
  if (sec) {
    inText = /^Text \d+$|^Pokédex Text$/.test(sec[1]);
    continue;
  }
  const lab = /^\s+\$[0-9a-f]{4} = (\S+)$/i.exec(line);
  if (inText && lab && rom[lab[1]] !== undefined) textLabels.push(lab[1]);
}
// First trainer header label after `def_trainers` in each map's script file.
const trainerHeaders: Record<string, string> = {};
for (const f of readdirSync(join(repo, 'scripts'))) {
  if (!f.endsWith('.asm')) continue;
  const lines = readFileSync(join(repo, 'scripts', f), 'utf8').split('\n');
  const i = lines.findIndex((l) => /^\s*def_trainers\b/.test(l));
  if (i < 0) continue;
  const m = /^(\w+):/.exec(lines[i + 1] ?? '');
  if (m) trainerHeaders[f.replace(/\.asm$/, '')] = m[1];
}
writeFileSync(join(outDir, "symbols.json"), JSON.stringify({ rom, ram, textLabels, trainerHeaders }));
console.log(`text labels: ${textLabels.length}`);
console.log(`symbols: ${Object.keys(rom).length} rom, ${Object.keys(ram).length} ram`);

// -------------------------------------------------------------- constants
const constDir = join(repo, 'constants');
const skipFiles = new Set(['hardware.inc', 'charmap.asm', 'music_constants.asm']);
const names: Array<[string, string]> = [];
const seen = new Set<string>();
const add = (group: string, name: string) => {
  if (seen.has(name)) return;
  seen.add(name);
  names.push([group, name]);
};

for (const file of readdirSync(constDir).sort()) {
  if (skipFiles.has(file)) continue;
  const group = basename(file).replace(/_constants\.asm$|\.asm$/, '');
  const text = readFileSync(join(constDir, file), 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    let m: RegExpExecArray | null;
    if ((m = /^(?:const|const_export|shift_const)\s+(\w+)/.exec(line))) add(group, m[1]);
    else if ((m = /^map_const\s+(\w+)/.exec(line))) {
      add(group, m[1]);
      add('map_size', `${m[1]}_WIDTH`);
      add('map_size', `${m[1]}_HEIGHT`);
    } else if ((m = /^trainer_const\s+(\w+)/.exec(line))) {
      add(group, m[1]);
      add('opp', `OPP_${m[1]}`);
    } else if ((m = /^add_hm\s+(\w+)/.exec(line))) {
      add(group, `HM_${m[1]}`);
      add('tmnum', `${m[1]}_TMNUM`);
    } else if ((m = /^add_tm\s+(\w+)/.exec(line))) {
      add(group, `TM_${m[1]}`);
      add('tmnum', `${m[1]}_TMNUM`);
    } else if ((m = /^DEF\s+(\w+)\s+EQU\s/.exec(line))) add(group, m[1]);
  }
}

const includes = readFileSync(join(repo, 'includes.asm'), 'utf8')
  .split('\n')
  .filter((l) => !/music_constants/.test(l))
  .join('\n');
let asm = includes + '\n';
for (const [group, name] of names) {
  asm += `IF DEF(#${name})\n  IF ISCONST(#${name})\n    PRINTLN "${group}\\t${name}\\t{d:#${name}}"\n  ENDC\nENDC\n`;
}
const tmp = mkdtempSync(join(tmpdir(), 'pyw-'));
const asmPath = join(tmp, 'dump.asm');
writeFileSync(asmPath, asm);
const out = execFileSync('rgbasm', ['-I', repo + '/', '-o', join(tmp, 'dump.o'), asmPath], {
  cwd: repo,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const constants: Record<string, Record<string, number>> = {};
for (const line of out.split('\n')) {
  const [group, name, value] = line.split('\t');
  if (!value) continue;
  (constants[group] ??= {})[name] = Number(value);
}

// Music/SFX ids are computed from header addresses (see constants/music_constants.asm).
const music: Record<string, number> = {};
const musicText = readFileSync(join(constDir, 'music_constants.asm'), 'utf8');
const sfxBase = rom['SFX_Headers_1'] & 0xffff;
for (const m of musicText.matchAll(/music_const\s+(\w+),\s*(\w+)/g)) {
  const label = rom[m[2]];
  if (label === undefined) {
    console.warn(`warning: no symbol for ${m[1]} (${m[2]}); skipped`);
    continue;
  }
  music[m[1]] = ((label & 0xffff) - sfxBase) / 3;
}
constants.music = music;

// Per-map script / text / object constants are defined next to the map data
// (def_script_pointers, def_text_pointers, object_const_def + dw_const/const_export).
const script: Record<string, number> = {};
const textId: Record<string, number> = {};
const object: Record<string, number> = {};
const scanEnums = (file: string) => {
  let mode: 'none' | 'script' | 'text' | 'object' = 'none';
  let n = 0;
  let prevLabel = '';
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    const lab = /^(\w+):/.exec(line);
    if (lab) prevLabel = lab[1];
    if (/^def_script_pointers\b/.test(line)) [mode, n] = ['script', 0];
    else if (/^def_text_pointers\b/.test(line)) [mode, n] = ['text', 1];
    else if (/^object_const_def\b/.test(line)) [mode, n] = ['object', 1];
    else if (/^const_def\s+(\d+)/.test(line) && /_TextPointers:?\s*$/.test(prevLabel)) {
      mode = 'text';
      n = Number(/^const_def\s+(\d+)/.exec(line)![1]);
    }
    else if (mode !== 'none') {
      const dw = /^dw_const\s+\w+(?:\.\w+)?\s*,\s*(\w+)/.exec(line);
      const cst = /^const(?:_export)?\s+(\w+)/.exec(line);
      if (dw && (mode === 'script' || mode === 'text')) (mode === 'script' ? script : textId)[dw[1]] = n++;
      else if (cst && mode === 'object') object[cst[1]] = n++;
      else if (line && !/^(dw|db|const_skip|const_def)\b/.test(line)) mode = 'none';
      else if (/^const_skip\b/.test(line)) n++;
    }
  }
};
for (const dir of ['scripts', 'data/maps/objects']) {
  for (const f of readdirSync(join(repo, dir))) if (f.endsWith('.asm')) scanEnums(join(repo, dir, f));
}
constants.map_script = script;
constants.text_id = textId;
constants.object = object;

writeFileSync(join(outDir, 'constants.json'), JSON.stringify(constants, null, 0));
console.log(
  'constants:',
  Object.entries(constants)
    .map(([g, v]) => `${g}=${Object.keys(v).length}`)
    .join(' '),
);
