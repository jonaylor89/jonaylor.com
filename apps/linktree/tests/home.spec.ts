import { expect, test } from "@playwright/test";

test("homepage renders with header and footer", async ({ page }) => {
  await page.goto("/");

  // Check header is visible
  await expect(page.getByRole("heading", { name: /johannes/i })).toBeVisible();

  // Check footer is visible
  await expect(page.getByText(/made with/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /johannes/i })).toBeVisible();
});

test("all link cards are rendered", async ({ page }) => {
  await page.goto("/");

  // Should have 13 link cards
  const cards = page.locator(".Card");
  await expect(cards).toHaveCount(13);

  // Check first few cards are visible
  await expect(cards.first()).toBeVisible();
  await expect(cards.nth(1)).toBeVisible();
  await expect(cards.nth(2)).toBeVisible();
});

test("cards have correct structure and content", async ({ page }) => {
  await page.goto("/");

  const firstCard = page.locator(".Card").first();

  // Card should have an image
  const image = firstCard.locator("img.cover");
  await expect(image).toBeVisible();

  // Card should have title
  const title = firstCard.locator("h2");
  await expect(title).toBeVisible();
  await expect(title).toHaveText(/website/i);

  // Card should have subtitle
  const subtitle = firstCard.locator("p");
  await expect(subtitle).toBeVisible();
});

test("card links are clickable and have correct attributes", async ({
  page,
}) => {
  await page.goto("/");

  const firstCardLink = page.locator("a").first();

  // Should have target="_blank" and rel="noopener noreferrer"
  await expect(firstCardLink).toHaveAttribute("target", "_blank");
  await expect(firstCardLink).toHaveAttribute("rel", "noopener noreferrer");

  // Should have href
  const href = await firstCardLink.getAttribute("href");
  expect(href).toBeTruthy();
  expect(href).toMatch(/^https?:\/\//);
});
