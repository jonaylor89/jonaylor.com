# Intentional deviations from the original

This lists every place where behavior intentionally differs from Pokémon Yellow (as documented by
pret/pokeyellow). Anything not listed here is meant to match the original; a mismatch is a bug.

## Presentation
- **3D rendering.** Maps are drawn as extruded tiles viewed by a perspective camera, not a
  160×144 tile screen. Gameplay coordinates, collision and timing still use the original 16×16
  squares and frame counts. Scenery uses authored low-poly trees, pitched roofs, fences,
  signboards, plants, ledges and furniture, coloured from the original tiles and palettes;
  these shapes do not change the ROM collision grid.
- **View distance.** The original only shows a 3-block strip of a connected map. We draw up to 8
  squares of the surroundings so the 3D view doesn't end abruptly. Phone quality uses four
  squares and caps DPR at 1.5 (desktop cap: two) to bound rendering cost.
- **Cross-tileset connections.** Route 23 connects to Route 22 (OVERWORLD) and Indigo Plateau
  while using the PLATEAU tileset. The original reads the connected strip with the current tileset,
  indexing past the end of its blockset and showing garbage. We read the connected map's blocks with
  that map's own tileset, both for drawing and for passability. Walking across these edges behaves
  the same as in the original.
- **Cutaway.** Geometry between the camera and the player is dithered away so the player is
  never hidden.
- **Cutscene cameras.** Authored tracking/reveal rails observe the original script milestones;
  they never add waits, alter scripts or consume RNG. Entry/return blends use game frames.
  Reduced motion disables the rails. Warps reset framing; map connections translate it.
- **Sprites.** Characters are billboards that lean toward the camera. The frames, mirroring and
  walk cycle are the original ones.
- **Color palettes.** WEB SETTINGS offers optional palettes beyond the Super Game Boy colors.
  Vivid, pastel, golden dusk, moonlit night and sepia regrade each area's own SGB palette (hue
  kept, saturation, shadows and tint changed); DMG green, pocket grayscale and high contrast
  replace every palette with one 4-shade ramp. All keep the shade order, so FadePal fades,
  flashes and text behave as with the original palette, which stays the default.
- **Fades.** Fades step through FadePal1–8 like the original; in 3D the rBGP remap recolors the
  tile textures and the sky, and rOBP0 the sprite sheets, so lighting and fog still shade the
  remapped colors.

## Battles
- **Battle presentation.** Transitions use the full 160×144 screen. During battle the intact
  GB screen is a smaller panel below a 3D diorama: billboards mirror its current ROM pic tiles
  (including Transform, Substitute and fainting) over low-poly platforms. A short, frame-timed
  lunge accompanies moves unless reduced motion is enabled. The overworld is not shown. The
  panel's layout, HUDs, palettes, menus and timing follow the original.
- **Move animations.** Ported in full, drawn as on a Super Game Boy/Game Boy Color: subanimation
  sprites use wAnimPalette $F0, so their light-gray pixels show white. Mid-scanline effects (the
  wavy screen, the enemy HUD shake) are drawn as per-line offsets of the finished tile layer.
- **Battle transitions.** The eight transitions are chosen exactly as in the original, but the
  shapes are drawn as black tiles over the 3D view, and the "Shrink"/"Split" variants move
  those tiles rather than the overworld's own background tiles. Screen flashes go through the
  FadePal remap.
- **Division by zero.** If Reflect/Light Screen make a scaled Defense of exactly 256 (its low byte
  becomes 0), the original divides by zero and hangs. We stop with an error instead.
- **RNG.** `Random` runs every frame (as VBlank does) on the emulated divider described below, so
  battles are deterministic for a given save but not identical to a real cartridge's rolls.

## Overworld
- **Game Boy Printer.** No printer is ever attached. PRINT BOX behaves as the original does with
  nothing on the link port: the link check reads $FF, so it shows "Printer Error 2" until B.
- **Picture pop-ups.** Fossils, fan club pictures and the Route 15 binoculars show the pic at
  once, the way AnimateSendingOutMon draws it with BATTLE ANIMATION off; the grow-in animation
  isn't played in the overworld.
- **Poison flash.** `ChangeBGPalColor0_4Frames` inverts rBGP for four frames; in 3D this recolors
  the tile textures and sky with the inverted palette.

## Accounts and persistence
- **Hosted data.** Authorized operator-prepared game bundles download automatically rather than
  asking each player for a ROM. Offline app/data caches are browser conveniences, not DRM.
- **Guest play/accounts/cloud saves.** Guests play and SAVE locally without registering. A
  dismissible sign-in suggestion offers cloud backup. Better Auth email/password accounts on
  Workers/D1 own one slot each; explicit import keeps guest/account checkpoints separate.
  Existing in-game save points write locally before background sync; divergent devices require
  a checkpoint choice and restart. No game-state merging or server-authoritative gameplay.
- **Save failure handling.** SAVE no longer reports success after a fixed frame timeout.
  It waits for durable local storage; the Hall of Fame cannot reset past a failed local save.
- **Production debugging.** Debug overlay, console globals and debug start-position/party
  overrides are development-only. Cloud checks do not make client-run progress cheat-proof.

## Web controls
- **Web settings.** The toolbar/F2 panel supplements the original OPTION menu. It pauses game
  frames, RNG and audio while open. Camera, filters, gain and keyboard bindings are device-local;
  text speed remains an original game option stored with normal game saves.
- **Touch controls/haptics.** On-screen controls support multiple pointers and drag re-entry.
  Optional device-local vibration is off by default; unsupported browsers ignore it.
  Safe-area layouts keep controls, settings and the battle panel clear of cutouts.

## Optional mods
Chosen at NEW GAME (before Oak's speech) and stored in that save; with none selected the game is
the original. Mods cannot be changed later. Both use the same save format and validation.
- **Comfort.** After a won battle, Pokémon that fought gain experience as normal and the rest of
  the party (not fainted) gain half, printed as Exp. All gains (holding the real EXP.ALL keeps its
  original behavior instead). With an HM in the bag, the party menu lists its field move for any
  Pokémon whose TM/HM list allows it (at most four field moves, as the menu fits); badge checks
  still apply. Holding B while walking moves at bike speed (not during scripted movement, ledges
  or fishing). The move menu's TYPE box shows the damage multiplier (x0, x.25, x.5, x2, x4)
  against the current opponent for damaging moves, except against the unidentified GHOST.
- **Randomizer.** A seed builds a permutation of the 151 species within tiers of 16 by base stat
  total. Wild grass/water tables, the three rods and every trainer party use it; levels,
  encounter rates and trainer movesets/AI are unchanged. Gifts, in-game trades, static
  encounters (Snorlax, legendaries, fossils), the starter Pikachu and the rival's Eevee gift are
  not randomized. The seed is independent of the game's RNG.

## Timing
- Logic runs at the Game Boy's 59.73 Hz from a fixed-step accumulator. When the browser stalls,
  at most 4 frames are caught up per display frame, then the clock resyncs.

## Not yet implemented (temporary)
Listed in TASKS.md. These are missing features, not deviations, and will be removed from here as
they land.
