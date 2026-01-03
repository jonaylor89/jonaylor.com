import { expect, test } from "@playwright/test";

test("page has proper meta tags", async ({ page }) => {
  await page.goto("/");

  // Check title
  await expect(page).toHaveTitle(/johannes naylor/i);

  // Check meta description
  const description = page.locator('meta[name="description"]');
  await expect(description).toHaveAttribute("content", /.+/);

  // Check canonical URL
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveAttribute("href", /.+/);
});

test("page has Open Graph tags", async ({ page }) => {
  await page.goto("/");

  // Check OG tags
  const ogTitle = page.locator('meta[property="og:title"]');
  await expect(ogTitle).toHaveAttribute("content", /.+/);

  const ogType = page.locator('meta[property="og:type"]');
  await expect(ogType).toHaveAttribute("content", "website");

  const ogImage = page.locator('meta[property="og:image"]');
  await expect(ogImage).toHaveAttribute("content", /.+/);
});

test("page has Twitter Card tags", async ({ page }) => {
  await page.goto("/");

  // Check Twitter tags
  const twitterCard = page.locator('meta[name="twitter:card"]');
  await expect(twitterCard).toHaveAttribute("content", "summary_large_image");

  const twitterSite = page.locator('meta[name="twitter:site"]');
  await expect(twitterSite).toHaveAttribute("content", "@jonaylor89");
});

test("page has JSON-LD structured data", async ({ page }) => {
  await page.goto("/");

  // Check for JSON-LD script
  const jsonLd = page.locator('script[type="application/ld+json"]');
  await expect(jsonLd).toHaveCount(1);

  // Parse and verify JSON-LD content
  const jsonContent = await jsonLd.textContent();
  expect(jsonContent).toBeTruthy();

  const data = JSON.parse(jsonContent!);
  expect(data["@context"]).toBe("https://schema.org");
  expect(data["@type"]).toBe("ProfilePage");
  expect(data.mainEntity).toBeTruthy();
  expect(data.mainEntity["@type"]).toBe("Person");
});

test("Plausible Analytics script is loaded", async ({ page }) => {
  await page.goto("/");

  // Check for Plausible script
  const plausibleScript = page.locator('script[data-domain]');
  await expect(plausibleScript).toHaveAttribute(
    "data-domain",
    "linktree.jonaylor.com"
  );
  await expect(plausibleScript).toHaveAttribute(
    "src",
    "https://plausible.io/js/script.js"
  );
});
