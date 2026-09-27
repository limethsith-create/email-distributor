// The launch call (docs/LAUNCH-CALL.md): the "what happens now" email, when
// the invite may go (list, copy, warm-up day), the invite once, the approval
// page first (call optional, skip), Approved on the call, the reminders and
// overdue on the launch thread, the reply bot booking a launch meeting, one
// launch meeting per client, and no secret in any hub answer. SMTP is the
// nodemailer stub below and IMAP is io.scanMailbox: nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { saveInbox, patchInbox } from '@/lib/db/inboxes';
import { insertLeads } from '@/lib/db/leads';
import { readToken } from '@/lib/pagetokens';
import { runApprovalJob, approvalUrl, approveSection, getApproval } from '@/lib/systems/approval';
import { getStoredSequence } from '@/lib/systems/copy';
import { readinessGate } from '@/lib/systems/readiness';
import { readyForLaunch, sendLaunchInvite, sendNextSteps, day1Estimate, day1Line, approvedOnCall, skipCall, launchCallFor } from '@/lib/systems/launchcall';
import { checkOnboardCalls, readCall, readThread, onboardCallView, normaliseSettings, markHeld, dueReminder, activeCall } from '@/lib/systems/onboardcall';
import { calendarAction, calendarView, getMeeting, requestMeeting } from '@/lib/systems/calendar';
import { hubClient, hubBoard } from '@/lib/systems/hubview';

// ── stubs ──
process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
process.env.SMTP_ACCOUNT_1 = 'onboard@aviance.test:app-pw2:Limeth Sith';
process.env.PUBLIC_BASE_URL = 'https://app.test';
delete process.env.OPEN_TRACKING;
let sent = [];
nodemailer.createTransport = (opts = {}) => ({
  async sendMail(m) { sent.push({ ...m, user: opts.auth?.user }); return { messageId: m.messageId, response: '250 OK' }; },
  async verify() { return true; },
  close() {},
});
let alerts = [];
let inbox = [];
const realNow = io.now;

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; inbox = [];
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.scanMailbox = async () => ({ ok: true, messages: inbox.map((m) => ({ ...m })), uidState: { INBOX: { uidValidity: '1', lastUid: inbox.length } } });
  io.now = realNow;
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
});

const ID = 'ecreek';
const SAM = 'sam@ecreek.com';
const INVITE_SUBJECT = 'Your list is ready';
const SECRET_PW = 'Inbox-App-Pw-7731';
const FRI = new Date('2026-10-16T14:00:00Z');   // Fri 10:00 ET (EDT) = 7:30 pm Colombo — warm-up day 10 when it started on Wed 7 Oct
const TUE = new Date('2026-10-13T14:00:00Z');   // Tue 10:00 ET
const TUE_20_11 = '2026-10-20T15:00:00.000Z';    // Tue 20 Oct 11:00 am EDT = 8:30 pm Colombo
const at = (base, hours) => new Date(base.getTime() + hours * 3600e3);
const toSam = () => sent.filter((m) => m.to === SAM);
const alertKeys = () => alerts.map((a) => a.key);
const check = (now) => checkOnboardCalls({ now, force: true });
const PROFILE = {
  senderName: 'Sam Test', postalAddress: '100 Main St, Dallas, TX 75201', oneLiner: 'We look after computers, email and backups for small offices in Dallas.',
  defaultNiche: 'managed IT', defaultIcp: 'dental practices', industry: 'managed IT services', titles: 'owner, president, office manager', cities: 'Dallas, TX', states: 'TX',
};
const TRIAL = { signedDay: '2026-10-06', day1Date: '2026-10-21', day30Date: '2026-11-19' };

/**
 * A client in warm-up whose onboarding call was held: two inboxes `warmupDay`
 * days into warm-up (counted at `now`), `leads` unsent contacts, the profile
 * the copy needs, the trial dates.
 */
async function warming({ warmupDay = 10, leads = 220, now = FRI, trial = TRIAL, profile = PROFILE } = {}) {
  // No helper accounts in this test: the circle rule is off, so the warm-up card reads "Warming up — day N".
  await kv.hset('system:config', { 'WARMUP.minPool': JSON.stringify(0) });
  await createClient(ID, { state: 'warming', name: 'eCreek IT', contactName: 'Sam Test', contactEmail: SAM, mainDomain: 'ecreek.com', website: 'https://ecreek.com', onboardCallSentAt: '2026-10-01T14:00:00Z' });
  await kv.hset(K.onboardCall(ID), { sentAt: '2026-10-01T14:00:00Z', contactEmail: SAM, heldAt: '2026-10-06T16:00:00Z', theirZone: 'America/New_York' });
  await kv.hset(K.profile(ID), profile);
  await kv.hset(K.trial(ID), trial);
  const started = new Date(now.getTime() - (warmupDay - 1) * 864e5).toISOString();
  for (const email of ['sam@ecreek-mail.com', 'sam.t@ecreek-mail.com']) {
    await saveInbox(ID, { email, password: SECRET_PW, provider: 'google', displayName: 'Sam Test' });
    await patchInbox(ID, email, { warmupStartedAt: started, enabled: '1' });
  }
  if (leads) await insertLeads(ID, Array.from({ length: leads }, (_, i) => ({ email: `pat${i}@dental${i}.com`, first_name: 'Pat', company: `Dental ${i}`, city: 'Dallas', state: 'TX', types: ['dentist'] })));
}

/** The hourly approval job as the tick runs it. */
const job = async (now, deps = {}) => runApprovalJob({ client: await getClient(ID), now, deps });

/** The invite went: the launch call is in play. → the invite email. */
async function invited(now = FRI) {
  await warming({ now });
  const r = await job(now);
  assert.ok(r.launchInvite?.sent, JSON.stringify(r));
  return toSam().find((m) => m.subject === INVITE_SUBJECT);
}

/** A message from Sam in the onboarding inbox, answering the invite. */
let uid = 100;
function mail(text, { at: when, inviteId = null, subject = `Re: ${INVITE_SUBJECT}` }) {
  uid++;
  const ids = inviteId ? [inviteId.replace(/^<|>$/g, '').toLowerCase()] : [];
  return { uid, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: `<Reply${uid}.X@mail.ecreek.com>`, from: SAM, fromName: 'Sam Test', to: ['onboard@aviance.test'], subject, date: new Date(when).toISOString(), inReplyTo: ids, references: ids, threadIds: ids, kind: 'human', hasIcs: false, text };
}

const { POST: launchPost } = await import('@/app/api/mc/clients/[id]/launch-call/route');
const post = async (body) => { const r = await launchPost(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: { id: ID } }); return { status: r.status, body: await r.json() }; };

// ── "what happens now" ───────────────────────────────────────────────────────

test('next_steps goes once — after the onboarding call is held, with the Day 1 from the ramp, never a made-up date', async () => {
  await createClient(ID, { state: 'onboarding', name: 'eCreek IT', contactName: 'Sam Test', contactEmail: SAM, mainDomain: 'ecreek.com', onboardCallSentAt: '2026-10-01T14:00:00Z' });
  await kv.hset(K.onboardCall(ID), { sentAt: '2026-10-01T14:00:00Z', contactEmail: SAM, bookedAt: '2026-10-02T14:00:00Z', bookedFor: '2026-10-06T15:00:00Z' });
  // Nothing has started yet: no date is promised.
  await markHeld(ID, { now: new Date('2026-10-06T15:40:00Z') });
  const plan = toSam();
  assert.equal(plan.length, 1, 'one email on Call done');
  assert.equal(plan[0].subject, 'Your trial — what happens now');
  assert.match(plan[0].text, /^Hi Sam,\n\nGood to talk with you today/);
  assert.match(plan[0].text, /30-minute launch call/);
  assert.match(plan[0].text, /The first emails go out in about three weeks\./);
  assert.doesNotMatch(plan[0].text, /\{/);
  assert.deepEqual((await readThread(ID)).map((t) => t.kind), ['next_steps'], 'in the conversation under its own kind');
  assert.equal((await kv.hgetall(K.trial(ID))).nextStepsMoment, 'call');
  // The agreement moment later sends nothing more (never two "what happens now" emails); a second Call done neither.
  assert.deepEqual(await sendNextSteps(ID, { now: new Date('2026-10-06T18:00:00Z'), moment: 'agreement' }), { sent: false, already: true });
  await markHeld(ID, { now: new Date('2026-10-06T16:00:00Z') });
  assert.equal(toSam().length, 1);
  // The estimate, pure: day1Date first, else the slowest inbox's start + 14 days on a business day, else nothing.
  assert.equal(day1Estimate({ trial: { day1Date: '2026-10-21' } }), '2026-10-21');
  assert.equal(day1Estimate({ inboxes: [{ warmupStartedAt: '2026-10-07T09:40:00Z' }, { warmupStartedAt: '2026-10-08T09:40:00Z' }], minDays: 14 }), '2026-10-22');
  assert.equal(day1Estimate({ inboxes: [{ warmupStartedAt: '2026-10-03T12:00:00Z' }] }), '2026-10-19', 'Sat 17 Oct → Mon 19 Oct');
  assert.equal(day1Estimate({}), null);
  assert.equal(day1Line('2026-10-21'), 'about Wednesday 21 October');
  assert.equal(day1Line(null), 'in about three weeks');
});

// ── ready for the launch call ────────────────────────────────────────────────

test('readyForLaunch: not before warm-up day 10, not with a short list, not with copy the checker fails; the job waits and sends no approval link', async () => {
  await warming({ warmupDay: 8, now: new Date('2026-10-14T14:00:00Z') });
  const early = await readyForLaunch(ID, { now: new Date('2026-10-14T14:00:00Z'), build: true });
  assert.equal(early.ok, false);
  assert.deepEqual([early.checks.warmup.day, early.checks.warmup.ok, early.checks.list.ok, early.checks.copy.ok], [8, false, true, true]);
  assert.match(early.reasons.join(' '), /warm-up is on day 8 of at least 10/);
  // Day −7 (the old link day): the job waits for the launch call instead of emailing the approval page.
  const r = await job(new Date('2026-10-14T14:00:00Z'));
  assert.match(r.waiting, /^launch call: warm-up is on day 8/);
  assert.equal(sent.length, 0, 'no approval link, no invite');

  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  await warming({ leads: 120 });
  const short = await readyForLaunch(ID, { now: FRI, build: true });
  assert.equal(short.ok, false);
  assert.deepEqual([short.checks.warmup.ok, short.checks.list.ok, short.checks.list.unsent], [true, false, 120]);
  assert.match(short.reasons.join(' '), /the list has 120 of the 200 contacts we need/);
  assert.equal(short.checks.copy.built, false, 'the copy is built once the list is in');

  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  await warming();
  await readyForLaunch(ID, { now: FRI, build: true }); // builds the copy
  const seq = await getStoredSequence(ID);
  const broken = { ...seq.variantA, touches: seq.variantA.touches.map((t, i) => (i === 0 ? { ...t, body: `${t.body} {Nope}` } : t)) };
  await kv.hset(K.sequence(ID), { variantA: JSON.stringify(broken) });
  const failing = await readyForLaunch(ID, { now: FRI });
  assert.equal(failing.ok, false);
  assert.deepEqual([failing.checks.copy.ok, failing.checks.copy.built], [false, true]);
  assert.match(failing.reasons.join(' '), /Copy Checker failed on A d0: unfilled_slot/);
});

test('the invite once: booking page for a launch call + the approval page, tracked, launch_ready — a second run sends nothing', async () => {
  const m = await invited();
  assert.ok(m, 'the launch invite went');
  assert.equal(toSam().length, 1, 'one email');
  assert.ok(!sent.some((x) => /for your OK/.test(x.subject || '')), 'not the plain approval email');
  assert.match(m.from, /<onboard@aviance\.test>$/, 'from the onboarding-call inbox, so replies land where the machine reads them');
  assert.match(m.text, /^Hi Sam,/);
  assert.match(m.text, /will go out in your name are ready/, 'Sam is the sender');
  assert.match(m.text, /30-minute launch call/);
  assert.match(m.text, /the first emails go out about Wednesday 21 October\./);
  const book = m.text.match(/Book a time that suits you: https:\/\/app\.test\/c\/([^/\s]+)\/book\b/);
  assert.ok(book, 'the booking page');
  const tok = await readToken(book[1], { purpose: 'book' });
  assert.deepEqual([tok.clientId, tok.data], [ID, { kind: 'launch' }], 'the link books a LAUNCH call');
  const approve = m.text.match(/https:\/\/app\.test\/c\/([^/\s]+)\/approve\b/);
  assert.ok(approve, 'the approval page, below');
  assert.equal((await readToken(approve[1], { purpose: 'approval' })).clientId, ID);
  assert.match(m.html, /\/api\/track\/open\?t=v2\./, 'one open pixel');
  // Tracked on its own hash; the client hash carries the flags the tick reads; the copy card knows the link went.
  const raw = await readCall(ID, 'launch');
  assert.equal(raw.sentAt, FRI.toISOString());
  assert.equal(raw.subject, INVITE_SUBJECT);
  assert.deepEqual(JSON.parse(raw.messageIds), [m.messageId]);
  assert.equal(raw.dueBy, '2026-10-21T14:00:00.000Z', '3 business days');
  assert.equal(raw.theirZone, 'America/New_York', 'their zone from the onboarding call');
  const c = await getClient(ID);
  assert.deepEqual([c.launchCallSentAt, c.launchCallOpen], [FRI.toISOString(), '1']);
  assert.equal((await getApproval(ID)).status, 'launch_invite');
  assert.deepEqual(alertKeys(), ['launch_ready']);
  assert.match(alerts[0].body, /220 contacts on the list.*warm-up day 10/);
  assert.deepEqual((await readThread(ID)).map((t) => [t.dir, t.kind]), [['out', 'launch_invite']]);
  // The hub's launchCall.
  const lc = await launchCallFor(ID, { now: at(FRI, 1) });
  assert.deepEqual([lc.kind, lc.status, lc.label, lc.approvedOnCall, lc.approvedOnPage, lc.skipped], ['launch', 'sent', 'Invite sent — waiting for them to book', null, null, null]);
  assert.equal(lc.approvalUrl, await approvalUrl(ID));
  assert.equal(lc.steps[0].label, 'Launch invite sent');
  assert.equal(lc.callMinutes, 30);
  assert.equal(lc.nextReminderAt, '2026-10-19T13:00:00.000Z', '24 h falls on Saturday → Monday 09:00 ET');
  // The job again: the call carries the approval now; no page reminder, no silence rule.
  assert.deepEqual(await job(at(FRI, 2)), { launch: 'sent' });
  assert.equal(toSam().length, 1);
  // The row and the trial.
  const detail = await hubClient(ID, { now: at(FRI, 2) });
  assert.equal(detail.launchCall.status, 'sent');
  assert.deepEqual(detail.launchCall.thread.map((t) => t.kind), ['launch_invite']);
  assert.match(detail.row.simple.label, /^Warming up — day 10 of about 14.* · waiting for them to pick a launch-call time$/);
  assert.equal(detail.row.simple.needsYou, false);
  assert.match(detail.row.systems.find((s) => s.key === 'copy').line, /^Launch invite sent/);
});

test('the fallback: LAUNCH.fallbackDay reached and still not ready → the plain approval email as before; a client with no warm-up records keeps the old Day −7 path', async () => {
  await warming({ leads: 50 });
  const deps = { notify: async (id, key, vars) => { sent.push({ to: SAM, key, subject: key, text: vars.approvalUrl }); return { sent: true }; } };
  assert.match((await job(at(FRI, 0), deps)).waiting, /^launch call:/, 'Day −5: still waiting for the list');
  const r = await job(new Date('2026-10-18T14:00:00Z'), deps); // Day −3
  assert.ok(r.link?.sent, JSON.stringify(r));
  assert.match(r.fallback, /the list has 50 of the 200/);
  assert.deepEqual(sent.map((m) => m.key), ['approval_link']);
  assert.equal((await readCall(ID, 'launch')).sentAt, undefined, 'no launch invite');
  // From here the old path continues (its reminders, then the silence rule) and the launch step stays out of it.
  assert.deepEqual(await job(new Date('2026-10-19T14:00:00Z'), deps), { reminder: -5 });
  assert.equal((await readCall(ID, 'launch')).sentAt, undefined);

  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  await createClient(ID, { state: 'warming', name: 'eCreek IT', contactName: 'Sam Test', contactEmail: SAM, mainDomain: 'ecreek.com' });
  await kv.hset(K.profile(ID), PROFILE);
  await kv.hset(K.trial(ID), TRIAL);
  await insertLeads(ID, [{ email: 'ann@dental.com', first_name: 'Ann', company: 'Smile Dental', city: 'Dallas', state: 'TX', types: ['dentist'] }]);
  assert.deepEqual((await job(new Date('2026-10-14T14:00:00Z'), deps)).link?.sent, true, 'Day −7, no warm-up records: the approval link as before');
});

// ── the approval page first: the call is optional, skip ─────────────────────

test('approved on the page → the call is optional (label, no reminders), skip works only then and never over a booked time', async () => {
  const m = await invited();
  const token = m.text.match(/\/c\/([^/\s]+)\/approve\b/)[1];
  assert.equal((await post({ action: 'skip' })).status, 409, 'skip before they approved');
  for (const s of ['profile', 'list']) assert.equal((await approveSection(token, s, { now: at(FRI, 3) })).approved, false);
  assert.equal((await approveSection(token, 'copy', { now: at(FRI, 3) })).approved, true);
  const seq = await getStoredSequence(ID);
  assert.equal(seq.approvalMode, 'click');
  let lc = await launchCallFor(ID, { now: at(FRI, 4) });
  assert.equal(lc.approvedOnPage, at(FRI, 3).toISOString());
  assert.equal(lc.label, 'They approved on the page — the call is optional');
  assert.equal(lc.nextReminderAt, null, 'no more "book the call" reminders');
  assert.equal(dueReminder(await readCall(ID, 'launch'), normaliseSettings(), at(FRI, 80), 'warming', 'launch'), null);
  await check(new Date('2026-10-22T14:00:00Z'));
  assert.deepEqual(alertKeys(), ['launch_ready'], 'never overdue once they approved');
  assert.equal(toSam().length, 1);
  let detail = await hubClient(ID, { now: at(FRI, 4) });
  assert.match(detail.row.simple.label, /· they approved on the page \(launch call optional\)$/);
  assert.equal(detail.row.simple.next, 'Nothing for you: hold the call if you like, or press Skip the call');
  assert.equal(detail.row.simple.needsYou, false);
  // A booked time blocks the skip (cancel it in the Calendar first); without one, skip closes the call.
  io.now = () => at(FRI, 5);
  assert.equal((await post({ action: 'markBooked', when: TUE_20_11 })).status, 200);
  const blocked = await post({ action: 'skip' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /cancel it in the Calendar first/);
  const meeting = await getMeeting((await readCall(ID, 'launch')).meetingId);
  assert.deepEqual([meeting.kind, meeting.source, meeting.status, meeting.title], ['launch', 'launch_card', 'confirmed', 'Launch call — eCreek IT']);
  await calendarAction({ action: 'cancel', id: meeting.id, reason: 'no need' }, { now: at(FRI, 6) });
  const skipped = await post({ action: 'skip' });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(skipped.body.launchCall.skipped, at(FRI, 5).toISOString());
  assert.equal(skipped.body.launchCall.label, 'Call skipped — they approved on the page');
  assert.equal((await getClient(ID)).launchCallOpen, '0');
  detail = await hubClient(ID, { now: at(FRI, 7) });
  assert.equal(detail.row.simple.label, 'Launch call done — first emails on Wednesday 21 October');
  assert.deepEqual(detail.row.todo.filter((t) => /^launch-/.test(t.id)), []);
  assert.equal((await post({ action: 'approvedOnCall' })).status, 409, 'skipped: nothing to approve on a call');
});

// ── Approved on the call ─────────────────────────────────────────────────────

test('Approved on the call: every section approved, approvalMode call, the call held, the readiness gate green; the to-dos say what to press', async () => {
  const m = await invited();
  const inviteId = m.messageId;
  io.now = () => at(FRI, 1);
  const booked = await post({ action: 'markBooked', when: TUE_20_11 });
  assert.equal(booked.status, 200);
  assert.deepEqual([booked.body.launchCall.status, booked.body.launchCall.bookedBy, booked.body.launchCall.bookedFor], ['booked', 'owner', TUE_20_11]);
  let detail = await hubClient(ID, { now: at(FRI, 2) });
  assert.match(detail.row.simple.label, / · launch call Tue 20 Oct, 8:30 pm \(your time\)$/);
  assert.match(detail.row.simple.next, /^Nothing for you until the call/);
  // The call time passes: the to-do and the row ask for Approved on the call.
  const after = new Date('2026-10-20T16:00:00Z');
  detail = await hubClient(ID, { now: after });
  const mark = detail.row.todo.find((t) => t.id === `launch-mark:${ID}`);
  assert.ok(mark && mark.urgent, JSON.stringify(detail.row.todo));
  assert.equal(mark.text, 'Hold the launch call with Sam Test, then press Approved on the call');
  assert.deepEqual(mark.action, { type: 'view', view: 'detail', clientId: ID, section: 'launchCall' });
  assert.equal(detail.row.simple.next, 'Hold the launch call, then press Approved on the call');
  assert.equal(detail.row.simple.needsYou, true);
  assert.equal((await readinessGate(ID, after)).checks.approval.ok, false);
  // Approved on the call.
  io.now = () => after;
  const ok = await post({ action: 'approvedOnCall' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const lc = ok.body.launchCall;
  assert.deepEqual([lc.status, lc.approvedOnCall, lc.heldAt, lc.label], ['held', after.toISOString(), after.toISOString(), 'Approved on the call — sending can start']);
  const seq = await getStoredSequence(ID);
  assert.deepEqual([seq.approvalMode, seq.approvedBy, seq.approvedAt], ['call', 'Limeth Sith', after.toISOString()]);
  const a = await getApproval(ID);
  assert.deepEqual(['profile', 'list', 'copy'].map((s) => [a.sections[s].status, a.sections[s].by]), [['approved', 'call'], ['approved', 'call'], ['approved', 'call']]);
  const gate = await readinessGate(ID, after);
  assert.deepEqual(gate.checks.approval, { ok: true, mode: 'call' }, 'Day 1 reads the new approval');
  assert.equal((await getClient(ID)).launchCallOpen, '0');
  assert.equal((await getMeeting((await readCall(ID, 'launch')).meetingId)).status, 'held', 'the calendar meeting is held too');
  detail = await hubClient(ID, { now: at(after, 1) });
  assert.equal(detail.row.simple.label, 'Launch call done — first emails on Wednesday 21 October');
  assert.equal(detail.row.simple.needsYou, false);
  assert.match(detail.row.systems.find((s) => s.key === 'copy').line, /^Approved by the launch call/);
  assert.equal(detail.sequence.approvalMode, 'call');
  // Pressing it again changes nothing; the plain approval job is done with it.
  assert.equal((await post({ action: 'approvedOnCall' })).status, 200);
  assert.deepEqual(await job(at(after, 2)), { approved: true });
  // A reply after the call went into the conversation (from them, answering the invite), not the closed call.
  inbox = [mail('Thanks, that was helpful.', { at: at(after, 3), inviteId })];
  await check(at(after, 4));
  assert.equal((await readThread(ID)).at(-1).kind, 'reply');
  assert.equal((await activeCall(ID)).kind, 'onboarding', 'no call in play any more');
});

test('Call done in the Calendar without the OK: the to-do asks for Approved on the call', async () => {
  await invited();
  io.now = () => at(FRI, 1);
  await post({ action: 'markBooked', when: TUE_20_11 });
  const meetingId = (await readCall(ID, 'launch')).meetingId;
  const now = new Date('2026-10-20T16:00:00Z');
  await calendarAction({ action: 'held', id: meetingId }, { now });
  const detail = await hubClient(ID, { now: at(now, 1) });
  assert.equal(detail.launchCall.status, 'held');
  assert.equal(detail.launchCall.label, 'Call done — press Approved on the call if they gave the OK');
  const mark = detail.row.todo.find((t) => t.id === `launch-mark:${ID}`);
  assert.equal(mark.text, 'Press Approved on the call for Sam Test — the launch call is done');
  assert.deepEqual([detail.row.simple.needsYou, detail.row.simple.next], [true, 'Press Approved on the call if they gave the OK']);
  assert.equal((await getStoredSequence(ID)).approvedAt, undefined, 'Call done alone approves nothing');
});

// ── reminders, overdue, stop ─────────────────────────────────────────────────

test('launch reminders at 24 h / 72 h in the same thread with the approval page, overdue once (launch_overdue), stopReminders; the check covers both kinds', async () => {
  await warming({ now: TUE, warmupDay: 10 });
  await sendLaunchInvite(ID, { now: TUE });
  const invite = toSam()[0];
  assert.equal((await check(at(TUE, 23))).remindersSent, 0);
  const r24 = await check(at(TUE, 24)); // Wed 10:00 ET
  assert.deepEqual([r24.checked, r24.remindersSent], [1, 1], 'the launch call is the one open call');
  const r1 = toSam()[1];
  assert.equal(r1.subject, `Re: ${INVITE_SUBJECT}`);
  assert.equal(r1.inReplyTo, invite.messageId);
  assert.match(r1.text, /Your list and your emails for eCreek IT are ready, and the 30-minute launch call isn't booked yet\./);
  assert.match(r1.text, /Or read and approve them on one page: https:\/\/app\.test\/c\/[^/\s]+\/approve/);
  assert.equal((await check(at(TUE, 24.5))).remindersSent, 0, 'never twice');
  assert.equal((await check(at(TUE, 72.1))).remindersSent, 1, 'Fri 10:06 ET: the 72 h reminder');
  // … and, after the call's own overdue, the delivery watch (docs/IMPROVE-PASS.md C.2): the invite is still
  // unopened 48 business hours on (Thu 10:00 ET) — a quiet alert and a to-do.
  assert.deepEqual(alertKeys(), ['launch_overdue', 'client_email_unopened']);
  assert.match(alerts[0].body, /has not booked the launch call 3 business days after the launch invite/);
  let lc = await launchCallFor(ID, { now: at(TUE, 73) });
  assert.deepEqual([lc.status, lc.overdue, lc.remindersSent, lc.nextReminderAt], ['overdue', true, 2, null]);
  const detail = await hubClient(ID, { now: at(TUE, 73) });
  const od = detail.row.todo.find((t) => t.id === `launch-overdue:${ID}`);
  assert.ok(od && od.urgent);
  assert.deepEqual(od.action, { type: 'view', view: 'detail', clientId: ID, section: 'launchCall' });
  assert.match(detail.row.simple.label, /· launch call still not booked \(overdue\)$/);
  assert.equal((await check(at(TUE, 120))).remindersSent, 0, 'no third reminder');
  assert.deepEqual(alertKeys(), ['launch_overdue', 'client_email_unopened'], 'overdue alerts once');
  // The job runs for a launch call alone.
  const { JOBS } = await import('@/lib/jobs');
  const j = JOBS.find((x) => x.name === 'onboard-calls');
  assert.equal(await j.due({ now: at(TUE, 1), clients: [{ id: ID, state: 'warming', launchCallOpen: '1' }] }), '2026-10-13T11:00');
  assert.equal(await j.due({ now: at(TUE, 1), clients: [{ id: ID, state: 'warming' }] }), null);
  // Stop: nothing more goes by itself, and it is never overdue again.
  io.now = () => at(TUE, 121);
  const stopped = await post({ action: 'stopReminders' });
  assert.deepEqual([stopped.body.launchCall.status, stopped.body.launchCall.stopped], ['stopped', true]);
  // Resend: the invite again in the same thread; the clock restarts.
  const resent = await post({ action: 'resend' });
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  assert.equal(toSam().at(-1).subject, INVITE_SUBJECT);
  assert.ok(toSam().at(-1).references.includes(invite.messageId), 'in the invite\'s thread');
  assert.equal(resent.body.launchCall.sentAt, TUE.toISOString(), 'sentAt stays the first invite');
  assert.equal(resent.body.launchCall.remindersSent, 0);
});

test('the day-before reminder for a launch call carries the Meet link and the approval page', async () => {
  await invited();
  io.now = () => at(FRI, 1);
  await post({ action: 'markBooked', when: TUE_20_11 });
  const meetingId = (await readCall(ID, 'launch')).meetingId;
  await kv.hset(K.meetings(), { [meetingId]: JSON.stringify({ ...(await getMeeting(meetingId)), meetLink: 'https://meet.google.com/abc-defg-hij' }) });
  assert.equal((await check(new Date('2026-10-19T12:30:00Z'))).remindersSent, 0, '08:30 ET Monday: before US hours');
  assert.equal((await check(new Date('2026-10-19T13:30:00Z'))).remindersSent, 1);
  const rem = toSam().at(-1);
  assert.equal(rem.subject, 'Our launch call tomorrow');
  assert.match(rem.text, /our 30-minute launch call is Tuesday 20 October at 11:00 am Eastern Time\./);
  assert.match(rem.text, /Join here: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.match(rem.text, /If you'd like a look before the call: https:\/\/app\.test\/c\/[^/\s]+\/approve/);
  assert.equal((await check(new Date('2026-10-19T15:00:00Z'))).remindersSent, 0, 'once');
});

// ── the reply bot on the launch thread ───────────────────────────────────────

test('the reply bot serves the launch thread: "what times" → the launch booking page + times; a proposed time → a launch meeting request; a price question → the owner', async () => {
  const m = await invited();
  const inviteId = m.messageId;
  inbox = [mail('Hi Limeth,\n\nGreat — what times work for you next week?\n\nSam', { at: at(FRI, 1), inviteId })];
  await check(at(FRI, 1.02)); // a minute later: read, queued, not yet answered
  assert.deepEqual(alertKeys(), ['launch_ready'], 'no onboard_reply: the bot has it');
  assert.equal(toSam().length, 1, 'the bot waits its 3 minutes');
  await check(at(FRI, 1.1)); // past the delay
  const bot = toSam().at(-1);
  assert.equal(bot.subject, `Re: ${INVITE_SUBJECT}`);
  assert.equal((bot.text.match(/^• /gm) || []).length, 3, 'three open times');
  const link = bot.text.match(/https:\/\/app\.test\/c\/([^/\s]+)\/book\b/);
  assert.deepEqual((await readToken(link[1], { purpose: 'book' })).data, { kind: 'launch' }, 'the booking page for the launch call');
  assert.deepEqual(alertKeys(), ['launch_ready', 'bot_replied']);
  let lc = await launchCallFor(ID, { now: at(FRI, 1.2) });
  assert.deepEqual([lc.status, lc.needsReply, lc.label], ['replied', false, 'The reply bot answered — waiting for them to book']);
  assert.deepEqual((await readThread(ID)).map((t) => [t.kind, t.rule || null]), [['launch_invite', null], ['reply', 'wants_time'], ['auto_reply', 'wants_time']]);
  // They propose a time: a LAUNCH meeting request the owner says yes to in the Calendar.
  inbox = [mail('Tuesday at 11am Eastern works for me.', { at: at(FRI, 2), inviteId })];
  await check(at(FRI, 2.05));
  await check(at(FRI, 2.1));
  lc = await launchCallFor(ID, { now: at(FRI, 2.2) });
  assert.equal(lc.requestedFor, TUE_20_11);
  const meeting = await getMeeting(lc.meetingId);
  assert.deepEqual([meeting.kind, meeting.status, meeting.source, meeting.start, meeting.minutes], ['launch', 'requested', 'reply_bot', TUE_20_11, 30]);
  assert.equal((await calendarView({ now: at(FRI, 2.2) })).requests[0].kind, 'launch', 'the Calendar\'s request carries the kind');
  assert.match(alerts.find((a) => a.key === 'meeting_requested').body, /asked for the launch call at Tue 20 Oct 11:00 am ET/);
  const detail = await hubClient(ID, { now: at(FRI, 2.3) });
  const req = detail.row.todo.find((t) => t.id === `meeting-request:${ID}`);
  assert.equal(req.action.kind, 'launch');
  assert.match(detail.row.simple.label, /· they asked for Tue 20 Oct, 8:30 pm \(your time\) — say yes in the Calendar$/);
  assert.equal(detail.row.simple.needsYou, true);
  // The owner's Yes books the launch call.
  await calendarAction({ action: 'confirm', id: meeting.id }, { now: at(FRI, 3) });
  lc = await launchCallFor(ID, { now: at(FRI, 3.1) });
  assert.deepEqual([lc.status, lc.bookedFor, lc.bookedBy], ['booked', TUE_20_11, 'calendar']);
  assert.match(toSam().at(-1).subject, /^Confirmed: our call on Tue 20 Oct/);
  // A price question mid-trial is not the bot's on this thread: the owner gets it.
  inbox = [mail('Quick one — how much does the plan cost after the trial?', { at: at(FRI, 4), inviteId })];
  await check(at(FRI, 4.05));
  await check(at(FRI, 4.1));
  assert.equal(alertKeys().at(-1), 'onboard_reply');
  assert.match(alerts.at(-1).body, /replied to the launch call email/);
  const detail2 = await hubClient(ID, { now: at(FRI, 4.2) });
  assert.ok(detail2.row.todo.some((t) => t.id === `launch-reply:${ID}` && t.action.section === 'launchCall'));
  assert.equal(detail2.row.simple.next, 'They wrote again — answer them');
});

// ── one launch meeting per client ────────────────────────────────────────────

test('one launch meeting per client: a second pick moves the request; Add a launch call in the calendar refuses while one is open', async () => {
  await invited();
  const first = await requestMeeting(ID, { start: TUE_20_11, zone: 'America/New_York' }, { now: at(FRI, 1), kind: 'launch' });
  assert.deepEqual([first.kind, first.status, first.title], ['launch', 'requested', 'Launch call — eCreek IT']);
  const second = await requestMeeting(ID, { start: '2026-10-20T16:00:00.000Z', zone: 'America/New_York' }, { now: at(FRI, 2), kind: 'launch' });
  assert.equal(second.id, first.id, 'the same meeting, moved');
  assert.equal(second.start, '2026-10-20T16:00:00.000Z');
  const view = await calendarView({ now: at(FRI, 2) });
  assert.equal(view.requests.filter((m) => m.clientId === ID).length, 1);
  await assert.rejects(() => calendarAction({ action: 'add', clientId: ID, kind: 'launch', start: '2026-10-21T15:00:00Z' }, { now: at(FRI, 3) }), /already have a launch call/);
  // The onboarding meeting is another meeting: the two kinds never share one.
  assert.equal((await readCall(ID)).meetingId, undefined);
});

// ── no secret in any hub answer ──────────────────────────────────────────────

test('no secret in the launch call\'s answers: the trial detail, the board, the launch-call route', async () => {
  await invited();
  io.now = () => at(FRI, 1);
  const detail = await hubClient(ID, { now: at(FRI, 1) });
  const board = await hubBoard({ now: at(FRI, 1) });
  const route = await post({ action: 'markBooked', when: TUE_20_11 });
  const text = JSON.stringify({ detail, board, route });
  for (const s of [SECRET_PW, 'app-pw2', 'app-pw']) assert.ok(!text.includes(s), `${s} in a hub answer`);
  assert.ok(!/passwordEnc|tokenEnc|refreshToken/i.test(text));
  // The launchCall view itself, pure: the same fields as onboardCall plus the three new ones and the link.
  const view = onboardCallView({ sentAt: FRI.toISOString(), dueBy: '2026-10-21T14:00:00Z', contactEmail: SAM, approvedOnPage: at(FRI, 3).toISOString() }, [], { now: at(FRI, 4), settings: normaliseSettings(), clientState: 'warming', kind: 'launch', approvalUrl: 'https://app.test/c/t/approve' });
  assert.deepEqual([view.kind, view.status, view.approvedOnPage, view.approvedOnCall, view.skipped, view.approvalUrl], ['launch', 'sent', at(FRI, 3).toISOString(), null, null, 'https://app.test/c/t/approve']);
  for (const k of ['requestedFor', 'proposedFor', 'meetingId', 'meetLink', 'steps', 'thread']) assert.ok(k in view, k);
});
