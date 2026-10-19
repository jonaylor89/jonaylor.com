/**
 * The Game Boy sound engine (audio/engine_1.asm with engine_2's init routines,
 * home/audio.asm, home/fade_audio.asm, audio/low_health_alarm.asm), ported to
 * run on a byte copy of the audio WRAM so its layout-dependent clears behave as
 * in the original. It runs once per frame (VBlank) and produces sound-register
 * writes for the APU; the game queries it (WaitForSoundToFinish, channel IDs).
 */
import type { AudioData } from '../data/schema';
import { ramSym } from '../rom/symbols';
import { c as konst } from '../rom/constants';

const NUM_CHANNELS = 8;
const CHAN3 = 2;
const CHAN4 = 3;
const CHAN5 = 4;
const CHAN7 = 6;
const CHAN8 = 7;

// wChannelFlags1 bits
const PERFECT_PITCH = 1 << 0;
const SOUND_CALL = 1 << 1;
const NOISE_OR_SFX = 1 << 2;
const VIBRATO_DIRECTION = 1 << 3;
const PITCH_SLIDE_ON = 1 << 4;
const PITCH_SLIDE_DECREASING = 1 << 5;
const ROTATE_DUTY_CYCLE = 1 << 6;
// wChannelFlags2
const EXECUTE_MUSIC = 1 << 0;

const REG_DUTY_SOUND_LEN = 1;
const REG_VOLUME_ENVELOPE = 2;
const REG_FREQUENCY_LO = 3;

const NR10 = 0xff10;
const NR30 = 0xff1a;
const NR50 = 0xff24;
const NR51 = 0xff25;
const NR52 = 0xff26;

/** Bits that read back as 1 from each sound register (FF10-FF26). */
const READ_OR = [0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff, 0xff, 0x00, 0x00, 0xbf, 0x00, 0x00, 0x70];

export type RegWrite = [addr: number, value: number];

export class SoundEngine {
  private readonly ram: Uint8Array;
  private readonly base: number;
  private readonly at: Record<string, number> = {};
  private readonly banks = new Map<number, Uint8Array>();
  /** Sound registers FF10-FF3F as written */
  readonly regs = new Uint8Array(0x30);
  /** This frame's register writes, taken by the audio output */
  writes: RegWrite[] = [];

  // audio-related variables outside the audio WRAM section
  lowHealthAlarm = 0; // wLowHealthAlarm
  fadeOutControl = 0; // wAudioFadeOutControl
  fadeOutCounter = 0;
  fadeOutReload = 0;
  lastMusicSoundID = 0; // wLastMusicSoundID
  /** wStatusFlags2 BIT_NO_AUDIO_FADE_OUT */
  noAudioFadeOut = false;
  /** wOptions SOUND bits (0 mono, 1-3 earphone modes) */
  soundOption = 0;

  private readonly CRY_START: number;
  private readonly CRY_END: number;
  private readonly BATTLE_START: number;
  private readonly BATTLE_END: number;
  private readonly NOISE_END: number;
  private readonly maxSfx: number[];

  constructor(readonly d: AudioData) {
    const labels = [
      'wUnusedMusicByte', 'wSoundID', 'wMuteAudioAndPauseMusic', 'wDisableChannelOutputWhenSfxEnds', 'wStereoPanning', 'wSavedVolume',
      'wChannelCommandPointers', 'wChannelReturnAddresses', 'wChannelSoundIDs', 'wChannelFlags1', 'wChannelFlags2', 'wChannelDutyCycles',
      'wChannelDutyCyclePatterns', 'wChannelVibratoDelayCounters', 'wChannelVibratoExtents', 'wChannelVibratoRates', 'wChannelFrequencyLowBytes',
      'wChannelVibratoDelayCounterReloadValues', 'wChannelPitchSlideLengthModifiers', 'wChannelPitchSlideFrequencySteps',
      'wChannelPitchSlideFrequencyStepsFractionalPart', 'wChannelPitchSlideCurrentFrequencyFractionalPart', 'wChannelPitchSlideCurrentFrequencyHighBytes',
      'wChannelPitchSlideCurrentFrequencyLowBytes', 'wChannelPitchSlideTargetFrequencyHighBytes', 'wChannelPitchSlideTargetFrequencyLowBytes',
      'wChannelNoteDelayCounters', 'wChannelLoopCounters', 'wChannelNoteSpeeds', 'wChannelNoteDelayCountersFractionalPart', 'wChannelOctaves',
      'wChannelVolumes', 'wMusicWaveInstrument', 'wSfxWaveInstrument', 'wMusicTempo', 'wSfxTempo', 'wSfxHeaderPointer', 'wNewSoundID',
      'wAudioROMBank', 'wAudioSavedROMBank', 'wFrequencyModifier', 'wTempoModifier', 'wUnusedAudioCounter',
    ];
    this.base = ramSym('wUnusedMusicByte');
    for (const l of labels) this.at[l] = ramSym(l) - this.base;
    this.ram = new Uint8Array(this.at.wUnusedAudioCounter + 2);
    for (const [bank, data] of Object.entries(d.banks)) {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.banks.set(Number(bank), bytes);
    }
    const m = (n: string) => konst('music', n);
    this.CRY_START = m('SFX_CRY_00');
    this.CRY_END = m('SFX_CRY_25') + 3;
    this.BATTLE_START = m('SFX_PECK');
    this.BATTLE_END = m('SFX_TRAINER_APPEARED') + 1;
    this.NOISE_END = m('SFX_NOISE_INSTRUMENT19') + 1;
    this.maxSfx = [m('SFX_SAFARI_ZONE_PA'), m('SFX_TRAINER_APPEARED'), m('SFX_SHOOTING_STAR'), m('SFX_GET_ITEM2_4_2') + 2];
    this.write(NR52, 0x80);
    this.stopAllAudio();
  }

  // ------------------------------------------------------------------ memory helpers
  private g(label: string, i = 0): number {
    return this.ram[this.at[label] + i];
  }
  private s(label: string, i: number, v: number): void {
    this.ram[this.at[label] + i] = v & 0xff;
  }
  private fill(label: string, n: number, v: number): void {
    this.ram.fill(v & 0xff, this.at[label], this.at[label] + n);
  }
  private ptr(c: number): number {
    return this.g('wChannelCommandPointers', c * 2) | (this.g('wChannelCommandPointers', c * 2 + 1) << 8);
  }
  private setPtr(c: number, p: number): void {
    this.s('wChannelCommandPointers', c * 2, p);
    this.s('wChannelCommandPointers', c * 2 + 1, p >> 8);
  }
  /** A ROM byte in the current audio bank (or the home bank below $4000). */
  private romByte(bank: number, addr: number): number {
    const b = this.banks.get(bank);
    if (!b || addr < 0x4000 || addr >= 0x8000) return 0xff;
    return b[addr - 0x4000];
  }
  /** GetNextMusicByte */
  private next(c: number): number {
    const p = this.ptr(c);
    const v = this.romByte(this.g('wAudioROMBank'), p);
    this.setPtr(c, p + 1);
    return v;
  }

  // ------------------------------------------------------------------ registers
  private write(addr: number, v: number): void {
    v &= 0xff;
    this.regs[addr - NR10] = v;
    this.writes.push([addr, v]);
  }
  private read(addr: number): number {
    const i = addr - NR10;
    return i < READ_OR.length ? this.regs[i] | READ_OR[i] : this.regs[i];
  }
  /** Audio1_GetRegisterPointer */
  private reg(c: number, r: number): number {
    return 0xff00 + this.d.hwBase[c] + r;
  }

  // ------------------------------------------------------------------ queries
  soundId(ch: number): number {
    return this.g('wChannelSoundIDs', ch);
  }
  /** WaitForSoundToFinish's condition: an SFX still running on channels 5, 6 or 8 */
  get sfxPlaying(): boolean {
    if (this.lowHealthAlarm & 0x80) return false;
    return !!(this.soundId(4) | this.soundId(5) | this.soundId(7));
  }
  get audioBank(): number {
    return this.g('wAudioROMBank');
  }
  get musicTempo(): number {
    return (this.g('wMusicTempo') << 8) | this.g('wMusicTempo', 1);
  }
  set musicTempo(v: number) {
    this.s('wMusicTempo', 0, v >> 8);
    this.s('wMusicTempo', 1, v);
  }
  /** wChannelNoteDelayCounters (the surfing minigame's tempo sync reads them) */
  noteDelay(ch: number): number {
    return this.g('wChannelNoteDelayCounters', ch);
  }

  // ------------------------------------------------------------------ the home routines
  /** PlaySound (home/audio.asm) */
  playSound(id: number): void {
    const b = id & 0xff;
    if (this.g('wNewSoundID')) for (let ch = 4; ch < 8; ch++) this.s('wChannelSoundIDs', ch, 0);
    if (this.fadeOutControl) {
      if (!this.g('wNewSoundID')) return;
      this.s('wNewSoundID', 0, 0);
      if (this.lastMusicSoundID !== 0xff) {
        // fade out the current music first
        this.lastMusicSoundID = b;
        this.fadeOutReload = this.fadeOutControl;
        this.fadeOutCounter = this.fadeOutControl;
        this.fadeOutControl = b;
        return;
      }
      this.fadeOutControl = 0;
    }
    this.s('wNewSoundID', 0, 0);
    this.determineAudioFunction(b);
  }

  /** PlayMusic: a song in a given audio bank */
  playMusic(id: number, bank: number): void {
    this.s('wNewSoundID', 0, id);
    this.fadeOutControl = 0;
    this.s('wAudioROMBank', 0, bank);
    this.s('wAudioSavedROMBank', 0, bank);
    this.playSound(id);
  }

  /** StopAllMusic */
  stopAllMusic(): void {
    this.s('wNewSoundID', 0, 0xff);
    this.playSound(0xff);
  }

  /** Set the audio bank and start a fade-out to `id` (PlayDefaultMusicCommon's tail). */
  setBanks(current: number, saved: number): void {
    this.s('wAudioROMBank', 0, current);
    this.s('wAudioSavedROMBank', 0, saved);
  }
  newSoundId(id: number): void {
    this.s('wNewSoundID', 0, id);
  }

  /** GetCryData + PlaySound for a species index; returns the sound ID played. */
  playCry(species: number): number {
    const [base, pitch, length] = this.d.cryData[species - 1] ?? [0, 0, 0x80];
    this.s('wFrequencyModifier', 0, pitch);
    this.s('wTempoModifier', 0, length);
    const id = (base * 3 + this.CRY_START) & 0xff;
    this.playSound(id);
    return id;
  }

  /** Overwrite a channel's command pointer with a labelled stream (the alternate starts, the flute). */
  overwriteChannelPointer(ch: number, label: string): void {
    const p = this.d.labels[label];
    if (p !== undefined) this.setPtr(ch, p);
  }

  /** The VBlank work: FadeOutAudio, Music_DoLowHealthAlarm, Audio1_UpdateMusic. */
  frame(): void {
    this.fadeOutAudio();
    this.doLowHealthAlarm();
    this.updateMusic();
  }

  /** FadeOutAudio */
  private fadeOutAudio(): void {
    if (!this.fadeOutControl) {
      if (this.noAudioFadeOut) return;
      if (this.regs[NR50 - NR10] !== 0x77) this.write(NR50, 0x77);
      return;
    }
    if (this.fadeOutCounter) {
      this.fadeOutCounter--;
      return;
    }
    this.fadeOutCounter = this.fadeOutReload;
    const v = this.regs[NR50 - NR10];
    if (v) {
      const lo = ((v & 0xf) - 1) & 0xf;
      const hi = (((v >> 4) - 1) & 0xf) << 4;
      this.write(NR50, hi | lo);
      return;
    }
    const b = this.fadeOutControl;
    this.fadeOutControl = 0;
    this.stopAllMusic();
    this.s('wAudioROMBank', 0, this.g('wAudioSavedROMBank'));
    this.s('wNewSoundID', 0, b);
    this.playSound(b);
  }

  /** Music_DoLowHealthAlarm */
  private doLowHealthAlarm(): void {
    const a = this.lowHealthAlarm;
    const tones = this.d.lowHealthTones;
    const playTone = (i: number) => {
      this.write(NR10, 0);
      for (let k = 0; k < 4; k++) this.write(NR10 + 1 + k, tones[i * 4 + k]);
    };
    if (a === 0xff) {
      this.lowHealthAlarm = 0;
      this.s('wChannelSoundIDs', CHAN5, 0);
      playTone(2);
      return;
    }
    if (!(a & 0x80)) return;
    let t = a & 0x7f;
    if (!t) {
      playTone(0);
      t = 30;
    } else {
      if (t === 20) playTone(1);
      this.s('wChannelSoundIDs', CHAN5, this.CRY_END);
      t = (this.lowHealthAlarm & 0x7f) - 1;
    }
    this.lowHealthAlarm = (t & 0x7f) | 0x80;
  }

  /** DetermineAudioFunction: the engine copy belonging to the current audio bank */
  private determineAudioFunction(id: number): void {
    const bank = this.g('wAudioROMBank');
    let n = this.d.engineBanks.indexOf(bank);
    if (n < 0) n = 3; // invalid banks default to audio 4
    this.playSoundN(n, id);
  }

  // ------------------------------------------------------------------ AudioN_PlaySound
  private playSoundN(n: number, id: number): void {
    this.s('wSoundID', 0, id);
    if (id === 0xff) return this.stopAllAudio();
    const max = this.maxSfx[n];
    const headers = this.d.sfxHeaders[n];
    const bank = this.d.engineBanks[n];
    const isSfx = id <= max || id > 0xfe;
    if (!isSfx) {
      this.initMusicVariables();
    } else {
      const header = headers + id * 3;
      this.s('wSfxHeaderPointer', 0, header >> 8);
      this.s('wSfxHeaderPointer', 1, header);
      let c = (this.romByte(bank, header) & 0xc0) >> 6;
      for (;;) {
        const e = this.romByte(bank, header + c * 3) & 0xf;
        const cur = this.soundId(e);
        let play = !cur;
        if (!play) {
          if (e === CHAN8) {
            if (id < this.NOISE_END) return;
            if (cur <= this.NOISE_END) play = true;
          }
          if (!play) {
            if (id <= cur) play = true;
            else return;
          }
        }
        this.initSfxVariables(e);
        if (c === 0) break;
        c--;
      }
    }
    // .playSoundCommon
    let de = headers + id * 3;
    let a = this.romByte(bank, de);
    let count = ((a >> 6) & 3) + 1;
    a &= 0xf;
    de++;
    let ch = 0;
    for (;;) {
      while (ch !== a && ch < 16) ch++;
      if (ch >= CHAN4) this.s('wChannelFlags1', ch, this.g('wChannelFlags1', ch) | NOISE_OR_SFX);
      this.setPtr(ch, this.romByte(bank, de) | (this.romByte(bank, de + 1) << 8));
      de += 2;
      this.s('wChannelSoundIDs', ch, id);
      ch++;
      count--;
      a = this.romByte(bank, de);
      de++;
      if (!count) break;
      a &= 0xff;
    }
    if (id >= this.CRY_START && id < this.CRY_END) {
      for (let k = CHAN5; k < 8; k++) this.s('wChannelSoundIDs', k, id);
      this.setPtr(CHAN7, this.d.cryRet[n]);
      if (!this.g('wSavedVolume')) {
        this.s('wSavedVolume', 0, this.regs[NR50 - NR10]);
        this.write(NR50, 0x77);
      }
    }
  }

  /** Audio2_InitMusicVariables */
  private initMusicVariables(): void {
    this.s('wUnusedMusicByte', 0, 0);
    this.s('wDisableChannelOutputWhenSfxEnds', 0, 0);
    this.s('wMusicTempo', 1, 0);
    this.s('wMusicWaveInstrument', 0, 0);
    this.s('wSfxWaveInstrument', 0, 0);
    this.fill('wChannelReturnAddresses', NUM_CHANNELS, 0);
    this.fill('wChannelCommandPointers', NUM_CHANNELS, 0);
    for (const l of [
      'wChannelSoundIDs', 'wChannelFlags1', 'wChannelDutyCycles', 'wChannelDutyCyclePatterns', 'wChannelVibratoDelayCounters',
      'wChannelVibratoExtents', 'wChannelVibratoRates', 'wChannelFrequencyLowBytes', 'wChannelVibratoDelayCounterReloadValues',
      'wChannelFlags2', 'wChannelPitchSlideLengthModifiers', 'wChannelPitchSlideFrequencySteps',
      'wChannelPitchSlideFrequencyStepsFractionalPart', 'wChannelPitchSlideCurrentFrequencyFractionalPart',
      'wChannelPitchSlideCurrentFrequencyHighBytes', 'wChannelPitchSlideCurrentFrequencyLowBytes',
      'wChannelPitchSlideTargetFrequencyHighBytes', 'wChannelPitchSlideTargetFrequencyLowBytes',
    ])
      this.fill(l, 4, 0);
    for (const l of ['wChannelLoopCounters', 'wChannelNoteDelayCounters', 'wChannelNoteSpeeds']) this.fill(l, 4, 1);
    this.s('wMusicTempo', 0, 1);
    this.s('wStereoPanning', 0, 0xff);
    this.write(NR50, 0);
    this.write(NR10, 0x08);
    this.write(NR51, 0);
    this.write(NR30, 0);
    this.write(NR30, 0x80);
    this.write(NR50, 0x77);
  }

  /** Audio2_InitSFXVariables */
  private initSfxVariables(e: number): void {
    this.s('wChannelReturnAddresses', e * 2, 0);
    this.s('wChannelReturnAddresses', e * 2 + 1, 0);
    this.setPtr(e, 0);
    for (const l of [
      'wChannelSoundIDs', 'wChannelFlags1', 'wChannelDutyCycles', 'wChannelDutyCyclePatterns', 'wChannelVibratoDelayCounters',
      'wChannelVibratoExtents', 'wChannelVibratoRates', 'wChannelFrequencyLowBytes', 'wChannelVibratoDelayCounterReloadValues',
      'wChannelPitchSlideLengthModifiers', 'wChannelPitchSlideFrequencySteps', 'wChannelPitchSlideFrequencyStepsFractionalPart',
      'wChannelPitchSlideCurrentFrequencyFractionalPart', 'wChannelPitchSlideCurrentFrequencyHighBytes',
      'wChannelPitchSlideCurrentFrequencyLowBytes', 'wChannelPitchSlideTargetFrequencyHighBytes',
      'wChannelPitchSlideTargetFrequencyLowBytes', 'wChannelFlags2',
    ])
      this.s(l, e, 0);
    for (const l of ['wChannelLoopCounters', 'wChannelNoteDelayCounters', 'wChannelNoteSpeeds']) this.s(l, e, 1);
    if (e === CHAN5) this.write(NR10, 0x08);
  }

  /** Audio2_StopAllAudio */
  private stopAllAudio(): void {
    this.write(NR52, 0x80);
    this.write(NR30, 0x80);
    this.write(NR51, 0);
    this.write(0xff1c, 0);
    this.write(NR10, 0x08);
    this.write(0xff12, 0x08);
    this.write(0xff17, 0x08);
    this.write(0xff21, 0x08);
    this.write(0xff14, 0x40);
    this.write(0xff19, 0x40);
    this.write(0xff23, 0x40);
    this.write(NR50, 0x77);
    this.s('wUnusedMusicByte', 0, 0);
    this.s('wDisableChannelOutputWhenSfxEnds', 0, 0);
    this.s('wMuteAudioAndPauseMusic', 0, 0);
    this.s('wMusicTempo', 1, 0);
    this.s('wSfxTempo', 1, 0);
    this.s('wMusicWaveInstrument', 0, 0);
    this.s('wSfxWaveInstrument', 0, 0);
    this.fill('wChannelCommandPointers', 0xb0, 0);
    this.fill('wChannelNoteDelayCounters', 0x18, 1);
    this.s('wMusicTempo', 0, 1);
    this.s('wSfxTempo', 0, 1);
    this.s('wStereoPanning', 0, 0xff);
  }

  // ------------------------------------------------------------------ Audio1_UpdateMusic
  private updateMusic(): void {
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (!this.soundId(c)) continue;
      const mute = this.g('wMuteAudioAndPauseMusic');
      if (c < CHAN5 && mute) {
        if (mute & 0x80) continue;
        this.s('wMuteAudioAndPauseMusic', 0, mute | 0x80);
        this.write(NR51, 0);
        this.write(NR30, 0);
        this.write(NR30, 0x80);
        continue;
      }
      this.applyMusicAffects(c);
    }
  }

  /** Audio1_ApplyMusicAffects */
  private applyMusicAffects(c: number): void {
    const delay = this.g('wChannelNoteDelayCounters', c);
    if (delay === 1) return this.playNextNote(c);
    this.s('wChannelNoteDelayCounters', c, delay - 1);
    if (c < CHAN5 && this.soundId(c + 4)) return;
    const f1 = () => this.g('wChannelFlags1', c);
    if (f1() & ROTATE_DUTY_CYCLE) this.applyDutyCyclePattern(c);
    if (!(this.g('wChannelFlags2', c) & EXECUTE_MUSIC) && f1() & NOISE_OR_SFX) return;
    if (f1() & PITCH_SLIDE_ON) return this.applyPitchSlide(c);
    const vd = this.g('wChannelVibratoDelayCounters', c);
    if (vd) {
      this.s('wChannelVibratoDelayCounters', c, vd - 1);
      return;
    }
    const ext = this.g('wChannelVibratoExtents', c);
    if (!ext) return;
    const rate = this.g('wChannelVibratoRates', c);
    if (rate & 0xf) {
      this.s('wChannelVibratoRates', c, rate - 1);
      return;
    }
    const swapped = ((rate << 4) | (rate >> 4)) & 0xff;
    this.s('wChannelVibratoRates', c, rate | swapped);
    const e = this.g('wChannelFrequencyLowBytes', c);
    let a: number;
    if (f1() & VIBRATO_DIRECTION) {
      this.s('wChannelFlags1', c, f1() & ~VIBRATO_DIRECTION);
      a = e - (ext & 0xf);
      if (a < 0) a = 0;
    } else {
      this.s('wChannelFlags1', c, f1() | VIBRATO_DIRECTION);
      a = e + (ext >> 4);
      if (a > 0xff) a = 0xff;
    }
    this.write(this.reg(c, REG_FREQUENCY_LO), a);
  }

  /** Audio1_PlayNextNote */
  private playNextNote(c: number): void {
    this.s('wChannelVibratoDelayCounters', c, this.g('wChannelVibratoDelayCounterReloadValues', c));
    this.s('wChannelFlags1', c, this.g('wChannelFlags1', c) & ~(PITCH_SLIDE_ON | PITCH_SLIDE_DECREASING));
    if (c === CHAN5 && this.lowHealthAlarm & 0x80) {
      this.enableChannelOutput(c);
      return;
    }
    this.soundRet(c);
  }

  /** The command interpreter (Audio1_sound_ret … Audio1_note_pitch) */
  private soundRet(c: number): void {
    for (;;) {
      const d = this.next(c);
      // sound_ret
      if (d === 0xff) {
        const f1 = this.g('wChannelFlags1', c);
        if (f1 & SOUND_CALL) {
          this.s('wChannelFlags1', c, f1 & ~SOUND_CALL);
          this.s('wChannelCommandPointers', c * 2, this.g('wChannelReturnAddresses', c * 2));
          this.s('wChannelCommandPointers', c * 2 + 1, this.g('wChannelReturnAddresses', c * 2 + 1));
          continue;
        }
        let disable = c < CHAN4;
        if (!disable) {
          this.s('wChannelFlags1', c, f1 & ~NOISE_OR_SFX);
          this.s('wChannelFlags2', c, this.g('wChannelFlags2', c) & ~EXECUTE_MUSIC);
          // only the wave SFX channel restarts channel 3 and honours wDisableChannelOutputWhenSfxEnds
          if (c === CHAN7) {
            this.write(NR30, 0);
            this.write(NR30, 0x80);
            if (this.g('wDisableChannelOutputWhenSfxEnds')) {
              this.s('wDisableChannelOutputWhenSfxEnds', 0, 0);
              disable = true;
            }
          }
        }
        if (disable) this.write(NR51, this.regs[NR51 - NR10] & this.d.disableMasks[c]);
        const id5 = this.soundId(CHAN5);
        if (id5 >= this.CRY_START && id5 < this.CRY_END) {
          if (c !== CHAN5 && this.goBackOneCommandIfCry(c)) return;
          this.write(NR50, this.g('wSavedVolume'));
          this.s('wSavedVolume', 0, 0);
        }
        this.s('wChannelSoundIDs', c, 0);
        return;
      }
      // sound_call
      if (d === 0xfd) {
        const lo = this.next(c);
        const hi = this.next(c);
        this.s('wChannelReturnAddresses', c * 2, this.g('wChannelCommandPointers', c * 2));
        this.s('wChannelReturnAddresses', c * 2 + 1, this.g('wChannelCommandPointers', c * 2 + 1));
        this.setPtr(c, lo | (hi << 8));
        this.s('wChannelFlags1', c, this.g('wChannelFlags1', c) | SOUND_CALL);
        continue;
      }
      // sound_loop
      if (d === 0xfe) {
        const count = this.next(c);
        if (count) {
          const n = this.g('wChannelLoopCounters', c);
          if (n === count) {
            this.s('wChannelLoopCounters', c, 1);
            this.next(c);
            this.next(c);
            continue;
          }
          this.s('wChannelLoopCounters', c, n + 1);
        }
        const lo = this.next(c);
        const hi = this.next(c);
        this.setPtr(c, lo | (hi << 8));
        continue;
      }
      // note_type
      if ((d & 0xf0) === 0xd0) {
        this.s('wChannelNoteSpeeds', c, d & 0xf);
        if (c !== CHAN4) {
          let v = this.next(c);
          if (c === CHAN3 || c === CHAN7) {
            this.s(c === CHAN3 ? 'wMusicWaveInstrument' : 'wSfxWaveInstrument', 0, v & 0xf);
            v = (v & 0x30) << 1;
          }
          this.s('wChannelVolumes', c, v);
        }
        continue;
      }
      if (d === 0xe8) {
        this.s('wChannelFlags1', c, this.g('wChannelFlags1', c) ^ PERFECT_PITCH);
        continue;
      }
      // vibrato
      if (d === 0xea) {
        const delay = this.next(c);
        this.s('wChannelVibratoDelayCounters', c, delay);
        this.s('wChannelVibratoDelayCounterReloadValues', c, delay);
        const v = this.next(c);
        const n = v >> 4;
        const half = n >> 1;
        this.s('wChannelVibratoExtents', c, ((half + (n & 1)) << 4) | half);
        const r = v & 0xf;
        this.s('wChannelVibratoRates', c, (r << 4) | r);
        continue;
      }
      // pitch_slide
      if (d === 0xeb) {
        this.s('wChannelPitchSlideLengthModifiers', c, this.next(c));
        const v = this.next(c);
        const [fd, fe] = this.calculateFrequency(v & 0xf, v >> 4);
        this.s('wChannelPitchSlideTargetFrequencyHighBytes', c, fd);
        this.s('wChannelPitchSlideTargetFrequencyLowBytes', c, fe);
        this.s('wChannelFlags1', c, this.g('wChannelFlags1', c) | PITCH_SLIDE_ON);
        this.noteLength(c, this.next(c));
        return;
      }
      if (d === 0xec) {
        const v = this.next(c);
        this.s('wChannelDutyCycles', c, ((v >> 2) | (v << 6)) & 0xc0);
        continue;
      }
      // tempo
      if (d === 0xed) {
        const hi = this.next(c);
        const lo = this.next(c);
        if (c < CHAN5) {
          this.s('wMusicTempo', 0, hi);
          this.s('wMusicTempo', 1, lo);
          this.fill('wChannelNoteDelayCountersFractionalPart', 4, 0);
        } else {
          this.s('wSfxTempo', 0, hi);
          this.s('wSfxTempo', 1, lo);
          this.ram.fill(0, this.at.wChannelNoteDelayCountersFractionalPart + 4, this.at.wChannelNoteDelayCountersFractionalPart + 8);
        }
        continue;
      }
      if (d === 0xee) {
        this.s('wStereoPanning', 0, this.next(c));
        continue;
      }
      // unknownmusic0xef
      if (d === 0xef) {
        const b = this.next(c);
        this.determineAudioFunction(b);
        if (!this.g('wDisableChannelOutputWhenSfxEnds')) {
          this.s('wDisableChannelOutputWhenSfxEnds', 0, this.soundId(CHAN8));
          this.s('wChannelSoundIDs', CHAN8, 0);
        }
        continue;
      }
      // duty_cycle_pattern
      if (d === 0xfc) {
        const v = this.next(c);
        this.s('wChannelDutyCyclePatterns', c, v);
        this.s('wChannelDutyCycles', c, v & 0xc0);
        this.s('wChannelFlags1', c, this.g('wChannelFlags1', c) | ROTATE_DUTY_CYCLE);
        continue;
      }
      if (d === 0xf0) {
        this.write(NR50, this.next(c));
        continue;
      }
      if (d === 0xf8) {
        this.s('wChannelFlags2', c, this.g('wChannelFlags2', c) | EXECUTE_MUSIC);
        continue;
      }
      // octave
      if ((d & 0xf0) === 0xe0) {
        this.s('wChannelOctaves', c, d & 0xf);
        continue;
      }
      const exec = this.g('wChannelFlags2', c) & EXECUTE_MUSIC;
      // sfx_note (square_note / noise_note)
      if ((d & 0xf0) === 0x20 && c >= CHAN4 && !exec) {
        const delay = this.noteLength(c, d);
        this.write(this.reg(c, REG_DUTY_SOUND_LEN), this.g('wChannelDutyCycles', c) | delay);
        this.write(this.reg(c, REG_VOLUME_ENVELOPE), this.next(c));
        const e = this.next(c);
        const hi = c === CHAN8 ? 0 : this.next(c);
        this.applyDutyCycleAndSoundLength(c);
        this.enableChannelOutput(c);
        this.applyWavePatternAndFrequency(c, hi, e);
        return;
      }
      // pitch_sweep
      if (c >= CHAN5 && d === 0x10 && !exec) {
        this.write(NR10, this.next(c));
        continue;
      }
      // note (the music noise channel's drum notes)
      if (c === CHAN4) {
        const hi = d & 0xf0;
        if (hi <= 0xb0) {
          let instrument: number;
          let len: number;
          if (hi === 0xb0) {
            len = d & 0xf;
            instrument = this.next(c);
          } else {
            instrument = hi >> 4;
            len = d & 0xf;
          }
          if (!this.g('wDisableChannelOutputWhenSfxEnds')) this.determineAudioFunction(instrument);
          this.noteLength(c, len);
          return;
        }
      }
      this.noteLength(c, d);
      return;
    }
  }

  /** Audio1_note_length (and note_pitch for notes): returns the new delay (a) for sfx_note */
  private noteLength(c: number, d: number): number {
    const len = (d & 0xf) + 1;
    let hl = this.g('wChannelNoteSpeeds', c) * len;
    let tempo: number;
    if (c < CHAN5) tempo = this.musicTempo;
    else if (c === CHAN8) tempo = 0x100;
    else {
      this.setSfxTempo();
      tempo = (this.g('wSfxTempo') << 8) | this.g('wSfxTempo', 1);
    }
    hl = ((hl & 0xff) * tempo + this.g('wChannelNoteDelayCountersFractionalPart', c)) & 0xffff;
    this.s('wChannelNoteDelayCountersFractionalPart', c, hl);
    const delay = hl >> 8;
    this.s('wChannelNoteDelayCounters', c, delay);
    if (!(this.g('wChannelFlags2', c) & EXECUTE_MUSIC) && this.g('wChannelFlags1', c) & NOISE_OR_SFX) return delay;
    this.notePitch(c, d);
    return delay;
  }

  /** Audio1_note_pitch */
  private notePitch(c: number, cmd: number): void {
    const hi = cmd & 0xf0;
    if (hi === 0xc0) {
      // rest
      if (c < CHAN5 && this.soundId(c + 4)) return;
      if (c === CHAN3 || c === CHAN7) {
        this.write(NR51, this.regs[NR51 - NR10] & this.d.disableMasks[c]);
        return;
      }
      this.write(this.reg(c, REG_VOLUME_ENVELOPE), 0x08);
      this.write(this.reg(c, REG_VOLUME_ENVELOPE + 2), 0x80);
      return;
    }
    let [fd, fe] = this.calculateFrequency(hi >> 4, this.g('wChannelOctaves', c));
    if (this.g('wChannelFlags1', c) & PITCH_SLIDE_ON) this.initPitchSlideVars(c, fd, fe);
    if (c < CHAN5 && this.soundId(c + 4)) return;
    this.write(this.reg(c, REG_VOLUME_ENVELOPE), this.g('wChannelVolumes', c));
    this.applyDutyCycleAndSoundLength(c);
    this.enableChannelOutput(c);
    if (this.g('wChannelFlags1', c) & PERFECT_PITCH) fe = (fe + 1) & 0xff; // the carry never reaches d
    this.s('wChannelFrequencyLowBytes', c, fe);
    this.applyWavePatternAndFrequency(c, fd, fe);
  }

  /** Audio1_EnableChannelOutput */
  private enableChannelOutput(c: number): void {
    const masks = this.d.enableMasks;
    const opt = (this.soundOption & 3) * 8;
    let d = this.regs[NR51 - NR10] | masks[opt + c];
    const sfxOff = c === CHAN8 || (c < CHAN5 && !this.soundId(c + 4));
    if (sfxOff) {
      const pan = this.g('wStereoPanning') & masks[opt + c];
      d = (this.regs[NR51 - NR10] & this.d.disableMasks[c]) | pan;
    }
    this.write(NR51, d);
  }

  /** Audio1_ApplyDutyCycleAndSoundLength */
  private applyDutyCycleAndSoundLength(c: number): void {
    let d = this.g('wChannelNoteDelayCounters', c);
    if (c !== CHAN3 && c !== CHAN7) d = (d & 0x3f) | this.g('wChannelDutyCycles', c);
    this.write(this.reg(c, REG_DUTY_SOUND_LEN), d);
  }

  /** Audio1_ApplyWavePatternAndFrequency */
  private applyWavePatternAndFrequency(c: number, d: number, e: number): void {
    if (c === CHAN3 || c === CHAN7) {
      const inst = this.g(c === CHAN3 ? 'wMusicWaveInstrument' : 'wSfxWaveInstrument');
      const p = this.d.wavePointers[inst & 7];
      this.write(NR30, 0);
      for (let i = 0; i < 16; i++) this.write(0xff30 + i, this.romByte(this.d.engineBanks[0], p + i));
      this.write(NR30, 0x80);
    }
    d = (d | 0x80) & 0xc7;
    this.write(this.reg(c, REG_FREQUENCY_LO), e);
    this.write(this.reg(c, REG_FREQUENCY_LO + 1), d);
    if (c >= CHAN5 && (this.isCry() || this.isBattleSfx())) {
      // Audio1_ApplyFrequencyModifier
      const v = this.g('wFrequencyModifier') + e;
      if (v > 0xff) d = (d + 1) & 0xff;
      this.write(this.reg(c, REG_FREQUENCY_LO), v);
      this.write(this.reg(c, REG_FREQUENCY_LO + 1), d);
    }
  }

  /** Audio1_SetSfxTempo */
  private setSfxTempo(): void {
    if (this.isCry() || this.isBattleSfx()) {
      const v = this.g('wTempoModifier') + 0x80;
      this.s('wSfxTempo', 1, v);
      this.s('wSfxTempo', 0, v > 0xff ? 1 : 0);
    } else {
      this.s('wSfxTempo', 1, 0);
      this.s('wSfxTempo', 0, 1);
    }
  }

  private isCry(): boolean {
    const a = this.soundId(CHAN5);
    return a >= this.CRY_START && a < this.CRY_END;
  }

  /** Audio1_IsBattleSFX: only while the audio bank is Audio Engine 2's */
  private isBattleSfx(): boolean {
    if (this.g('wAudioROMBank') !== this.d.engineBanks[1]) return false;
    const a = this.soundId(CHAN8) | this.soundId(CHAN5);
    return a >= this.BATTLE_START && a <= this.BATTLE_END;
  }

  /** Audio1_GoBackOneCommandIfCry: true (carry) when rewound */
  private goBackOneCommandIfCry(c: number): boolean {
    if (!this.isCry()) return false;
    this.setPtr(c, (this.ptr(c) - 1) & 0xffff);
    return true;
  }

  /** Audio1_CalculateFrequency: [d, e] for a note at an octave */
  private calculateFrequency(note: number, octave: number): [number, number] {
    let v = (this.d.pitches[note] << 16) >> 16;
    for (let b = octave; b !== 7; b = (b + 1) & 0xff) v >>= 1;
    return [((v >> 8) + 8) & 0xff, v & 0xff];
  }

  /** Audio1_ApplyDutyCyclePattern */
  private applyDutyCyclePattern(c: number): void {
    let p = this.g('wChannelDutyCyclePatterns', c);
    p = ((p << 2) | (p >> 6)) & 0xff;
    this.s('wChannelDutyCyclePatterns', c, p);
    const r = this.reg(c, REG_DUTY_SOUND_LEN);
    this.write(r, (this.read(r) & 0x3f) | (p & 0xc0));
  }

  /** Audio1_ApplyPitchSlide */
  private applyPitchSlide(c: number): void {
    const f1 = this.g('wChannelFlags1', c);
    let d: number;
    let e: number;
    const thi = this.g('wChannelPitchSlideTargetFrequencyHighBytes', c);
    const tlo = this.g('wChannelPitchSlideTargetFrequencyLowBytes', c);
    let reached: boolean;
    if (!(f1 & PITCH_SLIDE_DECREASING)) {
      let v = ((this.g('wChannelPitchSlideCurrentFrequencyHighBytes', c) << 8) | this.g('wChannelPitchSlideCurrentFrequencyLowBytes', c)) + this.g('wChannelPitchSlideFrequencySteps', c);
      const frac = this.g('wChannelPitchSlideCurrentFrequencyFractionalPart', c) + this.g('wChannelPitchSlideFrequencyStepsFractionalPart', c);
      this.s('wChannelPitchSlideCurrentFrequencyFractionalPart', c, frac);
      v = (v + (frac > 0xff ? 1 : 0)) & 0xffff;
      d = v >> 8;
      e = v & 0xff;
      reached = thi < d || (thi === d && tlo < e);
    } else {
      let v = ((this.g('wChannelPitchSlideCurrentFrequencyHighBytes', c) << 8) | this.g('wChannelPitchSlideCurrentFrequencyLowBytes', c)) - this.g('wChannelPitchSlideFrequencySteps', c);
      const f = this.g('wChannelPitchSlideFrequencyStepsFractionalPart', c) * 2;
      this.s('wChannelPitchSlideFrequencyStepsFractionalPart', c, f);
      v = (v - (f > 0xff ? 1 : 0)) & 0xffff;
      d = v >> 8;
      e = v & 0xff;
      reached = d < thi || (d === thi && e < tlo);
    }
    if (reached) {
      this.s('wChannelFlags1', c, f1 & ~(PITCH_SLIDE_ON | PITCH_SLIDE_DECREASING));
      return;
    }
    this.s('wChannelPitchSlideCurrentFrequencyLowBytes', c, e);
    this.s('wChannelPitchSlideCurrentFrequencyHighBytes', c, d);
    this.write(this.reg(c, REG_FREQUENCY_LO), e);
    this.write(this.reg(c, REG_FREQUENCY_LO + 1), d);
  }

  /** Audio1_InitPitchSlideVars */
  private initPitchSlideVars(c: number, d: number, e: number): void {
    this.s('wChannelPitchSlideCurrentFrequencyHighBytes', c, d);
    this.s('wChannelPitchSlideCurrentFrequencyLowBytes', c, e);
    let len = this.g('wChannelNoteDelayCounters', c) - this.g('wChannelPitchSlideLengthModifiers', c);
    if (len < 0) len = 1;
    this.s('wChannelPitchSlideLengthModifiers', c, len);
    const tlo = this.g('wChannelPitchSlideTargetFrequencyLowBytes', c);
    const thi = this.g('wChannelPitchSlideTargetFrequencyHighBytes', c);
    let lo = e - tlo;
    const borrow = lo < 0 ? 1 : 0;
    lo &= 0xff;
    let hi = d - borrow - thi;
    let decreasing: boolean;
    if (hi >= 0) {
      decreasing = true;
      e = lo;
      d = hi & 0xff;
    } else {
      decreasing = false;
      // the target is higher: target - current, borrowing from the current's high byte (bug)
      const cd = this.g('wChannelPitchSlideCurrentFrequencyHighBytes', c);
      const ce = this.g('wChannelPitchSlideCurrentFrequencyLowBytes', c);
      lo = tlo - ce;
      const b2 = lo < 0 ? 1 : 0;
      e = lo & 0xff;
      hi = (cd - b2) & 0xff;
      d = (thi - hi) & 0xff;
    }
    const f1 = this.g('wChannelFlags1', c);
    this.s('wChannelFlags1', c, decreasing ? f1 | PITCH_SLIDE_DECREASING : f1 & ~PITCH_SLIDE_DECREASING);
    // divide (d:e) by the length: b ends as quotient + 1
    const m = this.g('wChannelPitchSlideLengthModifiers', c);
    let b = 0;
    for (;;) {
      b = (b + 1) & 0xff;
      const v = e - m;
      e = v & 0xff;
      if (v >= 0) continue;
      if (!d) break;
      d--;
    }
    const rem = (e + m) & 0xff;
    this.s('wChannelPitchSlideFrequencySteps', c, b);
    this.s('wChannelPitchSlideFrequencyStepsFractionalPart', c, rem);
    this.s('wChannelPitchSlideCurrentFrequencyFractionalPart', c, rem);
  }

  /** wMuteAudioAndPauseMusic */
  setMute(v: number): void {
    this.s('wMuteAudioAndPauseMusic', 0, v);
  }

  /** Clear a channel's sound ID (the low health alarm's CHAN5 when it stops) */
  clearChannel(ch: number): void {
    this.s('wChannelSoundIDs', ch, 0);
  }

  /** wFrequencyModifier / wTempoModifier (cries and battle SFX) */
  setModifiers(frequency: number, tempo: number): void {
    this.s('wFrequencyModifier', 0, frequency);
    this.s('wTempoModifier', 0, tempo);
  }

  /** A sound register written directly by game code (DoBallTossSpecialEffects' rAUD1SWEEP) */
  writeReg(addr: number, v: number): void {
    this.write(addr, v);
  }

  /** Register values written behind the engine's back (the Pikachu PCM player). */
  pokeRegs(writes: [number, number][]): void {
    for (const [a, v] of writes) this.regs[a - NR10] = v;
  }

  /** Take this frame's register writes. */
  takeWrites(): RegWrite[] {
    const w = this.writes;
    this.writes = [];
    return w;
  }
}
