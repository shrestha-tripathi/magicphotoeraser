// Generate the full favicon / PWA icon pack from public/favicon.svg.
//   node scripts/gen-icons.mjs
//
// Outputs (all in public/):
//   favicon.ico            multi-res 16/32/48 REAL ICO (png-to-ico)
//   favicon-32.png         explicit 32px PNG (declared in <head>)
//   icon-192.png           PWA
//   icon-512.png           PWA + schema Organization.logo
//   icon-512-maskable.png  PWA maskable (extra safe-zone padding)
//   apple-touch-icon.png   iOS home screen (180, opaque bg)
//
// The master favicon.svg is violet-tile + white glyph, so NO recolor step is
// needed (the silent #000-recolor bug only bites monochrome source SVGs).
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pub = resolve(__dirname, "..", "public");
const svg = readFileSync(resolve(pub, "favicon.svg"));

const VIOLET = "#7c3aed"; // tile bg, used to flatten apple-touch (no alpha on iOS)

// Render the square tile SVG at a given size (transparent corners preserved).
const render = (size) => sharp(svg).resize(size, size).png();

// Maskable: Android crops to a circle/squircle, so the tile must be inset.
// Our glyph already sits inside a rounded tile, so we scale the whole SVG to
// ~80% and center it on a full-bleed violet square (the tile colour) so the
// crop never bites into the glyph.
async function renderMaskable(size) {
  const inner = Math.round(size * 0.8);
  const glyph = await render(inner).toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: VIOLET,
    },
  })
    .composite([{ input: glyph, gravity: "center" }])
    .png();
}

// apple-touch needs an OPAQUE background (iOS ignores alpha, shows black).
async function renderAppleTouch(size) {
  const glyph = await render(size).toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: VIOLET },
  })
    .composite([{ input: glyph, gravity: "center" }])
    .png();
}

async function main() {
  // Standard square PNGs (transparent corners).
  await render(192).toFile(resolve(pub, "icon-192.png"));
  await render(512).toFile(resolve(pub, "icon-512.png"));
  await render(32).toFile(resolve(pub, "favicon-32.png"));
  console.log("✓ icon-192 / icon-512 / favicon-32");

  // Maskable + apple-touch (opaque).
  await (await renderMaskable(512)).toFile(resolve(pub, "icon-512-maskable.png"));
  await (await renderAppleTouch(180)).toFile(resolve(pub, "apple-touch-icon.png"));
  console.log("✓ icon-512-maskable / apple-touch-icon");

  // REAL multi-resolution .ico (NOT a renamed PNG — see static-site-brand-assets).
  const ico16 = await render(16).toBuffer();
  const ico32 = await render(32).toBuffer();
  const ico48 = await render(48).toBuffer();
  const ico = await pngToIco([ico16, ico32, ico48]);
  writeFileSync(resolve(pub, "favicon.ico"), ico);
  console.log(`✓ favicon.ico (multi-res 16/32/48, ${(ico.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
