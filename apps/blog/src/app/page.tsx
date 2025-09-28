import Link from "next/link";
import Image from "next/image";
import { getAllPosts, formatDate } from "@/lib/posts";
import { formatReadTime } from "@/lib/readTime";
import Footer from "@/components/Footer";

export default function Home() {
  const posts = getAllPosts();

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-5 min-h-screen">
      <header className="mb-12">
        <div className="flex justify-between items-center mb-8">
          <div className="flex-1" />
        </div>
        <div className="text-center">
          <h1 className="text-3xl md:text-4xl font-bold mb-4 text-black dark:text-white">
            Buried Treasure
          </h1>
          <p className="text-lg text-black dark:text-white">
            By Johannes Naylor
          </p>
          <nav
            aria-label="External links"
            className="flex flex-wrap justify-center gap-4 text-sm"
          >
            <Link
              href="https://jonaylor.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
            >
              about me
            </Link>
            <Link
              href="https://bio.jonaylor.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
            >
              projects
            </Link>
            <Link
              href="https://github.com/jonaylor89"
              target="_blank"
              rel="noopener noreferrer"
              className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
            >
              github
            </Link>
            <Link
              href="https://linkedin.com/in/john-naylor"
              target="_blank"
              rel="noopener noreferrer"
              className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
            >
              linkedin
            </Link>
            <Link
              href="https://x.com/jonaylor89"
              target="_blank"
              rel="noopener noreferrer"
              className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
            >
              X/twitter
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {posts.length === 0 ? (
          <section className="text-center py-12">
            <p className="text-black dark:text-white text-lg">
              No posts yet. Add some markdown files to the{" "}
              <code className="bg-gray-100 dark:bg-gray-800 text-black dark:text-white px-1 py-0.5 rounded">
                content/posts
              </code>{" "}
              directory to get started.
            </p>
          </section>
        ) : (
          <section>
            <h2 className="sr-only">Blog Posts</h2>
            <div className="flex flex-col gap-8">
              {posts.map((post, index) => (
                <article
                  key={post.slug}
                  className={`${index !== posts.length - 1 ? "border-b border-gray-200 dark:border-gray-700" : ""} pb-8`}
                  itemScope
                  itemType="https://schema.org/Article"
                >
                  <Link
                    href={`/posts/${post.slug}`}
                    className="blog-post-link block no-underline text-black dark:text-white"
                  >
                    <div className="md:flex md:gap-6 md:items-start">
                      {/* Mobile: Image on top, Desktop: Content first */}
                      <div className="md:hidden">
                        {post.frontmatter.coverImage && (
                          <div className="mb-4 overflow-hidden rounded-md">
                            <Image
                              src={post.frontmatter.coverImage}
                              alt={
                                post.frontmatter.coverImageAlt ||
                                post.frontmatter.title
                              }
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
                          <h3
                            className="post-title text-2xl font-bold mb-3 transition-opacity duration-200 text-black dark:text-white"
                            itemProp="headline"
                          >
                            {post.frontmatter.title}
                          </h3>
                          <div className="flex items-center gap-4 text-sm text-black dark:text-white">
                            <time
                              dateTime={post.frontmatter.date}
                              itemProp="datePublished"
                            >
                              {formatDate(post.frontmatter.date)}
                            </time>
                            <span className="text-gray-500 dark:text-gray-400">
                              {formatReadTime(post.readTime)}
                            </span>
                          </div>
                        </header>
                        <p
                          className="text-black dark:text-white mb-4 text-base leading-relaxed"
                          itemProp="description"
                        >
                          {post.frontmatter.excerpt}
                        </p>
                      </div>

                      {/* Desktop: Image on right */}
                      <div className="hidden md:block md:flex-shrink-0">
                        {post.frontmatter.coverImage && (
                          <div className="w-48 h-32 overflow-hidden rounded-md">
                            <Image
                              src={post.frontmatter.coverImage}
                              alt={
                                post.frontmatter.coverImageAlt ||
                                post.frontmatter.title
                              }
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
        )}
      </main>

      <Footer />
    </div>
  );
}
