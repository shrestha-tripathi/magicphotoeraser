import type { APIRoute } from "astro";
import { absoluteUrl } from "../site.config";

/**
 * Dynamic sitemap.xml — single source of truth for indexable routes.
 *
 * /app is intentionally EXCLUDED (it's noindex + Disallow in robots.txt).
 * Base URL comes from site.url, which already applies the .pages.dev rejection
 * guard, so preview deploys never leak a *.pages.dev host into the sitemap.
 *
 * Priorities follow the trust-pages convention:
 *   home 1.0 · core marketing 0.8 · about 0.7 · contact 0.5 · legal 0.3
 */
interface Route {
  path: string;
  priority: string;
  changefreq: string;
}

const routes: Route[] = [
  { path: "/", priority: "1.0", changefreq: "weekly" },
  { path: "/how-it-works", priority: "0.8", changefreq: "monthly" },
  { path: "/compare", priority: "0.8", changefreq: "monthly" },
  { path: "/faq", priority: "0.7", changefreq: "monthly" },
  { path: "/about", priority: "0.7", changefreq: "monthly" },
  { path: "/contact", priority: "0.5", changefreq: "yearly" },
  { path: "/privacy", priority: "0.3", changefreq: "yearly" },
  { path: "/terms", priority: "0.3", changefreq: "yearly" },
];

export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);

  const urls = routes
    .map(
      (r) => `  <url>
    <loc>${absoluteUrl(r.path)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
  </url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
};
