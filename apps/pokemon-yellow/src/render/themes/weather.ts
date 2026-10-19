/** Ambient particles around the camera target (snow, leaves, petals, fireflies, dust, rain). Purely visual. */
import * as THREE from 'three';
import type { WeatherParams } from './types';
import type { ThemeUniforms } from './shader';

const KINDS = { snow: 0, leaves: 1, petals: 2, fireflies: 3, dust: 4, rain: 5 } as const;
const BOX = new THREE.Vector3(36, 12, 36);

export class Weather {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(readonly params: WeatherParams, shared: ThemeUniforms, mobile: boolean, pixelRatio: number) {
    const count = Math.min(2500, Math.round(params.density * (BOX.x * BOX.y * BOX.z) / 1000 * (mobile ? 0.5 : 1)));
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    const kind = KINDS[params.kind];
    const glow = params.kind === 'fireflies';
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: BOX.clone() },
        uColor: { value: new THREE.Color().setStyle(params.color) },
        uColor2: { value: new THREE.Color().setStyle(params.color2 ?? params.color) },
        uPixelRatio: { value: pixelRatio * (params.size ?? 1) },
        uThemeTime: shared.uThemeTime,
        uFade: shared.uFade,
      },
      defines: { KIND: kind },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform vec3 uCenter, uBox;
        uniform float uThemeTime, uPixelRatio;
        varying vec4 vSeed;
        varying float vAlpha;
        void main() {
          float t = uThemeTime;
          vec3 p = aSeed.xyz * uBox;
          float s = aSeed.w;
          #if KIND == 0
            p.y -= t * (0.55 + s * 0.5); p.x += sin(t * 0.8 + s * 40.0) * 0.45; p.z += cos(t * 0.6 + s * 25.0) * 0.3;
          #elif KIND == 1 || KIND == 2
            p.y -= t * (0.45 + s * 0.35); p.x += sin(t * 0.9 + s * 30.0) * 1.1 + t * 0.35; p.z += cos(t * 0.7 + s * 20.0) * 0.6;
          #elif KIND == 3
            p.y = aSeed.y * 2.2 + 0.2;
            p += vec3(sin(t * 0.37 + s * 31.0), sin(t * 0.9 + aSeed.x * 17.0) * 0.25, cos(t * 0.31 + aSeed.z * 23.0)) * 1.3;
          #elif KIND == 4
            p.y = aSeed.y * 3.0 + 0.2;
            p += vec3(sin(t * 0.13 + s * 31.0), sin(t * 0.21 + aSeed.x * 17.0) * 0.3, cos(t * 0.11 + aSeed.z * 23.0)) * 0.5;
          #else
            p.y -= t * (11.0 + s * 3.0); p.x -= t * 1.2;
          #endif
          vec3 base = uCenter - vec3(uBox.x * 0.5, 0.0, uBox.z * 0.5);
          p = mod(p - base, uBox) + base;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = KIND == 0 ? 0.11 : KIND == 3 ? 0.16 : KIND == 4 ? 0.04 : KIND == 5 ? 0.35 : 0.13;
          gl_PointSize = size * (0.7 + s * 0.6) * uPixelRatio * 900.0 / -mv.z;
          vSeed = aSeed;
          vAlpha = KIND == 3 ? 0.35 + 0.65 * pow(0.5 + 0.5 * sin(t * (1.5 + s * 2.0) + s * 60.0), 3.0) : 1.0;
          // Thin out particles right in front of the camera.
          vAlpha *= smoothstep(1.5, 4.0, -mv.z);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor, uColor2;
        uniform float uThemeTime, uFade;
        varying vec4 vSeed;
        varying float vAlpha;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          float a;
          #if KIND == 1 || KIND == 2
            float ang = uThemeTime * (1.0 + vSeed.w * 2.0) + vSeed.x * 6.28;
            pc = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * pc;
            a = 1.0 - smoothstep(0.18, 0.24, length(pc * vec2(1.0, KIND == 1 ? 2.2 : 1.6)));
          #elif KIND == 5
            a = (1.0 - smoothstep(0.0, 0.06, abs(pc.x))) * 0.45;
          #elif KIND == 3
            a = pow(1.0 - smoothstep(0.0, 0.5, length(pc)), 2.0);
          #else
            a = 1.0 - smoothstep(0.25, 0.5, length(pc));
          #endif
          vec3 col = mix(uColor, uColor2, step(0.5, fract(vSeed.w * 7.13)));
          col = uFade < 0.0 ? mix(col, vec3(1.0), -uFade) : mix(col, vec3(0.0), uFade);
          if (a * vAlpha < 0.02) discard;
          gl_FragColor = linearToOutputTexel(vec4(col, a * vAlpha * (1.0 - abs(uFade))));
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = `pack:weather:${params.kind}`;
  }

  follow(x: number, z: number): void {
    (this.points.material.uniforms.uCenter.value as THREE.Vector3).set(x, 0, z);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
