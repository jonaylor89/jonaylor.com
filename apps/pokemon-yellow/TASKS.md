# TASKS

Living checklist for the full conversion. `[x]` = implemented and covered by tests or verified in
the browser; `[ ]` = not done. Each phase must be completed fully (no stubs) before it is
checked off. Routine names refer to pret/pokeyellow.

## 1. ROM / disassembly pipeline
- [x] Reference tables from a pokeyellow build: ROM/RAM labels, text-bank labels, ~4,000 constants, music ids (`tools/gen-reference.ts`)
- [x] ROM loader with SHA-1 verification and a clear error for unsupported dumps
- [x] Text codec: charmap, control characters, the full text-command stream (nested TX_FAR calls with scoped DONE/PROMPT returns, `text_asm` markers, special text scripts)
- [x] Maps: headers, blocks, border, connections (offsets), warps, signs, objects (NPC/item/trainer/static Pokémon), text pointers, music
- [x] Toggleable object states
- [x] Tilesets: graphics, blocksets, collision lists, counters, grass, animation type, warp and door tiles
- [x] Movement tables: ledges, tile-pair collisions (land/water), water tilesets and shore tiles, cut-tree blocks, bookshelves, warp pads/holes, warp carpets, dungeon/escape-rope/bike tilesets, flower tiles
- [x] Overworld sprites (walking 6-frame and still 1-frame sheets)
- [x] SGB palettes and per-species palettes
- [x] Font, text-box and HP/status graphics
- [x] Species: base stats, types, catch rate, base exp, level-1 moves, growth rate, TM/HM bits, evolutions, learnsets; dex order; Pokédex entries
- [x] Moves, move names; items, prices, TM prices; type names and chart
- [x] Wild grass/water tables, slot chances, Old/Good/Super Rod data
- [x] Trainer classes: names, parties, base money, pic labels, AI move-choice modifiers
- [x] Node CLI (`npm run extract`) and browser Web Worker share one extractor
- [x] Pokémon front/back pics and trainer pics (Gen 1 sprite decompression, `UncompressSpriteData`)
- [x] Battle graphics: HUD tiles, party balls, substitute doll, transition data, party icons, Pokédex tiles, bold P
- [x] Battle animations (`src/rom/extract/battleAnims.ts`: `AttackAnimationPointers`, subanimations, frame blocks, base coords, the move animation tilesets, pic tilemaps, the special effects' tables)
- [x] Trade animation graphics and InternalClockTradeAnim (`src/movie/trade.ts`): Game Boys, scrolling BG/window text, circled party icons and ball travelling through the cable; ROM animation commands, cries and palettes; tested and browser-checked
- [x] Title screen, intro, credits, town map, Pokédex, party menu icons, badges, trainer card graphics (the intro and title run on a small PPU, `src/gb/ppu.ts`; `src/movie/intro.ts`, `src/ui/titleFlow.ts`)
- [x] Hidden events (`HiddenEventMaps`), `TextPredefs`, bookshelf tiles, hidden item/coin coords, bench guys, badge maps, Vermilion trash cans, Cinnabar gates, vending prices; mart inventories from the text scripts
- [x] Trade NPC data (`TradeMons`, the three dialog text sets, the OT name) (`src/rom/extract/trades.ts`)
- [x] Fly destinations, town map entries, the Town Map graphics (RLE map, cursor, arrow, nest icon, bird) (`src/rom/extract/townMap.ts`)
- [x] Trainer special moves (`SpecialTrainerMoves`), AI routine table, move grammar, battle effect lists, special warps, key items, TM moves
- [x] Pikachu data: happiness/mood tables, emotion scripts, picture animations (scripts, frame sets, tilemaps, graphics), PCM cries, `PikachuMovementDatabase`, sine table
- [x] Audio (`src/rom/extract/audio.ts`): the four audio engine banks whole (headers, channel command streams, noise instruments, wave samples), engine tables, `CryData`, `MoveSoundTable`, music banks, the rival/Cities1/Poké Flute alternate stream labels

## 2. Core state, saves, map loader
- [x] Deterministic `Store` (pure reducer, action log, replay, undo); RNG state lives in the game state
- [x] New-game initial state (Red's room 3,6; ¥3000; Potion in the PC) per `InitPlayerData`/`NewGameWarp`
- [x] Save files: versioned, checksummed, IndexedDB + localStorage fallback; round-trip and corruption tests
- [x] Bundle cache in IndexedDB (`derived-rom-data`), labelled as derived from the user's ROM, schema-versioned
- [x] `WorldMap`: blocks, connection strips, border blocks, collision tile (lower-left), per-owner tileset for cross-tileset connections
- [x] Gen 1 party/box struct binary serialization (`src/game/gen1.ts`: 44/33-byte structs, the 404-byte party and 1122-byte box lists with species lists and names); party export/import in the debug overlay; tested
- [x] Battle RNG port (`Random` every frame, `BattleRandom`) — deterministic emulation documented in DEVIATIONS.md
- [x] 12 PC boxes; CHANGE BOX saves the game (`ChangeBox`)
- [x] "Continue" screen with player stats (`displayContinueGameInfo` in `src/ui/titleFlow.ts`)

## 3. 3D overworld
- [x] Map mesh: tile quads, extruded solid squares with textured walls, water, ledges, counters, doors (manifest-driven)
- [x] Asset manifest covering every tile and sprite; `MissingAssetError` on unknown ids (tested across all maps)
- [x] Palettes chosen per `SetPal_Overworld`; color filters (GBC, vivid, pastel, dusk, night, sepia, DMG, Pocket, high contrast)
- [x] Water and flower tile animation (`UpdateMovingBgTiles`)
- [x] Billboard sprites with the original walk cycle and mirroring
- [x] Third-person smoothed follow camera; camera distance setting; reduced motion (snaps camera, instant fades)
- [x] Dithered cutaway when geometry hides the player
- [x] Grid movement at original speed (16 frames/square walk, 8 bike), Yellow's turn-in-place, ledge hops
- [x] Collision: passable tiles, tile pairs, objects, ledges (`CollisionCheckOnLand`, `HandleLedges`)
- [x] Warps: door/warp tiles, edge and carpet warps (`ExtraWarpCheck`), LAST_MAP, stepping out of doors
- [x] Map connections with a seamless camera hand-off
- [x] Connected maps with a different tileset rendered with their own tileset (Route 23 ↔ 22 / Indigo Plateau)
- [x] Dedicated low-poly models: trees, connected roof ridges, fences, signs, flowers, grass tufts, directional ledges, PCs, bookshelves, counters (`src/render/scenery.ts`, manifest-authored IDs); baked into the map's single atlas-backed mesh so filters/fades/cutaway and live block rebuilds still apply; tested and browser-checked
- [x] Map-specific transitions (`src/field/warpAnims.ts`): Fly's bird (FlyAnimationScreenCoords), Teleport/Escape Rope/Dig spins, warp pads, holes, dungeon warps; `HandleFlyWarpOrDungeonWarp`/`PrepareForSpecialWarp`; tested
- [x] Original fade palettes (FadePal1-8) for every fade: the fade hook selects a FadePal whose rBGP recolors the tile atlas, sky and text layer (PPU screens included) and whose rOBP0 recolors the sprite sheets; warps use PlayMapChangeSound's GBFadeOutToBlack (none in dark maps) and LoadGBPal's instant restore, MapEntryAfterBattle's GBFadeInFromWhite
- [x] Cutscene camera rails and transitions (`src/render/camera.ts`, `cutscenes.ts`): frame-deterministic tracking/reveal rails at Oak/starter/Pokédex/Champion/Hall-of-Fame milestones, S.S. Anne sailing, conservative tracking for other forced walks; smooth entry/exit, warp reset, seamless connection origins, disabled by reduced motion; tested and browser-checked
- [x] Dark caves (Rock Tunnel) and Flash (`wMapPalOffset` → FadePal2 remap of the map palette); tested
- [x] `CheckForceBikeOrSurf` (Cycling Road entrances, Seafoam currents → the maps' MOVE_OBJECT scripts), `ForceBikeDown` with the trainer-battle exception
- [x] Spinner tiles (Viridian Gym, Rocket Hideout B2F/B3F: `src/scripts/spinners.ts`, the arrow RLE slides, SpinnerPlayerFacingDirections, LoadSpinnerArrowTiles' alternating arrow graphics in the tile atlas) and Seafoam's current movement (the MOVE_OBJECT scripts); tested
- [x] Bicycle: bike sprite and music (`PlayDefaultMusicCommon`, `CheckForNoBikingMusicMap`), `DoBikeSpeedup` hill rule, forced riding on Cycling Road
- [x] Surf (`src/field/surf.ts`): item and field move, `IsSurfingAllowed`, `IsNextTileShoreOrWater`, `CollisionCheckOnWater` stepping off onto land, Seel / Surfing Pikachu sheets (wd472), surf music; tested
- [x] Fishing (`src/field/fishing.ts`): Old/Good/Super Rod with `ReadSuperRodData`, `FishingAnim` pose and rod sprite, bite shake and "!" bubble; tested
- [x] Strength boulders (`src/field/strength.ts`: `TryPushingBoulder`, `CheckForCollisionWhenPushingBoulder`, dust animation, BIT_STRENGTH_ACTIVE in wStatusFlags1, reset on map entry) and Cut (`src/field/cut.ts`: trees/grass, `CutTreeBlockSwaps`, tree/leaf animations); tested. Boulder holes are in the Seafoam/Victory Road scripts
- [x] `ApplyOutOfBattlePoisonDamage` after every step (`src/engine/poison.ts`): 1 HP every fourth step (`wStepCounter`), fainting text and Pikachu's PSNFNT happiness, the poison flash and sound, blackout; Day Care exp; Pikachu's walking happiness and mood drift; tested
- [x] Safari Zone step counter (`SafariZoneCheckSteps`), game-over PA and warp (`src/engine/safari.ts`), the gate's admission incl. Yellow's cut-price/free entry (`src/scripts/maps/SafariZoneGate.ts`), START-menu steps/balls box
- [x] Hidden events and bookshelves (`CheckForHiddenEventOrBookshelfOrCardKeyDoor`): PCs, hidden items/coins, posters, notebooks, blackboard, bench guys, statues, fossils, binoculars, Bill's Cell Separator, Vermilion trash cans, Cinnabar quiz gates, card-key doors (`src/engine/hiddenEvents.ts`); `ReplaceTileBlock` with live mesh rebuild
- [x] Hidden events owned by map ports: slot machines (Game Corner, `src/ui/slots.ts`), Pokémon Mansion switches (`ScriptRegistry.hidden`); Town Map display
- [x] Pikachu follower (`src/engine/pikachu.ts`): `SpawnPikachu_` with the follow command buffer, fast catch-up, ledge hops, idle animations, spawn placement after warps/connections/Pokémon Center, walk-through collision rule, sleeping Pikachu; scripted movement (`ApplyPikachuMovementData`); tested
- [x] Talking to Pikachu (`src/engine/pikachuEmotions.ts`): map-specific and mood/happiness emotions, emotion commands, the picture animation VM in its 5x5 window; tested
- [x] Pikachu: the ledge-hop shadow (LedgeHoppingShadow as a ground decal, also under the player's ledge jumps), grass priority for every sprite (the grass tile drawn over the lower half; the player's from `hTilePlayerStandingOn`, others while the player stands still), copying the player's frame while spinning

## 4. NPCs, dialogue, event scripting
- [x] Text engine port (`PlaceString`/`TextCommandProcessor`): letter delay by option, A/B speed-up, ▼ prompts, paragraphs, scrolling, RAM strings/numbers/BCD
- [x] GB tile-grid UI layer drawn with the ROM font; text boxes per `TextBoxBorder`
- [x] Signs, NPC text, talking across counters; NPCs turn to face the player
- [x] NPC movement: random walk within range, facing behavior, `UpdateNPCSprite`/`TryWalking` timing and RNG (`src/engine/sprites.ts`)
- [x] Script engine: coroutine OverworldLoop, per-map script state machines, MoveSprite, simulated joypad, NPC movement script tables, DisplayTextID/PrintText, text_asm handlers, emotion bubbles, pathfinding, YES/NO menu, naming screen
- [x] Port all map scripts and text_asm routines: 227 of 227 maps covered (`npx tsx tools/coverage.ts`). Most text_asm routines compile from the ROM (`src/rom/extract/simpleAsm.ts`, run by `src/engine/asmProgram.ts`); straight-line map scripts and standard trainer maps are recognised from their bytes; the rest are hand-ported in `src/scripts/maps/` (gyms incl. the Cinnabar quiz, Rocket Hideout, Pokémon Tower, Safari Zone gate, Pokémon Mansion, Silph Co., the Pokémon League and Hall of Fame, the link rooms, Pikachu's Beach, …).
- [x] Headless playthrough test from a new game to the Town Map (`tests/story.test.ts`)
- [x] Trainer line-of-sight engine, trainer headers (extracted), beaten flags, TalkToTrainer (`src/engine/trainers.ts`), tested on Viridian Forest
- [x] Item balls (`PickUpItemText`), `HideObject`/`ShowObject`, `GiveItem`, event-flag macros
- [x] Marts (BUY/SELL, `AddItemToInventory_` stacking), PCs (Bill's/someone's with WITHDRAW/DEPOSIT/RELEASE/CHANGE BOX/PRINT BOX, item PC, Oak's dex rating), vending machines (`src/ui/mart.ts`, `src/ui/pc.ts`); tested
- [x] Game Corner prize vendor (`src/ui/prizes.ts`); PKMN LEAGUE PC (`pkmnLeaguePC` in `src/ui/hallOfFame.ts`)
- [x] START menu with SAVE (info box, older-file check), OPTION (all five Yellow options) and EXIT; strings read from ROM
- [x] START menu POKéMON (party menu with icons, STATS pages, SWITCH, field-move menu with Strength/Flash/Dig/Teleport/Softboiled) and ITEM (bag list with SELECT swapping, USE/TOSS, quantity chooser); tested
- [x] START menu POKéDEX list with DATA/CRY/AREA/PRNT (`showPokedexMenu`) and the trainer card (`src/ui/trainerCard.ts`); field moves Cut/Fly/Surf
- [x] Name entry (player/rival/nicknames), Oak's intro speech with the default-name menus and pic slides, the title screen (on the PPU), the main menu and the clear-save dialogue (`src/ui/titleFlow.ts`)

- [x] Pokécenter nurse, item balls, Chansey, cable club (no-link path)

## 5. Battles
- [x] Battle state mirroring WRAM (`src/battle/state.ts`), StartBattle/MainInBattleLoop, turn order (Quick Attack/Counter priority, Speed ties by RNG), PP, switching, running (`TryRunningFromBattle`), Safari Zone loop
- [x] Damage formula (stat scaling, crit level doubling, 997 cap), crits by base Speed with the Focus Energy bug, random factor 217–255, STAB, type chart in order, 1/256 miss, Counter, Psywave/Seismic Toss/Super Fang
- [x] Stat stages, badge boosts and their reapplication quirk, Paralysis/Burn penalties
- [x] Every move effect in `MoveEffectPointerTable` (`src/battle/effects.ts`) with the original's quirks (Transform check, Substitute at 0 HP, Heal 255/511, Haze, Twineedle, Mist range, …)
- [x] Wild encounters (`TryDoWildEncounter`: per-frame hRandomAdd/Sub, grass/water/indoor rules, slot table, Repel), three-step cooldown, catching formula and shake count, Poké Doll, ghost battles
- [x] Trainer AI (move-choice layers 1–4, every class routine with items and switching), trainer parties with special moves, prize money, rival names
- [x] Experience (stat exp, traded/trainer boosts, Exp. All), level-up with stats box, learning moves (one per level), evolution with B to cancel, Pokédex seen/owned and the data page on first catch
- [x] Battle UI (HUDs, HP bar animation, battle/move/Mimic menus, SELECT move swapping), party menu with icons, STATS screens, bag list menu, all eight battle transitions
- [x] Item use in battle (`src/items/useItem.ts`): balls, medicine, X items, Guard Spec, Dire Hit, X Accuracy, Poké Flute, Poké Doll, Safari bait/rock, PP items; field items too (repels, vitamins, Rare Candy, stones, TMs/HMs, bicycle, coin case)
- [x] Blackout (`HandleBlackOut`: half money, heal, warp to the last Pokémon Center town), Pikachu happiness on faint/level-up/items
- [x] Tests: `tests/battle.test.ts` (formula, matchups, crits, accuracy, badge quirk, Heal quirk, running, capture, full wild battle); trainers and the playthrough run on the real engine
- [x] Battle animations (`src/battle/moveAnims.ts`): PlayAnimation's subanimations (SUBANIMTYPE transforms, FRAMEBLOCKMODE timing, OAM with flips and the SGB anim palette) and all special effects (pic slides/blinks/squish/bounce, Transform/Substitute/Minimize pictures, palette flashes, falling leaves and petals, water droplets, the wavy screen and enemy HUD shake on per-line scroll), AnimationIdSpecialEffects, GetMoveSound (cry moves too), TossBallAnimation with shakes, poof and the Ghost Marowak dodge; BATTLE ANIMATION: OFF keeps the 30-frame pause; tested
- [x] 3D battle stage (`src/render/BattleStage.ts`): ROM-pixel billboards and low-poly platforms above the intact GB panel, current pic tiles mirror send-outs/Transform/Substitute/fainting; frame-timed optional lunge, filters/fades, resource cleanup. SetPal_Battle / BlkPacket_Battle per-mon and HP-bar palettes, ChangeMonPic refresh, original party-species palette through Transform; tested and browser-checked at desktop/phone sizes
- [x] Scripted battles: Ghost Marowak, Snorlax, the legendary birds, Mewtwo, Jessie & James (`IsFightingJessieJames` pic); tested
- [x] PC boxes (Bill's PC)
- [x] Day Care (`src/scripts/maps/Daycare.ts`): deposit/withdraw, 1 exp per step with the $500000 cap, ¥100 per level + ¥100, moves learned on withdrawal (`WriteMonMoves` day-care mode), starter Pikachu cries; tested
- [ ] Link battles (Cable Club) — out of scope without a link partner; the battle engine has no link paths

## 6. Progression
- [x] Badges and HM field gating (Cut/Fly/Surf/Strength/Flash), badge stat boosts, obedience levels
- [x] Oak's aides (`OaksAideScript`: HM05, Itemfinder, Exp. All by Pokédex owned count); tested
- [x] Items: key items, Bicycle voucher flow, Silph Scope, Poké Flute, Card Key (incl. the bag-use bug), Lift Key, fossils, Oak's Parcel, Old Amber, Coin Case, Exp. All, Itemfinder, the Pokédex item
- [x] Story/progression audit from Pallet Town to Hall of Fame, plus post-game cave unlock/Mewtwo: continuous input campaign (`tests/campaign.test.ts`), 24 checkpoint/negative cases (`tests/progression.test.ts`), and real Victory Road push/drop route; fixed FAR-return/Lift Key, tutorial HP, trainer prize-money and ledge-input regressions. Exact QA scope/fixtures: `QA.md`
- [x] Hall of Fame and credits (`src/ui/hallOfFame.ts`: records in `state.hallOfFame`, player stats, credits roll with silhouettes and THE END, soft reset via `hooks.reset`)
- [x] Yellow-specific events: Pikachu happiness events, the four Jessie & James battles (Mt. Moon, Rocket Hideout, Pokémon Tower, Silph Co.), the three Kanto starters as gifts, Pikachu's Beach (the Surfing Pikachu minigame on a small PPU, `src/minigame/surfing.ts`, `src/gb/`)
- [x] Game Corner slots and prizes (`src/ui/slots.ts`, `src/ui/prizes.ts`)
- [x] In-game trades (`DoInGameTradeDialogue` in `src/scripts/events.ts`: all seven traders, trade flags, received-mon OT/ID/nickname, Kadabra/Graveler/Machoke/Haunter trade evolution); tested in `tests/facilities.test.ts`. The trade animation runs on the PPU (`InternalClockTradeAnim`), including for trade evolutions

## 7. Audio, polish, performance, QA
- [x] Music/SFX sequencer: the sound engine ported on a byte copy of the audio WRAM (`src/audio/soundEngine.ts`: UpdateMusic, the command set, pitch slides, vibrato, duty patterns, SFX priority, cries with pitch/tempo modifiers, fade-outs, the low health alarm), its register writes fed each frame to a DMG APU emulation (`src/audio/apu.ts`) in an AudioWorklet (`src/audio/apuWorklet.ts`, `output.ts`); `PlayDefaultMusic(FadeOutCurrent)` with bank handling, `StopMusic`, `WaitForSoundToFinish`/`PlaySoundWaitForCurrent` at the original call sites, `TextCommandSounds`; tested
- [x] Pokémon cries; Pikachu PCM samples (NR32 toggled every 180 cycles as timed APU writes while the game is frozen, as with interrupts off)
- [x] Web settings screen (`src/ui/webSettings.ts`, toolbar / F2): text speed, camera distance/pitch, keyboard remapping with conflict protection, color filters, reduced motion and volume; live preview, validated device-local preferences with legacy migration, native modal keyboard focus and game/audio pause; tested and browser-checked at desktop/phone sizes
- [x] Optional New Game mods (`src/game/mods.ts`, `src/ui/modPicker.ts`): Comfort (Exp. Share, HM field moves, hold-B run, type hints) and a seeded, tiered Randomizer; stored and validated in saves; unit-tested and browser-checked at desktop/phone sizes
- [x] Texture packs / world looks (`src/render/themes/`): material-tagged map geometry, ramp + procedural surface shader, sun/sky lighting with baked contact shadows and a once-per-map shadow map, sky dome, weather, snow, night lighting, final pass; Remastered and more packs; QA via `tools/theme-qa.ts`
- [x] Mobile: responsive portrait/landscape UI, optional persisted haptics, multi-pointer ownership/drag/cancellation, safe-area controls/settings/battle panel; Chrome touch checks with real CSS inset overrides (`tools/browser-qa.ts`). Phone DPR 1.5 / margin 4 quality tier and atlas-merged scenery keep draw/resource budgets bounded (`src/render/quality.ts`, `tests/performance.test.ts`)
- [x] 60 FPS desktop audit and phone-viewport profiling (`tools/profile.ts`): town/forest/battle on each tier, scene validation, CPU/frame/resource metrics and failing budget checks; all six pass on Apple M5 Max / Chrome 155. Phone runs emulate viewport/DPR/touch, **not physical phone GPUs**; see `QA.md`
- [x] Debug overlay: validated real encounters, undoable/destructive story and cutscene presets, pause/frame stepping, bounded next-map-script-state stepping, 200-entry map/text/ASM trace, performance diagnostics; reload/warp cancels old coroutines and presentation/audio state (`src/dev/presets.ts`, `tests/debug.test.ts`)
- [x] Automated new-game-to-credits input route (`tests/campaign.test.ts`, fixed seed): 678,357 frames through all required quests, puzzles, badges, League, Hall of Fame save and credits. Explicit post-Pokédex combat/healing fixture and disabled random encounters; **no checkpoint transport or quest/badge/puzzle/position writes**. RLE input and flag-write report saved locally; see `QA.md`
- [x] Progression-flag tests: ordered real-battle badges/rewards, no duplicate rewards, loss/full-bag negatives, causal key-item chains, badge guards, cave unlock and post-game Mewtwo (`tests/progression.test.ts`); full input campaign additionally records all event-flag writes

## 8. Accounts / hosted-data milestone (local implementation)

- [x] Traditional individual Better Auth email/password accounts on Workers/D1, verified email and password recovery
- [x] Guest-first play and local SAVE, optional dismissible login suggestion, explicit guest import and separate account queues
- [x] Durable offline queue, revision CAS, idempotent retries, explicit conflict selection
- [x] Bounded recovery history, revisioned clear-slot tombstones, one active tab/account/browser
- [x] Operator asset preparation, versioned/integrity-checked downloads, no player ROM picker
- [x] Production offline app shell; existing SAVE/PC/Hall of Fame entry points use account backend
- [x] Real native SQLite transaction tests, real local workerd/D1 Better Auth API tests, production browser QA using actual SAVE inputs
- [x] One-command local D1 migrations/Vite/Worker startup and development email inbox, no Docker/cloud tenant
- [x] Operator deployment/auth/asset/legal instructions in `DEPLOYMENT.md`

Monorepo hosting uses one production Worker/D1 and Postmark, with no staging/previews;
see `DEPLOYMENT.md`. Backups/restore operations, privacy/age/account-deletion procedures,
abuse/quotas/monitoring and physical-device checks remain operator responsibilities,
not claims of completion.
Player-to-player trading is deferred; existing NPC trades are not network trading.

## Notes
- Current validation: **254 tests / 39 suites**, typecheck, production build, Worker packaging dry-run and real production-browser/Better Auth/D1 QA pass; 227/227 maps have script coverage. The single-player baseline had 203 tests / 30 suites. Browser/render audit scope and physical-device limitations are documented in `QA.md`.
- Elevator warps (Silph Co.) target a placeholder map that the elevator script rewrites at runtime; the integrity test lists them explicitly.
