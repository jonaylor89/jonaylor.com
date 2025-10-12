import Link from "next/link";
import { Post } from "@/lib/posts";

interface SuggestedPostsProps {
  posts: Post[];
}

export default function SuggestedPosts({ posts }: SuggestedPostsProps) {
  if (posts.length === 0) {
    return null;
  }

  return (
    <section className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700">
      <h2 className="text-xl font-bold mb-6 text-black dark:text-white">
        Check these out next
      </h2>
      <div className="space-y-4">
        {posts.map((post) => (
          <article key={post.slug}>
            <Link
              href={`/${post.slug}`}
              className="block group hover:opacity-70 transition-opacity duration-200"
            >
              <h3 className="text-lg font-medium text-black dark:text-white mb-1">
                {post.frontmatter.title}
              </h3>
              {post.frontmatter.excerpt && (
                <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                  {post.frontmatter.excerpt}
                </p>
              )}
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
