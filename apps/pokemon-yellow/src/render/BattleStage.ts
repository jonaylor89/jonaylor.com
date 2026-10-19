/** ROM-pixel billboards on a small low-poly battle diorama. The GB layer is
 * authoritative: reading its pic tiles also mirrors Transform/Substitute,
 * send-outs, blinks and fainting without introducing another battle state.
 */
import * as THREE from 'three';
import type { TileScreen } from '../ui/TileScreen';

export class BattleStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-6, 6, 3, -3, 0.1, 80);
  readonly actors: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  readonly platforms: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly textures: THREE.DataTexture[] = [];
  private readonly buffers: Uint8Array[] = [];
  private readonly bg = new THREE.Color();
  private readonly shades = new Uint8Array(56 * 56);
  private readonly outside = new Uint8Array(56 * 56);
  private readonly flood = new Uint16Array(56 * 56);
  private readonly geometry = new THREE.PlaneGeometry(3.8, 3.8);
  private readonly platformGeometry = new THREE.CylinderGeometry(1.9, 2.1, 0.18, 12);
  private attack?: { turn: number; start: number };
  /** Texture packs: a sky-gradient backdrop and platforms of the area's ground. */
  private look?: { platform: THREE.Color; backdrop: THREE.DataTexture };
  setLook(look: { top: THREE.Color; bottom: THREE.Color; platform: THREE.Color } | undefined): void {
    this.look?.backdrop.dispose();
    this.look = undefined;
    this.scene.background = null;
    if (!look) return;
    const rows = 64, data = new Uint8Array(rows * 4);
    for (let y = 0; y < rows; y++) {
      const c = look.bottom.clone().lerp(look.top, Math.pow(y / (rows - 1), 0.8)).convertLinearToSRGB();
      data.set([c.r * 255, c.g * 255, c.b * 255, 255].map(Math.round), y * 4);
    }
    const backdrop = new THREE.DataTexture(data, 1, rows, THREE.RGBAFormat);
    backdrop.colorSpace = THREE.SRGBColorSpace;
    backdrop.magFilter = backdrop.minFilter = THREE.LinearFilter;
    backdrop.needsUpdate = true;
    this.look = { platform: look.platform.clone(), backdrop };
    this.scene.background = backdrop;
    for (const p of this.platforms) p.material.color.copy(look.platform);
  }

  constructor() {
    this.camera.position.set(0, 5, 12);
    this.camera.lookAt(0, 1.2, 0);
    for (let side = 0; side < 2; side++) {
      const pixels = new Uint8Array(56 * 56 * 4);
      const texture = new THREE.DataTexture(pixels, 56, 56, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      const actor = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.05 }));
      actor.name = side ? 'battle:enemy' : 'battle:player';
      actor.position.set(side ? 3 : -3, 2, side ? -0.6 : 0.6);
      actor.quaternion.copy(this.camera.quaternion);
      const platform = new THREE.Mesh(this.platformGeometry, new THREE.MeshBasicMaterial());
      platform.position.set(side ? 3 : -3, 0, side ? -0.6 : 0.6);
      this.scene.add(platform, actor);
      this.actors.push(actor); this.platforms.push(platform);
      this.textures.push(texture); this.buffers.push(pixels);
    }
  }

  animation(id: number, turn: number, frame: number): void {
    // The original move animation remains on the GB layer; only a restrained
    // lunge is added to the 3D presentation (never to status/send-out animations).
    if (id > 0 && id <= 165) this.attack = { turn, start: frame };
  }

  update(screen: TileScreen, frame: number, reducedMotion = false): void {
    const color = screen.colorAt(0, 0, 0);
    this.bg.setRGB(color[0] / 255, color[1] / 255, color[2] / 255, THREE.SRGBColorSpace);
    for (let side = 0; side < 2; side++) {
      const ox = side ? 12 : 1, oy = side ? 0 : 5;
      const base = side ? 0x100 : 0x200;
      const pixels = this.buffers[side];
      let changed = false, visible = false;
      // Only exterior colour-zero pixels are transparent: keep enclosed white
      // details (eyes, teeth, belly) instead of punching holes in the mon.
      const shades = this.shades, outside = this.outside, queue = this.flood;
      for (let ty = 0; ty < 7; ty++) for (let tx = 0; tx < 7; tx++) {
        const code = screen.get(ox + tx, oy + ty);
        const indices = code >= base && code < base + 49 ? screen.glyphIndices(code) : undefined;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) shades[(ty * 8 + y) * 56 + tx * 8 + x] = indices?.[y * 8 + x] ?? 0;
      }
      outside.fill(0);
      let tail = 0;
      const visit = (i: number) => { if (!shades[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
      for (let i = 0; i < 56; i++) { visit(i); visit(55 * 56 + i); visit(i * 56); visit(i * 56 + 55); }
      for (let head = 0; head < tail; head++) {
        const i = queue[head];
        if (i % 56) visit(i - 1);
        if (i % 56 < 55) visit(i + 1);
        if (i >= 56) visit(i - 56);
        if (i < 55 * 56) visit(i + 56);
      }
      for (let ty = 0; ty < 7; ty++) for (let tx = 0; tx < 7; tx++) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const at = (ty * 8 + y) * 56 + tx * 8 + x;
          const shade = shades[at];
          const col = screen.colorAt(ox + tx, oy + ty, shade);
          // DataTexture's row zero is the bottom of the image in GL.
          const i = ((55 - (ty * 8 + y)) * 56 + tx * 8 + x) * 4;
          const alpha = outside[at] ? 0 : 255;
          if (alpha) visible = true;
          if (pixels[i] !== col[0] || pixels[i + 1] !== col[1] || pixels[i + 2] !== col[2] || pixels[i + 3] !== alpha) changed = true;
          pixels[i] = col[0]; pixels[i + 1] = col[1]; pixels[i + 2] = col[2]; pixels[i + 3] = alpha;
        }
      }
      if (changed) this.textures[side].needsUpdate = true;
      this.actors[side].visible = visible;
      if (!this.look) {
        const pc = screen.colorAt(ox, oy, 1);
        this.platforms[side].material.color.setRGB(pc[0] / 255, pc[1] / 255, pc[2] / 255, THREE.SRGBColorSpace).multiplyScalar(0.8);
      }
      const elapsed = this.attack ? frame - this.attack.start : 100;
      const lunge = !reducedMotion && this.attack?.turn === side && elapsed >= 0 && elapsed < 24 ? Math.sin(elapsed / 24 * Math.PI) * 0.6 : 0;
      this.actors[side].position.x = (side ? 3 : -3) + (side ? -lunge : lunge);
    }
  }

  /** Reserve the upper 40% for the stage; the intact GB screen sits below it. */
  render(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getSize(new THREE.Vector2());
    const height = Math.max(1, Math.floor(size.y * 0.4));
    const aspect = size.x / height;
    const span = Math.max(5.4, 12 / aspect);
    this.camera.left = -span * aspect / 2; this.camera.right = span * aspect / 2;
    this.camera.top = span / 2; this.camera.bottom = -span / 2;
    this.camera.updateProjectionMatrix();
    const viewport = renderer.getViewport(new THREE.Vector4());
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new THREE.Color()).clone(), clearAlpha = renderer.getClearAlpha();
    try {
      renderer.setClearColor(this.bg, 1);
      renderer.clear();
      renderer.autoClear = false;
      renderer.setViewport(0, size.y - height, size.x, height);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setViewport(viewport);
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    this.look?.backdrop.dispose();
    this.geometry.dispose(); this.platformGeometry.dispose();
    this.actors.forEach((a) => a.material.dispose());
    this.platforms.forEach((a) => a.material.dispose());
    this.textures.forEach((t) => t.dispose());
    this.scene.clear();
  }
}
