/**
 * runSegment — on-device click-to-select via SlimSAM (SAM family), fully in the
 * browser (WebGPU, WASM fallback). Click an object → a pixel mask of it.
 *
 * Model: Xenova/slimsam-77-uniform ONNX exports (Apache-2.0). TWO graphs:
 *   - vision_encoder.onnx              (22.2 MiB) — runs ONCE per image
 *   - prompt_encoder_mask_decoder.onnx (15.8 MiB) — runs per CLICK (cheap)
 *
 * The encode-once / decode-per-click split is the whole UX win: the heavy ViT
 * encode (~1–3 s) happens once when the user first clicks a given image, its
 * embedding is cached, and every subsequent click is just the tiny decoder (~ms)
 * → instant mask feedback.
 *
 * ── I/O CONTRACT (EMPIRICALLY PROBED against the real .onnx — the Transformers.js
 *    export differs HARD from the Meta SAM ONNX; do not assume the Meta signature) ──
 *   ENCODER  in : pixel_values  f32 [1,3,1024,1024]
 *            out: image_embeddings f32 [1,256,64,64]
 *                 image_positional_embeddings f32 [1,256,64,64]   ← BOTH feed decoder
 *   DECODER  in : input_points  f32   [1,1,N,2]   (x,y) in 1024-space
 *                 input_labels  int64 [1,1,N]     1=fg, 0=bg, -1=pad
 *                 image_embeddings f32 [1,256,64,64]
 *                 image_positional_embeddings f32 [1,256,64,64]
 *            out: iou_scores f32 [1,1,3]
 *                 pred_masks f32 [1,1,3,256,256]  ← RAW LOGITS, threshold > 0
 *   Pick the mask channel with the highest iou_score. Access tensors by NAME
 *   (the names are stable in this export: pixel_values / input_points / etc.).
 */

import * as ort from "onnxruntime-web/webgpu";
import { pickBackend, type Backend } from "../inpaint/capabilities";
import {
  fetchSamModel,
  SAM_ENCODER_FILE,
  SAM_DECODER_FILE,
  type ProgressFn,
} from "./samSource";
import {
  readCachedSam,
  writeCachedSam,
  SAM_ENCODER_KEY,
  SAM_DECODER_KEY,
} from "./samCache";
import {
  SAM_SIZE,
  samGeometry,
  buildPixelValues,
  clickToModel,
  maskLogitsToSource,
  type SamGeometry,
} from "./preprocess";

const ORT_VERSION = "1.26.0";
// jsDelivr serves the wasm/mjs with CORP:cross-origin + ACAO:* → passes our
// COEP:require-corp. Same source the inpaint runtime uses; keep them aligned.
const WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let _envConfigured = false;
function configureEnv(backend: Backend) {
  if (_envConfigured) return;
  ort.env.wasm.wasmPaths = WASM_PATHS;
  if (backend === "webgpu") {
    ort.env.wasm.numThreads = 1;
  } else {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    ort.env.wasm.numThreads = Math.min(cores, 4);
    ort.env.wasm.proxy = true;
  }
  _envConfigured = true;
}

export interface SegmentStatus {
  /** "download" while fetching models, "compile" while building sessions,
   *  "encode" during the one-time per-image image encode. */
  phase: "download" | "compile" | "encode";
  /** 0..1 for the download phase; undefined for indeterminate phases. */
  progress?: number;
}

interface SamSessions {
  encoder: ort.InferenceSession;
  decoder: ort.InferenceSession;
  backend: Backend;
}

let _sessionsPromise: Promise<SamSessions> | null = null;

/** True once the SAM models are cached (this session or in IDB). */
export async function isSamReady(): Promise<boolean> {
  if (_sessionsPromise) return true;
  const [enc, dec] = await Promise.all([
    readCachedSam(SAM_ENCODER_KEY),
    readCachedSam(SAM_DECODER_KEY),
  ]);
  return enc !== null && dec !== null;
}

async function loadBytes(
  key: string,
  file: string,
  onProgress: ProgressFn,
): Promise<ArrayBuffer> {
  const cached = await readCachedSam(key);
  if (cached) {
    onProgress(1);
    return cached;
  }
  const bytes = await fetchSamModel(file, onProgress);
  await writeCachedSam(key, bytes);
  return bytes;
}

async function getSessions(onStatus?: (s: SegmentStatus) => void): Promise<SamSessions> {
  if (_sessionsPromise) return _sessionsPromise;
  _sessionsPromise = (async () => {
    const backend = await pickBackend();
    configureEnv(backend);

    // Download both models with a combined progress bar (encoder ~58%, decoder ~42%).
    onStatus?.({ phase: "download", progress: 0 });
    const ENC_FRAC = 0.58;
    const encBytes = await loadBytes(SAM_ENCODER_KEY, SAM_ENCODER_FILE, (f) =>
      onStatus?.({ phase: "download", progress: f * ENC_FRAC }),
    );
    const decBytes = await loadBytes(SAM_DECODER_KEY, SAM_DECODER_FILE, (f) =>
      onStatus?.({ phase: "download", progress: ENC_FRAC + f * (1 - ENC_FRAC) }),
    );

    onStatus?.({ phase: "compile" });
    const create = async (bytes: ArrayBuffer, ep: Backend) =>
      ort.InferenceSession.create(bytes, { executionProviders: [ep] });

    try {
      const [encoder, decoder] = await Promise.all([
        create(encBytes, backend),
        create(decBytes, backend),
      ]);
      return { encoder, decoder, backend };
    } catch (e) {
      if (backend === "webgpu") {
        console.warn("[segment] WebGPU session failed, falling back to WASM", e);
        _envConfigured = false;
        configureEnv("wasm");
        const [encoder, decoder] = await Promise.all([
          create(encBytes, "wasm"),
          create(decBytes, "wasm"),
        ]);
        return { encoder, decoder, backend: "wasm" };
      }
      throw e;
    }
  })();
  _sessionsPromise.catch(() => {
    _sessionsPromise = null;
  });
  return _sessionsPromise;
}

/**
 * A per-image SAM context: holds the encoder's two embedding tensors so repeated
 * clicks only pay the (cheap) decoder cost. Create once per loaded image; call
 * `segment(sx, sy)` on each click; call `dispose()` when the image changes.
 */
export interface SamContext {
  segment(sx: number, sy: number): Promise<Uint8Array>;
  readonly geom: SamGeometry;
  readonly backend: Backend;
  dispose(): void;
}

/**
 * Encode an image ONCE and return a context whose `segment()` runs only the
 * decoder per click. `onStatus` reports model download/compile/encode progress.
 */
export async function createSamContext(
  bitmap: ImageBitmap,
  srcW: number,
  srcH: number,
  onStatus?: (s: SegmentStatus) => void,
): Promise<SamContext> {
  const { encoder, decoder, backend } = await getSessions(onStatus);
  const geom = samGeometry(srcW, srcH);

  // One-time image encode.
  onStatus?.({ phase: "encode" });
  const pixelValues = new ort.Tensor("float32", buildPixelValues(bitmap, geom), [
    1,
    3,
    SAM_SIZE,
    SAM_SIZE,
  ]);
  const encOut = await encoder.run({ pixel_values: pixelValues });
  // Extract the embedding DATA (plain Float32Arrays) + shapes once. We must NOT
  // reuse the encoder's output Tensor objects directly across decoder.run() calls:
  // in WASM proxy mode ORT transfers (detaches) each input tensor's ArrayBuffer to
  // the worker, so a second click would throw "ArrayBuffer is already detached"
  // (DataCloneError). Instead we keep the raw data and build a FRESH tensor (with a
  // copied buffer) for every decode — cheap (~1 MB each) and detachment-proof.
  const embData = (encOut.image_embeddings.data as Float32Array).slice();
  const embDims = encOut.image_embeddings.dims as readonly number[];
  const posData = (encOut.image_positional_embeddings.data as Float32Array).slice();
  const posDims = encOut.image_positional_embeddings.dims as readonly number[];
  // Free the original output tensors now that we've copied their data out.
  encOut.image_embeddings.dispose?.();
  encOut.image_positional_embeddings.dispose?.();

  let disposed = false;

  const segment = async (sx: number, sy: number): Promise<Uint8Array> => {
    if (disposed) throw new Error("SAM context disposed");
    const [mx, my] = clickToModel(sx, sy, geom);
    // input_points f32 [1,1,N,2]; input_labels int64 [1,1,N] (1 = foreground).
    const inputPoints = new ort.Tensor("float32", Float32Array.from([mx, my]), [1, 1, 1, 2]);
    const inputLabels = new ort.Tensor("int64", BigInt64Array.from([1n]), [1, 1, 1]);
    // Fresh embedding tensors per call (copied buffers) — see note above.
    const imageEmbeddings = new ort.Tensor("float32", embData.slice(), embDims as number[]);
    const imagePositionalEmbeddings = new ort.Tensor("float32", posData.slice(), posDims as number[]);

    const decOut = await decoder.run({
      input_points: inputPoints,
      input_labels: inputLabels,
      image_embeddings: imageEmbeddings,
      image_positional_embeddings: imagePositionalEmbeddings,
    });
    const iou = decOut.iou_scores.data as Float32Array; // [3]
    const masks = decOut.pred_masks.data as Float32Array; // [3,256,256] flattened
    const maskSide = 256;
    const stride = maskSide * maskSide;
    // Pick the highest-IoU of the 3 candidate masks.
    let best = 0;
    for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
    const bestLogits = masks.subarray(best * stride, (best + 1) * stride);
    return maskLogitsToSource(bestLogits as Float32Array, maskSide, geom);
  };

  return {
    segment,
    geom,
    backend,
    dispose() {
      disposed = true;
      // The embedding DATA is plain Float32Arrays (GC'd when this context is
      // dropped); per-call tensors are disposed implicitly by ORT. Marking
      // `disposed` prevents any in-flight segment() from running post-dispose.
    },
  };
}
