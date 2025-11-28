import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const siteUrl = (context.site?.toString() || 'https://blog.jonaylor.com').replace(/\/$/, '');

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${siteUrl}/sitemap-0.xml</loc>
  </sitemap>
</sitemapindex>`;

  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}
