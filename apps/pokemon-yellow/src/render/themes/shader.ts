/**
 * The texture-pack surface shader, chained after the cutaway and water
 * shaders of the map's MeshBasicMaterial. In a pack the atlas holds ROM
 * shade indices (see INDEX_GRAYS), so palette fades/flashes still remap
 * exactly; this shader turns (material, shade, world position) into an
 * albedo from the pack's ramps plus procedural texture, then lights it.
 */
import type * as THREE from 'three';
import { MAT, MATERIAL_COUNT } from './materials';

/** Atlas colours for shade 0-3 in a pack: lightest first, decoded by `decodeShade`. */
export const INDEX_GRAYS: [number, number, number][] = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];

const defines = Object.entries(MAT).map(([name, id]) => `#define M_${name} ${id}`).join('\n');

/** Shared declarations: also used by the water shader's `waterTone`. */
const FRAGMENT_DECLARATIONS = /* glsl */ `
#define THEMED 1
#define MATS ${MATERIAL_COUNT}
${defines}
uniform sampler2D uRamps;
uniform vec4 uSurfA[MATS];
uniform vec4 uSurfB[MATS];
uniform vec3 uPalette[4];
uniform vec3 uPaletteHue;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec4 uLightParams;
uniform float uFade;
uniform float uSnow;
uniform float uThemeTime;
uniform vec3 uWindowGlow;
uniform vec4 uLantern;
uniform vec3 uLanternColor;
uniform sampler2D uShadowMap;
uniform float uShadowStrength;
uniform vec2 uShadowTexel;
varying float vThemeMat;
varying vec3 vThemeNormal;
varying float vThemeAO;
varying vec4 vShadowCoord;

float tHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * tNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v / 0.875;
}
/** Voronoi: distance to the nearest feature point and that cell's random id. */
vec2 tCell(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 r = g + vec2(tHash(i + g), tHash(i + g + 19.7)) - f;
    float dd = dot(r, r);
    if (dd < d) { d = dd; id = tHash(i + g + 7.3); }
  }
  return vec2(sqrt(d), id);
}
/** Planar coordinates for a face: ground uses x/z, walls their own plane. */
vec2 tPlanar(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.y > 0.6 ? p.xz : (a.x > a.z ? p.zy : p.xy);
}
float decodeShade(float r) { return r > 0.7 ? 0.0 : r > 0.24 ? 1.0 : r > 0.045 ? 2.0 : 3.0; }
vec3 rampAt(int m, float t) {
  return texture2D(uRamps, vec2((clamp(t, 0.0, 3.0) + 0.5) / 4.0, (float(m) + 0.5) / float(MATS))).rgb;
}
vec3 waterTone(vec2 uv) { return rampAt(M_WATER, decodeShade(texture2D(map, uv).r)); }

/** Procedural surface detail, as a shift along the material's ramp. */
float themeDetail(int m, vec3 p, vec3 n, float shade, inout float ao, inout float gloss) {
  vec2 q = tPlanar(p, n);
  if (m == M_GROUND || m == M_PATH) {
    return (tFbm(q * 0.45) - 0.5) * 1.1 + (tNoise(q * 23.0) - 0.5) * 0.45 + (tNoise(q * 7.0) - 0.5) * 0.3;
  }
  if (m == M_TALL_GRASS) {
    // Dense streaks on the patch floor; blades darken toward their roots.
    float streak = p.y < 0.01 ? (tNoise(vec2(q.x * 38.0, q.y * 7.0)) - 0.5) * 0.9 + 0.35 : 0.0;
    return (0.17 - p.y) * 5.5 + streak + (tNoise(q * 11.0) - 0.5) * 0.4;
  }
  if (m == M_FLOWERS) return (tNoise(q * 13.0) - 0.5) * 0.4;
  if (m == M_FOLIAGE) {
    if (shade > 2.5) return (tNoise(vec2((p.x + p.z) * 34.0, p.y * 3.0)) - 0.5) * 1.2;
    vec2 c = tCell(p.xz * 5.5 + vec2(p.y * 3.1, -p.y * 2.3));
    ao *= mix(0.8, 1.0, smoothstep(0.35, 1.25, p.y));
    return (c.x - 0.38) * 1.5 + (c.y - 0.5) * 0.45 + (tNoise(q * 12.0) - 0.5) * 0.35;
  }
  if (m == M_ROOF) {
    float row = p.y * 10.0;
    float course = smoothstep(0.78, 1.0, fract(row));
    float tile = fract((p.x + p.z * 0.15) * 5.0 + floor(row) * 0.5);
    float joint = smoothstep(0.9, 1.0, tile) + smoothstep(0.1, 0.0, tile);
    return course * 1.0 + joint * 0.5 - 0.25 + (tHash(vec2(floor((p.x + p.z * 0.15) * 5.0 + floor(row) * 0.5), floor(row))) - 0.5) * 0.55;
  }
  if (m == M_FACADE) {
    float lap = abs(n.y) < 0.5 ? smoothstep(0.86, 1.0, fract(q.y * 6.0)) : 0.0;
    return (tNoise(q * 15.0) - 0.5) * 0.3 + lap * 0.45;
  }
  if (m == M_ROCK) {
    float strata = sin(p.y * 15.0 + tFbm(q * 1.3) * 5.0);
    vec2 c = tCell(q * 3.4);
    return strata * 0.3 + (1.0 - smoothstep(0.0, 0.08, abs(c.x - 0.5))) * 0.4 + (tFbm(q * 6.0) - 0.5) * 0.6;
  }
  if (m == M_WOOD) {
    vec2 g = abs(n.y) > 0.6 ? p.xz : q;
    return (tNoise(vec2(g.x * 3.0, g.y * 46.0)) - 0.5) * 0.55 + (tNoise(vec2(g.x * 46.0, g.y * 3.0)) - 0.5) * 0.25;
  }
  if (m == M_FLOOR_WOOD) {
    float board = floor(p.z * 4.0);
    float seam = smoothstep(0.92, 1.0, fract(p.z * 4.0));
    float joint = smoothstep(0.975, 1.0, fract(p.x * 0.75 + tHash(vec2(board, 3.0))));
    return (tHash(vec2(board, 1.0)) - 0.5) * 0.5 + (tNoise(vec2(p.x * 3.0, p.z * 70.0)) - 0.5) * 0.45 + (seam + joint) * 1.1;
  }
  if (m == M_FLOOR_TILE) {
    vec2 g = fract(p.xz * 2.0);
    float grout = 1.0 - smoothstep(0.02, 0.05, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)));
    gloss *= 1.0 - grout;
    return grout * 1.1 + (tHash(floor(p.xz * 2.0)) - 0.5) * 0.2 + (tNoise(q * 9.0) - 0.5) * 0.12;
  }
  if (m == M_CAVE_FLOOR) {
    vec2 c = tCell(q * 4.5);
    return (tFbm(q * 0.9) - 0.5) * 1.0 + (1.0 - smoothstep(0.0, 0.25, c.x)) * -0.45 + (tNoise(q * 25.0) - 0.5) * 0.3;
  }
  if (m == M_INDOOR_WALL) {
    ao *= mix(0.72, 1.0, smoothstep(0.0, 0.3, p.y));
    return (tNoise(q * 22.0) - 0.5) * 0.18 + step(0.5, fract(q.x * 4.0)) * 0.12;
  }
  if (m == M_METAL) return (tNoise(vec2(q.x * 90.0, q.y * 2.0)) - 0.5) * 0.25;
  if (m == M_STONE) return (tFbm(q * 3.0) - 0.5) * 0.8 + step(0.975, tHash(floor(q * 26.0))) * 0.6;
  return (tNoise(q * 9.0) - 0.5) * 0.3;
}

float themeShadow(vec3 n) {
  if (uShadowStrength <= 0.0) return 1.0;
  vec3 c = vShadowCoord.xyz / vShadowCoord.w;
  if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float bias = max(0.0022 * (1.0 - max(dot(n, uSunDir), 0.0)), 0.0007);
  float lit = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
    lit += c.z - bias > texture2D(uShadowMap, c.xy + vec2(float(x), float(y)) * uShadowTexel).r ? 0.0 : 1.0;
  return mix(1.0, lit / 9.0, uShadowStrength);
}
`;

const FRAGMENT_SURFACE = /* glsl */ `
{
  int m = int(vThemeMat + 0.5);
  if (m == M_SHADOW) discard;
  vec3 n = normalize(vThemeNormal);
  // Building volumes: flat tops read as roofing, roof gables/supports as walls;
  // the sloped/vertical banks of lawns and ledges as dirt.
  if (m == M_FACADE && n.y > 0.7 && vWorldPos.y > 0.9) m = M_ROOF;
  else if (m == M_ROOF && abs(n.y) < 0.35) m = M_FACADE;
  else if (m == M_GROUND && n.y < 0.97) m = M_PATH;
  float shade = decodeShade(themeTexel.r);
  vec4 A = uSurfA[m];
  vec4 B = uSurfB[m];
  float gloss = B.x;
  float aoMul = 1.0;
  vec3 albedo;
  if (m == M_WATER) {
    albedo = diffuseColor.rgb;
  } else {
    float d = themeDetail(m, vWorldPos, n, shade, aoMul, gloss);
    float t = mix(A.x, shade, A.y) + d * A.z;
    albedo = rampAt(m, t);
    if (B.y >= 0.0 && B.z > 0.0) {
      float mask = smoothstep(0.56, 0.74, tFbm(vWorldPos.xz * 0.21 + 3.1)) * B.z;
      albedo = mix(albedo, rampAt(int(B.y + 0.5), t), mask);
    }
    // Tint: take the area palette's hue, keep the ramp's own lightness and colourfulness.
    if (A.w > 0.0) {
      vec3 pal = uPaletteHue;
      vec3 lumaW = vec3(0.2126, 0.7152, 0.0722);
      vec3 pc = pal - dot(pal, lumaW);
      float pChroma = length(pc);
      if (pChroma > 0.004) {
        vec3 ac = albedo - dot(albedo, lumaW);
        vec3 hued = dot(albedo, lumaW) + pc * (max(length(ac), 0.12) / pChroma);
        albedo = mix(albedo, max(hued, 0.0), A.w);
      }
    }
  }
#ifdef PACK_SURFACE
  packSurface(albedo, gloss, m, shade, vWorldPos, n);
#endif
  if (uSnow > 0.0 && m != M_WATER) {
    float up = smoothstep(0.4, 0.85, n.y);
    float drift = smoothstep(0.3, 0.62, tFbm(vWorldPos.xz * 1.6) * 0.6 + uSnow * 0.55);
    float s = up * drift;
    albedo = mix(albedo, vec3(0.9, 0.93, 0.98), s);
    gloss = mix(gloss, 0.2, s);
  }
  float ao = mix(1.0, vThemeAO, uLightParams.z) * aoMul;
  float wrap = uLightParams.y;
  float diff = clamp((dot(n, uSunDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
  float sh = themeShadow(n);
  vec3 amb = mix(uGroundAmb, uSkyAmb, n.y * 0.5 + 0.5) * uLightParams.x;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(n, H), 0.0), m == M_WATER ? 90.0 : 40.0) * gloss * sh;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * uLightParams.w;
  vec3 lit = albedo * (amb * ao + uSunColor * diff * sh) + uSunColor * spec + amb * rim * 0.6;
  if (B.w > 0.0 && shade > 2.5) lit = mix(lit, uWindowGlow, B.w);
  if (uLantern.w > 0.0) {
    float l = 1.0 - smoothstep(0.0, uLantern.w, length(vWorldPos - uLantern.xyz));
    lit += albedo * uLanternColor * l * l * 1.5;
  }
  lit = uFade < 0.0 ? mix(lit, vec3(1.0), -uFade) : mix(lit, vec3(0.0), uFade);
  diffuseColor.rgb = lit;
}
`;

export interface ThemeUniforms {
  [name: string]: THREE.IUniform;
}

/** Chain the pack shader onto a map material (after installCutaway/installWater). */
export function installTexturePack(material: THREE.MeshBasicMaterial, uniforms: ThemeUniforms, packGlsl: string | undefined, cacheKey: string): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float themeMaterial;
        attribute vec3 themeNormal;
        attribute float themeAO;
        uniform mat4 uShadowMatrix;
        varying float vThemeMat;
        varying vec3 vThemeNormal;
        varying float vThemeAO;
        varying vec4 vShadowCoord;
      `)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vThemeMat = themeMaterial;
        vThemeAO = themeAO;
        vThemeNormal = normalize(mat3(modelMatrix) * themeNormal);
        vShadowCoord = uShadowMatrix * (modelMatrix * vec4(transformed, 1.0));
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
${FRAGMENT_DECLARATIONS}
${packGlsl ? `#define PACK_SURFACE 1\n${packGlsl}` : ''}
`)
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 themeTexel = diffuseColor;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_SURFACE}`);
  };
  material.customProgramCacheKey = () => `texture-pack-${cacheKey}`;
}
