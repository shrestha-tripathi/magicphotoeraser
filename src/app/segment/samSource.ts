/**
 * samSource — WHERE the SlimSAM model bytes come from, behind swappable functions.
 *
 * Unlike the MI-GAN inpaint model (28 MB → sharded to dodge Cloudflare's 25 MiB
 * per-asset cap), BOTH SlimSAM files fit UNDER the cap as single assets:
 *   - vision_encoder.onnx                23,276,014 B (22.2 MiB)  ✓ under 25 MiB
 *   - prompt_encoder_mask_decoder.onnx   16,557,892 B (15.8 MiB)  ✓ under 25 MiB
 * So no sharding — one fetch each. If a future model exceeds the cap, shard it
 * here exactly like modelSource.ts and the rest of the app is untouched.
 *
 * `import.meta.env.BASE_URL` keeps paths correct under any deploy base; the
 * trailing-slash route config doesn't affect file assets.
 */

export type ProgressFn = (fraction: number) => void;

/** The two vendored SlimSAM model files (Apache-2.0, Xenova/slimsam-77-uniform). */
export const SAM_ENCODER_FILE = "slimsam_vision_encoder.onnx";
export const SAM_DECODER_FILE = "slimsam_prompt_encoder_mask_decoder.onnx";

function modelUrl(file: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/models/${file}`;
}

/**
 * Fetch a single model file with byte-accurate progress. Streams the body so the
 * progress bar is smooth; falls back to arrayBuffer() when the stream or
 * Content-Length is unavailable.
 */
export async function fetchSamModel(file: string, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const url = modelUrl(file);

  let total = 0;
  try {
    const head = await fetch(url, { method: "HEAD" });
    total = Number(head.headers.get("content-length") || "0");
    if (!Number.isFinite(total)) total = 0;
  } catch {
    total = 0;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SAM model ${file} failed: HTTP ${res.status}`);

  if (res.body && total > 0) {
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let downloaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        downloaded += value.length;
        onProgress?.(Math.min(0.999, downloaded / total));
      }
    }
    const out = new Uint8Array(downloaded);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    onProgress?.(1);
    return out.buffer;
  }

  const buf = await res.arrayBuffer();
  onProgress?.(1);
  return buf;
}
