import { MetadataRoute } from 'next'
import { getAllPosts } from '@/lib/posts'

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts()

  const postEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/posts/${post.slug}`,
    lastModified: new Date(post.frontmatter.date),
    changeFrequency: 'weekly',
    priority: 0.8,
  }))

  return [
    {
      url: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...postEntries,
  ]
}