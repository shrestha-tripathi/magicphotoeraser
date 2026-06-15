/**
 * runInpaint — the on-device inpainting engine: load MI-GAN once, then erase the
 * masked region of a photo entirely in the browser (WebGPU, WASM fallback).
 *
 * Model: migan_pipeline_v2.onnx (MIT, Picsart MI-GAN). The pipeline graph does the
 * crop-bbox 512-inpaint AND composites the result back into a FULL-RES copy of the
 * image internally (ends in ScatterND), so we feed full resolution and get full
 * resolution back — the untouched 95% of the photo returns byte-identical. That
 * internal composite is the whole "free sharp HD" moat; we don't build it.
 *
 * ── I/O contract (verified empirically against the actual .onnx, not docs) ──
 *   input  image : uint8 [1, 3, H, W]  RGB, CHW (channel-planar)
 *   input  mask  : uint8 [1, 1, H, W]
 *   output result: uint8 [1, 3, H, W]  RGB, CHW
 * Access by index (inputNames[0]/[1], outputNames[0]) — never hardcode the names.
 *
 * ── ⚠️ MASK POLARITY (measured 3 independent ways; counterintuitive) ──
 *   The MODEL wants  0 = inpaint/erase ,  255 = keep .
 *   Our brush mask canvas stores opaque WHITE (alpha 255) where the user wants to
 *   ERASE. So we INVERT: model_mask = (alpha > threshold) ? 0 : 255.
 *   Feeding alpha straight through would regenerate everything the user did NOT
 *   paint. This was the #1 trap of the commit — do not "simplify" it away.
 */

import * as ort from "onnxruntime-web/webgpu";
import { pickBackend, type Backend } from "./capabilities";
import { fetchModelBytes, type ProgressFn } from "./modelSource";
import { MODEL_KEY, readCachedModel, writeCachedModel } from "./modelCache";

const ORT_VERSION = "1.26.0";
// jsDelivr serves these wasm/mjs with `Cross-Origin-Resource-Policy: cross-origin`
// + `Access-Control-Allow-Origin: *`, so they pass our COEP:require-corp. Do NOT
// vendor them; do NOT point at an origin that omits CORP or the worker won't load.
const WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let _envBaseConfigured = false;
let _envBackend: Backend | null = null;
function configureEnv(backend: Backend) {
  // NOTE: ort.env.wasm is a GLOBAL singleton shared with the SAM/segment engine
  // (both import the same onnxruntime-web/webgpu chunk). So this MUST re-apply on
  // every backend change — a one-shot `if (configured) return` would let a stale
  // proxy=true from a wasm run leak into a later webgpu attempt (in either engine)
  // and make InferenceSession.create() throw "worker not ready".
  if (!_envBaseConfigured) {
    ort.env.wasm.wasmPaths = WASM_PATHS;
    _envBaseConfigured = true;
  }
  if (_envBackend === backend) return;
  if (backend === "webgpu") {
    // WebGPU EP does the heavy lifting on-GPU; one helper thread is plenty.
    // proxy=false is CRUCIAL: routing the GPU EP through the proxy Worker adds
    // only a race surface and is what throws "worker not ready" on real GPUs.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  } else {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    ort.env.wasm.numThreads = Math.min(cores, 4);
    ort.env.wasm.proxy = true; // keep the (slow) WASM compute off the UI thread
  }
  _envBackend = backend;
}

export interface InpaintStatus {
  /** "download" while fetching model bytes, "run" during inference. */
  phase: "download" | "compile" | "run";
  /** 0..1 for the download phase; undefined for indeterminate phases. */
  progress?: number;
}

let _sessionPromise: Promise<ort.InferenceSession> | null = null;
let _backend: Backend | null = null;

/** True once the model is cached in this session (drives "Erase" vs "Download & erase"). */
export async function isModelReady(): Promise<boolean> {
  if (_sessionPromise) return true;
  return (await readCachedModel(MODEL_KEY)) !== null;
}

/**
 * Lazily create (and memoize) the inference session. First call downloads the
 * model (or reads it from IndexedDB) and compiles it for the chosen backend.
 */
async function getSession(onStatus?: (s: InpaintStatus) => void): Promise<ort.InferenceSession> {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    const backend = await pickBackend();
    _backend = backend;
    configureEnv(backend);

    // 1. Model bytes: cache → else download shards (with progress) → cache.
    let bytes = await readCachedModel(MODEL_KEY);
    if (!bytes) {
      const onProgress: ProgressFn = (f) => onStatus?.({ phase: "download", progress: f });
      onStatus?.({ phase: "download", progress: 0 });
      bytes = await fetchModelBytes(onProgress);
      await writeCachedModel(MODEL_KEY, bytes);
    }

    // 2. Compile/instantiate the session for the chosen execution provider.
    onStatus?.({ phase: "compile" });
    try {
      return await ort.InferenceSession.create(bytes, {
        executionProviders: [backend],
      });
    } catch (e) {
      // WebGPU can fail at compile time on some drivers even when an adapter
      // existed — fall back to WASM once before giving up.
      if (backend === "webgpu") {
        console.warn("[inpaint] WebGPU session failed, falling back to WASM", e);
        _backend = "wasm";
        // configureEnv is backend-keyed + idempotent — switching to "wasm"
        // re-applies proxy/numThreads with no manual reset needed.
        configureEnv("wasm");
        return await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
      }
      throw e;
    }
  })();
  // If creation fails, clear the memo so a retry can start fresh.
  _sessionPromise.catch(() => {
    _sessionPromise = null;
  });
  return _sessionPromise;
}

/** Pack a canvas's RGBA ImageData into planar RGB-CHW uint8 (drops alpha). */
function packCHW(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const size = width * height;
  const chw = new Uint8Array(3 * size);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    chw[i] = data[p]; // R plane
    chw[size + i] = data[p + 1]; // G plane
    chw[2 * size + i] = data[p + 2]; // B plane
  }
  return chw;
}

/**
 * Adaptive dilation radius (in source pixels) for the erase mask. A real brush
 * leaves a 2–4px ring of the object un-painted at its edge (anti-aliased stroke +
 * the user stopping just short of the boundary); MI-GAN faithfully KEEPS that ring,
 * leaving a faint ghost outline of the "removed" object. Growing the mask outward
 * by a few px before inference swallows that halo — the standard move every polished
 * eraser makes. Verified against the real ONNX: a 4px gap needs radius ≥5 to fully
 * clean (the dilation must EXCEED the gap); modest background overspill is harmless
 * because the model refills it from surrounding context.
 *
 * ~1% of the longest edge, clamped to [4, 24]: 5px @480, 10px @1024, 19px @1080,
 * 24px cap @4K+. Kills the measured gaps without erasing into neighbouring objects.
 */
export function dilationRadius(width: number, height: number): number {
  return Math.max(4, Math.min(24, Math.round(0.01 * Math.max(width, height))));
}

/**
 * Grow the erase region (value 0) outward by `radius` px using a separable two-pass
 * max-filter over the KEEP mask's complement. Operating on `keep = (val===255)`:
 * a pixel becomes erase(0) if ANY pixel within the square (2r+1) window is erase.
 * Two 1-D passes (horizontal then vertical) give a square structuring element in
 * O(width·height·radius) with no allocation beyond two scratch rows — fast enough
 * for a 40MP mask in a few ms. (Matches the reference square-dilation we validated
 * empirically in Python.)
 */
function dilateErase(mask: Uint8Array, width: number, height: number, radius: number): void {
  if (radius <= 0) return;

  // Pass 1 — horizontal: for each row, a cell is erase(0) if any cell within
  // ±radius columns is erase. Use a running count of erase pixels in the window.
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let eraseInWindow = 0;
    // prime the window [0, radius]
    for (let x = 0; x <= radius && x < width; x++) {
      if (mask[row + x] === 0) eraseInWindow++;
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = eraseInWindow > 0 ? 0 : 255;
      // slide: drop column x-radius, add column x+radius+1
      const out = x - radius;
      const inc = x + radius + 1;
      if (out >= 0 && mask[row + out] === 0) eraseInWindow--;
      if (inc < width && mask[row + inc] === 0) eraseInWindow++;
    }
  }

  // Pass 2 — vertical over tmp, writing back into mask.
  for (let x = 0; x < width; x++) {
    let eraseInWindow = 0;
    for (let y = 0; y <= radius && y < height; y++) {
      if (tmp[y * width + x] === 0) eraseInWindow++;
    }
    for (let y = 0; y < height; y++) {
      mask[y * width + x] = eraseInWindow > 0 ? 0 : 255;
      const out = y - radius;
      const inc = y + radius + 1;
      if (out >= 0 && tmp[out * width + x] === 0) eraseInWindow--;
      if (inc < height && tmp[inc * width + x] === 0) eraseInWindow++;
    }
  }
}

/**
 * Build the model mask plane from the brush mask's alpha channel, INVERTING
 * polarity (model wants 0 = erase, 255 = keep; our brush paints alpha=255 = erase),
 * then DILATING the erase region to swallow the brush-edge halo.
 */
function packMaskInverted(
  maskData: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const size = width * height;
  const m = new Uint8Array(size);
  // alpha is byte 3 of each RGBA quad. Any non-trivial alpha = user wants to erase.
  for (let i = 0, p = 3; i < size; i++, p += 4) {
    m[i] = maskData[p] > 8 ? 0 : 255;
  }
  dilateErase(m, width, height, dilationRadius(width, height));
  return m;
}

/** Unpack planar RGB-CHW uint8 back into RGBA ImageData (opaque alpha). */
function unpackCHW(chw: Uint8Array | Uint8ClampedArray, width: number, height: number): ImageData {
  const size = width * height;
  const rgba = new Uint8ClampedArray(size * 4);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    rgba[p] = chw[i];
    rgba[p + 1] = chw[size + i];
    rgba[p + 2] = chw[2 * size + i];
    rgba[p + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

export interface InpaintResult {
  bitmap: ImageBitmap;
  backend: Backend;
}

/**
 * Erase the masked region of `image` and return a new full-resolution bitmap.
 *
 * @param image      the source photo (full working resolution)
 * @param maskCanvas the brush mask canvas (same WxH as image; white = erase)
 */
export async function inpaint(
  image: ImageBitmap,
  maskCanvas: HTMLCanvasElement,
  onStatus?: (s: InpaintStatus) => void,
): Promise<InpaintResult> {
  const width = image.width;
  const height = image.height;

  const session = await getSession(onStatus);

  // Read source pixels at full resolution via an OffscreenCanvas (no DOM, no
  // display scaling — these are the exact bytes the model sees).
  const srcCanvas = new OffscreenCanvas(width, height);
  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("Could not get 2D context for source image");
  sctx.drawImage(image, 0, 0);
  const imgData = sctx.getImageData(0, 0, width, height).data;

  // Read mask pixels. The mask canvas is already at source resolution.
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!mctx) throw new Error("Could not get 2D context for mask");
  const maskData = mctx.getImageData(0, 0, width, height).data;

  const imageTensor = new ort.Tensor("uint8", packCHW(imgData, width, height), [1, 3, height, width]);
  const maskTensor = new ort.Tensor("uint8", packMaskInverted(maskData, width, height), [1, 1, height, width]);

  onStatus?.({ phase: "run" });
  const feeds: Record<string, ort.Tensor> = {
    [session.inputNames[0]]: imageTensor,
    [session.inputNames[1]]: maskTensor,
  };
  const results = await session.run(feeds);
  const out = results[session.outputNames[0]];
  const outData = out.data as Uint8Array;

  const resultImageData = unpackCHW(outData, width, height);
  const bitmap = await createImageBitmap(resultImageData);
  return { bitmap, backend: _backend ?? "wasm" };
}
