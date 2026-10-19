/** Procedural diorama scenery, merged into the map's single atlas-backed mesh.
 * Colours come from ROM palette samples, so fades/filters still affect every
 * surface. No external art, independent materials, random state or game logic.
 */
export type SceneryKind = 'tree' | 'cutTree' | 'grove' | 'roof' | 'wall' | 'fence' | 'sign'
  | 'flowers' | 'grass' | 'ledge' | 'pc' | 'bookshelf' | 'counter' | 'bin' | 'plant'
  | 'rock' | 'stump' | 'cliff' | 'table' | 'stool' | 'chair' | 'bed' | 'cabinet' | 'tv'
  | 'statue' | 'gravestone' | 'machine' | 'ball';
export type Point = [number, number, number];
export interface SceneryFace {
  corners: [Point, Point, Point, Point];
  /** Index in the square's four tiles; pixel selects a flat palette sample. */
  tile: number;
  shade: number;
  pixel?: number;
  /** A prop's own ground, or its painted contact-shadow disc (texture packs restyle both). */
  role?: 'ground' | 'shadow';
}
export interface SceneryOptions {
  samples: { tile: number; pixel: number }[];
  roof?: [number, number, number];
  /** North, east, south, west: neighbouring squares of the same structure. */
  joined?: boolean[];
  facing?: number;
  /** Stable coordinate-derived variation; never consumes gameplay RNG. */
  seed?: number;
  /** Original tiles, used for the number of windows on a facade. */
  tiles?: number[];
  /** Movable sprite props do not bake a square of ground beneath themselves. */
  ground?: boolean;
  /** Multi-square objects are clipped into cells, never repeated per tile. */
  part?: [number, number];
  span?: [number, number];
  rise?: number;
  /** Tile references for the surrounding floor, not the prop's illustration. */
  floor?: number[];
  /** Dense whole-map batches use the same rounded silhouette with fewer facets. */
  compact?: boolean;
}

/** Local coordinates: x east, y up, z south, within a 16px gameplay square. */
export function sceneryFaces(kind: SceneryKind, opts: SceneryOptions): SceneryFace[] {
  const out: SceneryFace[] = [];
  const face = (a: Point, b: Point, c: Point, d: Point, tile = 0, shade = 1, color?: number) => {
    const sample = color === undefined ? undefined : opts.samples[color];
    out.push({ corners: [a, b, c, d], tile: sample?.tile ?? tile, pixel: sample?.pixel, shade });
  };
  const box = (x: number, z: number, w: number, d: number, bottom: number, top: number, color: number) => {
    face([x, top, z + d], [x + w, top, z + d], [x + w, top, z], [x, top, z], 0, 1, color);
    face([x, bottom, z + d], [x + w, bottom, z + d], [x + w, top, z + d], [x, top, z + d], 0, 0.86, color);
    face([x + w, bottom, z], [x, bottom, z], [x, top, z], [x + w, top, z], 0, 0.62, color);
    face([x + w, bottom, z + d], [x + w, bottom, z], [x + w, top, z], [x + w, top, z + d], 0, 0.74, color);
    face([x, bottom, z], [x, bottom, z + d], [x, top, z + d], [x, top, z], 0, 0.88, color);
  };
  /** Ring profile, bottom to top: cylinders, tapered pots, domes and spheres.
   * Reverse angular winding on the walls makes outward faces front-facing.
   */
  const lathe = (x: number, z: number, rings: [number, number][], color: number, n = 8, depth = 1, phase = 0) => {
    const point = (ring: number, i: number): Point => {
      const a = i * Math.PI * 2 / n + phase;
      return [x + Math.cos(a) * rings[ring][1], rings[ring][0], z + Math.sin(a) * rings[ring][1] * depth];
    };
    for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < n; i++) {
      const shade = 0.72 + 0.23 * (Math.sin((i + 0.5) * Math.PI * 2 / n + phase) + 1) / 2 + r / rings.length * 0.05;
      face(point(r, i + 1), point(r, i), point(r + 1, i), point(r + 1, i + 1), 0, shade, color);
    }
    const last = rings.length - 1;
    for (let i = 0; rings[last][1] > 0 && i < n; i++) {
      const c: Point = [x, rings[last][0], z];
      face(point(last, i + 1), point(last, i), c, c, 0, 1, color);
    }
  };
  const blob = (x: number, y: number, z: number, r: number, h: number, color: number, depth = 1, phase = 0) =>
    lathe(x, z, [[y, r * 0.35], [y + h * 0.18, r * 0.85], [y + h * 0.52, r], [y + h * 0.82, r * 0.7], [y + h, 0]], color, 8, depth, phase);
  const front = (x: number, z: number, w: number, bottom: number, top: number) => {
    // Restrict ROM illustrations to real display surfaces, never stretch over a cube.
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const left = x + col * w / 2, right = left + w / 2;
      const hi = top - row * (top - bottom) / 2, lo = hi - (top - bottom) / 2;
      face([left, lo, z], [right, lo, z], [right, hi, z], [left, hi, z], row * 2 + col);
    }
  };
  const ground = () => {
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const x = col / 2, z = row / 2;
      face([x, 0, z + 0.5], [x + 0.5, 0, z + 0.5], [x + 0.5, 0, z], [x, 0, z], row * 2 + col);
      out[out.length - 1].role = 'ground';
    }
  };
  const shadow = (radius: number, depth = 1) => {
    if (opts.ground !== false) {
      const start = out.length;
      lathe(0.5, 0.5, [[0.003, radius]], 0, 10, depth);
      for (const f of out.slice(start)) { f.shade = 0.86; f.role = 'shadow'; }
    }
  };
  const legs = (bottom: number, top: number, inset = 0.15) => {
    for (const x of [inset, 0.86 - inset]) for (const z of [inset, 0.86 - inset]) box(x, z, 0.14, 0.14, bottom, top, 2);
  };
  const leaves = (x: number, y: number, z: number, scale: number) => {
    // Solid diamond leaves, visible from either side, rather than crossed sprites.
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      const dx = Math.cos(a) * scale, dz = Math.sin(a) * scale;
      const side: Point = [-Math.sin(a) * scale * 0.24, 0, Math.cos(a) * scale * 0.24];
      const start: Point = [x, y, z], tip: Point = [x + dx, y + scale * 0.5, z + dz];
      const mid: Point = [x + dx * 0.6, y + scale * 0.65, z + dz * 0.6];
      const p: Point = [mid[0] + side[0], mid[1], mid[2] + side[2]];
      const q: Point = [mid[0] - side[0], mid[1], mid[2] - side[2]];
      face(start, p, tip, q, 0, 0.95, 2);
      face(q, tip, p, start, 0, 0.75, 2);
    }
  };
  const seed = ((opts.seed ?? 0) >>> 0) % 997 / 997;
  if (opts.ground !== false && !['roof', 'wall', 'cliff', 'ledge', 'grass', 'flowers', 'ball'].includes(kind)) {
    if (opts.floor) for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const x = col / 2, z = row / 2;
      face([x, 0, z + 0.5], [x + 0.5, 0, z + 0.5], [x + 0.5, 0, z], [x, 0, z], opts.floor[row * 2 + col]);
    }
    else face([0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0], 0, 1, 0);
  }
  const groundFaces = out.length;
  for (const f of out) f.role = 'ground';
  switch (kind) {
    case 'tree':
    case 'grove': {
      if (opts.compact) {
        lathe(0.5, 0.5, [[0, 0.15], [0.8, 0.085]], 3, 5);
        lathe(0.5, 0.5, [[0.52, 0.32], [1.02, 0.49], [1.55, 0.34], [1.89, 0]], 2, 6, 1, seed * 0.2);
        break;
      }
      shadow(0.46);
      lathe(0.5, 0.5, [[0, 0.17], [0.16, 0.11], [0.95, 0.085]], 3, 7);
      const h = kind === 'grove' ? 1.05 : 0.95 + seed * 0.12;
      // Interlocking rounded crowns: a leafy silhouette from every camera angle.
      blob(0.5, 0.52, 0.5, 0.49, h, 2, 1, seed * 0.4);
      blob(0.33, 0.92, 0.43, 0.29, 0.66, 1, 1, 0.3);
      blob(0.66, 0.85, 0.6, 0.3, 0.62, 2, 1, 0.6);
      blob(0.52, 1.24, 0.48, 0.27, 0.65, 2, 1, seed);
      break;
    }
    case 'cutTree':
      shadow(0.3);
      lathe(0.5, 0.5, [[0, 0.15], [0.12, 0.1], [0.55, 0.07]], 3, 7);
      blob(0.35, 0.38, 0.48, 0.26, 0.48, 2);
      blob(0.66, 0.42, 0.53, 0.25, 0.49, 2);
      blob(0.5, 0.69, 0.48, 0.25, 0.45, 1);
      break;
    case 'roof': {
      const [north, mid, south] = opts.roof ?? [1.3, 1.65, 1.3];
      const heights = [north, mid, south];
      for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
        const x = col / 2, z = row / 2;
        face([x, heights[row + 1], z + 0.5], [x + 0.5, heights[row + 1], z + 0.5], [x + 0.5, heights[row], z], [x, heights[row], z], row * 2 + col, row ? 0.86 : 1, 2);
      }
      // Raised shingle courses follow the shared slope, not one pyramid per cell.
      const height = (z: number) => z <= 0.5 ? north + (mid - north) * z * 2 : mid + (south - mid) * (z - 0.5) * 2;
      for (const z of [0.22, 0.47, 0.72, 0.97])
        face([0, height(z) + 0.008, z], [1, height(z) + 0.008, z], [1, height(z - 0.025) + 0.008, z - 0.025], [0, height(z - 0.025) + 0.008, z - 0.025], 0, 0.9, 1);
      // A roof is a closed building volume, not a floating cap: even a roof
      // cell surrounded by other roof cells needs support down to the ground
      // when the connected patch is viewed from its front/back edge.
      face([0, 0, 1], [1, 0, 1], [1, south, 1], [0, south, 1], 0, 0.86, 1);
      face([1, 0, 0], [0, 0, 0], [0, north, 0], [1, north, 0], 0, 0.62, 1);
      // Eaves and fascia only at the outside of a shared roof patch.
      if (!opts.joined?.[2]) box(0, 0.92, 1, 0.08, south - 0.1, south, 2);
      if (!opts.joined?.[0]) box(0, 0, 1, 0.08, north - 0.1, north, 2);
      for (const x of [0, 1]) if (!opts.joined?.[x ? 1 : 3]) for (let row = 0; row < 2; row++) {
        const z = x ? [(row + 1) / 2, row / 2] : [row / 2, (row + 1) / 2];
        const h = x ? [heights[row + 1], heights[row]] : [heights[row], heights[row + 1]];
        face([x, 0, z[0]], [x, 0, z[1]], [x, h[1], z[1]], [x, h[0], z[0]], 0, 0.78, 1);
      }
      break;
    }
    case 'wall': {
      box(0, 0, 1, 0.94, 0, 1.14, 1);
      // Preserve shop labels / brickwork on the vertical facade, not on its roof.
      front(0, 0.941, 1, 0, 1.12);
      box(0, 0.94, 1, 0.04, 0.05, 0.13, 2);
      box(0, 0.94, 1, 0.06, 1.06, 1.14, 0);
      for (let col = 0; col < 2; col++) if (opts.tiles?.[col] === 0x0a) {
        const x = 0.04 + col * 0.5;
        box(x, 0.94, 0.4, 0.035, 0.51, 0.94, 3);
        box(x + 0.035, 0.975, 0.33, 0.006, 0.55, 0.9, 0);
        box(x - 0.015, 0.94, 0.43, 0.06, 0.49, 0.55, 2);
      }
      break;
    }
    case 'sign':
      shadow(0.25, 0.65);
      lathe(0.5, 0.48, [[0, 0.075], [0.78, 0.055]], 3, 6);
      box(0.07, 0.36, 0.86, 0.2, 0.53, 1.12, 2);
      box(0.11, 0.56, 0.78, 0.025, 0.57, 1.08, 0);
      front(0.13, 0.586, 0.74, 0.6, 1.05);
      break;
    case 'fence':
      for (const x of [0.06, 0.84]) {
        box(x, 0.1, 0.1, 0.14, 0, 0.59, 1);
        lathe(x + 0.05, 0.17, [[0.59, 0.09], [0.7, 0]], 1, 4, 1, Math.PI / 4);
      }
      for (const y of [0.2, 0.44]) box(0, 0.13, 1, 0.08, y, y + 0.09, 2);
      break;
    case 'grass':
    case 'flowers': {
      ground();
      const positions = [[0.2, 0.25], [0.7, 0.22], [0.44, 0.7]];
      for (const [x, z] of positions) {
        const h = kind === 'grass' ? 0.24 + seed * 0.05 : 0.22;
        for (let i = 0; i < 3; i++) {
          const a = i * Math.PI * 2 / 3 + seed;
          const dx = Math.cos(a) * 0.12, dz = Math.sin(a) * 0.12;
          const p: Point = [x - dz * 0.25, 0, z + dx * 0.25];
          const q: Point = [x + dz * 0.25, 0, z - dx * 0.25];
          const tip: Point = [x + dx, h, z + dz];
          face(p, q, tip, tip, 0, 1, 2);
          face(q, p, tip, tip, 0, 0.8, 2);
        }
        if (kind === 'flowers') {
          for (const [dx, dz] of [[-0.065, 0], [0.065, 0], [0, -0.065], [0, 0.065]])
            lathe(x + dx, z + dz, [[h - 0.015, 0.055], [h + 0.03, 0]], 1, 5);
          lathe(x, z, [[h + 0.03, 0.03]], 3, 6);
        }
      }
      break;
    }
    case 'ledge': {
      const rotate = (p: Point): Point => opts.facing === 8 ? [1 - p[2], p[1], p[0]] : opts.facing === 12 ? [p[2], p[1], 1 - p[0]] : p;
      const start = out.length;
      face([0, 0.12, 0.72], [1, 0.12, 0.72], [1, 0.12, 0], [0, 0.12, 0], 0);
      face([0, 0, 1], [1, 0, 1], [1, 0.12, 0.72], [0, 0.12, 0.72], 2, 0.74);
      // Close the bank where the ledge row ends, so the open end never shows the background.
      // Local x=0/x=1 are the row's ends; after rotation they face west/east, north/south or south/north.
      const [westSide, eastSide] = opts.facing === 8 ? [0, 2] : opts.facing === 12 ? [2, 0] : [3, 1];
      if (!opts.joined?.[westSide]) face([0, 0, 0], [0, 0, 1], [0, 0.12, 0.72], [0, 0.12, 0], 2, 0.8);
      if (!opts.joined?.[eastSide]) face([1, 0, 1], [1, 0, 0], [1, 0.12, 0], [1, 0.12, 0.72], 2, 0.8);
      for (const f of out.slice(start)) f.corners = f.corners.map(rotate) as SceneryFace['corners'];
      break;
    }
    case 'bin':
      shadow(0.3);
      // Tapered metal body, rolled foot/rim, domed removable lid, handle and ribs.
      lathe(0.5, 0.5, [[0.02, 0.23], [0.08, 0.27], [0.6, 0.3], [0.65, 0.31]], 1, 12);
      lathe(0.5, 0.5, [[0.04, 0.255], [0.09, 0.255]], 2, 12);
      lathe(0.5, 0.5, [[0.63, 0.33], [0.69, 0.33], [0.75, 0.22], [0.77, 0]], 0, 12);
      for (let i = 0; i < 10; i++) {
        const a = i * Math.PI / 5;
        lathe(0.5 + Math.cos(a) * 0.273, 0.5 + Math.sin(a) * 0.273, [[0.12, 0.013], [0.57, 0.013]], 2, 4);
      }
      for (const x of [0.41, 0.55]) box(x, 0.47, 0.04, 0.06, 0.75, 0.84, 3);
      box(0.41, 0.47, 0.18, 0.06, 0.81, 0.86, 2);
      break;
    case 'plant':
      shadow(0.3);
      lathe(0.5, 0.5, [[0.02, 0.17], [0.1, 0.2], [0.43, 0.27]], 1, 10);
      lathe(0.5, 0.5, [[0.38, 0.29], [0.46, 0.29]], 2, 10);
      lathe(0.5, 0.5, [[0.465, 0.24]], 3, 10);
      lathe(0.5, 0.5, [[0.46, 0.025], [0.94, 0.02]], 2, 5);
      leaves(0.5, 0.55, 0.5, 0.39);
      leaves(0.5, 0.83, 0.5, 0.3);
      blob(0.5, 0.92, 0.5, 0.16, 0.35, 2);
      break;
    case 'stump':
      shadow(0.4);
      lathe(0.5, 0.5, [[0.01, 0.4], [0.16, 0.27], [0.54, 0.23], [0.59, 0.25]], 2, 9);
      lathe(0.5, 0.5, [[0.595, 0.21]], 0, 9);
      lathe(0.5, 0.5, [[0.597, 0.14]], 1, 9);
      lathe(0.5, 0.5, [[0.599, 0.1]], 0, 9);
      break;
    case 'rock':
      if (opts.compact) {
        lathe(0.48, 0.49, [[0.015, 0.24], [0.2, 0.46], [0.58, 0.34], [0.79, 0]], 2, 6, 0.94, seed);
        break;
      }
      shadow(0.44);
      blob(0.48, 0.015, 0.49, 0.46, 0.72 + seed * 0.12, 2, 0.94, 0.2 + seed);
      blob(0.76, 0.01, 0.72, 0.17, 0.23, 1, 0.85);
      break;
    case 'cliff': {
      // Chamfered continuous escarpments; only exposed edges have a rock face.
      const top = 1;
      const joined = opts.joined ?? [];
      const inset = [joined[3] ? 0 : 0.13, joined[0] ? 0 : 0.13, joined[1] ? 1 : 0.87, joined[2] ? 1 : 0.87];
      const [l, n, r, s] = inset;
      face([l, top, s], [r, top, s], [r, top, n], [l, top, n], 0, 1, 1);
      const edges: [Point, Point, Point, Point][] = [
        [[1, 0, 0], [0, 0, 0], [l, top, n], [r, top, n]],
        [[1, 0, 1], [1, 0, 0], [r, top, n], [r, top, s]],
        [[0, 0, 1], [1, 0, 1], [r, top, s], [l, top, s]],
        [[0, 0, 0], [0, 0, 1], [l, top, s], [l, top, n]],
      ];
      for (let i = 0; i < 4; i++) if (!joined[i]) {
        const [a, b, c, d] = edges[i];
        const mid: Point = [(a[0] + c[0]) / 2, top * 0.55, (a[2] + c[2]) / 2];
        face(a, b, mid, mid, 0, 0.77, 2);
        face(b, c, mid, mid, 0, 0.85, 1);
        face(c, d, mid, mid, 0, 0.92, 2);
        face(d, a, mid, mid, 0, 0.7, 2);
      }
      break;
    }
    case 'pc':
    case 'tv':
      shadow(0.38, 0.8);
      box(0.12, 0.18, 0.76, 0.65, 0, 0.4, 2);
      box(0.17, 0.16, 0.66, 0.4, 0.4, 1.04, 1);
      box(0.21, 0.56, 0.58, 0.035, 0.49, 0.97, 3);
      front(0.25, 0.596, 0.48, 0.55, 0.92);
      if (kind === 'pc') {
        box(0.12, 0.56, 0.76, 0.29, 0.4, 0.45, 0);
        for (let row = 0; row < 3; row++) for (let col = 0; col < 6; col++)
          box(0.23 + col * 0.09, 0.61 + row * 0.06, 0.06, 0.04, 0.45, 0.465, 2);
      }
      break;
    case 'bookshelf':
      // Open shelves with individual books and visible gaps, not a book decal.
      box(0.06, 0.13, 0.88, 0.12, 0, 1.28, 2);
      for (const x of [0.04, 0.88]) box(x, 0.12, 0.08, 0.62, 0, 1.32, 1);
      for (const y of [0.05, 0.48, 0.9, 1.28]) box(0.02, 0.1, 0.96, 0.68, y, y + 0.055, 1);
      for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) {
        const x = 0.16 + i * 0.11, y = 0.105 + row * 0.42;
        const h = 0.23 + ((i * 3 + row * 7) % 5) * 0.025;
        box(x, 0.3, 0.075, 0.32, y, y + h, i % 3);
        box(x, 0.621, 0.075, 0.008, y + h * 0.7, y + h * 0.7 + 0.025, 1);
      }
      break;
    case 'counter':
      box(0, 0.06, 1, 0.86, 0, 0.5, 2);
      box(0, 0, 1, 1, 0.5, 0.59, 0);
      box(0, 0.93, 1, 0.04, 0.12, 0.43, 1);
      break;
    case 'table':
      shadow(0.44);
      legs(0, 0.58);
      box(0.02, 0.04, 0.96, 0.92, 0.52, 0.62, 2);
      box(0.04, 0.06, 0.92, 0.88, 0.62, 0.68, 1);
      break;
    case 'stool':
    case 'chair':
      shadow(0.28);
      for (const x of [0.25, 0.65]) for (const z of [0.25, 0.65]) box(x, z, 0.08, 0.08, 0, 0.42, 2);
      box(0.19, 0.19, 0.62, 0.62, 0.39, 0.47, 1);
      if (kind === 'chair') {
        for (const x of [0.2, 0.72]) box(x, 0.2, 0.08, 0.08, 0.47, 0.96, 2);
        box(0.2, 0.19, 0.6, 0.1, 0.68, 0.94, 1);
      }
      break;
    case 'bed':
      legs(0, 0.23, 0.08);
      box(0.04, 0.08, 0.92, 0.86, 0.2, 0.33, 2);
      box(0.06, 0.06, 0.88, 0.08, 0.2, 0.8, 1);
      box(0.08, 0.16, 0.84, 0.74, 0.33, 0.46, 0);
      box(0.1, 0.42, 0.8, 0.48, 0.46, 0.51, 1);
      blob(0.5, 0.46, 0.28, 0.32, 0.1, 0, 0.3);
      break;
    case 'cabinet':
      box(0.06, 0.12, 0.88, 0.69, 0.03, 1.1, 1);
      for (const y of [0.1, 0.41, 0.72]) {
        box(0.11, 0.81, 0.78, 0.04, y, y + 0.27, 0);
        box(0.43, 0.85, 0.14, 0.05, y + 0.11, y + 0.15, 3);
      }
      box(0.02, 0.09, 0.96, 0.78, 1.1, 1.17, 2);
      break;
    case 'statue':
      box(0.1, 0.12, 0.8, 0.76, 0, 0.14, 2);
      box(0.19, 0.2, 0.62, 0.6, 0.14, 0.4, 1);
      blob(0.5, 0.4, 0.49, 0.31, 0.65, 2);
      blob(0.5, 0.96, 0.5, 0.29, 0.42, 1);
      for (const x of [0.3, 0.7]) lathe(x, 0.5, [[1.18, 0.1], [1.53, 0]], 2, 5);
      box(0.36, 0.76, 0.08, 0.04, 1.14, 1.2, 3);
      box(0.56, 0.76, 0.08, 0.04, 1.14, 1.2, 3);
      break;
    case 'gravestone':
      box(0.12, 0.18, 0.76, 0.65, 0, 0.12, 2);
      lathe(0.5, 0.4, [[0.1, 0.32], [0.72, 0.32], [0.9, 0.23], [0.97, 0]], 1, 8, 0.45);
      box(0.32, 0.551, 0.36, 0.02, 0.28, 0.61, 2);
      for (const y of [0.37, 0.46, 0.55]) box(0.38, 0.572, 0.24, 0.01, y, y + 0.025, 3);
      break;
    case 'machine':
      box(0.06, 0.12, 0.88, 0.7, 0, 1.18, 1);
      box(0.12, 0.82, 0.76, 0.03, 0.42, 1.1, 3);
      front(0.15, 0.851, 0.7, 0.46, 1.06);
      box(0.22, 0.82, 0.56, 0.08, 0.18, 0.32, 2);
      for (const x of [0.7, 0.79]) box(x, 0.86, 0.05, 0.03, 0.36, 0.4, 0);
      break;
    case 'ball':
      lathe(0.5, 0.5, [[0.02, 0], [0.1, 0.22], [0.28, 0.28]], 0, 12);
      lathe(0.5, 0.5, [[0.28, 0.285], [0.34, 0.285]], 3, 12);
      lathe(0.5, 0.5, [[0.34, 0.28], [0.51, 0.2], [0.59, 0]], 2, 12);
      blob(0.5, 0.27, 0.78, 0.07, 0.12, 0, 0.4);
      break;
  }
  if (!opts.part) return out;
  // Clip a shared object to each cell. This also handles border/region slicing
  // without requiring the anchor cell to be in the rendered region.
  const [px, pz] = opts.part, [w, d] = opts.span ?? [2, 2];
  const transformed = out.slice(groundFaces).map((f) => ({ ...f, corners: f.corners.map(([x, y, z]) =>
    [x * w - px, y * (opts.rise ?? 1), z * d - pz] as Point) as SceneryFace['corners'] }));
  return [...out.slice(0, groundFaces), ...clipToCell(transformed)];
}

/** Sutherland–Hodgman clipping in x/z, preserving winding and palette samples. */
function clipToCell(faces: SceneryFace[]): SceneryFace[] {
  const out: SceneryFace[] = [];
  for (const f of faces) for (const ids of [[0, 1, 2], [0, 2, 3]]) {
    let polygon = ids.map((i) => f.corners[i]);
    for (const [axis, bound, sign] of [[0, 0, 1], [0, 1, -1], [2, 0, 1], [2, 1, -1]]) {
      const input = polygon;
      polygon = [];
      for (let i = 0; i < input.length; i++) {
        const a = input[i], b = input[(i + 1) % input.length];
        const da = (a[axis] - bound) * sign, db = (b[axis] - bound) * sign;
        if (da >= 0) polygon.push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db);
          const p = a.map((v, j) => v + (b[j] - v) * t) as Point;
          p[axis] = bound;
          polygon.push(p);
        }
      }
    }
    for (let i = 1; i < polygon.length - 1; i++)
      out.push({ ...f, corners: [polygon[0], polygon[i], polygon[i + 1], polygon[i + 1]] });
  }
  return out;
}
