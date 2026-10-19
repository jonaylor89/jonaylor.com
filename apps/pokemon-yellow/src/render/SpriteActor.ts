/**
 * Billboarded overworld character built from the ROM sprite sheet.
 * Frame layout (16x16 each): 0 down, 1 up, 2 left, 3 down-walk, 4 up-walk,
 * 5 left-walk. Right-facing frames are the left frames mirrored, and the
 * down/up walk cycle alternates the walk frame with its mirror, as the
 * original sprite engine does with OAM X-flip.
 */
import * as THREE from 'three';
import type { Facing } from '../world/movement';
import type { SpriteVisual } from './manifest';
import { buildSpriteProp } from './spriteProp';

const DIR_FRAME: Record<Facing, number> = { down: 0, up: 1, left: 2, right: 2 };

export class SpriteActor {
  readonly object = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly tex: THREE.Texture;
  facing: Facing = 'down';
  /** Animation frame counter (SPRITESTATEDATA1_ANIMFRAMECOUNTER, 0-3). */
  animFrame = 0;

  constructor(
    texture: THREE.Texture,
    private readonly visual: SpriteVisual,
    /** The sprite id this actor was built from. */
    readonly sprite = 0,
  ) {
    this.tex = texture.clone();
    this.tex.needsUpdate = true;
    this.tex.wrapS = THREE.RepeatWrapping;
    this.tex.repeat.set(1 / visual.frames, 1);
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: !!visual.model });
    const geo = visual.model ? buildSpriteProp(visual.model, visual.modelPixels!) : new THREE.PlaneGeometry(1, 1);
    if (!visual.model) geo.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 1;
    this.object.add(this.mesh);
    this.updateFrame();
  }

  /** Place at a (possibly fractional) square position. */
  setPosition(x: number, y: number, height: number): void {
    // squares are 1 unit; stand in the middle, nudged toward the camera so walls behind never clip.
    this.object.position.set(x + 0.5, height, y + (this.visual.model ? 0.5 : 0.62));
  }

  /**
   * Face the camera. The sprite stands upright around its feet but leans back
   * toward the camera by most of the camera pitch, so the 16x16 art keeps its
   * proportions under the overhead third-person view.
   */
  faceCamera(camera: THREE.Camera, lean = 0.85): void {
    if (this.visual.model) return; // Props stand in the world, not on the camera plane.
    const p = new THREE.Vector3();
    camera.getWorldPosition(p);
    const dx = p.x - this.object.position.x;
    const dz = p.z - this.object.position.z;
    const dy = p.y - this.object.position.y;
    this.object.rotation.order = 'YXZ';
    this.object.rotation.y = Math.atan2(dx, dz);
    this.object.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz)) * lean;
  }

  updateFrame(): void {
    if (this.visual.model) return;
    let frame = DIR_FRAME[this.facing];
    let mirror = this.facing === 'right';
    if (this.visual.walking) {
      // SpriteFacingAndAnimationTable: stand, walk, stand, walk (mirrored for up/down)
      const phase = this.animFrame & 3;
      if (phase === 1 || phase === 3) {
        frame += 3;
        if ((this.facing === 'down' || this.facing === 'up') && phase === 3) mirror = !mirror;
      }
    }
    if (this.visual.frames === 1) frame = 0;
    if (frame >= this.visual.frames) frame = frame % this.visual.frames;
    const w = 1 / this.visual.frames;
    if (mirror) {
      this.tex.repeat.set(-w, 1);
      this.tex.offset.set((frame + 1) * w, 0);
    } else {
      this.tex.repeat.set(w, 1);
      this.tex.offset.set(frame * w, 0);
    }
  }

  /** Re-upload after the shared sheet was redrawn (palette fades) */
  refreshTexture(): void {
    this.tex.needsUpdate = true;
  }

  private overlay?: THREE.Mesh;
  /**
   * Grass priority (SPRITESTATEDATA2_GRASSPRIORITY): the grass tile's non-white
   * pixels drawn over the lower half of the sprite, as BG-over-OBJ priority does.
   */
  setGrassOverlay(tex: THREE.Texture | undefined): void {
    if (!tex) {
      if (this.overlay) this.overlay.visible = false;
      return;
    }
    if (!this.overlay) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.translate(0, 0.5, 0.004);
      this.overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
      this.overlay.renderOrder = 2;
      this.object.add(this.overlay);
    }
    const mat = this.overlay.material as THREE.MeshBasicMaterial;
    if (mat.map !== tex) {
      mat.map = tex;
      mat.needsUpdate = true;
    }
    this.overlay.visible = true;
  }

  setVisible(v: boolean): void {
    this.object.visible = v;
  }

  dispose(): void {
    if (this.overlay) {
      this.overlay.geometry.dispose();
      (this.overlay.material as THREE.Material).dispose();
    }
    this.tex.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
  }
}
