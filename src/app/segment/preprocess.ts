/**
 * preprocess — turn the user's photo + click into the exact tensors SlimSAM's
 * ONNX graph expects, and map mask logits back to source pixels.
 *
 * ── ALL math below was EMPIRICALLY VERIFIED against the real .onnx under python
 *    onnxruntime (probed the I/O, ran inference on synthetic + non-square images;
 *    click → mask IoU 1.000 vs ground truth). Do not "simplify" without re-probing.
 *
 * SamImageProcessor contract (from the model's preprocessor_config.json):
 *   1. RGB
 *   2. resize so the LONGEST edge == 1024 (bilinear), preserving aspect ratio
 *   3. rescale ×1/255
 *   4. normalize with ImageNet mean/std
 *   5. pad bottom + right to 1024×1024 (TOP-LEFT anchored, pad value 0)
 *
 * Because padding is bottom-right only (no centering), every coordinate map is a
 * pure uniform scale by `1024 / max(srcW, srcH)` — no offset term.
 */

export const SAM_SIZE = 1024; // model input is 1024×1024
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export interface SamGeometry {
  /** source→model scale: model_px = source_px * scale. */
  scale: number;
  /** Width of the (unpadded) resized image inside the 1024 canvas. */
  resizedW: number;
  /** Height of the (unpadded) resized image inside the 1024 canvas. */
  resizedH: number;
  srcW: number;
  srcH: number;
}

export function samGeometry(srcW: number, srcH: number): SamGeometry {
  const scale = SAM_SIZE / Math.max(srcW, srcH);
  return {
    scale,
    resizedW: Math.round(srcW * scale),
    resizedH: Math.round(srcH * scale),
    srcW,
    srcH,
  };
}

/**
 * Build the encoder's `pixel_values` tensor data: f32 [1,3,1024,1024], RGB-CHW,
 * ImageNet-normalized, resized-longest-edge + padded bottom-right with zeros.
 *
 * We draw the source bitmap into a 1024×1024 OffscreenCanvas at the resized size
 * (top-left), letting the 2D context do the high-quality bilinear downscale, then
 * read it back once. The padded region stays at the canvas's cleared value; we
 * normalize it as 0-pixels (matching HF's "pad the pixel image with 0, then
 * normalize" → padded area becomes (0-mean)/std, which the model was trained with).
 */
export function buildPixelValues(
  bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  geom: SamGeometry,
): Float32Array {
  const canvas = new OffscreenCanvas(SAM_SIZE, SAM_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context for SAM preprocess");
  // Cleared canvas = transparent black (0,0,0,0). Draw the resized image top-left.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, geom.resizedW, geom.resizedH);
  const { data } = ctx.getImageData(0, 0, SAM_SIZE, SAM_SIZE);

  const size = SAM_SIZE * SAM_SIZE;
  const out = new Float32Array(3 * size);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    // Channel-planar (CHW): R plane, G plane, B plane.
    out[i] = (data[p] / 255 - MEAN[0]) / STD[0];
    out[size + i] = (data[p + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * size + i] = (data[p + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

/** Map a source-pixel click to model (1024) space. */
export function clickToModel(
  sx: number,
  sy: number,
  geom: SamGeometry,
): [number, number] {
  return [sx * geom.scale, sy * geom.scale];
}

/**
 * Upscale the decoder's 256×256 logit mask to a SOURCE-resolution binary mask.
 *
 * pred_masks are RAW LOGITS (verified range ~ -32..+21); threshold at > 0. The
 * 256 grid corresponds to the FULL padded 1024 canvas, so to land on source px:
 *   256-space → ×(1024/256)=×4 → 1024-space → keep only the unpadded region
 *   (x < resizedW, y < resizedH) → ÷scale → source px.
 *
 * Returns a Uint8Array of length srcW*srcH where 255 = object (selected), 0 = not.
 * Nearest-neighbour upsample is fine here — the mask feeds the inpaint dilation
 * which already grows the region by several px, so sub-pixel edge exactness is
 * not the bottleneck (the brush has the same property).
 */
export function maskLogitsToSource(
  logits: Float32Array,
  maskSide: number, // 256
  geom: SamGeometry,
): Uint8Array {
  const { srcW, srcH, scale } = geom;
  const out = new Uint8Array(srcW * srcH);
  const modelPerMask = SAM_SIZE / maskSide; // 1024/256 = 4
  // For each source pixel, sample the corresponding mask logit.
  for (let sy = 0; sy < srcH; sy++) {
    const my = sy * scale; // → 1024-space (unpadded region only, always < resizedH)
    const maskY = Math.min(maskSide - 1, Math.floor(my / modelPerMask));
    const maskRow = maskY * maskSide;
    const outRow = sy * srcW;
    for (let sx = 0; sx < srcW; sx++) {
      const mx = sx * scale;
      const maskX = Math.min(maskSide - 1, Math.floor(mx / modelPerMask));
      out[outRow + sx] = logits[maskRow + maskX] > 0 ? 255 : 0;
    }
  }
  return out;
}
