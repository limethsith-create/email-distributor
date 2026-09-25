// Phase 6 acceptance (SPEC §15): the whole trial for client `_test`, driven
// through the real scheduler on a controllable clock with every network
// piece stubbed (tests/sim-world.mjs). Run 1 books and holds a qualified call
// and ends with Start plan; run 2 has no qualified call and goes through the
// extension and the zero-call report. The milestone log (state changes,
// client emails, owner alerts and the key system steps) is compared with
// tests/fixtures/full-run.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { getClient, getTrial, getProfile } from '@/lib/db/client';
import { getLead, getLeads } from '@/lib/db/leads';
import { getTotals } from '@/lib/db/counters';
import { setOverride } from '@/lib/config';
import { readToken } from '@/lib/pagetokens';
import { runTick } from '@/lib/scheduler';
import { startTest, TEST_ID } from '@/lib/systems/testmode';
import { saveOnboarding, acceptAgreement } from '@/lib/systems/onboarding';
import { submitPurchase } from '@/lib/systems/purchase';
import { saveHelper } from '@/lib/systems/warmup';
import { handleWebhook } from '@/lib/systems/leadfinder';
import { approveSection } from '@/lib/systems/approval';
import { confirmBookingOk } from '@/lib/systems/bookingtest';
import { applyTap } from '@/lib/systems/scorekeeper';
import { decide } from '@/lib/systems/decision';
import { sim, installWorld, deliver, sentTo, tokenIn } from './sim-world.mjs';

const OWNER = 'owner@aviance.test';
const FIXTURE = new URL('./fixtures/full-run.json', import.meta.url);
const WRITE = process.env.WRITE_FIXTURE === '1';

// ── clock ────────────────────────────────────────────────────────────────────

const et = (day, hhmm) => new Date(`${day}T${hhmm}:00-04:00`); // EDT (Oct) — Nov handled by etAt
function etAt(day, hhmm) {
  // US Eastern: EDT until the first Sunday of November (2026-11-01), EST after.
  return new Date(`${day}T${hhmm}:00${day >= '2026-11-01' ? '-05:00' : '-04:00'}`);
}
const addDaysKey = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function tickAt(when) {
  sim.now = when;
  return runTick({ source: 'cronjob', now: when });
}

/** Run the scheduler through [from, to): a tick every 15 minutes, day and night. */
async function runUntil(to, { hooks = [] } = {}) {
  let t = sim.now.getTime();
  const end = to.getTime();
  while (t < end) {
    const d = new Date(t);
    await tickAt(d);
    for (const h of hooks) await h(d);
    t += 15 * 60_000;
  }
  sim.now = to;
}

// ── the milestone log ────────────────────────────────────────────────────────

const KEEP_SYSTEM_EVENTS = new Set([
  'onboarding:agreement_accepted', 'market:passed', 'setupcheck:passed', 'leadfinder:dispatched', 'leadfinder:batch_inserted',
  'approval:link_sent', 'approval:approved', 'bookingtest:client_confirmed', 'sender:first_send', 'sender:smoke_cleared',
  'bookings:booking_created', 'scorekeeper:tap', 'reports:report_rendered', 'handover:handover_sent', 'decision:decision_sent',
  'extension:extension_started', 'extension:extension_ended', 'planstart:plan_started', 'wrapup:retired', 'wrapup:deleted',
]);

function milestone(e) {
  if (e.system === 'state' && e.event === 'changed') return { m: `state ${e.detail?.from} → ${e.detail?.to}` };
  if (e.system === 'notify' && e.event === 'client_email_sent') return { m: `client ${e.detail?.key}` };
  if (e.system === 'notify' && e.event === 'alert_sent') {
    const key = e.detail?.key;
    if (['morning_digest', 'monday_digest'].includes(key)) return null;
    return { m: `owner ${key}` };
  }
  if (KEEP_SYSTEM_EVENTS.has(`${e.system}:${e.event}`)) {
    const extra = ['reports', 'handover', 'extension'].includes(e.system) ? (e.detail?.name ? ` ${e.detail.name}` : e.detail?.reason ? ` ${e.detail.reason}` : '') : '';
    return { m: `${e.system} ${e.event}${extra}` };
  }
  return null;
}

async function milestones() {
  const events = ((await kv.lrange(K.events(TEST_ID), 0, -1)) || []).slice().reverse();
  const out = [];
  for (const e of events) {
    const m = milestone(e);
    if (m && out[out.length - 1] !== m.m) out.push(m.m); // collapse immediate repeats
  }
  return out;
}

// ── the actors ───────────────────────────────────────────────────────────────

async function prepare() {
  __reset();
  installWorld();
  // Leads v2: a lead is sendable only once an email verifier said `valid`.
  // One free-tier verifier (Reoon) is "configured" and answers `safe` for the
  // test prospects; its daily budget is lifted so the whole list verifies
  // during the build weeks (the real free tier is 20 a day).
  process.env.REOON_API_KEY = 'sim-reoon';
  const worldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://emailverifier.reoon.com/')
    ? new Response(JSON.stringify({ status: 'safe', is_safe_to_send: true }), { status: 200 })
    : worldFetch(url, init));
  await setOverride(null, 'VERIFY.services', { reoon: { daily: 5000, monthly: null } });
  await setOverride(null, 'OWNER.signerName', 'Limeth Sith');
  await setOverride(null, 'OWNER.address', '1 Owner Rd, Colombo');
  await setOverride(null, 'REVIEW.clutchUrl', 'https://clutch.co/profile/aviance');
  await setOverride(null, 'PAYMENT.paypalMe', 'https://paypal.me/aviance');
  await setOverride(null, 'WINBACK_TEXT.whatsNew', 'a faster list build');
  await setOverride(null, 'TESTMODE.clockScale', 0); // the test drives the clock itself
  for (let i = 0; i < 8; i++) await saveHelper({ email: `helper${i}@helper${i}.test`, password: 'abcdefghijklmnop', provider: 'google' });
}

async function clientFillsOnboarding() {
  const mail = sentTo(OWNER).find((m) => /\/onboard/.test(m.text));
  assert.ok(mail, 'onboarding link emailed');
  const tok = await readToken(tokenIn(mail.text, 'onboard'), { purpose: 'onboarding' });
  assert.equal(tok.clientId, TEST_ID);
  const r = await saveOnboarding(TEST_ID, {
    companyName: 'Test Mode Co', senderName: 'Sam Tester', senderTitle: 'Owner', senderPrefix: 'sam',
    calendarUrl: 'https://cal.com/aviance-test/15min', postalAddress: '1 Test St, Dover, DE 19901', hotLeadEmail: OWNER,
    suppressCustomers: 'bigcustomer.com', competitors: 'Rival IT', sellsTo: 'We run IT support for 10–50 person offices in Texas.',
    defaultNiche: 'managed IT', defaultIcp: 'small offices', industry: 'accounting firm, law firm',
    cities: 'Dallas, TX\nAustin, TX', states: 'TX', sizeMin: '10', sizeMax: '50', titles: 'Owner\nManaging Partner', excludedTitles: 'Intern',
    dreamCustomers: [{ name: 'A', website: 'a.com' }, { name: 'B', website: 'b.com' }, { name: 'C', website: 'c.com' }],
    capacityPerWeek: '5', winCondition: 'Two good calls.',
  });
  assert.deepEqual(r.errors, {});
  const a = await acceptAgreement(TEST_ID, { name: 'Tess Tester', title: 'CEO', agree: true, ip: '203.0.113.9', now: sim.now, deadline: Date.now() + 60_000 });
  assert.equal(a.ok, true, JSON.stringify(a));
}

async function ownerPastesLogins() {
  const r = await submitPurchase(TEST_ID, {
    domain: 'testmode-team.com', autoRenewOff: true, registrar: 'Cloudflare', price: 10.44,
    inboxes: [
      { email: 'sam@testmode-team.com', password: 'abcdefghijklmnop', displayName: 'Sam Tester' },
      { email: 's.tester@testmode-team.com', password: 'bcdefghijklmnopq', displayName: 'Sam Tester' },
    ],
  }, { now: sim.now, deadline: Date.now() + 60_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
}

let leadFinderDone = false;
async function leadFinderJob() {
  if (leadFinderDone) return;
  const st = (await kv.hgetall(K.leadfinder(TEST_ID))) || {};
  if (!st.initialAt) return;
  leadFinderDone = true;
  const cities = [['Dallas', 'TX'], ['Austin', 'TX']];
  for (let b = 0; b < 5; b++) {
    const leads = Array.from({ length: 90 }, (_, i) => {
      const n = b * 90 + i;
      const [city, state] = cities[n % 2];
      return { email: `owner${n}@firm${n}.test`, first_name: `Pat${n}`, name: `Pat${n} Lee`, title: n % 3 ? 'Owner' : 'Managing Partner', company: `Firm ${n} CPA`, website: `https://firm${n}.test`, city, state, types: ['accounting'], employees: 20, riskLevel: 'safe', score: 3 };
    });
    const r = await handleWebhook({ clientId: TEST_ID, type: 'batch', runId: 'r1', batchNo: b, mode: 'initial', leads, placesRequests: 30 });
    assert.equal(r.status, 200);
  }
  await handleWebhook({ clientId: TEST_ID, type: 'done', runId: 'r1', mode: 'initial', found: 450, candidates: 900 });
}

async function clientApproves() {
  const mail = sentTo(OWNER).find((m) => /\/approve/.test(m.text));
  if (!mail) return false;
  const t = tokenIn(mail.text, 'approve');
  for (const s of ['profile', 'list', 'copy']) assert.equal((await approveSection(t, s, { now: sim.now })).ok, true);
  return true;
}

async function clientTestsBookingLink() {
  const mail = sentTo(OWNER).find((m) => /\/booking-ok/.test(m.text));
  if (!mail) return false;
  assert.equal((await confirmBookingOk(tokenIn(mail.text, 'booking-ok'), { now: sim.now })).ok, true);
  return true;
}

/** Build weeks: apply → … → ready. Returns the Day 1 date. */
async function intakeAndBuild(startDay) {
  await prepare();
  sim.now = et(startDay, '10:00');
  await startTest({ from: 'apply', now: sim.now });
  assert.equal((await getClient(TEST_ID)).state, 'onboarding');
  sim.now = et(startDay, '10:20');
  await clientFillsOnboarding();
  assert.equal((await getClient(TEST_ID)).state, 'awaiting_purchase');
  await runUntil(et(startDay, '11:30'));
  assert.ok(sentTo(OWNER).some((m) => /Shopping list/.test(m.text)), 'shopping list sent to the owner');
  sim.now = et(startDay, '11:30');
  await ownerPastesLogins();
  let approved = false;
  let tested = false;
  const hooks = [
    leadFinderJob,
    async () => { if (!approved) approved = await clientApproves(); },
    async () => { if (!tested) tested = await clientTestsBookingLink(); },
  ];
  // Until the client is `ready` (Day 1 is ~14 days after setup).
  for (let d = 0; d < 20; d++) {
    const c = await getClient(TEST_ID);
    if (['ready', 'sending'].includes(c.state)) break;
    await runUntil(et(addDaysKey(startDay, d + 1), '00:05'), { hooks });
  }
  assert.ok(approved, 'the approval link arrived and was approved');
  assert.ok(tested, 'the booking link test arrived and was confirmed');
  const trial = await getTrial(TEST_ID);
  return trial.day1Date;
}

// ── replies ──────────────────────────────────────────────────────────────────

async function sentLeads() {
  return (await getLeads(TEST_ID)).filter((l) => l.sent_at && l.status === 'in_sequence' && l.original_message_id).sort((a, b) => a.email.localeCompare(b.email));
}

async function prospectReplies(kinds) {
  const leads = await sentLeads();
  assert.ok(leads.length >= kinds.length, `enough emailed leads (${leads.length}) for ${kinds.length} replies`);
  const TEXT = {
    interested: 'Interested — tell me more. What does it cost?',
    question: 'Who else in Dallas have you worked with?',
    notnow: 'Not right now, maybe next quarter.',
    no: 'No thanks.',
    ooo: null,
    wrongperson: "I'm not the right person — please contact dana.reyes@{host}, she runs operations.",
    angry: 'Stop emailing me. How did you get my address?',
    unclear: 'Received.',
    legal: 'Forwarding this to our attorney. Cease and desist.',
  };
  const used = {};
  for (const kind of kinds) {
    const lead = leads.shift();
    used[kind] = lead;
    const threadIds = [lead.original_message_id.replace(/[<>]/g, '')];
    if (kind === 'ooo') {
      // imap-scan marks auto-replies (OOO subject/headers) as kind 'ooo' before the handler sees them.
      deliver(lead.account_used, { from: lead.email, subject: 'Out of Office: ' + lead.original_subject, text: 'I am out of the office until next Monday.', threadIds, kind: 'ooo' });
    } else {
      deliver(lead.account_used, { from: lead.email, subject: `Re: ${lead.original_subject}`, text: TEXT[kind].replace('{host}', lead.email.split('@')[1]), threadIds });
    }
  }
  return used;
}

// The client answers every hot lead in its thread (as the agreement asks).
const answered = new Set();
async function clientAnswersHotLeads() {
  for (const m of sim.sent) {
    if (m.to !== OWNER || !/^Hot/.test(m.subject || '') || answered.has(m.messageId)) continue;
    answered.add(m.messageId);
    deliver(m.from, { from: OWNER, subject: `Re: ${m.subject}`, text: 'On it — I will call them today.', threadIds: [m.messageId.replace(/[<>]/g, '')] });
  }
}

// A trickle of replies (one "no thanks" a weekday at 13:00 ET) keeps the
// campaign from looking dead to the Emergency Runner's no-reply trigger.
let trickleDay = '';
async function replyTrickle(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  if (['Sat', 'Sun'].includes(get('weekday')) || Number(get('hour')) < 13 || trickleDay === day) return;
  const c = await getClient(TEST_ID);
  if (!['sending', 'extension'].includes(c.state)) return;
  const lead = (await sentLeads())[0];
  if (!lead) return;
  trickleDay = day;
  deliver(lead.account_used, { from: lead.email, subject: `Re: ${lead.original_subject}`, text: 'No thanks.', threadIds: [lead.original_message_id.replace(/[<>]/g, '')] });
}
const SENDING_HOOKS = [clientAnswersHotLeads, replyTrickle];

function bookingInvite(inbox, lead, startUtc) {
  const d = startUtc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:cal-${lead.email}`, `DTSTART:${d}`, `DTEND:${d}`, 'SUMMARY:Intro call', `ORGANIZER;CN=Sam Tester:mailto:${inbox}`, `ATTENDEE;CN=${lead.name}:mailto:${lead.email}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  deliver(inbox, { from: 'notifications@cal.com', subject: `New Event: Intro call with ${lead.name}`, text: `A new event was booked with ${lead.name}.`, ics: [ics], kind: 'human' });
}

// ── run 1: a qualified call → Start plan ─────────────────────────────────────

test('full run: apply → Day 30 decision → Start plan (with a qualified call)', { timeout: 900_000 }, async () => {
  const day1 = await intakeAndBuild('2026-10-05');
  if (process.env.SIM_DEBUG) { console.log((await milestones()).join('\n')); console.log(JSON.stringify(await getTrial(TEST_ID))); console.log(sim.now.toISOString(), (await getClient(TEST_ID)).state); const { readinessGate } = await import('@/lib/systems/readiness'); console.log(JSON.stringify(await readinessGate(TEST_ID, sim.now))); console.log(JSON.stringify(await kv.lrange(K.events(TEST_ID), 0, 30))); console.log(JSON.stringify(await kv.hgetall(K.inbox(TEST_ID, 'sam@testmode-team.com')))); }
  assert.equal(day1, '2026-10-19');
  const inbox = (await kv.smembers(K.inboxes(TEST_ID)))[0];

  // Day 1 → Day 3: sending starts, the first-50 smoke test clears.
  await runUntil(etAt(addDaysKey(day1, 2), '12:00'), { hooks: SENDING_HOOKS });
  assert.equal((await getClient(TEST_ID)).state, 'sending');
  assert.ok((await getTotals(TEST_ID)).sent > 0, 'cold emails went out');

  // Every reply kind (legal last: it holds sending until the owner clears it).
  const used = await prospectReplies(['interested', 'question', 'notnow', 'no', 'ooo', 'wrongperson', 'angry', 'unclear']);
  await runUntil(etAt(addDaysKey(day1, 2), '13:00'), { hooks: SENDING_HOOKS });
  const kinds = [...new Set(Object.values((await kv.hgetall(K.replies(TEST_ID))) || {}).map((r) => r.kind))].sort();
  assert.deepEqual(kinds, ['angry', 'interested', 'no', 'notnow', 'ooo', 'question', 'unclear', 'wrongperson']);
  assert.equal((await getLead(TEST_ID, used.no.email)).status, 'suppressed');
  assert.equal(await kv.sismember(K.suppression(), used.angry.email), 1);
  assert.ok(sentTo(used.interested.email).some((m) => /cal\.com/.test(m.text)), 'interested prospect got the two slots + link');
  assert.ok(await getLead(TEST_ID, `dana.reyes@${used.wrongperson.email.split('@')[1]}`), 'referral lead created');

  // The interested prospect books for Day 5 at 11:00 ET; the call is held.
  const lead = used.interested;
  const slot = etAt(addDaysKey(day1, 4), '11:00');
  bookingInvite(inbox, lead, slot);
  await runUntil(etAt(addDaysKey(day1, 2), '15:00'), { hooks: SENDING_HOOKS });
  const bookings = Object.values((await kv.hgetall(K.bookings(TEST_ID))) || {});
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].leadEmail, lead.email);
  await runUntil(new Date(slot.getTime() + 90 * 60_000), { hooks: SENDING_HOOKS }); // +1 h → call_tap
  const tapMail = sentTo(OWNER).find((m) => /\/tap/.test(m.text));
  assert.ok(tapMail, 'call_tap reached the client');
  const tap = await readToken(tokenIn(tapMail.text, 'tap'), { purpose: 'tap' });
  const r = await applyTap(TEST_ID, tap.data.bookingId, 'showed', { now: sim.now });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await getTotals(TEST_ID)).qualified, 1);

  // A legal reply near the end holds sending (no owner step needed: Day 30 ends it).
  const late = await prospectReplies(['legal']);
  await runUntil(etAt(addDaysKey(day1, 27), '12:00'), { hooks: SENDING_HOOKS });
  assert.ok((await getClient(TEST_ID)).legalHoldAt, 'legal hold set');
  assert.equal(await kv.sismember(K.suppression(), late.legal.email), 1);

  // Day 29 report, Day 30 handover + decision page.
  await runUntil(etAt(addDaysKey(day1, 29), '12:00'), { hooks: SENDING_HOOKS });
  const c30 = await getClient(TEST_ID);
  if (process.env.SIM_DEBUG) console.log((await milestones()).slice(20).join('\n'));
  assert.equal(c30.state, 'deciding');
  const decisionMail = sentTo(OWNER).find((m) => /\/decide/.test(m.text));
  assert.ok(decisionMail, 'decision link emailed');
  const d = await decide(tokenIn(decisionMail.text, 'decide'), 'start', { now: sim.now });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal((await getClient(TEST_ID)).state, 'converted');

  // A few more days: invoice, review request; the trial pair keeps sending.
  await runUntil(etAt(addDaysKey(day1, 33), '12:00'), { hooks: SENDING_HOOKS });
  assert.ok(sentTo(OWNER).some((m) => /invoice/i.test(m.subject || '') || /AV-\d{6}/.test(m.text)), 'invoice sent');

  const log = await milestones();
  await compareFixture('with_calls', log);
});

// ── run 2: no qualified call → extension → zero-call report ──────────────────

test('full run: no qualified call → extension to the cap → zero-call report → not now → retired', { timeout: 900_000 }, async () => {
  leadFinderDone = false;
  const day1 = await intakeAndBuild('2026-10-05');
  // No replies at all: 60 trial days of sending, then the decision, the ladder and retirement.
  await runUntil(etAt(addDaysKey(day1, 29), '12:00'));
  assert.equal((await getClient(TEST_ID)).state, 'extension');
  await runUntil(etAt(addDaysKey(day1, 60), '12:00'));
  const c = await getClient(TEST_ID);
  assert.equal(c.state, 'deciding');
  const zeroMail = sentTo(OWNER).filter((m) => /\/decide/.test(m.text)).pop();
  assert.ok(zeroMail, 'zero-call decision page sent');
  // No click → not_now by ladder day 45 → retired.
  await runUntil(etAt(addDaysKey(day1, 60 + 16), '12:00'));
  assert.equal((await getClient(TEST_ID)).state, 'retired');
  const log = await milestones();
  await compareFixture('zero_calls', log);
});

/** SIM_REPORT=dir writes a plain report of the run (timeline, emails, numbers) for a human to read. */
async function writeReport(run) {
  const dir = process.env.SIM_REPORT;
  if (!dir) return;
  const events = ((await kv.lrange(K.events(TEST_ID), 0, -1)) || []).slice().reverse()
    .map((e) => ({ at: e.at, system: e.system, event: e.event, detail: e.detail }));
  const client = await getClient(TEST_ID);
  const trial = await getTrial(TEST_ID);
  const leads = await getLeads(TEST_ID);
  const replies = Object.values((await kv.hgetall(K.replies(TEST_ID))) || {});
  const bookings = Object.values((await kv.hgetall(K.bookings(TEST_ID))) || {});
  const byStatus = {};
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  const mail = sim.sent.map((m) => ({ at: m.at, from: m.from, to: m.to, subject: m.subject, text: String(m.text || '').slice(0, 1500), warmup: Boolean(m.headers && m.headers['X-Aviance-Warm']) }));
  const report = {
    run, finishedAt: sim.now.toISOString(), state: client.state, trial,
    totals: await getTotals(TEST_ID), leadsByStatus: byStatus, leadCount: leads.length,
    replies: replies.map((r) => ({ kind: r.kind, leadEmail: r.leadEmail, snippet: r.snippet, action: r.action })),
    bookings: bookings.map((b) => ({ leadEmail: b.leadEmail, scheduledAt: b.scheduledAt, status: b.status, qualified: b.qualified })),
    milestones: await milestones(), events, mail,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${run}.json`, JSON.stringify(report, null, 1));
}

async function compareFixture(run, log) {
  await writeReport(run);
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (WRITE) {
    fx.runs[run] = log;
    fs.writeFileSync(FIXTURE, `${JSON.stringify(fx, null, 2)}\n`);
    return;
  }
  assert.deepEqual(log, fx.runs[run], `milestone log for ${run} differs from tests/fixtures/full-run.json (WRITE_FIXTURE=1 to regenerate after checking it)`);
}
