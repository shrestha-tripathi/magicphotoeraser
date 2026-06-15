/*
 * pwaInstall — custom PWA install prompt for the /app editor.
 *
 * Replaces Chrome's mini-infobar with a brand-styled pill, and gives iOS Safari
 * (which has no `beforeinstallprompt`) a manual "Share → Add to Home Screen"
 * hint. Zero dependencies, ~vanilla DOM appended to <body> — same pattern as
 * onboardingTour.ts, so it lives OUTSIDE React's root and never conflicts with
 * the editor island's reconciliation.
 *
 * Lives in the editor (NOT the marketing pages, which stay 0-JS): install intent
 * peaks right after a successful erase, and the editor is where the user has
 * proven the tool is worth keeping.
 *
 * The manifest (name, icons incl. maskable, theme/bg) and apple-touch-icon link
 * already ship (commit 4 / Layout.astro) — this module is purely the prompt UX.
 *
 * Honesty note: this is an INSTALL prompt, not an offline promise. The eraser
 * still needs the network to fetch its model on first use; the SW is
 * install-only (see public/sw.js). The pill copy says "Install", never "works
 * offline".
 */

import { site } from "../site.config";

const DISMISS_KEY = "mpe:pwa-dismissed-at";
const INSTALLED_KEY = "mpe:pwa-installed";
const REMIND_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** The non-standard event Chrome/Edge fire before showing their install UI. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let promptEl: HTMLDivElement | null = null;
let initialized = false;

/* ── storage helpers (private-mode safe — never throw, never nag on block) ── */

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage — ignore */
  }
}

/* ── install-state detection ── */

function isStandalone(): boolean {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* matchMedia unavailable — fall through */
  }
  // iOS Safari exposes navigator.standalone instead of the display-mode query.
  if ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone) {
    return true;
  }
  return false;
}

function isAlreadyInstalled(): boolean {
  if (getItem(INSTALLED_KEY) === "1") return true;
  return isStandalone();
}

function wasRecentlyDismissed(): boolean {
  const ts = Number.parseInt(getItem(DISMISS_KEY) ?? "", 10);
  return Number.isFinite(ts) && Date.now() - ts < REMIND_AFTER_MS;
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Mac; disambiguate via touch points.
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && safari;
}

/* ── DOM ── */

const ERASER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>';

const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function removePrompt(): void {
  if (promptEl) {
    promptEl.remove();
    promptEl = null;
  }
}

function dismiss(): void {
  setItem(DISMISS_KEY, String(Date.now()));
  removePrompt();
}

/**
 * Build + show the install pill. `ios` mode shows manual A2HS instructions and
 * no action button (iOS can't be triggered programmatically); otherwise the
 * primary button calls the captured `deferredPrompt`.
 */
function showPromptUI(opts: { ios: boolean }): void {
  if (promptEl) return; // already showing

  const wrap = document.createElement("div");
  wrap.className = "mpe-install";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-live", "polite");
  wrap.setAttribute("aria-label", `Install ${site.name}`);

  const icon = document.createElement("div");
  icon.className = "mpe-install-icon";
  icon.innerHTML = ERASER_ICON;

  const text = document.createElement("div");
  text.className = "mpe-install-text";

  const titleEl = document.createElement("div");
  titleEl.className = "mpe-install-title";

  const bodyEl = document.createElement("div");
  bodyEl.className = "mpe-install-body";

  if (opts.ios) {
    titleEl.textContent = `Install ${site.name}`;
    bodyEl.innerHTML = "Tap <b>Share</b>, then <b>Add to Home Screen</b>.";
  } else {
    titleEl.textContent = `Install ${site.name}`;
    bodyEl.textContent = "Add it to your home screen for one-tap access.";
  }
  text.append(titleEl, bodyEl);

  const actions = document.createElement("div");
  actions.className = "mpe-install-actions";

  if (!opts.ios) {
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "mpe-install-btn";
    installBtn.textContent = "Install";
    installBtn.addEventListener("click", () => {
      void acceptInstall();
    });
    actions.append(installBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mpe-install-close";
  closeBtn.setAttribute("aria-label", "Dismiss install prompt");
  closeBtn.innerHTML = CLOSE_ICON;
  closeBtn.addEventListener("click", dismiss);

  wrap.append(icon, text, actions, closeBtn);
  document.body.append(wrap);
  promptEl = wrap;
}

/** Fire the browser's native install flow from the deferred event. */
async function acceptInstall(): Promise<void> {
  const dp = deferredPrompt;
  // Hide our pill immediately so it doesn't linger behind the native dialog.
  removePrompt();
  if (!dp) return;
  deferredPrompt = null;
  try {
    await dp.prompt();
    const { outcome } = await dp.userChoice;
    if (outcome === "dismissed") {
      // User declined the native dialog — respect the cooldown before re-asking.
      setItem(DISMISS_KEY, String(Date.now()));
    }
    // On "accepted", the appinstalled handler sets the sticky bit.
  } catch {
    /* prompt() can reject if already consumed — ignore */
  }
}

/* ── public entry ── */

/**
 * Wire up install handling. Safe to call before DOM-ready (only attaches
 * listeners). No-ops if already installed or recently dismissed.
 */
export function initPwaInstall(): void {
  if (initialized) return;
  initialized = true;

  if (isAlreadyInstalled() || wasRecentlyDismissed()) return;

  // Chrome/Edge/Android: capture the event, suppress the default mini-infobar,
  // and show our own pill instead.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    if (!isAlreadyInstalled() && !wasRecentlyDismissed()) {
      showPromptUI({ ios: false });
    }
  });

  // Once installed (via our pill OR the browser's own menu), set the sticky bit
  // and never prompt again.
  window.addEventListener("appinstalled", () => {
    setItem(INSTALLED_KEY, "1");
    deferredPrompt = null;
    removePrompt();
  });

  // iOS Safari never fires beforeinstallprompt — show a manual hint after a
  // delay so it doesn't crowd first paint / the onboarding tour.
  if (isIosSafari()) {
    window.setTimeout(() => {
      if (!isAlreadyInstalled() && !wasRecentlyDismissed()) {
        showPromptUI({ ios: true });
      }
    }, 8000);
  }
}
