/**
 * Persistent collapse state for exercise / superset cards in the diary.
 * Keyed by date + rowKey so state survives navigation within the same day.
 * Old dates (> 30) are pruned automatically.
 *
 * Three-state model:
 *   null          — user has never interacted with this card; defaults apply
 *   'collapsed'   — user (or auto-collapse) wants it closed
 *   'expanded'    — user explicitly expanded after it was collapsed;
 *                   auto-collapse MUST respect this and not re-close
 *
 * Backwards-compatible with the earlier two-state format that used plain
 * `true`/no-entry: a legacy `true` is read as 'collapsed'.
 */
const KEY = 'lt:card-collapsed';

function _read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }
}

function _write(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {}
}

function _prune(map) {
  const dates = Object.keys(map).sort();
  if (dates.length <= 30) return map;
  const keep = new Set(dates.slice(-30));
  const next = {};
  for (const d of keep) next[d] = map[d];
  return next;
}

/** Returns 'collapsed' | 'expanded' | null. */
export function getCollapseState(date, rowKey) {
  if (!date || rowKey == null) return null;
  const map = _read();
  const raw = map?.[date]?.[rowKey];
  if (raw === 'collapsed' || raw === true)  return 'collapsed';
  if (raw === 'expanded'  || raw === false) return 'expanded';
  return null;
}

/** Convenience — keep the old signature working for callers that just want a bool. */
export function isCollapsed(date, rowKey) {
  return getCollapseState(date, rowKey) === 'collapsed';
}

/** Set an explicit state — BOTH collapsed and expanded are persisted, so the
 *  auto-collapse-on-complete logic can tell "user never touched it" from
 *  "user explicitly re-opened it after auto-collapse". */
export function setCollapsed(date, rowKey, collapsed) {
  if (!date || rowKey == null) return;
  let map = _read();
  if (!map[date]) map[date] = {};
  map[date][rowKey] = collapsed ? 'collapsed' : 'expanded';
  map = _prune(map);
  _write(map);
}
