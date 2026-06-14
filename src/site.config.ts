/**
 * Single source of truth for all brand strings + site metadata.
 *
 * NEVER hardcode the brand name or domain anywhere in src/ — always import
 * from here. Every user-facing string is overridable via PUBLIC_SITE_* env
 * vars so a rebrand is a `.env`-only change (no code edits).
 *
 * Includes the `.pages.dev` rejection guard: Cloudflare Pages deploys often
 * set PUBLIC_SITE_URL / PUBLIC_SITE_DOMAIN to the *.pages.dev preview URL in
 * the dashboard, and that stale value otherwise poisons canonical/OG/sitemap
 * forever. We reject any *.pages.dev value and fall back to the real domain.
 */
const env = import.meta.env;

const DEFAULT_DOMAIN = "magicphotoeraser.com";
const DEFAULT_URL = `https://${DEFAULT_DOMAIN}`;

const rawSiteUrl = env.PUBLIC_SITE_URL ?? DEFAULT_URL;
const siteUrl = /\.pages\.dev/i.test(rawSiteUrl) ? DEFAULT_URL : rawSiteUrl;

const rawDomain = env.PUBLIC_SITE_DOMAIN ?? DEFAULT_DOMAIN;
const domain = /\.pages\.dev/i.test(rawDomain) ? DEFAULT_DOMAIN : rawDomain;

export const site = {
  /** Brand / product name. */
  name: env.PUBLIC_SITE_NAME ?? "MagicPhotoEraser",
  /** Short tagline shown in the hero + meta. */
  tagline:
    env.PUBLIC_SITE_TAGLINE ??
    "Erase anything from a photo — right in your browser.",
  /** One-sentence description for <meta description> + OG. */
  description:
    env.PUBLIC_SITE_DESCRIPTION ??
    "Remove unwanted objects, people, text, or watermarks from any photo — 100% in your browser. No upload, no signup, no watermark. Your photos never leave your device.",
  /** Bare domain (no protocol), e.g. for display + sitemap. */
  domain,
  /** Canonical site origin (protocol + domain, no trailing slash). */
  url: siteUrl,

  /** Contact email for trust pages. */
  contactEmail: env.PUBLIC_SITE_CONTACT_EMAIL ?? "hello@magicphotoeraser.com",
  /** Public GitHub repo (optional; powers "open source" links). */
  githubRepo:
    env.PUBLIC_SITE_GITHUB_REPO ??
    "https://github.com/shrestha-tripathi/magicphotoeraser",
  /** Legal jurisdiction for the Terms page governing-law clause. */
  jurisdiction: env.PUBLIC_SITE_JURISDICTION ?? "India",

  /**
   * Google Analytics 4 Measurement ID (format: G-XXXXXXXXXX). Empty string
   * disables the gtag.js snippet entirely. Only injected in production builds
   * so localhost dev never pollutes the analytics property.
   *
   * INTENTIONALLY EMPTY for now — set PUBLIC_GA_MEASUREMENT_ID (or drop the ID
   * here) once the dedicated GA4 property exists.
   */
  gaId: env.PUBLIC_GA_MEASUREMENT_ID ?? "",
} as const;

export type SiteConfig = typeof site;
