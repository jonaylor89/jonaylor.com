import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getAllPosts, formatDate } from "@/lib/posts";
import { formatReadTime } from "@/lib/readTime";
import Footer from "@/components/Footer";

import { Metadata } from "next";

interface Props {
  params: Promise<{
    tag: string;
  }>;
}

export default async function TagPage({ params }: Props) {
  const { tag } = await params;
  const decodedTag = decodeURIComponent(tag);

  const allPosts = getAllPosts();
  const filteredPosts = allPosts.filter((post) =>
    post.frontmatter.tags?.some(
      (t) => t.toLowerCase() === decodedTag.toLowerCase(),
    ),
  );

  if (filteredPosts.length === 0) {
    notFound();
  }

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-5 min-h-screen">
      <header className="mb-12">
        <div className="text-center">
          <h1 className="text-3xl md:text-4xl font-bold mb-4 text-black dark:text-white">
            Posts tagged: #{decodedTag}
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400">
            {filteredPosts.length} post{filteredPosts.length !== 1 ? "s" : ""}{" "}
            found
          </p>
          <Link
            href="/"
            className="inline-block mt-4 text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            ← Back to all posts
          </Link>
        </div>
      </header>

      <main>
        <section>
          <h2 className="sr-only">Tagged Posts</h2>
          <div className="flex flex-col gap-8">
            {filteredPosts.map((post, index) => (
              <article
                key={post.slug}
                className={`${index !== filteredPosts.length - 1 ? "border-b border-gray-200 dark:border-gray-700" : ""} pb-8`}
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
      </main>

      <Footer />
    </div>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params;
  const decodedTag = decodeURIComponent(tag);

  return {
    title: `Posts tagged: ${decodedTag} | Buried Treasure`,
    description: `All blog posts tagged with ${decodedTag}`,
  };
}

export function generateStaticParams() {
  const posts = getAllPosts();
  const tags = new Set<string>();

  posts.forEach((post) => {
    post.frontmatter.tags?.forEach((tag) => {
      tags.add(tag);
    });
  });

  return Array.from(tags).map((tag) => ({
    tag: encodeURIComponent(tag),
  }));
}
