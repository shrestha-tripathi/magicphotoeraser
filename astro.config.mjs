// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  // Static, SEO-first output for Cloudflare Pages.
  site: "https://magicphotoeraser.com",
  // Cloudflare Pages 308-redirects /foo -> /foo/ and serves the 200 only at
  // the slash form. Emitting trailing slashes everywhere (pages -> /foo/index.html,
  // so Astro.url.pathname carries the slash) keeps our canonical, sitemap, and
  // breadcrumb URLs aligned with what Cloudflare serves — otherwise Google logs
  // "Page with redirect" + "Alternate page with proper canonical tag". Also makes
  // the dev server match prod (default "ignore" accepts both, hiding the mismatch).
  trailingSlash: "always",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
