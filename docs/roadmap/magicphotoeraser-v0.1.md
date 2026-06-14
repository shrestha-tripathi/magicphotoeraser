# MagicPhotoEraser — v0.1 Roadmap / Design Spec

**Status:** ✅ Implementation-ready (all 4 open questions resolved 2026-06-14)
**Author:** session 2026-06-14
**Domain:** magicphotoeraser.com (**bought** ✓)
**Related skills:** `local-first-ai-pwa`, `segment-anything-model`, `astro-microtool-scaffold`,
`cloudflare-pages-noindex-headers`, `static-site-trust-pages`, `pwa-install-custom-prompt`
**Sibling projects (pattern donors):** `~/projects/alwaysontopnotes` (Astro+island+IDB),
`~/projects/p2pdatesharing` (FTN — PWA, CF Pages), `~/projects/heicpix` (client-side image proc)
**Estimated work:** Phase 0–1 ≈ 1,200–1,600 LOC across ~7 commits (~1 wk); full v0.1 (Ph 0–4) ≈ 3 wks
**Risk:** Medium-high (model quality at high-res + WebGPU portability are the two real unknowns)
**Monetization:** **None — free forever, no paywall, no account.** AdSense-ready trust pages are
the only optional revenue path (same posture as AOTN), never feature-gating.

---

## Problem

People constantly need to **remove something from a photo**: a photobomber, an ex,
a license plate, a trash can, a date stamp, a logo, a stray finger, an ID number
before sharing. Today the options all hurt:

| Friction | Concrete example |
|---|---|
| **Upload-to-server tools** (cleanup.pictures, Pixlr, Fotor) | Your private photo (medical scan, ID card, kid, ex) gets uploaded to a stranger's GPU. The privacy claim is "trust us." |
| **HD is paywalled** | cleanup.pictures erases free at low-res, then charges for anything sharp. The free output is deliberately soft. |
| **Watermarks / signups** | Most "free" erasers slap a watermark or gate behind an account + credits. |
| **Desktop apps** (Photoshop Generative Fill, Inpaint by Teorex) | $20+/mo or a paid install; overkill for "erase this one thing." |
| **Existing OSS** (inpaint-web) | Genuinely client-side, but it's a rough tech demo — no SEO, no mobile polish, no click-to-select, no product. |

There is **no polished, free, fully-private, no-signup, no-watermark, browser-native
object eraser**. That gap is the whole product.

## Why this fits the June-2026 structural-moat filter

After HEICPix got cloned (fixheic.com, heicimg.com) you explicitly want builds with a
**structural moat**, not duplicable weekend microtools. MagicPhotoEraser qualifies:

1. **Multi-model on-device AI orchestration is hard to clone.** Running segmentation
   (SAM) → mask → inpainting (LaMa/MI-GAN) entirely in-browser, with WebGPU memory
   management, high-res crop-bbox compositing, and a WASM fallback, is real engineering.
   A weekend cloner can wrap a hosted API; they can't easily reproduce a polished
   *client-side* pipeline.
2. **The privacy claim is TRUE and emotionally load-bearing here.** "Your photos never
   leave your device" matters far more for an ID card or a private photo than for a
   HEIC convert. It's a real wedge against every upload-based competitor, not marketing.
3. **$0 marginal cost → genuinely free forever is itself the moat.** No GPU bill per
   erase means we can be free, no-watermark, no-signup, no-cap — permanently. Every
   incumbent has a server bill, so they MUST paywall HD or watermark. We structurally
   don't. "Free + private + sharp HD" is a position no upload-based competitor can match
   without rebuilding their whole cost structure.
4. **India-market angle:** free, no signup, no subscription, works on mid-range devices
   via WASM fallback, works offline after first load (PWA).

## Feasibility — validated, not assumed

- **`lxfater/inpaint-web` (5.8k⭐, 678 forks)** ships LaMa inpainting + image upscaling
  **fully in-browser via WebGPU + WASM, no server.** Proves the core premise outright.
- **cleanup.pictures** proved the *product* demand and the exact UX (brush → erase),
  but does HD server-side — our wedge is doing it locally AND free.
- **MobileSAM / SAM ONNX** ports run the "click an object → get a mask" magic in-browser
  (see the `segment-anything-model` skill; community onnxruntime-web + transformers.js
  ports exist). This is the "magic" in MagicPhotoEraser — slated for Phase 2.
- **onnxruntime-web** with the WebGPU execution provider (+ WASM fallback) is the proven
  runtime spine; the `local-first-ai-pwa` skill already documents the WebGPU adapter
  probe, lazy chunking, and model-caching patterns.

---

## Design options — A. App architecture / stack

This is an AI-heavy **canvas editor** (upload, brush, model lifecycle, before/after),
but magicphotoeraser.com ALSO needs to rank for "remove object from photo free" — so
SEO landing pages matter as much as editor ergonomics.

### Option A1 — Pure Astro 6 + vanilla-TS island (AOTN model)
SEO pages + the editor as one big `<script>` island, vanilla DOM/canvas.

| Pros | Cons |
|---|---|
| Maximal SEO, smallest JS, matches AOTN muscle memory | A stateful canvas editor (brush, mask history, multi-model load states, progress) in vanilla TS is genuinely painful |
| One deploy, one mental model | Re-inventing React-shaped state by hand |

### Option A2 — Astro 6 SEO shell + a React island for the editor (recommended)
Astro owns `/`, `/how-it-works`, `/faq`, `/compare`, trust pages (static, fast, SEO).
The `/app` editor is a React island (`client:only="react"`), Vite-bundled by Astro.

| Pros | Cons |
|---|---|
| SEO pages stay static + fast; editor gets React ergonomics for complex canvas state | Two interaction models in one repo (Astro pages + React island) |
| Reuses the `local-first-ai-pwa` React patterns (WebGPU probe, lazy chunks) directly | Slightly heavier `/app` bundle than vanilla |
| Cloudflare Pages serves native COOP/COEP via `_headers` — no coi-serviceworker hack | — |

### Option A3 — Pure Vite + React SPA (local-first-ai-pwa model)
Single React SPA, prerender the marketing routes with a plugin.

| Pros | Cons |
|---|---|
| Best editor DX, the skill's reference stack | Weakest SEO (SPA prerender is a fight); diverges from your Astro-first portfolio; loses Astro's free image/SEO tooling |

### Comparison

|  | A1 Astro+vanilla | A2 Astro+React island | A3 Vite SPA |
|---|---|---|---|
| SEO (landing) | ✅ Best | ✅ Best | ⚠️ Needs prerender hack |
| Editor DX (canvas+model state) | ❌ Painful | ✅ Good | ✅ Best |
| Reuse `local-first-ai-pwa` patterns | ⚠️ Partial | ✅ Full | ✅ Full |
| Portfolio consistency | ✅ | ✅ | ❌ |
| CF Pages COOP/COEP native | ✅ | ✅ | ✅ |
| **Verdict** | Too painful for editor | **✅ Recommended** | SEO tax not worth it |

**Chosen: A2 — Astro 6 SEO shell + React editor island, Cloudflare Pages.**

---

## Design options — B. The AI pipeline (the actual product)

All model options below ship as **free quality toggles** — there is no paid tier.

### Option B1 — LaMa only, brush-painted mask
User paints a mask with a brush; LaMa inpaints. Exactly inpaint-web's approach.

| Pros | Cons |
|---|---|
| Proven, simplest, the v1 core | Painting a precise mask by hand is fiddly; "magic" is only in the fill, not the selection |

### Option B2 — Phased: MI-GAN (fast) + LaMa (quality) + MobileSAM (click-select) — recommended
- **MI-GAN** (ICCV'23, mobile-grade, ~small, fast) = the default fast eraser.
- **LaMa** (big-lama ONNX) = the quality toggle for tricky textures (free).
- **MobileSAM** = "click the object, we auto-select it" → the signature *magic* (Phase 2).

| Pros | Cons |
|---|---|
| The click-to-select is the genuine "wow" + the name's promise | 2–3 models to orchestrate + cache (memory, download size) |
| Phaseable: ship LaMa/MI-GAN-brush first, add SAM as the v2 headline | SAM adds ~40MB + an encoder pass per image |
| Fast vs quality are just two free model buttons — simple mental model | — |

### Option B3 — Stable-Diffusion generative fill (free WebGPU-only stretch)
SD-1.5-inpaint / LCM in-browser via WebGPU — fills with *new plausible content*, not
just removal (e.g. extend a background, reconstruct complex scenes).

| Pros | Cons |
|---|---|
| Highest-end "generative fill" — a real headline differentiator | ~1–2GB download, WebGPU-only, slow (seconds–tens of seconds), OOM risk on mobile |
| Free + on-device generative fill is genuinely rare | Too heavy/risky for v1; v4 stretch goal, gated on capable WebGPU only |

### Comparison

|  | B1 LaMa-brush | B2 MI-GAN+LaMa+SAM | B3 SD generative |
|---|---|---|---|
| "Magic" selection UX | ❌ manual paint | ✅ click-to-select | ✅ |
| Model footprint | ~50–200MB | ~90–240MB phased | +1–2GB |
| Mobile-viable | ✅ (WASM) | ✅ (MI-GAN fast tier) | ❌ |
| Ships v1 fast | ✅ | ✅ (phased) | ❌ |
| Headline "wow" | weak | strong (SAM + HD) | strongest |
| **Verdict** | v1 core only | **✅ Recommended (phased)** | v4 stretch |

**Chosen: B2 — phased multi-model.** Brush+MI-GAN/LaMa is the v1 floor; MobileSAM
click-select is the v2 headline; SD generative fill is a v4 free WebGPU-only stretch.

---

## Chosen approach

```
                          magicphotoeraser.com  (Cloudflare Pages, static)
   ┌───────────────────────────────────────────────────────────────────────┐
   │  Astro 6 SEO shell                                                      │
   │  /  /how-it-works  /faq  /compare  /about /privacy /terms  + JSON-LD    │
   │                                                                         │
   │   ┌──────────────────  /app  (React island, client:only) ───────────┐  │
   │   │  Upload → Canvas → [Brush mask | Click-select (SAM, v2)] → Erase │  │
   │   │            │            │                    │           │       │  │
   │   │            ▼            ▼                    ▼           ▼       │  │
   │   │  ┌───────────────┐  ┌──────────┐  ┌──────────────┐ ┌─────────┐ │  │
   │   │  │ image decode  │  │ MobileSAM│  │  MI-GAN/LaMa │ │ before/ │ │  │
   │   │  │ + EXIF strip  │  │ encoder  │  │  inpaint ORT │ │ after   │ │  │
   │   │  └───────────────┘  │ +decoder │  │  WebGPU/WASM │ │ slider  │ │  │
   │   │                     └──────────┘  └──────────────┘ └─────────┘ │  │
   │   │   Model cache: Cache API + IndexedDB   ·   onnxruntime-web      │  │
   │   └───────────────────────────────────────────────────────────────┘  │
   │                                                                         │
   │  public/_headers → COOP:same-origin + COEP:require-corp (SAB native)   │
   └───────────────────────────────────────────────────────────────────────┘
        NOTHING leaves the device. No backend. No API key. No upload. Free forever.
```

### The load-bearing technical insight: crop-bbox inpainting, not whole-image

LaMa/MI-GAN are trained near **512px**; naively downscaling a 12-MP phone photo to 512,
erasing, and upscaling back destroys the whole image's sharpness. The fix that makes
free HD viable **without** server-side tiling:

> **Only inpaint the masked region.** Crop a padded bounding box around the user's mask,
> resize *that crop* to the model resolution, inpaint it, then composite the result back
> into the **full-resolution original** with feathered mask edges. The 95% of the image
> the user didn't touch stays pixel-perfect; only the erased patch is model-processed.

This is the difference between "free tool that softens your photo" (cleanup.pictures free
tier) and "free tool that keeps your photo sharp." It's the #1 quality lever and the
entire reason we can give away sharp HD that competitors paywall. Multi-tile blending for
very large masks is the natural extension (Phase 3).

### Everything is free forever

No Pro tier, no account, no watermark, no credits, no caps. Every model (MI-GAN, LaMa,
and later SAM + SD generative fill) is a free toggle. The only optional monetization is
**AdSense on the marketing/landing pages** (same posture as AOTN — ship AdSense-ready
privacy/terms copy, never gate the tool itself). Because marginal cost is $0, "free
forever" is sustainable indefinitely and is itself the competitive position.

---

## Migration plan — phased, commit-sized

### Phase 0 — Scaffold + SEO shell (~3 commits)
1. Astro 6 + TW v4 scaffold (pin trap from `astro-microtool-scaffold`), `site.config.ts`
   brand-env, GA4 wiring (its **own** GA4 id, not the shared worksoffline one), `_headers`
   (COOP/COEP + `.pages.dev` noindex).
2. Landing page: hero (before/after demo gif), mechanism animation, FAQ + JSON-LD,
   `/compare` vs cleanup.pictures (privacy + free-HD-forever angle).
3. Trust pages (`static-site-trust-pages`): about/contact/privacy/terms (AdSense-ready),
   sitemap, robots, OG image, favicon pack.

**Scope:** ~600 LOC · **Risk:** Low (well-trodden Astro path).

### Phase 1 — Core eraser MVP (~4 commits) ← the product floor
4. `/app` React island: upload (drag-drop/paste/picker), canvas render, EXIF strip on load.
5. Brush mask layer (size slider, add/erase mask, undo/redo of mask strokes).
6. onnxruntime-web integration + **MI-GAN** model, WebGPU-probe + WASM fallback, model
   download progress UI, Cache-API/IndexedDB model caching.
7. **Crop-bbox inpaint pipeline** + composite-back + before/after slider + download
   (PNG/JPG, EXIF-stripped). First shippable, demoable erase. **Launch v0.1 here.**

**Scope:** ~700 LOC · **Risk:** Medium (WebGPU portability, first-load size).

### Phase 2 — The "magic": click-to-select (~3 commits) ← the headline beat
8. MobileSAM encoder/decoder via ORT; click → embedding → mask; cache the per-image
   encoder pass.
9. Selection UX: click-add / shift-click-subtract / box-select; merge SAM mask into the
   brush mask layer so both paths feed one eraser.
10. "Erase selected" one-click flow; the headline feature + demo video.

**Scope:** ~500 LOC · **Risk:** Medium-high (SAM mask quality + memory on mobile).

### Phase 3 — HD quality + PWA (~3 commits)
11. LaMa quality model behind a free model-picker; multi-tile blending for large masks.
12. Installable PWA + offline app-shell (`pwa-install-custom-prompt`; reuse AOTN/FTN SW).
13. Onboarding tour, keyboard shortcuts, dark/light themes, batch queue (free).

**Scope:** ~500 LOC · **Risk:** Medium (multi-tile blending edge-seams).

### Phase 4 — Generative-fill stretch (~2 commits, optional)
14. SD-inpaint generative fill, WebGPU-only, gated on a real capability probe (skips on
    WASM/mobile with a clear "needs a desktop GPU" note). Free.
15. Polish, model-size selector, low-memory device guards.

**Scope:** ~400 LOC · **Risk:** High (SD footprint + OOM); strictly optional stretch.

Each commit is independently revertible and shippable. Phases 0–1 alone = a launchable,
genuinely-better-than-incumbent free tool. No licensing/checkout commits exist — the
whole product is free.

---

## Non-goals (v0.1)

- **No server, ever.** No upload, no hosted inference, no auth backend. If a feature
  can't run on-device, it's out of scope (this is the whole moat).
- **No monetization that gates the tool.** No Pro tier, no account, no watermark, no
  credits, no caps. AdSense on marketing pages is the only optional revenue path.
- **No general photo editor.** Not crop/filters/layers/text. One job: remove objects.
  (Brightness/crop creep dilutes the wedge and the SEO.)
- **No account system / login.**
- **No video.** Stills only in v0.1 (video inpainting is a separate, much larger product).
- **No mobile-app store builds.** PWA install only.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| High-res output looks soft (model is 512px) | High | Kills the core promise | **Crop-bbox inpaint + composite into full-res original** (the #1 lever); multi-tile blend for big masks (Phase 3) |
| WebGPU absent/broken (Safari, old Android, Win Chrome null-adapter) | High | No/slow erase | Real `requestAdapter()` probe (skill), WASM fallback, MI-GAN as the light default; gate SD on WebGPU-only with a tooltip |
| First-load model download (50–200MB) feels broken | Medium | Bounce on first use | Progress bar, smallest model first (MI-GAN), Cache-API persist so it's one-time, lazy-load only on first erase |
| Mobile OOM on large image + model | Medium | Tab crash | Cap input long-edge (e.g. 4096) for processing, free tensors, tile, downscale harder on low-memory devices |
| SAM mask quality poor on cluttered scenes | Medium | "Magic" underwhelms | Always allow brush touch-up of the SAM mask; Phase 1 ships brush-only so the floor never depends on SAM |
| ONNX model licensing (commercial/redistribution) | Medium | Legal/repaint | Verify each model's license (LaMa weights, MI-GAN, MobileSAM) BEFORE shipping; prefer Apache/MIT exports; document provenance. (Still matters even though the app is free — redistribution terms apply.) |
| Cloned | Low | Reputation only (no revenue to lose) | Moat is polish + on-device pipeline + brand/SEO/first-mover; being free removes the cloner's price wedge entirely |

## Open questions — ALL RESOLVED (2026-06-14)

1. **Default free model — MI-GAN vs LaMa?** → **MI-GAN as the default** (fast, small,
   best first-load + mobile); **LaMa as a free quality toggle**. Confirm with a
   side-by-side erase test at Commit 6.
2. **MobileSAM in v1 or v2?** → **v2.** Phase 1 ships brush-only (lower risk, still
   launchable); SAM click-select becomes the Phase 2 headline launch beat.
3. **Monetization?** → **Completely free forever. No Pro, no paywall, no account.**
   AdSense-ready trust pages only; never gate the tool. (User confirmed twice.)
4. **Domain?** → **magicphotoeraser.com is bought.** Brand/`site.config.ts`/OG/GA4 wired
   correctly from Phase 0 commit 1.

## Success criteria (v0.1 = Phases 0–1 shipped)

1. Open magicphotoeraser.com on a laptop, drag in a 12-MP photo, brush over a trash can,
   click Erase → trash can gone, **rest of the photo still pixel-sharp**, in < ~10s.
2. DevTools → Network during an erase shows **zero** outbound requests with image data.
3. Download the result → it's full-resolution, **no watermark**, EXIF stripped, free.
4. Same flow works on a mid-range Android (WASM fallback) — slower but completes without
   crashing.
5. Lighthouse SEO ≥ 95 on the landing page; "remove object from photo" intent pages
   indexed with FAQ rich results.

When all five hold, v0.1 ships and we open the Phase 2 (SAM "magic") beat.

## Appendix — why not just wrap a hosted inpainting API?

- **Kills the moat + the privacy claim** (the two reasons this beats cleanup.pictures).
- **Reintroduces marginal cost** → can't be free forever; forces a paywall.
- **Clonable in a weekend** — exactly the trap the June filter exists to avoid.

On-device is harder, and that difficulty *is* the defensibility. Free + private +
sharp-HD is a position no upload-based competitor can structurally match.
