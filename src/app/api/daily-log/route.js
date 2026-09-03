/**
 * Daily Activity Log API
 *
 * Returns email activity grouped by (UTC) day:
 * - Emails sent (every touch — day 0, day 3, day 7 — with account breakdown)
 * - Opens tracked
 * - Replies received
 * - Bounces detected
 *
 * Sends are built from the lead records themselves (sent_at / d3_sent_at /
 * d7_sent_at, whatever the lead's status is now), so a lead that later
 * replied, completed its sequence or bounced still shows on the day it was
 * emailed. The capped `sent_log` list only enriches those rows (subject,
 * sending inbox) and contributes rows for outreach-tagged sends whose lead has
 * since been archived. Warm-up traffic is never counted: a log entry counts
 * only when it is tagged with an outreach source or addressed to a lead.
 */

import { kv } from '@vercel/kv';
import { getAllLeads } from '@/lib/leads-db';
import { campaignOf, getTodayKey, mergeOpens, normalizeEmail } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const TOUCHES = [['d0', 'sent_at'], ['d3', 'd3_sent_at'], ['d7', 'd7_sent_at']];

function dayOf(ts) {
  const s = String(ts || '');
  return DAY_RE.test(s) ? s.slice(0, 10) : null;
}

function etDayOf(ts) {
  try {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : getTodayKey(d);
  } catch {
    return null;
  }
}

function isOutreachSource(src) {
  const s = String(src || '').toLowerCase();
  return s.startsWith('auto-send') || s.startsWith('follow-up');
}

function touchOfLogEntry(entry) {
  const t = String(entry.touch || '').toLowerCase();
  if (/^d(0|3|7)$/.test(t)) return t;
  const src = String(entry.source || '').toLowerCase();
  const m = /follow-up-d(\d+)/.exec(src);
  if (m) return `d${m[1]}`;
  const day = Number(entry.sequenceDay);
  if (Number.isFinite(day) && day > 0) return `d${day}`;
  return 'd0';
}

function mode(values, fallback) {
  const counts = new Map();
  let best = fallback;
  let bestN = 0;
  for (const v of values) {
    if (!v) continue;
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

export async function GET() {
  try {
    // Fetch all data sources in parallel. The log and event lists are read in
    // two pages each so one oversized reply can't sink the whole response.
    const [allLeads, sentLogA, sentLogB, emailOpens, replies, bounces, eventsA, eventsB] = await Promise.all([
      getAllLeads(),
      kv.lrange('sent_log', 0, 499).catch(() => []),
      kv.lrange('sent_log', 500, 999).catch(() => []),
      kv.hgetall('email_opens').catch(() => ({})),
      kv.hgetall('replies_v3').catch(() => ({})),
      kv.hgetall('bounces').catch(() => ({})),
      kv.lrange('open_events', 0, 1499).catch(() => []),
      kv.lrange('open_events', 1500, 2999).catch(() => []),
    ]);

    const sentLog = [...(sentLogA || []), ...(sentLogB || [])].filter((e) => e && typeof e === 'object');
    const openEvents = [...(eventsA || []), ...(eventsB || [])].filter((e) => e && typeof e === 'object');
    const opensMap = emailOpens && typeof emailOpens === 'object' ? emailOpens : {};
    const opensArr = Object.values(opensMap).filter((o) => o && typeof o === 'object');
    const repliesArr = Object.values(replies || {}).filter((r) => r && typeof r === 'object');
    const bouncesArr = Object.values(bounces || {}).filter((b) => b && typeof b === 'object');

    const leadByEmail = new Map();
    for (const l of allLeads) {
      const e = normalizeEmail(l.email);
      if (e) leadByEmail.set(e, l);
    }

    // sent_log entries keyed by recipient + touch, used to enrich lead-derived rows.
    const logByKey = new Map();
    for (const entry of sentLog) {
      const to = normalizeEmail(entry.to);
      if (!to) continue;
      const key = `${to}|${touchOfLogEntry(entry)}`;
      if (!logByKey.has(key)) logByKey.set(key, entry);
    }

    const dayMap = {};
    function ensureDay(day) {
      if (!dayMap[day]) {
        dayMap[day] = {
          date: day,
          date_et: day,
          sent: [],
          opens: [],
          replies: [],
          bounces: [],
          accountBreakdown: {},
          byCampaign: { 'free-leads': 0, 'offer': 0 },
          byTouch: { d0: 0, d3: 0, d7: 0 },
          _etDays: [],
        };
      }
      return dayMap[day];
    }

    function pushSend(day, row) {
      const dayEntry = ensureDay(day);
      dayEntry.sent.push(row);
      const accKey = row.from || 'unknown';
      dayEntry.accountBreakdown[accKey] = (dayEntry.accountBreakdown[accKey] || 0) + 1;
      dayEntry.byCampaign[row.campaign] = (dayEntry.byCampaign[row.campaign] || 0) + 1;
      dayEntry.byTouch[row.touch] = (dayEntry.byTouch[row.touch] || 0) + 1;
      const et = etDayOf(row.timestamp);
      if (et) dayEntry._etDays.push(et);
    }

    // ── Sends: one row per touch, from the lead records ──
    const sentKeys = new Set(); // `${email}|${touch}` already placed
    for (const lead of allLeads) {
      const email = normalizeEmail(lead.email);
      if (!email) continue;
      const campaign = campaignOf(lead);
      for (const [touch, field] of TOUCHES) {
        const ts = lead[field];
        const day = dayOf(ts);
        if (!day) continue;
        const key = `${email}|${touch}`;
        sentKeys.add(key);
        const log = logByKey.get(key) || null;
        pushSend(day, {
          to: email,
          from: (log && log.from) || lead.account_used || 'unknown',
          company: lead.company || lead.company_name || (log && log.company) || '',
          industry: lead.industry || (log && log.industry) || '',
          subject: (log && log.subject) || (touch === 'd0' ? lead.original_subject || '' : ''),
          status: 'sent',
          followUp: touch !== 'd0',
          timestamp: ts,
          touch,
          campaign,
        });
      }
    }

    // Outreach-tagged log entries whose lead is no longer in the hash (archived
    // since) still count; anything untagged and not addressed to a lead is
    // warm-up traffic and is dropped.
    for (const entry of sentLog) {
      if (String(entry.status || 'sent') !== 'sent') continue;
      const to = normalizeEmail(entry.to);
      if (!to) continue;
      if (!isOutreachSource(entry.source) && !leadByEmail.has(to)) continue;
      const touch = touchOfLogEntry(entry);
      const key = `${to}|${touch}`;
      if (sentKeys.has(key)) continue;
      const ts = entry.timestamp || entry.sentAt || entry.createdAt;
      const day = dayOf(ts);
      if (!day) continue;
      sentKeys.add(key);
      const lead = leadByEmail.get(to) || null;
      pushSend(day, {
        to,
        from: entry.from || (lead && lead.account_used) || 'unknown',
        company: entry.company || (lead && (lead.company || lead.company_name)) || '',
        industry: entry.industry || (lead && lead.industry) || '',
        subject: entry.subject || '',
        status: entry.status || 'sent',
        followUp: touch !== 'd0',
        timestamp: ts,
        touch,
        campaign: String(entry.campaign || '').toLowerCase() === 'free-leads' ? 'free-leads' : (lead ? campaignOf(lead) : 'offer'),
      });
    }

    // ── Opens: one row per lead on the day it was first opened ──
    for (const open of opensArr) {
      const email = normalizeEmail(open.email);
      const lead = leadByEmail.get(email) || { email };
      const merged = mergeOpens(lead, { [email]: open });
      const ts = merged.opened_at || open.firstHumanAt || null;
      const day = dayOf(ts);
      if (!day) continue;
      ensureDay(day).opens.push({
        email,
        count: Number(open.count) || 1,
        humanCount: Number(merged.human_open_count) || 0,
        openedAt: ts,
        lastOpenedAt: open.lastAt || open.lastOpenedAt || ts,
        lastClass: open.lastClass || null,
        touch: open.firstTouch || null,
      });
    }

    // Per-day open events (every hit; humans for uniqueOpens).
    const eventTotals = {};
    const eventHumans = {};
    for (const ev of openEvents) {
      const day = dayOf(ev.at);
      if (!day) continue;
      ensureDay(day);
      eventTotals[day] = (eventTotals[day] || 0) + 1;
      if (ev.human) (eventHumans[day] = eventHumans[day] || new Set()).add(normalizeEmail(ev.email));
    }

    // ── Replies ──
    const replyKeys = new Set(); // `${leadEmail}|${day}`
    for (const reply of repliesArr) {
      const ts = reply.date || reply.receivedAt || reply.repliedAt || reply.timestamp;
      const day = dayOf(ts);
      if (!day) continue;
      const leadEmail = normalizeEmail(reply.leadEmail || reply.from);
      replyKeys.add(`${leadEmail}|${day}`);
      ensureDay(day).replies.push({
        from: reply.from || leadEmail,
        leadEmail,
        company: reply.company || '',
        industry: reply.industry || '',
        subject: reply.subject || '',
        snippet: reply.preview || reply.snippet || '',
        repliedAt: ts,
        account: reply.account || null,
        folder: reply.folder || null,
        campaign: reply.campaign || null,
        touch: reply.touch || null,
        kind: reply.kind || 'human',
      });
    }
    for (const lead of allLeads) {
      if (!lead.replied_at) continue;
      if (lead.reply_kind && lead.reply_kind !== 'human') continue;
      const day = dayOf(lead.replied_at);
      if (!day) continue;
      const email = normalizeEmail(lead.email);
      if (replyKeys.has(`${email}|${day}`)) continue;
      replyKeys.add(`${email}|${day}`);
      ensureDay(day).replies.push({
        from: email,
        leadEmail: email,
        company: lead.company || lead.company_name || '',
        industry: lead.industry || '',
        subject: lead.reply_subject || '',
        snippet: lead.reply_preview || '',
        repliedAt: lead.replied_at,
        account: lead.reply_account || null,
        folder: lead.reply_folder || null,
        campaign: campaignOf(lead),
        touch: lead.reply_touch || null,
        kind: lead.reply_kind || 'human',
      });
    }

    // ── Bounces ──
    const bounceKeys = new Set(); // `${email}|${day}`
    for (const bounce of bouncesArr) {
      const ts = bounce.bouncedAt || bounce.bounced_at;
      const day = dayOf(ts);
      if (!day) continue;
      const email = normalizeEmail(bounce.email);
      bounceKeys.add(`${email}|${day}`);
      ensureDay(day).bounces.push({
        email,
        reason: bounce.reason || 'Unknown',
        account: bounce.account || null,
        bouncedAt: ts,
      });
    }
    for (const lead of allLeads) {
      if (lead.status !== 'bounced' || !lead.bounced_at) continue;
      const day = dayOf(lead.bounced_at);
      if (!day) continue;
      const email = normalizeEmail(lead.email);
      if (bounceKeys.has(`${email}|${day}`)) continue;
      bounceKeys.add(`${email}|${day}`);
      ensureDay(day).bounces.push({
        email,
        reason: lead.bounce_reason || 'Unknown',
        account: lead.bounce_account || lead.bounce_inbox || null,
        bouncedAt: lead.bounced_at,
      });
    }

    // Convert to sorted array (newest first)
    const days = Object.values(dayMap)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((day) => {
        const { _etDays, ...rest } = day;
        const hasEvents = Object.prototype.hasOwnProperty.call(eventTotals, day.date);
        const totalOpens = hasEvents ? eventTotals[day.date] : day.opens.reduce((n, o) => n + (Number(o.count) || 1), 0);
        const uniqueOpens = hasEvents ? (eventHumans[day.date] ? eventHumans[day.date].size : 0) : day.opens.length;
        return {
          ...rest,
          date_et: mode(_etDays, day.date),
          summary: {
            totalSent: day.sent.length,
            newSends: day.sent.filter((s) => !s.followUp).length,
            followUps: day.sent.filter((s) => s.followUp).length,
            totalOpens,
            totalReplies: day.replies.length,
            totalBounces: day.bounces.length,
            uniqueOpens,
            accountsUsed: Object.keys(day.accountBreakdown).length,
          },
        };
      });

    return Response.json({
      success: true,
      totalDays: days.length,
      days,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
