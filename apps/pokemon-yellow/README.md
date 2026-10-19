# Pokémon Yellow 3D (web)

An unofficial, from-scratch 3D reimplementation of **Pokémon Yellow** that runs in the browser
with Three.js. Play immediately as a guest and save locally; optionally sign in for separate
cloud saves, cross-device conflict handling and recovery. Operator-provided game data downloads
automatically, with offline reopening after setup.
**Players never need to upload a ROM.** Source control contains no ROM or extracted game assets.

Game logic follows the [pret/pokeyellow](https://github.com/pret/pokeyellow) disassembly. Where a
routine has been ported, the source comment names the original routine (e.g. `CollisionCheckOnLand`
in `home/overworld.asm`).

> Status: single-player game plus guest saves, Better Auth accounts, a Workers/D1 backend and hosted-data delivery.
> Production target: **https://pokemon-yellow.jonaylor.com** (one environment, no previews).
> See [DEPLOYMENT.md](DEPLOYMENT.md) for setup and operational launch gates,
> [QA.md](QA.md) for test scope, and [DEVIATIONS.md](DEVIATIONS.md) for differences.
> Player-to-player trading is deferred; existing NPC trades are unrelated. Link battles are unavailable.

## Legal notice

Pokémon is © Nintendo / Creatures Inc. / GAME FREAK inc. This project is not affiliated with or
endorsed by them. Hosted distribution requires authorization for all included assets/data and
offline downloads. The operator has stated they hold these rights; this repository grants none.
Authentication alone does not resolve redistribution rights.

ROMs and extracted assets remain excluded from source control. An authorized release build can
include operator-prepared assets from ignored `public/game-data/`; never commit those files or
the ROM. Supply the appropriate distribution notice when preparing a release; see [DEPLOYMENT.md](DEPLOYMENT.md).

CI downloads the SHA-256-pinned public release in `assets.release.json`; no ROM or email
credential is required to build. See `tools/fetch-assets.ts` and the deployment guide.

The only Game Freak–derived material in the source repository is `src/rom/generated/*.json`, which
holds **label names, addresses and constant names/values** from the open pret disassembly. The
extractor uses these to locate data inside your ROM.

## Requirements

- Node.js 22.13+ (developed on Node 24); no Docker or cloud login required locally
- A modern browser with WebGL and IndexedDB (desktop Chrome/Firefox/Safari, or mobile Safari/Chrome)
- Operator extraction/developer tests use **Pokémon Yellow Version (USA, Europe)**, SHA-1 `cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1`.
  Other revisions and languages are rejected with an explanatory message.

## Quick start

```sh
# From the monorepo root; pnpm 10.32.1 (see root packageManager).
pnpm install --frozen-lockfile
pnpm --filter pokemon-yellow assets:fetch
pnpm --filter pokemon-yellow dev  # game :5173, Worker/local SQLite :8787, inbox /__dev/mail
```

Open **http://localhost:5173** and play—no login screen. SAVE works locally and offers optional
sign-in for cloud backup. The command applies migrations to local D1 and runs the real Better Auth
backend; verification/reset emails go to **http://localhost:5173/__dev/mail**. Local data persists
under ignored `.wrangler/state/local/`. No remote resources are created. See [DEPLOYMENT.md](DEPLOYMENT.md).

### Home screen

The browser opens directly to a Pokémon-style menu over a quiet 3D Pallet Town scene:
**Continue** (when a checkpoint exists), **New Game**, **Settings**, and optional **Account**.
Continue shows your trainer, location, badges and play time and resumes in one action.
Settings and accessibility are available before play; F2 and WEB SETTINGS remain available in-game.
Keyboard remapping, standard gamepad navigation and touch work on the home screen.

New Game defaults to keeping an existing adventure. Confirmation offers a checkpoint export and
preserves a recovery copy before starting Oak's introduction. The existing slot is not replaced
until START → SAVE in the new adventure; restore the previous adventure via Account → Recovery
history. Guest recovery stays local and separate from account saves. Offline status is explicit;
local play never requires signing in or picking a ROM.

### Build

```sh
pnpm --filter pokemon-yellow build    # type-checks, then writes app dist/
pnpm --filter pokemon-yellow preview  # built app + local Worker/D1 on :8787
```

`dist/` is static. A Cloudflare Worker runs Better Auth and the save API, with D1 (SQLite) for
accounts/sessions/checkpoints. Preview uses the local backend and mail inbox. HTTPS, Worker secrets,
a real D1 binding and production email delivery are needed for deployment. Details: [DEPLOYMENT.md](DEPLOYMENT.md).

### Tests

```sh
pnpm --filter pokemon-yellow test      # actual local Worker/D1 auth and native SQLite
pnpm --filter pokemon-yellow qa:cloud  # production browser + local backend; needs Chrome
```

ROM-dependent tests (map loading, warp integrity, encounter tables, extraction values, manifest
coverage) read your ROM from `roms/pokeyellow.gbc`, or from the `PYW_ROM` environment variable. If
no ROM is present they are skipped. ROM-independent tests (state store, save/load round-trips,
IndexedDB persistence, charmap) always run. The continuous campaign uses a declared combat
fixture, not checkpoint transport or quest-flag writes; see [QA.md](QA.md) for the distinction
between that route and the isolated progression tests.

## Asset extraction pipeline

```
authorized operator ROM ──► prepare:assets ──► versioned manifest + GameBundle JSON
                                                   │
                                           static host / CDN
                                                   │
                                       automatic browser download
                                                   │
                                            IndexedDB cache
```

- `src/rom/extract/` runs in Node for releases/tests; a developer-only worker path remains for automation.
- `npm run extract -- roms/pokeyellow.gbc` writes `extracted/bundle.json` for inspection (git-ignored).
- `npm run dump-gfx` renders the extracted tilesets, some maps and sprites to PNGs in `extracted/gfx/`.
- The schema lives in `src/data/schema.ts` (currently **57**). After a shape change, bump it and
  prepare a matching hosted release; stale/missing player caches download data, never request a ROM.

Currently extracted: all 227 map headers (blocks, borders, connections, warps, signs, objects,
text pointers, music), toggleable object states, 25 tilesets (graphics, blocksets, collision,
counters, grass, animation, warp/door tiles), the movement tables (ledges, tile-pair collisions,
water, cut trees, bookshelves, warp pads/holes, carpets, flower animation), 89 sprite
sheets (including field poses), SGB palettes and per-species palettes, the font and text-box graphics, 151 species (base
stats, types, learnsets, evolutions, TM/HM compatibility), Pokédex entries, 165 moves, items and
prices, the type chart, wild grass/water tables, all three fishing rods, 47 trainer classes with
parties, prize money and AI modifiers, and the game's text streams (5,800+ decoded label
entries, including script-local labels). FAR calls retain their nested return scopes.

### Regenerating the reference tables (maintainers only)

```sh
git clone https://github.com/pret/pokeyellow && (cd pokeyellow && make)   # needs rgbds 1.0.x
npm run gen:reference -- /path/to/pokeyellow
```

## Controls

| Game Boy | Keyboard | Gamepad (standard) | Touch |
|---|---|---|---|
| D-pad | Arrow keys / WASD | D-pad / left stick | on-screen pad |
| A | Z, J, Space | A (bottom) | A |
| B | X, K, Backspace | B (right), X (left) | B |
| START | Enter | Start | START |
| SELECT | Shift | Back/Select | SELECT |

Extra keys: `+` / `-` change the camera distance; `` ` `` (backquote) toggles the debug overlay.
Touch controls appear automatically on touch devices.

Use **WEB SETTINGS** (top left) or **F2** for text speed, camera distance/pitch, keyboard
remapping, color filters, world looks (texture packs), reduced motion and volume. The panel pauses game frames and audio.
Web preferences are saved on this device; text speed is kept with normal game saves.

**NEW GAME** offers optional mods, kept with that save: **Comfort** (party Exp. Share, HM field
moves without teaching them, hold B to run, type-effectiveness hints) and a seeded
**Randomizer** for wild Pokémon and trainer teams. Comfort can be switched later in WEB SETTINGS;
the Randomizer is locked for that save. See [DEVIATIONS.md](DEVIATIONS.md#optional-mods).
In dev builds, `?new&mods=comfort,randomizer:SEED` starts a modded game directly.
Optional touch haptics are off by default and ignored on browsers without vibration support.
Touch input supports multiple fingers, drag re-entry, cancellation and safe-area insets.

## Saves

Save with **START → SAVE**—no account required. Guests use `guest:slot1` in IndexedDB with a
guest-scoped localStorage mirror. An optional, dismissible sign-in suggestion appears after saving.
An old unscoped `slot1` is copied once into the guest slot and retained as a legacy recovery copy.

Account mode commits a checkpoint and pending-sync record to
IndexedDB under `account:USER_ID:slot1`, then syncs through an authenticated, revision-checked API.
Concurrent/offline progress requires an explicit conflict choice, not last-write-wins or merging.
ACCOUNT shows sync status, recovery history, sign-out and checkpoint export.

Sign-in offers an explicit guest-checkpoint import; existing account progress is never silently
overwritten. Signing out returns to the separate guest slot and retains account queues.
Offline reopening requires an initial download, not guest registration. Browser data clearing/eviction
can lose guest or unsynced progress. FNV-1a checksums detect corruption, not cheating; the game
remains client-run. Use the production preview to test offline reloads. Details: [DEPLOYMENT.md](DEPLOYMENT.md).

## Debugging

- In development, `` ` `` opens the debug overlay: warp, flags/items, real encounter spawning, undoable story
  and cutscene fixtures, pause/frame stepping, bounded next-script-state stepping, trace,
  performance/resource budgets, state/party export, save/load, and cache reset.
  Story/cutscene presets replace the current game state; they are debug fixtures, not progress earned in play.
- Dev server URL parameters: `?map=PALLET_TOWN&x=5&y=6` starts at a location;
  `?rom=/roms/pokeyellow.gbc` (dev builds only) loads a ROM from the dev server for automation;
  `?new=1&seed=7&party=CHARMANDER:20,PIDGEY:5` starts a fresh game with a fixed RNG seed and a debug party.
- `npm run smoke -- "<query>" "<keys>" out.png` drives a headless Chrome against the dev server,
  pressing keys and taking a screenshot (set `CHROME` to your Chrome binary if it's not in the default macOS location).
- In development, `window.pyw` exposes `{ bundle, store, view, engine, input, audio }` in the console.

## Architecture

```
src/
  rom/          ROM access, symbol tables, text codec, extractors (+ worker)
  data/         bundle schema, IndexedDB helpers, bundle cache
  game/         deterministic state store (actions, replay, undo) and save files
  world/        map model (connections, borders, collision tiles) and movement rules
  engine/       the overworld frame loop (movement, warps, scripts, trainers, wild encounters)
  battle/       battle engine: core loop, moves, effects, AI, experience, menus, UI, transitions
  items/        item use (UseItem)
  render/       Three.js view, map meshes, sprites, palettes, tile animation, asset manifest
  cloud/        Better Auth client, guest/account persistence, sync transport, offline shell
  ui/           account/conflict dialogs, hosted-data boot, GB UI, text engine, debug overlay
  input/        keyboard / gamepad / touch → GB buttons
worker/         Better Auth, email transport, session/Origin/ownership checks, save API
migrations/     SQLite auth/save schema and atomic save triggers
wrangler.jsonc  Worker/static-assets/D1 bindings; separate local configuration
tools/          local dev/backend harness, real browser QA, extraction and game tools
tests/          vitest suites
```

- **Deterministic state:** `GameState` is plain JSON. All changes are `Action`s applied by a pure
  reducer, so replaying the action log from a snapshot reproduces the state exactly (tested).
- **Frame-accurate logic:** gameplay advances in emulated Game Boy frames (59.73 Hz) independent of
  the display rate, so walking speed (16 frames per square), text delays and animation timing match
  the original.
- **Asset manifest:** `src/render/manifest.ts` maps every tileset tile and sprite id to a 3D
  representation. Asking for an id that is not in the manifest throws `MissingAssetError`, and a
  test checks that every tile and sprite used by every map resolves.

## Validation and remaining limits

- All 227 maps have script coverage. The input-driven campaign reaches credits; checkpoint
  tests additionally cover post-game Mewtwo, failure paths and deferred rewards.
- Chrome touch/safe-area checks and desktop/phone-viewport rendering audits are reproducible
  with `tools/browser-qa.ts` and `tools/profile.ts` against the dev server.
- Emulated phone viewports are **not** physical-phone performance verification. Optional
  branches are not exhaustively emulator-diffed. See [QA.md](QA.md) for the exact scope.
- Link battles have no link-partner implementation and remain explicitly out of scope.

The full checklist is [TASKS.md](TASKS.md).
