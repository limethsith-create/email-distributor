// Stage C (SPEC §8) — run systems. Fake KV, stubbed SMTP / IMAP / DNS / Notifier.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { kv, __reset } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { createClient, getClient } from '@/lib/db/client';
import { saveInbox } from '@/lib/db/inboxes';
import { insertLeads, getLead, saveLead } from '@/lib/db/leads';
import { initCounters, getTotals } from '@/lib/db/counters';
import { fill } from '@/lib/templates/render';
import { TEMPLATES } from '@/lib/templates/client/stage-c';
import { setDeps, resetDeps, leadWindowOpen, namedSlots, businessHoursBetween, businessDaysBetween, zonedToUtc } from '@/lib/systems/stagec-common';
import { classifyReply, parseNotNowDate, extractReferral, guessAddresses, processMessage, runHotChaser, runReplies } from '@/lib/systems/replies';
import { runSender, evaluateSmoke, orderFresh, rampCapForDay, isAway } from '@/lib/systems/sender';
import { checkRules, unsubscribeHeaders } from '@/lib/systems/compliance';
import { checkEmail } from '@/lib/systems/copycheck';
import { parseIcs, parseIcsDate, recordBookingEvent, runReminders } from '@/lib/systems/bookings';
import { applyTap, resolveDispute, runScorekeeper, evaluateQualified } from '@/lib/systems/scorekeeper';
import { runEmergency } from '@/lib/systems/emergency';
import { runPace, getPaceLog } from '@/lib/systems/pace';
import { runClientWatch } from '@/lib/systems/clientwatch';
import { recordLearning, rollupNiche } from '@/lib/systems/learning';
import { runTick } from '@/lib/scheduler';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');

// Tue 6 Oct 2026, 11:00 ET (15:00 UTC).
const NOW = new Date('2026-10-06T15:00:00Z');
const ID = 'acme';
const INBOX = 'jane@acme-team.com';
const PROFILE = {
  senderName: 'Jane Doe', postalAddress: '1 Main St, Dover, DE 19901', calendarUrl: 'https://cal.com/jane',
  titles: JSON.stringify(['Owner', 'President', 'IT Director']), excludedTitles: JSON.stringify(['Intern']), industry: 'MSP',
};
const FOOTER = '{SenderName}\n{postalAddress}\n\nNot the right fit? Just reply STOP and I will not email you again.';
const seq = (tag) => ({
  footer: FOOTER,
  touches: [
    { touch: 'd0', thread: 'new', subject: `${tag} idea for {Company}`, body: 'Hi {FirstName},\n\nA short note about {Company}. Worth a chat?' },
    { touch: 'd3', thread: 'd0', body: '{FirstName} — following up. Worth a chat?' },
    { touch: 'd7', thread: 'new', subject: 'Quick one, {FirstName}', body: '{FirstName} — one more idea for {Company}. Open to it?' },
    { touch: 'd10', thread: 'd7', body: '{FirstName} — closing the file. Should I?' },
  ],
});

let sent; let notified; let alerts; let mailbox;
function stubs() {
  sent = []; notified = []; alerts = []; mailbox = [];
  setDeps({
    sendEmail: async (account, opts) => { sent.push({ from: account.email, ...opts }); return { success: true, messageId: `<m${sent.length}@acme-team.com>`, ms: 5 }; },
    notifyClient: async (clientId, key, vars, opts) => { notified.push({ clientId, key, vars, opts }); return { sent: true, messageId: `<n${notified.length}@acme-team.com>` }; },
    alertOwner: async (key, opts) => { alerts.push({ key, ...opts }); return { sent: true }; },
    verifyEmail: async () => ({ valid: true, reason: 'mx_verified' }),
    scanMailbox: async () => ({ ok: true, messages: mailbox.splice(0), uidState: { INBOX: { uidValidity: '1', lastUid: 10 } } }),
  });
}

async function setup({ state = 'sending', leads = [], day1Date = '2026-09-28', dailyCap = '25', cleared = true } = {}) {
  __reset();
  stubs();
  await createClient(ID, { state, name: 'Acme IT', contactEmail: 'boss@acmeit.com', mainDomain: 'acmeit.com' });
  await kv.hset(K.profile(ID), PROFILE);
  await kv.hset(K.trial(ID), { day1Date, firstSendAt: '2026-09-28T13:00:00Z' });
  await saveInbox(ID, { email: INBOX, password: 'app-pass', displayName: 'Jane Doe', enabled: true, dailyCap });
  await kv.hset(K.sequence(ID), { variantA: JSON.stringify(seq('A')), variantB: JSON.stringify(seq('B')), active: 'both', version: 1, approvedAt: '2026-09-20T00:00:00Z' });
  await initCounters(ID);
  if (cleared) await kv.hset(K.sendState(ID), { smokeClearedAt: '2026-09-29T00:00:00Z' });
  if (leads.length) await insertLeads(ID, leads);
}
const lead = (email, extra = {}) => ({ email, first_name: email.split('@')[0].replace(/^\w/, (c) => c.toUpperCase()), company: `${email.split('@')[1].split('.')[0].replace(/^\w/, (c) => c.toUpperCase())} Inc`, tz: 'America/New_York', riskLevel: 'safe', sequenceVariant: 'A', city: 'Dover', title: 'Owner', ...extra });

beforeEach(() => { resetDeps(); });

// ─── Classifier ──────────────────────────────────────────────────────────────

test('classifier: every kind, in the spec order', () => {
  const table = [
    ['I will be forwarding this to our attorney.', 'legal'],
    ['This is harassment. Stop emailing me or I will report you to the FTC.', 'legal'], // legal beats angry
    ['Stop emailing me.', 'angry'],
    ['How did you get my address? This is spam.', 'angry'],
    ['Not interested, stop emailing me', 'angry'], // angry beats no
    ['No thanks.', 'no'],
    ['Please remove me', 'no'],
    ['STOP', 'no'],
    ["We'll pass", 'no'],
    ["I'm not the right person for this — you want to talk to Mike Chen, our IT director.", 'wrongperson'],
    ['Please contact sarah.jones@acme.com, she handles vendors.', 'wrongperson'],
    ['Not right now — maybe next quarter. Are you able to send details?', 'notnow'], // notnow beats interested
    ['Busy until after Thanksgiving, circle back then', 'notnow'],
    ['Interested — tell me more.', 'interested'],
    ['Sounds good. What does it cost?', 'interested'],
    ['Yes', 'interested'],
    ['Who else in Dover have you worked with?', 'question'],
    ['Thanks for the note, received.', 'unclear'],
    ['We are honestly not interested in anything like this at the moment, we have a provider already and are happy', 'unclear'],
  ];
  for (const [text, kind] of table) assert.equal(classifyReply(text).kind, kind, text);
  // Quoted history (which contains "reply STOP") never drives the result.
  assert.equal(classifyReply('Tell me more please\n\nOn Tue, Jane wrote:\n> Not the right fit? Just reply STOP').kind, 'interested');
});

test('not-now date reader', () => {
  const now = new Date('2026-09-24T15:00:00Z');
  const d = (t) => parseNotNowDate(t, now).date;
  assert.equal(d('Try me in January'), '2027-01-01');
  assert.equal(d('Check back after October'), '2026-11-01');
  assert.equal(d('Maybe in Q1'), '2027-01-01');
  assert.equal(d('Q4 would be better'), '2026-10-01');
  assert.equal(d('next quarter'), '2026-12-23');
  assert.equal(d('next year'), '2027-01-01');
  assert.equal(d('after thanksgiving'), '2026-11-29');
  assert.equal(d('after Christmas'), '2026-12-28');
  assert.equal(d('circle back in May'), '2027-05-01');
  assert.equal(d('we may revisit this later'), '2026-11-23'); // "may" is a verb here → default +60
});

test('wrong-person extraction and address guesses', () => {
  assert.deepEqual(extractReferral("Not the right person — contact Sarah Jones at sarah.jones@acme.com"), { name: 'Sarah Jones', email: 'sarah.jones@acme.com' });
  assert.deepEqual(extractReferral("You'd want to talk to Mike Chen, our IT director."), { name: 'Mike Chen', email: null });
  assert.equal(extractReferral('Try ops@acme.com').email, 'ops@acme.com');
  assert.deepEqual(guessAddresses('Mike Chen', 'acme.com').slice(0, 2), ['mike@acme.com', 'mike.chen@acme.com']);
});

// ─── Windows, caps, compliance ───────────────────────────────────────────────

test('sender window by lead time zone and US holidays', () => {
  const ny = { tz: 'America/New_York' };
  const la = { tz: 'America/Los_Angeles' };
  assert.equal(leadWindowOpen(ny, NOW), true); // 11:00 ET
  assert.equal(leadWindowOpen(la, NOW), false); // 08:00 PT
  assert.equal(leadWindowOpen(la, new Date('2026-10-06T17:00:00Z')), true); // 10:00 PT
  assert.equal(leadWindowOpen(ny, new Date('2026-10-12T15:00:00Z')), false); // Columbus Day
  assert.equal(leadWindowOpen(ny, new Date('2026-10-10T15:00:00Z')), false); // Saturday
  assert.equal(leadWindowOpen(ny, new Date('2026-10-06T21:30:00Z')), false); // 17:30 ET
  const { open } = orderFresh([{ email: 'a@x.com', tz: 'America/Los_Angeles' }, { email: 'b@y.com', tz: 'America/New_York' }], { pace: {}, now: NOW, window: ['09:00', '17:00'] });
  assert.deepEqual(open.map((l) => l.email), ['b@y.com']);
  // risky only when safe / catch-all are exhausted
  const r = orderFresh([{ email: 'r@x.com', riskLevel: 'risky' }, { email: 's@y.com', riskLevel: 'catchall' }], { pace: {}, now: NOW, window: ['09:00', '17:00'] });
  assert.deepEqual(r.open.map((l) => l.email), ['s@y.com']);
  assert.equal(rampCapForDay(1, { '1-2': 8, '3-4': 12, '5-6': 16, '7+': 25 }), 8);
  assert.equal(rampCapForDay(9, { '1-2': 8, '3-4': 12, '5-6': 16, '7+': 25 }), 25);
  assert.equal(isAway({ awayRanges: JSON.stringify([{ from: '2026-10-05', to: '2026-10-07' }]) }, '2026-10-06'), true);
  assert.equal(namedSlots('America/Chicago', NOW)[0].label.includes('Wednesday'), true);
  assert.ok(Math.abs(businessHoursBetween(Date.parse('2026-10-09T20:00:00Z'), Date.parse('2026-10-13T20:00:00Z')) - 24) < 0.01); // Fri → Tue over a weekend + Columbus Day
  assert.equal(businessDaysBetween(Date.parse('2026-10-09T15:00:00Z'), Date.parse('2026-10-14T15:00:00Z')), 2);
  assert.equal(zonedToUtc(2026, 10, 6, 10, 0, 0, 'America/Chicago').toISOString(), '2026-10-06T15:00:00.000Z');
});

test('compliance guard rules', () => {
  const profile = { senderName: 'Jane Doe', postalAddress: '1 Main St, Dover, DE 19901' };
  const good = { to: 'a@x.com', fromName: 'Jane Doe', fromAddress: INBOX, subject: 'Idea for X', text: 'Hi\n\nJane Doe\n1 Main St, Dover, DE 19901\n\nNot the right fit? Just reply STOP and I will not email you again.', headers: unsubscribeHeaders('a@x.com', INBOX) };
  const ctx = { profile, inboxEmails: [INBOX], firstTouch: true, claims: ['we met', 'as discussed', 'your order'] };
  assert.equal(checkRules(good, ctx).ok, true);
  const rule = (patch, extra = {}) => checkRules({ ...good, ...patch }, { ...ctx, ...extra }).rule;
  assert.equal(rule({}, { blockedReason: 'suppressed' }), 'suppressed');
  assert.equal(rule({}, { blockedReason: 'blocklist:domain' }), 'blocklist');
  assert.equal(rule({ fromName: 'Someone Else' }), 'from_name');
  assert.equal(rule({ fromAddress: 'x@gmail.com' }), 'from_address');
  assert.equal(rule({ text: 'Hi\n\nreply STOP' }), 'postal_address');
  assert.equal(rule({ text: 'Hi 1 Main St, Dover, DE 19901' }), 'optout_line');
  assert.equal(rule({ subject: 'RE: Idea for X' }), 'first_touch_re');
  assert.equal(checkRules({ ...good, subject: 'Re: Idea for X' }, { ...ctx, firstTouch: false }).ok, true);
  assert.equal(rule({ text: `As discussed on the phone. ${good.text}` }), 'misleading_claim');
  assert.equal(rule({ headers: {} }), 'list_unsubscribe');
  assert.equal(rule({ headers: { 'List-Unsubscribe': unsubscribeHeaders('a@x.com', INBOX)['List-Unsubscribe'] } }), 'list_unsubscribe_post');
  assert.equal(checkEmail({ text: 'Hi {FirstName}' }, profile).failures.some((f) => f.rule === 'unfilled_slot'), true);
  assert.equal(checkEmail({ subject: 'Idea for X', body: 'Hi\n\nWorth a chat?', text: `Hi\n\nWorth a chat?\n\n${good.text}` }, profile).ok, true);
});

test('three compliance blocks in a day alert the owner', async () => {
  await setup();
  const { recordBlock } = await import('@/lib/systems/compliance');
  for (let i = 0; i < 3; i++) await recordBlock(ID, 'postal_address', 'missing', { now: NOW });
  assert.equal(alerts.filter((a) => a.key === 'compliance_block').length, 1);
});

// ─── Sender ──────────────────────────────────────────────────────────────────

test('sender: one email per inbox per tick, counters, threading, no double send', async () => {
  await setup({ leads: [lead('ann@alpha.com'), lead('bob@beta.com'), lead('cy@alpha.com'), lead('dee@west.com', { tz: 'America/Los_Angeles' })] });
  const r1 = await runSender(ID, { now: NOW });
  assert.equal(r1.sent, 1);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.noTrack, true);
  assert.match(m.subject, /idea for [A-Z][a-z]+$/); // Copy v2 writes the company without its legal suffix ("Alpha", not "Alpha Inc")
  assert.match(m.text, /1 Main St, Dover, DE 19901/);
  assert.match(m.headers['List-Unsubscribe'], /\/api\/unsubscribe\?t=/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.notEqual(m.to, 'dee@west.com'); // 08:00 in LA
  const t = await getTotals(ID);
  assert.equal(t.sent, 1); assert.equal(t.sentD0, 1); assert.equal(t.companiesContacted, 1);
  const l = await getLead(ID, m.to);
  assert.equal(l.status, 'in_sequence'); assert.equal(l.account_used, INBOX); assert.equal(l.sentVariant, 'A');
  assert.equal(await kv.hget(K.msgIndex(ID), 'm1@acme-team.com'), m.to);
  // same minute again: the inbox is paced → nothing more
  const r2 = await runSender(ID, { now: NOW });
  assert.equal(r2.sent, 0);
  assert.equal(sent.length, 1);
  // heartbeat for the Watchdog
  assert.ok((await kv.hgetall(K.heartbeat())).lastSendAt);

  // follow-up 3 days later threads on the first email
  await kv.del(K.pacing(ID));
  const later = new Date('2026-10-09T15:00:00Z');
  await runSender(ID, { now: later });
  const fu = sent.find((s) => s.to === m.to && s !== m);
  assert.ok(fu, 'd3 follow-up sent');
  assert.equal(fu.subject, `Re: ${m.subject}`);
  assert.equal(fu.inReplyTo, '<m1@acme-team.com>');
});

test('sender: same tick twice through the scheduler → one send', async () => {
  await setup({ leads: [lead('ann@alpha.com'), lead('bob@beta.com')] });
  await Promise.all([runTick({ source: 'a', now: NOW, clientId: ID }), runTick({ source: 'b', now: NOW, clientId: ID })]);
  assert.equal(sent.length, 1);
});

test('sender: state, legal hold, holiday and suppression gates', async () => {
  await setup({ state: 'paused', leads: [lead('ann@alpha.com')] });
  assert.match((await runSender(ID, { now: NOW })).skipped, /state paused/);
  await setup({ leads: [lead('ann@alpha.com')] });
  await kv.hset(K.client(ID), { legalHoldAt: NOW.toISOString() });
  assert.match((await runSender(ID, { now: NOW })).skipped, /legal hold/);
  await setup({ leads: [lead('ann@alpha.com')] });
  assert.match((await runSender(ID, { now: new Date('2026-10-12T15:00:00Z') })).skipped, /outside/);
  await setup({ leads: [lead('ann@alpha.com')] });
  await kv.sadd(K.suppression(), 'ann@alpha.com');
  const r = await runSender(ID, { now: NOW });
  assert.equal(sent.length, 0);
  assert.equal((await getLead(ID, 'ann@alpha.com')).status, 'suppressed');
  assert.equal(r.sent, 0);
});

test('sender: ready → sending on Day 1 and the first send dates the trial', async () => {
  await setup({ state: 'ready', leads: [lead('ann@alpha.com')], day1Date: '2026-10-05' });
  await kv.hdel(K.trial(ID), 'firstSendAt');
  await runSender(ID, { now: NOW });
  assert.equal((await getClient(ID)).state, 'sending');
  const tr = await kv.hgetall(K.trial(ID));
  assert.equal(tr.day1Date, '2026-10-06');
  assert.equal(tr.day30Date, '2026-11-04');
  assert.ok(tr.firstSendAt);
});

test('sender: first-50 smoke test holds, then clears or fails', async () => {
  await setup({ leads: [lead('ann@alpha.com')], cleared: false });
  await kv.hset(K.countersTotal(ID), { sent: 50, bounces: 1 });
  const r = await runSender(ID, { now: NOW });
  assert.equal(r.held, 'smoke test');
  assert.equal(sent.length, 0);
  let st = await kv.hgetall(K.sendState(ID));
  assert.ok(st.smokeReachedAt && (await getClient(ID)).bounceScanWantedAt);
  // first scan done, 2% → wait for the 2 h re-scan
  await kv.hset(K.sendState(ID), { bounceScanDoneAt: new Date(NOW.getTime() + 60000).toISOString() });
  assert.equal((await evaluateSmoke(ID, new Date(NOW.getTime() + 120000))).waiting, 'second scan time');
  const t2 = new Date(NOW.getTime() + 2 * 3600e3 + 60000);
  assert.equal((await evaluateSmoke(ID, t2)).waiting, 'second scan');
  await kv.hset(K.sendState(ID), { bounceScanDoneAt: new Date(t2.getTime() + 60000).toISOString() });
  assert.equal((await evaluateSmoke(ID, new Date(t2.getTime() + 120000))).cleared, true);

  await setup({ leads: [lead('ann@alpha.com')], cleared: false });
  await kv.hset(K.countersTotal(ID), { sent: 50, bounces: 2 });
  await runSender(ID, { now: NOW });
  await kv.hset(K.sendState(ID), { bounceScanDoneAt: new Date(NOW.getTime() + 60000).toISOString() });
  assert.equal((await evaluateSmoke(ID, new Date(NOW.getTime() + 120000))).failed, true);
  assert.equal((await getClient(ID)).emergencyRequested, 'smoke_bounce');
  st = await kv.hgetall(K.sendState(ID));
  assert.ok(st.smokeFailedAt);
});

test('sender: a recipient reject bounces the lead and asks for a bounce scan', async () => {
  await setup({ leads: [lead('ann@alpha.com')] });
  setDeps({ sendEmail: async () => ({ success: false, kind: 'recipient', error: '550 no such user', response: '550 5.1.1 user unknown' }) });
  await runSender(ID, { now: NOW });
  assert.equal((await getLead(ID, 'ann@alpha.com')).status, 'bounced');
  assert.equal((await getTotals(ID)).bounces, 1);
  assert.ok((await getClient(ID)).bounceScanWantedAt);
});

// ─── Replies ─────────────────────────────────────────────────────────────────

async function emailedLead(email, extra = {}) {
  await insertLeads(ID, [lead(email, extra)]);
  const l = await getLead(ID, email);
  await saveLead(ID, { ...l, status: 'in_sequence', sent_at: '2026-10-01T15:00:00Z', account_used: INBOX, original_subject: 'A idea for X', original_message_id: `<orig-${email}>`, sentVariant: 'A', sentVersion: 1 }, l.status);
  await kv.hset(K.msgIndex(ID), { [`orig-${email}`]: email });
}
const ctxFor = async () => {
  const { loadPace } = await import('@/lib/systems/sender');
  return { client: await getClient(ID), profile: await kv.hgetall(K.profile(ID)), trial: await kv.hgetall(K.trial(ID)), pace: await loadPace(ID), inboxEmails: [INBOX], clientAddrs: ['boss@acmeit.com'], clientHost: 'acmeit.com', niche: 'msp' };
};
const msg = (from, text, extra = {}) => ({ uid: Math.floor(Math.random() * 1e6), folder: 'INBOX', inbox: INBOX, messageId: `<r${Math.random().toString(36).slice(2)}@x.com>`, from, subject: 'Re: A idea for X', date: NOW.toISOString(), headers: {}, threadIds: [`orig-${from}`], kind: 'human', text, ...extra });

test('reply handler: interested → two named slots in-thread + hot lead, counted once', async () => {
  await setup();
  await emailedLead('ann@alpha.com');
  const m = msg('ann@alpha.com', 'Interested — tell me more.');
  const r = await processMessage(ID, m, await ctxFor(), NOW);
  assert.equal(r.kind, 'interested');
  const reply = sent.find((s) => s.to === 'ann@alpha.com');
  assert.ok(reply);
  assert.equal(reply.subject, 'Re: A idea for X');
  assert.equal(reply.inReplyTo, m.messageId);
  assert.match(reply.text, /Wednesday, October 7 at 10:00 AM EDT/);
  assert.match(reply.text, /Thursday, October 8 at 2:00 PM EDT/);
  assert.match(reply.text, /https:\/\/cal\.com\/jane/);
  const hot = notified.find((n) => n.key === 'hot_lead');
  assert.ok(hot);
  assert.equal(fill('t', TEMPLATES.hot_lead.subject, hot.vars), 'Hot — Alpha Inc, Ann, Owner');
  const t = await getTotals(ID);
  assert.equal(t.replies, 1); assert.equal(t.positive, 1);
  const recs = Object.values(await kv.hgetall(K.replies(ID)));
  assert.equal(recs[0].kind, 'interested'); assert.ok(recs[0].forwardedToClientAt); assert.ok(recs[0].handledAt);
  assert.equal((await getLead(ID, 'ann@alpha.com')).status, 'replied');
  // the same message again does nothing
  await processMessage(ID, m, await ctxFor(), NOW);
  assert.equal(sent.filter((s) => s.to === 'ann@alpha.com').length, 1);
  assert.equal((await getTotals(ID)).replies, 1);
});

test('reply handler: no / legal / ooo / warm-up / bounce / wrong person / not now', async () => {
  await setup();
  for (const e of ['no@a.com', 'law@b.com', 'ooo@c.com', 'warm@d.com', 'dead@e.com', 'wrong@f.com', 'later@g.com']) await emailedLead(e);
  const ctx = await ctxFor();
  await processMessage(ID, msg('no@a.com', 'No thanks.'), ctx, NOW);
  assert.equal(await kv.sismember(K.suppression(), 'no@a.com'), 1);
  assert.ok(sent.find((s) => s.to === 'no@a.com' && /Taken you off the list/.test(s.text)));

  await processMessage(ID, msg('law@b.com', 'My attorney will be in touch.'), ctx, NOW);
  assert.ok((await getClient(ID)).legalHoldAt);
  assert.ok(alerts.find((a) => a.key === 'legal_reply'));
  assert.equal(sent.filter((s) => s.to === 'law@b.com').length, 0);

  const ooo = await processMessage(ID, msg('ooo@c.com', 'I am out of the office until October 20.', { kind: 'ooo', subject: 'Out of office' }), ctx, NOW);
  assert.equal(ooo.kind, 'ooo');
  assert.match((await getLead(ID, 'ooo@c.com')).holdUntil, /^2026-10-20/);

  const w = await processMessage(ID, msg('warm@d.com', 'hello', { headers: { 'x-aviance-warm': 'abc' } }), ctx, NOW);
  assert.equal(w.skipped, 'warm-up');

  const dsn = await processMessage(ID, msg('mailer-daemon@googlemail.com', 'Delivery to the following recipient failed permanently:\n\n dead@e.com\n\nStatus: 5.1.1 user unknown\nAction: failed', { kind: 'dsn', threadIds: [] }), ctx, NOW);
  assert.equal(dsn.bounce, 'dead@e.com');
  assert.equal((await getLead(ID, 'dead@e.com')).status, 'bounced');

  await processMessage(ID, msg('wrong@f.com', 'Not the right person — contact Sarah Jones at sarah@f.com'), ctx, NOW);
  const ref = await getLead(ID, 'sarah@f.com');
  assert.equal(ref.source, 'referral'); assert.equal(ref.referrerName, 'Wrong');
  assert.equal((await getLead(ID, 'wrong@f.com')).status, 'suppressed');

  await processMessage(ID, msg('later@g.com', 'Not now — try me in January.'), ctx, NOW);
  const later = await getLead(ID, 'later@g.com');
  assert.equal(later.status, 'notnow'); assert.equal(later.notnowDate, '2027-01-01');
  assert.ok(sent.find((s) => s.to === 'later@g.com' && /check back in January/.test(s.text)));
});

test('reply job: every inbox per run, then the hot-lead chaser (4 h nudge, 24 h holding reply)', async () => {
  await setup();
  await emailedLead('ann@alpha.com');
  mailbox.push(msg('ann@alpha.com', 'Who else have you worked with?'));
  const r = await runReplies(ID, { now: NOW });
  assert.equal(r.scan.inboxes.length, 1);
  assert.equal(r.scan.inboxes[0].messages, 1);
  assert.deepEqual(r.scan.inboxes[0].results, ['question']);
  assert.ok(await kv.hget(K.imapState(ID), `replies|${INBOX}|INBOX`));
  // A second run with nothing new writes nothing (Redis budget).
  const { __commandsBy, __resetCommands } = await import('@vercel/kv');
  __resetCommands();
  await runReplies(ID, { now: new Date(NOW.getTime() + 60_000) });
  assert.equal(__commandsBy().hset || 0, 0);
  const n0 = notified.length;
  await runHotChaser(ID, new Date(NOW.getTime() + 5 * 3600e3));
  assert.equal(notified.length, n0 + 1);
  assert.equal(notified[notified.length - 1].key, 'hot_lead_nudge');
  await runHotChaser(ID, new Date(NOW.getTime() + 25 * 3600e3));
  assert.ok(sent.find((s) => s.to === 'ann@alpha.com' && /will be in touch shortly/.test(s.text)));
  assert.equal(Number((await kv.hgetall(K.trial(ID))).unansweredHot), 1);
  // the client answers in the hot-lead thread → answered, counter back down
  const hotRec = Object.values(await kv.hgetall(K.hot(ID)))[0];
  await processMessage(ID, msg('boss@acmeit.com', 'On it', { threadIds: [hotRec.hotMessageId.replace(/[<>]/g, '')] }), await ctxFor(), NOW);
  assert.ok(Object.values(await kv.hgetall(K.hot(ID)))[0].answeredAt);
  assert.equal(Number((await kv.hgetall(K.trial(ID))).unansweredHot), 0);
});

test('exit interview reply is stored verbatim', async () => {
  await setup();
  await kv.hset(K.trial(ID), { exitInterviewSentAt: '2026-10-05T00:00:00Z', exitInterviewMessageId: '<exit1@acme-team.com>' });
  await processMessage(ID, msg('boss@acmeit.com', 'Honestly the timing was wrong for us.', { threadIds: ['exit1@acme-team.com'] }), await ctxFor(), NOW);
  assert.equal((await kv.hgetall(K.trial(ID))).exitReason, 'Honestly the timing was wrong for us.');
});

// ─── Bookings + scorekeeper ──────────────────────────────────────────────────

const ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:evt-123@cal.com', 'SEQUENCE:0',
  'DTSTART;TZID=America/Chicago:20261008T100000', 'DTEND;TZID=America/Chicago:20261008T103000',
  'SUMMARY:Intro call', 'ORGANIZER;CN=Jane Doe:mailto:jane@acme-team.com',
  'ATTENDEE;CN="Ann Smith";PARTSTAT=ACCEPTED:mailto:ann@alpha.c',
  ' om', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

test('ICS parsing: TZID, UTC, Windows zone names, folded lines, cancel', () => {
  const [ev] = parseIcs(ICS);
  assert.equal(ev.uid, 'evt-123@cal.com');
  assert.equal(ev.start.toISOString(), '2026-10-08T15:00:00.000Z');
  assert.equal(ev.attendees[0].email, 'ann@alpha.com');
  assert.equal(ev.attendees[0].name, 'Ann Smith');
  assert.equal(ev.organizer.email, 'jane@acme-team.com');
  assert.equal(ev.method, 'REQUEST');
  assert.equal(parseIcsDate('20261008T150000Z').date.toISOString(), '2026-10-08T15:00:00.000Z');
  assert.equal(parseIcsDate('20261008T100000', { TZID: 'Pacific Standard Time' }).date.toISOString(), '2026-10-08T17:00:00.000Z');
  assert.equal(parseIcsDate('20261008', { VALUE: 'DATE' }).allDay, true);
  const [c] = parseIcs('BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:x\nDTSTART:20261008T150000Z\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(c.method, 'CANCEL');
});

async function booked() {
  await setup();
  await emailedLead('ann@alpha.com', { title: 'Owner' });
  const ctx = { exclude: new Set([INBOX, 'boss@acmeit.com']), niche: 'msp' };
  const [ev] = parseIcs(ICS);
  const r = await recordBookingEvent(ID, ev, { now: NOW, ctx });
  return r.id;
}

test('booking: created, matched, handoff sent, booked counted once, reminders + tap', async () => {
  const id = await booked();
  const b = (await kv.hgetall(K.bookings(ID)))[id];
  assert.equal(b.leadEmail, 'ann@alpha.com'); assert.equal(b.status, 'booked'); assert.equal(b.source, 'link');
  assert.ok(b.threadForwardedAt);
  assert.ok(notified.find((n) => n.key === 'call_handoff'));
  assert.equal((await getTotals(ID)).booked, 1);
  // same invite again → nothing new
  const [ev] = parseIcs(ICS);
  await recordBookingEvent(ID, ev, { now: NOW, ctx: { exclude: new Set([INBOX]), niche: 'msp' } });
  assert.equal((await getTotals(ID)).booked, 1);
  // 24 h reminder window (call is 2026-10-08 15:00 UTC)
  await runReminders(ID, { now: new Date('2026-10-07T16:00:00Z') });
  assert.ok(sent.find((s) => s.to === 'ann@alpha.com' && /quick reminder/.test(s.text)));
  await runReminders(ID, { now: new Date('2026-10-08T14:30:00Z') });
  assert.ok(sent.find((s) => s.to === 'ann@alpha.com' && /talk in an hour/.test(s.text)));
  await runReminders(ID, { now: new Date('2026-10-08T16:05:00Z') });
  const tap = notified.find((n) => n.key === 'call_tap');
  assert.ok(tap && /\/c\/.+\/tap\?a=showed/.test(tap.vars.showedUrl));
});

test('scorekeeper: showed → held + qualified; dispute window, reason and owner decision', async () => {
  const id = await booked();
  const after = new Date('2026-10-08T17:00:00Z');
  await applyTap(ID, id, 'showed', { now: after });
  let t = await getTotals(ID);
  assert.equal(t.held, 1); assert.equal(t.qualified, 1);
  assert.equal((await applyTap(ID, id, 'dispute', { now: after })).ok, false); // reason required
  assert.equal((await applyTap(ID, id, 'dispute', { reason: 'title', now: after })).ok, true);
  t = await getTotals(ID);
  assert.equal(t.qualified, 0);
  assert.ok(alerts.find((a) => a.key === 'dispute'));
  await resolveDispute(ID, id, 'overturn', { now: after });
  assert.equal((await getTotals(ID)).qualified, 1);
  // a second dispute after 24 business hours is refused
  const res = await applyTap(ID, id, 'dispute', { reason: 'profile', now: new Date('2026-10-13T17:00:00Z') });
  assert.equal(res.ok, false);
  assert.match(res.error, /window/);
});

test('scorekeeper: dispute auto-upheld after 48 h; late dispute refused', async () => {
  const id = await booked();
  await applyTap(ID, id, 'showed', { now: new Date('2026-10-08T17:00:00Z') });
  const late = await applyTap(ID, id, 'dispute', { reason: 'profile', now: new Date('2026-10-12T17:00:00Z') }); // Fri+Mon(holiday) … > 24 business h
  assert.equal(late.ok, false);
  await applyTap(ID, id, 'dispute', { reason: 'profile', now: new Date('2026-10-08T18:00:00Z') });
  await runScorekeeper(ID, { now: new Date('2026-10-10T19:00:00Z') });
  const b = (await kv.hgetall(K.bookings(ID)))[id];
  assert.equal(b.disputeResolution, 'upheld_auto');
  assert.equal((await getTotals(ID)).qualified, 0);
});

test('qualified definition edge cases', () => {
  const profile = { titles: JSON.stringify(['Owner', 'IT Director']), excludedTitles: JSON.stringify(['Intern']) };
  const held = { status: 'held', source: 'link', attendedTapAt: 'x' };
  assert.equal(evaluateQualified({ booking: held, lead: { title: 'Owner' }, profile }).qualified, true);
  assert.equal(evaluateQualified({ booking: held, lead: { title: 'Marketing Intern' }, profile }).qualified, false);
  assert.equal(evaluateQualified({ booking: held, lead: { title: '' }, profile }).qualified, true); // no title, Showed
  assert.equal(evaluateQualified({ booking: { ...held, attendedTapAt: null }, lead: {}, profile }).qualified, false);
  assert.equal(evaluateQualified({ booking: held, lead: { title: 'Owner' }, profile, blocklisted: true }).qualified, false); // competitor
  assert.equal(evaluateQualified({ booking: { ...held, colleague: true, attendeeTitle: 'IT Director' }, lead: { title: 'Owner' }, profile }).qualified, true);
  assert.equal(evaluateQualified({ booking: { ...held, source: 'manual' }, lead: { title: 'Owner' }, profile }).qualified, false);
  assert.equal(evaluateQualified({ booking: { ...held, status: 'noshow' }, lead: { title: 'Owner' }, profile }).qualified, false);
});

test('no-show ladder: re-book emails at 0 / 3 / 7 days, closed at 14; re-book counts once', async () => {
  const id = await booked();
  const t0 = new Date('2026-10-08T17:00:00Z');
  await applyTap(ID, id, 'noshow', { now: t0 });
  assert.equal((await getTotals(ID)).noshows, 1);
  const rebooks = () => sent.filter((s) => s.to === 'ann@alpha.com' && /sorry we missed each other/.test(s.text)).length;
  assert.equal(rebooks(), 1);
  await runScorekeeper(ID, { now: new Date(t0.getTime() + 1 * 864e5) });
  assert.equal(rebooks(), 1);
  await runScorekeeper(ID, { now: new Date(t0.getTime() + 3.1 * 864e5) });
  assert.equal(rebooks(), 2);
  await runScorekeeper(ID, { now: new Date(t0.getTime() + 7.1 * 864e5) });
  assert.equal(rebooks(), 3);
  await runScorekeeper(ID, { now: new Date(t0.getTime() + 8 * 864e5) });
  assert.equal(rebooks(), 3);
  // re-booked: old booking → rebooked, booked stays 1
  const ev = { uid: 'evt-456', method: 'REQUEST', start: new Date('2026-10-20T15:00:00Z'), attendees: [{ email: 'ann@alpha.com' }] };
  const r = await recordBookingEvent(ID, ev, { now: new Date(t0.getTime() + 9 * 864e5), ctx: { exclude: new Set([INBOX]), niche: 'msp' } });
  assert.equal((await kv.hgetall(K.bookings(ID)))[id].status, 'rebooked');
  assert.equal((await getTotals(ID)).booked, 1);
  await applyTap(ID, r.id, 'showed', { now: new Date('2026-10-20T17:00:00Z') });
  assert.equal((await getTotals(ID)).held, 1);
  assert.ok(alerts.find((a) => a.key === 'noshow_high'));
});

test('client-side no-show: apology to the prospect, counts as held, owner alert', async () => {
  const id = await booked();
  await applyTap(ID, id, 'client_noshow', { now: new Date('2026-10-08T17:00:00Z') });
  assert.ok(sent.find((s) => s.to === 'ann@alpha.com' && /that was on our side/.test(s.text)));
  assert.equal((await getTotals(ID)).held, 1);
  assert.ok(alerts.find((a) => a.key === 'client_noshow'));
});

// ─── Emergency ───────────────────────────────────────────────────────────────

test('emergency: bounce trigger → pause, notice, re-verify, resume halved; 3 green days restore', async () => {
  await setup({ leads: [lead('ann@alpha.com'), lead('bad@nomx.com')] });
  await kv.hset(K.countersDay(ID, '2026-10-06'), { sent: 60, bounces: 3 });
  setDeps({ verifyEmail: async (e) => (e.includes('nomx') ? { valid: false, reason: 'no_mx' } : { valid: true }) });
  const r1 = await runEmergency(ID, { now: NOW });
  assert.equal(r1.started.code, 'bounce');
  let c = await getClient(ID);
  assert.equal(c.state, 'paused'); assert.equal(c.emergencyActive, '1');
  assert.ok(alerts.find((a) => a.key === 'emergency'));
  assert.ok(notified.find((n) => n.key === 'deliverability_notice'));
  const r2 = await runEmergency(ID, { now: new Date(NOW.getTime() + 60000) });
  assert.equal(r2.resumed, true);
  c = await getClient(ID);
  assert.equal(c.state, 'sending'); assert.equal(c.emergencyActive, '0'); assert.equal(c.emergencyHalved, '1');
  assert.equal((await getLead(ID, 'bad@nomx.com')).status, 'done');
  assert.equal((await kv.hgetall(K.inbox(ID, INBOX))).dailyCap, '12');
  // green business days: Wed 7, Thu 8, Fri 9 (checked the morning after)
  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) await kv.hset(K.countersDay(ID, day), { sent: 20, bounces: 0, replies: 1 });
  await runEmergency(ID, { now: new Date('2026-10-08T12:00:00Z') });
  await runEmergency(ID, { now: new Date('2026-10-09T12:00:00Z') });
  assert.equal((await getClient(ID)).emergencyHalved, '1');
  await runEmergency(ID, { now: new Date('2026-10-10T12:00:00Z') });
  assert.equal((await getClient(ID)).emergencyHalved, '0');
  assert.ok(alerts.find((a) => a.key === 'emergency_resolved'));
});

test('emergency: canary request consumed; blacklisted domain is burned and stays paused', async () => {
  await setup();
  await kv.hset(K.client(ID), { emergencyRequested: 'canary' });
  const r = await runEmergency(ID, { now: NOW });
  assert.equal(r.started.code, 'canary');
  assert.equal((await getClient(ID)).emergencyRequested, '');
  await kv.hset(K.domain(ID), { name: 'acme-team.com', blacklist: 'listed' });
  let excluded = null;
  setDeps({ pricescout: { replacementShoppingList: async (_id, { exclude }) => { excluded = exclude; return 'Shopping list: acmehq.com'; } } });
  const r2 = await runEmergency(ID, { now: new Date(NOW.getTime() + 60000) });
  assert.equal(r2.burned, true);
  assert.ok((await kv.hgetall(K.domain(ID))).retiredAt);
  assert.deepEqual(excluded, ['acme-team.com']);
  assert.match(alerts.find((a) => a.key === 'domain_burned').body, /acmehq\.com/);
  assert.equal((await getClient(ID)).state, 'paused');
  assert.equal((await runEmergency(ID, { now: new Date(NOW.getTime() + 120000) })).waiting, 'domain replacement (owner)');
});

test('emergency: no trigger on a healthy client', async () => {
  await setup();
  await kv.hset(K.countersDay(ID, '2026-10-06'), { sent: 60, bounces: 1, replies: 2 });
  const r = await runEmergency(ID, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal((await getClient(ID)).state, 'sending');
});

// ─── Pace checks ─────────────────────────────────────────────────────────────

test('pace checks: fixes per day, logged, profile untouched', async () => {
  await setup();
  const profileBefore = JSON.stringify(await kv.hgetall(K.profile(ID)));
  const setTotals = (t) => kv.hset(K.countersTotal(ID), t);
  await setTotals({ sent: 50, bounces: 2, replies: 0, positive: 0, booked: 0, held: 0, qualified: 0, wrongfit: 0, companiesContacted: 48 });
  assert.equal((await runPace(ID, { now: NOW, day: 3 })).test.startsWith('bounce'), true);
  assert.equal((await getClient(ID)).emergencyRequested, 'pace_day3');

  // Day 7 when the backup copy cannot be built (profile has no one-liner / ICP): nothing changes, the owner is told
  await setTotals({ sent: 300, replies: 1 });
  const d7 = await runPace(ID, { now: NOW, day: 7 });
  assert.equal(d7.fix, null);
  assert.ok(alerts.find((a) => a.key === 'copy_blocked' && /backup copy/.test(a.vars.rule)));

  // Day 12: positive 0 → best variant + narrow slice
  await recordLearning(ID, 'sends', { lead: { sentVariant: 'B', sentVersion: 1, city: 'Dover', tz: 'America/New_York' }, niche: 'msp' });
  for (let i = 0; i < 12; i++) await recordLearning(ID, 'sends', { lead: { sentVariant: 'B', city: 'Austin' }, niche: 'msp' });
  await recordLearning(ID, 'replies', { lead: { sentVariant: 'B', city: 'Austin' }, niche: 'msp' });
  const d12 = await runPace(ID, { now: NOW, day: 12 });
  assert.ok(d12.fix);
  assert.equal((await kv.hgetall(K.sequence(ID))).active, 'B');
  assert.deepEqual(JSON.parse((await kv.hgetall(K.pace(ID))).narrowSlice), { field: 'city', value: 'Austin' });

  // Day 15: qualified 0 → off-pace email with real numbers, gaps 3-2-3, early sends
  await setTotals({ sent: 500, replies: 7, positive: 2, qualified: 0, companiesContacted: 240 });
  await runPace(ID, { now: NOW, day: 15 });
  const off = notified.find((n) => n.key === 'offpace_day15');
  assert.equal(off.vars.companies, 240); assert.equal(off.vars.replies, 7); assert.equal(off.vars.positive, 2);
  const pace = await kv.hgetall(K.pace(ID));
  assert.equal(pace.compressed, '1'); assert.equal(pace.earlySend, '1');

  // Day 20: positives but no bookings → soft reply
  await setTotals({ positive: 3, booked: 0 });
  await runPace(ID, { now: NOW, day: 20 });
  assert.equal((await kv.hgetall(K.pace(ID))).softInterested, '1');

  // Day 25: wrong fit → exclude that size band / title
  await insertLeads(ID, [lead('wf@wrong.com', { sizeBand: '50-200', title: 'Office Manager' })]);
  await kv.hset(K.bookings(ID), { bx: { id: 'bx', status: 'wrongfit', leadEmail: 'wf@wrong.com' } });
  await setTotals({ held: 1, wrongfit: 1 });
  await runPace(ID, { now: NOW, day: 25 });
  const ex = JSON.parse((await kv.hgetall(K.pace(ID))).exclude);
  assert.deepEqual(ex, { sizeBands: ['50-200'], titles: ['office manager'] });

  const log = await getPaceLog(ID);
  assert.deepEqual(log.map((l) => l.day).sort((a, b) => a - b), [3, 12, 15, 20, 25]);
  assert.equal(JSON.stringify(await kv.hgetall(K.profile(ID))), profileBefore);
});

test('pace Day 7: Stage B backup copy becomes version 2, old variants kept', async () => {
  await setup();
  await kv.hset(K.profile(ID), { oneLiner: 'We run IT for small offices.', defaultIcp: 'office managers', companyName: 'Acme IT' });
  await kv.hset(K.countersTotal(ID), { sent: 300, bounces: 2, replies: 1, positive: 0, booked: 0, held: 0, qualified: 0, wrongfit: 0, companiesContacted: 280 });
  const d7 = await runPace(ID, { now: NOW, day: 7 });
  assert.ok(d7.fix);
  const s = await kv.hgetall(K.sequence(ID));
  assert.equal(Number(s.version), 2);
  const a = JSON.parse(s.variantA);
  assert.ok(a.variantId && a.touches.length === 4);
  assert.doesNotMatch(JSON.stringify(a), /\{(SenderName|ClientCompany|oneLiner|ICP|postalAddress)\}/);
  assert.ok(s.variantA_v1);
});

test('pace check refuses to run on missing counters', async () => {
  await setup();
  await kv.del(K.countersTotal(ID));
  const r = await runPace(ID, { now: NOW, day: 7 });
  assert.ok(r.blocked.length);
  assert.ok(alerts.find((a) => a.key === 'report_blocked'));
});

// ─── Client watch ────────────────────────────────────────────────────────────

test('client watch: quiet → warn, pause at 5 business days, resume on reply', async () => {
  await setup();
  await kv.hset(K.hot(ID), { r1: { replyId: 'r1', leadEmail: 'ann@alpha.com', sentAt: '2026-10-01T15:00:00Z' } });
  await kv.hset(K.trial(ID), { lastClientActivityAt: '2026-09-30T15:00:00Z' });
  const w = await runClientWatch(ID, { now: new Date('2026-10-05T15:00:00Z') });
  assert.equal(w.warned, true);
  assert.equal((await getClient(ID)).state, 'sending');
  const p = await runClientWatch(ID, { now: new Date('2026-10-09T15:00:00Z') });
  assert.equal(p.paused, true);
  assert.equal((await getClient(ID)).state, 'paused');
  assert.ok(notified.find((n) => n.key === 'paused_quiet'));
  await kv.hset(K.trial(ID), { lastClientActivityAt: '2026-10-09T16:00:00Z' });
  const r = await runClientWatch(ID, { now: new Date('2026-10-09T17:00:00Z') });
  assert.equal(r.resumed, 'sending');
});

test('client buttons: customer hit, stop, away', async () => {
  await setup();
  await emailedLead('ann@alpha.com');
  const { customerHit, stopTrial, setAway } = await import('@/lib/systems/clientwatch');
  const res = await customerHit(ID, { email: 'ann@alpha.com', list: 'bigcustomer.com, someone@gmail.com', now: NOW });
  assert.equal(res.apologySent, true);
  assert.equal(await kv.sismember(K.blocklist(ID), 'alpha.com'), 1);
  assert.equal(await kv.sismember(K.blocklist(ID), 'bigcustomer.com'), 1);
  assert.equal(await kv.sismember(K.blocklist(ID), 'gmail.com'), 0);
  assert.ok(alerts.find((a) => a.key === 'customer_hit'));
  assert.equal((await setAway(ID, { from: '2026-10-12', to: '2026-10-14', now: NOW })).ok, true);
  assert.equal((await setAway(ID, { from: '2026-10-14', to: '2026-10-12', now: NOW })).ok, false);
  assert.equal((await stopTrial(ID, { now: NOW })).ok, true);
  assert.equal((await getClient(ID)).state, 'paused');
  assert.equal((await kv.hgetall(K.trial(ID))).endReason, 'client_stopped');
});

// ─── Learning + templates ────────────────────────────────────────────────────

test('learning library: rollup per niche + variant, best hour and city, no personal data', async () => {
  __reset();
  for (let i = 0; i < 25; i++) await recordLearning('acme', 'sends', { lead: { email: `p${i}@x.com`, sentVariant: 'A', sentVersion: 1, city: 'Dover', tz: 'America/New_York', sent_at: '2026-10-06T14:00:00Z' }, niche: 'msp' });
  for (let i = 0; i < 25; i++) await recordLearning('acme', 'sends', { lead: { sentVariant: 'B', sentVersion: 1, city: 'Austin', tz: 'America/Chicago', sent_at: '2026-10-06T16:00:00Z' }, niche: 'msp' });
  await recordLearning('acme', 'replies', { lead: { sentVariant: 'B', sentVersion: 1, city: 'Austin', tz: 'America/Chicago', sent_at: '2026-10-06T16:00:00Z' }, niche: 'msp' });
  await recordLearning('acme', 'positive', { lead: { sentVariant: 'B', sentVersion: 1, city: 'Austin', tz: 'America/Chicago', sent_at: '2026-10-06T16:00:00Z' }, niche: 'msp' });
  const r = await rollupNiche('msp');
  assert.equal(r.rank[0].variant, 'B1');
  assert.equal(r.bestCity.name, 'Austin');
  assert.equal(r.bestHour.name, '11');
  const view = await kv.hgetall(K.learning('msp'));
  assert.deepEqual(view.A1, { sends: 25, replies: 0, positive: 0, booked: 0 });
  assert.doesNotMatch(JSON.stringify(await kv.hgetall(K.learningRaw('msp'))), /@/);
});

test('every Stage C template renders with sample data and no blank slot', () => {
  const sample = {
    Company: 'Acme', Name: 'Ann', Title: 'Owner', size: '10-50', city: 'Dover', verbatim: 'Tell me more', actionLine: 'x', context: 'Acme — Dover',
    hours: 5, when: 'Thursday 10:00 AM', whyYes: 'Tell me more', asked: 'nothing', thread: 'x', days: 6, showedUrl: 'u', noshowUrl: 'u', wrongfitUrl: 'u', disputeUrl: 'u', clientNoshowUrl: 'u',
    companies: 240, replies: 7, positive: 2, diagnosis: 'd', fix: 'f', pending: 2, FirstName: 'Ann', slot1: 's1', slot2: 's2', calendarUrl: 'c',
    month: 'January', Referrer: 'Bob', Greeting: 'Hi Ann,', oneLiner: 'We fix IT.', SenderName: 'Jane', missedWhen: 'Tuesday', ClientCompany: 'Acme IT',
  };
  const keys = ['hot_lead', 'hot_lead_nudge', 'call_handoff', 'slot_far_warning', 'call_tap', 'call_tap_reminder', 'quote_request', 'offpace_day15', 'deliverability_notice', 'paused_quiet', 'reply_interested', 'reply_interested_soft', 'reply_notnow', 'reply_no', 'reply_wrongperson_thanks', 'referral_intro', 'holding_reply', 'notnow_followup', 'reminder_24h', 'reminder_1h', 'rebook_email', 'apology_reschedule', 'apology_customer'];
  for (const k of keys) {
    const t = TEMPLATES[k];
    assert.ok(t, k);
    if (t.subject) fill(k, t.subject, sample);
    const body = fill(k, t.body, sample);
    assert.doesNotMatch(body, /\{[A-Za-z]/, k);
    if (t.prospect) assert.equal(t.from, 'trial', k);
  }
});

// ─── Jobs, bounce scan, not-now, referrals ───────────────────────────────────

test('jobs: every Stage C client job skips aviance and wrong states', async () => {
  const { JOBS } = await import('@/lib/joblist/stage-c');
  for (const job of JOBS.filter((j) => j.scope === 'client')) {
    assert.equal(await job.due({ client: { id: 'aviance', state: 'sending' }, now: NOW }), null, job.name);
    // Leads v2: lead verification runs from `warming` (the list is built then); every other Stage C job waits.
    if (job.name.startsWith('lead-verify')) continue;
    assert.equal(await job.due({ client: { id: 'acme', state: 'warming' }, now: NOW }), null, job.name);
  }
  const lv = JOBS.find((j) => j.name === 'lead-verify');
  assert.equal(await lv.due({ client: { id: 'acme', state: 'warming' }, now: NOW }), null); // nothing waiting
  assert.ok(await lv.due({ client: { id: 'acme', state: 'warming', verifyPending: '1' }, now: NOW }));
  assert.equal(await lv.due({ client: { id: 'acme', state: 'declined', verifyPending: '1' }, now: NOW }), null);
  const send = JOBS.find((j) => j.name === 'send');
  assert.equal(await send.due({ client: { id: 'acme', state: 'sending' }, now: NOW }), '2026-10-06T11:00');
  assert.equal(await send.due({ client: { id: 'acme', state: 'sending' }, now: new Date('2026-10-12T15:00:00Z') }), null); // holiday
  const em = JOBS.find((j) => j.name === 'emergency');
  // No sends since the last scan: once a day at noon (time-based triggers).
  assert.equal(await em.due({ client: { id: 'acme', state: 'sending' }, now: new Date('2026-10-06T15:03:00Z') }), null);
  assert.equal(await em.due({ client: { id: 'acme', state: 'sending' }, now: new Date('2026-10-06T16:03:00Z') }), '2026-10-06');
  // New sends: a scan in the client's 15-minute slot; a request: this minute.
  assert.match(await em.due({ client: { id: 'acme', state: 'sending', sentSinceScan: '1' }, now: new Date('2026-10-06T15:03:00Z') }), /^2026-10-06T1[01]:\d\d$/);
  assert.equal(await em.due({ client: { id: 'acme', state: 'sending', emergencyRequested: 'canary' }, now: new Date('2026-10-06T15:03:00Z') }), '2026-10-06T11:03');
});

test('sender: cheap idle path when every inbox is paced', async () => {
  await setup({ leads: [lead('ann@alpha.com'), lead('bob@beta.com')] });
  await runSender(ID, { now: NOW, client: await getClient(ID) });
  assert.equal(sent.length, 1);
  const r = await runSender(ID, { now: new Date(NOW.getTime() + 60000), client: await getClient(ID) });
  assert.equal(r.idle, true);
});

test('bounce scan: one pass over the inboxes, DSN bounces the lead, stamps the smoke clock', async () => {
  await setup();
  await emailedLead('dead@e.com');
  await kv.hset(K.client(ID), { bounceScanWantedAt: NOW.toISOString() });
  mailbox.push(msg('mailer-daemon@googlemail.com', 'Final-Recipient: rfc822; dead@e.com\nAction: failed\nStatus: 5.1.1', { kind: 'dsn', threadIds: [] }));
  const { runBounceScan } = await import('@/lib/systems/replies');
  const r = await runBounceScan(ID, { now: NOW });
  assert.equal(r.done, true);
  assert.equal((await getLead(ID, 'dead@e.com')).status, 'bounced');
  assert.equal((await getTotals(ID)).bounces, 1);
  assert.equal((await getClient(ID)).bounceScanWantedAt, '');
  assert.ok((await kv.hgetall(K.sendState(ID))).bounceScanDoneAt);
});

test('not-now follow-up goes once on its date', async () => {
  await setup();
  await emailedLead('later@g.com');
  const l = await getLead(ID, 'later@g.com');
  await saveLead(ID, { ...l, status: 'notnow', notnowDate: '2026-10-06' }, l.status);
  const { runNotNow } = await import('@/lib/systems/replies');
  assert.equal((await runNotNow(ID, { now: NOW })).sent, 1);
  assert.equal((await runNotNow(ID, { now: NOW })).sent, 0);
  const f = sent.find((s) => s.to === 'later@g.com');
  assert.match(f.text, /checking back around now/);
  assert.equal(f.inReplyTo, '<orig-later@g.com>');
});

test('referral lead gets referral_intro as its first touch', async () => {
  await setup({ leads: [lead('sarah@f.com', { source: 'referral', referrerName: 'Tom' })] });
  await kv.hset(K.profile(ID), { sellsTo: 'We run IT for 20-person offices in Delaware.' });
  await runSender(ID, { now: NOW });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Tom suggested I reach you');
  assert.match(sent[0].text, /We run IT for 20-person offices/);
  assert.match(sent[0].text, /reply STOP/);
});
