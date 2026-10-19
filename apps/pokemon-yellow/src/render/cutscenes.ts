/** Authored 3D framing at the original map-script milestones. This observes
 * the scripts; it never adds a delay or changes their state machines.
 */
import type { Engine } from '../engine/Engine';
import { c } from '../rom/constants';
import type { CameraShot, RailKey } from './camera';

const key = (frame: number, zoom: number, pitch = 0, yaw = 0, x = 0, z = 0): RailKey => ({ frame, zoom, pitch, yaw, x, z });
const conversation = [key(0, 0.95), key(90, 0.82, -4, -7)];
const approach = [key(0, 1.08, 3), key(150, 0.92, -2, 5)];
const reveal = [key(0, 1.1, 4, -6), key(180, 0.88, -3, 6)];
interface Rule extends CameraShot {
  map: number;
  first: number;
  last: number;
  subjects: number[];
}
function rule(map: string, prefix: string, first: string, last: string, subjects: string[], keys: RailKey[]): Rule {
  return { id: `${map}:${first}`, map: c('map', map), first: c('map_script', `SCRIPT_${prefix}_${first}`), last: c('map_script', `SCRIPT_${prefix}_${last}`), subjects: subjects.map((s) => c('object', s)), keys };
}
export const CUTSCENE_SHOTS: readonly Rule[] = [
  rule('PALLET_TOWN', 'PALLETTOWN', 'OAK_HEY_WAIT', 'OAK_GREETS_PLAYER', ['PALLETTOWN_OAK'], approach),
  rule('PALLET_TOWN', 'PALLETTOWN', 'AFTER_PIKACHU_BATTLE', 'PLAYER_FOLLOWS_OAK', ['PALLETTOWN_OAK'], conversation),
  rule('OAKS_LAB', 'OAKSLAB', 'OAK_ENTERS_LAB', 'OAK_CHOOSE_MON_SPEECH', ['OAKSLAB_OAK1', 'OAKSLAB_OAK2'], approach),
  rule('OAKS_LAB', 'OAKSLAB', 'CHOSE_STARTER_SCRIPT', 'PLAYER_RECEIVES_PIKACHU', ['OAKSLAB_RIVAL', 'OAKSLAB_OAK1'], reveal),
  rule('OAKS_LAB', 'OAKSLAB', 'RIVAL_STARTS_EXIT', 'PIKACHU_DISLIKES_POKEBALLS', ['OAKSLAB_RIVAL', 'OAKSLAB_OAK1'], conversation),
  rule('OAKS_LAB', 'OAKSLAB', 'RIVAL_ARRIVES_AT_OAKS_REQUEST', 'RIVAL_LEAVES_WITH_POKEDEX', ['OAKSLAB_OAK1', 'OAKSLAB_RIVAL'], reveal),
  rule('CHAMPIONS_ROOM', 'CHAMPIONSROOM', 'PLAYER_ENTERS', 'RIVAL_READY_TO_BATTLE', ['CHAMPIONSROOM_RIVAL'], reveal),
  rule('CHAMPIONS_ROOM', 'CHAMPIONSROOM', 'OAK_ARRIVES', 'CLEANUP_SCRIPT', ['CHAMPIONSROOM_OAK', 'CHAMPIONSROOM_RIVAL'], approach),
  rule('HALL_OF_FAME', 'HALLOFFAME', 'DEFAULT', 'OAK_CONGRATULATIONS', ['HALLOFFAME_OAK'], reveal),
];
const sailing: CameraShot = { id: 'VERMILION_DOCK:sailing', keys: [key(0, 1.15, 4, -4, 0, 1), key(240, 1.25, 7, 5, -1, 1.5), key(1200, 1.12, 3, 0, -2, 1)] };
const scriptedKeys = [key(0, 1.06, 2), key(120, 1, 0)];

export function cutsceneCamera(e: Engine): { shot?: CameraShot; focus: { x: number; z: number } } {
  const sprite = e.sprites[0];
  const [px, py] = sprite ? e.spriteRenderPos(sprite) : [e.state.player.x, e.state.player.y];
  const focus = { x: px + 0.5, z: py + 0.5 };
  if (e.ram.isInBattle || e.screen.ppu) return { focus };
  const map = e.state.player.map;
  if (map === c('map', 'VERMILION_DOCK') && e.ram.joyIgnore && e.event('EVENT_SS_ANNE_LEFT') && !e.event('EVENT_STARTED_WALKING_OUT_OF_DOCK'))
    return { shot: sailing, focus };
  const shot = CUTSCENE_SHOTS.find((r) => r.map === map && e.curScript >= r.first && e.curScript <= r.last);
  if (shot) {
    // Include the player, ignore hidden actors (Oak has two lab slots), and
    // keep the focus close enough that the player never leaves the frame.
    let x = focus.x, z = focus.z, count = 1;
    for (const slot of shot.subjects) {
      const s = e.sprites[slot];
      if (!s || s.hidden || !s.pictureId) continue;
      const [sx, sy] = e.spriteRenderPos(s);
      x += sx + 0.5; z += sy + 0.5; count++;
    }
    const clamp = (v: number) => Math.max(-2.5, Math.min(2.5, v));
    return { shot, focus: { x: focus.x + clamp(x / count - focus.x), z: focus.z + clamp(z / count - focus.z) } };
  }
  // All other scripted escorts/forced walks get a conservative wider tracking
  // rail. Normal movement, menus, and stationary dialogue keep the follow cam.
  if (e.ram.joyIgnore && (e.scripted.active || e.ram.simulatedIndex))
    return { shot: { id: `${map}:scripted-walk`, keys: scriptedKeys }, focus };
  return { focus };
}
