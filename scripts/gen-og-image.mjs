// Generate public/og-image.png — the 1200x630 social-share card.
//   node scripts/gen-og-image.mjs
//
// Dark violet card (dark beats light on every platform's chrome — see
// static-site-brand-assets). Brand mark top-left, big headline, supporting
// subline, glassy "100% IN-BROWSER" credential pill bottom-right.
//
// Text is rendered by librsvg via sharp; Liberation Sans is the metric-stable
// family available in this environment (matches the skill's glyph-advance math).
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = resolve(__dirname, "..", "public");

const W = 1200;
const H = 630;
const FONT = "Liberation Sans, Arial, sans-serif";

// Pull the master glyph (the eraser + sparkles), drop its own tile, and place
// it on the card inside our own rounded tile so it matches the favicon exactly.
const faviconSvg = readFileSync(resolve(pub, "favicon.svg"), "utf8");
// Extract just the inner glyph (everything between the bg <rect ... /> and </svg>).
const glyphInner = faviconSvg
  .replace(/^[\s\S]*?<rect width="256"[^>]*\/>/, "") // strip up to & incl. bg rect
  .replace(/<\/svg>\s*$/, "")
  .trim();

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#140a24"/>
      <stop offset="0.55" stop-color="#0d0717"/>
      <stop offset="1" stop-color="#0a0a0a"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.18" cy="0.12" r="0.9">
      <stop offset="0" stop-color="#7c3aed" stop-opacity="0.42"/>
      <stop offset="0.5" stop-color="#7c3aed" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#7c3aed" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#6d28d9"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- Brand mark (re-using the favicon glyph) + wordmark -->
  <g transform="translate(80, 78)">
    <rect width="96" height="96" rx="22" fill="url(#tile)"/>
    <g transform="scale(0.375)">${glyphInner}</g>
    <text x="122" y="40" fill="#ffffff" font-family="${FONT}" font-size="34" font-weight="700">MagicPhotoEraser</text>
    <text x="122" y="76" fill="#a78bfa" font-family="${FONT}" font-size="23" font-weight="400">magicphotoeraser.com</text>
  </g>

  <!-- Headline -->
  <text x="80" y="330" fill="#ffffff" font-family="${FONT}" font-size="76" font-weight="700">Erase anything</text>
  <text x="80" y="418" fill="#ffffff" font-family="${FONT}" font-size="76" font-weight="700">from a photo.</text>

  <!-- Subline -->
  <text x="82" y="486" fill="#c4b5fd" font-family="${FONT}" font-size="29" font-weight="400">Objects · people · text · watermarks — removed in your browser.</text>

  <!-- Credential pill (neutral glassy, bottom-right) -->
  <g transform="translate(840, 540)">
    <rect width="280" height="50" rx="25" fill="#ffffff" fill-opacity="0.10" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1"/>
    <circle cx="34" cy="25" r="6" fill="#22c55e"/>
    <text x="58" y="33" fill="#ffffff" font-family="${FONT}" font-size="19" font-weight="700" letter-spacing="1.2">100% IN-BROWSER</text>
  </g>
</svg>`;

async function main() {
  await sharp(Buffer.from(card)).png().toFile(resolve(pub, "og-image.png"));
  console.log("✓ og-image.png (1200x630)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
