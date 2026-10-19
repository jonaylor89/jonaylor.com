/** The sound engine and the APU. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { HAS_ROM, bundle } from './helpers';
import { SoundEngine } from '../src/audio/soundEngine';
import { Apu } from '../src/audio/apu';
import { c } from '../src/rom/constants';

function render(apu: Apu, frames: number): number {
  const n = Math.round((48000 / 60) * frames);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  apu.render(l, r, 0, n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  return peak;
}

describe.skipIf(!HAS_ROM)('sound engine', () => {
  it('plays and loops map music', async () => {
    const b = await bundle();
    const snd = new SoundEngine(b.audio);
    const apu = new Apu(48000);
    snd.playMusic(c('music', 'MUSIC_PALLET_TOWN'), b.audio.musicBanks.MUSIC_PALLET_TOWN);
    let peak = 0;
    const regsSeen = new Set<number>();
    for (let f = 0; f < 60 * 120; f++) {
      snd.frame();
      for (const [a, v] of snd.takeWrites()) {
        regsSeen.add(a);
        apu.write(a, v);
      }
      if (f % 60 === 0) peak = Math.max(peak, render(apu, 1));
      else render(apu, 1);
    }
    // two minutes later the song is still looping on every music channel
    for (let ch = 0; ch < 3; ch++) expect(snd.soundId(ch)).toBe(c('music', 'MUSIC_PALLET_TOWN'));
    expect(regsSeen.has(0xff14) && regsSeen.has(0xff19) && regsSeen.has(0xff1e)).toBe(true);
    expect(peak).toBeGreaterThan(0.05);
  });

  it('plays a cry on the SFX channels and restores the music', async () => {
    const b = await bundle();
    const snd = new SoundEngine(b.audio);
    snd.playMusic(c('music', 'MUSIC_ROUTES1'), b.audio.musicBanks.MUSIC_ROUTES1);
    for (let f = 0; f < 10; f++) snd.frame();
    snd.playCry(c('pokemon', 'PIKACHU'));
    expect(snd.sfxPlaying).toBe(true);
    let frames = 0;
    while (snd.sfxPlaying && frames < 600) {
      snd.frame();
      frames++;
    }
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(200);
    expect(snd.soundId(0)).toBe(c('music', 'MUSIC_ROUTES1'));
    snd.takeWrites();
    // the music channels resume their own registers
    for (let f = 0; f < 120; f++) snd.frame();
    expect(snd.takeWrites().some(([a]) => a === 0xff14)).toBe(true);
  });

  it('fades out the music into the next song', async () => {
    const b = await bundle();
    const snd = new SoundEngine(b.audio);
    snd.playMusic(c('music', 'MUSIC_PALLET_TOWN'), b.audio.musicBanks.MUSIC_PALLET_TOWN);
    for (let f = 0; f < 30; f++) snd.frame();
    snd.lastMusicSoundID = c('music', 'MUSIC_PALLET_TOWN');
    snd.fadeOutControl = 10;
    snd.newSoundId(c('music', 'MUSIC_ROUTES1'));
    snd.playSound(c('music', 'MUSIC_ROUTES1'));
    let frames = 0;
    while (snd.soundId(0) !== c('music', 'MUSIC_ROUTES1') && frames < 1000) {
      snd.frame();
      frames++;
    }
    // 7 volume steps, 11 frames each
    expect(frames).toBeGreaterThan(70);
    expect(frames).toBeLessThan(100);
  });

  it('plays every sound effect to its end', async () => {
    const b = await bundle();
    const snd = new SoundEngine(b.audio);
    for (const name of ['SFX_GO_INSIDE', 'SFX_PRESS_AB', 'SFX_GET_ITEM_1', 'SFX_LEDGE', 'SFX_COLLISION', 'SFX_SAVE']) {
      snd.playSound(c('music', name));
      let frames = 0;
      while (snd.sfxPlaying && frames < 2000) {
        snd.frame();
        frames++;
      }
      expect(frames, name).toBeLessThan(2000);
    }
  });
});
