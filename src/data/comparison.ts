/**
 * Single source of truth for the comparison table.
 *
 * Used by BOTH the 3-row home-page teaser AND the full /compare table, so the
 * two can never drift. Follows the incumbent-displacement methodology:
 *   - 3-state Verdict (true / false / "partial") — real products have caveats.
 *   - YOU (`us`) are always definitive (boolean), never "partial".
 *   - 1–2 honest-loss rows (us:false) with a roadmap note build more trust
 *     than pretending no gap exists.
 *   - Never lose on a row whose label IS the value proposition.
 */

export type Verdict = boolean | "partial";

export interface ComparisonRow {
  /** Short feature label (the row header). */
  feature: string;
  /** One-liner: why this matters to the user. */
  why: string;
  /** Verdict per competitor, in COMPETITORS order. */
  others: Verdict[];
  /** Our verdict — always definitive. */
  us: boolean;
  /** Per-competitor caveat, parallel to `others` (null = no caveat). */
  notes?: (string | null)[];
  /** Our caveat — shown when us:false (the honest-loss roadmap note). */
  note?: string;
  /** Is this one of the 3 rows shown in the home-page teaser? */
  teaser?: boolean;
}

/** Competitor column headers, in table order. */
export const COMPETITORS = [
  "cleanup.pictures",
  "Pixlr",
  "Photoshop",
] as const;

export const comparisonRows: ComparisonRow[] = [
  {
    feature: "Photos never uploaded",
    why: "Private photos (IDs, kids, medical) stay on your device — not a stranger's GPU.",
    others: [false, false, "partial"],
    us: true,
    notes: [
      "Uploads to their servers to process",
      "Uploads to their servers to process",
      "Desktop app is local; Firefly generative fill uploads to Adobe",
    ],
    teaser: true,
  },
  {
    feature: "Full-resolution HD export, free",
    why: "Keep your photo sharp without paying — the rest of the image is untouched.",
    others: [false, false, true],
    us: true,
    notes: [
      "Free output is low-res; HD is paywalled",
      "HD export needs a paid plan",
      "Full-res, but $23/mo",
    ],
    teaser: true,
  },
  {
    feature: "No watermark",
    why: "Your result is yours — no badge stamped across it.",
    others: ["partial", "partial", true],
    us: true,
    notes: [
      "Watermark/limits on the free tier",
      "Watermark on free exports",
      null,
    ],
  },
  {
    feature: "No signup or account",
    why: "Open the page and erase — no email, no login wall.",
    others: [true, false, false],
    us: true,
    notes: [null, "Account required", "Adobe ID required"],
    teaser: true,
  },
  {
    feature: "Free forever, no subscription",
    why: "$0 marginal cost on-device means free is sustainable, not a trial.",
    others: ["partial", false, false],
    us: true,
    notes: [
      "Free low-res only; pay for HD",
      "Free tier is limited; Premium is paid",
      "Subscription only",
    ],
  },
  {
    feature: "Works in the browser, nothing to install",
    why: "No 2 GB download — works on any laptop, Chromebook, or phone.",
    others: [true, true, false],
    us: true,
    notes: [null, null, "Desktop install (or web app with upload)"],
  },
  {
    feature: "Runs offline after first load",
    why: "The model caches on your device — keep erasing with no connection.",
    others: [false, false, true],
    us: true,
    notes: [
      "Needs a connection every time (server-side)",
      "Needs a connection every time (server-side)",
      "Desktop app works offline",
    ],
  },
  {
    feature: "Open source",
    why: "Inspect exactly what runs on your photos — no black box.",
    others: [false, false, false],
    us: true,
  },
  {
    feature: "Click-to-select objects (AI)",
    why: "Tap the object instead of brushing it precisely by hand.",
    others: [true, "partial", true],
    us: false,
    note: "On the roadmap — on-device click-to-select (MobileSAM) is the next major release. Brush-select ships first.",
    notes: ["Click-select supported", "Some AI selection tools", "Object selection + Generative Fill"],
  },
];

/** The 3 rows shown in the home-page teaser. */
export const teaserRows = comparisonRows.filter((r) => r.teaser);
