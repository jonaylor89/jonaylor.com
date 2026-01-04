import { expect, test } from "@playwright/test";

test("first post opens and shows content", async ({ page }) => {
	await page.goto("/");

	const firstPost = page.locator(".blog-post-link").first();
	await firstPost.click();

	await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
	await expect(page.getByRole("link", { name: /back to all posts/i })).toBeVisible();
});
