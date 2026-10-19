/**
 * The sound engine's data (audio/engine_*.asm, audio.asm): the four audio ROM
 * banks whole (headers, channel command streams and the engine's own tables
 * all live there and are read through 16-bit pointers within the bank), the
 * engine-1 tables, the cry table, and the labels the special routines point
 * channels at (the rival's alternate starts, Cities1's alternate tempo, the
 * Poké Flute in battle).
 */
import type { Rom } from '../Rom';
import { CONSTANTS, sym, symBank } from '../symbols';
import type { AudioData } from '../../data/schema';

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export function extractAudio(rom: Rom): AudioData {
  const engineBanks = [1, 2, 3, 4].map((n) => symBank(`Audio${n}_PlaySound`));
  const banks: Record<number, string> = {};
  for (const b of engineBanks) banks[b] = b64(rom.slice(b * 0x4000, 0x4000));
  const addr = (label: string) => {
    const off = sym(label);
    return off < 0x4000 ? off : (off % 0x4000) + 0x4000;
  };
  const bytes = (label: string, n: number) => [...rom.slice(sym(label), n)];
  const music = CONSTANTS.music;
  // the bank of each MUSIC_* (BANK(Music_*)) for PlayMusic
  const musicBanks: Record<string, number> = {};
  for (const name of Object.keys(music)) {
    if (!name.startsWith('MUSIC_')) continue;
    const label =
      'Music_' +
      name
        .slice(6)
        .toLowerCase()
        .split('_')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('');
    try {
      musicBanks[name] = symBank(label);
    } catch {
      // labels whose spelling differs are resolved below
    }
  }
  const fixes: Record<string, string> = {
    MUSIC_SS_ANNE: 'Music_SSAnne',
    MUSIC_MEET_PROF_OAK: 'Music_MeetProfOak',
    MUSIC_PKMN_HEALED: 'Music_PkmnHealed',
    MUSIC_GB_PRINTER: 'Music_GBPrinter',
    MUSIC_YELLOW_UNUSED_SONG: 'Music_YellowUnusedSong',
  };
  for (const [name, label] of Object.entries(fixes)) musicBanks[name] = symBank(label);
  const cryData: [number, number, number][] = [];
  for (let i = 0; i < 190; i++) {
    const p = sym('CryData') + i * 3;
    cryData.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2)]);
  }
  const labels: Record<string, number> = {};
  for (const l of [
    'Music_MeetRival_Ch1_AlternateStart',
    'Music_MeetRival_Ch2_AlternateStart',
    'Music_MeetRival_Ch3_AlternateStart',
    'Music_MeetRival_Ch1_AlternateTempo',
    'Music_MeetRival_Ch1_AlternateStartAndTempo',
    'Music_Cities1_Ch1_AlternateTempo',
    'SFX_Pokeflute_Ch5',
    'SFX_Pokeflute_Ch6',
    'SFX_Pokeflute_Ch7',
  ])
    labels[l] = addr(l);
  return {
    engineBanks,
    banks,
    sfxHeaders: [1, 2, 3, 4].map((n) => addr(`SFX_Headers_${n}`)),
    cryRet: [1, 2, 3, 4].map((n) => addr(`Audio${n}_CryRet`)),
    pitches: Array.from({ length: 12 }, (_, i) => rom.u16(sym('Audio1_Pitches') + i * 2)),
    hwBase: bytes('Audio1_HWChannelBaseAddresses', 8),
    disableMasks: bytes('Audio1_HWChannelDisableMasks', 8),
    enableMasks: bytes('Audio1_HWChannelEnableMasks', 32),
    wavePointers: Array.from({ length: 8 }, (_, i) => rom.u16(sym('Audio1_WavePointers') + i * 2)),
    musicBanks,
    cryData,
    labels,
    pokedexRatingSfx: Array.from({ length: 7 }, (_, i) => [rom.u8(sym('PokedexRatingSfxPointers') + i * 2), rom.u8(sym('PokedexRatingSfxPointers') + i * 2 + 1)] as [number, number]),
    lowHealthTones: bytes('Music_DoLowHealthAlarm.toneDataHi', 12),
    // MoveSoundTable: (sound, pitch mod, tempo mod), one more entry than there are moves
    moveSounds: bytes('MoveSoundTable', 3 * 166),
  };
}
