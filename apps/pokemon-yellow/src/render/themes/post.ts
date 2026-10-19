/** One full-screen pass after the 3D scene: grade, tilt-shift, ink outlines, bloom, vignette, grain. */
import * as THREE from 'three';
import type { PostParams } from './types';

export class PostPass {
  private target?: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  /** The scene pass's counts (renderer.info resets on the final quad). */
  sceneInfo = { calls: 0, triangles: 0 };

  constructor(params: PostParams) {
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uNearFar: { value: new THREE.Vector2(0.1, 200) },
        uGrade: { value: new THREE.Vector4(params.saturation, params.contrast, params.exposure, params.bloom) },
        uLift: { value: new THREE.Color().setStyle(params.lift, THREE.LinearSRGBColorSpace) },
        uGain: { value: new THREE.Color().setStyle(params.gain, THREE.LinearSRGBColorSpace) },
        uFx: { value: new THREE.Vector4(params.vignette, params.grain, params.tiltShift, params.outline) },
        uOutline: { value: new THREE.Color().setStyle(params.outlineColor, THREE.LinearSRGBColorSpace) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor, tDepth;
        uniform vec2 uResolution, uNearFar;
        uniform vec4 uGrade, uFx;
        uniform vec3 uLift, uGain, uOutline;
        varying vec2 vUv;
        float depthAt(vec2 uv) {
          float z = texture2D(tDepth, uv).r * 2.0 - 1.0;
          float n = uNearFar.x, f = uNearFar.y;
          return 2.0 * n * f / (f + n - z * (f - n));
        }
        float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        void main() {
          vec2 px = 1.0 / uResolution;
          vec3 col = texture2D(tColor, vUv).rgb;
          if (uFx.z > 0.0) {
            // Miniature focus band a little below centre, where the player stands.
            float blur = smoothstep(0.12, 0.62, abs(vUv.y - 0.44)) * uFx.z * 7.0;
            if (blur > 0.05) {
              vec3 acc = col; float w = 1.0;
              for (int i = 0; i < 12; i++) {
                float a = float(i) * 2.39996;
                float r = sqrt(float(i) + 0.5) / sqrt(12.0);
                acc += texture2D(tColor, vUv + vec2(cos(a), sin(a)) * r * blur * px * 2.2).rgb;
                w += 1.0;
              }
              col = acc / w;
            }
          }
          if (uGrade.w > 0.0) {
            vec3 glow = vec3(0.0);
            for (int i = 0; i < 8; i++) {
              float a = float(i) * 0.7854;
              glow += max(texture2D(tColor, vUv + vec2(cos(a), sin(a)) * px * 9.0).rgb - 0.7, 0.0);
            }
            col += glow / 8.0 * uGrade.w * 2.0;
          }
          if (uFx.w > 0.0) {
            float d = depthAt(vUv);
            float e = 0.0;
            for (int i = 0; i < 4; i++) {
              vec2 o = (i == 0 ? vec2(1, 0) : i == 1 ? vec2(-1, 0) : i == 2 ? vec2(0, 1) : vec2(0, -1)) * px * 1.25;
              e = max(e, abs(depthAt(vUv + o) - d) / d);
            }
            col = mix(col, uOutline, smoothstep(0.015, 0.05, e) * uFx.w);
          }
          // Grade in display space.
          col = pow(max(col * uGrade.z, 0.0), vec3(1.0 / 2.2));
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, uGrade.x);
          col = (col - 0.5) * uGrade.y + 0.5;
          col = col * uGain + uLift * (1.0 - col);
          col *= mix(1.0, smoothstep(0.98, 0.32, length((vUv - 0.5) * vec2(1.15, 1.0))), uFx.x);
          col += (hash(vUv * uResolution) - 0.5) * uFx.y;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    renderer.getDrawingBufferSize(this.size);
    if (!this.target || this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target?.depthTexture?.dispose();
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(this.size.x, this.size.y, { depthBuffer: true, depthTexture: new THREE.DepthTexture(this.size.x, this.size.y) });
      this.target.texture.minFilter = this.target.texture.magFilter = THREE.LinearFilter;
    }
    const u = this.material.uniforms;
    u.tColor.value = this.target.texture;
    u.tDepth.value = this.target.depthTexture;
    (u.uResolution.value as THREE.Vector2).copy(this.size);
    (u.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    this.sceneInfo = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.material.dispose();
  }
}
