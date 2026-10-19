import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYMAP, Input } from '../src/input/Input';
import { defaultWebSettings, loadWebSettings, normalizeWebSettings, remapKey, saveWebSettings, WEB_SETTINGS_KEY, LEGACY_VIEW_KEY } from '../src/ui/webSettingsData';

afterEach(() => vi.unstubAllGlobals());
class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe('web preferences', () => {
  it('has isolated defaults and respects the system reduced-motion preference', () => {
    const a = defaultWebSettings(true), b = defaultWebSettings();
    a.keymap.a[0] = 'KeyQ'; a.view.cameraDistance = 8;
    expect(b.keymap).toEqual(DEFAULT_KEYMAP);
    expect(b.view.cameraDistance).toBe(15);
    expect(a.view.reducedMotion).toBe(true);
    expect(b.view.reducedMotion).toBe(false);
  });

  it('round-trips validated camera, volume and keymaps, without game options in the device file', () => {
    const storage = new MemoryStorage();
    const value = defaultWebSettings();
    value.view.colorFilter = 'dmg';
    value.view.cameraPitchDeg = 60;
    value.volume = 0;
    value.keymap = remapKey(value.keymap, 'a', 'KeyQ');
    expect(saveWebSettings(storage, value)).toBe(true);
    expect(loadWebSettings(storage)).toEqual(value);
    expect(storage.getItem(WEB_SETTINGS_KEY)).not.toContain('textSpeed');
  });

  it('migrates old view preferences, clamps numeric values and rejects invalid enums', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_VIEW_KEY, JSON.stringify({ cameraDistance: 999, cameraPitchDeg: -10, colorFilter: 'invalid', reducedMotion: true }));
    const result = loadWebSettings(storage);
    expect(result.view).toEqual({ cameraDistance: 24, cameraPitchDeg: 25, colorFilter: 'gbc', reducedMotion: true, look: 'original' });
    expect(normalizeWebSettings({ version: 1, view: { look: 'remastered' } }).view.look).toBe('remastered');
    expect(normalizeWebSettings({ version: 1, view: { look: 'not-a-pack' } }).view.look).toBe('original');
    expect(normalizeWebSettings({ version: 1, volume: Infinity }).volume).toBe(1);
    expect(normalizeWebSettings({ version: 1, volume: -1 }).volume).toBe(0);
    expect(normalizeWebSettings({ version: 99 })).toEqual(defaultWebSettings());
  });

  it('recovers from corrupt data, denied storage, and ambiguous bindings', () => {
    const storage = new MemoryStorage();
    storage.setItem(WEB_SETTINGS_KEY, '{oops');
    expect(loadWebSettings(storage, true)).toEqual(defaultWebSettings(true));
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadWebSettings(denied)).toEqual(defaultWebSettings());
    expect(saveWebSettings(denied, defaultWebSettings())).toBe(false);
    const value = defaultWebSettings();
    value.keymap.start = ['KeyZ'];
    expect(normalizeWebSettings(value).keymap).toEqual(DEFAULT_KEYMAP);
    value.keymap.start = [];
    expect(normalizeWebSettings(value).keymap).toEqual(DEFAULT_KEYMAP);
  });

  it('remaps aliases atomically, never leaves another button unbound, and reserves UI shortcuts', () => {
    const map = structuredClone(DEFAULT_KEYMAP);
    expect(remapKey(map, 'b', 'KeyZ').a).toEqual(['KeyJ', 'Space']);
    expect(remapKey(map, 'b', 'KeyZ').b).toEqual(['KeyZ']);
    expect(() => remapKey(map, 'a', 'Enter')).toThrow('START needs a key');
    for (const key of ['F2', 'Escape', 'Backquote', 'Equal', 'Minus', 'MetaLeft']) expect(() => remapKey(map, 'a', key)).toThrow('reserved');
    expect(map).toEqual(DEFAULT_KEYMAP);
  });
});

describe('settings input isolation', () => {
  it('clears held input and suppresses keys, touch and gamepads until released after closing', () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    let gamepadHeld = false;
    vi.stubGlobal('navigator', { getGamepads: () => [{ mapping: 'standard', buttons: [{ pressed: gamepadHeld }], axes: [0, 0] }] });
    const key = (name: string, code: string) => {
      const event = new Event(name, { cancelable: true });
      Object.defineProperty(event, 'code', { value: code });
      events.dispatchEvent(event);
    };
    const input = new Input();
    try {
      key('keydown', 'KeyZ');
      expect(input.poll().pressed.has('a')).toBe(true);
      input.setSuspended(true);
      gamepadHeld = true;
      key('keydown', 'ArrowUp');
      input.setTouch('b', true);
      expect(input.poll().held.size).toBe(0);
      input.setSuspended(false);
      expect(input.poll().held.size).toBe(0);
      gamepadHeld = false;
      expect(input.poll().held.size).toBe(0);
      input.keymap = remapKey(input.keymap, 'a', 'KeyQ');
      key('keyup', 'KeyZ');
      key('keydown', 'KeyQ');
      expect([...input.poll().pressed]).toEqual(['a']);
    } finally { input.dispose(); }
    key('keydown', 'ArrowRight');
    expect(input.poll().held.has('right')).toBe(false);
  });
});
