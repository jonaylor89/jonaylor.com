import { expect, test } from '@playwright/test';

test('homepage renders and lists posts', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /buried treasure/i })).toBeVisible();
  await expect(
    page.getByRole('banner').getByRole('link', { name: /about me/i }).first(),
  ).toBeVisible();

  const posts = page.locator('.blog-post-link');
  await expect(posts.first()).toBeVisible();
});
