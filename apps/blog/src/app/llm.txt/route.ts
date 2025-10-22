import { NextResponse } from 'next/server'
import { getAllPosts } from '@/lib/posts'

export async function GET() {
  const posts = getAllPosts()
  const siteUrl = "https://blog.jonaylor.com"

  const llmTxt = `# Buried Treasure - Johannes Naylor's Blog

> A blog about technology, software development, and programming by Johannes Naylor

## About

This is a technical blog by Johannes Naylor covering topics in software development,
programming, web development, and technology. The blog features in-depth articles,
tutorials, and personal insights from a software engineer's perspective.

## Blog Posts

The blog contains ${posts.length} posts. Each post is available in both HTML and raw MDX format.

${posts.map(post => {
  const tags = post.frontmatter.tags?.join(', ') || 'No tags'
  return `### ${post.frontmatter.title}
- URL: ${siteUrl}/${post.slug}
- Raw MDX: ${siteUrl}/${post.slug}/raw
- Date: ${post.frontmatter.date}
- Tags: ${tags}
- Excerpt: ${post.frontmatter.excerpt}
- Read time: ${post.readTime} min`
}).join('\n\n')}

## Site Structure

- Home: ${siteUrl}/
- All posts: Browse by visiting the home page
- Posts by tag: ${siteUrl}/tag/[tag-name]
- RSS Feed: ${siteUrl}/rss.xml
- Sitemap: ${siteUrl}/sitemap.xml

## Available Tags

${Array.from(new Set(posts.flatMap(p => p.frontmatter.tags || []))).sort().join(', ')}

## API Endpoints

- GET /api/posts - Returns all posts as JSON
- GET /[slug]/raw - Returns the raw MDX content for a specific post

## Contact

- Website: https://jonaylor.com
- GitHub: https://github.com/jonaylor89
- LinkedIn: https://linkedin.com/in/john-naylor
- Twitter/X: https://x.com/jonaylor89
`

  return new NextResponse(llmTxt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}
