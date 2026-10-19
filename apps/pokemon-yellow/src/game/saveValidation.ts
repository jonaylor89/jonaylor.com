/** Structural validation only: client-run gameplay is not cheat-proof. */
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const string = (v: unknown) => typeof v === 'string' && v.length <= 128;
const numbers = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every(number);
const recordNumbers = (v: unknown) => object(v) && Object.keys(v).length <= 8192 && Object.values(v).every(number);
function mon(v: unknown): boolean {
  if (!object(v)) return false;
  return ['species', 'hp', 'boxLevel', 'status', 'catchRate', 'otId', 'exp', 'dvs', 'level', 'maxHp', 'atk', 'def', 'spd', 'spc'].every(k => number(v[k])) &&
    numbers(v.types, 2) && (v.types as unknown[]).length === 2 &&
    ['moves', 'pp'].every(k => numbers(v[k], 4) && (v[k] as unknown[]).length === 4) &&
    object(v.statExp) && ['hp', 'atk', 'def', 'spd', 'spc'].every(k => number((v.statExp as Obj)[k])) &&
    string(v.nickname) && string(v.otName);
}
function items(v: unknown, max: number): boolean {
  return Array.isArray(v) && v.length <= max && v.every(i => object(i) && number(i.item) && number(i.qty));
}
export function validSaveState(value: unknown, version: number): boolean {
  if (!object(value)) return false;
  const s = value;
  if (s.version !== version || ![1, 2].includes(version)) return false;
  if (!['frames', 'money', 'coins', 'badges', 'currentBox'].every(k => number(s[k]))) return false;
  const p = s.player;
  if (!object(p) || !string(p.name) || !string(p.rivalName) ||
      !['id', 'map', 'x', 'y', 'lastMap'].every(k => number(p[k])) ||
      !['up', 'down', 'left', 'right'].includes(p.facing as string) ||
      !['walk', 'bike', 'surf'].includes(p.mode as string)) return false;
  if (!['eventFlags', 'hiddenItems', 'hiddenCoins'].every(k => numbers(s[k], 16384)) ||
      !Array.isArray(s.objectVisible) || s.objectVisible.length > 16384 || !s.objectVisible.every(v => typeof v === 'boolean') ||
      !recordNumbers(s.mapScripts) || !(s.vars === undefined && version === 1 || recordNumbers(s.vars))) return false;
  if (!Array.isArray(s.party) || s.party.length > 6 || !s.party.every(mon) ||
      !Array.isArray(s.boxes) || s.boxes.length !== 12 || !s.boxes.every(box => Array.isArray(box) && box.length <= 20 && box.every(mon)) ||
      (s.currentBox as number) < 0 || (s.currentBox as number) >= 12 ||
      !items(s.bag, 20) || !items(s.pcItems, 50)) return false;
  if (!object(s.pokedex) || !numbers(s.pokedex.owned, 19) || !numbers(s.pokedex.seen, 19) ||
      !object(s.options) || !['fast', 'medium', 'slow'].includes(s.options.textSpeed as string) ||
      typeof s.options.battleAnimation !== 'boolean' || !['shift', 'set'].includes(s.options.battleStyle as string) ||
      !object(s.pikachu) || !number(s.pikachu.happiness) || !number(s.pikachu.mood) ||
      !object(s.rng) || !['seed', 'add', 'sub'].every(k => number((s.rng as Obj)[k]))) return false;
  if (s.daycare !== undefined && !mon(s.daycare)) return false;
  if (s.hallOfFame !== undefined && (!Array.isArray(s.hallOfFame) || s.hallOfFame.length > 50 ||
      !s.hallOfFame.every(team => Array.isArray(team) && team.length <= 6 && team.every(m =>
        object(m) && number(m.species) && number(m.level) && string(m.nick))))) return false;
  return true;
}
