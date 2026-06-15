import { useCallback, useEffect, useRef, useState } from "react";

/**
 * BeforeAfterSlider — read-only comparison of the original photo (before) against
 * the current erased result (after), with a draggable wipe divider.
 *
 * Geometry mirrors CanvasEditor exactly (DPR-aware "contain" fit, capped at 100%
 * so we never upscale) so the two images register pixel-for-pixel. Two stacked
 * canvases share that geometry:
 *   - bottom = AFTER (the result), always fully painted
 *   - top    = BEFORE (the original), revealed from the LEFT up to the divider via
 *              an inset clip — so dragging the handle left→right wipes from the
 *              original to the result.
 * The divider position is a 0..1 fraction of display width; pointer + keyboard
 * (←/→, Home/End) both drive it, and it's announced as a slider for a11y.
 */

interface Props {
  before: ImageBitmap;
  after: ImageBitmap;
}

interface Fit {
  displayWidth: number;
  displayHeight: number;
  dpr: number;
}

export default function BeforeAfterSlider({ before, after }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const [pos, setPos] = useState(0.5); // divider fraction 0..1
  const draggingRef = useRef(false);

  // --- Fit + paint both canvases (same contain math as CanvasEditor) ---
  useEffect(() => {
    const container = containerRef.current;
    const bc = beforeCanvasRef.current;
    const ac = afterCanvasRef.current;
    if (!container || !bc || !ac) return;

    const draw = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      // Both bitmaps are the same dimensions (result is produced at source res).
      const scale = Math.min(cw / after.width, ch / after.height, 1);
      const displayWidth = Math.max(1, Math.round(after.width * scale));
      const displayHeight = Math.max(1, Math.round(after.height * scale));
      const backingW = Math.round(displayWidth * dpr);
      const backingH = Math.round(displayHeight * dpr);

      for (const [canvas, bmp] of [
        [bc, before],
        [ac, after],
      ] as const) {
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;
        if (canvas.width !== backingW || canvas.height !== backingH) {
          canvas.width = backingW;
          canvas.height = backingH;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        }
      }
      setFit({ displayWidth, displayHeight, dpr });
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [before, after]);

  // --- Pointer drag on the frame sets the divider position ---
  const setFromClientX = useCallback((clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const f = (clientX - rect.left) / rect.width;
    setPos(Math.min(1, Math.max(0, f)));
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      draggingRef.current = true;
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );
  const stop = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPos((p) => Math.max(0, p - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPos((p) => Math.min(1, p + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      setPos(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPos(1);
    }
  }, []);

  const pct = Math.round(pos * 100);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden p-3 sm:p-6"
    >
      <div
        ref={frameRef}
        className="relative touch-none select-none"
        style={{
          width: fit ? `${fit.displayWidth}px` : undefined,
          height: fit ? `${fit.displayHeight}px` : undefined,
          lineHeight: 0,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
      >
        {/* AFTER (result) — bottom layer, fully visible */}
        <canvas
          ref={afterCanvasRef}
          className="mpe-checkerboard block max-h-full max-w-full rounded-lg shadow-lg ring-1 ring-black/10"
          aria-label="After erasing"
        />
        {/* BEFORE (original) — top layer, clipped to the left of the divider */}
        <canvas
          ref={beforeCanvasRef}
          className="mpe-checkerboard absolute left-0 top-0 block max-h-full max-w-full rounded-lg"
          style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
          aria-label="Before erasing"
        />

        {/* Corner pills */}
        <span
          className="pointer-events-none absolute left-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold text-white"
          style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
        >
          Before
        </span>
        <span
          className="pointer-events-none absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold text-white"
          style={{ backgroundColor: "rgba(124,58,237,0.85)" }}
        >
          After
        </span>

        {/* Divider line + handle */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
          style={{ left: `${pct}%`, transform: "translateX(-50%)" }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Reveal before / after"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          onKeyDown={onKeyDown}
          className="absolute top-1/2 z-20 flex size-9 cursor-ew-resize items-center justify-center rounded-full border-2 border-white bg-[var(--color-accent)] text-white shadow-lg outline-none ring-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 7-5 5 5 5" />
            <path d="m15 7 5 5-5 5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
