/**
 * decodeImage — turn a user-supplied File/Blob into a clean, display-ready
 * ImageBitmap that is the single source of truth for the editor.
 *
 * Why this is its own module (and not inline in the React island):
 *  - It is pure + framework-agnostic, so Phase 3's crop-bbox inpaint pipeline
 *    and a future Web Worker can reuse it.
 *  - It centralises the two correctness guarantees the whole product leans on:
 *
 *    1. EXIF ORIENTATION is baked in. Phone photos carry an Orientation tag
 *       (e.g. "rotate 90° CW") instead of physically-rotated pixels. We decode
 *       with `imageOrientation: "from-image"` so the bitmap's pixels are already
 *       upright — every downstream coordinate (brush mask, bbox crop, composite)
 *       then works in one obvious space with no rotation bookkeeping.
 *
 *    2. METADATA never survives. createImageBitmap → canvas re-export keeps only
 *       raw RGBA; GPS, camera model, timestamps are all dropped. This is the
 *       "your photo never leaves your device — and we don't even keep the GPS
 *       tag" promise, achieved with zero dependencies.
 *
 * Memory discipline: an absurd input (108-MP, or a decompression-bomb PNG) is
 * downscaled ONCE here to MAX_MEGAPIXELS so every later full-res buffer (source,
 * mask, composite) is bounded. Real phone photos (12–50 MP) pass through
 * untouched or with a single high-quality reduction.
 */

/** Hard ceiling on the working source. 40 MP ≈ 7300×5500 — larger than any
 *  phone sensor's useful output, and keeps a full-res RGBA buffer near ~160 MB
 *  so the later mask + composite layers stay within mobile memory budgets.
 *  Tunable; the crop-bbox pipeline only model-processes the masked patch, so
 *  this cap costs almost no real-world sharpness. */
export const MAX_MEGAPIXELS = 40;

/** Reject files above this size before we even try to decode (a cheap DoS /
 *  fat-finger guard; the real constraint is MAX_MEGAPIXELS after decode). */
export const MAX_FILE_BYTES = 60 * 1024 * 1024; // 60 MB

/** MIME types the browser can reliably decode to pixels. HEIC/HEIF are handled
 *  with a dedicated, friendlier error (see below) rather than a generic failure. */
const DECODABLE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/bmp",
]);

export type DecodeErrorCode =
  | "too-large"
  | "heic-unsupported"
  | "unsupported-type"
  | "decode-failed"
  | "empty";

export class ImageDecodeError extends Error {
  code: DecodeErrorCode;
  constructor(code: DecodeErrorCode, message: string) {
    super(message);
    this.name = "ImageDecodeError";
    this.code = code;
  }
}

export interface DecodedImage {
  /** EXIF-oriented, metadata-free, possibly-downscaled source of truth.
   *  Caller owns this and MUST call `.close()` on it when discarding. */
  bitmap: ImageBitmap;
  /** Oriented working dimensions (== bitmap.width/height). */
  width: number;
  height: number;
  /** Display name for the toolbar (filename, or a generated name for pastes). */
  name: string;
  /** Original MIME (best-effort; may be "" for some paste sources). */
  type: string;
  /** Original byte size of the input blob. */
  sizeBytes: number;
  /** True when the source exceeded MAX_MEGAPIXELS and was reduced on load. */
  downscaled: boolean;
  /** Oriented dimensions BEFORE any downscale (for an honest "reduced from" note). */
  sourceWidth: number;
  sourceHeight: number;
}

function looksLikeHeic(blob: Blob, name: string): boolean {
  const t = (blob.type || "").toLowerCase();
  if (t === "image/heic" || t === "image/heif") return true;
  return /\.(heic|heif)$/i.test(name);
}

/** Draw an oriented bitmap down to a target pixel size with a high-quality
 *  resample, returning a fresh ImageBitmap. Used only on the oversized path. */
async function downscaleBitmap(
  src: ImageBitmap,
  targetW: number,
  targetH: number,
): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageDecodeError("decode-failed", "Canvas 2D unavailable.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, targetW, targetH);
  return createImageBitmap(canvas);
}

/**
 * Decode a File/Blob into a DecodedImage. Throws ImageDecodeError with a
 * machine-readable `.code` so the UI can show a targeted message (and, for
 * HEIC, cross-link to HEICPix).
 */
export async function decodeImage(
  blob: Blob,
  name = "image",
): Promise<DecodedImage> {
  if (!blob || blob.size === 0) {
    throw new ImageDecodeError("empty", "That file appears to be empty.");
  }
  if (blob.size > MAX_FILE_BYTES) {
    const mb = (blob.size / (1024 * 1024)).toFixed(0);
    throw new ImageDecodeError(
      "too-large",
      `That file is ${mb} MB — over the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit.`,
    );
  }
  if (looksLikeHeic(blob, name)) {
    throw new ImageDecodeError(
      "heic-unsupported",
      "HEIC photos can’t be opened directly in the browser. Convert it to JPG or PNG first (try heicpix.com — also free and on-device), then drop it here.",
    );
  }
  // Allow empty type (some paste/drag sources omit it) but reject known-bad ones.
  if (blob.type && !DECODABLE_TYPES.has(blob.type.toLowerCase())) {
    throw new ImageDecodeError(
      "unsupported-type",
      `“${blob.type}” isn’t a supported image format. Use JPG, PNG, WebP, or AVIF.`,
    );
  }

  // First pass: orient + strip metadata. This is the source-of-truth decode.
  let oriented: ImageBitmap;
  try {
    oriented = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new ImageDecodeError(
      "decode-failed",
      "We couldn’t read that image. It may be corrupted or in an unsupported format.",
    );
  }

  const sourceWidth = oriented.width;
  const sourceHeight = oriented.height;
  const megapixels = (sourceWidth * sourceHeight) / 1_000_000;

  if (megapixels <= MAX_MEGAPIXELS) {
    return {
      bitmap: oriented,
      width: sourceWidth,
      height: sourceHeight,
      name,
      type: blob.type || "",
      sizeBytes: blob.size,
      downscaled: false,
      sourceWidth,
      sourceHeight,
    };
  }

  // Oversized: reduce once, preserving aspect ratio, then free the original.
  const scale = Math.sqrt(MAX_MEGAPIXELS / megapixels);
  const targetW = Math.max(1, Math.round(sourceWidth * scale));
  const targetH = Math.max(1, Math.round(sourceHeight * scale));
  let reduced: ImageBitmap;
  try {
    reduced = await downscaleBitmap(oriented, targetW, targetH);
  } finally {
    oriented.close();
  }

  return {
    bitmap: reduced,
    width: reduced.width,
    height: reduced.height,
    name,
    type: blob.type || "",
    sizeBytes: blob.size,
    downscaled: true,
    sourceWidth,
    sourceHeight,
  };
}

/** Pull the first image blob out of a paste/drop DataTransfer, or null. */
export function imageBlobFromDataTransfer(dt: DataTransfer | null): {
  blob: Blob;
  name: string;
} | null {
  if (!dt) return null;
  // Prefer files (drag-drop, some pastes), then fall back to clipboard items.
  if (dt.files && dt.files.length > 0) {
    for (const f of Array.from(dt.files)) {
      if (f.type.startsWith("image/") || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)$/i.test(f.name)) {
        return { blob: f, name: f.name || "image" };
      }
    }
  }
  if (dt.items && dt.items.length > 0) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) return { blob: f, name: f.name || "pasted-image" };
      }
    }
  }
  return null;
}
