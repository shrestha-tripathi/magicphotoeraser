# MagicPhotoEraser — Phase 2 RFC: Click-to-Select (SlimSAM)

> **Status:** APPROVED — D1/D2/D3 signed off by Shrestha Jun 2026. Building commit 10.
> **Phase goal:** Replace "manually brush every pixel of the object" with "click the
> object once, we select it for you." This is the headline beat the product name
> *Magic*PhotoEraser promises. Brush stays as the fallback/refinement tool.

## ✅ Resolved decisions (the contract)

- **D1 = Raw onnxruntime-web** (reuse the c7 spine). NOT Transformers.js — avoids
  shipping two ORT runtimes in one COEP-isolated app. We hand-roll SAM pre/post-processing
  (~70 lines, mirrors the MI-GAN CHW pack). One runtime, one pin story, one CDN config.
- **D2 = fp32 `vision_encoder.onnx` (23.3 MB)** — best segmentation quality, fits under the
  25 MiB Cloudflare per-asset cap (NO sharding). Decoder = fp32 `prompt_encoder_mask_decoder.onnx`
  (16.6 MB). Quantized variants are a Phase-2.2 low-memory fallback, not 2.0.
- **D3 = Auto-select is the DEFAULT mode**, brush is the toggle. Lead with the headline
  feature; both write into the same mask buffer so users can click-then-brush-refine.

## 1. Why this is the marquee feature

Today the user must carefully paint over the whole object — tedious, and (per the c7
finding) under-painting leaves ghosts. Click-to-select flips it: **one tap → the AI
proposes a pixel-perfect mask of the object under the cursor.** The mask then feeds the
*exact same* MI-GAN inpaint pipeline we already ship. Segmentation replaces the brush as
the mask *source*; everything downstream (dilation, inpaint, compare, download) is untouched.

This is what every "magic eraser" (Google Pixel, Samsung, cleanup.pictures' paid tier)
does. Doing it **100% on-device** is the moat — same story as the eraser itself.

## 2. Model choice — SlimSAM-77 (VERIFIED + EMPIRICALLY PROBED)

Researched live against HuggingFace + **probed under python onnxruntime 1.24** (c7 discipline)
Jun 2026. **Recommendation: `Xenova/slimsam-77-uniform`.**

### ⭐ EMPIRICAL I/O CONTRACT (probed, NOT assumed — the Transformers.js export differs HARD from Meta SAM)

> 🩸 **This is why we probe.** The Xenova/transformers.js export signature is **completely
> different** from the "official" Meta `segment-anything` ONNX most blog posts use. Coding
> against the Meta signature (mask_input / has_mask_input / orig_im_size inputs) would have
> failed at runtime. The REAL contract, verified by `InferenceSession.get_inputs()` + a full
> working inference:

**Encoder — `vision_encoder.onnx`** (23,276,014 B = 22.2 MiB, under CF cap ✓):
```
IN   pixel_values                f32  [1, 3, 1024, 1024]
OUT  image_embeddings            f32  [1, 256, 64, 64]
OUT  image_positional_embeddings f32  [1, 256, 64, 64]   ← BOTH outputs feed the decoder
```

**Decoder — `prompt_encoder_mask_decoder.onnx`** (16,557,892 B = 15.8 MiB, under CF cap ✓):
```
IN   input_points                f32   [1, 1, N, 2]     (x,y) in 1024-space; 4-D not 3-D!
IN   input_labels                int64 [1, 1, N]        1=fg, 0=bg, -1=pad  (int64 NOT f32!)
IN   image_embeddings            f32   [1, 256, 64, 64]
IN   image_positional_embeddings f32   [1, 256, 64, 64] ← the encoder's 2nd output
OUT  iou_scores                  f32   [1, 1, 3]
OUT  pred_masks                  f32   [1, 1, 3, 256, 256]  ← RAW LOGITS, threshold > 0
```
- **NO** `mask_input` / `has_mask_input` / `orig_im_size` inputs (Meta SAM has all three; this
  export bakes them away). N = number of click points.
- **Mask select:** `argmax(iou_scores)` → pick that channel of the 3. (Verified: clicking a
  synthetic object gave iou `[0.71, 0.98, 0.98]`, best idx 2, **mask IoU 1.000 vs ground truth**.)

### Preprocessing (verified from `preprocessor_config.json` = `SamImageProcessor`)
1. RGB, 2. **resize so LONGEST edge = 1024** (bilinear, preserves aspect), 3. rescale ×1/255,
4. normalize ImageNet `mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225]`, 5. **pad bottom+right
to 1024×1024** (top-left anchored, pad value 0 pre-norm).

### ⭐ Coordinate transform (THE landmine — verified on a non-square 1200×600 image)
Because padding is **bottom-right only** (no centering), the transform is a pure uniform scale:
```
scale       = 1024 / max(srcW, srcH)
click→model: (mx, my) = (sx * scale, sy * scale)
mask→source: 256-space → ×4 → 1024-space → drop padded region (x≥srcW*scale or y≥srcH*scale)
                       → ÷scale → source pixel
```
Verified: 1200×600 img, click src (875,325) → model (746.7,277.3) → mask back-projects to
src bbox x[802..947] y[248..394] vs object x[800..950] y[250..400], centroid (874,323) vs
(875,325). **Near pixel-perfect.**

| | encoder | decoder | total | license |
|---|---|---|---|---|
| **SlimSAM-77** (rec) | 23.3 MB fp32 / 8.88 MB uint8 | 16.6 MB fp32 / 4.9 MB uint8 | ~40 MB fp32 | **Apache-2.0** ✅ |
| MobileSAM | ~28–40 MB encoder | ~16 MB | larger | Apache-2.0 |
| EdgeSAM | smaller | smaller | tiny | non-commercial ⚠️ |

Why SlimSAM-77 wins **for this project specifically**:
- **Both files fit UNDER the 25 MiB Cloudflare Pages per-asset cap** (22.2 + 15.8 MiB) →
  NO sharding gymnastics (unlike the MI-GAN 28 MB → 2-shard dance).
- **Apache-2.0** weights AND ONNX exports — clean commercial redistribution.
- It is the **Transformers.js-canonical export** → contract is battle-tested (we still probed it).
- Quantized variants (8.88 + 4.9 MB) exist for a future "lite" mobile path.

## 3. ⭐ D1 — Runtime: raw onnxruntime-web vs Transformers.js  (NEEDS YOUR CALL)

This is the one real architectural fork. SlimSAM's "official" API is `@huggingface/transformers`
(Transformers.js). But we already run a hand-built ORT spine from c7.

| | **A. Raw onnxruntime-web** (reuse c7 spine) | **B. Transformers.js** (`@huggingface/transformers`) |
|---|---|---|
| New deps | **zero** — reuse `capabilities.ts`/`modelCache.ts`/ORT 1.26.0 | +1 big dep (~1–3 MB JS) that **bundles its OWN onnxruntime-web** |
| ORT instances | **one** (our pinned 1.26.0) | **two** ORT runtimes in one app (theirs + ours) → double WASM load, version skew risk |
| COEP / CDN wasmPaths | already solved, reused as-is | TJS loads its own wasm; must re-prove it passes our COEP:require-corp |
| Preprocessing | we hand-roll resize-to-1024 + normalize (~40 lines) | `AutoProcessor` does it (off-the-shelf) |
| Postprocessing | we hand-roll mask upscale + threshold (~30 lines) | `post_process_masks` does it |
| vite 7.3.5 pin | untouched | TJS may drag transitive deps that fight the pin |
| Fits project conventions | ✅ matches c7 exactly + the "raw canvas, no konva" precedent | ✗ introduces a parallel ML stack |

**My recommendation: A (raw onnxruntime-web).** It's the *less* off-the-shelf choice, which
normally cuts against your stated preference — but here the "library" (TJS) would **duplicate
the carefully-pinned ORT/COEP/WebGPU/cache infrastructure we already built and verified in c7**,
and shipping two onnxruntime-web instances in one COEP-isolated app is a real footgun (double
~10 MB wasm, potential `ort.env` collisions). The SAM pre/post-processing we'd hand-roll is
small, well-documented, and mirrors what we already do for MI-GAN's CHW pack. We keep ONE ML
runtime, one pin story, one CDN config.

If you'd rather optimize for "least code we maintain" over "one clean runtime," B is defensible —
say the word and I'll spec it instead. **This is D1.**

## 4. UX design — the click flow

```
Upload ─▶ [Auto-select mode]  ◀default        [Brush mode]  ◀fallback/refine
            │                                     │
   user CLICKS the object                  user paints (Phase 1 brush, unchanged)
            │
   encoder runs ONCE per image (cached) ── "Analyzing photo…" ~1–3 s first click only
            │
   decoder runs per click (~50–150 ms) ─▶ mask preview overlays instantly
            │
   [+] click = add region   [−] alt/right-click = subtract region (SAM multi-point refine)
            │
   "Erase" ─▶ existing dilate → MI-GAN → compare → download   (Phase 1, untouched)
```

Key decisions baked in (flag if you disagree):
- **Encode-once / decode-per-click.** The encoder is the heavy step (~1–3 s); it runs the
  first time the user clicks on a given image and the embedding is cached for that image.
  Every subsequent click is just the tiny decoder (~ms) → feels instant. Re-encode only on
  image replace.
- **Auto-select is the default mode**, brush is a toggle. Both write into the *same* mask
  buffer, so a user can click to select then brush-refine the edges — best of both.
- **Multi-point refinement:** positive click = "include this", negative click = "exclude
  this" (SAM's native `point_labels` 1/0). Lets users fix a greedy selection without brushing.
- **Mask candidate toggle:** SAM returns 3 masks (whole/part/subpart). Default to highest-IoU;
  optionally let power users cycle them (small "⊙ ◑ ◔" control). *Phase 2.2, not 2.0.*

## 5. Commit breakdown (~3 commits, each independently shippable)

- **commit 10 — SAM runtime spine + single-click select.** New `src/app/segment/`:
  `samSource.ts` (fetch+cache encoder & decoder, reuse `modelCache.ts` IDB), `samSession.ts`
  (lazy ORT sessions, encode-once embedding cache), `preprocess.ts` (resize-to-1024 +
  normalize + coord transforms), `runSegment.ts` (decoder per-click → upscale → threshold →
  write into the existing source-res mask). EraserApp gains an **Auto-select / Brush** mode
  toggle; a click in auto mode produces a mask the existing Erase consumes. **Ship = click an
  object, it gets selected, Erase removes it.** ~the c7-sized heavy commit.
- **commit 11 — multi-point refine + mask preview polish.** Positive/negative points,
  live mask-preview overlay (distinct style from brush), "clear selection", keyboard a11y,
  the encode progress UI ("Analyzing photo…"). Mobile tap handling.
- **commit 12 — candidate-mask cycling + onboarding + perf.** 3-mask toggle, first-run
  "click to select" hint (reuse `zero-dep-onboarding-tour`), WebGPU/WASM perf pass,
  quantized-encoder fallback on low-memory devices, lazy-load so /app initial bundle unchanged.

## 6. Technical landmines to verify empirically (the c7 discipline)

1. **Coordinate spaces.** Three of them: display canvas px → source-image px → SAM 1024-space.
   Off-by-one here = mask lands in the wrong spot. Verify with a known-object click, ground-truth
   the mask centroid (pixel-sample, don't eyeball).
2. **Mask polarity into the inpaint pipeline.** SAM mask = `1`/true = object. Our inpaint wants
   `0` = erase (verified c7). So `samMask → eraseRegion` must invert, then the existing
   `dilateErase` + `packMaskInverted` run as-is. Measure end-to-end on one real erase.
3. **Encoder under WebGPU.** Confirm the ViT encoder runs under our WebGPU EP (some ViT ops fall
   back to WASM). If WebGPU chokes, WASM still works (slower encode). Measure both; don't assume.
4. **Embedding cache lifetime.** The `[1,256,64,64]` f32 embedding is ~4 MB — keep ONE per
   current image, free on replace (mirror the c8 `originalBitmapRef` discipline).
5. **First-click latency UX.** 1–3 s encode on first click must not feel like a freeze — show
   "Analyzing photo…" immediately on click, not after encode.

## 7. Open questions for sign-off

- **D1 (runtime):** Raw onnxruntime-web (my rec) vs Transformers.js? §3.
- **D2 (encoder precision):** Ship fp32 `vision_encoder.onnx` (23.3 MB, best quality, fits CF
  cap) — my rec — vs uint8 quantized (8.88 MB, smaller download, slight quality loss)? I lean
  **fp32** since it fits the cap and segmentation quality is the whole point; we can add the
  quantized path as a low-memory fallback in commit 12.
- **D3 (default mode):** Auto-select default with brush as toggle (my rec) vs brush default with
  auto-select as opt-in? I lean **auto-select default** — it's the headline feature; lead with it.
- **Scope check:** Is ~3 commits the right size, or do you want commit 10 (single-click select)
  as a standalone ship-and-evaluate before committing to 11–12?

---

### TL;DR for the impatient
SlimSAM-77, Apache-2.0, encoder fits under the CF cap (no sharding). Reuse the c7 ORT spine
rather than bolting on Transformers.js (one runtime, not two). Encode-once/decode-per-click =
instant feedback. Click an object → mask → existing erase pipeline. 3 commits. **Need your call
on D1/D2/D3, then I build commit 10.**
