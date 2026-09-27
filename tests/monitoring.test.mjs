// Delivery monitoring (docs/IMPROVE-PASS.md C): every email to a client is
// tracked (accepted, Message-ID, opened by its one pixel, bounced by a DSN
// matched on Message-ID or address, replied by a threaded message); the
// milestone emails are watched (retry once after 10 minutes → an alert;
// bounced → an alert; not opened in 48 business hours → a to-do and a quiet
// alert); the "we start on …" email goes once Day 1 is fixed, in their
// daytime, with the start in their zone, the window and the inbox they will
// see; the hub's conversation entries carry the status. SMTP is the
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
import { notifyClient, alertOwner, getAlertLog } from '@/lib/notify';
import { verifyTrackingToken } from '@/lib/tokens';
import { normId, originalMessageId, findReturnedHeadersPart } from '@/lib/mail-utils';
import { approveApplication } from '@/lib/systems/gatekeeper';
import { checkOnboardCalls, readCall, onboardCallFor } from '@/lib/systems/onboardcall';
import { conversationFor, entryView } from '@/lib/systems/conversation';
import { hubClient } from '@/lib/systems/hubview';
import { runReadiness } from '@/lib/systems/readiness';
import {
  readTrack, noteClientBounces, markMailOpened, businessHoursLater, statusOf, deliveryView, ownerShort,
  pickBounced, pickReplied, watchStep, trackKeyOf, entryIdOf, MILESTONES, WATCH,
} from '@/lib/systems/mailwatch';
import { sendStartEmail, startVars, startFacts, clockWord, inTheirDaytime } from '@/lib/systems/startemail';

// ── stubs ──
process.env.ENC_KEY = process.env.ENC_KEY || crypto.randomBytes(32).toString('base64');
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
process.env.SMTP_ACCOUNT_1 = 'onboard@aviance.test:app-pw2:Limeth Sith';
process.env.PUBLIC_BASE_URL = 'https://app.test';
delete process.env.OPEN_TRACKING;
let sent = [];
let failNext = 0;
nodemailer.createTransport = (opts = {}) => ({
  async sendMail(m) {
    if (failNext > 0) { failNext--; throw Object.assign(new Error('554 5.7.1 Message rejected'), { responseCode: 554, command: 'DATA' }); }
    sent.push({ ...m, user: opts.auth?.user });
    return { messageId: m.messageId, accepted: [m.to], rejected: [], response: '250 2.0.0 OK' };
  },
  async verify() { return true; },
  close() {},
});
let alerts = [];
let inbox = [];
const realNow = io.now;
const realNotify = io.notifyClient;

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; inbox = []; failNext = 0;
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.scanMailbox = async () => ({ ok: true, messages: inbox.map((m) => ({ ...m })), uidState: { INBOX: { uidValidity: '1', lastUid: inbox.length } } });
  io.now = realNow;
  io.notifyClient = realNotify;
  delete process.env.OPEN_TRACKING;
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'REPLYBOT.enabled': JSON.stringify(false), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
});

const ID = 'ecreek';
const SAM = 'sam@ecreek.com';
const FRI = new Date('2026-10-16T14:00:00Z'); // Fri 10:00 ET
const at = (base, hours) => new Date(base.getTime() + hours * 3600e3);
const toSam = () => sent.filter((m) => m.to === SAM);
const alertKeys = () => alerts.map((a) => a.key);
const check = (now) => checkOnboardCalls({ now, force: true });
const pixelOf = (m) => { const src = /src="([^"]+\/api\/track\/open\?t=[^"]+)"/.exec(m.html || '')?.[1]; return src ? new URL(src.replace(/&amp;/g, '&')) : null; };
const imgs = (m) => (String(m.html || '').match(/<img /g) || []).length;
const FRIDAY = { title: 'Your week', body: 'Warm-up is on day 9.', ownerName: 'Limeth Sith' };
const MOVED = { firstName: 'Sam', day1Date: 'Wednesday 21 October', day30Date: 'Thursday 19 November', reason: 'the list is still being built', waitingLine: 'Nothing is needed from you.', ownerName: 'Limeth Sith' };
const THUNDERBIRD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Thunderbird/128.0';

async function client(state = 'sending', over = {}) {
  await createClient(ID, { state, name: 'eCreek IT', contactName: 'Sam Test', contactEmail: SAM, mainDomain: 'ecreek.com', ...over });
}
async function hit(url, ua = THUNDERBIRD) {
  const { GET } = await import('@/app/api/track/open/route');
  return GET(new Request(`http://x/api/track/open?t=${url.searchParams.get('t')}`, { headers: { 'user-agent': ua } }));
}
const recOf = async (m) => (await readTrack(ID))[trackKeyOf(m.messageId)];

// ── C.1 every client email is tracked ────────────────────────────────────────

test('every email to the client carries one open pixel (purpose mail, its own key) and is tracked; prospects\' emails are not', async () => {
  await client();
  const res = await notifyClient(ID, 'friday_update', FRIDAY, { dedupe: 'f1', now: FRI });
  assert.equal(res.accepted, true);
  const m = toSam()[0];
  assert.equal(imgs(m), 1, 'one pixel');
  const tok = verifyTrackingToken(pixelOf(m).searchParams.get('t'));
  assert.deepEqual([tok.purpose, tok.clientId, tok.email, tok.touch], ['mail', ID, SAM, trackKeyOf(m.messageId)]);
  assert.equal(tok.sentAt, FRI.getTime(), 'the send\'s own clock');
  assert.ok(!m.headers['List-Unsubscribe'], 'still a 1:1 email');
  const rec = await recOf(m);
  assert.deepEqual([rec.template, rec.accepted, rec.messageId, rec.to, rec.at, rec.pixel, rec.id], ['friday_update', true, m.messageId, SAM, FRI.toISOString(), true, entryIdOf(m.messageId)]);
  assert.equal(rec.milestone, undefined, 'not a milestone: no watch');
  // The hub's conversation entry.
  const e = (await conversationFor(ID, { now: FRI })).thread[0];
  assert.deepEqual([e.status, e.statusText, e.accepted, e.messageId, e.milestone], ['delivered', 'delivered · not opened yet', true, m.messageId, false]);
  assert.equal(e.statusAt, FRI.toISOString());
  // To a prospect (not the contact): no pixel, no tracking.
  await notifyClient(ID, 'friday_update', FRIDAY, { dedupe: 'f2', to: 'lead@dental1.com', now: FRI });
  assert.equal(imgs(sent.find((x) => x.to === 'lead@dental1.com')), 0);
  assert.equal(Object.keys(await readTrack(ID)).length, 1);
  // The owner's own words: tracked, never a pixel.
  await notifyClient(ID, 'onboard_owner_reply', { threadSubject: 'Your trial', text: 'Hi Sam,\n\nSee you Tuesday.\n\nLimeth Sith' }, { dedupe: null, now: FRI });
  assert.equal(imgs(toSam().at(-1)), 0);
  assert.equal((await recOf(toSam().at(-1))).pixel, false);
  // OPEN_TRACKING=off: no pixel at all; the entry then reads just "delivered".
  process.env.OPEN_TRACKING = 'off';
  await notifyClient(ID, 'friday_update', FRIDAY, { dedupe: 'f3', now: FRI });
  assert.equal(imgs(toSam().at(-1)), 0);
  const th = (await conversationFor(ID, { now: FRI })).thread;
  assert.equal(th.at(-1).statusText, 'delivered');
});

test('the pixel: a person\'s open marks that email opened (a scanner does not); the acceptance email\'s pixel marks the call and the email', async () => {
  await client();
  const sentAt = new Date(Date.now() - 10 * 60e3);
  await notifyClient(ID, 'friday_update', FRIDAY, { dedupe: 'f1', now: sentAt });
  const m = toSam()[0];
  const scanner = await hit(pixelOf(m), 'Mozilla/5.0 (compatible; Barracuda scanner)');
  assert.equal(scanner.headers.get('content-type'), 'image/gif');
  assert.equal((await recOf(m)).openedAt, undefined);
  await hit(pixelOf(m));
  await hit(pixelOf(m));
  const rec = await recOf(m);
  assert.ok(rec.openedAt);
  assert.equal(rec.opens, 2);
  const e = (await conversationFor(ID)).thread[0];
  assert.equal(e.status, 'opened');
  assert.match(e.statusText, /^delivered · opened (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}(:\d\d)? [ap]m$/);
  assert.equal(await kv.hgetall('email_opens'), null, 'the cold-email open store is not touched');
  // A key that is not ours, or another address, marks nothing.
  assert.equal(await markMailOpened(ID, '0123456789abcdef', SAM), false);
  assert.equal(await markMailOpened(ID, trackKeyOf(m.messageId), 'someone@else.com'), false);

  // The acceptance email: its onboarding pixel names the email too.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'REPLYBOT.enabled': JSON.stringify(false), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  await createClient(ID, { name: 'eCreek IT', contactName: 'Sam Test', contactEmail: SAM, mainDomain: 'ecreek.com', website: 'https://ecreek.com', state: 'applied', source: 'website' });
  await kv.hset(K.application(ID), { review: 'pending', mainDomain: 'ecreek.com', receivedAt: sentAt.toISOString(), source: 'website' });
  await approveApplication(ID, { now: sentAt });
  const acc = toSam()[0];
  assert.equal(imgs(acc), 1, 'still one pixel');
  const t2 = verifyTrackingToken(pixelOf(acc).searchParams.get('t'));
  assert.deepEqual([t2.purpose, t2.touch], ['onboard', trackKeyOf(acc.messageId)]);
  await hit(pixelOf(acc));
  assert.ok((await readCall(ID)).openedAt, 'the call: opened');
  assert.ok((await recOf(acc)).openedAt, 'the email: opened');
  const oc = await onboardCallFor(ID);
  assert.equal(oc.thread[0].kind, 'acceptance');
  assert.equal(oc.thread[0].status, 'opened', 'the onboarding card\'s thread carries the status too');
  assert.equal((await readTrack(ID))[trackKeyOf(acc.messageId)].milestone, true);
});

test('a message from them that threads to our email marks it replied; the entry reads replied …', async () => {
  await client('onboarding');
  await notifyClient(ID, 'friday_update', FRIDAY, { dedupe: 'f1', now: FRI });
  const m = toSam()[0];
  const id = m.messageId.replace(/[<>]/g, '').toLowerCase();
  inbox = [{ uid: 5, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<r1@mail.ecreek.com>', from: SAM, to: ['onboard@aviance.test'], subject: `Re: ${m.subject}`, date: at(FRI, 2).toISOString(), inReplyTo: [id], references: [id], threadIds: [id], kind: 'human', hasIcs: false, text: 'Thanks, looks good.' }];
  await check(at(FRI, 3));
  const rec = await recOf(m);
  assert.equal(rec.repliedAt, at(FRI, 2).toISOString());
  const th = (await conversationFor(ID, { now: at(FRI, 3) })).thread;
  const ours = th.find((e) => e.dir === 'out');
  assert.equal(ours.status, 'replied');
  assert.match(ours.statusText, /^replied Fri \d{1,2}(:\d\d)? [ap]m$/);
  const theirs = th.find((e) => e.dir === 'in');
  assert.deepEqual([theirs.status, theirs.statusText, theirs.accepted], [null, null, null], 'their messages carry no delivery');
});

test('bounces: the bounce checker by Message-ID (a milestone → client_email_bounced), the onboarding inbox\'s DSN by address and time', async () => {
  await client('warming');
  await notifyClient(ID, 'day1_moved', MOVED, { dedupe: 'd1', now: FRI });
  const m = toSam()[0];
  const n = await noteClientBounces([
    { email: SAM, reason: '550 5.1.1 The email account that you tried to reach does not exist', date: at(FRI, 0.1).toISOString(), originalMessageId: normId(m.messageId) },
    { email: 'nobody@else.com', reason: '550', date: at(FRI, 0.1).toISOString() },
  ], { now: at(FRI, 0.2) });
  assert.equal(n, 1, 'only the client\'s address matches');
  const rec = await recOf(m);
  assert.equal(rec.bouncedAt, at(FRI, 0.1).toISOString());
  assert.match(rec.bounceReason, /does not exist/);
  assert.deepEqual(alertKeys(), ['client_email_bounced']);
  assert.deepEqual(alerts[0].vars, { person: 'Sam', what: MILESTONES.day1_moved.what });
  const e = (await conversationFor(ID, { now: at(FRI, 1) })).thread[0];
  assert.deepEqual([e.status, e.milestone], ['bounced', true]);
  assert.match(e.statusText, /^bounced Fri /);
  assert.match(e.bounceReason, /does not exist/);
  // The same bounce again: nothing more.
  assert.equal(await noteClientBounces([{ email: SAM, reason: '550', date: at(FRI, 0.1).toISOString(), originalMessageId: normId(m.messageId) }], { now: at(FRI, 0.3) }), 0);

  // A DSN in the onboarding inbox (no Message-ID in it): the newest email to that address before it; not a milestone → no alert.
  alerts = [];
  await notifyClient(ID, 'friday_update', FRIDAY, { dedupe: 'f1', now: at(FRI, 1) });
  const f = toSam().at(-1);
  inbox = [{ uid: 9, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<dsn9@mx.google.com>', from: 'mailer-daemon@googlemail.com', to: ['onboard@aviance.test'], subject: 'Delivery Status Notification (Failure)', date: at(FRI, 1.05).toISOString(), threadIds: [], kind: 'dsn', hasIcs: false,
    text: `Address not found\n\nYour message wasn't delivered to ${SAM} because the address couldn't be found.\n\nThe response was:\n550 5.1.1 The email account that you tried to reach does not exist.` }];
  const r = await check(at(FRI, 1.2));
  assert.equal(r.bounces, 1);
  assert.ok((await recOf(f)).bouncedAt, 'the Friday note bounced');
  assert.deepEqual(alertKeys(), [], 'not a milestone: the status only');
  // The helpers: the returned headers' Message-ID, and where they are in a DSN.
  assert.equal(originalMessageId(`Message-ID: <dsn9@mx.google.com>\n\nFrom: onboard@aviance.test\nMessage-ID: ${m.messageId}\n`, '<dsn9@mx.google.com>'), normId(m.messageId));
  assert.equal(originalMessageId('no headers here'), null);
  assert.equal(findReturnedHeadersPart({ childNodes: [{ type: 'text/plain', part: '1' }, { type: 'message/delivery-status', part: '2' }, { type: 'text/rfc822-headers', part: '3' }] }), '3');
});

// ── C.2 the milestone watch ──────────────────────────────────────────────────

test('a milestone email that cannot be sent is retried once 10 minutes later — sent: nothing more; not sent again: client_email_failed', async () => {
  await client('warming');
  failNext = 1;
  await assert.rejects(() => notifyClient(ID, 'day1_moved', MOVED, { dedupe: 'day1_moved:2026-10-21', now: FRI }), /send day1_moved failed/);
  assert.equal(toSam().length, 0);
  const spec = JSON.parse((await kv.hgetall(K.mailRetry(ID))).day1_moved);
  assert.equal(spec.retryAt, at(FRI, 10 / 60).toISOString());
  assert.equal((await getClient(ID)).mailWatchDueAt, spec.retryAt);
  // The job wakes for it (nothing else is open) — not before.
  const { JOBS } = await import('@/lib/jobs');
  const job = JOBS.find((x) => x.name === 'onboard-calls');
  assert.equal(await job.due({ now: at(FRI, 5 / 60), clients: [await getClient(ID)] }), null);
  assert.ok(await job.due({ now: at(FRI, 10 / 60), clients: [await getClient(ID)] }));
  await check(at(FRI, 5 / 60));
  assert.equal(toSam().length, 0, 'not before 10 minutes');
  const r = await check(at(FRI, 10 / 60));
  assert.deepEqual(r.mailWatch, { retried: 1, failed: 0, unopened: 0 });
  assert.equal(toSam().length, 1, 'the same email, once');
  assert.equal(toSam()[0].subject, 'Your trial — first send moves to Wednesday 21 October');
  assert.deepEqual(alertKeys(), []);
  assert.deepEqual((await kv.hgetall(K.mailRetry(ID))) || {}, {}, 'nothing left to retry');
  assert.equal((await conversationFor(ID, { now: at(FRI, 1) })).thread[0].template, 'day1_moved');
  await check(at(FRI, 0.5));
  assert.equal(toSam().length, 1, 'never twice');

  // Not sent again on the retry → the owner hears it, once.
  __reset(); sent = []; alerts = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'REPLYBOT.enabled': JSON.stringify(false), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  await client('warming');
  failNext = 2;
  await assert.rejects(() => notifyClient(ID, 'day1_moved', MOVED, { dedupe: 'day1_moved:2026-10-21', now: FRI }));
  const r2 = await check(at(FRI, 10 / 60));
  assert.deepEqual(r2.mailWatch, { retried: 0, failed: 1, unopened: 0 });
  assert.deepEqual(alertKeys(), ['client_email_failed']);
  assert.deepEqual(alerts[0].vars, { person: 'Sam', what: 'new start date' });
  assert.match(alerts[0].body, /could not be sent/);
  assert.match(alerts[0].body, /554 5\.7\.1 Message rejected/);
  assert.deepEqual((await kv.hgetall(K.mailRetry(ID))) || {}, {});
  await check(at(FRI, 1));
  assert.deepEqual(alertKeys(), ['client_email_failed'], 'one retry, one alert');
  assert.equal(toSam().length, 0);
});

test('the plan email that failed after the call is retried by its own sender (its records kept)', async () => {
  await client('onboarding');
  failNext = 1;
  const { sendNextSteps } = await import('@/lib/systems/launchcall');
  await assert.rejects(() => sendNextSteps(ID, { now: FRI, moment: 'call' }));
  assert.equal((await kv.hgetall(K.trial(ID)))?.nextStepsSentAt, undefined);
  await check(at(FRI, 11 / 60));
  assert.equal(toSam().length, 1);
  assert.equal(toSam()[0].subject, 'Your trial — what happens now');
  const trial = await kv.hgetall(K.trial(ID));
  assert.ok(trial.nextStepsSentAt);
  assert.equal(trial.nextStepsMoment, 'call');
  assert.deepEqual((await conversationFor(ID, { now: at(FRI, 1) })).thread.map((e) => [e.kind, e.status]), [['next_steps', 'delivered']]);
});

test('not opened in 48 business hours → the to-do "Sam hasn\'t opened the … email — call or text them?" + a quiet alert; an open clears it', async () => {
  await client('ready');
  await notifyClient(ID, 'welcome_two_dates', { firstName: 'Sam', ownerName: 'Limeth Sith', day1Date: 'Wednesday 21 October', day30Date: 'Thursday 19 November', callMinutes: 30 }, { dedupe: 'w1', now: FRI });
  const m = toSam()[0];
  const w = (await recOf(m)).watch;
  assert.equal(w.unopenedDueAt, '2026-10-20T14:00:00.000Z', 'Fri 10:00 ET + 48 business hours = Tue 10:00 ET (the weekend does not count)');
  assert.equal(w.bounceLookAt, at(FRI, WATCH.bounceLookMinutes / 60).toISOString());
  await check(at(FRI, 0.5)); // the bounce look: nothing to say
  assert.equal((await getClient(ID)).mailWatchDueAt, '2026-10-20T14:00:00.000Z', 'next look: the 48 h mark');
  await check(new Date('2026-10-19T14:00:00Z')); // Monday: still waiting
  assert.deepEqual(alertKeys(), []);
  const r = await check(new Date('2026-10-20T14:00:00Z'));
  assert.equal(r.mailWatch.unopened, 1);
  assert.deepEqual(alertKeys(), ['client_email_unopened']);
  assert.deepEqual(alerts[0].vars, { person: 'Sam', what: '“we start on”' });
  // The hub: an urgent to-do the big button picks up.
  const d = await hubClient(ID, { now: new Date('2026-10-20T15:00:00Z') });
  const todo = d.row.todo.find((t) => t.id === `unopened:${ID}`);
  assert.equal(todo.text, 'Sam hasn\'t opened the “we start on” email — call or text them?');
  assert.equal(todo.urgent, true);
  assert.deepEqual(todo.action, { type: 'api', method: 'POST', path: `/api/mc/clients/${ID}/messages`, body: { action: 'unopenedDone' }, confirm: 'Did you reach Sam? This clears the reminder.' });
  assert.equal(d.row.simple.needsYou, true);
  assert.equal(d.row.simple.next, todo.text);
  const entry = d.conversation.thread[0];
  assert.deepEqual([entry.status, entry.statusText, entry.milestone, entry.unopenedAt], ['delivered', 'delivered · not opened yet', true, '2026-10-20T14:00:00.000Z']);
  // Nothing more on later looks.
  await check(new Date('2026-10-21T14:00:00Z'));
  assert.deepEqual(alertKeys(), ['client_email_unopened']);
  // She opens it: the to-do goes.
  assert.equal(await markMailOpened(ID, trackKeyOf(m.messageId), SAM, { now: new Date('2026-10-21T15:00:00Z') }), true);
  assert.equal((await getClient(ID)).mailUnopened, undefined);
  assert.ok(!(await hubClient(ID, { now: new Date('2026-10-21T16:00:00Z') })).row.todo.some((t) => t.id === `unopened:${ID}`));
});

test('the unopened to-do: the owner\'s "done" clears it and acknowledges its alert; a message from them means no to-do at all', async () => {
  io.alertOwner = alertOwner; // the real log, to see the acknowledgement
  await client('sending');
  await notifyClient(ID, 'decision_link', { decisionUrl: 'https://app.test/c/x/decide', recommendationLine: 'My one recommendation: Growth.', bonusLine: '22 calls for the price of 20', bonusExpires: 'Sat, 17 Oct 2026 14:00 UTC', ownerName: 'Limeth Sith' }, { dedupe: 'd', now: FRI });
  await check(new Date('2026-10-20T14:05:00Z'));
  assert.ok((await getClient(ID)).mailUnopened);
  const open = (await getAlertLog()).filter((a) => a.key === 'client_email_unopened');
  assert.equal(open.length, 1);
  assert.equal(open[0].title, 'Sam hasn\'t opened the decision email');
  const { POST } = await import('@/app/api/mc/clients/[id]/messages/route');
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'unopenedDone' }) }), { params: { id: ID } });
  assert.equal(res.status, 200);
  assert.equal((await getClient(ID)).mailUnopened, undefined);
  assert.equal((await getAlertLog()).find((a) => a.key === 'client_email_unopened').acknowledged, true);

  // Another client email, but they wrote to us after it: they are in touch — no to-do.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'REPLYBOT.enabled': JSON.stringify(false), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  await client('sending');
  await notifyClient(ID, 'decision_link', { decisionUrl: 'https://app.test/c/x/decide', recommendationLine: 'x', bonusLine: 'y', bonusExpires: 'z', ownerName: 'Limeth Sith' }, { dedupe: 'd', now: FRI });
  inbox = [{ uid: 3, folder: 'INBOX', inbox: 'onboard@aviance.test', messageId: '<q@ecreek.com>', from: SAM, to: ['onboard@aviance.test'], subject: 'Quick question', date: at(FRI, 5).toISOString(), threadIds: [], kind: 'human', hasIcs: false, text: 'Can we talk Monday?' }];
  await check(at(FRI, 6));
  await check(new Date('2026-10-20T14:05:00Z'));
  assert.equal((await getClient(ID)).mailUnopened, undefined);
  assert.ok(!(await getAlertLog()).some((a) => a.key === 'client_email_unopened' && a.clientId === ID && !a.acknowledged));

  // Test Mode (`_test`: the "client" is the owner himself) is tracked but never gets the to-do.
  await createClient('_test', { state: 'sending', name: 'Test', contactName: 'Limeth Sith', contactEmail: 'owner@aviance.test' });
  await notifyClient('_test', 'decision_link', { decisionUrl: 'https://app.test/c/x/decide', recommendationLine: 'x', bonusLine: 'y', bonusExpires: 'z', ownerName: 'Limeth Sith' }, { dedupe: 'd', now: FRI });
  const t = Object.values(await readTrack('_test'))[0];
  assert.deepEqual([t.milestone, t.watch.unopenedDueAt], [true, null]);
});

// ── C.3 the "we start on …" email ────────────────────────────────────────────

const PROFILE = { senderName: 'Sam Test', postalAddress: '100 Main St, Dallas, TX 75201' };

async function readyClient({ state = 'ready', trial = { day1Date: '2026-10-21', day30Date: '2026-11-19' } } = {}) {
  await client(state);
  await kv.hset(K.profile(ID), PROFILE);
  await kv.hset(K.trial(ID), trial);
  for (const email of ['sam@ecreek-mail.com', 'sam.t@ecreek-mail.com']) {
    await saveInbox(ID, { email, password: 'Inbox-App-Pw-1', provider: 'google', displayName: 'Sam Test' });
    await patchInbox(ID, email, { enabled: '1', warmupStartedAt: '2026-10-07T12:00:00Z' });
  }
}

test('the "we start on" email: once Day 1 is fixed, in their daytime, naming the start in their zone, the window and the inbox they will see', async () => {
  await readyClient();
  const seen = [];
  io.notifyClient = async (id, key, vars, opts) => { seen.push({ key, vars, opts }); return realNotify(id, key, vars, opts); };
  // Monday 11:00 pm in Dallas: it waits for their morning.
  const night = new Date('2026-10-20T04:00:00Z');
  assert.deepEqual(await sendStartEmail(ID, { now: night }), { waiting: 'daytime' });
  assert.equal((await getClient(ID)).intakeStep, 'welcome');
  assert.equal(toSam().length, 0);
  const { JOBS } = await import('@/lib/jobs');
  const job = JOBS.find((x) => x.name === 'welcome');
  assert.equal(await job.due({ client: await getClient(ID), now: new Date('2026-10-20T11:00:00Z') }), null, '07:00 ET');
  assert.ok(await job.due({ client: await getClient(ID), now: new Date('2026-10-20T12:00:00Z') }), '08:00 ET: due');
  // 08:00 ET is 07:00 in Dallas: still their night.
  assert.deepEqual(await job.run({ clientId: ID, now: new Date('2026-10-20T12:00:00Z') }), { waiting: 'daytime' });
  // 08:00 in Dallas: it goes.
  assert.deepEqual(await job.run({ clientId: ID, now: new Date('2026-10-20T13:00:00Z') }), { sent: true, day1: '2026-10-21' });
  assert.equal(toSam().length, 1);
  const v = seen[0].vars;
  assert.equal(seen[0].key, 'welcome_two_dates');
  assert.equal(seen[0].opts.dedupe, 'welcome_two_dates:2026-10-21');
  assert.deepEqual(
    [v.firstName, v.ownerName, v.day1Date, v.day30Date, v.callMinutes],
    ['Sam', 'Limeth Sith', 'Wednesday 21 October', 'Thursday 19 November', 30], 'the kept vars',
  );
  assert.deepEqual(
    [v.startWhen, v.startTime, v.theirZoneName, v.sendWindow, v.windowStart, v.windowEnd, v.senderName, v.inboxName, v.inboxAddress, v.inboxes],
    ['Wednesday 21 October at 8:00 am Central Time (9:00 am Eastern)', '8:00 am', 'Central Time', "between 9:00 am and 5:00 pm on weekdays, in each prospect's own time zone", '9:00 am', '5:00 pm', 'Sam Test', 'Sam Test <sam.t@ecreek-mail.com>', 'sam.t@ecreek-mail.com', 'sam.t@ecreek-mail.com and sam@ecreek-mail.com'],
    'the new vars',
  );
  const c = await getClient(ID);
  assert.equal(c.intakeStep, '');
  assert.equal((await kv.hgetall(K.trial(ID))).startEmailFor, '2026-10-21');
  // Watched like every milestone email.
  assert.equal((await readTrack(ID))[trackKeyOf(toSam()[0].messageId)].milestone, true);
  // Once per Day 1.
  assert.deepEqual(await sendStartEmail(ID, { now: new Date('2026-10-20T15:00:00Z') }), { already: true });
  assert.equal(toSam().length, 1);
  // Before Day 1 is fixed (still warming): nothing.
  await kv.hset(K.client(ID), { state: 'warming' });
  await kv.hset(K.trial(ID), { day1Date: '2026-10-22' });
  assert.deepEqual(await sendStartEmail(ID, { now: new Date('2026-10-20T15:00:00Z') }), { skipped: 'Day 1 is not fixed yet' });
  assert.equal(toSam().length, 1);
});

test('readiness: green → ready and the "we start on" email; a Day 1 that moves → day1_moved with the same facts', async () => {
  await readyClient({ state: 'warming', trial: { signedDay: '2026-10-06', day1Date: '2026-10-21', day30Date: '2026-11-19' } });
  const notes = [];
  const deps = { notify: async (id, key, vars, opts) => { notes.push({ key, vars, dedupe: opts.dedupe }); return { sent: true }; } };
  // Day 1 morning, the gate still red → Day 1 slides; day1_moved names the new start the same way.
  const day1 = new Date('2026-10-21T14:00:00Z');
  const r1 = await runReadiness({ client: await getClient(ID), now: day1, deps });
  assert.equal(r1.slid, '2026-10-22');
  assert.equal(notes[0].key, 'day1_moved');
  assert.equal(notes[0].vars.day1Date, 'Thursday, October 22', 'the kept var (its own format)');
  assert.equal(notes[0].vars.startWhen, 'Thursday 22 October at 8:00 am Central Time (9:00 am Eastern)');
  assert.equal(notes[0].vars.inboxName, 'Sam Test <sam.t@ecreek-mail.com>');
  assert.match(notes[0].vars.sendWindow, /^between 9:00 am and 5:00 pm on weekdays/);
  // Everything green (the stage-b recipe) → ready, and the one start email for 22 October.
  await kv.hset(K.sequence(ID), { approvedAt: day1.toISOString(), approvalMode: 'call' });
  await insertLeads(ID, Array.from({ length: 200 }, (_, i) => ({ email: `p${i}@co${i}.com`, company: `Co ${i}` })));
  for (const email of ['sam@ecreek-mail.com', 'sam.t@ecreek-mail.com']) await patchInbox(ID, email, { warmupReady: '1', inboxRate7d: '0.950', readyStreak: '2' });
  await kv.hset(K.canary(ID, '2026-10-21'), { phase: 'done', result: JSON.stringify({ overall: 0.9, min: 0.9, perInbox: { 'sam@ecreek-mail.com': { sent: 10, inbox: 9, placement: 0.9 }, 'sam.t@ecreek-mail.com': { sent: 10, inbox: 9, placement: 0.9 } } }) });
  for (const email of ['sam@ecreek-mail.com', 'sam.t@ecreek-mail.com']) await kv.lpush(K.placement(ID), JSON.stringify({ at: day1.toISOString(), day: '2026-10-21', tool: 'mail-tester', inbox: email, score: 9.5, pass: true, detail: [] }));
  await kv.hset(K.profile(ID), { bookingTested: '1' });
  const r2 = await runReadiness({ client: await getClient(ID), now: at(day1, 2), deps });
  assert.equal(r2.ready, true, JSON.stringify(r2.checks));
  assert.equal((await getClient(ID)).state, 'ready');
  assert.deepEqual(notes.map((n) => n.key), ['day1_moved', 'welcome_two_dates']);
  assert.equal(notes[1].dedupe, 'welcome_two_dates:2026-10-22');
  assert.equal(notes[1].vars.day1Date, 'Thursday 22 October');
  // The next hour: still green, nothing twice.
  await runReadiness({ client: await getClient(ID), now: at(day1, 3), deps });
  assert.equal(notes.length, 2);
});

// ── pure parts ───────────────────────────────────────────────────────────────

test('pure: business hours, the status and its words, matching bounces and replies, the watch step, the start facts', () => {
  // 48 hours counted on US business days (ET): Tue → Thu, Fri → Tue, over Columbus Day (Mon 12 Oct 2026) → Wed.
  assert.equal(new Date(businessHoursLater('2026-10-13T14:00:00Z')).toISOString(), '2026-10-15T14:00:00.000Z');
  assert.equal(new Date(businessHoursLater('2026-10-16T14:00:00Z')).toISOString(), '2026-10-20T14:00:00.000Z');
  assert.equal(new Date(businessHoursLater('2026-10-09T14:00:00Z')).toISOString(), '2026-10-14T14:00:00.000Z');
  assert.equal(new Date(businessHoursLater('2026-10-17T15:00:00Z')).toISOString(), '2026-10-21T04:00:00.000Z', 'sent on a Saturday: Mon + Tue');

  // Status: replied > bounced > opened > delivered > sent.
  const base = { at: '2026-10-16T14:00:00Z', accepted: true, pixel: true };
  assert.equal(statusOf(base).status, 'delivered');
  assert.equal(statusOf({ ...base, accepted: false }).status, 'sent');
  assert.equal(statusOf({ ...base, openedAt: '2026-10-16T15:00:00Z' }).status, 'opened');
  assert.equal(statusOf({ ...base, openedAt: '2026-10-16T15:00:00Z', bouncedAt: '2026-10-16T14:05:00Z' }).status, 'bounced');
  assert.equal(statusOf({ ...base, bouncedAt: 'x', repliedAt: '2026-10-17T15:00:00Z' }).status, 'replied');
  const now = new Date('2026-10-17T00:00:00Z');
  assert.equal(ownerShort('2026-10-16T14:40:00Z', now), 'Fri 8:10 pm', 'the owner\'s clock (Colombo)');
  assert.equal(ownerShort('2026-10-16T14:30:00Z', now), 'Fri 8 pm');
  assert.equal(ownerShort('2026-09-29T14:40:00Z', now), 'Tue 29 Sep, 8:10 pm', 'older: with the date');
  assert.equal(deliveryView({ ...base, openedAt: '2026-10-16T14:40:00Z' }, { dir: 'out' }, now).statusText, 'delivered · opened Fri 8:10 pm');
  assert.equal(deliveryView({ ...base, pixel: false }, { dir: 'out' }, now).statusText, 'delivered');
  assert.deepEqual(deliveryView(null, { dir: 'out', at: '2026-10-16T14:40:00Z' }, now), { accepted: null, messageId: null, openedAt: null, bouncedAt: null, bounceReason: null, repliedAt: null, milestone: false, unopenedAt: null, status: 'sent', statusAt: '2026-10-16T14:40:00.000Z', statusText: 'sent Fri 8:10 pm' });
  assert.equal(entryView({ id: 'in-1', dir: 'in', at: '2026-10-16T14:40:00Z', kind: 'reply', text: 'hi' }).status, null);

  // Bounces: the named Message-ID first, else the newest to that address in the 3 days before.
  const recs = [
    { key: 'a', messageId: '<A@x>', to: SAM, at: '2026-10-14T14:00:00Z' },
    { key: 'b', messageId: '<B@x>', to: SAM, at: '2026-10-16T14:00:00Z' },
    { key: 'c', messageId: '<C@x>', to: 'other@x.com', at: '2026-10-16T14:30:00Z' },
    { key: 'd', messageId: '<D@x>', to: SAM, at: '2026-10-16T18:00:00Z' },
  ];
  assert.equal(pickBounced(recs, { email: SAM, messageId: 'a@x', at: '2026-10-16T15:00:00Z' }).key, 'a');
  assert.equal(pickBounced(recs, { email: SAM, at: '2026-10-16T15:00:00Z' }).key, 'b', 'not the one sent after the bounce');
  assert.equal(pickBounced(recs, { email: SAM, at: '2026-10-25T15:00:00Z' }), null, 'nothing in the 3 days before');
  assert.equal(pickReplied(recs, ['zzz@y', 'b@x', 'a@x']).key, 'b', 'In-Reply-To first');
  assert.equal(pickReplied(recs, ['nope@y']), null);

  // The watch step.
  const w = { at: '2026-10-16T14:00:00Z', watch: { bounceLookAt: '2026-10-16T14:20:00Z', unopenedDueAt: '2026-10-20T14:00:00Z' } };
  assert.deepEqual(watchStep(w, new Date('2026-10-16T14:10:00Z')), { wait: Date.parse('2026-10-16T14:20:00Z') });
  assert.deepEqual(watchStep(w, new Date('2026-10-16T15:00:00Z')), { wait: Date.parse('2026-10-20T14:00:00Z') });
  assert.deepEqual(watchStep(w, new Date('2026-10-20T14:00:00Z')), { unopened: true });
  assert.deepEqual(watchStep({ ...w, openedAt: 'x' }, new Date('2026-10-20T14:00:00Z')), { done: 'opened' });
  assert.deepEqual(watchStep(w, new Date('2026-10-20T14:00:00Z'), { theyWroteAt: '2026-10-17T10:00:00Z' }), { done: 'they wrote' });
  assert.deepEqual(watchStep(w, new Date('2026-10-20T14:00:00Z'), { theyWroteAt: '2026-10-15T10:00:00Z' }), { unopened: true }, 'a message before it is no sign');
  assert.deepEqual(watchStep(w, new Date('2026-10-20T14:00:00Z'), { actedAt: '2026-10-19T10:00:00Z' }), { done: 'they acted on it' });
  assert.deepEqual(watchStep({ ...w, watch: { bounceLookAt: w.watch.bounceLookAt, unopenedDueAt: null } }, new Date('2026-10-16T15:00:00Z')), { done: 'no open pixel' });

  // Every milestone the brief names.
  assert.deepEqual(Object.keys(MILESTONES).sort(), ['accepted_call', 'day1_moved', 'decision_link', 'decision_link_zero', 'launch_invite', 'next_steps', 'trial_report', 'trial_report_zero', 'welcome_two_dates']);

  // The start facts without the Calendar's words: Eastern.
  const f = startFacts({ day1Date: '2026-10-21', window: ['09:00', '17:00'], senderName: '', inboxes: ['b@x.com', 'a@x.com'] });
  assert.deepEqual([f.day1Date, f.day30Date, f.startWhen, f.inboxName, f.inboxes], ['Wednesday 21 October', 'Thursday 19 November', 'Wednesday 21 October at 9:00 am Eastern Time', 'b@x.com', 'b@x.com and a@x.com']);
  assert.deepEqual([clockWord('09:00'), clockWord('17:30'), clockWord('00:05'), clockWord('12:00')], ['9:00 am', '5:30 pm', '12:05 am', '12:00 pm']);
  assert.equal(inTheirDaytime(new Date('2026-10-20T12:30:00Z'), 'America/New_York'), true);
  assert.equal(inTheirDaytime(new Date('2026-10-20T12:30:00Z'), 'America/Los_Angeles'), false);
});

test('startVars reads their zone from the profile, the Sender\'s window and the switched-on inboxes', async () => {
  await readyClient();
  await patchInbox(ID, 'sam.t@ecreek-mail.com', { enabled: '0' });
  const v = await startVars(ID, '2026-10-21');
  assert.deepEqual([v.theirZoneName, v.inboxName, v.inboxes], ['Central Time', 'Sam Test <sam@ecreek-mail.com>', 'sam@ecreek-mail.com']);
});
