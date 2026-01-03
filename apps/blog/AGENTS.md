# Agent Guidance
- Keep edits small and follow current Astro patterns.
- QA pipeline (in order): `npm run build`; then `npm run lint` and `npm run test` if those scripts exist—otherwise report they are missing.
- Visual/E2E check: if Playwright is set up, start `npm run dev` and run `npx playwright test`; if not set up, say so.
- Summarize the commands run and their outcomes before finishing.
