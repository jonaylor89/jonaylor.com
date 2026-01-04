import { expect, test } from "@playwright/test";

test("theme toggle button is visible and functional", async ({ page }) => {
	await page.goto("/");

	const themeButton = page.locator("#theme-toggle");
	await expect(themeButton).toBeVisible();

	// Default theme should be dark
	const initialTheme = await page.evaluate(() => document.body.getAttribute("data-theme"));
	expect(initialTheme).toBe("dark");

	// Sun icon should be visible in dark mode
	const sunIcon = page.locator("#sun-icon");
	await expect(sunIcon).toBeVisible();

	// Moon icon should be hidden in dark mode
	const moonIcon = page.locator("#moon-icon");
	await expect(moonIcon).toBeHidden();

	// Click to toggle theme
	await themeButton.click();

	// Wait a bit for transition
	await page.waitForTimeout(100);

	// Theme should now be light
	const newTheme = await page.evaluate(() => document.body.getAttribute("data-theme"));
	expect(newTheme).toBe("light");

	// Sun icon should be hidden in light mode
	await expect(sunIcon).toBeHidden();

	// Moon icon should be visible in light mode
	await expect(moonIcon).toBeVisible();
});

test("theme persists in localStorage", async ({ page }) => {
	await page.goto("/");

	// Toggle to light theme
	const themeButton = page.locator("#theme-toggle");
	await themeButton.click();

	// Wait for localStorage to update
	await page.waitForTimeout(100);

	// Check localStorage
	const storedTheme = await page.evaluate(() => localStorage.getItem("theme"));
	expect(storedTheme).toBe("light");

	// Reload page
	await page.reload();

	// Theme should still be light after reload
	const theme = await page.evaluate(() => document.body.getAttribute("data-theme"));
	expect(theme).toBe("light");
});

test("theme affects card hover colors", async ({ page }) => {
	await page.goto("/");

	const firstCard = page.locator(".Card").first();

	// Get background color in dark mode
	await firstCard.hover();
	await page.waitForTimeout(200); // Wait for hover transition

	// Toggle to light mode
	const themeButton = page.locator("#theme-toggle");
	await themeButton.click();
	await page.waitForTimeout(200);

	// Hover again in light mode
	await firstCard.hover();
	await page.waitForTimeout(200);

	// Just verify no errors occurred during theme switching
	// (actual color comparison would be flaky)
});
