import { useCallback, useEffect, useRef, useState } from "react";
import type { BrushMaskApi } from "./useBrushMask";
import type { SamPoint } from "./segment/runSegment";

/**
 * CanvasEditor — the paint surface. Three stacked canvases sharing identical
 * DPR-aware "contain" geometry:
 *   1. image canvas   — the decoded bitmap (same fit logic as the old ImageStage)
 *   2. mask canvas    — the user's COMMITTED selection (brush strokes + stamped
 *                       SAM masks), tinted accent + semi-transparent
 *   3. preview canvas — the PENDING SAM selection (not yet committed): a distinct
 *                       cyan tint + outline + the +/- point dots, so it reads as
 *                       "proposed, refine me" vs the violet committed mask
 * A lightweight DOM brush-cursor ring tracks the pointer (no canvas redraw).
 *
 * Coordinate spaces:
 *   - Pointer events arrive in CSS px relative to the canvas box.
 *   - We divide by the display `scale` to get SOURCE px, which is what the mask
 *     hook stores — so the mask is resolution-independent and already model-ready.
 *
 * Painting uses Pointer Events (mouse + touch + stylus in one path) and
 * getCoalescedEvents() so fast drags capture every intermediate sample instead
 * of gapping. Touch-action:none keeps a drag from scrolling the page.
 */

interface Props {
  bitmap: ImageBitmap;
  mask: BrushMaskApi;
  /** When true, a click selects an object (SAM) instead of painting a stroke. */
  selectMode?: boolean;
  /**
   * Fired with SOURCE-space coords + polarity when the user clicks in select
   * mode. `positive` is true for an "include" point, false for "exclude" — it's
   * derived from the toolbar +/- toggle, but an alt/right-click forces negative.
   */
  onSelectClick?: (sx: number, sy: number, positive: boolean) => void;
  /** The pending SAM selection mask (source-res, 1=selected) to preview, or null. */
  previewMask?: Uint8Array | null;
  /** Source dimensions of previewMask (== bitmap dims; passed for clarity/guards). */
  previewWidth?: number;
  previewHeight?: number;
  /** The accumulated +/- points, drawn as dots on the preview layer. */
  previewPoints?: SamPoint[];
  /** Bumps whenever the preview mask/points change, to trigger a repaint. */
  previewRevision?: number;
  /** The active point polarity from the toolbar (drives the cursor color). */
  pointPositive?: boolean;
}

interface Fit {
  displayWidth: number;
  displayHeight: number;
  scale: number; // source→display
  dpr: number;
}

const ACCENT = "124, 58, 237"; // var(--color-accent) violet-600, as RGB for rgba()
const PREVIEW = "6, 182, 212"; // cyan-500 — distinct from the violet committed mask

export default function CanvasEditor({
  bitmap,
  mask,
  selectMode = false,
  onSelectClick,
  previewMask = null,
  previewPoints = [],
  previewRevision = 0,
  pointPositive = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const fitRef = useRef<Fit | null>(null);
  fitRef.current = fit;
  const paintingRef = useRef(false);

  const { maskCanvas, revision, brushSize, mode, beginStroke, extendStroke, endStroke } = mask;

  // selectMode / onSelectClick read inside memoized pointer handlers via refs so
  // the handlers don't need to be re-created (and lose pointer capture) on toggle.
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  const onSelectClickRef = useRef(onSelectClick);
  onSelectClickRef.current = onSelectClick;
  const pointPositiveRef = useRef(pointPositive);
  pointPositiveRef.current = pointPositive;

  // --- Fit + draw the image canvas (mirrors the old ImageStage logic) ---
  useEffect(() => {
    const container = containerRef.current;
    const imageCanvas = imageCanvasRef.current;
    const maskEl = maskCanvasRef.current;
    const previewEl = previewCanvasRef.current;
    if (!container || !imageCanvas || !maskEl || !previewEl) return;

    const draw = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      // The canvas renders INSIDE the container's padding (p-3 / sm:p-6), and a
      // `max-w-full` cap would otherwise shrink it below the size this fit logic
      // assumes — making f.scale wrong and mismapping touch coords (the mobile
      // brush/select bug). Subtract the actual computed padding so displayWidth
      // equals what's truly rendered, and toSource() maps 1:1. Read padding from
      // computed style so it stays correct across the responsive p-3 → sm:p-6.
      const cs = window.getComputedStyle(container);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const availW = Math.max(1, cw - padX);
      const availH = Math.max(1, ch - padY);
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(availW / bitmap.width, availH / bitmap.height, 1);
      const displayWidth = Math.max(1, Math.round(bitmap.width * scale));
      const displayHeight = Math.max(1, Math.round(bitmap.height * scale));
      const backingW = Math.round(displayWidth * dpr);
      const backingH = Math.round(displayHeight * dpr);

      for (const c of [imageCanvas, maskEl, previewEl]) {
        c.style.width = `${displayWidth}px`;
        c.style.height = `${displayHeight}px`;
        if (c.width !== backingW || c.height !== backingH) {
          c.width = backingW;
          c.height = backingH;
        }
      }

      const ictx = imageCanvas.getContext("2d");
      if (ictx) {
        ictx.imageSmoothingEnabled = true;
        ictx.imageSmoothingQuality = "high";
        ictx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
        ictx.drawImage(bitmap, 0, 0, imageCanvas.width, imageCanvas.height);
      }

      const next = { displayWidth, displayHeight, scale, dpr };
      const prev = fitRef.current;
      if (
        !prev ||
        prev.displayWidth !== displayWidth ||
        prev.displayHeight !== displayHeight ||
        prev.dpr !== dpr
      ) {
        setFit(next);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener?.("change", draw);
    return () => {
      ro.disconnect();
      mq.removeEventListener?.("change", draw);
    };
  }, [bitmap]);

  // --- Repaint the mask overlay whenever the mask changes or the fit changes ---
  useEffect(() => {
    const maskEl = maskCanvasRef.current;
    if (!maskEl || !maskCanvas || !fit) return;
    const mctx = maskEl.getContext("2d");
    if (!mctx) return;
    mctx.clearRect(0, 0, maskEl.width, maskEl.height);
    // Scale the source-res mask down to the display backing store.
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    mctx.globalAlpha = 1;
    // The mask is white-on-transparent; tint it by drawing then re-coloring via
    // source-in so only the painted area takes the accent tint.
    mctx.drawImage(maskCanvas, 0, 0, maskEl.width, maskEl.height);
    mctx.globalCompositeOperation = "source-in";
    mctx.fillStyle = `rgba(${ACCENT}, 0.6)`;
    mctx.fillRect(0, 0, maskEl.width, maskEl.height);
    mctx.globalCompositeOperation = "source-over";
  }, [revision, fit, maskCanvas]);

  // --- Repaint the PENDING preview layer (cyan tint + outline + point dots) ---
  // Distinct from the committed violet mask so the user reads it as "proposed,
  // refine me". Built from the source-res preview mask via a tiny offscreen canvas
  // (no per-pixel loop on the display surface), then the +/- dots on top.
  const previewSrcRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const pv = previewCanvasRef.current;
    if (!pv || !fit) return;
    const pctx = pv.getContext("2d");
    if (!pctx) return;
    pctx.clearRect(0, 0, pv.width, pv.height);
    if (!previewMask || previewMask.length === 0) return;

    // Rasterize the source-res 0/1 mask into an offscreen RGBA canvas once, then
    // scale it up to the display backing store (browser handles the resampling).
    let off = previewSrcRef.current;
    if (!off || off.width !== bitmap.width || off.height !== bitmap.height) {
      off = document.createElement("canvas");
      off.width = bitmap.width;
      off.height = bitmap.height;
      previewSrcRef.current = off;
    }
    const octx = off.getContext("2d");
    if (!octx) return;
    const id = octx.createImageData(bitmap.width, bitmap.height);
    const [pr, pg, pb] = PREVIEW.split(",").map((s) => parseInt(s, 10));
    const data = id.data;
    for (let i = 0; i < previewMask.length; i++) {
      if (previewMask[i]) {
        const j = i * 4;
        data[j] = pr;
        data[j + 1] = pg;
        data[j + 2] = pb;
        data[j + 3] = 150; // ~0.59 alpha fill
      }
    }
    octx.putImageData(id, 0, 0);
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(off, 0, 0, pv.width, pv.height);

    // Draw the +/- point dots in DISPLAY space (scaled from source coords).
    const sx = pv.width / bitmap.width;
    const sy = pv.height / bitmap.height;
    const r = Math.max(5, Math.round(7 * (fit.dpr || 1)));
    for (const p of previewPoints) {
      const cx = p.sx * sx;
      const cy = p.sy * sy;
      pctx.beginPath();
      pctx.arc(cx, cy, r, 0, Math.PI * 2);
      pctx.fillStyle = p.positive ? "rgba(22, 163, 74, 0.95)" : "rgba(220, 38, 38, 0.95)";
      pctx.fill();
      pctx.lineWidth = Math.max(1.5, r * 0.28);
      pctx.strokeStyle = "rgba(255,255,255,0.95)";
      pctx.stroke();
      // a small +/- glyph
      pctx.strokeStyle = "rgba(255,255,255,0.98)";
      pctx.lineWidth = Math.max(1.5, r * 0.3);
      pctx.beginPath();
      pctx.moveTo(cx - r * 0.5, cy);
      pctx.lineTo(cx + r * 0.5, cy);
      if (p.positive) {
        pctx.moveTo(cx, cy - r * 0.5);
        pctx.lineTo(cx, cy + r * 0.5);
      }
      pctx.stroke();
    }
  }, [previewRevision, fit, previewMask, previewPoints, bitmap]);

  // --- Pointer painting ---
  const toSource = useCallback((clientX: number, clientY: number) => {
    const maskEl = maskCanvasRef.current;
    const f = fitRef.current;
    if (!maskEl || !f) return null;
    const rect = maskEl.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    // CSS px → source px (rect is the display size; divide by scale).
    const sx = cssX / f.scale;
    const sy = cssY / f.scale;
    return { sx, sy, cssX, cssY };
  }, []);

  const moveCursor = useCallback(
    (cssX: number, cssY: number) => {
      const cur = cursorRef.current;
      const f = fitRef.current;
      if (!cur || !f) return;
      const d = brushSize * f.scale; // display diameter
      cur.style.width = `${d}px`;
      cur.style.height = `${d}px`;
      cur.style.transform = `translate(${cssX - d / 2}px, ${cssY - d / 2}px)`;
    },
    [brushSize],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // In select mode we ALSO accept right-click (button 2) as a shortcut for a
      // negative point; in brush mode only the primary button paints.
      const isSelect = selectModeRef.current;
      if (e.pointerType === "mouse" && e.button !== 0 && !(isSelect && e.button === 2)) return;
      const p = toSource(e.clientX, e.clientY);
      if (!p) return;
      // Select mode: a click hands the source-space point + polarity to SAM; no
      // painting. Polarity = toolbar toggle, but alt-click OR right-click forces
      // negative (the desktop power-user shortcut; mobile uses the toggle).
      if (isSelect) {
        const forcedNegative = e.altKey || e.button === 2;
        const positive = forcedNegative ? false : pointPositiveRef.current;
        moveCursor(p.cssX, p.cssY);
        onSelectClickRef.current?.(p.sx, p.sy, positive);
        return;
      }
      // setPointerCapture keeps the stroke alive if the finger leaves the canvas
      // mid-drag. Guard it: on rare devices / edge timing it can throw
      // ("no active pointer with the given id"); a throw here must NOT abort the
      // stroke, so swallow it and paint regardless.
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is best-effort; painting continues without it */
      }
      paintingRef.current = true;
      beginStroke(p.sx, p.sy);
      moveCursor(p.cssX, p.cssY);
    },
    [toSource, beginStroke, moveCursor],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = toSource(e.clientX, e.clientY);
      if (p) moveCursor(p.cssX, p.cssY);
      if (selectModeRef.current || !paintingRef.current) return;
      // Capture every intermediate sample for smooth fast drags. Per spec
      // getCoalescedEvents() CAN return an empty list (some platforms / when
      // there are no buffered moves) — fall back to the event itself so a
      // sample is never dropped.
      const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
      const events = coalesced.length > 0 ? coalesced : [e.nativeEvent];
      for (const ev of events) {
        const sp = toSource(ev.clientX, ev.clientY);
        if (sp) extendStroke(sp.sx, sp.sy);
      }
    },
    [toSource, extendStroke, moveCursor],
  );

  const finishStroke = useCallback(() => {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    endStroke();
  }, [endStroke]);

  const [hoverInside, setHoverInside] = useState(false);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden p-3 sm:p-6"
    >
      <div className="relative" style={{ lineHeight: 0 }}>
        <canvas
          ref={imageCanvasRef}
          className="mpe-checkerboard block rounded-lg shadow-lg ring-1 ring-black/10"
          aria-label="Your photo"
        />
        <canvas
          ref={maskCanvasRef}
          className="absolute left-0 top-0 block rounded-lg"
          style={{ touchAction: "none", cursor: selectMode ? "crosshair" : "none" }}
          aria-label={
            selectMode
              ? "Click an object to select it for erasing"
              : "Selection mask — brush over what you want to erase"
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onContextMenu={(e) => {
            // In select mode a right-click is a negative point (handled in
            // pointerdown) — suppress the browser menu so it doesn't interrupt.
            if (selectMode) e.preventDefault();
          }}
          onPointerEnter={() => setHoverInside(true)}
          onPointerLeave={() => {
            setHoverInside(false);
            finishStroke();
          }}
        />
        {/* Pending SAM selection preview (cyan + point dots), above the mask but
            below the pointer surface so it never intercepts clicks. */}
        <canvas
          ref={previewCanvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 block rounded-lg"
        />
        {/* Brush-size cursor ring (DOM, not canvas) */}
        <div
          ref={cursorRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 rounded-full"
          style={{
            border: `1.5px solid ${mode === "add" ? `rgba(${ACCENT}, 0.95)` : "rgba(220, 38, 38, 0.95)"}`,
            boxShadow: "0 0 0 1.5px rgba(255,255,255,0.7)",
            backgroundColor:
              mode === "add"
                ? `rgba(${ACCENT}, 0.12)`
                : "rgba(220, 38, 38, 0.10)",
            opacity: hoverInside && !selectMode ? 1 : 0,
            transition: "opacity 120ms ease",
          }}
        />
      </div>
    </div>
  );
}
