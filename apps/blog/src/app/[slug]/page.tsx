import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getPostBySlug, getAllPosts, formatDate } from "@/lib/posts";
import { formatReadTime } from "@/lib/readTime";
import { generatePostMetadata, generateJSONLD } from "@/lib/seo";
import { MDXRemote } from "next-mdx-remote/rsc";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import Breadcrumb from "@/components/Breadcrumb";
import ShareButtons from "@/components/ShareButtons";
import { siteConfig } from "@/lib/seo";
import { mdxComponents } from "@/components/mdx";
import Footer from "@/components/Footer";

interface Props {
  params: Promise<{
    slug: string;
  }>;
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) {
    notFound();
  }

  const jsonLd = generateJSONLD("article", {
    title: post.frontmatter.title,
    description: post.frontmatter.excerpt,
    slug: post.slug,
    date: post.frontmatter.date,
    tags: post.frontmatter.tags,
    content: post.content,
    coverImage: post.frontmatter.coverImage,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="max-w-3xl mx-auto px-5 md:px-10 py-5 min-h-screen">
        <div className="flex justify-between items-center mb-6">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Posts", href: "/" },
              { label: post.frontmatter.title },
            ]}
          />
        </div>

        <article>
          <header className="mb-8">
            <h1 className="text-3xl md:text-4xl font-bold mb-4 text-black dark:text-white leading-tight">
              {post.frontmatter.title}
            </h1>
            {post.frontmatter.coverImage && (
              <div className="mb-6 overflow-hidden rounded-md">
                <Image
                  src={post.frontmatter.coverImage}
                  alt={post.frontmatter.coverImageAlt || post.frontmatter.title}
                  width={800}
                  height={400}
                  className="w-full h-64 md:h-80 object-cover"
                  priority
                />
              </div>
            )}
            <div className="flex items-center gap-4 text-black dark:text-white mb-6">
              <time className="text-base">
                {formatDate(post.frontmatter.date)}
              </time>
              <span className="text-gray-500 dark:text-gray-400">
                {formatReadTime(post.readTime)}
              </span>
            </div>
            {post.frontmatter.excerpt && (
              <p className="text-xl text-black dark:text-white italic mb-8">
                {post.frontmatter.excerpt}
              </p>
            )}
          </header>

          <div className="prose prose-lg max-w-none dark:prose-invert">
            <MDXRemote
              source={post.content}
              components={mdxComponents}
              options={{
                mdxOptions: {
                  remarkPlugins: [remarkGfm],
                  rehypePlugins: [rehypeHighlight],
                },
              }}
            />
          </div>

          <ShareButtons
            url={`${siteConfig.url}/${post.slug}`}
            title={post.frontmatter.title}
            description={post.frontmatter.excerpt}
          />

          {post.frontmatter.tags && post.frontmatter.tags.length > 0 && (
            <div className="mt-6 pt-6">
              <div className="flex flex-wrap gap-2">
                {post.frontmatter.tags.map((tag) => (
                  <Link
                    key={tag}
                    href={`/tag/${encodeURIComponent(tag)}`}
                    className="bg-gray-100 dark:bg-gray-800 text-black dark:text-white px-3 py-1 rounded-full text-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors duration-200"
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </article>

        <div className="mt-8 mb-4">
          <Link
            href="/"
            className="nav-link inline-block text-black dark:text-white underline transition-opacity duration-200"
          >
            ← Back to all posts
          </Link>
        </div>

        <Footer />
      </div>
    </>
  );
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) {
    return {};
  }

  return generatePostMetadata(post);
}

export function generateStaticParams() {
  const posts = getAllPosts();

  return posts.map((post) => ({
    slug: post.slug,
  }));
}
