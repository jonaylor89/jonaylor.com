/**
 * The overworld Pikachu that follows the player: engine/pikachu/pikachu_follow.asm
 * (SpawnPikachu_, the follow command buffer, spawn placement, the idle
 * animations) and the scripted movement of engine/pikachu/pikachu_movement.asm
 * (ApplyPikachuMovementData with PikachuMovementDatabase).
 *
 * Pikachu is sprite slot 15. As for other sprites, its position is a map
 * square plus a pixel offset rather than the original's screen pixels.
 */
import type { Co, Engine } from './Engine';
import { c } from '../rom/constants';
import { newSprite, FACING_DOWN, FACING_LEFT, FACING_RIGHT, FACING_UP, type Sprite } from './sprites';
import { PLAYER_DIR_DOWN, PLAYER_DIR_LEFT, PLAYER_DIR_RIGHT, PLAYER_DIR_UP } from './pad';
import { isStarterPikachuAliveInParty } from '../game/pikachu';

/** wPikachuOverworldStateFlags bits */
export const PIKA_NOT_FOLLOWING = 1 << 1;
const PIKA_ANIMATING = 1 << 2;
export const PIKA_NO_DRAWING = 1 << 3;
export const PIKA_CONNECTION = 1 << 4;
export const PIKA_SURF_STOPPED = 1 << 5;
const PIKA_LEDGE_TOGGLE = 1 << 6;
export const PIKA_HIDDEN = 1 << 7;

/** Player screen position in pixels ($40, $3c). */
const PLAYER_SCREEN_X = 0x40;
const PLAYER_SCREEN_Y = 0x3c;

/** Pointer_fc7e3: facing, x step, y step, movement status for follow commands 1-8. */
const FOLLOW_STEPS: [number, number, number, number][] = [
  [FACING_DOWN, 0, 1, 3],
  [FACING_UP, 0, -1, 3],
  [FACING_LEFT, -1, 0, 3],
  [FACING_RIGHT, 1, 0, 3],
  [FACING_DOWN, 0, 1, 4],
  [FACING_UP, 0, -1, 4],
  [FACING_LEFT, -1, 0, 4],
  [FACING_RIGHT, 1, 0, 4],
];

/** Pointer_fc8d6: (dy, dx) of the idle hop, read from the end. */
const HOP: [number, number][] = [
  [0, 0], [-2, 1], [-4, 2], [-2, 3], [0, 4], [-2, 3], [-4, 2], [-2, 1],
  [0, 0], [-2, -1], [-4, -2], [-2, -3], [0, -4], [-2, -3], [-4, -2], [-2, -1], [0, 0],
];

const CLOCKWISE = [FACING_DOWN, FACING_LEFT, FACING_UP, FACING_RIGHT];

export class PikachuFollower {
  /** SPRITESTATEDATA1_MOVEMENTSTATUS (bit 7: see Func_fc745) */
  status = 0;
  walkAnimCounter = 0;
  intraAnim = 0;
  animFrame = 0;
  facing = FACING_DOWN;
  stepX = 0;
  stepY = 0;
  mapX = 0;
  mapY = 0;
  /** Pixel offset from the map square (the original's screen pixels minus the map position). */
  offX = 0;
  offY = 0;
  /** SPRITESTATEDATA1_IMAGEINDEX = $ff */
  hidden = true;
  /** wPikachuSpawnState */
  spawnState = 0;
  /** wPikachuFollowCommandBuffer; its size byte is length - 1 ($ff when empty). */
  buffer: number[] = [];
  /** wd431 / wd432 */
  private hopY = 0;
  private hopX = 0;
  /** wPikachuMovementYOffset while a scripted hop is in the air (rendered as lift + shadow). */
  lift = 0;
  shadow = false;
  /** The image index as drawn: direction and animation frame (scripted movement can turn the image only). */
  renderDir = FACING_DOWN;
  renderFrame = 0;

  constructor(readonly e: Engine) {}

  private get flags(): number {
    return this.e.ram.pikachuOverworldStateFlags;
  }
  private set flags(v: number) {
    this.e.ram.pikachuOverworldStateFlags = v;
  }

  get slot(): number {
    return c('map_object', 'PIKACHU_SPRITE_INDEX');
  }

  /** ShouldPikachuSpawn */
  shouldSpawn(): boolean {
    if (this.flags & (PIKA_SURF_STOPPED | PIKA_HIDDEN)) return false;
    if (!isStarterPikachuAliveInParty(this.e.state)) return false;
    return this.e.state.player.mode === 'walk';
  }

  private get player() {
    return this.e.state.player;
  }
  private get playerFacing(): number {
    return { down: FACING_DOWN, up: FACING_UP, left: FACING_LEFT, right: FACING_RIGHT }[this.player.facing];
  }
  /** Func_fc82e: the player is mid-step. */
  private playerWalking(): boolean {
    return this.e.ram.walkCounter !== 0;
  }

  // ------------------------------------------------------------ spawning
  /** SchedulePikachuSpawnForAfterText (end of LoadMapHeader). */
  scheduleSpawnForAfterText(): void {
    if (this.flags & PIKA_CONNECTION) {
      this.flags &= ~PIKA_CONNECTION;
      this.calculatePlacementCoords();
      this.spawnState = 0;
      this.facing = this.playerFacing;
      return;
    }
    this.flags &= ~PIKA_NOT_FOLLOWING; // EnablePikachuFollowingPlayer
    this.clearSpriteState();
    this.hidden = true;
    this.buffer = [];
    this.calculateFacingDirection();
  }

  /** ClearPikachuSpriteStateData */
  private clearSpriteState(): void {
    this.status = 0;
    this.walkAnimCounter = 0;
    this.intraAnim = this.animFrame = 0;
    this.stepX = this.stepY = 0;
    this.mapX = this.mapY = 0;
    this.offX = this.offY = 0;
    this.facing = FACING_DOWN;
  }

  /** CalculatePikachuSpawnCoordsAndFacing */
  private calculateSpawnCoordsAndFacing(): void {
    this.calculatePlacementCoords();
    this.calculateFacingDirection();
    this.spawnState = 0;
  }

  /** CalculatePikachuPlacementCoords */
  calculatePlacementCoords(): void {
    let x = this.player.x;
    let y = this.player.y;
    const f = this.playerFacing;
    const behind = () => {
      if (f === FACING_DOWN) y--;
      else if (f === FACING_UP) y++;
      else if (f === FACING_LEFT) x++;
      else x--;
    };
    switch (this.spawnState) {
      case 0:
      case 3:
        break;
      case 1:
        x++;
        break;
      case 2:
        behind();
        break;
      case 4:
        y++;
        break;
      case 5:
        y--;
        break;
      case 6:
        x--;
        break;
      case 7:
        if (f === FACING_DOWN) y++;
        else if (f === FACING_UP) y--;
        else if (f === FACING_LEFT) x--;
        else x++;
        break;
      default:
        x++;
    }
    this.mapX = x;
    this.mapY = y;
    this.offX = this.offY = 0;
    this.e.ram.pikachuSpawnFollowing = true;
  }

  /** CalculatePikachuFacingDirection */
  private calculateFacingDirection(): void {
    this.hidden = true;
    switch (this.spawnState) {
      case 0:
      case 1:
      case 4:
      case 6:
        this.facing = this.playerFacing;
        break;
      case 3:
        this.facing = FACING_DOWN;
        break;
      case 7:
        this.facing = this.playerFacing ^ 4;
        break;
      default:
        this.computeFacingDirection();
    }
  }

  /** SetPikachuSpawnOutside: entering a map from an outside map. */
  setSpawnOutside(map: number): void {
    const M = (n: string) => c('map', n);
    const f = this.playerFacing;
    let s: number;
    if (map === M('OAKS_LAB')) s = 6;
    else if (map === M('ROUTE_22_GATE')) s = f === FACING_DOWN ? 3 : 1;
    else if (map === M('MT_MOON_B1F') || map === M('ROCK_TUNNEL_1F')) s = 3;
    else if (['VICTORY_ROAD_2F', 'ROUTE_7_GATE', 'ROUTE_8_GATE', 'ROUTE_16_GATE_1F', 'ROUTE_18_GATE_1F', 'ROUTE_15_GATE_1F', 'ROUTE_11_GATE_1F'].some((n) => M(n) === map))
      s = 4;
    else if (
      ['VIRIDIAN_FOREST_NORTH_GATE', 'CERULEAN_BADGE_HOUSE', 'CERULEAN_TRASHED_HOUSE', 'VERMILION_DOCK', 'CELADON_MANSION_1F', 'ROUTE_2_GATE', 'FUCHSIA_GOOD_ROD_HOUSE'].some(
        (n) => M(n) === map,
      ) &&
      f === FACING_DOWN
    )
      s = 3;
    else s = 1;
    this.spawnState = s;
  }

  /** SetPikachuSpawnWarpPad: warps between inside maps. */
  setSpawnWarpPad(map: number): void {
    const M = (n: string) => c('map', n);
    const f = this.playerFacing;
    let inArray: boolean;
    if (map === M('VIRIDIAN_FOREST_NORTH_GATE')) inArray = f === FACING_UP;
    else if (map === M('VIRIDIAN_FOREST_SOUTH_GATE')) inArray = f !== FACING_DOWN;
    else
      inArray = [
        'VIRIDIAN_FOREST',
        'SAFARI_ZONE_CENTER_REST_HOUSE',
        'SAFARI_ZONE_WEST_REST_HOUSE',
        'SAFARI_ZONE_EAST_REST_HOUSE',
        'SAFARI_ZONE_NORTH_REST_HOUSE',
        'SAFARI_ZONE_SECRET_HOUSE',
        'SILPH_CO_ELEVATOR',
        'CELADON_MART_ELEVATOR',
        'CINNABAR_LAB_TRADE_ROOM',
        'CINNABAR_LAB_METRONOME_ROOM',
        'CINNABAR_LAB_FOSSIL_ROOM',
      ].some((n) => M(n) === map);
    this.spawnState = inArray ? 1 : 0;
  }

  /** SetPikachuSpawnBackOutside: a LAST_MAP warp (checked against the map being left). */
  setSpawnBackOutside(fromMap: number): void {
    const M = (n: string) => c('map', n);
    const up = this.playerFacing === FACING_UP;
    this.spawnState = (fromMap === M('ROUTE_22_GATE') || fromMap === M('ROUTE_2_GATE')) && up ? 1 : 3;
  }

  /** Walking across a map connection (CheckMapConnections .loadNewMap). */
  onConnection(): void {
    this.flags |= PIKA_CONNECTION;
    this.spawnState = 2;
  }

  // ------------------------------------------------------------ the follow command buffer
  private clearBuffer(): void {
    this.buffer = [];
  }
  private append(cmd: number): void {
    this.buffer.push(cmd);
  }
  /** Func_fcc92: take the oldest command; the newest one is never taken. */
  private pop(): number | undefined {
    if (this.buffer.length <= 1) return undefined;
    return this.buffer.shift();
  }
  /** GetPikachuFollowCommand */
  private current(): number {
    return this.buffer.length ? this.buffer[this.buffer.length - 1] : 0;
  }
  /** GetPikachuFollowCommandIfBufferSizeNonzero */
  private currentIfMoving(): number {
    return this.buffer.length > 1 ? this.buffer[this.buffer.length - 1] : 0;
  }

  /** RefreshPikachuFollow */
  refreshFollow(): void {
    this.clearBuffer();
    const cmd = this.computeFollowCommand();
    if (cmd !== undefined) this.append(cmd);
  }

  /** ComputePikachuFollowCommand: the step that brings Pikachu to the player (5-8: two squares or more). */
  private computeFollowCommand(): number | undefined {
    const dy = this.player.y - this.mapY;
    if (dy) {
      if (dy > 0) return dy < 2 ? 1 : 5;
      return -dy < 2 ? 2 : 6;
    }
    const dx = this.player.x - this.mapX;
    if (!dx) return undefined;
    if (dx > 0) return dx < 2 ? 4 : 8;
    return -dx < 2 ? 3 : 7;
  }

  /** Func_fcc08: the player starts a step. */
  onPlayerStep(): void {
    if (this.flags & (PIKA_SURF_STOPPED | PIKA_HIDDEN)) return;
    if (!isStarterPikachuAliveInParty(this.e.state)) return;
    if (this.player.mode !== 'walk') return;
    const dir = this.e.ram.playerDirection;
    let cmd: number | undefined;
    if (this.e.ram.ledgeOrFishing) {
      // Func_fcc64: a ledge hop is two squares in one command; the second step is skipped
      if (this.flags & PIKA_LEDGE_TOGGLE) {
        this.flags &= ~PIKA_LEDGE_TOGGLE;
        return;
      }
      this.flags |= PIKA_LEDGE_TOGGLE;
      cmd = dir & PLAYER_DIR_UP ? 6 : dir & PLAYER_DIR_DOWN ? 5 : dir & PLAYER_DIR_LEFT ? 7 : dir & PLAYER_DIR_RIGHT ? 8 : undefined;
    } else cmd = dir & PLAYER_DIR_UP ? 2 : dir & PLAYER_DIR_DOWN ? 1 : dir & PLAYER_DIR_LEFT ? 3 : dir & PLAYER_DIR_RIGHT ? 4 : undefined;
    if (cmd !== undefined) this.append(cmd);
  }

  /** ComputePikachuFacingDirection */
  computeFacingDirection(): void {
    const cmd = this.currentIfMoving();
    if (cmd) {
      this.facing = ((cmd - 1) & 3) * 4;
      return;
    }
    if (this.mapY !== this.player.y) this.facing = this.mapY < this.player.y ? FACING_DOWN : FACING_UP;
    else if (this.mapX !== this.player.x) this.facing = this.mapX < this.player.x ? FACING_RIGHT : FACING_LEFT;
    else this.facing = this.playerFacing;
  }

  // ------------------------------------------------------------ per frame
  /** SpawnPikachu_ (UpdateSprites, sprite slot 15). */
  update(): void {
    this.flags &= ~PIKA_ANIMATING;
    if (this.trySpawn() && this.onScreen()) {
      if (this.status & 0x80) this.resumeAfterStatusFlag();
      else if (this.e.ram.fontLoaded || this.flags & PIKA_NOT_FOLLOWING) this.standStill();
      else this.runStatus();
    }
    this.sync();
  }

  /** TrySpawnPikachu */
  private trySpawn(): boolean {
    if (!this.shouldSpawn()) {
      this.hidden = true;
      this.status = 0;
      return false;
    }
    if (!this.status) this.calculateSpawnCoordsAndFacing();
    return true;
  }

  /** Pikachu's position on the 160x144 screen. */
  private screenPos(): { x: number; y: number } {
    const e = this.e;
    const [px, py] = e.spriteRenderPos(e.sprites[0]);
    return {
      x: Math.round(this.mapX * 16 + this.offX - px * 16) + PLAYER_SCREEN_X,
      y: Math.round(this.mapY * 16 + this.offY - py * 16) + PLAYER_SCREEN_Y,
    };
  }

  /** WillPikachuSpawnOnTheScreen: within the view, and not under a text box or menu. */
  private onScreen(): boolean {
    const p = this.player;
    const visible =
      this.mapY >= p.y - 4 && this.mapY <= p.y + 4 && this.mapX >= p.x - 4 && this.mapX <= p.x + 5 && !this.underUi();
    if (!visible) this.hidden = true;
    return visible;
  }

  /** .GetNPCCurrentTile: the four tiles under Pikachu are UI tiles ($60 and up). */
  private underUi(): boolean {
    const { x, y } = this.screenPos();
    const row = (((y + 4) & 0xf0) >> 4) * 2;
    const col = (x + 2) >> 3;
    const s = this.e.screen;
    for (const [cx, cy] of [
      [col, row + 1],
      [col + 1, row + 1],
      [col, row],
      [col + 1, row],
    ]) {
      if (cx < 0 || cy < 0 || cx >= 20 || cy >= 18) continue;
      if (s.get(cx, cy) >= 0) return true;
    }
    return false;
  }

  private runStatus(): void {
    const st = this.status & 0x7f;
    switch (st >= 10 ? 0 : st) {
      case 0: // Func_fc793
        this.refreshFollow();
        this.offX = this.offY = 0; // InitializeSpriteScreenPosition
        this.hidden = true;
        this.status = 1;
        return;
      case 1:
        return this.takeCommand();
      case 2:
        return this.idle();
      case 3:
        return this.walkFrame(false);
      case 4:
      case 5:
        return this.walkFrame(true);
      case 6:
        return this.hopFrame();
      case 7:
        return this.spinFrame((a) => (a + 1) & 3);
      case 8:
        return this.spinFrame((a) => a ^ 1);
      case 9:
        return this.turnFrame();
    }
  }

  /** Func_fc745 */
  private resumeAfterStatusFlag(): void {
    this.status &= 0x7f;
    this.walkAnimCounter = 0;
    if (!(this.flags & PIKA_NOT_FOLLOWING)) this.facing = this.playerFacing ^ 4;
    this.intraAnim = this.animFrame = 0;
    this.updateWalkingSprite();
  }

  /** Func_fc76a: a text box is open or Pikachu isn't following. */
  private standStill(): void {
    this.intraAnim = this.animFrame = 0;
    this.updateWalkingSprite();
    if (!this.playerWalking()) this.offX = this.offY = 0;
    this.status = 1;
    this.walkAnimCounter = 0;
    this.refreshFollow();
  }

  /** Func_fc7aa */
  private takeCommand(): void {
    const cmd = this.pop();
    if (cmd === undefined) return this.idle();
    const [facing, x, y, status] = FOLLOW_STEPS[(cmd - 1) & 7];
    this.facing = facing;
    this.stepX = x;
    this.stepY = y;
    this.status = status;
    if (status === 4) {
      // Func_fca0a: a ledge hop covers two squares
      this.walkAnimCounter = 8;
      this.addStepVector();
      this.addStepVector();
      return this.walkFrame(true);
    }
    if (this.buffer.length - 1 >= 2) {
      // FastPikachuFollow: catch up
      this.walkAnimCounter = 4;
      this.status = 5;
    } else {
      // NormalPikachuFollow
      this.walkAnimCounter = 8;
      this.status = 3;
    }
    this.addStepVector();
    this.walkFrame(this.status === 5);
  }

  /** AddPikachuStepVector: the map square moves at once; the pixels catch up. */
  private addStepVector(): void {
    this.mapX += this.stepX;
    this.mapY += this.stepY;
    this.offX -= 16 * this.stepX;
    this.offY -= 16 * this.stepY;
  }

  /** asm_fc9c3 / asm_fc9ee / asm_fca1c */
  private walkFrame(fast: boolean): void {
    const k = fast ? 4 : 2;
    this.offX += this.stepX * k;
    this.offY += this.stepY * k;
    this.walkingAnimationSpeed();
    this.updateWalkingSprite();
    this.walkAnimCounter = (this.walkAnimCounter - 1) & 0xff;
    if (this.walkAnimCounter) return;
    this.stepX = this.stepY = 0;
    this.computeFacingDirection();
    this.status = 1;
  }

  /** GetPikachuWalkingAnimationSpeed: a happy Pikachu (80+) animates faster. */
  private walkingAnimationSpeed(): void {
    const d = this.e.state.pikachu.happiness >= 80 ? 2 : 5;
    this.intraAnim++;
    if (this.intraAnim !== d) return;
    this.intraAnim = 0;
    this.animFrame = (this.animFrame + 1) & 3;
  }

  /** Func_fcae2: hidden while standing on the player's square. */
  private onPlayer(): boolean {
    if (this.mapY !== this.player.y || this.mapX !== this.player.x) return false;
    this.hidden = true;
    return true;
  }

  /** UpdatePikachuWalkingSprite */
  private updateWalkingSprite(): void {
    if (this.flags & PIKA_NO_DRAWING) {
      this.hidden = true;
      return;
    }
    const player = this.e.sprites[0];
    if (this.e.ram.spinning && player) {
      // .copy_player: the player's facing and animation frame
      this.hidden = false;
      this.renderDir = player.facing;
      this.renderFrame = player.animFrame;
      return;
    }
    if (this.e.ram.fontLoaded) {
      if (this.onPlayer()) return;
      this.hidden = false;
      this.renderDir = this.facing;
      this.renderFrame = 0;
      return;
    }
    this.hidden = false;
    this.renderDir = this.facing;
    this.renderFrame = this.animFrame;
  }

  /** Func_fc803: idle next to the player, turning now and then; excited when the player is away. */
  private idle(): void {
    if (this.onPlayer()) return;
    this.walkAnimCounter = (this.walkAnimCounter - 1) & 0xff;
    if (this.walkAnimCounter) {
      this.intraAnim = this.animFrame = 0;
      this.updateWalkingSprite();
      return;
    }
    const cmd = this.current();
    if (cmd >= 5) return this.startIdleAnimation(cmd);
    this.walkAnimCounter = 0x20;
    this.facing = this.e.random() & 0xc;
    this.intraAnim = this.animFrame = 0;
    this.updateWalkingSprite();
  }

  /** Func_fc842: one of four random animations. */
  private startIdleAnimation(cmd: number): void {
    const which = this.e.random() & 3;
    if (which === 0) {
      // Func_fc862: hop on the spot
      this.facing = (((cmd - 1) * 4) & 0xc) as number;
      this.status = 6;
      this.hopY = this.hopX = 0;
      this.walkAnimCounter = 0x11;
      return this.hopFrame();
    }
    if (which === 1) {
      this.status = 7;
      this.walkAnimCounter = 0x30;
      return this.spinFrame((a) => (a + 1) & 3);
    }
    this.walkAnimCounter = 0x20;
    if (which === 2) {
      this.status = 8;
      return this.spinFrame((a) => a ^ 1);
    }
    this.status = 9;
    this.turnFrame();
  }

  /** Func_fc835 */
  private endIdleAnimation(): void {
    this.walkAnimCounter = 0x10;
    this.status = 1;
  }

  /** asm_fc87f */
  private hopFrame(): void {
    if (this.playerWalking()) {
      // Func_fc8c7
      this.offY -= this.hopY;
      this.offX -= this.hopX;
      return this.endIdleAnimation();
    }
    this.flags |= PIKA_ANIMATING;
    const [dy, dx] = HOP[this.walkAnimCounter - 1];
    this.offY += dy - this.hopY;
    this.offX += dx - this.hopX;
    this.hopY = dy;
    this.hopX = dx;
    this.walkAnimCounter--;
    if (!this.walkAnimCounter) this.endIdleAnimation();
  }

  /** asm_fc904 / asm_fc937 */
  private spinFrame(next: (frame: number) => number): void {
    if (this.playerWalking()) return this.endIdleAnimation();
    this.flags |= PIKA_ANIMATING;
    this.intraAnim++;
    if (this.intraAnim === 8) {
      this.intraAnim = 0;
      this.animFrame = next(this.animFrame);
    }
    this.updateWalkingSprite();
    this.walkAnimCounter--;
    if (!this.walkAnimCounter) this.endIdleAnimation();
  }

  /** asm_fc969 */
  private turnFrame(): void {
    if (this.playerWalking()) return this.endIdleAnimation();
    this.flags |= PIKA_ANIMATING;
    this.intraAnim++;
    if (this.intraAnim === 8) {
      this.intraAnim = 0;
      this.facing = CLOCKWISE[(CLOCKWISE.indexOf(this.facing) + 1) & 3];
    }
    this.updateWalkingSprite();
    this.walkAnimCounter--;
    if (!this.walkAnimCounter) this.endIdleAnimation();
  }

  // ------------------------------------------------------------ queries
  /** IsPikachuRightNextToPlayer (diagonals don't count; the same square does). */
  isRightNextToPlayer(): boolean {
    const dy = this.mapY - this.player.y;
    const dx = this.mapX - this.player.x;
    if (dy === 0) return Math.abs(dx) <= 1;
    return Math.abs(dy) === 1 && dx === 0;
  }

  /** GetPikachuFacingDirection: where Pikachu is relative to the player ($ff on the same square). */
  directionFromPlayer(): number {
    if (this.mapY !== this.player.y) return this.mapY > this.player.y ? FACING_DOWN : FACING_UP;
    if (this.mapX !== this.player.x) return this.mapX > this.player.x ? FACING_RIGHT : FACING_LEFT;
    return 0xff;
  }

  // ------------------------------------------------------------ scripted movement
  /**
   * TryApplyPikachuMovementData: only when Pikachu stands on side `facing` of the player.
   * Some maps' copies of it don't refresh the follow buffer afterwards (`refresh` = false).
   */
  *tryApplyMovementData(facing: number, data: number[], refresh = true): Co {
    if (!isStarterPikachuAliveInParty(this.e.state) || this.player.mode !== 'walk') return;
    if (this.directionFromPlayer() !== facing) return;
    yield* this.applyMovementData(data);
    if (refresh) this.refreshFollow();
  }

  /** ApplyPikachuMovementData_: run movement commands until $3f. */
  *applyMovementData(data: number[]): Co {
    const db = this.e.bundle.hidden.pikachuMovement;
    let i = 0;
    const next = () => {
      const v = data[i++];
      if (v === undefined) throw new Error('Pikachu movement data has no $3f terminator');
      return v;
    };
    const m = new PikachuMovement(this);
    for (;;) {
      const cmd = next();
      if (cmd === 0x3f) break;
      const row = db.slice(cmd * 4, cmd * 4 + 4);
      if (row.length < 4) throw new Error(`unknown Pikachu movement command $${cmd.toString(16)}`);
      const p1 = row[1] === 0x80 ? next() : row[1];
      const p2 = row[3] === 0x80 ? next() : row[3];
      yield* m.execute(row[0], p1, row[2], p2);
    }
    this.lift = 0;
    this.shadow = false;
    this.sync();
    yield;
  }


  /** Mirror the follower into sprite slot 15 for drawing and sprite collisions. */
  sync(): void {
    const e = this.e;
    let s = e.sprites[this.slot];
    if (s?.obj) return; // a map object uses slot 15 here
    if (!s) {
      s = newSprite(this.slot);
      e.sprites[this.slot] = s;
    }
    s.pictureId = c('sprite', 'SPRITE_PIKACHU');
    s.mapX = this.mapX;
    s.mapY = this.mapY;
    s.offX = this.offX;
    s.offY = this.offY;
    s.facing = this.renderDir;
    s.animFrame = this.renderFrame;
    s.hidden = this.hidden || this.status === 0;
    s.movementStatus = this.status ? 1 : 0;
  }

  /** The sprite as drawn (for the renderer). */
  get sprite(): Sprite | undefined {
    return this.e.sprites[this.slot];
  }
}

/** One ExecutePikachuMovementCommand: Func1 moves, Func2 animates, two frames per iteration. */
class PikachuMovement {
  private flags = 0;
  private stepTimer = 0;
  private subTimer = 0;
  private x = 0;
  private y = 0;
  private yOffset = 0;
  private xOffset = 0;
  private imageDir = 0;
  private imageFrame = 0;
  private p1 = 0;
  private p2 = 0;

  constructor(private readonly f: PikachuFollower) {
    // SPRITESTATEDATA1_IMAGEINDEX as it stands when the movement starts
    this.imageDir = f.renderDir;
    this.imageFrame = f.renderFrame;
  }

  *execute(func1: number, p1: number, func2: number, p2: number): Co {
    this.flags = 0;
    this.stepTimer = 0;
    this.subTimer = 0;
    this.p1 = p1;
    this.p2 = p2;
    const f = this.f;
    for (;;) {
      this.func1(func1);
      this.func2(func2);
      // GetCoordsForPikachuShadow: the image index and the pixel position (plus the hop offset)
      f.renderDir = this.imageDir;
      f.renderFrame = this.imageFrame;
      f.hidden = false;
      f.offY = this.y + Math.max(0, this.yOffset) - f.mapY * 16;
      f.offX = this.x + this.xOffset - f.mapX * 16;
      f.lift = Math.max(0, -this.yOffset);
      // AnimatePikachuShadow: the ledge shadow under a hop
      f.shadow = (this.flags & 0x40) !== 0;
      this.flags &= ~0x40;
      f.sync();
      yield;
      yield;
      if (this.flags & 0x80) return;
    }
  }

  private get facing(): number {
    return this.f.facing & 0xc;
  }
  private set facing(v: number) {
    this.f.facing = v & 0xc;
  }
  private end(): void {
    this.flags |= 0x80;
  }

  /** CheckPikachuStepTimer1: true when the command's step count is done. */
  private timer1(): boolean {
    this.stepTimer++;
    if ((this.p1 & 0x1f) + 1 !== this.stepTimer) return false;
    this.stepTimer = 0;
    return true;
  }
  /** CheckPikachuStepTimer2 */
  private timer2(): boolean {
    this.subTimer++;
    if ((this.p2 & 0xf) + 1 !== this.subTimer) return false;
    this.subTimer = 0;
    return true;
  }
  /** GetPikachuStepVectorMagnitude */
  private magnitude(): number {
    return ((this.p1 >> 5) & 3) + 1;
  }

  /** UpdatePikachuPosition by PIKASTEPDIR */
  private move(dir: number, a: number): void {
    const v: [number, number][] = [
      [0, a],
      [0, -a],
      [-a, 0],
      [a, 0],
      [-a, a],
      [a, a],
      [-a, -a],
      [a, -a],
    ];
    const [dx, dy] = v[dir];
    this.x += dx;
    this.y += dy;
  }

  /** ApplyPikachuStepVector: the map square follows a finished step. */
  private stepMap(dir: number): void {
    const v: [number, number][] = [
      [0, 1],
      [0, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ];
    const [dx, dy] = v[dir];
    this.f.mapX += dx;
    this.f.mapY += dy;
  }

  private func1(n: number): void {
    const f = this.f;
    const facingToDir = (fc: number) => [0, 1, 2, 3][fc >> 2] ?? 0; // SPRITE_FACING_* → PIKASTEPDIR
    // PIKASTEPDIR: DOWN, UP, LEFT, RIGHT, DOWN_LEFT, DOWN_RIGHT, UP_LEFT, UP_RIGHT
    const D = 0,
      U = 1,
      L = 2,
      R = 3,
      DL = 4,
      DR = 5,
      UL = 6,
      UR = 7;
    const turn = (table: Record<number, number>) => table[this.facing] ?? facingToDir(this.facing);
    const applyStep = (dir: number) => {
      this.move(dir, this.magnitude());
      if (this.timer1()) this.end();
    };
    const moveFacing = (dir: number, setFacing: boolean) => {
      if (setFacing) this.facing = dir << 2;
      this.move(dir, this.magnitude());
      if (!this.timer1()) return;
      this.stepMap(dir);
      this.end();
    };
    switch (n) {
      case 0x00:
      case 0x17:
        return this.end();
      case 0x01: {
        // LoadPikachuCurrentPosition
        this.y = f.mapY * 16 + f.offY;
        this.x = f.mapX * 16 + f.offX;
        this.yOffset = this.xOffset = 0;
        return this.end();
      }
      case 0x02:
        if (this.timer1()) this.end();
        return;
      case 0x03:
        return applyStep(facingToDir(this.facing));
      case 0x04:
        return applyStep(facingToDir(this.facing ^ 4));
      case 0x05:
        return applyStep(turn({ [FACING_DOWN]: R, [FACING_UP]: L, [FACING_LEFT]: D, [FACING_RIGHT]: U }));
      case 0x06:
        return applyStep(turn({ [FACING_DOWN]: L, [FACING_UP]: R, [FACING_LEFT]: U, [FACING_RIGHT]: D }));
      case 0x07:
        return applyStep(turn({ [FACING_DOWN]: DR, [FACING_UP]: UL, [FACING_LEFT]: DL, [FACING_RIGHT]: UR }));
      case 0x08:
        return applyStep(turn({ [FACING_DOWN]: DL, [FACING_UP]: UR, [FACING_LEFT]: UL, [FACING_RIGHT]: DR }));
      case 0x09:
        return applyStep(turn({ [FACING_DOWN]: UR, [FACING_UP]: DL, [FACING_LEFT]: DR, [FACING_RIGHT]: UL }));
      case 0x0a:
        return applyStep(turn({ [FACING_DOWN]: UL, [FACING_UP]: DR, [FACING_LEFT]: UR, [FACING_RIGHT]: DL }));
      case 0x0b:
        return moveFacing(D, true);
      case 0x0c:
        return moveFacing(U, true);
      case 0x0d:
        return moveFacing(L, true);
      case 0x0e:
        return moveFacing(R, true);
      case 0x0f:
        return moveFacing(DL, false);
      case 0x10:
        return moveFacing(DR, false);
      case 0x11:
        return moveFacing(UL, false);
      case 0x12:
        return moveFacing(UR, false);
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
        this.facing = (n - 0x13) << 2;
        return this.end();
      default:
        throw new Error(`Pikachu movement func1 ${n}`);
    }
  }

  private func2(n: number): void {
    const f = this.f;
    const image = (dir: number, frame: number) => {
      this.imageDir = dir & 0xc;
      this.imageFrame = frame & 3;
    };
    switch (n) {
      case 0:
        // ResetFrameCounterAndFaceCurrent
        f.intraAnim = f.animFrame = 0;
        image(this.facing, 0);
        break;
      case 1:
      case 2: {
        // UpdateSpriteImageIdxWith(PreviousImageIdxDirection | Facing). CheckPikachuStepTimer2 leaves hl on
        // wPikachuStepSubtimer, so the `inc [hl]` and the frame read use the subtimer, not the frame counter.
        const dir = n === 2 ? this.facing : this.imageDir;
        if (this.timer2()) this.subTimer = (this.subTimer + 1) & 0xff;
        image(dir, (this.subTimer >> 2) & 3);
        break;
      }
      case 3:
        this.turnImage((this.p2 & 0x40) === 0x40 ? 1 : -1);
        break;
      case 4:
        this.turnImage(1);
        break;
      case 5:
        this.turnImage(-1);
        break;
      case 6:
        image(this.imageDir, 0);
        break;
      case 7:
      case 8: {
        // UpdateJumpWith(PreviousImageIdxDirection | Facing)
        const dir = n === 8 ? this.facing : this.imageDir;
        image(dir, this.jumpTimer());
        this.yOffset = this.sine();
        if (this.yOffset) this.flags |= 0x40;
        break;
      }
      case 9:
        image(this.facing, 0);
        this.yOffset = this.sine();
        break;
      case 10:
        break;
      default:
        throw new Error(`Pikachu movement func2 ${n}`);
    }
  }

  private turnImage(step: 1 | -1): void {
    let dir = this.imageDir;
    if (this.timer2()) dir = CLOCKWISE[(CLOCKWISE.indexOf(dir) + (step === 1 ? 1 : 3)) & 3];
    this.imageDir = dir;
    this.imageFrame = 0;
  }

  /** PikaMovementFunc2_Timer */
  private jumpTimer(): number {
    const f = this.f;
    f.intraAnim = (f.intraAnim + 1) & 3;
    if (!f.intraAnim) f.animFrame = (f.animFrame + 1) & 3;
    return f.animFrame;
  }

  /** PikaMovementFunc_Sine: amplitude (p2 & $f) + 1, speed 2^((p2 >> 4) & 7), starting half a turn in. */
  private sine(): number {
    const d = (this.p2 & 0xf) + 1;
    const shift = (this.p2 >> 4) & 7;
    const e = shift ? 1 << shift : 1;
    this.subTimer = (this.subTimer + e) & 0xff;
    const arg = (this.subTimer + 0x20) & 0xff;
    return sineE(this.f.e.bundle.hidden.pikachuSine, arg, d);
  }
}

/** Sine_e with amplitude d (GetSine multiplies the table entry by d, keeping the high byte). */
function sineE(table: number[], e: number, d: number): number {
  const a = e & 0x3f;
  const get = (i: number) => {
    let mul = d;
    let de = table[i];
    let hl = 0;
    while (mul) {
      if (mul & 1) hl = (hl + de) & 0xffff;
      mul >>= 1;
      de = (de << 1) & 0xffff;
    }
    return hl >> 8;
  };
  if (a < 0x20) return get(a);
  const h = get(a & 0x1f);
  return h ? -h : 0;
}
