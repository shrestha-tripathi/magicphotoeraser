/**
 * On-page debug mode — gated on `?debug=1`. Prints the device's REAL runtime
 * state plus a live, timestamped event log directly onto the page, so a user on
 * a phone we can't attach devtools to can screenshot ground-truth diagnostics.
 *
 * Why this exists: the brush/select coordinate + height-collapse fixes were
 * verified on a HEADLESS DESKTOP resized to 375px — which is NOT a real phone
 * (no ~250 MB tab-heap limit, no WebKit engine, no real touch/WebGPU). A crash
 * that only happens on the user's actual device cannot be fixed by guessing; it
 * needs evidence. The gap between the LAST log line and the crash IS the bug
 * location. See skill: on-page-debug-mode-for-mobile-crashes.
 *
 * Cost for normal users: ZERO behavioural change and ~no bytes — the panel only
 * mounts when `?debug=1` is present, and debugLog/debugFact are early-return
 * no-ops otherwise.
 */

import { probeWebGPU } from "./inpaint/capabilities";

interface PerfWithMemory {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}
interface NavExtras {
  gpu?: { requestAdapter?: () => Promise<unknown> };
  deviceMemory?: number;
  storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> };
}

const _params =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
/** True only when the page is loaded with ?debug=1. */
export const DEBUG_ENABLED = _params?.get("debug") === "1";

const _logLines: string[] = [];
const _facts: Record<string, string> = {};
let _panelEl: HTMLDivElement | null = null;
let _bodyEl: HTMLPreElement | null = null;
let _collapsed = false;
let _booted = false;

function _safe(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    return `(err: ${String(e)})`;
  }
}

function _render(): void {
  if (!_bodyEl || _collapsed) return;
  const factLines = Object.entries(_facts).map(([k, v]) => `${k}: ${v}`);
  _bodyEl.textContent =
    (_prevCrashTail ? _prevCrashTail + "\n" : "") +
    factLines.join("\n") +
    "\n──────── events ────────\n" +
    _logLines.join("\n");
}

// sessionStorage key for crash-survival: the log is mirrored here on EVERY append,
// so if iOS jetsams + auto-reloads the tab (the "it reloads the app" symptom), the
// NEXT load can show the tail that was on screen the instant before the kill.
const _CRASH_KEY = "mpe:debug:lastlog";
let _prevCrashTail = "";

function _persist(): void {
  try {
    // Keep it small — only the last ~40 lines matter for the crash signature.
    sessionStorage.setItem(_CRASH_KEY, _logLines.slice(-40).join("\n"));
  } catch {
    /* private mode / quota — best-effort */
  }
}

/** Append a timestamped event line (no-op unless ?debug=1). */
export function debugLog(msg: string): void {
  if (!DEBUG_ENABLED) return;
  const t =
    typeof performance !== "undefined" ? (performance.now() / 1000).toFixed(2) : "?";
  _logLines.push(`[${t}s] ${msg}`);
  if (_logLines.length > 250) _logLines.shift();
  _persist();
  _render();
}

/** Set/replace a top-of-panel fact line (no-op unless ?debug=1). */
export function debugFact(key: string, value: string): void {
  if (!DEBUG_ENABLED) return;
  _facts[key] = value;
  _render();
}

function _refreshHeap(): void {
  const mem = (performance as unknown as PerfWithMemory).memory;
  if (mem) {
    _facts["heap used/limit MB"] =
      `${(mem.usedJSHeapSize / 1e6).toFixed(0)} / ${(mem.jsHeapSizeLimit / 1e6).toFixed(0)}`;
  }
  _render();
}

async function _collectStaticFacts(): Promise<void> {
  const nav = navigator as unknown as NavExtras;
  _facts["time"] = _safe(() => new Date().toISOString());
  _facts["ua"] = _safe(() => navigator.userAgent);
  _facts["viewport"] = _safe(
    () => `${window.innerWidth}x${window.innerHeight} @dpr${window.devicePixelRatio}`,
  );
  _facts["pointer-coarse"] = _safe(() =>
    String(window.matchMedia("(pointer: coarse)").matches),
  );
  _facts["crossOriginIsolated"] = _safe(() => String(self.crossOriginIsolated));
  _facts["SharedArrayBuffer"] = _safe(() => String(typeof SharedArrayBuffer !== "undefined"));
  _facts["navigator.gpu present"] = _safe(() => String("gpu" in navigator));
  _facts["hardwareConcurrency"] = _safe(() => String(navigator.hardwareConcurrency ?? "?"));
  _facts["deviceMemory(GB)"] = _safe(() => String(nav.deviceMemory ?? "(n/a)"));

  const mem = (performance as unknown as PerfWithMemory).memory;
  _facts["heap used/limit MB"] = mem
    ? `${(mem.usedJSHeapSize / 1e6).toFixed(0)} / ${(mem.jsHeapSizeLimit / 1e6).toFixed(0)}`
    : "(n/a — WebKit/Safari)";

  _render();

  // Storage estimate (how much IDB/cache headroom the device gives us).
  try {
    if (nav.storage?.estimate) {
      const est = await nav.storage.estimate();
      _facts["storage use/quota MB"] =
        `${((est.usage ?? 0) / 1e6).toFixed(0)} / ${((est.quota ?? 0) / 1e6).toFixed(0)}`;
      _render();
    }
  } catch {
    /* ignore */
  }

  // The REAL capability decision the app will make (await requestAdapter, not
  // just `'gpu' in navigator`) — this is what picks the webgpu vs wasm EP.
  _facts["webgpu adapter (app EP)"] = "probing…";
  _render();
  try {
    const ok = await probeWebGPU();
    _facts["webgpu adapter (app EP)"] = ok ? "YES → webgpu EP" : "null → WASM EP";
  } catch (e) {
    _facts["webgpu adapter (app EP)"] = `threw → WASM EP (${String(e)})`;
  }
  _render();
}

/**
 * Mount the on-screen debug panel (idempotent; no-op unless ?debug=1). Also
 * installs global error/rejection listeners so silent failures surface in the
 * panel even when nothing reaches the UI.
 */
export function mountDebugPanel(): void {
  if (!DEBUG_ENABLED || _booted || typeof document === "undefined") return;
  _booted = true;

  _panelEl = document.createElement("div");
  _panelEl.id = "mpe-debug-panel";
  _panelEl.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "background:#000",
    "color:#0f0",
    "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:6px 10px",
    "z-index:2147483647",
    "max-height:60vh",
    "overflow-y:auto",
    "white-space:pre-wrap",
    "word-break:break-word",
    "border-bottom:2px solid #0f0",
    "box-shadow:0 2px 12px rgba(0,0,0,0.6)",
  ].join(";");

  const hdr = document.createElement("div");
  hdr.style.cssText =
    "cursor:pointer;color:#ff0;margin-bottom:4px;font-weight:bold;user-select:none";
  const setHdr = () => {
    hdr.textContent = _collapsed
      ? "▶ DEBUG — tap to expand & screenshot"
      : "▼ DEBUG (?debug=1) — screenshot this, then reproduce. Tap bar to collapse.";
  };
  hdr.addEventListener("click", () => {
    _collapsed = !_collapsed;
    if (_bodyEl) _bodyEl.style.display = _collapsed ? "none" : "block";
    if (_panelEl)
      _panelEl.style.maxHeight = _collapsed ? "auto" : "60vh";
    setHdr();
    _render();
  });
  setHdr();

  _bodyEl = document.createElement("pre");
  _bodyEl.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word";

  _panelEl.appendChild(hdr);
  _panelEl.appendChild(_bodyEl);
  document.body.appendChild(_panelEl);

  // CRASH-SURVIVAL: if a previous load left a log tail in sessionStorage, the tab
  // was reloaded (likely an iOS jetsam kill — the "it reloads the app" symptom).
  // Show that tail FIRST, brightly, so the user's screenshot captures the lines
  // that were on screen the instant before the kill — the crash signature.
  try {
    const tail = sessionStorage.getItem(_CRASH_KEY);
    if (tail) {
      _prevCrashTail =
        "╔══ PREVIOUS SESSION (before reload/crash) ══\n" +
        tail
          .split("\n")
          .map((l) => "║ " + l)
          .join("\n") +
        "\n╚════════════════════════════════════════════";
      // Clear so a normal manual reload later doesn't keep showing a stale crash.
      sessionStorage.removeItem(_CRASH_KEY);
    }
  } catch {
    /* ignore */
  }

  // Surface otherwise-silent failures (esp. the Arc "did nothing" case).
  window.addEventListener("error", (e) => {
    debugLog(`window.error: ${e.message} @ ${e.filename ?? "?"}:${e.lineno ?? "?"}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    debugLog(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`);
  });
  // iOS fires pagehide right before the OS may discard the tab — log it so the
  // persisted tail ends with a clear "page hidden" marker if a kill follows.
  window.addEventListener("pagehide", () => debugLog("pagehide (tab backgrounded/discarded)"));

  debugLog("debug panel mounted");
  void _collectStaticFacts();

  // Heartbeat: log "alive" every 2s with a counter. After an erase, if the log
  // STOPS advancing (no more heartbeats) and the tab reloads, the gap pins the
  // moment of death — esp. useful on WebKit where performance.memory is absent.
  let _beat = 0;
  window.setInterval(() => {
    _beat++;
    const mem = (performance as unknown as PerfWithMemory).memory;
    const memStr = mem ? ` heap=${(mem.usedJSHeapSize / 1e6).toFixed(0)}MB` : "";
    debugLog(`♥ alive #${_beat}${memStr}`);
  }, 2000);

  // Refresh heap fact every 1.5 s so the user can watch memory climb toward the kill.
  window.setInterval(_refreshHeap, 1500);
}
