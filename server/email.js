import nodemailer from 'nodemailer';
import db from './db.js';

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

function createTransport() {
  const cfg = getSmtpConfig();
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

export async function testSmtp() { const transport = createTransport(); await transport.verify(); }
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

export async function sendWeeklySummary(email, name, stats, origin = '') {
  const { workoutCount = 0, totalVolume = 0 } = stats;
  const body = `${greeting(name)}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#FFFFFF;">Your Week in Review</p>
    <p style="margin:0 0 24px;font-size:15px;color:#8A93A8;line-height:1.7;">Here's a summary of your training this past week.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom:24px;">
      ${_statRow('🏋️', 'Workouts', workoutCount)}
      ${_statRow('📊', 'Total Volume', `${Math.round(totalVolume).toLocaleString()}`)}
    </table>
    <p style="margin:0;font-size:14px;color:#6B7590;text-align:center;line-height:1.6;">Keep pushing — consistency is everything.</p>`;
  await sendMail({
    to: email,
    subject: `LiftTrace — Your weekly summary`,
    html: emailWrapper(origin, body, 'You received this because weekly summaries are enabled in your settings.'),
    text: `Your week: ${workoutCount} workouts, ${Math.round(totalVolume).toLocaleString()} volume lifted. Keep pushing!`,
  });
}
