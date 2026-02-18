// @ts-check

import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

// https://astro.build/config
export default defineConfig({
	site: "https://jonaylor.com",
	output: "static",

	// Path-based redirects for old URLs (provider-agnostic)
	// Note: /index.html redirect handled by vercel.json to avoid build conflict
	redirects: {
		"/needle_movers.html": "/needle-movers",
		"/user_manual.html": "/user-manual",
	},

	integrations: [
		mdx({
			remarkPlugins: [remarkGfm],
			rehypePlugins: [rehypeHighlight],
		}),
		sitemap(),
	],

	vite: {
		plugins: [tailwindcss()],
		optimizeDeps: {
			exclude: ["@jonaylor89/png-db"],
		},
	},

	markdown: {
		remarkPlugins: [remarkGfm],
		rehypePlugins: [rehypeHighlight],
	},
});
