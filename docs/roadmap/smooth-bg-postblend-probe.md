# Smooth-background post-blend probe — REJECTED (Phase 3 close-out)

**Status:** Investigated, measured against ground truth, **rejected**. No build.
**Date:** Jun 2026 · **HEAD at probe:** `96d3722` · **Companion to:** the LaMa-vs-MI-GAN
probe (`b0c8d68`) and the Samsung-grade model survey (`96d3722`).

## The hypothesis (from the survey close-out)

The Samsung-grade survey ended with one concrete, cheap idea worth testing:

> The smartest "better" lever isn't a bigger model — it's fixing MI-GAN's *one*
> real weakness. In the LaMa probe, LaMa beat MI-GAN **only on smooth backgrounds**
> (sky / water), where MI-GAN leaves a faint blob/banding. That specific artifact
> *might* be fixable with a **~0 MB post-processing blend** (detect the smooth
> surround, feather the fill in) — closing the gap for free, no new model, no
> download, no privacy compromise.

This doc is the measure-first probe of that idea. **It does not survive contact
with ground truth.**

## Method (ground-truthed, not eyeballed)

The 6-photo probe set from `b0c8d68` uses **synthetic rectangular masks over real
photos**, which means the original pixels under each mask **are the ground truth**.
So every candidate fix can be scored as **mean-absolute-error (MAE) vs the true
pixels** inside the fill — not a proxy, the real thing. Cases span the difficulty
spread: smooth sky, flat pavement, grass-with-horizon, textured ocean, busy
forest, concrete.

Four post-blend variants were implemented (numpy-only, all ~0 MB, all the kind of
thing that could ship as a tiny post-process after MI-GAN):

| Variant | What it does |
|---|---|
| **A · membrane** | Laplace-extend the exterior background into the hole; pull MI-GAN's low-frequency content toward that smooth surface (keep its high-freq texture). |
| **B · dc-only** | Subtract a single per-channel **constant** offset = mean(MI-GAN − membrane-prediction) over the fill. Can't smear structure; only shifts level. |
| **C · dc-gated** | B, but only when the surround is smooth on **all four sides** (a horizon entering from one side blocks it). |
| **D · edge-aware** | A, but weighted by (1 − local-gradient of MI-GAN's own fill), so it can only touch regions MI-GAN itself rendered as flat. |

## Result — MAE vs ground truth (lower = better)

| case | surround | MI-GAN | membrane | dc | dc-gated | edge-aware | LaMa |
|---|---|---:|---:|---:|---:|---:|---:|
| 01 sky_beach | horizon present | **14.33** | 19.55 | 19.28 | 14.33 | 15.54 | 10.45 |
| 02 pavement | smooth | 4.60 | **3.85** | 4.05 | 4.05 | 4.36 | 3.61 |
| 03 grass_field | horizon/treeline | **13.63** | 22.62 | 14.74 | 13.63 | 17.15 | 10.84 |
| 04 water_ocean | textured | **25.90** | 27.78 | 26.18 | 25.90 | 26.69 | 20.31 |
| 05 forest_foliage | busy texture | **29.22** | 29.49 | 28.70 | 29.22 | 29.98 | 23.53 |
| 06 concrete | texture | 8.49 | 8.47 | 8.55 | 8.49 | 8.47 | 8.40 |
| **TOTAL** | | **96.18** | **111.76** | 101.50 | **95.63** | 102.19 | **77.14** |
| Δ vs MI-GAN | | — | **+15.58 ✗** | +5.32 ✗ | **−0.55** | +6.01 ✗ | −19.04 |

## Why it fails (the load-bearing finding)

1. **The artifact is NOT a boundary seam.** MI-GAN's kept region is byte-identical
   at the mask boundary (kept_err ≈ 0.00, confirmed in `b0c8d68`). There is *nothing
   to feather* — Poisson/seamless-clone blending adds essentially zero correction
   (corr_max < 2 on sky). The visible "blob" is a **low-frequency deviation in the
   interior** of the fill, not a seam at the edge. A blend that matches the boundary
   can't touch it.

2. **The blob lives exactly where structure is.** The faintly-wrong patches show up
   where a **horizon / treeline sits *behind* the erased object**. Any "assume smooth
   background behind the object" fix (membrane, dc) **smears that real structure into
   a washed-out foggy band** — making it *visibly and quantitatively worse* (grass
   13.6 → 22.6, sky 14.3 → 19.6). Vision confirmed the smear independently:
   *"noticeably washed-out, hazy, smeared center… foggy, low-detail."* See
   `grid/_blend_evidence.png`.

3. **The only safe variant is a no-op.** dc-gated (C) refuses to act unless all four
   sides are smooth — which fired on exactly **1 of 6** cases (flat pavement) for a
   total improvement of **0.55 MAE across the whole set**: invisible. Make the gate
   any looser and it regresses (becomes plain dc, +5.3).

4. **The genuinely better result is LaMa (−19 MAE) — and it's the 198 MB model we
   already rejected** in `b0c8d68` for failing the "visibly AND consistently better"
   bar at a large cost. The post-blend was the attempt to get LaMa's smooth-bg win
   for free; ground truth says you cannot.

## Decision

**Reject the ~0 MB smooth-background post-blend.** Four variants tested; the only
one that doesn't regress is statistically a no-op, and the aggressive ones smear
real structure. MI-GAN's output stands as shipped. **Phase 3 quality bucket stays
closed as "MI-GAN sufficient"** — now closed on *two* independent fronts (no better
web-runnable model exists, AND the cheap post-process doesn't work).

## What would actually move quality (unchanged from the survey)

- A **quantized MAT ONNX** (~120 MB) — doesn't exist yet; watch HF.
- A **distilled/turbo SD-inpaint under ~300 MB** — field moves fast; re-check.
- Both are real-model upgrades for a *future WebGPU-gated opt-in tier*, not free.

## Portfolio lesson

A "cheap post-process to fix the model's one weakness" is itself a hypothesis that
must be **measured against ground truth, not eyeballed**. Here the artifact's true
nature (interior low-freq deviation co-located with real structure, *not* a boundary
seam) meant every cheap fix either did nothing or smeared the scene. The synthetic-
mask probe set paid off a 4th time: it turned a plausible-sounding "fix the blob for
free" into a measured "you can't" — saving a shipped regression. **When the fix is
~0 MB, the temptation to skip the probe is highest; that's exactly when to run it.**

### Repro

```
/tmp/mpe-probe/blend_probe4.py   # error decomposition vs truth (low/high-freq)
/tmp/mpe-probe/blend_probe5.py   # membrane / dc / dc-gated vs truth
/tmp/mpe-probe/blend_probe6.py   # edge-aware vs truth
/tmp/mpe-probe/evidence.mjs      # renders grid/_blend_evidence.png
```
(probe artifacts uncommitted in /tmp, like the prior probes.)
