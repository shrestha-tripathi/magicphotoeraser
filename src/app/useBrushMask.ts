import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * useBrushMask — owns the editable selection mask for the eraser.
 *
 * THE load-bearing design decision: undo/redo is VECTOR REPLAY, not ImageData
 * snapshots. A source-resolution mask at the 40-MP cap is ~160 MB of RGBA; a
 * 15-deep snapshot undo stack would be ~2.4 GB and OOM any phone. Instead we
 * keep each stroke as a tiny vector record {mode, size, points[]} (a few KB)
 * and, to undo, we clear the mask and replay every stroke except the popped
 * one. Memory stays flat regardless of undo depth, and replaying a few hundred
 * strokes onto a canvas is sub-frame fast.
 *
 * The mask lives at SOURCE resolution (== the decoded bitmap), so it is already
 * the exact buffer the crop-bbox inpaint pipeline (c7/c8) will read — no
 * rescaling between "what the user painted" and "what the model sees". The
 * CanvasEditor paints in source coordinates by dividing pointer positions by
 * the display scale before handing them here.
 *
 * Mask channel convention: we draw opaque white (#fff, alpha 255) where the
 * user wants to erase, fully transparent elsewhere. Downstream, "alpha > 0"
 * (or the red channel) is the binary erase region; the soft brush edge gives a
 * feathered boundary the compositor can use directly.
 */

export type BrushMode = "add" | "erase";

export interface Stroke {
  kind?: "stroke";
  mode: BrushMode;
  /** Brush diameter in SOURCE pixels. */
  size: number;
  /** Sampled points in SOURCE coordinates; >=1 (a tap is a single point). */
  points: { x: number; y: number }[];
}

/**
 * A raster region committed in one shot — produced by SAM click-to-select.
 * Stored as a 1-BIT-PACKED bitmap (width*height/8 bytes) so a single op costs
 * ~1.5 MB at 12 MP (vs ~48 MB for a full RGBA snapshot), keeping undo memory
 * bounded the same way vector strokes do. `mode:"add"` paints the region into
 * the mask; `"erase"` removes it (so a SAM selection can be subtracted later).
 */
export interface RasterStamp {
  kind: "stamp";
  mode: BrushMode;
  /** Packed 1-bit mask, row-major, MSB-first; length = ceil(w*h/8). */
  packed: Uint8Array;
  width: number;
  height: number;
}

export type MaskOp = Stroke | RasterStamp;

export interface BrushMaskApi {
  /** The live source-resolution mask canvas (white = erase). Stable ref. */
  maskCanvas: HTMLCanvasElement | null;
  brushSize: number;
  setBrushSize: (n: number) => void;
  mode: BrushMode;
  setMode: (m: BrushMode) => void;
  /** Begin a stroke at a source-space point. */
  beginStroke: (x: number, y: number) => void;
  /** Extend the in-progress stroke to a new source-space point. */
  extendStroke: (x: number, y: number) => void;
  /** Finalize the in-progress stroke (commits it to the undo history). */
  endStroke: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  /** Commit a SAM raster selection (source-res 0/255 mask) as one undoable op. */
  stampMask: (mask: Uint8Array, width: number, height: number, mode?: BrushMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** True when at least one committed stroke exists (mask is non-empty-ish). */
  hasMask: boolean;
  /** Monotonic counter that bumps on every visible mask change, so consumers
   *  can repaint their overlay without diffing canvas pixels. */
  revision: number;
}

/** Min/max brush diameter as a fraction-free source-pixel range. The slider in
 *  the toolbar maps to this; defaults sit comfortably for typical phone photos. */
export const BRUSH_MIN = 6;
export const BRUSH_MAX = 320;
const BRUSH_DEFAULT = 64;

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const { mode, size, points } = stroke;
  if (points.length === 0) return;
  // "add" paints white into the mask; "erase" removes mask via destination-out.
  ctx.save();
  ctx.globalCompositeOperation = mode === "add" ? "source-over" : "destination-out";
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (points.length === 1) {
    // A tap → a filled dot of the brush radius.
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Unpack a 1-bit-packed stamp into white-on-transparent RGBA ImageData. */
function stampToImageData(stamp: RasterStamp): ImageData {
  const { packed, width, height } = stamp;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const bit = (packed[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit) {
      const p = i * 4;
      rgba[p] = 255;
      rgba[p + 1] = 255;
      rgba[p + 2] = 255;
      rgba[p + 3] = 255;
    }
  }
  return new ImageData(rgba, width, height);
}

/** Composite a raster stamp into the mask canvas (add = OR in, erase = cut out). */
function drawStamp(ctx: CanvasRenderingContext2D, stamp: RasterStamp) {
  // Render the packed region to a scratch canvas, then composite it. A scratch
  // canvas is needed because destination-out needs a source shape to subtract.
  const scratch = document.createElement("canvas");
  scratch.width = stamp.width;
  scratch.height = stamp.height;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.putImageData(stampToImageData(stamp), 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = stamp.mode === "add" ? "source-over" : "destination-out";
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

function drawOp(ctx: CanvasRenderingContext2D, op: MaskOp) {
  if (op.kind === "stamp") drawStamp(ctx, op);
  else drawStroke(ctx, op);
}

/** Pack a source-res 0/255 mask (Uint8Array, 255 = selected) into 1-bit MSB-first. */
export function packMaskBits(mask: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const packed = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (mask[i] > 127) packed[i >> 3] |= 1 << (7 - (i & 7));
  }
  return packed;
}

export function useBrushMask(
  sourceWidth: number,
  sourceHeight: number,
): BrushMaskApi {
  const [brushSize, setBrushSize] = useState(BRUSH_DEFAULT);
  const [mode, setMode] = useState<BrushMode>("add");
  const [revision, setRevision] = useState(0);
  const [counts, setCounts] = useState({ undo: 0, redo: 0 });

  // History lives in refs (mutated imperatively during a drag for zero GC
  // churn); React state mirrors only the bits the UI needs (counts, revision).
  // Entries are MaskOp = brush Stroke | SAM RasterStamp; replayed uniformly.
  const strokesRef = useRef<MaskOp[]>([]);
  const redoRef = useRef<MaskOp[]>([]);
  const currentRef = useRef<Stroke | null>(null);

  // The mask canvas is created once per image size and reused.
  const maskCanvas = useMemo(() => {
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;
    const c = document.createElement("canvas");
    c.width = sourceWidth;
    c.height = sourceHeight;
    return c;
    // A new bitmap (new dimensions) gets a fresh mask + history below.
  }, [sourceWidth, sourceHeight]);

  // Reset all history whenever the mask canvas (i.e. the image) changes.
  useEffect(() => {
    strokesRef.current = [];
    redoRef.current = [];
    currentRef.current = null;
    setCounts({ undo: 0, redo: 0 });
    setRevision((r) => r + 1);
  }, [maskCanvas]);

  const ctx = useMemo(
    () => maskCanvas?.getContext("2d") ?? null,
    [maskCanvas],
  );

  const repaintAll = useCallback(() => {
    if (!ctx || !maskCanvas) return;
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    for (const s of strokesRef.current) drawOp(ctx, s);
  }, [ctx, maskCanvas]);

  const beginStroke = useCallback(
    (x: number, y: number) => {
      if (!ctx) return;
      currentRef.current = { mode, size: brushSize, points: [{ x, y }] };
      // Paint the initial dot immediately so a tap shows instantly.
      drawStroke(ctx, currentRef.current);
      setRevision((r) => r + 1);
    },
    [ctx, mode, brushSize],
  );

  const extendStroke = useCallback(
    (x: number, y: number) => {
      const cur = currentRef.current;
      if (!ctx || !cur) return;
      const last = cur.points[cur.points.length - 1];
      // Skip sub-pixel jitter; keeps the vector list lean on slow drags.
      if (last && Math.hypot(x - last.x, y - last.y) < 1) return;
      cur.points.push({ x, y });
      // Incremental: draw just the new segment instead of replaying everything.
      ctx.save();
      ctx.globalCompositeOperation =
        cur.mode === "add" ? "source-over" : "destination-out";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = cur.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.restore();
      setRevision((r) => r + 1);
    },
    [ctx],
  );

  const endStroke = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    currentRef.current = null;
    strokesRef.current.push(cur);
    redoRef.current = []; // a new stroke invalidates the redo branch
    setCounts({ undo: strokesRef.current.length, redo: 0 });
    setRevision((r) => r + 1);
  }, []);

  const undo = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    const popped = strokesRef.current.pop()!;
    redoRef.current.push(popped);
    repaintAll();
    setCounts({ undo: strokesRef.current.length, redo: redoRef.current.length });
    setRevision((r) => r + 1);
  }, [repaintAll]);

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return;
    const restored = redoRef.current.pop()!;
    strokesRef.current.push(restored);
    if (ctx) drawOp(ctx, restored); // redo just re-applies the one op
    setCounts({ undo: strokesRef.current.length, redo: redoRef.current.length });
    setRevision((r) => r + 1);
  }, [ctx]);

  const clear = useCallback(() => {
    if (strokesRef.current.length === 0 && redoRef.current.length === 0) return;
    strokesRef.current = [];
    redoRef.current = [];
    currentRef.current = null;
    if (ctx && maskCanvas) ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    setCounts({ undo: 0, redo: 0 });
    setRevision((r) => r + 1);
  }, [ctx, maskCanvas]);

  /**
   * Commit a SAM-produced raster selection (source-res 0/255 mask, 255 = object)
   * as one undoable op. Packs it to 1-bit so undo memory stays bounded, then
   * composites it into the live mask canvas exactly like a brush stroke.
   */
  const stampMask = useCallback(
    (mask: Uint8Array, width: number, height: number, opMode: BrushMode = "add") => {
      if (!ctx || !maskCanvas) return;
      if (width !== maskCanvas.width || height !== maskCanvas.height) return;
      const stamp: RasterStamp = {
        kind: "stamp",
        mode: opMode,
        packed: packMaskBits(mask, width, height),
        width,
        height,
      };
      strokesRef.current.push(stamp);
      redoRef.current = []; // a new op invalidates the redo branch
      drawStamp(ctx, stamp);
      setCounts({ undo: strokesRef.current.length, redo: 0 });
      setRevision((r) => r + 1);
    },
    [ctx, maskCanvas],
  );

  return {
    maskCanvas,
    brushSize,
    setBrushSize,
    mode,
    setMode,
    beginStroke,
    extendStroke,
    endStroke,
    undo,
    redo,
    clear,
    stampMask,
    canUndo: counts.undo > 0,
    canRedo: counts.redo > 0,
    hasMask: counts.undo > 0,
    revision,
  };
}
