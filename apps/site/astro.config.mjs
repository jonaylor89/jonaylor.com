// @ts-check

import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

// https://astro.build/config
export default defineConfig({
	site: "https://jonaylor.com",
	output: "static",

	// Path-based redirects for old URLs
	// Note: /index.html redirect handled by public/_redirects for Cloudflare Pages
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

	fonts: [
		{
			provider: fontProviders.google(),
			name: "Figtree",
			cssVariable: "--font-figtree",
			weights: [400],
			styles: ["normal"],
			subsets: ["latin"],
			fallbacks: ["system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "PT Serif",
			cssVariable: "--font-pt-serif",
			weights: [400, 700],
			styles: ["normal"],
			subsets: ["latin"],
			fallbacks: ["Georgia", "Cambria", "Times New Roman", "Times", "serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-jetbrains-mono",
			weights: [400, 500, 600],
			styles: ["normal"],
			subsets: ["latin"],
			fallbacks: ["SFMono-Regular", "Menlo", "Monaco", "Consolas", "Courier New", "monospace"],
		},
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
