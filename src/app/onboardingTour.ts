/**
 * onboardingTour — a zero-dependency, first-run guided tour for the /app editor.
 *
 * ~6 KB of vanilla DOM (spotlight + popover + Next/Back/Skip + Esc/Arrow keys),
 * NOT shepherd.js/driver.js (40–80 KB for what fits here). The tour DOM is
 * appended to <body>, OUTSIDE React's root, so there's no reconciliation
 * conflict with the editor island — React owns the app, this owns its overlay.
 *
 * Fires once, ~1 s after the user's FIRST photo decodes (the moment the magic
 * toolbar appears) — see EraserApp's first-ready effect. A sticky localStorage
 * bit means it never nags again; the toolbar "?" button replays it on demand.
 *
 * Steps anchor to `[data-tour-anchor="…"]` elements in the editor toolbar. A
 * missing anchor SILENTLY skips that step (never crashes the tour) — important
 * because the refine anchor only exists in select mode.
 */

const SEEN_KEY = "mpe:tour-seen-v1"; // bump the suffix when the tour changes materially

interface TourStep {
  /** Value of the target's `data-tour-anchor` attribute. Step skipped if absent. */
  anchor: string;
  placement: "top" | "bottom";
  title: string;
  body: string;
}

// Hand-curated to the THREE highest-value, least-obvious interactions. The skill
// warns against over-touring; upload is self-explanatory so it's intentionally omitted.
const STEPS: TourStep[] = [
  {
    anchor: "select",
    placement: "bottom",
    title: "Click to select — the magic",
    body: "Just click any object. On-device AI selects it instantly — no careful tracing, no upload. Click a different spot to select something else.",
  },
  {
    anchor: "refine",
    placement: "bottom",
    title: "Refine if needed",
    body: "Add or remove points to fine-tune the selection, cycle alternative shapes, or switch to Brush for full manual control.",
  },
  {
    anchor: "erase",
    placement: "top",
    title: "Erase — it vanishes",
    body: "Hit Erase and the object disappears, with AI filling the gap seamlessly. Everything runs on your device — your photo is never uploaded.",
  },
];

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // private mode / blocked storage → treat as seen (never nag)
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

interface ResolvedStep {
  step: TourStep;
  el: HTMLElement;
}

function resolveSteps(): ResolvedStep[] {
  return STEPS.flatMap((step) => {
    const el = document.querySelector<HTMLElement>(`[data-tour-anchor="${step.anchor}"]`);
    return el ? [{ step, el }] : []; // missing anchor → silently skip
  });
}

interface TourUI {
  backdrop: HTMLDivElement;
  spotlight: HTMLDivElement;
  popover: HTMLDivElement;
  titleEl: HTMLDivElement;
  bodyEl: HTMLDivElement;
  counterEl: HTMLSpanElement;
  backBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  skipBtn: HTMLButtonElement;
}

function createTourUI(): TourUI {
  const backdrop = document.createElement("div");
  backdrop.className = "mpe-tour-backdrop";

  const spotlight = document.createElement("div");
  spotlight.className = "mpe-tour-spotlight";

  const popover = document.createElement("div");
  popover.className = "mpe-tour-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-live", "polite");
  popover.setAttribute("aria-label", "Product tour");

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "mpe-tour-skip";
  skipBtn.setAttribute("aria-label", "Close tour");
  skipBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  const titleEl = document.createElement("div");
  titleEl.className = "mpe-tour-title";

  const bodyEl = document.createElement("div");
  bodyEl.className = "mpe-tour-body";

  const footer = document.createElement("div");
  footer.className = "mpe-tour-footer";

  const counterEl = document.createElement("span");
  counterEl.className = "mpe-tour-counter";

  const btns = document.createElement("div");
  btns.className = "mpe-tour-btns";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "mpe-tour-btn mpe-tour-btn--ghost";
  backBtn.textContent = "Back";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "mpe-tour-btn mpe-tour-btn--primary";
  nextBtn.textContent = "Next";

  btns.append(backBtn, nextBtn);
  footer.append(counterEl, btns);
  popover.append(skipBtn, titleEl, bodyEl, footer);

  document.body.append(backdrop, spotlight, popover);
  return { backdrop, spotlight, popover, titleEl, bodyEl, counterEl, backBtn, nextBtn, skipBtn };
}

function positionUI(ui: TourUI, item: ResolvedStep, index: number, total: number): void {
  const rect = item.el.getBoundingClientRect();
  const pad = 8;
  Object.assign(ui.spotlight.style, {
    top: `${rect.top - pad}px`,
    left: `${rect.left - pad}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`,
  });

  // Populate text + controls.
  ui.titleEl.textContent = item.step.title;
  ui.bodyEl.textContent = item.step.body;
  ui.counterEl.textContent = `${index + 1} of ${total}`;
  ui.backBtn.style.visibility = index === 0 ? "hidden" : "visible";
  ui.nextBtn.textContent = index === total - 1 ? "Got it" : "Next";

  // Popover placement: prefer the step hint, flip if there isn't room.
  const W = Math.min(330, window.innerWidth - 24);
  const P = 12;
  let left = rect.left + rect.width / 2 - W / 2;
  left = Math.max(P, Math.min(window.innerWidth - W - P, left));
  const estH = ui.popover.offsetHeight || 190;
  const spaceBelow = window.innerHeight - rect.bottom;
  const below = item.step.placement === "bottom" && spaceBelow > estH + 24;
  const top = below
    ? rect.bottom + 14
    : Math.max(P, rect.top - estH - 14);
  Object.assign(ui.popover.style, { top: `${top}px`, left: `${left}px`, width: `${W}px` });
}

/**
 * Start the tour. With `{ force: true }` it always runs (the "?" replay button);
 * otherwise it only runs on first visit. Returns false if it didn't start
 * (already seen, no anchors found, or already open).
 */
export function startTour(opts?: { force?: boolean }): boolean {
  if (!opts?.force && hasSeenTour()) return false;
  if (document.querySelector(".mpe-tour-popover")) return false; // no double-start
  const items = resolveSteps();
  if (items.length === 0) return false;

  const ui = createTourUI();
  let index = 0;
  const cleanups: Array<() => void> = [];

  const render = () => positionUI(ui, items[index], index, items.length);

  const finish = () => {
    markSeen();
    ui.backdrop.classList.add("mpe-tour--leaving");
    ui.popover.classList.add("mpe-tour--leaving");
    ui.spotlight.classList.add("mpe-tour--leaving");
    window.setTimeout(() => {
      ui.backdrop.remove();
      ui.popover.remove();
      ui.spotlight.remove();
    }, 200);
    cleanups.forEach((fn) => fn());
  };

  const go = (dir: number) => {
    const next = index + dir;
    if (next < 0) return;
    if (next >= items.length) {
      finish();
      return;
    }
    index = next;
    render();
  };

  ui.nextBtn.addEventListener("click", () => go(1));
  ui.backBtn.addEventListener("click", () => go(-1));
  ui.skipBtn.addEventListener("click", finish);
  ui.backdrop.addEventListener("click", finish);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    }
  };
  window.addEventListener("keydown", onKey);
  cleanups.push(() => window.removeEventListener("keydown", onKey));

  const onReflow = () => render();
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, { passive: true });
  cleanups.push(
    () => window.removeEventListener("resize", onReflow),
    () => window.removeEventListener("scroll", onReflow),
  );

  render();
  // The popover's real height is unknown until paint; a second pass corrects
  // placement once we can measure offsetHeight.
  requestAnimationFrame(render);
  return true;
}

// Support/debug helper: `__resetTour()` in DevTools clears the seen-bit so the
// first-run tour fires again on the next image load. Registered once.
if (typeof window !== "undefined") {
  (window as unknown as { __resetTour?: () => void }).__resetTour = () => {
    try {
      localStorage.removeItem(SEEN_KEY);
      // eslint-disable-next-line no-console
      console.info("[MPE tour] Reset — load a photo (or click ?) to see it again.");
    } catch {
      /* ignore */
    }
  };
}
