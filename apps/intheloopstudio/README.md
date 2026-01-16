# In The Loop

Static landing page for In The Loop - a platform for artists and producers to collaborate.

## Tech Stack

- **[Astro](https://astro.build/)** - Static site generator
- **[Tailwind CSS v4](https://tailwindcss.com/)** - Utility-first CSS
- **[Biome](https://biomejs.dev/)** - Fast linter and formatter

## Getting Started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run Biome linter
- `npm run lint:fix` - Fix linting issues
- `npm run check` - Run Astro check and Biome

## Project Structure

```
src/
├── components/     # Astro components
├── layouts/        # Page layouts
├── pages/          # Routes (index, privacy, terms, usage, 404)
└── styles.css      # Global styles with Tailwind
public/
├── favicon.svg
├── robots.txt
└── sitemap.xml
```
