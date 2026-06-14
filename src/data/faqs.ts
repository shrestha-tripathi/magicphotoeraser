/**
 * Single source of truth for FAQ content.
 *
 * Used by BOTH the visible FAQ accordion AND the FAQPage JSON-LD schema, so
 * the two can never drift. Google treats schema answers the visitor can't see
 * as spam — deriving both from this array guarantees parity.
 *
 * Keep answers plain-text here; the JSON-LD builder wraps them in <p>…</p>.
 * Sweet spot is 8–12 questions.
 */
export interface Faq {
  q: string;
  a: string;
}

export const faqs: Faq[] = [
  {
    q: "Is MagicPhotoEraser really free?",
    a: "Yes — completely free, forever. No Pro tier, no account, no watermark, no credits, no caps. Because every erase runs on your own device, there's no server bill to pass on to you, so there's nothing to charge for. We may show ads on info pages like this one, but the eraser itself is never gated.",
  },
  {
    q: "Do my photos get uploaded anywhere?",
    a: "No. Your photo never leaves your device. The AI model runs entirely inside your browser using WebGPU (or WASM as a fallback), so the image is processed on your own hardware. You can confirm it yourself: open your browser's Network tab while you erase — you'll see zero outbound requests carrying image data. There's no server, no account, and no analytics on your pictures.",
  },
  {
    q: "How does erasing objects in the browser actually work?",
    a: "You brush over the thing you want gone, and an on-device inpainting AI model reconstructs what was likely behind it from the surrounding pixels. Everything — decoding your image, running the model, and compositing the result — happens locally in your browser. Nothing is sent to a server.",
  },
  {
    q: "Will the rest of my photo stay sharp?",
    a: "Yes. Most free erasers shrink your whole image to a small size to run the model, then blow it back up — which softens everything. We do the opposite: we only process the small region you brushed over, then composite it back into your full-resolution original with feathered edges. The 95% of the photo you didn't touch stays pixel-for-pixel identical, so HD photos stay HD.",
  },
  {
    q: "Is there a watermark on the result?",
    a: "Never. You download the full-resolution image with no watermark, no logo, and no badge. EXIF metadata (including GPS location) is stripped on the way out for your privacy.",
  },
  {
    q: "Do I need to install anything or sign up?",
    a: "No install, no signup, no account. It's a website — open it and start erasing. On the first erase your browser downloads the AI model once (then caches it), so repeat uses are instant and work even offline.",
  },
  {
    q: "Which browsers and devices are supported?",
    a: "Any modern browser — Chrome, Edge, Firefox, and Safari on Windows, macOS, Linux, Android, and iPhone/iPad. Devices with WebGPU run fastest; everything else automatically falls back to a slower-but-working WASM path, so it still completes on mid-range phones.",
  },
  {
    q: "What can I remove from a photo?",
    a: "Unwanted objects, photobombers, an ex, trash cans, power lines, signs, text and date stamps, logos and watermarks, blemishes, or sensitive details like a license plate or ID number before sharing. It's purpose-built for removal — one job, done well.",
  },
  {
    q: "How is this different from cleanup.pictures or Pixlr?",
    a: "Those tools upload your photo to their servers and pay for GPUs, so they have to paywall HD output or add a watermark to cover costs. We run 100% on your device, which means $0 marginal cost — that's why we can be free, private, and full-resolution at the same time. Your photo also never leaves your machine, which matters for anything private.",
  },
  {
    q: "Does it work offline?",
    a: "After your first erase, the AI model is cached on your device, so yes — you can keep erasing with no internet connection. A progressive web app (installable, offline-first) is on the roadmap.",
  },
];

/**
 * Build a Google-valid FAQPage schema object from the faqs array.
 * Answers are <p>-wrapped per Google's official example.
 */
export function buildFaqSchema(items: Faq[] = faqs) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: `<p>${f.a}</p>` },
    })),
  };
}
