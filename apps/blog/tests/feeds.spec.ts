import { expect, test } from '@playwright/test';

test('rss and sitemap endpoints respond with content', async ({ request }) => {
  const rss = await request.get('/rss.xml');
  expect(rss.ok()).toBeTruthy();
  const rssText = await rss.text();
  expect(rssText).toContain('<rss');

  const sitemap = await request.get('/sitemap-index.xml');
  expect(sitemap.ok()).toBeTruthy();
  const sitemapText = await sitemap.text();
  expect(sitemapText).toContain('<sitemapindex');
  expect(sitemapText).toMatch(/<loc>.+<\/loc>/);
});
