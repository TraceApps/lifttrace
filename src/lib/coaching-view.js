/**
 * coaching-view.js: small shared helpers for the Coach and Coaching screens.
 */
import { get } from 'svelte/store';
import { dateFormat } from '../stores/settings.js';

/** A YYYY-MM-DD date in the app's date format (the Units setting). */
export function formatDay(d, fmt = get(dateFormat)) {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00');
  if (Number.isNaN(dt.getTime())) return d;
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dy = String(dt.getDate()).padStart(2, '0');
  if (fmt === 'US') return `${m}/${dy}/${dt.getFullYear()}`;
  if (fmt === 'EU') return `${dy}/${m}/${dt.getFullYear()}`;
  return d;
}

/** A server timestamp ("YYYY-MM-DD HH:MM:SS", UTC) as a local YYYY-MM-DD. */
export function localDay(ts) {
  if (!ts) return null;
  const dt = new Date(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('sv-SE');
}

/** A server timestamp as a day in the app's date format. */
export const formatServerDay = (ts, fmt) => formatDay(localDay(ts), fmt);

/** The message for a failed coaching call: offline says so plainly. */
export function coachingErrorText(e, t) {
  if (e?.offline) return t('coaching.needs_connection');
  return e?.message || t('coaching.something_failed');
}
