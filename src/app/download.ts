/**
 * download — export a result bitmap to a file the user can save.
 *
 * Renders the full working-resolution bitmap to an OffscreenCanvas and encodes it
 * client-side (no upload). EXIF/metadata is already gone (it was stripped at decode
 * via the createImageBitmap → canvas round-trip), so the export carries no GPS /
 * camera tags — consistent with the privacy promise. No watermark, ever.
 */

export type DownloadFormat = "png" | "jpeg";

/** Pick a sensible default output format from the original file's MIME/extension.
 *  PNG sources (often screenshots / graphics with hard edges or transparency) stay
 *  PNG; everything photographic (JPEG/HEIC/etc.) exports as JPEG to keep files small. */
export function defaultFormatFor(mime: string, name: string): DownloadFormat {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  if (m === "image/png" || n.endsWith(".png")) return "png";
  return "jpeg";
}

const EXT: Record<DownloadFormat, string> = { png: "png", jpeg: "jpg" };
const CONTENT_TYPE: Record<DownloadFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
};

/** Build the download filename: `<base>-erased.<ext>`, preserving the user's name. */
export function downloadName(originalName: string, format: DownloadFormat): string {
  const base = (originalName || "image").replace(/\.[^./\\]+$/, "") || "image";
  return `${base}-erased.${EXT[format]}`;
}

/**
 * Encode `bitmap` and trigger a browser download. Returns the blob size in bytes
 * (useful for a "saved 2.1 MB" affordance later). JPEG quality is high (0.92) so
 * the give-away result still looks pristine.
 */
export async function downloadBitmap(
  bitmap: ImageBitmap,
  originalName: string,
  format: DownloadFormat,
): Promise<number> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context for export");

  // JPEG has no alpha — paint a white matte first so any transparent pixels don't
  // encode as black. PNG keeps transparency.
  if (format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);

  const blob = await canvas.convertToBlob({
    type: CONTENT_TYPE[format],
    quality: format === "jpeg" ? 0.92 : undefined,
  });

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(originalName, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  return blob.size;
}
