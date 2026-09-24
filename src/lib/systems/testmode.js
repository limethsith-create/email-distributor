/**
 * Test Mode (SPEC §10.7). The client `_test` runs on a scaled clock
 * (TESTMODE.clockScale, default 24: one real hour = one trial day) with the
 * owner's own addresses and the warm-up helper accounts as its leads, so a
 * whole trial runs through the real systems in an afternoon.
 *
 * The simulate buttons write exactly the records the real systems write
 * (replies hash, bookings hash, lead status, counters) — they never call a
 * shortcut in Stage D, so the reports and the decision see what they would
 * see in production.
 *
 * Simulated replies do NOT add addresses to suppression:global (the leads are
 * the owner's own inboxes; suppressing them would break every other client).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { createClient, getClient, getTrial, updateClient, setState } from '@/lib/db/client';
import { bump, initCounters } from '@/lib/db/counters';
import { insertLeads, getLeads, patchLead } from '@/lib/db/leads';
import { logEvent } from '@/lib/db/events';
import { ownerEmail } from '@/lib/notify';
import { addDays, dayKeyIn, ET, trialDay } from '@/lib/time';
import { clientNow, offsetFor, instantForTrialDay } from '@/lib/testclock';
import { purgeClient } from '@/lib/systems/wrapup';
import { getBookings } from '@/lib/systems/dshared';

export const TEST_ID = '_test';

export const REPLY_KINDS = ['interested', 'question', 'notnow', 'no', 'ooo', 'wrongperson', 'angry', 'legal', 'unclear', 'bounce'];
const SAMPLE = {
  interested: 'Sounds interesting — tell me more. What does it cost?',
  question: 'How does the list get built?',
  notnow: 'Not right now, maybe next quarter.',
  no: 'No thanks.',
  ooo: 'I am out of the office until Monday.',
  wrongperson: 'Not the right person — reach out to Dana.',
  angry: 'Stop emailing me.',
  legal: 'This is harassment, I will report you to the FTC.',
  unclear: 'Hmm.',
  bounce: 'Delivery Status Notification (Failure)',
};

async function helperEmails() {
  let pool = [];
  try { pool = (await kv.smembers(K.warmupPool())) || []; } catch {}
  const out = [];
  for (const m of pool) {
    const email = String(m).split(':').pop();
    if (!email.includes('@')) continue;
    try { if (await kv.exists(K.warmupHelper(email))) out.push(email); } catch {}
  }
  return out;
}

async function seedLeads(now) {
  const owner = ownerEmail();
  const [user, domain] = owner.split('@');
  const emails = [...new Set([...(await helperEmails()), owner, `${user}+t1@${domain}`, `${user}+t2@${domain}`, `${user}+t3@${domain}`])];
  const leads = emails.map((email, i) => ({
    email, first_name: `Tester${i + 1}`, name: `Tester ${i + 1}`, title: 'Owner', company: `Test Company ${i + 1}`,
    website: `https://test${i + 1}.invalid`, host: `test${i + 1}.invalid`, city: ['Dallas', 'Austin', 'Denver'][i % 3], state: ['TX', 'TX', 'CO'][i % 3],
    tz: 'America/Chicago', sizeBand: '10-50', source: 'test', score: 1, riskLevel: 'safe', sequenceVariant: i % 2 ? 'B' : 'A', createdAt: now.toISOString(),
  }));
  return insertLeads(TEST_ID, leads);
}

/**
 * Start a test trial. from = 'apply' (Stage A's Gatekeeper takes it from
 * `applied`) or 'sending' (skip intake/build: Day 1 today, for Stage D runs).
 */
export async function startTest({ from = 'apply', now = new Date() } = {}) {
  if (await getClient(TEST_ID)) throw new Error('A test is already running. Reset it first.');
  const scale = await cfg(null, 'TESTMODE.clockScale');
  await createClient(TEST_ID, {
    name: 'Test Mode Co', contactName: 'Tester', contactEmail: ownerEmail(), mainDomain: 'aviance-test.invalid', website: 'https://aviance-test.invalid',
    state: 'applied', clockScale: String(scale), clockOrigin: now.toISOString(), clockOffsetMs: '0',
  });
  await kv.hset(K.profile(TEST_ID), { capacityPerWeek: '5', industry: 'IT services', niche: 'msp', senderName: 'Test Sender', postalAddress: '1 Test St, Dover, DE 19901', calendarUrl: 'https://cal.com/aviance-test' });
  const seeded = await seedLeads(now);
  if (from === 'sending') {
    const c = await getClient(TEST_ID);
    const vnow = clientNow(c, now);
    const today = dayKeyIn(ET, vnow);
    await kv.hset(K.trial(TEST_ID), { signedDay: addDays(today, -14), day1Date: today, day30Date: addDays(today, 29), firstSendAt: vnow.toISOString(), agreementAcceptedAt: addDays(today, -14) });
    await initCounters(TEST_ID);
    await setState(TEST_ID, 'sending', 'Test Mode fast start (intake and build skipped)', { force: true });
  }
  await logEvent(TEST_ID, 'test', 'test_started', { from, scale, leads: seeded.added });
  return { started: true, from, leads: seeded.added };
}

export async function resetTest() {
  const r = await purgeClient(TEST_ID);
  try { await kv.del(K.testSkipPings()); } catch {}
  await logEvent(null, 'test', 'test_reset', r);
  return r;
}

/** Move the scaled clock so it reads 09:05 ET on trial day N. */
export async function jumpToDay(n, now = new Date()) {
  const client = await getClient(TEST_ID);
  if (!client) throw new Error('No test running.');
  const trial = await getTrial(TEST_ID);
  const target = instantForTrialDay(trial, Number(n));
  if (!target) throw new Error('The test trial has no Day 1 or signed date yet.');
  const offset = offsetFor(client, target, now);
  await updateClient(TEST_ID, { clockOffsetMs: String(Math.round(offset)) });
  await logEvent(TEST_ID, 'test', 'clock_jumped', { day: Number(n) });
  return { day: Number(n), virtualNow: target.toISOString() };
}

async function pickLead(prefer = ['in_sequence', 'unsent', 'replied']) {
  const leads = await getLeads(TEST_ID);
  for (const s of prefer) { const l = leads.find((x) => x.status === s); if (l) return l; }
  return leads[0] || null;
}

export async function simulate(kind, now = new Date()) {
  const client = await getClient(TEST_ID);
  if (!client) throw new Error('No test running.');
  const vnow = clientNow(client, now);
  const at = vnow.toISOString();
  const id = `sim-${now.getTime().toString(36)}`;

  if (REPLY_KINDS.includes(kind)) {
    const lead = await pickLead();
    if (!lead) throw new Error('No test leads.');
    const notnowDate = kind === 'notnow' ? addDays(dayKeyIn(ET, vnow), 60) : null;
    await kv.hset(K.replies(TEST_ID), { [id]: { leadEmail: lead.email, inbox: 'test', receivedAt: at, subject: 'Re: 30-day trial', snippet: SAMPLE[kind], kind, handledAt: at, action: 'simulated', notnowDate } });
    const status = { interested: 'replied', question: 'replied', unclear: 'replied', notnow: 'notnow', no: 'suppressed', angry: 'suppressed', legal: 'suppressed', wrongperson: 'suppressed', bounce: 'bounced', ooo: lead.status }[kind];
    await patchLead(TEST_ID, lead.email, { status, replied_at: kind === 'bounce' ? lead.replied_at : at, reply_kind: kind, ...(notnowDate ? { notnowDate } : {}) });
    if (kind === 'bounce') await bump(TEST_ID, 'bounces', 1, vnow);
    else if (kind !== 'ooo') await bump(TEST_ID, 'replies', 1, vnow);
    if (['interested', 'question'].includes(kind)) await bump(TEST_ID, 'positive', 1, vnow);
    await logEvent(TEST_ID, 'test', 'simulated_reply', { kind, lead: lead.email });
    return { kind, lead: lead.email };
  }

  if (kind === 'booking') {
    const lead = await pickLead(['replied', 'in_sequence', 'unsent']);
    await kv.hset(K.bookings(TEST_ID), { [id]: { leadEmail: lead?.email || null, scheduledAt: new Date(vnow.getTime() + 864e5).toISOString(), source: 'link', remindersSent: [], status: 'booked', qualified: false, rebookAttempts: 0, createdAt: at } });
    await bump(TEST_ID, 'booked', 1, vnow);
    await logEvent(TEST_ID, 'test', 'simulated_booking', { bookingId: id });
    return { bookingId: id };
  }

  if (kind === 'held' || kind === 'noshow') {
    const b = (await getBookings(TEST_ID)).filter((x) => x.status === 'booked').sort((a, c) => String(c.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!b) throw new Error('No booked call to mark. Simulate a booking first.');
    const { id: bid, ...rec } = b;
    if (kind === 'held') {
      await kv.hset(K.bookings(TEST_ID), { [bid]: { ...rec, status: 'held', qualified: true, attendedTapAt: at } });
      await bump(TEST_ID, 'held', 1, vnow);
      await bump(TEST_ID, 'qualified', 1, vnow);
    } else {
      await kv.hset(K.bookings(TEST_ID), { [bid]: { ...rec, status: 'noshow', qualified: false, attendedTapAt: at } });
      await bump(TEST_ID, 'noshows', 1, vnow);
    }
    await logEvent(TEST_ID, 'test', `simulated_${kind}`, { bookingId: bid });
    return { bookingId: bid, kind };
  }

  if (kind === 'sends') {
    // A day of normal sending: 40 sends to 20 companies.
    await bump(TEST_ID, 'sent', 40, vnow);
    await bump(TEST_ID, 'sentD0', 20, vnow);
    await bump(TEST_ID, 'companiesContacted', 20, vnow);
    const trial = await getTrial(TEST_ID);
    if (!trial.firstSendAt) await kv.hset(K.trial(TEST_ID), { firstSendAt: at, day1Date: trial.day1Date || dayKeyIn(ET, vnow) });
    await logEvent(TEST_ID, 'test', 'simulated_sends', { sent: 40 });
    return { sent: 40 };
  }

  if (kind === 'bounce_spike') {
    await bump(TEST_ID, 'sent', 50, vnow);
    await bump(TEST_ID, 'bounces', 3, vnow);
    await logEvent(TEST_ID, 'test', 'simulated_bounce_spike', { sent: 50, bounces: 3 });
    return { sent: 50, bounces: 3 };
  }

  if (kind === 'heartbeat_loss') {
    await kv.set(K.testSkipPings(), '1', { ex: 20 * 60 });
    await logEvent(null, 'test', 'simulated_heartbeat_loss', { minutes: 20 });
    return { skipPingsFor: '20 min', note: 'Honoured by /api/cron/tick once the 2-line change in the Stage D report is merged.' };
  }
  throw new Error(`unknown simulation ${kind}`);
}

export async function testStatus(now = new Date()) {
  const client = await getClient(TEST_ID);
  if (!client) return { running: false };
  const trial = await getTrial(TEST_ID);
  const vnow = clientNow(client, now);
  let skip = null;
  try { skip = await kv.get(K.testSkipPings()); } catch {}
  return { running: true, state: client.state, virtualNow: vnow.toISOString(), day: trialDay(trial, vnow), clockScale: Number(client.clockScale), heartbeatLoss: Boolean(skip), trial };
}
