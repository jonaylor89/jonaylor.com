import { describe, expect, it } from 'vitest';
import { homeSaveStatus, homeSaveSummary } from '../src/ui/homeScreen';
import { gamepadButtons } from '../src/input/Input';
import { newGameState } from '../src/game/state';
import { deserializeSave, serializeSave } from '../src/game/save';
import type { GameBundle } from '../src/data/schema';

const bundle = { toggleableObjects: [], maps: { 0: { constName: 'PALLET_TOWN' } } } as unknown as GameBundle;
describe('browser home screen', () => {
  it('summarizes the actual checkpoint without modifying it', () => {
    const state = newGameState(bundle); state.player.name = 'ASH'; state.player.map = 0;
    state.badges = 0b101; state.frames = 402 * 3600;
    const file = deserializeSave(serializeSave(state)); const before = structuredClone(file);
    expect(homeSaveSummary(bundle, file)).toEqual({ trainer: 'ASH · PALLET TOWN', progress: '2 badges · 06:42 played' });
    expect(file).toEqual(before);
  });
  it('keeps device, cloud, offline, conflict and failed-save status distinct', () => {
    expect(homeSaveStatus({ account: false }, true)).toBe('Saved on this device');
    expect(homeSaveStatus({ account: false }, false)).toBe('Offline · Playing from this device');
    expect(homeSaveStatus({ account: true, status: 'synced' }, true)).toBe('Cloud save up to date');
    expect(homeSaveStatus({ account: true, status: 'synced' }, false)).toBe('Saved on this device · Sync when online');
    expect(homeSaveStatus({ account: true, status: 'pending' }, true)).toContain('Sync pending');
    expect(homeSaveStatus({ account: true, status: 'error' }, true)).toContain('Cloud unavailable');
    expect(homeSaveStatus({ account: true, status: 'conflict' }, false)).toBe('Choose a save to continue');
    expect(homeSaveStatus({ account: false, failed: true }, false)).toContain('NOT written');
  });
  it('uses the same standard gamepad controls in menus and gameplay', () => {
    const pad = (buttons: number[], axes = [0, 0], mapping = 'standard') => ({ mapping, axes, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: buttons.includes(i) })) }) as unknown as Gamepad;
    expect([...gamepadButtons([null, pad([0, 9, 13])])].sort()).toEqual(['a', 'down', 'start']);
    expect([...gamepadButtons([pad([1], [-1, -1])])].sort()).toEqual(['b', 'left', 'up']);
    expect(gamepadButtons([pad([0], [0, 0], '')]).size).toBe(0);
  });
});
