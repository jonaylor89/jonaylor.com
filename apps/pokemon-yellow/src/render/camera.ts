/** Presentation-only camera rails. Time is measured in emulated frames, never
 * wall time; selecting/sampling a shot does not run scripts, wait or use RNG.
 */
export interface RailKey {
  frame: number;
  x: number;
  z: number;
  zoom: number;
  pitch: number;
  yaw: number;
}
export interface CameraShot {
  id: string;
  keys: readonly RailKey[];
}
export interface CameraPose {
  x: number;
  z: number;
  zoom: number;
  pitch: number;
  yaw: number;
}
const ease = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const mix = (a: CameraPose, b: CameraPose, t: number): CameraPose => ({
  x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
  zoom: a.zoom + (b.zoom - a.zoom) * t, pitch: a.pitch + (b.pitch - a.pitch) * t,
  yaw: a.yaw + (b.yaw - a.yaw) * t,
});
export function sampleRail(keys: readonly RailKey[], frame: number): CameraPose {
  if (!keys.length) throw new Error('camera rail needs a key');
  for (let i = 1; i < keys.length; i++) {
    if (frame <= keys[i].frame) return mix(keys[i - 1], keys[i], ease((frame - keys[i - 1].frame) / (keys[i].frame - keys[i - 1].frame)));
  }
  return mix(keys[keys.length - 1], keys[keys.length - 1], 1);
}

/** Blend into/between shots and back to the player; a warp resets the director. */
export class CameraDirector {
  private id?: string;
  private start = 0;
  private from?: CameraPose;
  private last?: CameraPose;
  /** True while a rail or its return transition owns the camera. */
  active = false;
  reset(): void { this.id = undefined; this.start = 0; this.from = this.last = undefined; this.active = false; }
  /** Seamless connected maps change the coordinate origin, not the camera shot. */
  shift(dx: number, dz: number): void {
    if (this.from) this.from = { ...this.from, x: this.from.x + dx, z: this.from.z + dz };
    if (this.last) this.last = { ...this.last, x: this.last.x + dx, z: this.last.z + dz };
  }

  sample(shot: CameraShot | undefined, focus: { x: number; z: number }, player: { x: number; z: number }, frame: number, reducedMotion = false): CameraPose {
    const normal: CameraPose = { ...player, zoom: 1, pitch: 0, yaw: 0 };
    if (reducedMotion) { this.reset(); return normal; }
    if (this.id !== shot?.id || frame < this.start) {
      this.from = this.last ?? normal;
      this.start = frame;
      this.id = shot?.id;
    }
    const age = Math.max(0, frame - this.start);
    let target = normal;
    if (shot) {
      const key = sampleRail(shot.keys, age);
      target = { ...key, x: focus.x + key.x, z: focus.z + key.z };
    }
    this.active = !!shot || (!!this.from && age < 32);
    this.last = this.from && age < 32 ? mix(this.from, target, ease(age / 32)) : target;
    return this.last;
  }
}
