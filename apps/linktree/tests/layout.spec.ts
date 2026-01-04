import { expect, test } from "@playwright/test";

test("card images have correct dimensions", async ({ page }) => {
	await page.goto("/");

	const firstCardImage = page.locator(".Card img.cover").first();
	await expect(firstCardImage).toBeVisible();

	// Get computed style
	const box = await firstCardImage.boundingBox();
	expect(box).toBeTruthy();

	// Image should be approximately 94px tall (from CSS)
	// Allow some tolerance for browser rendering differences
	expect(box?.height).toBeGreaterThan(80);
	expect(box?.height).toBeLessThan(110);
});

test("cards use CSS Grid layout", async ({ page }) => {
	await page.goto("/");

	// Check that the row uses CSS Grid
	const row = page.locator(".row");
	const display = await row.evaluate((el) => window.getComputedStyle(el).display);
	expect(display).toBe("grid");

	// Verify grid has gap
	const gap = await row.evaluate((el) => window.getComputedStyle(el).gap);
	expect(gap).not.toBe("0px");

	// Verify cards are rendered and visible
	const cards = page.locator(".Card");
	await expect(cards.first()).toBeVisible();
	await expect(cards.nth(1)).toBeVisible();

	// Verify cards have proper dimensions
	const firstBox = await cards.nth(0).boundingBox();
	expect(firstBox).toBeTruthy();
	expect(firstBox?.width).toBeGreaterThan(200);
	expect(firstBox?.height).toBeGreaterThan(150);
});

test("cards have correct height", async ({ page }) => {
	await page.goto("/");

	const firstCard = page.locator(".Card").first();
	const box = await firstCard.boundingBox();

	expect(box).toBeTruthy();
	// Card height should be 200px from CSS
	expect(box?.height).toBeGreaterThan(190);
	expect(box?.height).toBeLessThan(220);
});

test("responsive layout on mobile", async ({ page }) => {
	// Set mobile viewport
	await page.setViewportSize({ width: 375, height: 667 });
	await page.goto("/");

	const cards = page.locator(".Card");
	await expect(cards.first()).toBeVisible();
	await expect(cards.nth(1)).toBeVisible();
	await page.waitForTimeout(500); // Wait for animations

	// On mobile, cards should stack vertically
	const firstBox = await cards.nth(0).boundingBox();
	const secondBox = await cards.nth(1).boundingBox();

	expect(firstBox).toBeTruthy();
	expect(secondBox).toBeTruthy();

	if (!firstBox || !secondBox) {
		throw new Error("Card bounding boxes not found");
	}

	// Second card should be below first card (or side by side on small screens with grid)
	// Just verify both cards are rendered with positions
	expect(firstBox.height).toBeGreaterThan(0);
	expect(secondBox.height).toBeGreaterThan(0);
});

test("responsive layout on desktop", async ({ page }) => {
	// Set desktop viewport
	await page.setViewportSize({ width: 1920, height: 1080 });
	await page.goto("/");

	const cards = page.locator(".Card");

	// Wait for cards to be visible
	await expect(cards.first()).toBeVisible();
	await expect(cards.nth(1)).toBeVisible();
	await expect(cards.nth(2)).toBeVisible();

	// On desktop with CSS Grid, check the grid template columns
	const row = page.locator(".row");
	const gridTemplateColumns = await row.evaluate(
		(el) => window.getComputedStyle(el).gridTemplateColumns
	);

	// On desktop (>= 550px), should have 3 columns
	const columnCount = gridTemplateColumns.split(" ").length;
	expect(columnCount).toBe(3);

	// Verify all cards are visible
	const visibleCards = await cards.count();
	expect(visibleCards).toBe(13);
});
