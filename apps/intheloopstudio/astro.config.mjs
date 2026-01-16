import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	vite: {
		plugins: [tailwindcss()],
	},
	build: {
		inlineStylesheets: "always",
	},
	compressHTML: true,
	prefetch: true,
});
