import type { BrushMaskApi } from "./useBrushMask";
import { BRUSH_MIN, BRUSH_MAX } from "./useBrushMask";

/**
 * BrushToolbar — the editing controls for the mask: Add/Erase mode toggle,
 * brush-size slider, and Undo / Redo / Clear. Kept presentational; all state
 * lives in the useBrushMask hook passed down as `mask`.
 */

interface Props {
  mask: BrushMaskApi;
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex size-9 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export default function BrushToolbar({ mask }: Props) {
  const { brushSize, setBrushSize, mode, setMode, undo, redo, clear, canUndo, canRedo, hasMask } = mask;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-[var(--color-border)] px-4 py-2.5">
      {/* Add / Remove selection mode (the app erases the photo, so we avoid the
          word "erase" here — this toggles whether the brush adds to or removes
          from the selection mask). */}
      <div className="flex items-center gap-2">
        <span className="hidden text-sm text-[var(--color-fg-subtle)] sm:inline">Brush</span>
        <div
          className="inline-flex overflow-hidden rounded-lg border border-[var(--color-border)]"
          role="group"
          aria-label="Brush mode"
        >
          <button
            type="button"
            onClick={() => setMode("add")}
            aria-pressed={mode === "add"}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "add"
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
            Add
          </button>
          <button
            type="button"
            onClick={() => setMode("erase")}
            aria-pressed={mode === "erase"}
            className={`inline-flex items-center gap-1.5 border-l border-[var(--color-border)] px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "erase"
                ? "bg-[var(--color-danger)] text-white"
                : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /></svg>
            Remove
          </button>
        </div>
      </div>

      {/* Brush size */}
      <label className="flex items-center gap-2.5 text-sm text-[var(--color-fg-muted)]">
        <span className="hidden sm:inline">Size</span>
        <input
          type="range"
          min={BRUSH_MIN}
          max={BRUSH_MAX}
          value={brushSize}
          onChange={(e) => setBrushSize(Number(e.target.value))}
          className="mpe-range w-28 sm:w-40"
          aria-label="Brush size"
        />
        <span className="w-9 tabular-nums text-right text-[var(--color-fg-subtle)]">
          {brushSize}
        </span>
      </label>

      {/* History controls */}
      <div className="ml-auto flex items-center gap-2">
        <IconBtn label="Undo (Ctrl/⌘ Z)" onClick={undo} disabled={!canUndo}>
          <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
          </svg>
        </IconBtn>
        <IconBtn label="Redo (Ctrl/⌘ Shift Z)" onClick={redo} disabled={!canRedo}>
          <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 7v6h-6" />
            <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
          </svg>
        </IconBtn>
        <button
          type="button"
          onClick={clear}
          disabled={!hasMask}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
