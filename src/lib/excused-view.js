/**
 * How an excused day (issue #121) looks wherever it shows: the Diary's sheet,
 * banner, calendar and week strip, the Statistics heatmap and the coach's
 * view of a client. One icon per reason, so the same reason reads the same
 * everywhere.
 */
export const EXCUSE_ICONS = {
  injury: 'personal_injury',
  illness: 'sick',
  appointment: 'event',
  other: 'event_busy',
};

export const excuseIcon = (reason) => EXCUSE_ICONS[reason] || 'event_busy';

/** Excused days as a Map date -> record, removed ones left out. */
export function excusedMap(rows) {
  const out = new Map();
  for (const r of rows || []) if (r?.date && !r.deleted_at) out.set(r.date, r);
  return out;
}
