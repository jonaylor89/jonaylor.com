# Agent Guidance
- Monorepo uses pnpm and turbo; run commands from the repo root, prefer pnpm, and keep edits small while following the conventions of the app you're touching.
- Summarize the commands run and their outcomes before finishing.

## Blog app (apps/blog)
- Astro site—stick to existing Astro patterns and keep changes minimal.
- QA (in order): `pnpm --filter blog build`; then `pnpm --filter blog lint` and `pnpm --filter blog test` if those scripts exist—otherwise note that they're missing.
- Visual/E2E: if Playwright is set up, start `pnpm --filter blog dev` and run `pnpm --filter blog test`; if not set up, say so.
