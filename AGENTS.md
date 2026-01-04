# Agent Guidance
- Monorepo uses pnpm and turbo; run commands from the repo root, prefer pnpm, and keep edits small while following the conventions of the app you're touching.
- Summarize the commands run and their outcomes before finishing.

## Linting & Formatting
- This monorepo uses **Biome** (not ESLint) for ultra-fast linting and formatting.
- Before committing: run `pnpm lint` to check for issues, `pnpm lint:fix` to auto-fix, and `pnpm format` to format code.
- Biome checks are configured in `biome.json` at the root and apply to `apps/blog` and `apps/linktree`.
- Legacy apps (www, resume, gm) are excluded from linting.

## Blog app (apps/blog)
- Astro site—stick to existing Astro patterns and keep changes minimal.
- QA (in order):
  1. `pnpm --filter blog lint` - Check for linting issues
  2. `pnpm --filter blog build` - Ensure build passes
  3. `pnpm --filter blog test` - Run Playwright tests (if applicable)
- Visual/E2E: if Playwright is set up, start `pnpm --filter blog dev` and run `pnpm --filter blog test`; if not set up, say so.

## Linktree app (apps/linktree)
- Astro site—follow existing patterns.
- QA (in order):
  1. `pnpm --filter linktree lint` - Check for linting issues
  2. `pnpm --filter linktree build` - Ensure build passes
  3. `pnpm --filter linktree test` - Run Playwright tests (if applicable)
