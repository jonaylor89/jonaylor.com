import type { Post } from '@/lib/posts';
import Link from 'next/link'
import Image from 'next/image'
import { headers } from 'next/headers'
import { getAllPosts, formatDate } from '@/lib/posts'
import { formatReadTime } from '@/lib/readTime'
import Footer from '@/components/Footer'

// Calculate Levenshtein distance between two strings
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[str2.length][str1.length]
}

export default async function NotFound() {
  // Get the pathname from headers
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') || headersList.get('referer') || ''

  const allPosts = getAllPosts()

  // Extract the slug from the pathname
  const pathSlug = pathname.replace(/^\/posts?\//, '').replace(/^.*\//, '').toLowerCase()

  let suggestedPosts: Post[] = []
  let randomPosts: Post[] = []

  if (pathSlug && pathSlug !== pathname.toLowerCase()) {
    // Find similar posts based on URL
    const postsWithSimilarity = allPosts.map(post => ({
      post,
      similarity: levenshteinDistance(pathSlug, post.slug.toLowerCase())
    }))

    // Sort by similarity (lower distance = more similar)
    postsWithSimilarity.sort((a, b) => a.similarity - b.similarity)

    // Get top 3 similar posts if the similarity is reasonable (distance < 8)
    const similar = postsWithSimilarity
      .filter(p => p.similarity < 8 && p.similarity > 0)
      .slice(0, 3)
      .map(p => p.post)

    suggestedPosts = similar

    // Get random posts if we don't have enough similar ones
    if (similar.length < 3) {
      const remaining = 3 - similar.length
      const shuffled = [...allPosts]
        .filter(p => !similar.includes(p))
        .sort(() => Math.random() - 0.5)
        .slice(0, remaining)
      randomPosts = shuffled
    }
  } else {
    // No path slug, just show random posts
    randomPosts = [...allPosts].sort(() => Math.random() - 0.5).slice(0, 3)
  }

  const allDisplayPosts = [...suggestedPosts, ...randomPosts]

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-5 min-h-screen">
      <header className="mb-12">
        <div className="text-center">
          <h1 className="text-6xl font-bold mb-4 text-black dark:text-white">
            404
          </h1>
          <h2 className="text-2xl font-semibold mb-4 text-black dark:text-white">
            Page Not Found
          </h2>
          <p className="text-lg text-gray-600 dark:text-gray-400 mb-6">
            {suggestedPosts.length > 0
              ? "Hmm, that page doesn't exist. Did you mean one of these?"
              : "Hmm, that page doesn't exist. Here are some posts you might enjoy:"}
          </p>
          <Link
            href="/"
            className="inline-block text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            ← Back to home
          </Link>
        </div>
      </header>

      <main>
        {allDisplayPosts.length > 0 ? (
          <section>
            <h2 className="text-xl font-semibold mb-6 text-black dark:text-white">
              {suggestedPosts.length > 0 ? 'Similar Posts' : 'Check Out These Posts'}
            </h2>
            <div className="flex flex-col gap-8">
              {allDisplayPosts.map((post, index) => (
                <article
                  key={post.slug}
                  className={`${index !== allDisplayPosts.length - 1 ? 'border-b border-gray-200 dark:border-gray-700' : ''} pb-8`}
                  itemScope
                  itemType="https://schema.org/Article"
                >
                  <Link
                    href={`/${post.slug}`}
                    className="blog-post-link block no-underline text-black dark:text-white"
                  >
                    <div className="md:flex md:gap-6 md:items-start">
                      {/* Mobile: Image on top, Desktop: Content first */}
                      <div className="md:hidden">
                        {post.frontmatter.coverImage && (
                          <div className="mb-4 overflow-hidden rounded-md">
                            <Image
                              src={post.frontmatter.coverImage}
                              alt={post.frontmatter.coverImageAlt || post.frontmatter.title}
                              width={800}
                              height={400}
                              className="w-full h-48 object-cover transition-transform duration-200 hover:scale-105"
                              itemProp="image"
                            />
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="md:flex-1">
                        <header className="mb-4">
                          <h3 className="post-title text-2xl font-bold mb-3 transition-opacity duration-200 text-black dark:text-white" itemProp="headline">
                            {post.frontmatter.title}
                          </h3>
                          <div className="flex items-center gap-4 text-sm text-black dark:text-white">
                            <time dateTime={post.frontmatter.date} itemProp="datePublished">
                              {formatDate(post.frontmatter.date)}
                            </time>
                            <span className="text-gray-500 dark:text-gray-400">
                              {formatReadTime(post.readTime)}
                            </span>
                          </div>
                        </header>
                        <p className="text-black dark:text-white mb-4 text-base leading-relaxed" itemProp="description">
                          {post.frontmatter.excerpt}
                        </p>
                      </div>

                      {/* Desktop: Image on right */}
                      <div className="hidden md:block md:flex-shrink-0">
                        {post.frontmatter.coverImage && (
                          <div className="w-48 h-32 overflow-hidden rounded-md">
                            <Image
                              src={post.frontmatter.coverImage}
                              alt={post.frontmatter.coverImageAlt || post.frontmatter.title}
                              width={800}
                              height={400}
                              className="w-full h-full object-cover transition-transform duration-200 hover:scale-105"
                              itemProp="image"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <div className="text-center py-12">
            <p className="text-gray-600 dark:text-gray-400">
              No posts available at the moment.
            </p>
          </div>
        )}
      </main>

      <Footer />
    </div>
  )
}
