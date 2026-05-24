/**
 * Shared formatting helpers for the Statistics page and its extracted
 * chart components. Kept as plain functions so they're also usable
 * from Svelte reactive statements without subscribing to stores.
 */

/** Compact volume number: 12 → "12", 4800 → "4.8k", 1234567 → "1.2M". */
export function fmtVol(v) {
  if (!Number.isFinite(v)) return '0';
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

/** Turn a "2026-W17" style ISO week into just "W17" for axis labels. */
export function fmtWeekLabel(w) {
  return w ? w.slice(5) : '';
}
