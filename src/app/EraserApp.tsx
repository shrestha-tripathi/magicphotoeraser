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
// First-run onboarding tour (~6 KB vanilla DOM, no runtime dep — safe to import
// statically; it lazily injects its overlay only when started).
import { startTour, hasSeenTour } from "./onboardingTour";
// PWA install prompt (vanilla DOM, ~zero dep). Lives in the editor only — keeps
// marketing pages 0-JS, and install intent peaks after a successful erase.
import { initPwaInstall } from "./pwaInstall";
// Keyboard-shortcuts cheat-sheet overlay (vanilla DOM, same pattern as the tour).
// Opened with `?` or the toolbar keyboard button; makes power-user shortcuts discoverable.
import { toggleShortcuts, openShortcuts } from "./shortcutsHelp";
// Type-only import: erased at build time, so the heavy onnxruntime chunk it lives
// next to is NOT pulled into the initial /app bundle. The runtime is loaded lazily
// via dynamic import() inside onErase, on the user's first erase.
import type { InpaintStatus } from "./inpaint/runInpaint";
// Type-only imports for the SAM (click-to-select) runtime — same lazy-load story:
// the onnxruntime + SlimSAM chunk is pulled in only on the first object click.
import type { SamContext, SamPoint, SegmentStatus } from "./segment/runSegment";
// On-page debug mode (?debug=1) — prints real device runtime state + a live event
// log so a user on a phone we can't attach devtools to can screenshot ground-truth
// diagnostics for a crash we can't reproduce. No-op (and ~0 bytes) without the flag.
import { mountDebugPanel, debugLog, debugFact } from "./debug";

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

/**
 * Initial selection mode. On touch-primary (mobile) devices default to BRUSH
 * (selectMode=false) so the FIRST interaction is INSTANT — painting needs no
 * model at all, whereas click-to-select must download + encode the 38 MB SAM
 * model (slow on mobile; on iOS it's forced onto the slower WASM EP — see
 * capabilities.isIOS — and used to crash the tab). The heavy model then loads
 * only when the user explicitly taps "Click to select." Desktop keeps
 * click-to-select as the default: it's the headline feature and runs fast on WebGPU.
 *
 * `(pointer: coarse)` matches when the PRIMARY input is touch (phones/tablets);
 * a desktop with a touchscreen still reports a fine primary pointer, so it stays
 * on select. The /app island is client:only, so this only ever runs in-browser.
 */
function defaultSelectMode(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return !window.matchMedia("(pointer: coarse)").matches;
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
  // `selectMode` true = click an object to auto-select it (the headline feature,
  // default on DESKTOP per D3); false = manual brush (default on MOBILE so the
  // first interaction is instant — no 38 MB model load until the user opts in via
  // the "Click to select" toggle). See defaultSelectMode(). Lazy init so the
  // matchMedia read happens once on mount, in-browser only.
  const [selectMode, setSelectMode] = useState<boolean>(defaultSelectMode);
  const [segmenting, setSegmenting] = useState(false);
  const [segStatus, setSegStatus] = useState<SegmentStatus | null>(null);
  const samContextRef = useRef<SamContext | null>(null);
  // Indicates which image the current SAM context was built for, so we know to
  // rebuild it after an erase swaps the bitmap (same dims, new pixels).
  const samBitmapRef = useRef<ImageBitmap | null>(null);

  // --- Pending selection (commit 11: multi-point refine) ---
  // The accumulated +/- points and the LIVE preview mask they produce. This is
  // SEPARATE from the committed brush-mask buffer: every +/- click re-runs the
  // decoder with ALL points and replaces the preview, so negative points can
  // subtract. The preview only merges into the real mask on Erase or when the
  // user leaves select mode (see commitSelection). `pointPositive` is the active
  // toolbar polarity. `selReqRef` is a monotonic id so a slow decoder result from
  // an earlier click can't overwrite a newer one (latest-click-wins race guard).
  const [selPoints, setSelPoints] = useState<SamPoint[]>([]);
  const [previewMask, setPreviewMask] = useState<Uint8Array | null>(null);
  const [previewRev, setPreviewRev] = useState(0);
  const [pointPositive, setPointPositive] = useState(true);
  const selPointsRef = useRef<SamPoint[]>([]);
  selPointsRef.current = selPoints;
  const previewMaskRef = useRef<Uint8Array | null>(null);
  previewMaskRef.current = previewMask;
  const selReqRef = useRef(0);

  // --- 3-mask cycling (commit 12) ---
  // A single click yields 1–3 viable candidate masks at different granularities
  // (e.g. a jacket → the person → the whole group). We hold them all and let the
  // user cycle with the "Try another shape" chip or [ / ] keys; the active index
  // drives which one is shown as the preview. Cycling is a pure index swap — NO
  // extra model run. Only offered at EXACTLY ONE point: once the user starts +/-
  // refining (>1 point) the refined mask is authoritative, so we collapse to a
  // single candidate and hide the chip (empirically the multi-point candidates are
  // muddy — see the c12 probe). Any NEW point re-decodes and resets the index to 0.
  const [candidateMasks, setCandidateMasks] = useState<Uint8Array[]>([]);
  const [cycleIndex, setCycleIndex] = useState(0);
  const candidateMasksRef = useRef<Uint8Array[]>([]);
  candidateMasksRef.current = candidateMasks;
  const cycleIndexRef = useRef(0);
  cycleIndexRef.current = cycleIndex;

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
    // Drop any pending SAM selection (points + preview) and invalidate in-flight
    // decodes so a late result can't land on the next image.
    selReqRef.current++;
    setSelPoints([]);
    setPreviewMask(null);
    setPreviewRev((r) => r + 1);
    setCandidateMasks([]);
    setCycleIndex(0);
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
      debugLog(`ingest start: ${name} ${(blob.size / 1e6).toFixed(2)}MB type=${blob.type}`);
      try {
        const decoded = await decodeImage(blob, name);
        bitmapRef.current = decoded.bitmap;
        // Retain the pristine original for Compare / Revert (whole session).
        originalBitmapRef.current = decoded.bitmap;
        setImage(decoded);
        setPhase("ready");
        debugLog(
          `ingest ok: ${decoded.width}x${decoded.height}` +
            (decoded.downscaled
              ? ` (downscaled from ${decoded.sourceWidth}x${decoded.sourceHeight})`
              : ""),
        );
        debugFact("image", `${decoded.width}x${decoded.height} (${name})`);
      } catch (e) {
        const err =
          e instanceof ImageDecodeError
            ? { code: e.code, message: e.message }
            : { code: "decode-failed", message: "Something went wrong reading that image." };
        debugLog(`ingest FAILED: ${err.code} — ${err.message}`);
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

  // --- Commit the pending SAM preview into the real (undoable) mask buffer, then
  // clear the pending state. Called before Erase and when leaving select mode so
  // the refined selection is never lost. No-op if there's nothing pending. ---
  const commitSelection = useCallback(() => {
    selReqRef.current++; // invalidate any in-flight decode
    const pending = previewMaskRef.current;
    if (pending && image) {
      mask.stampMask(pending, image.width, image.height, "add");
    }
    setSelPoints([]);
    setPreviewMask(null);
    setPreviewRev((r) => r + 1);
    setCandidateMasks([]);
    setCycleIndex(0);
  }, [image, mask]);

  // --- Discard the pending selection without committing (the "Clear selection"
  // button, and on image change / mode toggles). ---
  const clearSelection = useCallback(() => {
    selReqRef.current++; // invalidate any in-flight decode
    setSelPoints([]);
    setPreviewMask(null);
    setPreviewRev((r) => r + 1);
    setCandidateMasks([]);
    setCycleIndex(0);
    setSegmenting(false);
    setSegStatus(null);
  }, []);

  // --- Switch between Click-to-select and Brush. Leaving select mode COMMITS the
  // pending preview (so the user doesn't lose a refined selection by toggling);
  // entering select mode starts from a clean slate. ---
  const switchMode = useCallback(
    (toSelect: boolean) => {
      if (toSelect === selectMode) return;
      if (toSelect) clearSelection();
      else commitSelection();
      setSelectMode(toSelect);
    },
    [selectMode, commitSelection, clearSelection],
  );

  // --- Erase: run the on-device inpainter on the painted mask (Decision 2A:
  // result replaces the canvas in place so the user can keep erasing more) ---
  const onErase = useCallback(async () => {
    if (!image || !mask.maskCanvas || erasing) return;
    // There's something to erase if the mask buffer is already non-empty OR a
    // pending SAM selection is showing. Read both from sources that are correct
    // synchronously (the preview ref + the committed-stroke state).
    const hasPending = previewMaskRef.current != null;
    if (!mask.hasMask && !hasPending) return;
    // Commit any pending SAM preview into the mask buffer first. stampMask draws
    // to maskCanvas synchronously, so the canvas pixels are ready for inpaint even
    // though the hook's hasMask COUNT only updates on the next render.
    commitSelection();
    setEraseError(null);
    setErasing(true);
    setEraseStatus({ phase: "download", progress: 0 });
    debugLog(`erase START (${image.width}x${image.height})`);
    try {
      // Lazy-load the runtime (+ onnxruntime-web chunk) only now, on first erase.
      const { inpaint } = await import("./inpaint/runInpaint");
      const { bitmap: result } = await inpaint(image.bitmap, mask.maskCanvas, (s) => {
        debugLog(`inpaint ${s.phase}${s.progress != null ? ` ${Math.round(s.progress * 100)}%` : ""}`);
        setEraseStatus(s);
      });
      debugLog("erase DONE");
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
  }, [image, mask, erasing, commitSelection]);

  // --- Click-to-select: encode the image once (lazily, on first click), then
  // run SAM's decoder for the ACCUMULATED +/- points and show the result as a
  // PENDING preview (commit 11). The preview is NOT baked into the mask buffer
  // yet — that happens on Erase or when leaving select mode (commitSelection) —
  // so a negative click can subtract from an over-greedy selection. ---
  const onSelectClick = useCallback(
    async (sx: number, sy: number, positive: boolean) => {
      if (!image || erasing) return;
      setEraseError(null);
      debugLog(`select click @(${Math.round(sx)},${Math.round(sy)}) ${positive ? "+" : "-"}`);

      // Append the new point and snapshot the full set for this request.
      const points = [...selPointsRef.current, { sx, sy, positive }];
      setSelPoints(points);
      const reqId = ++selReqRef.current;

      setSegmenting(true);
      setSegStatus(null);
      try {
        debugLog("import runSegment chunk…");
        const { createSamContext } = await import("./segment/runSegment");
        // (Re)build the per-image context if missing or stale (bitmap swapped).
        if (!samContextRef.current || samBitmapRef.current !== image.bitmap) {
          debugLog("createSamContext START (download+compile+encode SAM)");
          samContextRef.current?.dispose();
          samContextRef.current = await createSamContext(
            image.bitmap,
            image.width,
            image.height,
            (s) => {
              debugLog(`SAM ${s.phase}${s.progress != null ? ` ${Math.round(s.progress * 100)}%` : ""}`);
              setSegStatus(s);
            },
          );
          samBitmapRef.current = image.bitmap;
          debugLog(`createSamContext DONE (backend=${samContextRef.current.backend})`);
        }
        debugLog(`decoder.segment(${points.length}pt) START`);
        const { masks: candidates } = await samContextRef.current.segment(points);
        debugLog(`decoder.segment DONE → ${candidates.length} candidate(s)`);
        // Latest-click-wins: if a newer click already superseded this request (or
        // the selection was cleared / image changed), drop this stale result.
        if (reqId !== selReqRef.current) return;
        // Store all candidates and show the default (index 0). A NEW point always
        // resets the cycle to 0; the "Try another shape" chip lets the user cycle
        // the rest (only meaningful at a single point — candidates.length is 1 when
        // refining, so the chip auto-hides).
        setCandidateMasks(candidates);
        setCycleIndex(0);
        setPreviewMask(candidates[0]);
        setPreviewRev((r) => r + 1);
      } catch (e) {
        debugLog(`select FAILED: ${String(e)}`);
        console.error("[segment] failed", e);
        if (reqId === selReqRef.current) {
          // Roll the failed point back out of the set so a retry is clean.
          setSelPoints((prev) => prev.slice(0, -1));
          setEraseError(
            "Couldn’t select that — your device may not support on-device AI, or the model failed to load. You can still brush manually.",
          );
        }
      } finally {
        if (reqId === selReqRef.current) {
          setSegmenting(false);
          setSegStatus(null);
        }
      }
    },
    [image, erasing],
  );

  // --- Cycle to another candidate mask (commit 12). Pure index swap into the
  // already-decoded candidates — no model run. `dir` is +1 (next) or -1 (prev),
  // wrapping around. No-op unless there are ≥2 candidates (i.e. a single click
  // that produced multiple distinct granularities). ---
  const cycleMask = useCallback(
    (dir: number) => {
      const cands = candidateMasksRef.current;
      if (cands.length < 2) return;
      const next = (cycleIndexRef.current + dir + cands.length) % cands.length;
      setCycleIndex(next);
      setPreviewMask(cands[next]);
      setPreviewRev((r) => r + 1);
    },
    [],
  );

  // [ / ] cycle the candidate masks while a multi-candidate selection is showing.
  useEffect(() => {
    if (candidateMasks.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in a field (none today, but future-proof) or modified.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "]") {
        e.preventDefault();
        cycleMask(1);
      } else if (e.key === "[") {
        e.preventDefault();
        cycleMask(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [candidateMasks.length, cycleMask]);

  // `?` opens the keyboard-shortcuts cheat sheet (and toggles it closed). Guarded
  // against typing in fields and against modifier combos so it never fights a real
  // shortcut. The overlay itself owns Esc/Tab/close once open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      toggleShortcuts();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    clearSelection();
    setHasEdited(false);
    setCompareMode(false);
  }, [image, mask, clearSelection]);

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

  // --- PWA install prompt (commit 14) ---
  // Wire up install handling once on mount. initPwaInstall() is a no-op if the
  // app is already installed or the user recently dismissed the pill, and only
  // attaches listeners (the pill itself appears later, on beforeinstallprompt or
  // the iOS hint timer). Editor-only by design — marketing pages stay 0-JS.
  useEffect(() => {
    initPwaInstall();
  }, []);

  // --- On-page debug panel (?debug=1) — mount once on island mount. No-op
  // unless the flag is present. Mounted early so it captures the whole session.
  useEffect(() => {
    mountDebugPanel();
    debugFact(
      "default mode",
      defaultSelectMode() ? "select (desktop)" : "brush (mobile — instant, no model)",
    );
  }, []);

  // --- First-run onboarding tour (commit 13) ---
  // Fire ONCE, the first time a photo successfully decodes (phase → "ready"),
  // ~900 ms after the editor toolbar paints so it doesn't crowd the transition.
  // `tourFiredRef` guards against re-firing on later image swaps within a session;
  // the localStorage seen-bit (inside startTour) guards across sessions. Skipped
  // entirely for returning users — hasSeenTour() short-circuits before the timer.
  const tourFiredRef = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || tourFiredRef.current || hasSeenTour()) return;
    tourFiredRef.current = true;
    const t = window.setTimeout(() => {
      // Only if still on the editor and a tour isn't already open.
      if (document.querySelector('[data-tour-anchor="select"]')) startTour();
    }, 900);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Replay handler for the "?" button — always forces the tour regardless of the
  // seen-bit. Defined here so the toolbar button can call it.
  const replayTour = useCallback(() => {
    startTour({ force: true });
  }, []);

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
                data-tour-anchor="select"
              >
                <button
                  type="button"
                  onClick={() => switchMode(true)}
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
                  onClick={() => switchMode(false)}
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
                <div className="flex flex-wrap items-center gap-3">
                  {/* +/- point polarity toggle (mirrors the brush Add/Remove pill) */}
                  <div
                    className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5"
                    role="group"
                    aria-label="Point type"
                    data-tour-anchor="refine"
                  >
                    <button
                      type="button"
                      onClick={() => setPointPositive(true)}
                      aria-pressed={pointPositive}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                        pointPositive
                          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                      }`}
                      title="Click to ADD a region to the selection"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => setPointPositive(false)}
                      aria-pressed={!pointPositive}
                      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                        !pointPositive
                          ? "bg-red-600 text-white"
                          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                      }`}
                      title="Click to REMOVE a region from the selection (or alt/right-click)"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                        <path d="M5 12h14" />
                      </svg>
                      Remove
                    </button>
                  </div>
                  {selPoints.length > 0 ? (
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-sm font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                      title="Discard the current selection and start over"
                    >
                      Clear selection
                    </button>
                  ) : null}
                  {/* 3-mask cycling (c12): only when a single click yielded ≥2
                      distinct granularities. Cycling is a pure preview swap. */}
                  {candidateMasks.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => cycleMask(1)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-2.5 py-1 text-sm font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20"
                      title="Show a different shape for this object — or press ] / ["
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 2v6h6M21 12a9 9 0 0 0-15-6.7L3 8M21 22v-6h-6M3 12a9 9 0 0 0 15 6.7l3-2.7" />
                      </svg>
                      Try another shape
                      <span className="tabular-nums opacity-70">
                        {cycleIndex + 1}/{candidateMasks.length}
                      </span>
                    </button>
                  ) : null}
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    {selPoints.length === 0
                      ? "Click an object to select it — add or remove points to refine."
                      : candidateMasks.length > 1
                        ? `${selPoints.length} point · refine, then Erase — or try another shape (] / [).`
                        : `${selPoints.length} point${selPoints.length === 1 ? "" : "s"} · refine, then Erase. Brush still works too.`}
                  </p>
                </div>
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
                  disabled={(!mask.hasMask && selPoints.length === 0) || erasing}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-1.5 font-semibold text-[var(--color-accent-fg)] shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  data-tour-anchor="erase"
                  title={
                    mask.hasMask || selPoints.length > 0
                      ? "Erase the selected area"
                      : "Select or brush over something first"
                  }
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
              {/* Replay the onboarding tour (commit 13). Icon-only, unobtrusive. */}
              <button
                type="button"
                onClick={replayTour}
                aria-label="Show the quick tour"
                title="Show the quick tour"
                className="inline-flex items-center justify-center rounded-md border border-[var(--color-border)] p-1.5 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              </button>
              {/* Keyboard-shortcuts cheat sheet (commit 15). Also opens with `?`. */}
              <button
                type="button"
                onClick={openShortcuts}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                className="inline-flex items-center justify-center rounded-md border border-[var(--color-border)] p-1.5 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect width="20" height="16" x="2" y="4" rx="2" />
                  <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M7 16h10" />
                </svg>
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
              previewMask={previewMask}
              previewWidth={image.width}
              previewHeight={image.height}
              previewPoints={selPoints}
              previewRevision={previewRev}
              pointPositive={pointPositive}
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
            role="status"
            aria-live="polite"
            aria-busy="true"
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
                  <div
                    className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-muted)]"
                    role="progressbar"
                    aria-label="Model download progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((eraseStatus.progress ?? 0) * 100)}
                  >
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
            role="status"
            aria-live="polite"
            aria-busy="true"
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
                  <div
                    className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-muted)]"
                    role="progressbar"
                    aria-label="Model download progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((segStatus.progress ?? 0) * 100)}
                  >
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
          <div className="absolute inset-x-0 bottom-4 z-20 flex justify-center px-4" role="alert" aria-live="assertive">
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
