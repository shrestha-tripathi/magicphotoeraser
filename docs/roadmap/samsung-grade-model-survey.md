# "Samsung-grade" eraser — model survey & feasibility (Phase 3 follow-up)

**Date:** 2026-06-15
**Question (user):** find a Hugging Face model that does **better** than MI-GAN —
"Samsung phone level AI eraser capabilities" — without significant cost.
**Verdict:** **No in-browser model reaches Samsung-grade today.** Samsung's "Generative
Edit" is server-side diffusion (generative fill). The only web-deployable upgrade is a
*lateral* one (int8 LaMa, 59 MB). True generative fill in-browser = a ~2 GB download +
desktop-GPU compute — not viable for a free client-side phone tool right now.

---

## What "Samsung-grade" actually is (the reframe)

Samsung Galaxy "Object Eraser → Generative Edit" (S24+) and Google "Magic Editor" are
**diffusion-based generative fill**, and they **run in the cloud** (Samsung's servers /
Google's data centres), not on-device for the hard cases. They don't *patch* a hole from
surrounding pixels (what MI-GAN/LaMa do) — they *hallucinate plausible new content*
(rebuild an occluded railing, regenerate a face, fill a person-sized hole with
coherent scene). That capability class = **Stable-Diffusion-inpainting / BrushNet /
PowerPaint / MAT**, not the GAN patch-inpainters.

This matters because our whole moat is **"$0 marginal cost, 100% on-device, private."**
Samsung's quality comes from *breaking* exactly those constraints (cloud GPUs, your
photo leaves the device). So "Samsung-grade + free + private + in-browser" is, today, a
contradiction — not a model we haven't found yet.

## The full HF survey (everything checked, with real sizes)

### Tier 1 — web-deployable patch-inpainters (ONNX, run in onnxruntime-web)

| Model | Size | EP | Quality vs MI-GAN | Verdict |
|---|---|---|---|---|
| **MI-GAN** (current) | **26 MiB** | WASM✅ WebGPU✅ | baseline; sharp fills | shipping |
| **int8 LaMa** (benote93) | **59 MiB** | WASM✅ (int8 ok) | *lateral* — smoother (wins smooth bg, loses texture), same as fp32 LaMa | viable but not "better" |
| fp32 LaMa (Carve) | 198 MiB | WASM✅ | lateral (already probed → deferred) | rejected |
| fp16 LaMa | 103 MiB | **WASM❌** WebGPU✅ | lateral | WebGPU-only |
| AOT-GAN (ogkalu) | 22 MiB | WASM✅ | trained for **manga/text removal**, not general photos; out∈[-1,1] | niche, not better |
| opencv lama 2025 | 88 MiB | WASM✅ | LaMa-class (lateral) | no license clarity |

**Tier-1 conclusion:** every ONNX patch-inpainter is on the same MI-GAN↔LaMa
sharp↔smooth frontier. int8 LaMa is the only "cheap-ish" alternative and it's the
*lateral* LaMa we already chose to defer — quantizing it doesn't change its character,
just its price (kept_err 0.0, fill-texture std 96 — quantization preserved quality).
**None is categorically better.**

### Tier 2 — genuinely-better patch models (MAT / ZITS) — NOT web-deployable

| Model | Best available format | Size | Why it can't ship to web |
|---|---|---|---|
| **MAT** (Mask-Aware Transformer, SOTA large-hole) | `.pth`/`.safetensors` only (Acly, Sanster) | 119–239 MiB | **No ONNX export exists.** Custom mask-aware attention ops are notoriously hard to export to ONNX, and onnxruntime-**web** supports a subset of even that. Face variants (CelebA/FFHQ) are face-only; only Places-512 is general. |
| **ZITS** (structure-aware) | 4× `.pt` multi-stage (~373 MiB) | 373 MiB | No ONNX; 4-model pipeline (wireframe→edge→structure→inpaint). Way too heavy + complex for web. |

**Tier-2 conclusion:** the models that are *actually* a step above LaMa exist only as
PyTorch and have no realistic onnxruntime-web path. Exporting MAT ourselves is a research
project with no guarantee the web runtime supports its ops (same risk class as the
fp16-WASM failure, but worse).

### Tier 3 — generative fill (the real "Samsung-grade") — ~2 GB, desktop-GPU

| Model | Web export? | Size | Reality |
|---|---|---|---|
| **SD-inpainting** (`jdp8/sd-inpainting-ort-web-fp16`) | ✅ exists, ort-web fp16! | **2,035 MiB** (1.64 GB UNet) | The honest data point: someone DID export SD-inpaint for onnxruntime-web. It's **78× MI-GAN**. Multi-second-per-step diffusion (20-50 steps) on a desktop GPU; minutes or OOM on a phone. |
| SD-2-inpaint ort-web | ✅ | 2,462 MiB | same class, bigger |
| BrushNet / PowerPaint (Sanster) | ❌ PyTorch/diffusers only | 2–5 GB | SOTA generative edit; what IOPaint runs server/desktop. No web export. |
| LDM (IOPaint) | ❌ `.pt` | 1.9 GB | same |

**Tier-3 conclusion:** generative fill *can* technically run in a browser via WebGPU
(the export exists), but at **~2 GB one-time download + phone-melting / OOM compute**.
That is the definition of "significant cost" — it breaks the free-fast-private promise
outright. This is the tier Samsung uses, and they run it in the cloud for a reason.

## Why the fp16-WASM finding still bounds us (and where WebGPU helps)

- The WASM fallback (null-adapter / low-end devices) can ONLY load **fp32 or int8** —
  fp16 is dead on WASM (proven earlier). So the *baseline tier* is locked to MI-GAN /
  int8-LaMa class regardless.
- **WebGPU** (most modern phones + desktops) lifts that — fp16 and heavier models load.
  So a *future* "HD tier (WebGPU only)" could run fp16 LaMa (103 MB) or, in theory, an
  exported MAT. But: (a) MAT has no ONNX, (b) fp16 LaMa is still just lateral-LaMa, and
  (c) gating quality behind "modern GPU only" fragments the product. Not worth it now.

## Recommendation

1. **Keep MI-GAN as the shipping eraser.** It's the right point on the frontier for a
   free, private, fast, 26 MB on-device tool. The survey *confirms* this rather than
   settling for it — there is no free lunch above it.
2. **Don't chase Samsung-grade in-browser.** It requires either cloud GPUs (kills the
   privacy moat + adds per-erase cost) or a ~2 GB on-device diffusion download (kills
   the fast/free moat). Both contradict the product's entire reason to exist.
3. **The honest "better" lever isn't a bigger model — it's fixing MI-GAN's ONE real
   weakness cheaply:** the smooth-background blob/banding artifact (the only place LaMa
   won). A tiny post-processing pass (detect low-variance surround → light Poisson/edge
   blend) could close most of that gap at **~0 MB**. That's the high-ROI move, and it's
   probe-gated like everything else. Parked as a candidate future commit.
4. **If a true upgrade is wanted later,** the realistic watch-list is: (a) a quantized
   **MAT ONNX** appearing (would be a genuine step up at ~120 MB — not here yet), or
   (b) a distilled/turbo SD-inpaint that gets under ~300 MB with ≤4 steps (the field is
   moving fast; revisit in a few months).

**Bottom line for the user:** I looked hard — int8 LaMa (59 MB), AOT-GAN (22 MB), MAT,
ZITS, opencv-LaMa, and the actual SD-inpaint web export. Nothing delivers Samsung-grade
*without* significant cost, because Samsung-grade **is** the significant cost (cloud or
~2 GB). The best free/private/in-browser option remains MI-GAN, and the smartest next
quality investment is a ~0 MB artifact-fix, not a heavier model.

## Artifacts (local /tmp/mpe-probe — not committed)
- models/: lama_int8.onnx (59 MB), aot.onnx (22 MB) downloaded + contract-probed.
- int8 LaMa contract = identical to fp32 LaMa (norm 1/255, mask 1=hole), kept_err 0.0.
- AOT contract = norm 1/255, mask 1=erase, output ∈ [-1,1] (manga/text-removal model).
