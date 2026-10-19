# Handoff: Pokémon Yellow 3D web port

## Current milestone: accounts, cloud saves, no-upload boot

The user explicitly requested replacing the earlier backend with **Better Auth + Workers + D1**
and optional guest play. The managed-auth requirement has been superseded by self-hosted
Better Auth. Ordinary independent accounts; no family/child profiles. Trading is deferred.
The operator stated they hold the necessary asset-distribution rights.

Implemented: guest-first boot and local SAVE, optional sign-in suggested after SAVE, email/password
verification/recovery through real Better Auth, same-origin HttpOnly sessions, account-owned saves,
durable offline queues, revision/UUID HTTP sync, explicit import/conflict choices and recovery.
D1 SQLite triggers make each save/head/history/receipt/pruning operation one atomic statement.
The old dependency, Postgres migration and fake provider/browser fixture have been removed.
The ignored old Cloudflare/family draft was NOT applied.

**Read `DEPLOYMENT.md`** for actual local startup, architecture, deployment and remaining gates.
`npm run dev` migrates local D1, starts Vite :5173 and Wrangler :8787; the real local email inbox is
`http://localhost:5173/__dev/mail`. No Docker or external auth tenant is required. Use localhost
consistently. `npm run build && npm run preview` serves the built frontend with real local auth/API
on :8787. Persistent local backend state is ignored under `.wrangler/state/local/`.

Schema stays **57**; no game-bundle change in this migration. Authorized prepared assets remain
ignored in `public/game-data/`; the local QA notice is a fixture, not a production notice.
Production auth fails closed without secrets/email configuration, but guest play remains available.

Tests include native SQLite trigger rollback/retention and real isolated workerd/D1 auth/API flows.
The production browser QA now drives intro/name menus and actual START → SAVE on two browser
profiles, with no intercepted APIs, IndexedDB save injection or private game globals.
It covers guest saves, verification/import, offline reload/conflicts/recovery, account separation,
password reset/logout and tab locks. Final validation: **254 tests / 39 suites**, typecheck,
production build, Worker packaging dry-run and real browser/backend QA pass; map coverage 227/227. It also caught/fixed Cloudflare's /index.html redirect breaking
cached navigation. See `QA.md` for final validation totals and remaining audit/physical-device limits.

That validation describes the original standalone implementation. The app has since been
imported into this pnpm monorepo; use `DEPLOYMENT.md` for the current single-production
Worker/D1/Postmark setup and automatic deployment instructions.

The single-player history below describes the baseline; its old runtime-ROM and test-count
statements are historical, not the new hosted startup behavior.

This is a working handoff for the next coding-agent session. Read it together with `TASKS.md`, which is the source of truth for what's done and what's left, `DEVIATIONS.md` (known differences from the original) and `README.md`.

## The project

- The game is a TypeScript + three.js port of Pokémon Yellow. The original baseline extracted data at runtime from the user's own ROM (`roms/pokeyellow.gbc`, never committed). Logic is ported routine by routine from the pret disassembly (pret/pokeyellow), and the code comments name the original routines (`; GBFadeOutToBlack`, `MoveAnimation`, ...).
- **Standing directive from the user:** keep working through every unchecked item in `TASKS.md` until all are complete.
- **Faithfulness is the bar.** Port the asm behavior, including its quirks and bugs, and note any unavoidable difference in `DEVIATIONS.md`.
- **Commit only when the user asks.** The single-player baseline is `78622f4045b2`; the accounts/cloud-save milestone and single-production monorepo deployment are approved. Preserve unrelated Android work.

## Environment gotchas (important)

- The shell's `node`/`npx` wrappers are broken, so always use the full path:
  ```sh
  N=~/.nvm/versions/node/v24.21.0/bin/node
  $N node_modules/typescript/bin/tsc --noEmit -p .                 # typecheck
  $N node_modules/vitest/vitest.mjs run [file] [-t name]           # tests (~100 s including the campaign)
  $N node_modules/tsx/dist/cli.mjs tools/extract.ts roms/pokeyellow.gbc   # re-extract bundle
  $N node_modules/tsx/dist/cli.mjs tools/dev.ts                   # Vite + local Worker/D1
  ```
- **After any extractor or schema change:** bump `SCHEMA_VERSION` in `src/data/schema.ts` (currently **57**) and re-run the extract. The browser caches bundles by version.
- **Disassembly:** `/Users/johannes/.cache/checkouts/github.com/pret/pokeyellow`. Symbols and constants are generated into `src/rom/generated/{symbols,constants}.json`.
- **Symbols and constants in code:**
  - `sym(label)` gives the flat ROM offset and `symBank(label)` the bank.
  - `c(group, NAME)` reads constants. Groups include `move`, `move_animation`, `music`, `pokemon`, `item`, `map`, `event`, `palette`.
  - `ramSym(label)` gives WRAM addresses.
- **Tests and the frame loop:** tests run frames synchronously, so IndexedDB promises don't resolve mid-loop. Use `await new Promise(r => setTimeout(r, 100))` when needed. To stub battles: `(h.engine as {battleHost:unknown}).battleHost = {*run(){return 'win'}}`.
- **Puppeteer and the dev server:** puppeteer (Chrome at `/Applications/Google Chrome.app`) works for visual checks; scripts are listed in the last section. **Editing `src/` while a puppeteer run is in progress makes Vite reload the page and ruins the run.**
- **Headless audio:** headless Chrome has no audio sink (the AudioContext clock doesn't advance). To verify audio there, use an `OfflineAudioContext`.
- **Python edits:** when editing files with Python scripts, `assert old in s` before each replace.

## Architecture cheat-sheet

| Area | Files |
|---|---|
| Engine and frame loop, RAM, hooks, sound integration | `src/engine/Engine.ts`, `ScriptEnv.ts` |
| Tile-grid UI layer (text, menus, battle screen) | `src/ui/TileScreen.ts` |
| Emulated PPU for full-screen sequences (intro, title, surfing) | `src/gb/ppu.ts`, `src/gb/hardware.ts` (`GbHardware`), `animatedObjects.ts` |
| 3D overworld | `src/render/OverworldView.ts`, `syncView.ts`, `textures.ts`, `palette.ts`, `SpriteActor.ts` |
| Battle | `src/battle/Battle.ts`, `BattleUI.ts`, `moveAnims.ts` (new), `animation.ts` |
| Audio (new) | `src/audio/soundEngine.ts` (sound engine on a WRAM byte copy), `apu.ts`, `apuWorklet.ts`, `output.ts` |
| Extraction | `src/rom/extract/*.ts` → `GameBundle` (`src/data/schema.ts`) |
| Map scripts | `src/scripts/maps/*.ts`, registered in `src/scripts/index.ts` |

**The TileScreen cell model:**
- A cell holds a glyph code. Codes below `0x100` are the font and HUD tiles.
- Codes `0x100+` are glyph overrides: enemy pic `0x100+`, player pic `0x200+` (both row-major), animation OBJ tiles `0x400+`.
- `MoveAnimator.idToCode`/`codeToId` convert between the original column-major VRAM tile IDs and these codes.

## Done in the last session (all tests passing; 138 at the last full run)

- **Audio, complete:**
  - A faithful sound-engine port and a DMG APU in an AudioWorklet.
  - Cries, Pikachu PCM (timed NR32 writes while the game is frozen), music banks and fades, and the low-HP alarm.
  - `WaitForSoundToFinish` / `PlaySoundWaitForCurrent` at the original call sites, and `TextCommandSounds`.
  - Tests: `tests/audio.test.ts`.
- **FadePal fades:**
  - Palette remaps replace the old overlay (`view.setFadePal` / `setPaletteRemap`, `TileScreen.setFadeMap`).
  - Warps fade out via GBFadeOutToBlack and restore instantly. MapEntryAfterBattle fades in from white.
  - New `hooks.bgp` hook, used for the poison flash (rBGP xor $FF).
- **Smaller items:**
  - Gen 1 struct serialization: `src/game/gen1.ts`, with party export/import in the debug overlay and `tests/gen1.test.ts`.
  - Spinner arrow-tile animation.
  - Ledge-hop shadow decal, grass-priority overlay for sprites, and Pikachu copying the player's frame while spinning.
- **Battle animations, complete:**
  - `src/rom/extract/battleAnims.ts` → `bundle.battleAnims`, played by `src/battle/moveAnims.ts` (`MoveAnimator`, reached via `Battle.anim`).
  - All subanimations, special effects and TossBallAnimation. Tests: `tests/battleAnims.test.ts`.
  - TileScreen objects now support flips and an `obp` palette, plus per-line `setLineScroll`.
  - The SGB anim palette $F0 makes light-gray anim pixels white. This is faithful, not a bug.

## Completed after this handoff

- **Trade animation:** `src/movie/trade.ts` ports InternalClockTradeFuncSequence on the PPU:
  BG/window scrolling, the Game Boys/cable, OAM party icons, ball animations via MoveAnimator,
  mon/OT info, ROM texts, cries and sound waits. The received OT ID is generated before the
  movie, matching InGameTrade_PrepareTradeData. TileScreen.glyphIndices exposes raw pixels.
  LoadHpBarAndStatusTilePatterns is required for the ID/No. glyphs (the initial plan missed it).
  Tests: `tests/trade.test.ts`; the real NPC trade and trade evolution tests include the movie.
  Browser snapshots/check scripts are in ignored `extracted/`.
- **Dedicated scenery:** `src/render/scenery.ts` emits low-poly trees, roof ridges, fences,
  signs, flowers, grass tufts, directional ledges, PCs, bookshelves and counters.
  `manifest.ts` maps authored ROM tile IDs; `MapMesh.ts` bakes everything into the existing
  atlas-backed mesh, keeping fades/filters/cutaway and block rebuilds. Connected roof tiles
  share a ridge. Flower selection uses all four tiles of a square.
  Tests: `tests/scenery.test.ts`; browser-checked Pallet Town, Route 2 and Red's house.
  Beware: OVERWORLD $3A is a small tree, **not** a sign; Pallet signs are $56.
- **Camera rails:** `src/render/camera.ts` is a frame-deterministic director with entry/return
  blends. `cutscenes.ts` observes script milestones for Oak/starter/Pokédex, Champion/Hall of
  Fame, S.S. Anne, and other forced walks without adding waits or RNG calls. Hidden subjects
  are ignored, reduced motion disables rails, warps reset framing and connections translate it.
  Tests: `tests/camera.test.ts`; Chrome check: ignored `extracted/check-presentation.mjs`.
- **Battle presentation:** `src/render/BattleStage.ts` mirrors the GB pic tiles into two
  billboards over low-poly platforms above a compact, intact GB panel. It follows the pics'
  Transform/Substitute/fainting state and screen palettes/fades; move lunges respect reduced
  motion. Stage activation is `hooks.battleScene` (after the full-screen transition).
  `src/battle/palettes.ts` ports SetPal_Battle/BlkPacket_Battle; HP colors use thresholds
  **27 and 10 pixels**, not 24. ChangeMonPic refreshes palettes. Transform retains the original
  party species palette, as in the asm. Objects now use SGB cell attributes, not always pal 0.
  Tests: `tests/battlePresentation.test.ts`; Chrome desktop/phone screenshots and manual-frame
  driver: `extracted/check-battle-stage.mjs`.
- **Web settings:** `src/ui/webSettings.ts`, toolbar/F2, native modal with game/audio pause.
  Text speed edits the saved game option; camera/filter/motion/keymap/volume use validated,
  device-local `pokeyellow-web:web-settings` preferences (old view settings migrate).
  `attachView` now returns a callable `ViewSync` with `refreshSettings()` to recolor atlases
  and restore the current UI palette layout live. Input is suspended/cleared while open and
  held gamepad buttons must be released before resuming. AudioOutput tracks desired suspension
  even during its async first-gesture initialization.
  Tests: `tests/webSettings.test.ts`; `extracted/check-settings.mjs` checks pause, persistence,
  remap conflicts/Escape/focus, desktop/phone layout and real CDP touch scrolling.
- Final validation: typecheck, all 162 tests, and the production build passed.

## Completion audit (current)

All feasible single-player checklist items are complete. **Only link battles remain unchecked**, explicitly out of scope without a link partner. No commits were created during implementation; the user subsequently requested a commit of this finished local-save baseline.

- `tests/campaign.test.ts` / `routeDriver.ts`: fresh-game input route through credits, 678,357 frames, fixed seed. Post-Pokédex combat/healing fixture is explicit; no checkpoint transport, quest/badge/puzzle/position writes or battle-cursor injection. HMs/badges are earned, field moves/healing/bag management use menus. Real Strength push-state search executes the Victory Road switches and floor drop. Wild random encounters are disabled; scripted battles are real.
- `tests/progression.test.ts`: 24 checkpoint/negative cases, including cave unlock/Mewtwo, full-bag retry, losses, duplicate rewards, story chains and Route 23 guards. `tests/strengthRoute.test.ts` separately drives the full Victory Road puzzle route.
- Four regressions fixed against assembly: nested FAR processor return scopes (Lift Key and later commands), no uninitialized player-mon HP flush in tutorial/Safari battles, two-byte BCD trainer base money (Brock ¥1188), and ledge input ownership/landing cleanup restoring collision.
- Schema **56**, re-extracted. `TextOp.far` preserves call scopes; `walkTextOps` and `withoutTextAsm` recurse for inspection/intentional stripping. Missing nested ASM handlers still reach the unported hook.
- Mobile input/haptics/safe-area layouts and phone quality tier completed. `tools/browser-qa.ts` passes portrait/landscape with Chrome's native CSS safe-area overrides, multi-touch, drag/re-entry, cancellation, haptic dispatch and no battle/control overlap. Its experimental CDP command is newer than bundled typings, with a targeted `@ts-expect-error`.
- `tools/profile.ts`: six desktop/emulated-phone town/forest/battle scenarios pass on Chrome 155 / Apple M5 Max, ~60 FPS, p95 <=16.8 ms; maximum 7 draw calls, 37,936 triangles, 7 geometries, 6 textures. **Not physical-phone GPU verification.**
- Debug encounters, destructive/undoable story/cutscene presets, bounded script/frame stepping, trace and profiler complete (`src/dev/presets.ts`, `src/ui/debug.ts`, `tests/debug.test.ts`).
- Final validation: **203 tests / 30 suites**, typecheck, production build; **227/227** map-script coverage. See `QA.md` for reproducible commands, fixture boundaries and remaining verification limits.

Ignored artifacts: `extracted/campaign-latest.json` (initial state, explicit fixture, RLE inputs, milestone frames, 9,764 event writes / 258 distinct flags), `final-tests.log`, `performance.json`, `profile.log`, `browser-qa.log`, and mobile screenshots. Debug/resume scripts under `extracted/` were diagnostic only; the repository's campaign test always starts fresh. Do not redistribute these ROM-derived artifacts.

Physical iOS/Android GPU/thermal/vibration checks and exhaustive emulator-diffing of every optional branch are not claimed; they are external verification limits, not unfinished single-player implementations.

## Useful snippets for browser checks

- **Start a wild battle from page JS:**
  ```js
  pyw.engine.ram.curOpponent = 36; // internal species ID; 36 = Pidgey
  pyw.engine.ram.curEnemyLevel = 5;
  ```
  The overworld loop then starts the battle. Use `?new&map=ROUTE_1&x=10&y=20&party=CHARMANDER:10` (party is dev-only).
- **Development globals only:** `window.pyw = { bundle, store, view, engine, input, audio }`. Debug overlay and URL position/party/seed overrides are excluded from production behavior.
- **Scripts:** the last session's puppeteer scripts lived in its scratchpad (`banim.mts`, `fade.mts`, `grass.mts`, `audio2.mts`). Rewrite them as needed. In key bindings Z = A, X = B, Enter = Start.
