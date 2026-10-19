/** Texture-pack sky: gradient, sun, drifting clouds and stars on a camera-centred dome. */
import * as THREE from 'three';
import type { SkyParams } from './types';
import type { ThemeUniforms } from './shader';

export class SkyDome {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(sky: SkyParams, shared: ThemeUniforms) {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color().setStyle(sky.zenith) },
        uHorizon: { value: new THREE.Color().setStyle(sky.horizon) },
        uCloudColor: { value: new THREE.Color().setStyle(sky.cloudColor) },
        uSky: { value: new THREE.Vector3(sky.sunDisc, sky.clouds, sky.stars) },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uThemeTime: shared.uThemeTime,
        uFade: shared.uFade,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uZenith, uHorizon, uCloudColor, uSky, uSunDir, uSunColor;
        uniform float uThemeTime, uFade;
        float h2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float n2(vec2 p) {
          vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1, 0)), u.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), u.x), u.y);
        }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * n2(p); p = p * 2.02 + 11.3; a *= 0.5; } return v; }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.02, 0.65, h), 0.75));
          col = mix(col, uHorizon * 0.85, smoothstep(0.0, -0.35, h));
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunColor * (pow(sd, 900.0) * 3.0 + pow(sd, 10.0) * 0.18) * uSky.x;
          if (h > 0.0 && uSky.y > 0.0) {
            vec2 uv = d.xz / (h + 0.12) * 1.4 + vec2(uThemeTime * 0.012, uThemeTime * 0.004);
            float c = smoothstep(0.48, 0.78, fbm(uv));
            col = mix(col, uCloudColor * (0.85 + 0.25 * fbm(uv * 2.0 + 5.0)), c * uSky.y * smoothstep(0.0, 0.2, h));
          }
          if (uSky.z > 0.0 && h > 0.0) {
            vec2 cell = floor(vec2(atan(d.z, d.x) * 120.0, h * 160.0));
            float star = step(0.9965, h2(cell)) * (0.6 + 0.4 * sin(uThemeTime * 2.0 + h2(cell + 3.0) * 40.0));
            col += vec3(star) * uSky.z * smoothstep(0.02, 0.25, h);
          }
          col = uFade < 0.0 ? mix(col, vec3(1.0), -uFade) : mix(col, vec3(0.0), uFade);
          gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), material);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'pack:sky';
  }

  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  /** The horizon colour for distance fog. */
  horizon(): THREE.Color {
    return this.mesh.material.uniforms.uHorizon.value as THREE.Color;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
