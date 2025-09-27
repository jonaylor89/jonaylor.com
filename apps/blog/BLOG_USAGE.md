# Blog Usage Guide

This is your personal blog built with Next.js and MDX. Here's how to use it:

## Adding New Blog Posts

1. Create a new `.md` or `.mdx` file in the `content/posts/` directory
2. Add frontmatter at the top of your file:

```yaml
---
title: "Your Blog Post Title"
date: "2024-01-20"
excerpt: "Brief description of your post"
tags: ["tag1", "tag2", "tag3"]
---
```

3. Write your content in Markdown below the frontmatter
4. The file name (without extension) will become the URL slug

## File Structure

```
├── content/
│   └── posts/           # Your blog posts go here
│       ├── welcome.md
│       └── another-post.md
├── src/
│   ├── app/
│   │   ├── page.tsx     # Blog listing page
│   │   └── posts/[slug]/
│   │       └── page.tsx # Individual post page
│   └── lib/
│       └── posts.ts     # Blog post utilities
```

## Development

```bash
npm run dev    # Start development server
npm run build  # Build for production
npm start      # Start production server
```

## Features

- **File-based content**: All posts are markdown files
- **Frontmatter support**: Add metadata to your posts
- **Dark mode ready**: Styled for both light and dark themes
- **Responsive design**: Works on all device sizes
- **SEO friendly**: Proper meta tags and structure
- **Static generation**: Fast loading with Next.js SSG

## Deployment

This blog is ready to deploy on Vercel:

1. Push your code to GitHub
2. Connect your repository to Vercel
3. Deploy automatically

Your blog posts will be automatically built and served as static pages for optimal performance.

## Customization

- Edit `src/app/page.tsx` to customize the homepage
- Modify `src/app/layout.tsx` to change the overall layout
- Update `tailwind.config.js` to adjust styling
- Add custom MDX components in `src/app/posts/[slug]/page.tsx`