// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  // Static, SEO-first output for Cloudflare Pages.
  site: "https://magicphotoeraser.com",
  vite: {
    plugins: [tailwindcss()],
  },
});
