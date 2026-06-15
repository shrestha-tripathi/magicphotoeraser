# MagicPhotoEraser — Phase 3 (Retention, Quality, Polish)

**Status:** Roadmap / spec draft — **NOT implementation-ready** (one pivotal open
question: the LaMa probe, Q1 below, gates the quality commit).
**Author:** session 2026-06-15
**Related:** `src/app/EraserApp.tsx`, `src/app/inpaint/{runInpaint,modelSource,modelCache,capabilities}.ts`,
`public/manifest.webmanifest`, `public/_headers`, `src/layouts/Layout.astro`,
`docs/roadmap/magicphotoeraser-v0.1.md`, `docs/roadmap/magicphotoeraser-phase2.md`
**Estimated work:** ~350–550 LOC across **2 confirmed + 1 probe-gated** commits, ~2–3 working days
**Risk:** Low–Medium (PWA install is well-trodden; the only Medium-risk item is the LaMa model swap, which is probe-gated and opt-in)

---

## Problem

Phase 2 shipped "the magic" (click-to-select). The product is now **feature-complete
and launchable** — upload → click/brush → erase → compare → download, 100% on-device —
yet it sits unlaunched. The original v0.1 roadmap pencilled in a vague "Phase 3 — LaMa
HD quality + PWA + polish (~3 commits)" *before any of those assumptions were measured.*

The gap between "works" and "a polished product people install and come back to" is three
distinct buckets, and **two of the three original assumptions don't survive contact with
the numbers:**

| Bucket | Original assumption | What measuring revealed |
|---|---|---|
| **Retention** | "Add PWA + offline" | PWA install ✅ worth it. Full *offline shell* ❌ — app needs 28–68 MB of models + cross-origin ORT wasm; the offline-SW skill itself says use **install-only** here. |
| **Quality** | "Free LaMa HD quality toggle" | LaMa fp32 ONNX = **198 MiB** (vs MI-GAN's 28 MB), **no quantized export exists**, and MI-GAN *already* does internal crop-bbox compositing → sharp HD. The "free" toggle is a 7× download for an **unproven** delta. |
| **Polish** | "polish" (unspecified) | Real, concrete debt exists (a11y, keyboard help, the c13 popover-clamp cosmetic, mobile pass). This bucket is genuinely worth a commit. |

This RFC re-negotiates Phase 3 around what the measurements actually support.

---

## Current architecture (what we'd be changing / building on)

### What's already shipped (don't rebuild)
- **v0.1** (commits 1–9): Astro SEO shell + React `/app` island, brush mask, MI-GAN
  inpaint (WebGPU + WASM fallback), mask dilation, before/after compare, download.
- **Phase 2** (commits 10–13): SlimSAM click-to-select, multi-point refine, 3-mask
  cycling, first-run onboarding tour.

### What's already PRE-WIRED for Phase 3 (free leverage)
- **`public/manifest.webmanifest`** — already complete: name, description, `display:
  standalone`, theme/bg colors, and **all four icons incl. `icon-512-maskable.png`**
  (shipped in c4). PWA install needs *zero* new icon work.
- **`public/_headers`** — already pins `application/manifest+json` for the manifest, and
  ships COOP/COEP (which an install-only SW is compatible with).
- **`src/layouts/Layout.astro:101`** — already emits `<link rel="manifest">`.
- **`modelCache.ts`** — models already persist in IndexedDB (one-time download). The
  encoder/decoder/MI-GAN bytes survive across sessions *today*.

### What's NOT there yet
- **No service worker at all** (`public/sw.js` absent) → not installable, Chrome shows no
  install affordance.
- **No `apple-touch-icon` link** in `<head>` (the PNG exists at `/apple-touch-icon.png`,
  just not linked).
- **No install prompt UI**, no iOS A2HS hint.
- **System-only theme** (`prefers-color-scheme`, no manual toggle) — fine, not changing.
- **ORT wasm is cross-origin** (`cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/`) — see
  `runInpaint.ts:34`. This is the load-bearing fact that kills a naive offline story.

---

## The LaMa question (the pivotal re-negotiation)

The v0.1 roadmap's headline Phase 3 feature was "LaMa as a free quality toggle." Measuring
LaMa's actual cost changes the calculus enough that it deserves its own decision.

**Measured facts (2026-06-15, `curl -sIL`):**
- `Carve/LaMa-ONNX/lama_fp32.onnx` → **198 MiB** (208,044,816 B)
- `lama.onnx` (same repo) → 197 MiB
- `lama_int8.onnx` / `lama_fp16.onnx` / `lama_quantized.onnx` → **all 404** (no quantized export)
- For contrast: MI-GAN `migan_pipeline_v2.onnx` → **26 MiB**, and it *already composites
  crop-bbox internally* (kept region byte-identical — verified c7).

So LaMa is a **7.6× heavier** download, would need **8 shards** under CF's 25 MiB asset
cap, and its quality advantage over MI-GAN on *our* crop-bbox pipeline is **unverified**.

### Option Q-A — Ship LaMa as an opt-in "HD mode" toggle
A second model behind an explicit, clearly-labelled "HD mode (one-time 198 MB download)"
toggle. Default stays MI-GAN. Lazy-load LaMa only when the user opts in.

| Pros | Cons |
|---|---|
| Power users who want max quality get it | 198 MB is a *lot* on mobile/India-market data |
| Honest (download cost shown up-front) | 8-shard plumbing + a 2nd preprocessing path (LaMa I/O differs from MI-GAN) |
| "Free HD that competitors paywall" angle | **Quality delta is unproven** — may not be visibly better on crop-bbox output |
| Default UX untouched (no regression) | Doubles the model-maintenance surface |

**Verdict:** Defensible *only if* a probe proves LaMa is visibly better. Otherwise it's
198 MB of complexity for nothing.

### Option Q-B — Defer LaMa entirely; invest the "quality" budget elsewhere
Drop LaMa from Phase 3. MI-GAN's output is already sharp-HD (internal composite). Spend
the quality budget on cheaper, universal levers: mask-edge feathering tuning, an optional
**second-pass residual cleanup** (erase → detect leftover object pixels → auto re-mask),
or higher working-res cap for power users.

| Pros | Cons |
|---|---|
| Zero extra download weight | "We have LaMa" is a nice marketing line we'd forgo |
| Every erase benefits, not just opt-in users | Second-pass cleanup is itself speculative — needs its own probe |
| Keeps the model surface single (MI-GAN) | Leaves a known better-quality model on the table |

**Verdict:** Strong default. MI-GAN is genuinely good; "quality" may be a solved problem
we're inventing work around.

### Option Q-C — Probe FIRST, then decide (recommended)
Before committing to *either*, run a **Python/ORT probe** (the project's measure-first
rule, same discipline that just killed the fp16-SlimSAM commit and the offline-shell
assumption): run LaMa and MI-GAN on the **same 5–8 real photos** (varied: person on
texture, object on sky, text/watermark, busy background) through the **crop-bbox path we
actually use**, and compare outputs side-by-side. Decision tree:
- LaMa **visibly + consistently better** → do Option Q-A (opt-in HD mode), it earns the 198 MB.
- LaMa **marginal / situational** → do Option Q-B (defer), bank the finding.

**Verdict:** ✅ **Recommended.** This is a ~1-hour probe that prevents a multi-day,
198 MB mistake (or conversely de-risks shipping it). Matches the rule that just paid off twice.

### Comparison summary

|  | Q-A ship now | Q-B defer | Q-C probe-first |
|---|---|---|---|
| Risk of wasted 198 MB build | High | None | None |
| Risk of leaving quality on table | None | Medium | None |
| Up-front cost | High | Zero | ~1 hr probe |
| Honors measure-first rule | ❌ | ⚠️ (assumes) | ✅ |
| Decision quality | Guess | Guess | Evidence |

---

## The PWA question

### Option P-A — Install-only PWA (recommended)
A minimal `sw.js` whose only job is to satisfy Chrome's installability heuristic (skipWaiting
+ clients.claim, fetch passthrough). Custom install pill (replaces Chrome's mini-infobar) +
iOS Safari "Share → Add to Home Screen" hint + `appinstalled` sticky bit + 14-day dismiss
cooldown. Per the `pwa-install-custom-prompt` skill.

| Pros | Cons |
|---|---|
| App icon on home screen → retention | Doesn't make the *eraser* work offline |
| ~6 KB, zero new deps, skill-ready | (acceptable — see below) |
| Manifest + maskable icon already done | |
| No stale-cache invalidation headache | |

### Option P-B — Full offline app-shell SW
Precache `dist/_astro/*` + shell routes (the `astro-offline-app-shell-sw` skill).

| Pros | Cons |
|---|---|
| App shell loads offline | **Eraser still can't run offline** without 28–68 MB models cached |
| | **ORT wasm is cross-origin** (jsDelivr) — COEP + opaque-response rules make caching it fragile |
| | The offline-SW skill *itself* says: "app can't do useful work offline (WebGPU model download) → use install-only instead" |
| | Stale-cache invalidation churn every deploy |

**Verdict:** ❌ Misleading for v1. We'd cache an app shell that boots to an eraser that
can't fetch its model offline. The skill we'd use explicitly flags this exact case as the
*wrong* one. **A genuine offline eraser is a real future phase** (vendor ORT wasm
same-origin + precache models from IndexedDB), but it's not a casual Phase 3 add — it's
its own ~90 MB design problem.

### Comparison summary

|  | P-A install-only | P-B offline shell |
|---|---|---|
| Eraser works offline | No | **No (the trap)** |
| New deps | 0 | 0 |
| Stale-cache risk | None | High (every deploy) |
| Honest to user | ✅ | ⚠️ (implies offline that ~half-works) |
| Skill recommendation for this app type | ✅ This one | ❌ "use install-only instead" |

**Chosen: P-A (install-only).** Genuinely installable, honest, retention win, no false
offline promise.

---

## Polish bundle (candidate menu — pick during review)

Concrete, grounded debt. Each is small; the commit bundles the chosen subset.

1. **Keyboard-shortcuts help overlay** — the app has rich shortcuts (`]`/`[` cycle,
   right/alt-click negative, Ctrl/⌘Z undo) that are *invisible*. A `?`-key / button overlay
   listing them. (~60 LOC, pairs with the existing onboarding "?" button.)
2. **c13 popover top-clamp cosmetic** — the onboarding tour's "top"-placed step near the
   viewport top clamps to `top:12` instead of flipping below (documented known-cosmetic in
   the project skill). Small placement fix. (~20 LOC)
3. **`apple-touch-icon` link in `<head>`** — the PNG exists, just isn't linked. iOS home-screen
   icon correctness. (1 line; folds into the PWA commit naturally.)
4. **Mobile UX pass** — verify the toolbar wraps cleanly, brush cursor behaves on touch, the
   compare slider is thumb-friendly at <400px. (Audit + targeted fixes.)
5. **a11y sweep** — focus-visible rings on canvas-mode toggles, `aria-live` on the
   erase-progress + "Analyzing your photo…" overlays, reduced-motion already partly done.
6. **"Tips" affordance** — a subtle hint when a user's mask covers <X% of a clicked object
   (the c7-flagged partial-erase footgun). Lower priority.

---

## Chosen approach: re-scoped Phase 3

```
                    ┌────────────────────────────────────────────┐
                    │ Phase 3 = retention + honest quality + polish│
                    └────────────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
  ┌───────────┐               ┌───────────────┐             ┌──────────────┐
  │ Commit 14 │               │  Probe (Q-C)  │             │  Commit 16   │
  │ PWA       │               │  LaMa vs      │──decides──▶ │  Quality:    │
  │ install   │               │  MI-GAN       │             │  Q-A or Q-B  │
  │ (P-A)     │               │  (~1 hr, no   │             │  (probe-gated)│
  └───────────┘               │   commit)     │             └──────────────┘
        │                     └───────────────┘                     │
        └──────────────┬──────────────────────────────────────────┘
                       ▼
                ┌───────────────┐
                │  Commit 15    │
                │  Polish bundle│
                │  (pick subset)│
                └───────────────┘
```

Commit numbering continues the repo sequence (last shipped = c13 `5ef1fb4`; c14 was the
dropped fp16 investigation — **reusing the number is fine since no c14 exists in history**).

---

## Migration plan

### Commit 14 — PWA install (install-only) + apple-touch-icon
- `public/sw.js` — install-only SW (skipWaiting, clients.claim, fetch passthrough). NO offline cache.
- `src/app/pwaInstall.ts` — `beforeinstallprompt` capture + `preventDefault`, custom pill UI,
  iOS A2HS hint (8 s delay), `appinstalled` sticky bit (localStorage), 14-day dismiss cooldown,
  multi-layer already-installed detection.
- `src/layouts/Layout.astro` — `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
  SW registration on `window.load`.
- Wire `initPwaInstall()` into the `/app` island boot (NOT marketing pages — keep them 0-JS;
  the install pill lives in the editor where intent is highest).
- `global.css` — install-pill styles, BOTH themes, `prefers-reduced-motion`.

**Scope:** ~180 LOC. **Risk:** Low (skill-ready, manifest+icons pre-done).
**Verify:** built `dist/sw.js` present; manifest 200 + `application/manifest+json`; DevTools
→ Application → Manifest renders icons; install affordance appears; iOS hint fires; pill
respects dismiss cooldown; marketing pages stay 0-JS.

### Commit 15 — Polish bundle (chosen subset of the menu)
Default recommended subset: **(1) keyboard-shortcuts overlay + (2) c13 popover clamp + (5)
a11y sweep**. (3) folds into c14. (4) mobile pass and (6) tips are stretch.

**Scope:** ~120–200 LOC depending on subset. **Risk:** Low.
**Verify:** shortcuts overlay opens/closes (`?` + Esc), lists real bindings; tour step 3
popover flips below near top edge; `aria-live` regions announce; both themes; build 0/0/0.

### Probe (between 15 and 16 — NOT a commit) — LaMa vs MI-GAN
Python/ORT, 5–8 real photos, crop-bbox path, side-by-side outputs + a quality metric
(e.g. perceptual diff vs a hand-cleaned reference where available, plus eyeball). Output: a
go/no-go on Q-A. Document the finding in the project skill regardless of outcome.

**Scope:** throwaway script, ~1 hr. **Risk:** None (no repo change).

### Commit 16 — Quality (probe-gated: Q-A *or* Q-B)
- **If probe says LaMa wins →** opt-in "HD mode" toggle: 8-shard LaMa loader (extend
  `modelSource.ts` pattern), LaMa preprocessing path, explicit "one-time 198 MB download"
  consent UI, lazy-load on opt-in, default stays MI-GAN.
- **If probe says marginal →** Q-B: drop LaMa; ship the cheapest universal lever the probe
  surfaced (likely a dilation-radius tune or a second-pass residual cleanup *if* it too
  probes well), else close the quality bucket as "MI-GAN is sufficient."

**Scope:** Q-A ~250 LOC + 8 shard assets; Q-B ~0–80 LOC. **Risk:** Q-A Medium (new model
I/O, large download UX); Q-B Low.
**Verify (Q-A):** HD toggle downloads only on opt-in; LaMa erase works WebGPU + WASM;
default path unchanged; build 0/0/0.

---

## Non-goals

- **No full offline eraser in Phase 3.** Install-only PWA only. A genuine offline eraser
  (vendor ORT wasm same-origin + precache 28–68 MB models from IDB) is a separate future phase.
- **No SD generative-fill** (that's the optional Phase 4 stretch, WebGPU-only).
- **No manual light/dark theme toggle.** System `prefers-color-scheme` stays; both themes
  already mandatory + shipped.
- **No account/cloud/sync anything.** The privacy promise is the moat; nothing leaves the device.
- **No GA4 wiring here.** GA4 stays deferred to project-end per the user; it's a launch-checklist
  item, not a Phase 3 feature.
- **No shipping LaMa on faith.** It's probe-gated. If the probe doesn't justify 198 MB, it doesn't ship.

---

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LaMa 198 MB shipped but quality delta invisible | Medium | High (wasted weeks + bad mobile UX) | **Probe-gate it (Q-C).** Don't build c16-LaMa until the probe proves value. |
| Install-only SW mistaken for offline support by users | Low | Medium | Don't advertise offline; pill says "Install app," not "works offline." |
| SW caching breaks COOP/COEP (which the eraser needs) | Low | High | Install-only SW does fetch passthrough — never intercepts/caches, so headers are untouched. Verify SharedArrayBuffer still available post-install. |
| Stale SW pins an old build | Low | Medium | skipWaiting + clients.claim; install-only has no precache to go stale. |
| LaMa I/O contract differs from MI-GAN, silent wrong output | Medium (if Q-A) | High | Probe in Python *first* (verify I/O + polarity empirically, same as c7/c10 SlimSAM discipline) before any TS. |
| iOS install hint annoys / shows when already installed | Low | Low | `navigator.standalone` + display-mode detection + 14-day cooldown (skill handles all three). |
| Polish a11y changes regress the canvas pointer handling | Low | Medium | a11y additions are additive (aria-live, focus rings); don't touch pointer event paths. |

---

## Open questions

1. **LaMa: probe-first (Q-C), or skip straight to defer (Q-B)?** *(BLOCKING for c16 only —
   c14/c15 proceed regardless.)* **Recommend Q-C** — the ~1 hr probe is cheap insurance and
   matches the rule that just killed two speculative commits. If you'd rather not spend even
   that, Q-B (defer) is the safe default and we revisit LaMa when a quantized export exists.
2. **Polish subset for c15?** Recommend (1) shortcuts overlay + (2) c13 clamp + (5) a11y.
   Mobile pass (4) and tips (6) are stretch — include now or spin to a c17?
3. **Commit order: PWA (14) before or after polish (15)?** Recommend PWA first — it's the
   bigger retention win and is fully spec'd; polish can absorb any review feedback after.
4. **Should the install pill live only in `/app`, or also on the landing page?** Recommend
   `/app` only (keeps marketing 0-JS; install intent peaks after a successful erase). Could
   add a static "Install" link in the footer with no JS as a compromise.

---

## Success criteria

1. On Android Chrome, after one erase, the user gets an install pill; tapping it installs
   MagicPhotoEraser with the correct maskable icon; relaunching opens standalone (no browser chrome).
2. On iOS Safari, the user sees a "Share → Add to Home Screen" hint (once, respecting cooldown);
   following it installs with the apple-touch-icon.
3. An installed user who returns and erases again hits the IndexedDB-cached model — no re-download.
4. SharedArrayBuffer / threaded WASM still works after SW install (eraser unaffected).
5. A new user can discover the `]`/`[` cycle and negative-click shortcuts via the help overlay
   without reading docs.
6. **The LaMa decision is made on evidence** — either an opt-in HD mode that's visibly sharper
   on the probe photos, or a documented "MI-GAN sufficient, LaMa deferred" finding. Not a guess.

When 1–5 hold (and 6 is resolved either way), Phase 3 ships and the product is launch-ready.

---

## Appendix: why not vite-plugin-pwa / Workbox?

Same reasoning as the rest of the portfolio: a static Astro microtool doesn't need Workbox's
runtime-caching strategies, expiration plugins, or background sync. Install-only is ~6 KB of
hand-rolled SW + a manifest that already exists. Adding a build-time PWA dep here is the
unwelcome-complexity the user's "zero unnecessary deps for static microtools" preference
rejects. If a *genuine* offline eraser is greenlit later, the zero-dep
`astro-offline-app-shell-sw` skill (build-time `astro:build:done` precache injection) is the
path — still no Workbox.

## Appendix: the offline eraser, sketched (future phase, not now)

For when "works fully offline" becomes a goal:
1. **Vendor ORT wasm same-origin** (`ort-wasm-simd-threaded.jsep.wasm` = 26 MiB, +`.mjs`) into
   `public/` instead of jsDelivr, so a SW can cache it (cross-origin opaque responses + COEP
   make CDN caching fragile). Set `ort.env.wasm.wasmPaths` to the local path.
2. **Precache app shell** via the zero-dep build-time injection skill.
3. **Models already persist** in IndexedDB (modelCache.ts) — gate the eraser on "models cached?"
   and show an offline-unavailable state until the first online download.
Total offline weight ≈ app shell + 26 MiB wasm + 28 MB MI-GAN (+ 40 MB SAM if click-select
offline). Real, but a deliberate ~90 MB design problem — hence its own phase.
