# 3D scenery

The map renderer uses a procedural low-poly diorama vocabulary instead of treating
recognizable props as textured collision cubes. No external assets or additional
ROM data are needed; existing cached bundles work unchanged.

## What changed

- Rounded, lobed tree crowns with tapered trunks; smaller Cut trees and ringed stumps.
- Forest trees span their original 2×2 squares as one clipped model, not four
  trees or a canopy illustration on a slab. Tables and gym statues also share
  geometry across their original footprints.
- Cylindrical trash cans with tapered bodies, ribs, rolled rims, domed lids and
  handles, including Surge's puzzle and the S.S. Anne's bins.
- Open bookshelves with individual books, CRT computers with keyboards, TVs,
  potted plants with solid leaves, stools, tables, beds, drawer cabinets,
  machines, statues and rounded gravestones.
- Faceted boulders and continuous chamfered cliff edges; connected roofs with
  shingle courses and edge-only fascia; vertical facades with projecting windows.
- Item-ball and Strength-boulder **actors** are world-space meshes, not billboards.
  Their existing movement, hiding, collection and interaction lifecycle is retained.
- Water has continuous wind-driven ripples, subtle real surface undulation,
  depth-tinted shallows, sky sheen and shoreline foam, rather than a repeating
  pixel illustration. Mixed shoreline cells are level banks instead of cubes.

`src/render/manifest.ts` owns the ROM tile identities and multi-cell signatures.
`src/render/scenery.ts` owns the geometry. `src/render/MapMesh.ts` still merges all
static geometry into one material/draw call per map/connected tileset.
`src/render/spriteProp.ts` builds the two still-sprite replacements.
`src/render/water.ts` supplies the shore-distance field and water shader, composed
with the existing cutaway shader inside that same atlas-backed map material.

## Invariants

- Collision, passability, script coordinates and field-move block replacements
  remain ROM-driven. Visual geometry never changes the game state or gameplay RNG.
- Colours are UV samples from the existing ROM atlas/sprite sheets, including a
  tileset-wide fallback when a particular square lacks a required shade. Palette
  fades and accessibility filters still recolour the original shared textures.
- Coordinate-seeded variation is stable across rebuilds. Shared objects use their
  anchor coordinates so quarter-model seams match. Cell clipping also works when
  only part of an object falls inside a connected-map/border region.
- Bases borrow adjacent floor tiles instead of painting white squares indoors.
- Dense maps use fewer facets for trees and rocks, preserving rounded silhouettes
  while staying within the existing 180,000-triangle whole-map budget. This is
  batch-density selection, not camera-distance LOD; it does not pop while walking.
- Water uses no extra draw calls, textures or reflection render targets. Only
  near-shore tiles need extra vertices. Foam follows the real 8px water boundary,
  including tiles outside a cropped/connected mesh, not its rendering boundary.
  Wave phase is shared across connected/sliding meshes and remains continuous
  through connected-map coordinate shifts. Simulation time pauses it with the
  game; reduced motion freezes it without resetting the surface. Surf, fishing
  and collision continue to use the original ROM rules and surface heights.

## Validation

With a locally supplied supported ROM:

```sh
npm test
npm run build
npm run dev -- --port 5175 --strictPort
PORT=5175 npm run smoke -- 'map=VERMILION_GYM&x=5&y=12' '' extracted/bins.png
PORT=5175 npm run smoke -- 'map=VIRIDIAN_FOREST&x=16&y=40' '' extracted/forest.png
PORT=5175 npm run smoke -- 'map=REDS_HOUSE_1F&x=3&y=5' '' extracted/furniture.png
PORT=5175 npx tsx tools/profile.ts --software
PORT=5175 npx tsx tools/water-qa.ts --software
```

`tests/scenery.test.ts` checks deterministic bounded models, cylinder winding,
shared-object seams, palette fallback, still-prop positioning/disposal, ROM
identities, unchanged passability and atlas/mesh integrity. It also builds **all
227 maps** at the desktop border distance and checks each static batch against
the existing geometry budget. The largest measured batch is Route 23 (~163k
triangles); the full-detail forest is ~135k.

Browser spot checks cover Pallet, Red's house, Viridian Forest, Vermilion Gym and
Seafoam. The existing profiling audit also covers town/forest/battle at desktop
and emulated-phone viewports. Software-renderer/emulated-phone results are not a
claim of physical-phone performance.

`tests/water.test.ts` covers shore distance/corners, cropped-region seams,
simulation timing, reduced motion, stable palette sampling, shader composition,
mixed shoreline identities and map geometry attributes. `tools/water-qa.ts`
checks desktop pool/ocean/harbour/cave and emulated-phone pool/ocean rendering,
shader errors and budgets. It also compares rendered water animation versus
reduced-motion freezing, colour filters and palette-black/white fades. Screenshots
and the report are written under the ignored `extracted/water/` directory.

## Texture packs

`src/render/themes/` adds optional world looks on top of this geometry. A pack is one file in
`themes/packs/` (auto-discovered): colour ramps per material, surface tuning, light, sky,
weather, snow, night lighting and an optional final pass. `materials.ts` tags every map quad
with a material from the tileset and the manifest's kind/model (prop ground and painted shadow
discs are marked by `SceneryFace.role`); MapMesh adds material, flat-normal and baked
contact-shadow attributes only when a pack is active, so the Original look is unchanged.
`shader.ts` chains after the cutaway and water shaders in the same single map material.

Invariants: the atlas keeps ROM shade indices (`INDEX_GRAYS`), so tile animations, spinner
arrows and every FadePal/rBGP remap behave exactly as in the GB look; the shadow map is
rendered once per map build, never per frame; phones get no shadow map and only the grade/vignette
part of the final pass. Check a
pack with `PORT=5173 npx tsx tools/theme-qa.ts --looks <id>` (screenshots, contact sheets,
shader errors and budgets under `extracted/themes/`); `tests/texturePacks.test.ts` validates
every pack's ramps, lights and surface parameters.

## Deliberate limits

This is not an all-assets replacement: characters and Pokémon retain their
original animated ROM billboards; signs and display panels retain ROM artwork.
Unclassified architectural tiles still use the extrusion fallback. The mapping
is explicit rather than guessing object identity from image brightness, so
adding another prop means authoring its tileset identity/signature and tests.
