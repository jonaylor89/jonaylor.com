# Monorepo import

Imported from the local `pokemon-yellow-web` project into `apps/pokemon-yellow`.
The original repository is retained; its ignored assets/secrets and VCS metadata are not copied.

Source baseline: `7d9039bc` (scenery and water updates), plus the working Better Auth / Workers /
D1 / guest-save milestone. The original single-player completion baseline was `78622f4045b2`.

The workspace uses pnpm and the root lockfile. There is no app-level npm lockfile.
ROMs, extracted game data, local D1 state, private credentials and screenshots stay ignored.
The production game bundle must be provisioned independently of the public source checkout.

Production target: `https://pokemon-yellow.jonaylor.com`, one environment (no staging).
Production transactional email: Postmark, from `me@jonaylor.com`. Local verification/reset
email uses the local inbox. CI fetches the SHA-256-pinned public release in `assets.release.json`;
the ROM is never uploaded or needed in CI.

Import validation (2026-10-19): **282 tests / 43 suites**, app typecheck/build, all **11 monorepo
build tasks**, root lint/format checks, Worker packaging dry-run, and real-browser local-backend
QA passed. The full suite used the operator ROM through `PYW_ROM`; ordinary CI skips those
ROM-dependent tests. See `DEPLOYMENT.md` for opt-in live production QA and operational limits.
