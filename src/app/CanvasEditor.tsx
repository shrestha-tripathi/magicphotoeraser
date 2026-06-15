import { useCallback, useEffect, useRef, useState } from "react";
import type { BrushMaskApi } from "./useBrushMask";

/**
 * CanvasEditor — the paint surface. Two stacked canvases sharing identical
 * DPR-aware "contain" geometry:
 *   1. image canvas  — the decoded bitmap (same fit logic as the old ImageStage)
 *   2. mask canvas   — the user's selection, tinted accent + semi-transparent,
 *                      redrawn from the hook's source-res mask on every revision
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
}

interface Fit {
  displayWidth: number;
  displayHeight: number;
  scale: number; // source→display
  dpr: number;
}

const ACCENT = "124, 58, 237"; // var(--color-accent) violet-600, as RGB for rgba()

export default function CanvasEditor({ bitmap, mask }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const fitRef = useRef<Fit | null>(null);
  fitRef.current = fit;
  const paintingRef = useRef(false);

  const { maskCanvas, revision, brushSize, mode, beginStroke, extendStroke, endStroke } = mask;

  // --- Fit + draw the image canvas (mirrors the old ImageStage logic) ---
  useEffect(() => {
    const container = containerRef.current;
    const imageCanvas = imageCanvasRef.current;
    const maskEl = maskCanvasRef.current;
    if (!container || !imageCanvas || !maskEl) return;

    const draw = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(cw / bitmap.width, ch / bitmap.height, 1);
      const displayWidth = Math.max(1, Math.round(bitmap.width * scale));
      const displayHeight = Math.max(1, Math.round(bitmap.height * scale));
      const backingW = Math.round(displayWidth * dpr);
      const backingH = Math.round(displayHeight * dpr);

      for (const c of [imageCanvas, maskEl]) {
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
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const p = toSource(e.clientX, e.clientY);
      if (!p) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
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
      if (!paintingRef.current) return;
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
          className="mpe-checkerboard block max-h-full max-w-full rounded-lg shadow-lg ring-1 ring-black/10"
          aria-label="Your photo"
        />
        <canvas
          ref={maskCanvasRef}
          className="absolute left-0 top-0 block max-h-full max-w-full rounded-lg"
          style={{ touchAction: "none", cursor: "none" }}
          aria-label="Selection mask — brush over what you want to erase"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onPointerEnter={() => setHoverInside(true)}
          onPointerLeave={() => {
            setHoverInside(false);
            finishStroke();
          }}
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
            opacity: hoverInside ? 1 : 0,
            transition: "opacity 120ms ease",
          }}
        />
      </div>
    </div>
  );
}
