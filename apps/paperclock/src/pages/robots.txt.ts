const site = import.meta.env.PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://paperclock.jonaylor.com";

export function GET() {
  const sitemap = site ? `\n\nSitemap: ${site}/sitemap.xml` : "";

  return new Response(`User-agent: *\nAllow: /${sitemap}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
