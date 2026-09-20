import nodemailer from 'nodemailer';
import db from './db.js';
import { changeVsAvg, fmtMinutes, fmtHold, summaryLine } from './lib/weekly-summary.js';

export function seedSmtpFromEnv() {
  const map = {
    SMTP_HOST: 'smtp_host', SMTP_PORT: 'smtp_port', SMTP_SECURE: 'smtp_secure',
    SMTP_USER: 'smtp_user', SMTP_PASS: 'smtp_pass', SMTP_FROM:   'smtp_from',
  };
  const upsert = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  // Only lock if the primary SMTP_HOST is actually set (non-empty).
  // Other vars like SMTP_PORT may have docker-compose defaults that
  // shouldn't trigger the lock on their own.
  const hostVal = process.env.SMTP_HOST;
  const locked = hostVal != null && hostVal !== '';
  for (const [envKey, dbKey] of Object.entries(map)) {
    const val = process.env[envKey];
    if (val != null && val !== '') upsert.run(dbKey, val);
  }
  if (locked) upsert.run('smtp_env_locked', 'true');
  else db.prepare("DELETE FROM app_config WHERE key = 'smtp_env_locked'").run();
}

export function isSmtpEnvLocked() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('smtp_env_locked');
  return row?.value === 'true';
}

function getSmtpConfig() {
  const rows = db.prepare('SELECT key, value FROM app_config WHERE key LIKE ?').all('smtp_%');
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = value;
  return cfg;
}

// Merge stored config with any inline overrides. Empty-string overrides
// still count as "user cleared this field"; only undefined falls back
// to storage. Lets the Settings UI test unsaved form values.
function _mergedCfg(overrides) {
  const stored = getSmtpConfig();
  if (!overrides) return stored;
  const merged = { ...stored };
  for (const k of ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from']) {
    if (overrides[k] !== undefined) merged[k] = overrides[k];
  }
  return merged;
}

function createTransport(overrides) {
  const cfg = _mergedCfg(overrides);
  if (!cfg.smtp_host) throw new Error('Email not configured.');
  return nodemailer.createTransport({
    host: cfg.smtp_host, port: parseInt(cfg.smtp_port || '587'),
    secure: cfg.smtp_secure === 'true',
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass || '' } : undefined,
  });
}

export async function sendMail({ to, subject, html, text }) {
  const cfg = getSmtpConfig();
  const from = cfg.smtp_from || cfg.smtp_user || 'LiftTrace <noreply@lifttrace.app>';
  const transport = createTransport();
  await transport.sendMail({ from, to, subject, html, text });
}

/** Send a real branded test email to prove end-to-end delivery, not just
 *  auth. If `overrides` is provided, uses those values for the connection
 *  (so unsaved form values can be tested). Recipient priority: explicit
 *  `to` arg, then smtp_from, then smtp_user. Returns the address the
 *  email was actually sent to so the UI can show it. */
export async function testSmtp({ overrides, to, origin, recipientName } = {}) {
  const cfg = _mergedCfg(overrides);
  const from = cfg.smtp_from || cfg.smtp_user || 'LiftTrace <noreply@lifttrace.app>';
  const recipient = to || cfg.smtp_from || cfg.smtp_user;
  if (!recipient) throw new Error('No recipient. Fill in a From address (or make sure your account has an email set).');
  const transport = createTransport(overrides);
  const body = _testEmailBody(recipientName);
  await transport.sendMail({
    from,
    to: recipient,
    subject: 'LiftTrace SMTP Test',
    html: emailWrapper(origin || '', body, null),
    text: `Hey${recipientName ? ' ' + recipientName : ''},\n\nThis is a test email from your LiftTrace instance. If you're reading this, your SMTP settings work end-to-end. Password resets, invites, and other transactional emails will be delivered through this config.\n\nSafe to delete this email.`,
  });
  return { to: recipient };
}

// Branded body for the SMTP test email. Same wrapper + helpers as
// sendInvite / sendPasswordReset so the test proves the full email
// pipeline (including images + styling), not just plaintext.
function _testEmailBody(name) {
  return `${greeting(name)}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#FFFFFF;">SMTP test successful</p>
    <p style="margin:0 0 16px;font-size:15px;color:#8A93A8;line-height:1.7;">
      This is a test email from your <strong style="color:#FFFFFF;">LiftTrace</strong> instance. If you're reading this,
      your SMTP settings work end-to-end.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#8A93A8;line-height:1.7;">
      Password resets, user invites, and other transactional emails will be delivered through this SMTP config.
    </p>
    <p style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      Safe to delete this email.
    </p>`;
}
export function isEmailConfigured() { return !!getSmtpConfig().smtp_host; }

function emailWrapper(origin, bodyHtml, footerNote) {
  const year = new Date().getFullYear();
  const logoUrl = origin ? `${origin}/icons/icon-192.png` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#0A0B0F;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#0A0B0F;">
  <tr><td align="center" style="padding:48px 16px 40px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="520" style="max-width:520px;width:100%;">
      <tr><td align="center" style="background-color:#0D1610;padding:36px 40px 30px;border-radius:16px 16px 0 0;border:1px solid #2A1A0A;border-bottom:none;">
        ${logoUrl ? `<img src="${logoUrl}" alt="LiftTrace" width="60" height="60" style="width:60px;height:60px;border-radius:14px;margin:0 auto 18px;display:block;" />` : `<div style="width:60px;height:60px;border-radius:14px;background:rgba(255,116,51,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:32px;color:#FF7433;">&#x1F4AA;</div>`}
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;color:#FFFFFF;letter-spacing:-0.4px;">LiftTrace</div>
        <div style="font-family:-apple-system,sans-serif;font-size:11px;font-weight:600;color:#FF7433;letter-spacing:0.22em;text-transform:uppercase;margin-top:8px;">Trace Every Rep</div>
      </td></tr>
      <tr><td style="background:linear-gradient(90deg,#0D1610,#FF7433 40%,#FF7433 60%,#0D1610);height:2px;border-left:1px solid #2A1A0A;border-right:1px solid #2A1A0A;"></td></tr>
      <tr><td style="background-color:#111318;padding:36px 40px;border-left:1px solid #1E2330;border-right:1px solid #1E2330;font-family:-apple-system,sans-serif;">${bodyHtml}</td></tr>
      <tr><td style="background-color:#0D0F14;padding:22px 40px 28px;border-radius:0 0 16px 16px;border:1px solid #1A1F2E;border-top:1px solid #252D3D;">
        ${footerNote ? `<p style="margin:0 0 10px;font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">${footerNote}</p>` : ''}
        <p style="margin:0;font-size:11px;color:#323850;text-align:center;">&copy; ${year} LiftTrace &middot; Self-hosted &middot; Your data, your rules</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function ctaButton(href, label) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;"><tr><td align="center" style="border-radius:10px;background-color:#FF7433;"><a href="${href}" style="display:inline-block;padding:14px 36px;font-family:-apple-system,sans-serif;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${label}</a></td></tr></table>`;
}

function greeting(name) {
  if (!name) return '';
  return `<p style="margin:0 0 14px;font-size:15px;color:#8A93A8;">Hey <strong style="color:#FFFFFF">${name}</strong>,</p>`;
}

function fallbackUrl(url) {
  return `<p style="margin:20px 0 0;font-size:12px;color:#4A5268;text-align:center;word-break:break-all;">If the button above doesn't work, copy and paste this URL:<br/><a href="${url}" style="color:#FF7433;text-decoration:none;">${url}</a></p>`;
}

export async function sendPasswordReset(email, resetUrl) {
  const origin = new URL(resetUrl).origin;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const name = user?.nickname || user?.full_name || null;
  const body = `${greeting(name)}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#FFFFFF;">Password reset requested</p>
    <p style="margin:0 0 28px;font-size:15px;color:#8A93A8;line-height:1.7;">Click the button below to choose a new password for your LiftTrace account. If you didn't request this, you can safely ignore this email.</p>
    ${ctaButton(resetUrl, 'Reset My Password')}
    <p style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;">This link expires in <strong style="color:#8A93A8;">1 hour</strong>.</p>
    ${fallbackUrl(resetUrl)}`;
  await sendMail({
    to: email,
    subject: 'Reset your LiftTrace password',
    html: emailWrapper(origin, body, 'You received this because a password reset was requested for your account.'),
    text: `Reset your LiftTrace password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

export async function sendInvite(email, inviteUrl, inviterName) {
  const origin = new URL(inviteUrl).origin;
  const body = `<p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#FFFFFF;">You're invited!</p>
    <p style="margin:0 0 12px;font-size:15px;color:#8A93A8;line-height:1.7;">${inviterName ? `<strong style="color:#FFFFFF;">${inviterName}</strong> has invited you to join` : "You've been invited to join"} <strong style="color:#FFFFFF;">LiftTrace</strong> — a self-hosted weightlifting tracker built for privacy.</p>
    <p style="margin:0 0 28px;font-size:14px;color:#6B7590;line-height:1.6;">Track every rep, set, and PR. Build programs. Get AI coaching. Your data stays on your server.</p>
    ${ctaButton(inviteUrl, 'Accept Invitation')}
    <p style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;">This invitation expires in <strong style="color:#8A93A8;">7 days</strong>.</p>
    ${fallbackUrl(inviteUrl)}`;
  await sendMail({
    to: email,
    subject: "You've been invited to LiftTrace",
    html: emailWrapper(origin, body, null),
    text: `${inviterName || 'Someone'} invited you to LiftTrace — a self-hosted weightlifting tracker.\n\nAccept your invitation: ${inviteUrl}\n\nThis link expires in 7 days.`,
  });
}

function _statRow(icon, label, value) {
  return `<tr>
    <td style="padding:10px 16px;font-size:14px;color:#8A93A8;border-bottom:1px solid #1E2330;">
      <span style="margin-right:8px">${icon}</span>${label}
    </td>
    <td style="padding:10px 16px;font-size:16px;font-weight:700;color:#FFFFFF;text-align:right;border-bottom:1px solid #1E2330;">${value}</td>
  </tr>`;
}

// ── Coach Feedback Notification ────────────────────────────────────────────
// Fired when a trainer posts a NEW feedback note on a trainee's workout via
// POST /api/trainer/feedback. Best-effort and non-blocking; sending failure
// never breaks the feedback insert. Skip conditions live at the call site
// (no email address, self-feedback, opt-out, SMTP unconfigured).
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export async function sendCoachFeedback(email, workoutName, coachName, feedbackText, viewUrl) {
  if (!email) return;
  const origin      = new URL(viewUrl).origin;
  const safeCoach   = _escapeHtml(coachName || 'Your coach');
  const safeWorkout = _escapeHtml(workoutName || 'your workout');
  const raw         = String(feedbackText || '').trim();
  const max         = 120;
  const trimmed     = raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
  const safePreview = _escapeHtml(trimmed);
  const body = `
    ${greeting(null)}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      ${safeCoach} left feedback on your workout
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#8A93A8;line-height:1.7;">
      New note on <strong style="color:#FFFFFF;">${safeWorkout}</strong>.
    </p>
    ${safePreview ? `<blockquote style="margin:0 0 24px;padding:14px 18px;background-color:#0D0F14;border-left:3px solid #FF7433;border-radius:6px;font-size:14px;color:#C8CDD9;line-height:1.6;font-style:italic;">${safePreview}</blockquote>` : ''}
    ${ctaButton(viewUrl, 'View Workout')}
    ${fallbackUrl(viewUrl)}`;
  await sendMail({
    to: email,
    subject: `${coachName || 'Your coach'} left feedback on your workout`,
    html: emailWrapper(origin, body, 'You received this because coach-feedback notifications are enabled in your settings.'),
    text: `${coachName || 'Your coach'} left feedback on ${workoutName || 'your workout'}.\n\n${raw ? `"${raw}"\n\n` : ''}Open it: ${viewUrl}`,
  });
}

/**
 * Weekly summary (issue #98). `summary` comes from buildWeeklySummary in
 * lib/weekly-summary.js. Charts are plain table bars: mail clients drop
 * inline SVG and hold back remote images, but a coloured cell with a width
 * renders everywhere.
 */
export async function sendWeeklySummary(email, name, summary, origin = '', opts = {}) {
  await sendMail({ to: email, ...renderWeeklySummary(name, summary, origin, opts) });
}

/** Subject, HTML and text for the weekly summary, without sending it. */
export function renderWeeklySummary(name, summary, origin = '', { unit = 'lbs', locale = 'en' } = {}) {
  const nf = new Intl.NumberFormat(locale);
  const { week, goal, prs, muscles } = summary;
  const range = _fmtRange(summary.start, summary.end, locale);
  const statsUrl = `${origin}/#/statistics?range=1W`;

  const cmp = (cur, avg) => {
    if (!summary.hasBaseline) return '';
    const pct = changeVsAvg(cur, avg);
    if (pct == null) return '';
    const colour = pct > 0 ? '#4FFFB0' : pct < 0 ? '#FF8A5C' : '#8A93A8';
    const text = pct === 0 ? 'same as 4-week avg' : `${pct > 0 ? '+' : ''}${pct}% vs 4-week avg`;
    return `<div style="font-size:12px;font-weight:500;color:${colour};margin-top:2px;">${text}</div>`;
  };

  let bodyMain;
  if (!week.sessions) {
    bodyMain = `<p style="margin:0 0 24px;font-size:15px;color:#8A93A8;line-height:1.7;">No workouts logged this week${goal ? ` (your goal is ${goal})` : ''}. A fresh week starts now.</p>`;
  } else {
    const planned = goal
      ? `${week.sessions} of ${goal} planned ${goal === 1 ? 'session' : 'sessions'}${week.sessions >= goal ? ', goal met' : ''}`
      : `${week.sessions} ${week.sessions === 1 ? 'session' : 'sessions'}`;
    const rows = [
      _statRow('🗓️', 'Sessions', `${planned}${cmp(week.sessions, summary.avg.sessions)}`),
      _statRow('✅', 'Working Sets', `${nf.format(week.sets)}${cmp(week.sets, summary.avg.sets)}`),
    ];
    if (week.volume > 0) rows.push(_statRow('🏋️', 'Volume', `${nf.format(week.volume)} ${_escapeHtml(unit)}${cmp(week.volume, summary.avg.volume)}`));
    if (week.minutes > 0) rows.push(_statRow('⏱️', 'Time Trained', `${fmtMinutes(week.minutes)}${cmp(week.minutes, summary.avg.minutes)}`));
    rows.push(_statRow('🔥', 'Personal Records', nf.format(prs.length)));

    const prList = prs.length
      ? `<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#FFFFFF;letter-spacing:0.02em;">New Personal Records</p>
         <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:24px;">
         ${prs.slice(0, 8).map(p => `<tr><td style="padding:6px 0;font-size:14px;color:#C8CDD9;">${_escapeHtml(p.name || '')}</td><td style="padding:6px 0;font-size:14px;font-weight:700;color:#FF7433;text-align:right;">${p.durationSec ? `${fmtHold(p.durationSec)} hold${p.weight > 0 ? ` @ ${nf.format(p.weight)} ${_escapeHtml(unit)}` : ''}` : `${nf.format(p.weight)} ${_escapeHtml(unit)} x ${p.reps}`}</td></tr>`).join('')}
         ${prs.length > 8 ? `<tr><td colspan="2" style="padding:6px 0;font-size:13px;color:#6B7590;">and ${prs.length - 8} more</td></tr>` : ''}
         </table>`
      : '';

    const maxSets = muscles.length ? muscles[0].sets : 0;
    const muscleBars = muscles.length
      ? `<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#FFFFFF;letter-spacing:0.02em;">Sets by Muscle Group</p>
         <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:28px;">
         ${muscles.slice(0, 10).map(m => {
           const pct = Math.max(4, Math.round((m.sets / maxSets) * 100));
           return `<tr>
             <td width="96" style="padding:4px 8px 4px 0;font-size:13px;color:#8A93A8;white-space:nowrap;">${_escapeHtml(_titleCase(m.muscle))}</td>
             <td style="padding:4px 0;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="${pct}%"><tr><td height="10" style="height:10px;line-height:10px;font-size:0;background-color:#FF7433;border-radius:5px;">&nbsp;</td></tr></table></td>
             <td width="36" style="padding:4px 0 4px 8px;font-size:13px;font-weight:700;color:#FFFFFF;text-align:right;">${nf.format(m.sets)}</td>
           </tr>`;
         }).join('')}
         </table>`
      : '';

    bodyMain = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:24px;">${rows.join('')}</table>${prList}${muscleBars}`;
  }

  const body = `${greeting(_escapeHtml(name || ''))}
    <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#FFFFFF;">Your Week in Review</p>
    <p style="margin:0 0 24px;font-size:13px;color:#6B7590;">${_escapeHtml(range)}</p>
    ${bodyMain}
    ${ctaButton(statsUrl, 'View This Week')}
    ${fallbackUrl(statsUrl)}`;

  return {
    subject: 'LiftTrace: your week in review',
    html: emailWrapper(origin, body, 'You received this because weekly summaries are enabled in your settings.'),
    text: `Your week (${range}): ${summaryLine(summary, { unit, locale })}\n\nView this week: ${statsUrl}`,
  };
}

function _fmtRange(start, end, locale) {
  try {
    const f = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${f.format(new Date(`${start}T00:00:00Z`))} to ${f.format(new Date(`${end}T00:00:00Z`))}`;
  } catch { return `${start} to ${end}`; }
}

function _titleCase(s) { return String(s).replace(/\b\w/g, c => c.toUpperCase()); }
