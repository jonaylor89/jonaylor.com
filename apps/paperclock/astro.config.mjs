import { defineConfig } from "astro/config";

const site = process.env.PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://paperclock.jonaylor.com";

export default defineConfig({
  site,
  build: {
    inlineStylesheets: "always",
  },
  compressHTML: true,
  prefetch: true,
});
