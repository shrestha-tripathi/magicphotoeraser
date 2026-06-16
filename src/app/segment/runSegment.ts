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
import { pickBackend, isIOS, type Backend } from "../inpaint/capabilities";
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

let _envBaseConfigured = false;
let _envBackend: Backend | null = null;
function configureEnv(backend: Backend) {
  // wasmPaths only needs setting once; the rest MUST re-apply whenever the backend
  // changes (e.g. webgpu → wasm fallback, or a retry that re-picks webgpu). An
  // early `if (configured) return` is a TRAP here: ort.env.wasm is a GLOBAL shared
  // with the inpaint engine, so a stale proxy=true from a prior wasm run would leak
  // into a later webgpu attempt and make create() throw "worker not ready".
  if (!_envBaseConfigured) {
    ort.env.wasm.wasmPaths = WASM_PATHS;
    _envBaseConfigured = true;
  }
  if (_envBackend === backend) return;
  if (backend === "webgpu") {
    // GPU does the compute; one helper thread is plenty. CRUCIALLY proxy=false:
    // running the WebGPU EP through the proxy Worker adds nothing but a race
    // surface and is what made create() throw "worker not ready" on real-GPU
    // machines (esp. on a retry after a wasm fallback left proxy=true).
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  } else if (isIOS()) {
    // 🩸 iOS WASM: SINGLE-THREADED, NO proxy worker — same reason as runInpaint.
    // Threaded WASM holds a per-thread-sized SharedArrayBuffer resident for the
    // whole session; iOS WebKit jetsams the tab to reclaim it (the post-erase
    // crash a real-iPhone ?debug=1 trace pinned). 1 thread keeps the arena small
    // enough to survive. Slower, but the SAM encode is cached per image.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  } else {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    ort.env.wasm.numThreads = Math.min(cores, 4);
    ort.env.wasm.proxy = true;
  }
  _envBackend = backend;
}

export interface SegmentStatus {
  /** "download" while fetching models, "compile" while building sessions,
   *  "encode" during the one-time per-image image encode, "encode-done" right
   *  after encoder.run() resolves (proves the heavy ViT forward pass survived —
   *  the exact point iOS WebGPU jetsammed the tab; see capabilities.isIOS). */
  phase: "download" | "compile" | "encode" | "encode-done";
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

    // ⚠️ Build the two sessions SEQUENTIALLY — never via Promise.all. ORT-web
    // initializes its WASM/JSEP runtime lazily on the FIRST create(); a second
    // create() that races that init throws "worker not ready". The single-session
    // inpaint engine never tripped this, but SAM needs encoder + decoder, and the
    // race only bites on machines that actually select the webgpu EP — our headless
    // QA box has a NULL adapter, silently used wasm, and won the race by luck.
    // Awaiting the encoder fully warms the runtime before the decoder starts.
    const createBoth = async (ep: Backend) => {
      const encoder = await create(encBytes, ep);
      const decoder = await create(decBytes, ep);
      return { encoder, decoder };
    };

    try {
      const { encoder, decoder } = await createBoth(backend);
      return { encoder, decoder, backend };
    } catch (e) {
      if (backend === "webgpu") {
        console.warn("[segment] WebGPU session failed, falling back to WASM", e);
        // configureEnv is backend-keyed + idempotent now — switching to "wasm"
        // re-applies proxy/numThreads correctly without any manual reset flag.
        configureEnv("wasm");
        const { encoder, decoder } = await createBoth("wasm");
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
 * A single user click in SOURCE-image coordinates. `positive` true = "include
 * this region" (SAM label 1), false = "exclude this region" (SAM label 0).
 */
export interface SamPoint {
  sx: number;
  sy: number;
  positive: boolean;
}

// --- 3-mask cycling (c12) -------------------------------------------------
// SAM returns 3 candidate masks per decode (roughly: whole-object / part /
// sub-part). For a SINGLE click these are often genuinely distinct granularities,
// and letting the user cycle them is the classic SAM-demo affordance. But two of
// the three are frequently noise we must NOT offer:
//   • a GREEDY "whole-scene" mask that bleeds to the image borders, and
//   • a near-DUPLICATE of another candidate.
// 🔑 EMPIRICALLY MEASURED (python probe before coding): the greedy mask rings the
// image border (border-fraction ~0.48 vs ~0.0 for a clean object); distinct
// candidates have pairwise IoU well under 0.9 while dups sit ~0.98. So we order by
// IoU desc, drop greedy (high border coverage), drop dups, and fall back to the
// plain argmax if (pathologically) everything looked greedy — never return empty.
// order[0] reproduces the c11 single-point pick (and additionally drops the greedy
// whole-scene mask in the latent edge case where it would have won raw argmax).
const GREEDY_BORDER_FRAC = 0.3; // mask touching >30% of the border ring = scene bleed
const DEDUP_IOU = 0.9; // two candidates more similar than this = duplicates

function cycleOrder(masksLogits: Float32Array, iou: Float32Array, side: number): number[] {
  const stride = side * side;
  const bool: Uint8Array[] = [];
  const border: number[] = [];
  for (let k = 0; k < 3; k++) {
    const sub = masksLogits.subarray(k * stride, (k + 1) * stride);
    const b = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) b[i] = sub[i] > 0 ? 1 : 0;
    bool.push(b);
    // border-ring coverage: top+bottom rows + left+right cols (4·side cells).
    let set = 0;
    for (let x = 0; x < side; x++) set += b[x] + b[(side - 1) * side + x];
    for (let y = 0; y < side; y++) set += b[y * side] + b[y * side + side - 1];
    border.push(set / (4 * side));
  }
  const byIou = [0, 1, 2].sort((a, b) => iou[b] - iou[a]);
  const iouBetween = (a: Uint8Array, b: Uint8Array) => {
    let inter = 0,
      uni = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i],
        y = b[i];
      if (x | y) uni++;
      if (x & y) inter++;
    }
    return uni ? inter / uni : 1;
  };
  const kept: number[] = [];
  for (const k of byIou) {
    if (border[k] > GREEDY_BORDER_FRAC) continue; // greedy whole-scene bleed
    if (kept.some((j) => iouBetween(bool[k], bool[j]) > DEDUP_IOU)) continue; // dup
    kept.push(k);
  }
  if (kept.length === 0) kept.push(byIou[0]); // never return nothing
  return kept;
}

/**
 * A per-image SAM context: holds the encoder's two embedding tensors so repeated
 * clicks only pay the (cheap) decoder cost. Create once per loaded image; call
 * `segment(points)` with the accumulated +/- points on each refine; call
 * `dispose()` when the image changes.
 */
export interface SamContext {
  /**
   * Run the decoder for the accumulated point set. Returns ALL viable candidate
   * masks (source-res, 1=object) already ordered for cycling: `masks[0]` is the
   * default pick (== the c11 single-point choice), `masks[1..]` are alternative
   * granularities the user can cycle to. Length is 1–3 (greedy/dup candidates are
   * filtered out). See `cycleOrder`.
   */
  segment(points: SamPoint[]): Promise<SegmentResult>;
  readonly geom: SamGeometry;
  readonly backend: Backend;
  dispose(): void;
}

/** The ordered candidate masks from one decode (see SamContext.segment). */
export interface SegmentResult {
  /** 1–3 source-res masks (1=object), ordered: [0]=default, rest=cycle alternatives. */
  masks: Uint8Array[];
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
  // The heavy ViT forward pass SURVIVED — this is the exact call that jetsammed
  // the tab on iOS WebGPU (last log line was "SAM encode" with no return). On
  // WASM it completes; surface that so a ?debug=1 trace proves it on-device.
  onStatus?.({ phase: "encode-done" });
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

  const segment = async (points: SamPoint[]): Promise<SegmentResult> => {
    if (disposed) throw new Error("SAM context disposed");
    if (points.length === 0) {
      // No prompts → one empty mask (caller treats as "nothing selected").
      return { masks: [new Uint8Array(srcW * srcH)] };
    }

    // Build the point/label arrays in SAM 1024-space. 🔑 EMPIRICALLY VERIFIED
    // (python probe before coding): the transformers.js SlimSAM export REQUIRES a
    // trailing padding point [0,0] with label -1 — without it even a single click
    // produces a mask that bleeds across the whole image (50k px vs 11k px clean).
    // positive click → label 1 (include), negative → label 0 (exclude/subtract).
    const n = points.length + 1; // +1 padding point
    const coords = new Float32Array(n * 2);
    const labels = new BigInt64Array(n);
    points.forEach((p, i) => {
      const [mx, my] = clickToModel(p.sx, p.sy, geom);
      coords[i * 2] = mx;
      coords[i * 2 + 1] = my;
      labels[i] = p.positive ? 1n : 0n;
    });
    // padding point at the end: (0,0) / label -1
    coords[points.length * 2] = 0;
    coords[points.length * 2 + 1] = 0;
    labels[points.length] = -1n;

    const inputPoints = new ort.Tensor("float32", coords, [1, 1, n, 2]);
    const inputLabels = new ort.Tensor("int64", labels, [1, 1, n]);
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

    if (points.length > 1) {
      // 🔑 REFINING (multi-point): no cycling. The user's +/- points already
      // express the intended shape, so we return the SINGLE best mask. EMPIRICALLY
      // VERIFIED selection: pick the highest-IoU candidate but EXCLUDE index 0 —
      // idx 0 is SAM's greedy "whole scene" mask, which on a refine reports a
      // misleadingly-high IoU on a noise-riddled mask (measured 40k-px garbage vs
      // the correct 9k-px refined mask at idx 1).
      let best = 1;
      for (let i = 2; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
      const bestLogits = masks.subarray(best * stride, (best + 1) * stride);
      return { masks: [maskLogitsToSource(bestLogits as Float32Array, maskSide, geom)] };
    }

    // 🔑 SINGLE point: return the viable candidates ordered for cycling. order[0]
    // is the default pick (greedy-scene + dup candidates filtered out, then IoU
    // desc) and matches the c11 single-point choice; order[1..] are alternative
    // granularities (e.g. click a face → cycle to the whole head → the whole body).
    const order = cycleOrder(masks, iou, maskSide);
    return {
      masks: order.map((k) =>
        maskLogitsToSource(masks.subarray(k * stride, (k + 1) * stride) as Float32Array, maskSide, geom),
      ),
    };
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
