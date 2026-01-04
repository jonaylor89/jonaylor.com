// @ts-check

import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

// https://astro.build/config
export default defineConfig({
	site: "https://blog.jonaylor.com",
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
