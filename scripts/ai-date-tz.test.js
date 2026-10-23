/**
 * Trace takes real dates in every time zone.
 *
 * The date check behind every dated Trace write and every date range
 * (aiTools.js) read a date as local noon, then compared it with its UTC
 * date. At UTC+13 and +14 (New Zealand in summer, Tonga, Samoa,
 * Kiritimati) local noon is the day before in UTC, so every date failed:
 * each dated write was refused ("date must be a real date") and each range
 * the model sent was dropped. The check now reads the date as a calendar
 * day, in UTC.
 *
 * Runs the real tool executor, with a stand-in API, in each time zone.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const ZONES = ['Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Tongatapu', 'Pacific/Apia', 'Pacific/Kiritimati', 'UTC', 'Europe/Berlin', 'America/New_York', 'Pacific/Honolulu', 'Etc/GMT+12'];
const lib = new URL('../src/lib/aiTools.js', import.meta.url).href;

function runIn(TZ) {
  const script = `
    const calls = [];
    globalThis.fetch = async (path, opts = {}) => { calls.push({ path, method: opts.method || 'GET', body: opts.body }); return { ok: true, json: async () => (opts.method === 'POST' ? { id: 1 } : []) }; };
    const { runTool, cleanRangeArgs } = await import(${JSON.stringify(lib)});
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
    const out = { today: day(0) };
    try { await runTool('log_cardio', { date: day(0), activity: 'Run', duration_min: 30 }); out.write = calls.find(c => c.method === 'POST')?.body || 'no POST'; } catch (e) { out.write = 'refused: ' + e.message; }
    out.range = cleanRangeArgs({ date_from: day(-7), date_to: day(0) });
    out.leap = cleanRangeArgs({ date_from: '2024-02-29', date_to: '2023-02-29' });
    process.stdout.write(JSON.stringify(out));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
}

for (const TZ of ZONES) {
  test(`dated writes and ranges go through in ${TZ}`, () => {
    const r = runIn(TZ);
    assert.ok(!String(r.write).startsWith('refused'), `today's run was refused: ${r.write}`);
    assert.equal(JSON.parse(r.write).date, r.today, 'saved on the day asked');
    const week = new Date(`${r.today}T00:00:00Z`); week.setUTCDate(week.getUTCDate() - 7);
    assert.deepEqual(r.range, { date_from: week.toISOString().slice(0, 10), date_to: r.today }, 'the range is kept');
    // A real leap day stays; a date that doesn't exist is still dropped.
    assert.deepEqual(r.leap, { date_from: '2024-02-29' });
  });
}
