import { getAllPosts } from "@/lib/posts";
import { siteConfig } from "@/lib/seo";
import RSS from "rss";

export async function GET() {
  const posts = getAllPosts();

  const feed = new RSS({
    title: siteConfig.name,
    description: siteConfig.description,
    site_url: siteConfig.url,
    feed_url: `${siteConfig.url}/rss.xml`,
    copyright: `© ${new Date().getFullYear()} ${siteConfig.author.name}`,
    language: "en",
    pubDate:
      posts.length > 0 ? new Date(posts[0].frontmatter.date) : new Date(),
    webMaster: siteConfig.author.email,
    managingEditor: siteConfig.author.email,
  });

  posts.forEach((post) => {
    const postUrl = `${siteConfig.url}/${post.slug}`;

    feed.item({
      title: post.frontmatter.title,
      guid: postUrl,
      url: postUrl,
      date: new Date(post.frontmatter.date),
      description: post.frontmatter.excerpt,
      author: siteConfig.author.email,
      categories: post.frontmatter.tags || [],
    });
  });

  return new Response(feed.xml({ indent: true }), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}
