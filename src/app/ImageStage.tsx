import { useEffect, useRef } from "react";

/**
 * ImageStage — renders the decoded source bitmap onto a crisp, DPR-aware
 * canvas that "contains" within its parent (never upscales past 100%, so a
 * small screenshot shows at native size rather than a blurry blow-up; zoom/pan
 * arrives in a later commit).
 *
 * Deliberately separated from EraserApp because the brush-mask layer (next
 * commit) will be a second <canvas> stacked on this exact same geometry. The
 * displayed canvas is a DOWNSCALED view; the full-resolution `bitmap` stays
 * owned by EraserApp for the crop-bbox inpaint pipeline. Keeping display res
 * and source res separate from day one is what lets us paint a lightweight mask
 * while still compositing the erase back into the pixel-perfect original.
 */

export interface StageGeometry {
  /** CSS pixels of the displayed canvas (pre-DPR). */
  displayWidth: number;
  displayHeight: number;
  /** source→display scale factor (displayWidth / bitmap.width). */
  scale: number;
  /** device pixel ratio used for the backing store. */
  dpr: number;
}

interface Props {
  bitmap: ImageBitmap;
  /** Notifies the parent of the current fit geometry (for the future mask
   *  layer + a "shown at N%" readout). Called on mount and every resize. */
  onGeometry?: (g: StageGeometry) => void;
}

export default function ImageStage({ bitmap, onGeometry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Keep the latest callback without re-subscribing the ResizeObserver.
  const onGeometryRef = useRef(onGeometry);
  onGeometryRef.current = onGeometry;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const draw = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      // "contain" fit, capped at 100% (no upscaling past native).
      const scale = Math.min(cw / bitmap.width, ch / bitmap.height, 1);
      const displayWidth = Math.max(1, Math.round(bitmap.width * scale));
      const displayHeight = Math.max(1, Math.round(bitmap.height * scale));

      // CSS size = layout box; backing store = CSS size * DPR for crispness.
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      const backingW = Math.round(displayWidth * dpr);
      const backingH = Math.round(displayHeight * dpr);
      // Only resize the backing store when it actually changes (resizing a
      // canvas clears it and is costly).
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      onGeometryRef.current?.({ displayWidth, displayHeight, scale, dpr });
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    // devicePixelRatio can change when a window moves between monitors.
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener?.("change", draw);
    return () => {
      ro.disconnect();
      mq.removeEventListener?.("change", draw);
    };
  }, [bitmap]);

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center overflow-hidden p-3 sm:p-6"
    >
      <canvas
        ref={canvasRef}
        className="mpe-checkerboard max-h-full max-w-full rounded-lg shadow-lg ring-1 ring-black/10"
        aria-label="Your photo"
      />
    </div>
  );
}
