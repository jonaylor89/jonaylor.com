const site = import.meta.env.PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://paperclock.jonaylor.com";

const pages = [
  { path: "/", priority: "1.0", changefreq: "weekly" },
  { path: "/privacy", priority: "0.3", changefreq: "yearly" },
  { path: "/terms", priority: "0.3", changefreq: "yearly" },
];

export function GET() {
  const urls = site
    ? pages
        .map(
          ({ path, priority, changefreq }) => `  <url>
    <loc>${new URL(path, site)}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`,
        )
        .join("\n")
    : "";

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
}
