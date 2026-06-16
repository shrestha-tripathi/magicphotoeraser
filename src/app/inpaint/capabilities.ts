/**
 * capabilities — runtime feature probes for the inpaint engine.
 *
 * The ONE that actually bites: WebGPU. Windows Chrome populates `navigator.gpu`
 * even when there is NO usable adapter, so `'gpu' in navigator` lies. We MUST
 * `await navigator.gpu.requestAdapter()` and treat a null adapter as "no WebGPU"
 * — otherwise onnxruntime-web picks the webgpu EP, then throws deep inside an
 * async chunk and the erase silently dies. (Project rule + local-first-ai-pwa skill.)
 *
 * The probe is cached: requestAdapter() is comparatively expensive and the answer
 * never changes within a session.
 */

let _webgpu: Promise<boolean> | null = null;

export function probeWebGPU(): Promise<boolean> {
  if (_webgpu) return _webgpu;
  _webgpu = (async () => {
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
      if (!gpu?.requestAdapter) return false;
      const adapter = await gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  })();
  return _webgpu;
}

export type Backend = "webgpu" | "wasm";

/**
 * iOS (iPhone / iPad / iPod) — including iPadOS 13+, which masquerades as a
 * desktop "Macintosh" UA but has a touch screen (a real Mac never does).
 *
 * Why we care: iOS WebKit's WebGPU runs in a process with a SMALL, jetsam-happy
 * memory budget. A large model's forward pass (SAM's 1024² ViT encode, MI-GAN's
 * inpaint) exceeds it and the OS SILENTLY KILLS THE TAB — not a catchable JS
 * error, the whole page dies. Measured on a real iPhone (commit 06cd6e0 `?debug=1`
 * trace): webgpu EP selected, last log line "SAM encode", then crash at
 * `encoder.run()`. Headless desktop QA never saw it — that box has no GPU adapter
 * so it silently used WASM, which works. The user's phone HAS WebGPU, picked it,
 * and crashed.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iphone|ipod|ipad/i.test(ua)) return true;
  // iPadOS 13+ pretends to be macOS; disambiguate by touch support.
  const macLike = /macintosh|mac os x/i.test(ua);
  return macLike && navigator.maxTouchPoints > 1;
}

export async function pickBackend(): Promise<Backend> {
  // Force WASM on iOS: its WebGPU memory budget can't hold our models' working
  // set and the OS jetsams the tab mid-inference (see isIOS() above). WASM runs
  // in main memory (gigabytes) and COMPLETES — slower, but it doesn't crash.
  // Requires cross-origin isolation for threaded WASM, which CF Pages' _headers
  // already provide (verified crossOriginIsolated + SharedArrayBuffer on-device).
  // Revisit when iOS WebGPU memory handling matures.
  if (isIOS()) return "wasm";
  return (await probeWebGPU()) ? "webgpu" : "wasm";
}
