import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeImage,
  imageBlobFromDataTransfer,
  ImageDecodeError,
  type DecodedImage,
} from "./decodeImage";
import ImageStage, { type StageGeometry } from "./ImageStage";

/**
 * EraserApp — the /app editor island (client:only="react").
 *
 * Commit 5 scope = the editor FOUNDATION only: get a photo in (file picker /
 * drag-drop / paste), decode it EXIF-correctly + metadata-free, and display it
 * on a DPR-aware canvas with a minimal toolbar + reset. No brush, no model,
 * no erase yet — those are the next commits, and this state shape (one owned
 * full-res ImageBitmap) is the foundation they build on.
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
  const [, setGeometry] = useState<StageGeometry | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Hold the live bitmap in a ref too, so cleanup always frees the latest even
  // if state updates are batched/interrupted.
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const dragDepth = useRef(0);

  const releaseImage = useCallback(() => {
    if (bitmapRef.current) {
      bitmapRef.current.close();
      bitmapRef.current = null;
    }
  }, []);

  const ingest = useCallback(
    async (blob: Blob, name: string) => {
      // Free any previous image before decoding the next.
      releaseImage();
      setError(null);
      setPhase("decoding");
      try {
        const decoded = await decodeImage(blob, name);
        bitmapRef.current = decoded.bitmap;
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
    setPhase("empty");
  }, [releaseImage]);

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

      {/* Toolbar — only meaningful once an image is loaded. */}
      {image && phase === "ready" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] px-4 py-2.5 text-sm">
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
          <div className="ml-auto flex items-center gap-2">
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
      )}

      {/* Stage area */}
      <div className="relative flex flex-1 items-stretch justify-center">
        {phase === "ready" && image ? (
          <ImageStage bitmap={image.bitmap} onGeometry={setGeometry} />
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
