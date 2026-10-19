/** World-space still-sprite meshes, sampling the original sheet so OBJ palette
 * fades stay in sync. Strength boulders / item balls keep the actor lifecycle,
 * visibility, position interpolation and object interactions of the ROM sprite.
 */
import * as THREE from 'three';
import { sceneryFaces } from './scenery';

export function buildSpriteProp(kind: 'rock' | 'ball', pixels: number[]): THREE.BufferGeometry {
  const samples = pixels.map((pixel) => ({ tile: 0, pixel }));
  const faces = sceneryFaces(kind, { samples, ground: false });
  const pos: number[] = [], uv: number[] = [], color: number[] = [], indices: number[] = [];
  for (const f of faces) {
    const base = pos.length / 3, pixel = f.pixel ?? pixels[0];
    for (const [x, y, z] of f.corners) {
      pos.push(x - 0.5, y, z - 0.5);
      uv.push(((pixel % 16) + 0.5) / 16, 1 - (Math.floor(pixel / 16) + 0.5) / 16);
      color.push(f.shade, f.shade, f.shade);
    }
    indices.push(base, base + 1, base + 2);
    if (f.corners[2].some((v, i) => v !== f.corners[3][i])) indices.push(base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
