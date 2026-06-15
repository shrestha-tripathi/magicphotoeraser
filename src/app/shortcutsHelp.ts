/*
 * shortcutsHelp — a keyboard-shortcuts cheat-sheet overlay for the /app editor.
 *
 * The editor has several power-user shortcuts (mask cycling, negative-point
 * subtract, undo/redo, compare-slider nudges) that are otherwise invisible. This
 * is a discoverable reference: press `?` anywhere in the editor, or click the
 * keyboard button in the toolbar.
 *
 * Same zero-dependency, vanilla-DOM pattern as onboardingTour.ts — the overlay is
 * appended to <body>, OUTSIDE React's root, so it never conflicts with the editor
 * island's reconciliation. Unlike the tour, this is a proper modal dialog: it
 * traps focus, closes on Esc / backdrop / ✕, and restores focus to whatever
 * opened it (a11y baseline for a modal).
 */

interface Shortcut {
  /** Key tokens rendered as <kbd> chips, joined visually. `mod` → ⌘ on Mac, Ctrl elsewhere. */
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

// Mirrors the ACTUAL handlers in the codebase — keep in sync if shortcuts change:
//   EraserApp `]`/`[` cycle (cycleMask), Ctrl/⌘+Z / ⌘+Shift+Z / Ctrl+Y undo-redo;
//   CanvasEditor alt/right-click negative point; BeforeAfterSlider arrows/Home/End.
const GROUPS: ShortcutGroup[] = [
  {
    title: "Selecting",
    items: [
      { keys: ["Click"], label: "Select the object you click on" },
      { keys: ["Right-click"], label: "Remove from the selection" },
      { keys: ["Alt", "Click"], label: "Remove from the selection" },
      { keys: ["]"], label: "Try the next selection shape" },
      { keys: ["["], label: "Try the previous selection shape" },
    ],
  },
  {
    title: "Editing",
    items: [
      { keys: ["mod", "Z"], label: "Undo" },
      { keys: ["mod", "Shift", "Z"], label: "Redo" },
      { keys: ["mod", "Y"], label: "Redo (alternative)" },
    ],
  },
  {
    title: "Compare (before / after)",
    items: [
      { keys: ["← / →"], label: "Move the divider" },
      { keys: ["Shift", "← / →"], label: "Move in bigger steps" },
      { keys: ["Home / End"], label: "Jump to either edge" },
    ],
  },
  {
    title: "General",
    items: [{ keys: ["?"], label: "Show this shortcut list" }],
  },
];

function isMac(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Render one key token to its display label. `mod` is platform-aware. */
function keyLabel(token: string, mac: boolean): string {
  if (token === "mod") return mac ? "\u2318" : "Ctrl";
  if (token === "Shift") return mac ? "\u21e7" : "Shift";
  if (token === "Alt") return mac ? "\u2325" : "Alt";
  return token;
}

let overlay: HTMLDivElement | null = null;
let lastFocused: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export function isShortcutsOpen(): boolean {
  return overlay !== null;
}

export function closeShortcuts(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler, true);
    keydownHandler = null;
  }
  // Restore focus to the element that opened the dialog (a11y).
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus();
  }
  lastFocused = null;
}

const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export function openShortcuts(): void {
  if (overlay) return; // already open
  lastFocused = (document.activeElement as HTMLElement) || null;
  const mac = isMac();

  const backdrop = document.createElement("div");
  backdrop.className = "mpe-sc-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "mpe-sc-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "mpe-sc-title");

  const header = document.createElement("div");
  header.className = "mpe-sc-header";

  const title = document.createElement("h2");
  title.className = "mpe-sc-title";
  title.id = "mpe-sc-title";
  title.textContent = "Keyboard shortcuts";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mpe-sc-close";
  closeBtn.setAttribute("aria-label", "Close shortcuts");
  closeBtn.innerHTML = CLOSE_ICON;
  closeBtn.addEventListener("click", closeShortcuts);

  header.append(title, closeBtn);

  const grid = document.createElement("div");
  grid.className = "mpe-sc-grid";

  for (const group of GROUPS) {
    const section = document.createElement("section");
    section.className = "mpe-sc-group";

    const gTitle = document.createElement("h3");
    gTitle.className = "mpe-sc-group-title";
    gTitle.textContent = group.title;
    section.append(gTitle);

    const dl = document.createElement("dl");
    dl.className = "mpe-sc-list";

    for (const sc of group.items) {
      const row = document.createElement("div");
      row.className = "mpe-sc-row";

      const keys = document.createElement("dt");
      keys.className = "mpe-sc-keys";
      sc.keys.forEach((tok, i) => {
        if (i > 0) {
          const plus = document.createElement("span");
          plus.className = "mpe-sc-plus";
          plus.textContent = "+";
          keys.append(plus);
        }
        const kbd = document.createElement("kbd");
        kbd.className = "mpe-sc-kbd";
        kbd.textContent = keyLabel(tok, mac);
        keys.append(kbd);
      });

      const desc = document.createElement("dd");
      desc.className = "mpe-sc-desc";
      desc.textContent = sc.label;

      row.append(keys, desc);
      dl.append(row);
    }
    section.append(dl);
    grid.append(section);
  }

  const footer = document.createElement("div");
  footer.className = "mpe-sc-footer";
  footer.innerHTML = `Press <kbd class="mpe-sc-kbd">Esc</kbd> to close · everything runs on your device`;

  dialog.append(header, grid, footer);
  backdrop.append(dialog);
  document.body.append(backdrop);
  overlay = backdrop;

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeShortcuts();
  });

  // Focus the close button so the dialog is immediately keyboard-operable.
  closeBtn.focus();

  // Capture-phase key handling: Esc closes; Tab is trapped within the dialog.
  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeShortcuts();
      return;
    }
    if (e.key === "Tab") {
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", keydownHandler, true);
}

/** Toggle convenience for the `?` key + toolbar button. */
export function toggleShortcuts(): void {
  if (overlay) closeShortcuts();
  else openShortcuts();
}
