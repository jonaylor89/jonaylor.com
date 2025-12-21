import RSS from 'rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('posts', ({ data }) => {
    return !data.draft;
  });

  const sortedPosts = posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  const siteUrl = context.site?.toString() || 'https://blog.jonaylor.com';

  const feed = new RSS({
    title: 'Buried Treasure - Johannes Naylor\'s Blog',
    description: 'Blog by Johannes Naylor covering software engineering, laguage, and more',
    site_url: siteUrl,
    feed_url: `${siteUrl}/rss.xml`,
    language: 'en-us',
    pubDate: new Date(),
    copyright: `${new Date().getFullYear()} Johannes Naylor`,
    managingEditor: 'Johannes Naylor',
    webMaster: 'Johannes Naylor',
  });

  sortedPosts.forEach((post) => {
    feed.item({
      title: post.data.title,
      description: post.data.excerpt,
      url: `${siteUrl}/${post.slug}/`,
      date: post.data.date,
      categories: post.data.tags || [],
      author: 'Johannes Naylor',
    });
  });

  return new Response(feed.xml(), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}
