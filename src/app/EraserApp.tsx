import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeImage,
  imageBlobFromDataTransfer,
  ImageDecodeError,
  type DecodedImage,
} from "./decodeImage";
import CanvasEditor from "./CanvasEditor";
import BrushToolbar from "./BrushToolbar";
import BeforeAfterSlider from "./BeforeAfterSlider";
import { useBrushMask } from "./useBrushMask";
import {
  defaultFormatFor,
  downloadBitmap,
  type DownloadFormat,
} from "./download";
// Type-only import: erased at build time, so the heavy onnxruntime chunk it lives
// next to is NOT pulled into the initial /app bundle. The runtime is loaded lazily
// via dynamic import() inside onErase, on the user's first erase.
import type { InpaintStatus } from "./inpaint/runInpaint";
// Type-only imports for the SAM (click-to-select) runtime — same lazy-load story:
// the onnxruntime + SlimSAM chunk is pulled in only on the first object click.
import type { SamContext, SegmentStatus } from "./segment/runSegment";

/**
 * EraserApp — the /app editor island (client:only="react").
 *
 * Commit 5 — FOUNDATION: get a photo in (picker / drag-drop / paste), decode it
 * EXIF-correctly + metadata-free, display it on a DPR-aware canvas.
 * Commit 6 — BRUSH: paint a source-resolution selection mask over the photo
 * (Add/Remove, size, undo/redo/clear). Still no model/erase — c6 only produces
 * the mask that c7/c8 will feed to the inpainter. The owned full-res ImageBitmap
 * + the source-res mask are the two buffers the crop-bbox pipeline consumes.
 */

type Phase = "empty" | "decoding" | "ready" | "error";

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function EraserApp() {
  const [phase, setPhase] = useState<Phase>("empty");
  const [image, setImage] = useState<DecodedImage | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Brush mask lives at SOURCE resolution; recreated when the image changes.
  const mask = useBrushMask(image?.width ?? 0, image?.height ?? 0);

  // --- Erase (on-device inpaint) state ---
  // `erasing` gates the UI while the model downloads + runs; `eraseStatus`
  // drives the progress overlay (download fraction → running). `eraseError`
  // surfaces a friendly message if the runtime/model fails.
  const [erasing, setErasing] = useState(false);
  const [eraseStatus, setEraseStatus] = useState<InpaintStatus | null>(null);
  const [eraseError, setEraseError] = useState<string | null>(null);

  // --- Click-to-select (SAM) state ---
  // `selectMode` true = click an object to auto-select it (the headline feature,
  // default per D3); false = manual brush. `segmenting` gates the UI while the
  // SAM models download / encode / decode. `segStatus` drives the progress
  // overlay. The per-image SAM context (encoder embeddings) lives in a ref and is
  // (re)built lazily on the first click of each image, then disposed on change.
  const [selectMode, setSelectMode] = useState(true);
  const [segmenting, setSegmenting] = useState(false);
  const [segStatus, setSegStatus] = useState<SegmentStatus | null>(null);
  const samContextRef = useRef<SamContext | null>(null);
  // Indicates which image the current SAM context was built for, so we know to
  // rebuild it after an erase swaps the bitmap (same dims, new pixels).
  const samBitmapRef = useRef<ImageBitmap | null>(null);

  // --- Compare / download state (commit 8) ---
  // `hasEdited` is true once at least one erase has happened, which unlocks the
  // Compare slider, Download, and Revert controls. `compareMode` swaps the brush
  // editor for the before/after slider. `downloading` debounces the export click.
  const [hasEdited, setHasEdited] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // The pristine uploaded bitmap, retained for the whole session so Compare can
  // show the original and Revert can restore it. NOT closed on erase-swap — only
  // on reset/replace. Kept SEPARATE from bitmapRef (which tracks the current result).
  const originalBitmapRef = useRef<ImageBitmap | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Hold the live bitmap in a ref too, so cleanup always frees the latest even
  // if state updates are batched/interrupted.
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const dragDepth = useRef(0);

  const releaseImage = useCallback(() => {
    // Dispose any SAM encoder context (frees the held embedding tensors).
    if (samContextRef.current) {
      samContextRef.current.dispose();
      samContextRef.current = null;
    }
    samBitmapRef.current = null;
    if (bitmapRef.current) {
      bitmapRef.current.close();
      bitmapRef.current = null;
    }
    if (originalBitmapRef.current) {
      // Only close the original if it's a DIFFERENT object than the current
      // bitmap (after a revert they can be the same reference).
      if (originalBitmapRef.current !== bitmapRef.current) {
        originalBitmapRef.current.close();
      }
      originalBitmapRef.current = null;
    }
  }, []);

  const ingest = useCallback(
    async (blob: Blob, name: string) => {
      // Free any previous image before decoding the next.
      releaseImage();
      setError(null);
      setEraseError(null);
      setHasEdited(false);
      setCompareMode(false);
      setPhase("decoding");
      try {
        const decoded = await decodeImage(blob, name);
        bitmapRef.current = decoded.bitmap;
        // Retain the pristine original for Compare / Revert (whole session).
        originalBitmapRef.current = decoded.bitmap;
        setImage(decoded);
        setPhase("ready");
      } catch (e) {
        const err =
          e instanceof ImageDecodeError
            ? { code: e.code, message: e.message }
            : { code: "decode-failed", message: "Something went wrong reading that image." };
        setError(err);
        setImage(null);
        setPhase("error");
      }
    },
    [releaseImage],
  );

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void ingest(f, f.name || "image");
      // Reset so picking the same file again re-fires change.
      e.target.value = "";
    },
    [ingest],
  );

  const reset = useCallback(() => {
    releaseImage();
    setImage(null);
    setError(null);
    setEraseError(null);
    setHasEdited(false);
    setCompareMode(false);
    setPhase("empty");
  }, [releaseImage]);

  // --- Erase: run the on-device inpainter on the painted mask (Decision 2A:
  // result replaces the canvas in place so the user can keep erasing more) ---
  const onErase = useCallback(async () => {
    if (!image || !mask.maskCanvas || !mask.hasMask || erasing) return;
    setEraseError(null);
    setErasing(true);
    setEraseStatus({ phase: "download", progress: 0 });
    try {
      // Lazy-load the runtime (+ onnxruntime-web chunk) only now, on first erase.
      const { inpaint } = await import("./inpaint/runInpaint");
      const { bitmap: result } = await inpaint(image.bitmap, mask.maskCanvas, (s) =>
        setEraseStatus(s),
      );
      // 2A — swap the source bitmap in place. Same W×H, so the mask hook is NOT
      // recreated; we just clear the strokes so the next erase starts clean.
      const prev = bitmapRef.current;
      bitmapRef.current = result;
      setImage((img) => (img ? { ...img, bitmap: result } : img));
      mask.clear();
      setHasEdited(true);
      // Free the bitmap we just replaced — UNLESS it's the pristine original
      // (which we retain for Compare / Revert), or the same object as the result.
      if (prev && prev !== result && prev !== originalBitmapRef.current) {
        prev.close();
      }
    } catch (e) {
      console.error("[erase] failed", e);
      setEraseError(
        "Couldn’t erase that — your device may not support on-device AI, or the model failed to load. Please try again.",
      );
    } finally {
      setErasing(false);
      setEraseStatus(null);
    }
  }, [image, mask, erasing]);

  // --- Click-to-select: encode the image once (lazily, on first click), then
  // run SAM's decoder for the clicked point and stamp the resulting object mask
  // into the shared mask buffer (the same buffer Erase consumes). The encoder
  // context is rebuilt whenever the live bitmap changed (e.g. after an erase). ---
  const onSelectClick = useCallback(
    async (sx: number, sy: number) => {
      if (!image || segmenting || erasing) return;
      setEraseError(null);
      setSegmenting(true);
      setSegStatus(null);
      try {
        const { createSamContext } = await import("./segment/runSegment");
        // (Re)build the per-image context if missing or stale (bitmap swapped).
        if (!samContextRef.current || samBitmapRef.current !== image.bitmap) {
          samContextRef.current?.dispose();
          samContextRef.current = await createSamContext(
            image.bitmap,
            image.width,
            image.height,
            (s) => setSegStatus(s),
          );
          samBitmapRef.current = image.bitmap;
        }
        const maskBits = await samContextRef.current.segment(sx, sy);
        // Stamp the selection into the shared mask (additive, undoable).
        mask.stampMask(maskBits, image.width, image.height, "add");
      } catch (e) {
        console.error("[segment] failed", e);
        setEraseError(
          "Couldn’t select that — your device may not support on-device AI, or the model failed to load. You can still brush manually.",
        );
      } finally {
        setSegmenting(false);
        setSegStatus(null);
      }
    },
    [image, mask, segmenting, erasing],
  );

  // --- Revert to the pristine original (3-include). Frees the current result
  // unless it IS the original, points the current bitmap back at the original. ---
  const revert = useCallback(() => {
    const orig = originalBitmapRef.current;
    if (!orig || !image) return;
    const cur = bitmapRef.current;
    if (cur && cur !== orig) cur.close();
    bitmapRef.current = orig;
    setImage((img) => (img ? { ...img, bitmap: orig } : img));
    mask.clear();
    setHasEdited(false);
    setCompareMode(false);
  }, [image, mask]);

  // --- Download the current result (2c: format defaults to the source type) ---
  const onDownload = useCallback(async () => {
    if (!image || downloading) return;
    setDownloading(true);
    try {
      const format: DownloadFormat = defaultFormatFor(image.type, image.name);
      await downloadBitmap(image.bitmap, image.name, format);
    } catch (e) {
      console.error("[download] failed", e);
      setEraseError("Couldn’t save the image. Please try again.");
    } finally {
      setDownloading(false);
    }
  }, [image, downloading]);

  // --- Global paste (Ctrl/Cmd+V a screenshot anywhere on the page) ---
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const found = imageBlobFromDataTransfer(e.clipboardData);
      if (found) {
        e.preventDefault();
        void ingest(found.blob, found.name);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [ingest]);

  // --- Free the bitmap if the island unmounts ---
  useEffect(() => releaseImage, [releaseImage]);

  // --- Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo ---
  const readyRef = useRef(false);
  readyRef.current = phase === "ready";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      const target = e.target as HTMLElement | null;
      // Don't hijack typing in inputs (e.g. the size slider has focus).
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) mask.redo();
        else mask.undo();
      } else if (k === "y") {
        e.preventDefault();
        mask.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mask]);

  // --- Drag-and-drop (whole editor surface is a drop target) ---
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    }
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const found = imageBlobFromDataTransfer(e.dataTransfer);
      if (found) void ingest(found.blob, found.name);
      else setError({ code: "unsupported-type", message: "That didn’t look like an image file." });
    },
    [ingest],
  );

  const openPicker = useCallback(() => fileInputRef.current?.click(), []);

  return (
    <div
      className="relative flex min-h-[78vh] w-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={onPickFile}
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Toolbars — only meaningful once an image is loaded. */}
      {image && phase === "ready" && (
        <>
          {/* Mode toggle (Select / Brush) + brush controls — hidden in Compare. */}
          {!compareMode && (
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
              <div
                className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5"
                role="group"
                aria-label="Selection mode"
              >
                <button
                  type="button"
                  onClick={() => setSelectMode(true)}
                  aria-pressed={selectMode}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    selectMode
                      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                  }`}
                  title="Click an object to select it automatically"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 11.2V6a2 2 0 0 1 4 0v4.5" />
                    <path d="M13 10.5V4a2 2 0 0 1 4 0v8" />
                    <path d="M17 10.5a2 2 0 0 1 4 0V16a6 6 0 0 1-6 6h-2a8 8 0 0 1-7-4l-2.5-4a2 2 0 0 1 3.5-2L9 13" />
                  </svg>
                  Click to select
                </button>
                <button
                  type="button"
                  onClick={() => setSelectMode(false)}
                  aria-pressed={!selectMode}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    !selectMode
                      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                  }`}
                  title="Manually brush over the area to erase"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
                    <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
                  </svg>
                  Brush
                </button>
              </div>
              {selectMode ? (
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  Click an object to select it — then refine with the brush if needed.
                </p>
              ) : (
                <BrushToolbar mask={mask} />
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] px-4 py-2 text-sm">
            <span className="font-medium text-[var(--color-fg)] truncate max-w-[14rem]" title={image.name}>
              {image.name}
            </span>
            <span className="text-[var(--color-fg-muted)]">
              {image.width.toLocaleString()} × {image.height.toLocaleString()} px
            </span>
            <span className="text-[var(--color-fg-subtle)]">{formatBytes(image.sizeBytes)}</span>
            {image.downscaled && (
              <span
                className="rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)]"
                title={`Reduced from ${image.sourceWidth.toLocaleString()} × ${image.sourceHeight.toLocaleString()} px to stay fast and within memory.`}
              >
                reduced for performance
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* Primary erase action — hidden in Compare mode. */}
              {!compareMode && (
                <button
                  type="button"
                  onClick={onErase}
                  disabled={!mask.hasMask || erasing}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-1.5 font-semibold text-[var(--color-accent-fg)] shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  title={mask.hasMask ? "Erase the selected area" : "Brush over something first"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                    <path d="M22 21H7" />
                    <path d="m5 11 9 9" />
                  </svg>
                  {erasing ? "Erasing…" : "Erase"}
                </button>
              )}

              {/* Compare toggle — appears once at least one erase has happened. */}
              {hasEdited && (
                <button
                  type="button"
                  onClick={() => setCompareMode((c) => !c)}
                  aria-pressed={compareMode}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-medium transition-colors ${
                    compareMode
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
                  }`}
                  title="Compare before and after"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v18" />
                    <path d="M3 7.5 7 3v18l-4-4.5" />
                    <path d="m21 7.5-4-4.5v18l4-4.5" />
                  </svg>
                  {compareMode ? "Editing" : "Compare"}
                </button>
              )}

              {/* Revert to original (3-include) — only after an edit. */}
              {hasEdited && (
                <button
                  type="button"
                  onClick={revert}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                  title="Restore the original photo"
                >
                  Revert
                </button>
              )}

              {/* Download — available once edited (the whole point of v0.1). */}
              {hasEdited && (
                <button
                  type="button"
                  onClick={onDownload}
                  disabled={downloading}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-fg)] px-4 py-1.5 font-semibold text-[var(--color-bg)] shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Download the result (full resolution, no watermark)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="M7 10l5 5 5-5" />
                    <path d="M12 15V3" />
                  </svg>
                  {downloading ? "Saving…" : "Download"}
                </button>
              )}

              <button
                type="button"
                onClick={openPicker}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-muted)]"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={reset}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
              >
                Start over
              </button>
            </div>
          </div>
        </>
      )}

      {/* Stage area */}
      <div className="relative flex flex-1 items-stretch justify-center">
        {phase === "ready" && image ? (
          compareMode && originalBitmapRef.current ? (
            <BeforeAfterSlider before={originalBitmapRef.current} after={image.bitmap} />
          ) : (
            <CanvasEditor
              bitmap={image.bitmap}
              mask={mask}
              selectMode={selectMode}
              onSelectClick={onSelectClick}
            />
          )
        ) : phase === "decoding" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
            <Spinner />
            <p className="text-[var(--color-fg-muted)]">Reading your photo…</p>
          </div>
        ) : (
          <Dropzone
            phase={phase}
            error={error}
            onBrowse={openPicker}
            onRetry={reset}
          />
        )}

        {/* Drag overlay (covers the whole surface while a file is hovering). */}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[1px]"
            style={{ backgroundColor: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}
          >
            <div className="rounded-2xl border-2 border-dashed border-[var(--color-accent)] px-8 py-6 text-center"
              style={{ backgroundColor: "color-mix(in srgb, var(--color-bg) 80%, transparent)" }}
            >
              <p className="text-lg font-semibold text-[var(--color-accent)]">Drop to open</p>
            </div>
          </div>
        )}

        {/* Erase progress overlay (covers the stage while model downloads/runs). */}
        {erasing && (
          <div className="absolute inset-0 z-20 flex items-center justify-center backdrop-blur-[2px]"
            style={{ backgroundColor: "color-mix(in srgb, var(--color-bg) 70%, transparent)" }}
          >
            <div className="w-full max-w-xs rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-5 text-center shadow-xl">
              <Spinner />
              <p className="mt-3 font-medium text-[var(--color-fg)]">
                {eraseStatus?.phase === "download"
                  ? "Downloading the AI model…"
                  : eraseStatus?.phase === "compile"
                    ? "Preparing the AI model…"
                    : "Erasing…"}
              </p>
              {eraseStatus?.phase === "download" && (
                <>
                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-150"
                      style={{ width: `${Math.round((eraseStatus.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                    One-time ~27&nbsp;MB download · cached for next time · stays on your device
                  </p>
                </>
              )}
              {eraseStatus?.phase !== "download" && (
                <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                  Running entirely on your device — your photo never leaves the browser.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Segment (click-to-select) progress overlay. Encode is the slow step
            the first time per image; decode is near-instant after. */}
        {segmenting && (
          <div className="absolute inset-0 z-20 flex items-center justify-center backdrop-blur-[2px]"
            style={{ backgroundColor: "color-mix(in srgb, var(--color-bg) 70%, transparent)" }}
          >
            <div className="w-full max-w-xs rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-5 text-center shadow-xl">
              <Spinner />
              <p className="mt-3 font-medium text-[var(--color-fg)]">
                {segStatus?.phase === "download"
                  ? "Downloading the AI model…"
                  : segStatus?.phase === "compile"
                    ? "Preparing the AI model…"
                    : "Analyzing your photo…"}
              </p>
              {segStatus?.phase === "download" && (
                <>
                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-150"
                      style={{ width: `${Math.round((segStatus.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                    One-time ~40&nbsp;MB download · cached for next time · stays on your device
                  </p>
                </>
              )}
              {segStatus?.phase !== "download" && (
                <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                  Running entirely on your device — your photo never leaves the browser.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Erase error toast (also used for segment failures). */}
        {eraseError && !erasing && !segmenting && (
          <div className="absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
            <div className="flex max-w-md items-start gap-3 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-bg)] px-4 py-3 text-sm shadow-lg">
              <span className="mt-0.5 text-[var(--color-danger)]" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
              </span>
              <p className="text-[var(--color-fg-muted)]">{eraseError}</p>
              <button
                type="button"
                onClick={() => setEraseError(null)}
                className="ml-auto text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                aria-label="Dismiss"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block size-8 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]"
      aria-hidden="true"
    />
  );
}

function Dropzone({
  phase,
  error,
  onBrowse,
  onRetry,
}: {
  phase: Phase;
  error: { code: string; message: string } | null;
  onBrowse: () => void;
  onRetry: () => void;
}) {
  const isError = phase === "error" && error;
  const isHeic = error?.code === "heic-unsupported";
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16 sm:py-24">
      <div
        className={`w-full max-w-xl rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
          isError ? "border-[var(--color-danger)]/40" : "border-[var(--color-border)]"
        }`}
      >
        <span
          className="mx-auto flex size-16 items-center justify-center rounded-2xl text-[var(--color-accent)]"
          style={{
            backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
          }}
          aria-hidden="true"
        >
          {/* upload-cloud glyph */}
          <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 13v8" />
            <path d="m8 17 4-4 4 4" />
            <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />
          </svg>
        </span>

        {isError ? (
          <>
            <h2 className="mt-5 text-xl font-semibold text-[var(--color-fg)]">
              {isHeic ? "That’s a HEIC photo" : "Couldn’t open that"}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[var(--color-fg-muted)]">{error!.message}</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg bg-[var(--color-accent)] px-6 py-3 font-semibold text-[var(--color-accent-fg)] transition-opacity hover:opacity-90"
              >
                Try another photo
              </button>
              {isHeic && (
                <a
                  href="https://heicpix.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-[var(--color-border)] px-6 py-3 font-semibold text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-muted)]"
                >
                  Convert HEIC → JPG
                </a>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-5 text-xl font-semibold text-[var(--color-fg)]">
              Drop a photo to start erasing
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[var(--color-fg-muted)]">
              Drag &amp; drop, paste a screenshot, or browse. Everything happens on
              your device — your photo never leaves your browser.
            </p>
            <div className="mt-6">
              <button
                type="button"
                onClick={onBrowse}
                className="rounded-lg bg-[var(--color-accent)] px-6 py-3 font-semibold text-[var(--color-accent-fg)] transition-opacity hover:opacity-90"
              >
                Browse photos
              </button>
            </div>
            <p className="mt-4 text-xs text-[var(--color-fg-subtle)]">
              JPG · PNG · WebP · AVIF — or press{" "}
              <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-1.5 py-0.5 font-sans">
                Ctrl/⌘ V
              </kbd>{" "}
              to paste
            </p>
          </>
        )}
      </div>
    </div>
  );
}
