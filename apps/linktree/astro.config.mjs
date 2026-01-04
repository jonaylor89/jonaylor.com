// @ts-check

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
	site: "https://linktree.jonaylor.com",
	image: {
		service: {
			entrypoint: "astro/assets/services/noop",
		},
	},
	vite: {
		plugins: [tailwindcss()],
	},
	build: {
		inlineStylesheets: "auto",
	},
	compressHTML: true,
});
