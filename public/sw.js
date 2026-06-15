/*
 * MagicPhotoEraser service worker — INSTALL-ONLY (deliberately no offline cache).
 *
 * Why install-only and not an offline app-shell:
 *   The eraser cannot do useful work offline — it lazily downloads 28–68 MB of
 *   ONNX models and loads onnxruntime-web's WASM from a cross-origin CDN
 *   (jsDelivr). Precaching the app shell would boot users into an editor that
 *   then fails to fetch its model offline — a worse, more confusing experience
 *   than a clean "you're offline" browser page. So this SW exists for ONE
 *   reason: to satisfy Chrome's installability heuristic so the app can be
 *   added to the home screen / installed as a standalone PWA.
 *
 *   It does fetch PASSTHROUGH — it never intercepts, caches, or rewrites any
 *   request. That is critical: the eraser needs Cross-Origin-Isolation
 *   (COOP/COEP → SharedArrayBuffer for threaded WASM). A SW that touched
 *   responses could strip or weaken those headers; passthrough leaves the
 *   Cloudflare-served COOP/COEP headers fully intact.
 *
 *   If a genuine offline eraser is ever greenlit, this is replaced by the
 *   build-time precache-injection SW (see the astro-offline-app-shell-sw skill)
 *   AND the ORT wasm is vendored same-origin so it can be cached. Not today.
 */

const SW_VERSION = "v1-install-only";

self.addEventListener("install", () => {
  // Activate immediately on first visit so the page becomes controlled in the
  // same session — Chrome's install prompt heuristic wants a controlling SW.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim open clients so the current page is controlled without a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Intentionally pass through. We register this SW to enable installation,
  // NOT to intercept requests. Do not add caching here without also vendoring
  // the ORT wasm same-origin and accounting for COOP/COEP (see header note).
});

// eslint-disable-next-line no-console
console.info(`[SW] MagicPhotoEraser installed: ${SW_VERSION}`);
