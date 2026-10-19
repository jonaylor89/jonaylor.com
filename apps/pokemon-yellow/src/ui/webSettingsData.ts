/** Validated, device-local web preferences. Original game options stay in the
 * save; camera, audio gain and keyboard bindings do not alter ROM game state.
 */
import { DEFAULT_VIEW, type ViewSettings } from '../render/OverworldView';
import { BUTTONS, DEFAULT_KEYMAP, type KeyMap, type Button } from '../input/Input';

export const WEB_SETTINGS_KEY = 'pokeyellow-web:web-settings';
export const LEGACY_VIEW_KEY = 'pokeyellow-web:view-settings';
export interface WebSettings { version: 1; view: ViewSettings; keymap: KeyMap; volume: number; haptics: boolean }
export interface SettingsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function defaultWebSettings(reducedMotion = false): WebSettings {
  return { version: 1, view: { ...DEFAULT_VIEW, reducedMotion }, keymap: structuredClone(DEFAULT_KEYMAP), volume: 1, haptics: false };
}
const bounded = (v: unknown, min: number, max: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
/** Reserve browser/UI shortcuts and modifier-only keys. */
export function validBinding(code: unknown): code is string {
  return typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Enter|Backspace|Shift(Left|Right)|Numpad[0-9]|Numpad(Enter|Add|Subtract)|Tab|Comma|Period|Slash|Semicolon|Quote|Bracket(Left|Right)|Backslash)$/.test(code);
}
export function normalizeWebSettings(value: unknown, reducedMotion = false): WebSettings {
  const result = defaultWebSettings(reducedMotion);
  if (!value || typeof value !== 'object') return result;
  const raw = value as Partial<WebSettings>;
  if (raw.version !== 1) return result;
  const view = raw.view ?? {} as Partial<ViewSettings>;
  result.view.cameraDistance = bounded(view.cameraDistance, 4, 24, result.view.cameraDistance);
  result.view.cameraPitchDeg = bounded(view.cameraPitchDeg, 25, 75, result.view.cameraPitchDeg);
  if (typeof view.reducedMotion === 'boolean') result.view.reducedMotion = view.reducedMotion;
  if (typeof view.colorFilter === 'string' && ['gbc', 'dmg', 'pocket', 'high-contrast'].includes(view.colorFilter)) result.view.colorFilter = view.colorFilter;
  result.volume = bounded(raw.volume, 0, 1, 1);
  if (typeof raw.haptics === 'boolean') result.haptics = raw.haptics;
  // Accept bindings atomically: partial/ambiguous maps fall back to safe defaults.
  const used = new Set<string>();
  if (raw.keymap && BUTTONS.every((b) => Array.isArray(raw.keymap![b]) && raw.keymap![b].length > 0 && raw.keymap![b].length <= 8 && raw.keymap![b].every((key) => {
    if (!validBinding(key) || used.has(key)) return false;
    used.add(key); return true;
  }))) result.keymap = structuredClone(raw.keymap);
  return result;
}
export function loadWebSettings(storage: SettingsStorage, reducedMotion = false): WebSettings {
  try {
    const saved = storage.getItem(WEB_SETTINGS_KEY);
    if (saved) return normalizeWebSettings(JSON.parse(saved), reducedMotion);
    const legacy = storage.getItem(LEGACY_VIEW_KEY);
    return legacy ? normalizeWebSettings({ version: 1, view: JSON.parse(legacy) }, reducedMotion) : defaultWebSettings(reducedMotion);
  } catch { return defaultWebSettings(reducedMotion); }
}
/** Failure to persist must not prevent using the panel (e.g. private browsing). */
export function saveWebSettings(storage: SettingsStorage, settings: WebSettings): boolean {
  try { storage.setItem(WEB_SETTINGS_KEY, JSON.stringify(settings)); return true; } catch { return false; }
}
export function remapKey(keymap: KeyMap, button: Button, code: string): KeyMap {
  if (!validBinding(code)) throw new Error('That key is reserved. Choose a letter, arrow, number or punctuation key.');
  const next = structuredClone(keymap);
  for (const other of BUTTONS) {
    if (other === button) continue;
    next[other] = next[other].filter((key) => key !== code);
    if (!next[other].length) throw new Error(`${other.toUpperCase()} needs a key first. Remap it before using this key.`);
  }
  next[button] = [code];
  return next;
}
export function keyLabel(code: string): string {
  return ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'SPACE', Enter: 'ENTER', Backspace: '⌫', ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT' } as Record<string, string>)[code] ?? code.replace(/^Key|^Digit/, '');
}
