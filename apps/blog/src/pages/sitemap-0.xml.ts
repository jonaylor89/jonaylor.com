import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export async function GET(context: APIContext) {
	const posts = await getCollection("posts", ({ data }) => {
		return !data.draft;
	});

	const siteUrl = (context.site?.toString() || "https://blog.jonaylor.com").replace(/\/$/, "");

	const urls = [
		{
			loc: `${siteUrl}/`,
			lastmod: new Date().toISOString(),
			changefreq: "weekly",
			priority: 1.0,
		},
		...posts.map((post) => ({
			loc: `${siteUrl}/${post.slug}/`,
			lastmod: post.data.date.toISOString(),
			changefreq: "monthly",
			priority: 0.8,
		})),
	];

	const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map(
		(url) => `  <url>
    <loc>${url.loc}</loc>
    <lastmod>${url.lastmod}</lastmod>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`
	)
	.join("\n")}
</urlset>`;

	return new Response(sitemap, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
		},
	});
}
