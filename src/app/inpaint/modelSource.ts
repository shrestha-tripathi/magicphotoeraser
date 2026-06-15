/**
 * modelSource — WHERE the model bytes come from, behind one swappable function.
 *
 * Why sharded: the assembled model is ~28 MB, but Cloudflare Pages hard-caps a
 * single served asset at 25 MiB. A 28 MB file in `public/` would build fine
 * locally yet 404 in production. So we ship it as 2× ~13.4 MiB shards
 * (`migan_pipeline_v2.onnx.part0` / `.part1`), fetch both, and concat the buffers.
 *
 * This is the ONLY place that knows about shards. If we later move the model to a
 * Cloudflare R2 bucket (single object, no 25 MiB limit) the rest of the app is
 * untouched — just rewrite `fetchModelBytes()` to fetch one URL. Keep it that way.
 *
 * `import.meta.env.BASE_URL` keeps the paths correct under any deploy base, and
 * trailing-slash config doesn't affect file assets (only routes).
 */

/** Ordered shard URLs that concat into the full model. */
function shardUrls(): string[] {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return [
    `${base}/models/migan_pipeline_v2.onnx.part0`,
    `${base}/models/migan_pipeline_v2.onnx.part1`,
  ];
}

export type ProgressFn = (fraction: number) => void;

/**
 * Fetch every shard with byte-accurate progress and return the assembled model.
 * Progress is computed across the SUM of all shard sizes so the bar is smooth
 * and monotonic across the shard boundary.
 */
export async function fetchModelBytes(onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const urls = shardUrls();

  // First, learn each shard's size (Content-Length) so progress spans the whole
  // download, not per-shard 0→100 resets. A HEAD avoids buffering twice.
  const sizes = await Promise.all(
    urls.map(async (u) => {
      try {
        const head = await fetch(u, { method: "HEAD" });
        const len = Number(head.headers.get("content-length") || "0");
        return Number.isFinite(len) ? len : 0;
      } catch {
        return 0;
      }
    }),
  );
  const knownTotal = sizes.reduce((a, b) => a + b, 0);

  const parts: Uint8Array[] = [];
  let downloaded = 0;

  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i]);
    if (!res.ok) throw new Error(`Model shard ${i} failed: HTTP ${res.status}`);

    // Stream so we can report progress; fall back to arrayBuffer() if no body.
    if (res.body && knownTotal > 0) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          parts.push(value);
          downloaded += value.length;
          onProgress?.(Math.min(0.999, downloaded / knownTotal));
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      parts.push(buf);
      downloaded += buf.length;
      if (knownTotal > 0) onProgress?.(Math.min(0.999, downloaded / knownTotal));
    }
  }

  // Concatenate all shards into one contiguous buffer.
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  onProgress?.(1);
  return out.buffer;
}
