/**
 * Owner notifications — the "did it actually run today?" safety net.
 *
 * Two emails, both sent by the heartbeat itself (no cron, no external
 * service, no AI), each at most once per ET day, guarded by a SET NX key:
 *
 *  1. SWITCH-OFF ALARM — on a weekday, from 10 AM ET, if no inbox is switched
 *     on: "sending is OFF today". This is exactly what would have caught
 *     2026-09-09, when both switches were off all day and nothing went out.
 *
 *  2. END-OF-DAY REPORT — on a weekday, after the window closes (7 PM ET):
 *     per-inbox sent (fresh / follow-ups / failed), switches, caps, health,
 *     bounces, replies waiting for a human, and what is queued for tomorrow.
 *
 * Recipient: DAILY_REPORT_TO (default: the owner's Gmail). Sender: the first
 * configured SMTP account (the switch only gates prospect sends; owner mail
 * always goes). Marked transactional so it carries no tracking pixel and no
 * List-Unsubscribe header.
 */

import { kv } from '@vercel/kv';
import { sendEmail } from '@/lib/mailer';
import { getAllReplies, getLeadsMap } from '@/lib/leads-db';
import { isJunkConversation } from '@/lib/junk-filter';
import { etParts, isSendable, SEND_CAP } from '@/lib/metrics';
import { SEND_DAYS, SEND_WINDOW_END_HOUR } from '@/lib/warmup';

const DAILY_SEND_KEY = 'daily_sends';
const REPORT_SENT_KEY = 'owner_report_sent';   // hash: `${today}:report` / `${today}:alarm` -> ISO time
const DEFAULT_TO = 'limethsith@gmail.com';
const ALARM_FROM_HOUR = 10;                     // ET hour from which "everything is off" is alarming
const DASHBOARD = 'https://email-distributor.vercel.app';

const lower = (s) => String(s || '').trim().toLowerCase();

function recipient() {
  return (process.env.DAILY_REPORT_TO || DEFAULT_TO).trim();
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Claim the once-per-day slot; false if already sent (or KV unavailable). */
async function claimOnce(today, kind) {
  try {
    const field = `${today}:${kind}`;
    const added = await kv.hsetnx(REPORT_SENT_KEY, field, new Date().toISOString());
    return added === 1 || added === true;
  } catch {
    return false;
  }
}

async function deliver(accountsAll, subject, text, html) {
  const account = accountsAll[0];
  if (!account) return { sent: false, error: 'no smtp account' };
  const res = await sendEmail(account, { to: recipient(), subject, text, html, transactional: true, noTrack: true });
  return { sent: Boolean(res.success), error: res.success ? null : res.error, to: recipient() };
}

// ─── 1) Switch-off alarm ─────────────────────────────────────────────────────

/**
 * Call from the heartbeat when it finds no inbox enabled inside the window.
 * Sends once per day, only from ALARM_FROM_HOUR ET, only on send days.
 */
export async function maybeSendSwitchOffAlarm({ accountsAll, today, now = new Date() }) {
  const { weekday, hour } = etParts(now);
  if (!SEND_DAYS.has(weekday) || hour < ALARM_FROM_HOUR) return { sent: false, reason: 'not yet' };
  if (!(await claimOnce(today, 'alarm'))) return { sent: false, reason: 'already sent' };

  const subject = `⚠️ Aviance: sending is OFF today (${today}) — both inboxes switched off`;
  const text = [
    `Nothing is going out today. Every inbox is switched OFF on the Inboxes page.`,
    ``,
    `If that is not what you want, turn them on here: ${DASHBOARD}/inboxes`,
    `The engine will start sending within 10 minutes of the switch, until 7 PM ET.`,
    ``,
    `— Aviance Outreach (automatic notice, sent once per day)`,
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">
<p style="font-size:18px;font-weight:bold;color:#E0290F;margin:0 0 12px;">Sending is OFF today (${esc(today)})</p>
<p>Nothing is going out. Every inbox is switched <b>off</b> on the Inboxes page.</p>
<p>If that is not what you want: <a href="${DASHBOARD}/inboxes">turn them on here</a>. The engine starts within 10 minutes of the switch and runs until 7 PM ET.</p>
<p style="color:#8A8A85;font-size:12px;">Aviance Outreach · automatic notice, sent once per day</p></div>`;
  try {
    return await deliver(accountsAll, subject, text, html);
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ─── 2) End-of-day report ────────────────────────────────────────────────────

function n(v) { return parseInt(v || '0', 10) || 0; }

/** Everything the report needs, in three KV reads + one leads scan. */
async function collect({ accountsAll, cfg, today }) {
  const emails = accountsAll.map((a) => a.email);
  const fields = [];
  for (const e of emails) fields.push(`${e}:${today}`, `${e}:${today}:d0`, `${e}:${today}:d3`, `${e}:${today}:d7`, `${e}:${today}:failed`);
  fields.push(`__total__:${today}`, `__followups__:${today}`, `__failed__:${today}`);

  const [countsRaw, leadsMap, replies, convRaw] = await Promise.all([
    kv.hmget(DAILY_SEND_KEY, ...fields).catch(() => []),
    getLeadsMap().catch(() => ({})),
    getAllReplies().catch(() => []),
    kv.hgetall('conversations').catch(() => ({})),
  ]);
  const counts = {};
  fields.forEach((f, i) => { counts[f] = n((countsRaw || [])[i]); });

  const inboxes = accountsAll.map((a) => {
    const e = a.email;
    const enabledRaw = cfg.enabledMap[e];
    const enabled = enabledRaw === '1' || enabledRaw === 1 || enabledRaw === true;
    const capRaw = cfg.capMap[lower(e)];
    const cap = capRaw === undefined || capRaw === null || capRaw === '' ? SEND_CAP : Math.max(0, Math.min(SEND_CAP, parseInt(capRaw, 10) || 0));
    const h = cfg.health[e] || {};
    return {
      email: e,
      enabled, cap,
      sent: counts[`${e}:${today}`], d0: counts[`${e}:${today}:d0`], d3: counts[`${e}:${today}:d3`], d7: counts[`${e}:${today}:d7`],
      failed: counts[`${e}:${today}:failed`],
      bounces: h.bouncesTodayKey === today ? n(h.bouncesToday) : 0,
      health: h.disabledReason ? `DISABLED — ${h.disabledReason}` : (h.lastError && String(h.lastErrorAt || '') > String(h.lastSuccessAt || '') ? `warning — ${h.lastError}` : 'ok'),
      imap: h.imapLastError && String(h.imapLastErrorAt || '') > String(h.imapLastOkAt || '') ? `reply scan failing — ${h.imapLastError}` : 'ok',
    };
  });

  // Pipeline: what is queued for tomorrow.
  const nowMs = Date.now();
  let freshLeads = 0;
  let dueFollowUps = 0;
  let repliedToday = 0;
  for (const lead of Object.values(leadsMap || {})) {
    if (!lead || !lead.email) continue;
    if (isSendable(lead)) { freshLeads++; continue; }
    const st = lower(lead.status);
    if (lead.sent_at && (st === 'sent-d0' || st === 'sent-d3')) {
      const base = st === 'sent-d0' ? new Date(lead.sent_at).getTime() + 3 * 864e5 : (lead.d3_sent_at ? new Date(lead.d3_sent_at).getTime() : new Date(lead.sent_at).getTime() + 3 * 864e5) + 4 * 864e5;
      if (base <= nowMs + 864e5) dueFollowUps++;
    }
    if (lead.replied_at && String(lead.replied_at).slice(0, 10) === today) repliedToday++;
  }

  // Replies that need a human (all replies are handled by a person now).
  const conversations = Object.values(convRaw && typeof convRaw === 'object' ? convRaw : {}).filter((c) => c && typeof c === 'object' && !isJunkConversation(c));
  const awaiting = conversations.filter((c) => (c.messages || []).some((m) => m && m.dir === 'in'));
  const humanRepliesToday = (replies || []).filter((r) => r && String(r.date || '').slice(0, 10) === today && (String(r.kind || '').toLowerCase() === 'human' || !r.kind)).length;

  return {
    inboxes,
    totals: { sent: counts[`__total__:${today}`], followUps: counts[`__followups__:${today}`], failed: counts[`__failed__:${today}`] },
    pipeline: { freshLeads, dueFollowUps },
    replies: { today: Math.max(humanRepliesToday, repliedToday), awaiting },
  };
}

function renderReport(today, data) {
  const { inboxes, totals, pipeline, replies } = data;
  const anyOn = inboxes.some((i) => i.enabled);
  const problems = [];
  if (!anyOn) problems.push('Every inbox was switched OFF — nothing was sent.');
  for (const i of inboxes) {
    if (i.enabled && i.sent === 0) problems.push(`${i.email} was ON but sent 0 — check its health line below.`);
    if (i.health !== 'ok') problems.push(`${i.email}: ${i.health}`);
    if (i.imap !== 'ok') problems.push(`${i.email}: ${i.imap}`);
    if (i.sent && i.bounces / i.sent > 0.05) problems.push(`${i.email}: ${i.bounces} bounces on ${i.sent} sent (${Math.round((i.bounces / i.sent) * 100)}%) — above the 5% line.`);
  }
  if (replies.awaiting.length) problems.push(`${replies.awaiting.length} reply(ies) waiting for you to answer.`);
  if (pipeline.freshLeads < 40) problems.push(`Only ${pipeline.freshLeads} fresh leads left in the queue — import more soon.`);

  const headline = totals.sent === 0
    ? `0 emails sent today`
    : `${totals.sent} emails sent today (${totals.sent - totals.followUps} fresh, ${totals.followUps} follow-ups)`;
  const subject = `${problems.length ? '⚠️' : '✅'} Aviance ${today}: ${headline}${replies.today ? ` · ${replies.today} reply` : ''}`;

  const lines = [];
  lines.push(`AVIANCE OUTREACH — DAILY REPORT ${today}`);
  lines.push(headline + (totals.failed ? ` · ${totals.failed} failed` : ''));
  lines.push('');
  if (problems.length) { lines.push('NEEDS YOUR ATTENTION'); for (const p of problems) lines.push(`  - ${p}`); lines.push(''); }
  lines.push('INBOXES');
  for (const i of inboxes) {
    lines.push(`  ${i.email} — ${i.enabled ? 'ON' : 'OFF'} · ${i.sent}/${i.cap} sent (fresh ${i.d0}, day-3 ${i.d3}, day-7 ${i.d7})${i.failed ? ` · ${i.failed} failed` : ''}${i.bounces ? ` · ${i.bounces} bounced` : ''} · health ${i.health}`);
  }
  lines.push('');
  lines.push('REPLIES');
  lines.push(`  ${replies.today} reply(ies) today · ${replies.awaiting.length} waiting for you`);
  lines.push('');
  lines.push('QUEUED FOR TOMORROW');
  lines.push(`  ${pipeline.dueFollowUps} follow-ups due · ${pipeline.freshLeads} fresh leads`);
  lines.push('');
  lines.push(`Dashboard: ${DASHBOARD}   Inboxes: ${DASHBOARD}/inboxes   Replies: ${DASHBOARD}/replies`);
  lines.push('— Aviance Outreach (automatic report, sent once per day after 7 PM ET)');
  const text = lines.join('\n');

  const row = (i) => `<tr>
<td style="padding:8px 10px;border-bottom:1px solid #eee;"><b>${esc(i.email)}</b></td>
<td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:${i.enabled ? '#1a7f37' : '#E0290F'};font-weight:bold;">${i.enabled ? 'ON' : 'OFF'}</td>
<td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;"><b>${i.sent}</b> / ${i.cap}<br><span style="color:#8A8A85;font-size:12px;">fresh ${i.d0} · d3 ${i.d3} · d7 ${i.d7}</span></td>
<td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;">${i.failed}${i.bounces ? ` <span style="color:#E0290F;">(${i.bounces} bounced)</span>` : ''}</td>
<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:${i.health === 'ok' && i.imap === 'ok' ? '#1a7f37' : '#E0290F'};">${esc(i.health === 'ok' ? (i.imap === 'ok' ? 'Healthy' : i.imap) : i.health)}</td>
</tr>`;

  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:680px;">
<p style="margin:0;color:#8A8A85;font-size:12px;letter-spacing:2px;">AVIANCE OUTREACH · DAILY REPORT · ${esc(today)}</p>
<p style="font-size:22px;font-weight:bold;margin:6px 0 16px;">${esc(headline)}${totals.failed ? ` <span style="color:#E0290F;font-size:15px;">· ${totals.failed} failed</span>` : ''}</p>
${problems.length ? `<div style="background:#FFF3F1;border-left:4px solid #E0290F;padding:10px 14px;margin:0 0 18px;"><b>Needs your attention</b><ul style="margin:6px 0 0;padding-left:18px;">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : `<div style="background:#F1F8F4;border-left:4px solid #1a7f37;padding:10px 14px;margin:0 0 18px;">Nothing needs your attention.</div>`}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
<thead><tr style="background:#141414;color:#fff;font-size:11px;letter-spacing:1px;"><th style="padding:8px 10px;text-align:left;">INBOX</th><th style="padding:8px 10px;">SWITCH</th><th style="padding:8px 10px;">SENT / CAP</th><th style="padding:8px 10px;">FAILED</th><th style="padding:8px 10px;text-align:left;">HEALTH</th></tr></thead>
<tbody>${inboxes.map(row).join('')}</tbody></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;font-size:14px;">
<tr><td style="padding:6px 0;width:50%;vertical-align:top;"><b>Replies</b><br>${replies.today} reply(ies) today<br>${replies.awaiting.length} waiting for you</td>
<td style="padding:6px 0;vertical-align:top;"><b>Queued for tomorrow</b><br>${pipeline.dueFollowUps} follow-ups due<br>${pipeline.freshLeads} fresh leads</td></tr></table>
<p style="margin-top:18px;"><a href="${DASHBOARD}">Dashboard</a> · <a href="${DASHBOARD}/inboxes">Inboxes</a> · <a href="${DASHBOARD}/replies">Replies</a></p>
<p style="color:#8A8A85;font-size:12px;">Automatic report, sent once per day after 7 PM ET.</p></div>`;

  return { subject, text, html };
}

/**
 * Call from the heartbeat's outside-the-window path. Sends once per send day,
 * only after the window has closed (so the numbers are final), and only in
 * the two hours after close so the off-hours heartbeat stays cheap the rest
 * of the night (one HSETNX at most, and only in that slot).
 */
export async function maybeSendDailyReport({ accountsAll, cfg, today, now = new Date() }) {
  const { weekday, hour } = etParts(now);
  if (!SEND_DAYS.has(weekday)) return { sent: false, reason: 'weekend' };
  if (hour < SEND_WINDOW_END_HOUR || hour >= SEND_WINDOW_END_HOUR + 3) return { sent: false, reason: 'outside report slot' };
  if (!(await claimOnce(today, 'report'))) return { sent: false, reason: 'already sent' };
  try {
    const data = await collect({ accountsAll, cfg, today });
    const { subject, text, html } = renderReport(today, data);
    return await deliver(accountsAll, subject, text, html);
  } catch (err) {
    return { sent: false, error: err.message };
  }
}
