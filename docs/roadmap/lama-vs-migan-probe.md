# LaMa vs MI-GAN probe — Phase 3 quality decision (c16 gate)

**Date:** 2026-06-15
**Status:** ✅ COMPLETE — verdict reached
**Verdict:** **DEFER LaMa (Option Q-B).** Do NOT ship the 198 MB HD-mode toggle.
**Gated commit:** c16 becomes a no-op / "MI-GAN is sufficient" close, not a LaMa build.

---

## Question

The Phase 3 RFC (`magicphotoeraser-phase3.md`) left ONE pivotal open question: is LaMa
visibly + consistently better than MI-GAN on real photos through our crop-bbox path —
enough to justify a **198 MiB** opt-in "HD mode" download (7.6× MI-GAN's 26 MiB, 8 CF
shards, a second preprocessing path)? Per the measure-first rule, probe before building.

## Method

- **Models:** MI-GAN `migan_pipeline_v2.onnx` (reassembled from the repo's 2 shards;
  sha256 `6f1f3530…` matches the recorded hash) vs LaMa `Carve/LaMa-ONNX/lama_fp32.onnx`
  (208,044,816 B = 198 MiB).
- **6 real photos** (Unsplash), chosen to span the inpainting-difficulty spectrum:
  smooth sky gradient, dark near-uniform pavement, golden-field horizon, aerial
  ocean/foam, busy backlit forest foliage, fine concrete texture.
- **Apples-to-apples paths** — each model called the way the real app would:
  - MI-GAN: full-res uint8 image+mask, model does crop-bbox 512-inpaint +
    ScatterND composite INTERNALLY → full-res uint8 out.
  - LaMa: fixed 512×512 float32, does NOT composite internally, so we ran the
    crop-bbox path ourselves (pad bbox → crop → resize 512 → inpaint → resize back
    → feather-composite ONLY the masked region into the full-res original).
- **Empirically probed LaMa's I/O contract BEFORE trusting any output** (the c7/c10
  discipline). Ran all 4 combos on one real case and scored kept-region fidelity +
  fill texture: **norm = RGB/255, mask polarity = 1=hole/erase** is correct
  (kept_err 0.0, healthy fill std 62). The other 3 combos gave kept_err 19–125
  (garbage) or dead-flat fills. (LaMa: float32 [0,255] out, no internal composite,
  ~54–60 s session-create on CPU.)

## Results

### Perceptual (vision, per case)

| Case | Texture type | Winner | Magnitude |
|---|---|---|---|
| 01 sky / beach | smooth gradient | **LaMa** | **obvious** — MI-GAN left a blue blob + faint sky banding |
| 04 water / ocean | semi-structured foam | **LaMa** | **fairly obvious** — MI-GAN hallucinated an isolated foam blob |
| 03 grass / horizon | mixed | LaMa | largely negligible |
| 05 forest foliage | busy high-freq | LaMa | largely negligible ("MI-GAN punches well above its size class") |
| 06 concrete | fine texture | LaMa | essentially negligible ("doesn't justify the cost") |
| 02 pavement | dark near-uniform | tie | negligible |

### Quantitative (objective, all 6 cases)

| metric | finding |
|---|---|
| **kept-region error** (unmasked 95%) | **0.00 for BOTH** models, every case — both crop-bbox paths correctly leave the rest of the photo pixel-identical. The "free sharp HD" moat holds for both. |
| **fill sharpness** (Laplacian variance) | **MI-GAN consistently SHARPER** — forest 2233 vs 513, sky 445 vs 76, grass 128 vs 74, water 119 vs 50. |
| **fill sharpness vs ORIGINAL region** | MI-GAN lands far closer to the original texture richness (forest: MI-GAN 2233 vs orig 2572; LaMa 513). LaMa's fills are measurably **smoother / lower-detail**. |

## Interpretation — why it's a WASH, not a LaMa win

The vision and the metrics agree once you reconcile them: **LaMa's defining property is
that it fills SMOOTHER.** That single property cuts both ways:

- On **smooth gradients** (sky, water) smoother = better: no blob, no banding → LaMa
  clearly wins the 2 "obvious" cases.
- On **rich texture** (forest, grass, concrete) smoother = worse: it's detail loss /
  mild blur, and MI-GAN's sharper, higher-frequency fill looks more natural (and
  measures closer to the original's texture).

So neither model dominates. LaMa wins ~2 of 6 (smooth backgrounds), MI-GAN is equal-or-
better on the other ~4 (textured backgrounds), and on the rest it's a tie. The RFC's
go-condition was **"visibly AND consistently better."** LaMa is *neither consistent*
(loses/ties 4 of 6) — it's situationally better on a minority of cases.

## Decision — Option Q-B (defer LaMa)

**Do not ship the 198 MB HD-mode toggle.** Justification:

1. **Not consistently better** — fails the RFC's explicit go-bar. It's a lateral move
   with a different failure mode, not an upgrade.
2. **Cost is real and large** — 198 MiB (vs 26), 8 CF shards, a 2nd vendored model set,
   a 2nd float32 preprocessing path, device-tiering, ~54 s cold compile. All for a
   minority-case, situational win.
3. **The one place LaMa wins (smooth gradients) is independently fixable cheaper.**
   MI-GAN's blob/banding on smooth regions is a *known, addressable* artifact — a
   future cheap lever (e.g. detect low-variance surrounds → light post-blend, or a
   tiny edge-feather tweak) could close most of that gap at ~0 download cost. That's a
   far better ROI than a 198 MB second model. (Candidate for a future small commit, not
   c16, and itself probe-gated.)
4. **Free sharp-HD moat is already MI-GAN's** — kept_err 0.00 confirms the untouched
   95% stays pixel-perfect. The headline promise doesn't need LaMa.

## c16 outcome

c16 becomes a **non-build**: close the Phase-3 "quality" bucket as "MI-GAN is
sufficient; LaMa deferred — not consistently better, cost unjustified." Revisit LaMa
ONLY if (a) a quantized/fp16 LaMa export appears (would cut the 198 MB substantially) or
(b) user demand specifically for smooth-background object removal emerges. The
smooth-region post-blend idea is parked as a possible cheap future polish.

## Artifacts (local, /tmp/mpe-probe — not committed)

- `grid/_ALL.png` — full 6-case contact sheet (Original|MI-GAN|LaMa, zoomed to the
  erase region).
- `grid/0N_*.compare.png` — per-case triptychs.
- `outputs/*.{migan,lama}.rgb` — raw results. `probe_run.py` / `batch.py` — runners.

**Portfolio lesson:** "bigger model = better" is a trap. A 7.6× model that's *smoother*
is not *better* — it's a different point on the sharp↔smooth tradeoff that wins some
inputs and loses others. Probe on a SPREAD of real inputs + an objective sharpness
metric, not one cherry-picked hero image. The measure-first rule paid off a 3rd time:
it turned a confident-looking "ship free HD!" into a correct "defer," saving a multi-day
198 MB build that would've been a lateral move.
