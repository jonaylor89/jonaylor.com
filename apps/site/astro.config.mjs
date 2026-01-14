// @ts-check

import mdx from "@astrojs/mdx";
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
	],

	vite: {
		plugins: [tailwindcss()],
	},

	markdown: {
		remarkPlugins: [remarkGfm],
		rehypePlugins: [rehypeHighlight],
	},
});
