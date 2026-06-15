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

export async function pickBackend(): Promise<Backend> {
  return (await probeWebGPU()) ? "webgpu" : "wasm";
}
