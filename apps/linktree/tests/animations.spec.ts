import { expect, test } from "@playwright/test";

test("cards have slide-up animation", async ({ page }) => {
  await page.goto("/");

  const cards = page.locator(".Card");

  // All cards should be visible after animations complete
  await expect(cards.first()).toBeVisible();
  await expect(cards.nth(1)).toBeVisible();
  await expect(cards.nth(2)).toBeVisible();

  // Check that cards have animation applied
  const firstCard = cards.first();
  const animationName = await firstCard.evaluate((el) => {
    return window.getComputedStyle(el).animationName;
  });

  expect(animationName).toBe("slideUp");
});

test("cards animate in sequence", async ({ page }) => {
  // Navigate to a fresh page to see animations
  await page.goto("/");

  const cards = page.locator(".Card");

  // Get animation delay for first few cards
  const firstDelay = await cards.nth(0).evaluate((el) => {
    return window.getComputedStyle(el).animationDelay;
  });

  const secondDelay = await cards.nth(1).evaluate((el) => {
    return window.getComputedStyle(el).animationDelay;
  });

  const thirdDelay = await cards.nth(2).evaluate((el) => {
    return window.getComputedStyle(el).animationDelay;
  });

  // Delays should be increasing (0s, 0.1s, 0.2s)
  expect(firstDelay).toBe("0s");
  expect(secondDelay).toBe("0.1s");
  expect(thirdDelay).toBe("0.2s");
});
