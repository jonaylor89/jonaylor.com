# Production deployment

Verified 2026-10-19.

- Site: **https://pokemon-yellow.jonaylor.com**
- Source: `apps/pokemon-yellow` in `jonaylor89/jonaylor.com`, branch `main`.
- One production Worker (`pokemon-yellow`) and D1 (`pokemon-yellow`). No staging,
  workers.dev endpoint, version preview URLs or branch-preview builds.
- Better Auth email/password; Postmark Live delivery from `me@jonaylor.com`, stream `outbound`.
- Worker runtime secrets are not present in source, browser assets or build variables.
- Authorized game data is a public, versioned GitHub release pinned by SHA-256 in
  `assets.release.json`. Neither Git nor CI contains a ROM.

## Verified behavior

- Root monorepo lint/format checks and all 11 build tasks passed.
- Import regression run: 282 tests in 43 suites passed with the operator ROM. Ordinary CI
  runs ROM-independent tests and explicitly skips ROM-dependent gameplay tests.
- GitHub Build & Test and Biome CI passed. A real `push_event` Cloudflare build from `main`
  fetched and verified assets, passed tests, applied remote migrations and deployed successfully.
- Live mobile-viewport browser QA passed guest boot/SAVE without a ROM picker, optional
  registration and verification, explicit guest import, two-device cloud saves, offline
  SAVE/reopening, conflict/recovery selection, account separation, reset/logout and tab locks.
- Email QA used unique Postmark blackhole recipients and read only those messages, not real
  Hub/user mail. This validates the Live transport and actual auth links, not real-recipient
  inbox placement or physical-device performance.
- Production cookies were checked for Secure, HttpOnly and SameSite=Lax; auth responses use
  `no-store`. HTTP redirects to HTTPS; unauthenticated saves return 401; the dev inbox returns 404.
- Only the exact disposable QA users were removed afterward, cascading their account/session/
  save data. No production database reset or unrelated account deletion was performed.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the repeatable pipeline, secret rotation and opt-in live
QA procedure. Backups/restore rehearsals, privacy/age/deletion procedures, abuse/quotas/alerts,
dependency-audit follow-up and physical-phone checks remain operator responsibilities.
