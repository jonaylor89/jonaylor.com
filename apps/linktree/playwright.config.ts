import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	timeout: 30_000,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:4323",
	},
	webServer: {
		command: "pnpm run dev --host 127.0.0.1 --port 4323",
		url: "http://127.0.0.1:4323/",
		reuseExistingServer: true,
		timeout: 120_000,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
