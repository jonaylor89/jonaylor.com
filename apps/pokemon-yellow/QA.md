# Validation and QA

## Browser home screen

Pre-publication validation after rebasing onto the current main: **323 tests / 47 suites** pass
with `PYW_ROM` set; all **11** monorepo build tasks and root lint/format checks pass. Existing
world themes and optional New Game rules remain intact.

Run `pnpm --filter pokemon-yellow dev:ui`, then from this app run
`pnpm exec tsx tools/title-browser-qa.ts`. This guest-only UI smoke uses hosted data and mocked
session lookup (no ROM or backend). Desktop 1440×900, portrait 390×844, landscape 844×390 and
small-phone 320×568 checks cover first/returning menus, paused play time, Settings/F2, focus return,
remapped confirmation keys, standard gamepad navigation, offline status, safe overwrite cancellation,
storage-failure refusal, recovery copies, and one-action Continue. Screenshots use a temporary
directory removed on exit; `PYW_QA_DIR` optionally retains them for visual review.

`homeScreen.test.ts`, `guestSaves.test.ts` and `cloudSaves.test.ts` cover checkpoint summaries,
status accuracy, shared gamepad mapping, persistent new-adventure backups and conflict guards.
The real-backend `qa:cloud` harness also passed with the new home screen: actual guest SAVE,
registration/verification/import, two-device account saves, offline reload, conflicts/recovery,
account isolation, password reset, logout, tab locks and uncached APIs. The browser/Oak transition
is also regression-tested alongside the legacy boot in `menus.test.ts`.

## Accounts / hosted-data milestone

Current validation: **254 tests / 39 suites**, typecheck, production build, Worker deployment
**dry-run only**, real production-browser/backend QA, and **227/227** map-script coverage pass.
The local dev command's startup/restart with custom ports, Vite proxy and inbox was also checked.
No remote resources were created or deployed.

See `DEPLOYMENT.md` for reproducible local Worker/D1 setup and production-browser QA.
The persistence suites cover guest saves without auth/network, legacy guest migration,
account isolation, durable queues, new-save/old-ack races, idempotent retry, tombstones,
recovery bounds, failed writes, expected-account guards, structural validation and asset integrity.

`tests/cloudSql.test.ts` now uses Node's real SQLite with the same D1 migration and triggers:
exact payload preservation, revision checks, rollback on a failed history write, rate/retention
limits, ownership scoping and deletion cascades. It needs no Docker.

`tests/backend.test.ts` starts a real isolated local workerd/D1 backend. It registers and verifies
synthetic accounts through Better Auth/local email, uses real HttpOnly cookies, and checks Origin/
session/account boundaries, concurrent save transactions, retries, deletion, password reset/replay
and session revocation. It is part of the default test run, not an opt-in mock provider test.
`workerSecurity.test.ts` and `offlineShell.test.ts` cover production config/cookie/mail guards and
canonical cached navigation without API caching.

`npm run qa:cloud` builds the production app and starts a real isolated Worker/D1 backend.
It plays intro/name menus and **actual START → SAVE** as a guest, then registers/verifies/imports,
makes real saves on two browser profiles, reopens offline, resolves divergence, restores history,
switches accounts, resets a password, signs out, and checks tab locks. It decodes displayed glyph
pixels to drive the game: no private engine globals, injected IndexedDB saves or intercepted APIs.
Cloudflare's index.html redirect/cache-navigation regression is covered.

No deployed Cloudflare domain, real outbound email delivery, physical-phone lifecycle/GPU or public
registration policy is claimed by local validation. Existing build/test/browser dependency advisories
remain (including classifications through optional testing peers); no clean audit is claimed.

Durable Hall of Fame writes add host-timed commit waits, so the campaign's final frame count
now varies slightly around 680,000 rather than fixing the historical 678,357-frame total.
The historical single-player validation below remains applicable. Schema is now **57**.

## Reproducing the checks

Supply your own supported ROM at `roms/pokeyellow.gbc` (or set `PYW_ROM`).

```sh
npm test
npm run build
npx tsx tools/coverage.ts
npm run dev
# With the dev server running, using its private ROM URL:
npx tsx tools/browser-qa.ts
npx tsx tools/profile.ts
```

On this development machine the shell's Node wrappers are broken. Use
`/Users/johannes/.nvm/versions/node/v24.21.0/bin/node` to run the corresponding
`node_modules/{vitest/vitest.mjs,typescript/bin/tsc,vite/bin/vite.js,tsx/dist/cli.mjs}` entry points.
Chrome defaults to the macOS application; set `CHROME` and `PORT` when needed.

## Continuous campaign

`tests/campaign.test.ts` starts a fresh game with RNG seed `0x5eed`, obtains Pikachu
and the Pokédex, and continues by **real button input, without checkpoint transport
or writes to quest flags, badges, puzzle solutions, positions or battle cursors**.
It walks through the eight gyms, Mt. Moon and its fossil, Bill, the S.S. Anne,
Surge's locks, Rock Tunnel, the poster/Lift Key/elevator/Scope chain, Marowak/Fuji,
Snorlax, Safari admission/HM03/Gold Teeth/HM04, Card Key/Silph, Sabrina's warp pads,
Route 21 Surf, Mansion switches/holes, Cinnabar quizzes, Viridian spinners,
Route 23 badge guards, Victory Road's Strength switches and floor drop, the League,
Champion, Hall of Fame save, credits and the cave unlock.

**Fixture boundary:** after the Pokédex, the test installs an owned level-100 combat
party, legally learnable attacks/field moves, and healing stock. Wild *random*
encounters are disabled. HM items and badges are still obtained through the story;
the route does not rely on the prelearned moves to skip their quests. Scripted
battles remain real. Healing, bag-space recovery, field moves and puzzles use menus
and input. This is a progression regression route, **not** a vanilla-party grinding
or difficulty/balance test. Title/Oak-speech input is tested separately in `tests/menus.test.ts`.

The completed route uses about **678,000 game frames**, approximately 90 seconds
headlessly on this development machine. `tests/routeDriver.ts` reads collision and
ROM tables to plan movement and pushes; speculative maps are separate from the
engine's actual world. IndexedDB gets event-loop time during the final ceremony.

The ignored `extracted/campaign-latest.json` records the initial state, explicit
combat fixture and its frame, run-length-encoded input, milestone frames, and all
`setEvent` writes, including temporary flags and the post-League reset (258 distinct
flags in the validated route; repeated writes are retained).
Failures also produce `extracted/campaign-failure.json`. These artifacts are local
ROM-derived data, not distributable assets. Do not commit or share them.

## Checkpoint and negative tests

`tests/progression.test.ts` explicitly uses checkpoint transport to isolate 24
progression cases: ordered badge/reward flags, real League/credits/cave unlock,
Mewtwo disappearance, full-bag reward deferral/retry, no badge after losing,
Bill/captain, Safari/warden, Rocket/Tower/flute, Silph doors/blockade, Secret Key,
and the seven Route 23 guards' negative and positive paths.

`tests/strengthRoute.test.ts` separately executes Victory Road's full push/drop route
from a declared puzzle checkpoint. Other suites cover gifts, trades, optional
facilities, field gating, original battle quirks, and all-map asset/warp integrity.
`tools/coverage.ts` reports **227/227** map-script coverage; handler coverage alone
is not proof of every optional dialogue branch or emulator-level equivalence.

The campaign audit found and fixed four regressions against the disassembly:

- `TextCommand_FAR` must preserve a nested processor return scope. Flattened
  DONE/PROMPT text skipped following commands, including the Lift Key drop.
- Scripted catching/Safari battles that never send out a player Pokémon must not
  copy an uninitialized battle mon's HP/status into party slot zero.
- `GetTrainerInformation` copies only the first two BCD money bytes. Reading all
  three inflated trainer prizes by 100× (Brock's actual reward is ¥1188).
- A ledge's immediately started first step already owns its simulated input.
  Its landing must finish before `_HandleMidJump` clears control; stale input
  otherwise bypassed subsequent land collision.

## Browser and rendering audit

`tools/browser-qa.ts` drives actual Chrome touch events at 390×844 and 844×390.
It checks multi-finger ownership of A, release/drag/re-entry/cancellation, optional
haptic dispatch, DPR/margin quality tiers, and battle-panel/control separation.
Chrome's experimental `Emulation.setSafeAreaInsetsOverride` supplies real CSS
`env()` overrides: portrait top/bottom 44/34; landscape left/right 44/44 and bottom
21. Settings and every control must stay inside these safe bounds. Screenshots go
to ignored `extracted/mobile-{portrait,landscape}.png`.

`tools/profile.ts` measures desktop and phone-viewport town, forest and battle
scenarios, checks that the requested scene remains active, and records GPU,
render-frame/CPU timings and resource counts in `extracted/performance.json`.
Budgets are **80 draw calls, 180,000 triangles, 100 geometries and 100 textures**.
The 60 Hz audit accepts >=58 rendered FPS and p95 frame time <=18.5 ms. Desktop
failure or any scene/resource/runtime error makes the hardware audit fail.
`--software` explicitly labels software-renderer diagnostics; those are not a
hardware performance claim.

Phone quality caps DPR at 1.5 and connected-map margin at four squares; desktop
caps are two and eight. Atlas-backed merged scenery avoids per-prop draw calls.
The debug overlay exposes the same rolling profiler and budgets. The validated
Chrome 155 / Apple M5 Max run measured ~60 FPS in all six scenarios, p95 <=16.8 ms,
and maxima of seven draw calls, 37,936 triangles, seven geometries and six textures.

**Limits:** phone viewport/DPR/touch emulation is not a physical phone GPU or
battery/thermal benchmark. Real iOS/Android performance and physical vibration
still require device testing. Headless browser profiling is not an audio-output
latency test. Link battles remain unavailable without a link-partner implementation.
