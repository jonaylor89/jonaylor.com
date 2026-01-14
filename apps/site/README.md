# Unified Site - jonaylor.com

This is a unified Astro site that combines:
- **Main website** (`/`) - Previously `www` at jonaylor.com
- **Blog** (`/blog`) - Previously `blog` at blog.jonaylor.com
- **Projects/Links** (`/links`) - Previously `linktree` at bio.jonaylor.com

## Routes

| Path | Description |
|------|-------------|
| `/` | Homepage with intro, talks, and contact info |
| `/projects` | Simple list of projects by category |
| `/blog` | Blog listing page |
| `/blog/[slug]` | Individual blog posts |
| `/blog/rss.xml` | RSS feed |
| `/links` | Linktree-style social links page |
| `/user-manual` | Working style and preferences |
| `/needle-movers` | Big ideas |

## Development

```bash
# From monorepo root
pnpm --filter site dev

# Or from this directory
pnpm dev
```

## Build

```bash
pnpm --filter site build
```

## Content

Blog posts are in `src/content/posts/` as MDX files.
Project links are in `src/content/links/` as JSON files.

## Redirects

Old domains redirect to the new structure:
- `blog.jonaylor.com/*` → `jonaylor.com/blog/*`
- `bio.jonaylor.com/*` → `jonaylor.com/links/*`

**Source of truth:** `redirects.json`

To generate config for a different provider:
```bash
npx tsx scripts/generate-redirects.ts netlify    # or cloudflare, nginx
```

### Vercel Setup

1. Add `blog.jonaylor.com` and `bio.jonaylor.com` as domains in Vercel project settings
2. The `vercel.json` handles redirects at the edge

### Other Providers

Run the generator script and configure domain aliases in your provider's dashboard.

## Stack

- [Astro](https://astro.build) - Static site generator
- [Tailwind CSS](https://tailwindcss.com) - Styling
- [MDX](https://mdxjs.com) - Blog posts with components
