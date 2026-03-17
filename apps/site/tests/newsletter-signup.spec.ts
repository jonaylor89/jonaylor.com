import { expect, test } from "@playwright/test";

test.describe("Newsletter signup form", () => {
	test("is visible on the blog index page", async ({ page }) => {
		await page.goto("/blog");
		const signup = page.locator("[data-newsletter-signup]").first();
		await expect(signup).toBeVisible();
		await expect(signup.locator("h3")).toHaveText(
			"Get essays on engineering, AI, and building things"
		);
		await expect(signup.locator('input[name="email"]')).toBeVisible();
		await expect(signup.locator('button[type="submit"]')).toHaveText("Subscribe");
	});

	test("shows validation when submitting empty fields", async ({ page }) => {
		await page.goto("/blog");
		const form = page.locator("[data-newsletter-form]").first();
		const submitBtn = form.locator('button[type="submit"]');

		await submitBtn.click();

		const emailInput = form.locator('input[name="email"]');
		const isInvalid = await emailInput.evaluate((el: HTMLInputElement) => !el.validity.valid);
		expect(isInvalid).toBe(true);
	});

	test("submits the form and shows success on valid response", async ({ page }) => {
		await page.goto("/blog");

		await page.route("**/api/subscriptions", (route) => {
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ status: "confirmation_sent" }),
			});
		});

		const signup = page.locator("[data-newsletter-signup]").first();
		await signup.locator('input[name="email"]').fill("test@example.com");
		await signup.locator('button[type="submit"]').click();

		await expect(signup.locator("[data-newsletter-success]")).toBeVisible();
		await expect(signup.locator("[data-newsletter-form]")).toBeHidden();
	});

	test("shows error message on API failure", async ({ page }) => {
		await page.goto("/blog");

		await page.route("**/api/subscriptions", (route) => {
			route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({ error: "Invalid email" }),
			});
		});

		const signup = page.locator("[data-newsletter-signup]").first();
		await signup.locator('input[name="email"]').fill("bad@example.com");
		await signup.locator('button[type="submit"]').click();

		const error = signup.locator("[data-newsletter-error]");
		await expect(error).toBeVisible();
		await expect(error).toHaveText("Invalid email");
	});

	test("shows network error on fetch failure", async ({ page }) => {
		await page.goto("/blog");

		await page.route("**/api/subscriptions", (route) => {
			route.abort("connectionrefused");
		});

		const signup = page.locator("[data-newsletter-signup]").first();
		await signup.locator('input[name="email"]').fill("test@example.com");
		await signup.locator('button[type="submit"]').click();

		const error = signup.locator("[data-newsletter-error]");
		await expect(error).toBeVisible();
		await expect(error).toHaveText("Network error. Please try again.");
	});
});
