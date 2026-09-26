// Warm-up in the hub (docs/WARMUP-HUB.md): a helper is saved only after its
// SMTP + IMAP logins worked (plain per-provider reasons otherwise, nothing
// saved), "Test" re-tests one, GET /api/mc/warmup carries the plain circle /
// helpers / providers blocks next to the old fields, a trial's warm-up card
// (day, rate, readyBy from the ramp and the readiness rule — null when
// unknown), waiting_for_helpers → needsYou + one to-do + one alert a day,
// and inboxes connected by CheapInboxes auto-buy join the circle at warming.
//
// Fake KV; io.smtpVerify / io.imapLogin (and CheapInboxes, DNS, the setup
// check's mail) are stubs. Nothing leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { io } from '@/lib/systems/intake-io';
import { createClient, getClient } from '@/lib/db/client';
import { saveInbox, patchInbox, getInboxRecords } from '@/lib/db/inboxes';
import { decrypt } from '@/lib/crypto';
import { HELPER_PROVIDERS, PROVIDERS } from '@/lib/smtp-providers';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import {
  addHelper, testHelper, saveHelper, getPool, statBump, runWarmupSend, runWarmupDaily, helperFailure, estimateReadyBy,
  warmupView, circleOf, warmupHubSettings,
} from '@/lib/systems/warmup';
import { hubClient, hubBoard, simpleFor, todosFor } from '@/lib/systems/hubview';
import * as ci from '@/lib/ext/cheapinboxes';
import { syncAutobuy, readRec } from '@/lib/systems/autobuy';

process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'https://app.test';
delete process.env.OWNER_INBOX;
delete process.env.CHEAPINBOXES_API_KEY;

const NOW = new Date('2026-10-06T15:00:00Z'); // Tuesday 11:00 ET
const DAY = '2026-10-06';
const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * 864e5).toISOString();
const PASSWORD = 'abcd efgh ijkl mnop';
const alertsOf = async (key) => ((await kv.lrange(K.alertLog(), 0, -1)) || []).filter((a) => a.key === key);

// ── the login seam ───────────────────────────────────────────────────────────
let logins;
const SMTP_OK = { success: true };
const IMAP_OK = { ok: true, spamFolderExists: true };
function stubLogins({ smtp = SMTP_OK, imap = IMAP_OK } = {}) {
  logins = [];
  io.smtpVerify = async (account) => { logins.push({ kind: 'smtp', user: account.email, pass: account.appPassword, host: account.smtp.host, port: account.smtp.port }); return typeof smtp === 'function' ? smtp(account) : smtp; };
  io.imapLogin = async (account) => { logins.push({ kind: 'imap', user: account.imapUser || account.email, pass: account.appPassword, host: account.imap.host }); return typeof imap === 'function' ? imap(account) : imap; };
}

beforeEach(() => {
  __reset();
  stubLogins();
});

async function route(body) {
  const { POST, GET } = await import('@/app/api/mc/warmup/route');
  const res = body ? await POST(new Request('http://x/api/mc/warmup', { method: 'POST', body: JSON.stringify(body) })) : await GET();
  return { status: res.status, body: await res.json() };
}
const noSecrets = (answer) => { const t = JSON.stringify(answer); return !t.includes(PASSWORD) && !t.includes(PASSWORD.replace(/\s+/g, '')) && !t.includes('passwordEnc'); };

// ── 1. add: the login is tested first ────────────────────────────────────────

test('addHelper: both logins work → saved (encrypted, health ok, lastOkAt); the answer never carries the password', async () => {
  const r = await route({ action: 'addHelper', email: 'Pat.Helper@Yahoo.com', password: PASSWORD, displayName: 'Pat Helper' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.provider, 'yahoo');
  assert.equal(r.body.helper.health, 'ok');
  assert.equal(r.body.helper.providerLabel, 'Yahoo Mail');
  assert.equal(r.body.helper.problem, null);
  assert.ok(r.body.helper.lastOkAt);
  assert.ok(noSecrets(r.body));
  // SMTP (send) then IMAP (read) on Yahoo's servers, with the app password without spaces.
  assert.deepEqual(logins.map((l) => [l.kind, l.user, l.host]), [['smtp', 'pat.helper@yahoo.com', 'smtp.mail.yahoo.com'], ['imap', 'pat.helper@yahoo.com', 'imap.mail.yahoo.com']]);
  assert.ok(logins.every((l) => l.pass === 'abcdefghijklmnop'));
  const rec = await kv.hgetall(K.warmupHelper('pat.helper@yahoo.com'));
  assert.equal(decrypt(rec.passwordEnc), 'abcdefghijklmnop');
  assert.equal(rec.health, 'ok');
  assert.ok((await kv.smembers(K.warmupPool())).includes('_helper|pat.helper@yahoo.com'));
  assert.equal((await getPool({ now: NOW, clients: [] })).filter((m) => m.isHelper).length, 1, 'in the circle at once');
});

test('addHelper: a wrong password → 400 with the provider\'s app-password hint, nothing saved', async () => {
  stubLogins({ smtp: { success: false, error: 'Invalid login: 535-5.7.8 Username and Password not accepted', code: 'EAUTH', responseCode: 535 } });
  const gmail = await route({ action: 'addHelper', email: 'sam.helper@gmail.com', password: PASSWORD });
  assert.equal(gmail.status, 400);
  assert.equal(gmail.body.ok, false);
  assert.equal(gmail.body.kind, 'wrong_password');
  assert.match(gmail.body.error, /^Gmail said the password is wrong — use the 16-letter app password/);
  assert.match(gmail.body.error, /not your normal password/);
  assert.deepEqual(logins.map((l) => l.kind), ['smtp'], 'a refused password is not tried on IMAP too');

  const yahoo = await route({ action: 'addHelper', email: 'sam.helper@yahoo.com', password: PASSWORD });
  assert.equal(yahoo.status, 400);
  assert.match(yahoo.body.error, /^Yahoo said the password is wrong — .*create an app password under Account security/);
  const icloud = await route({ action: 'addHelper', email: 'sam.helper@icloud.com', password: PASSWORD });
  assert.match(icloud.body.error, /app-specific password/);

  for (const email of ['sam.helper@gmail.com', 'sam.helper@yahoo.com', 'sam.helper@icloud.com']) assert.equal(await kv.hgetall(K.warmupHelper(email)), null, `${email} not saved`);
  assert.deepEqual(await kv.smembers(K.warmupPool()), []);
  assert.ok(noSecrets([gmail.body, yahoo.body, icloud.body]));
});

test('addHelper: IMAP off → 400 with where to turn it on (GMX, WEB.DE, Yandex), nothing saved', async () => {
  // GMX takes the password for sending but refuses IMAP while "POP3 & IMAP" is off.
  stubLogins({ imap: { ok: false, error: 'Command failed: AUTHENTICATIONFAILED', auth: true } });
  const gmx = await route({ action: 'addHelper', email: 'lee.helper@gmx.com', password: PASSWORD });
  assert.equal(gmx.status, 400);
  assert.equal(gmx.body.kind, 'imap_off');
  assert.equal(gmx.body.error, 'IMAP is off — GMX: Email › Settings › POP3 & IMAP › enable access, then press Test and add again');
  const webde = await route({ action: 'addHelper', email: 'lee.helper@web.de', password: PASSWORD });
  assert.match(webde.body.error, /^IMAP is off — WEB\.DE: Settings › POP3\/IMAP › enable/);
  // A server that says so in words is IMAP-off anywhere.
  stubLogins({ imap: { ok: false, error: 'IMAP access is disabled for this account' } });
  const yandex = await route({ action: 'addHelper', email: 'lee.helper@yandex.com', password: PASSWORD });
  assert.match(yandex.body.error, /^IMAP is off — Yandex: Mail › Settings › Email clients › turn on IMAP/);
  const gmail = await route({ action: 'addHelper', email: 'lee.helper@gmail.com', password: PASSWORD });
  assert.equal(gmail.body.kind, 'imap_off');
  assert.match(gmail.body.error, /^IMAP is off — Gmail: turn on IMAP access/);

  for (const email of ['lee.helper@gmx.com', 'lee.helper@web.de', 'lee.helper@yandex.com', 'lee.helper@gmail.com']) assert.equal(await kv.hgetall(K.warmupHelper(email)), null);
  assert.deepEqual(await kv.smembers(K.warmupPool()), []);
});

test('addHelper: unknown provider, not an address, providers that cannot be free helpers → 400 before any login', async () => {
  const unknown = await route({ action: 'addHelper', email: 'x@example.org', password: PASSWORD, provider: 'hotmailz' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /^Unknown provider "hotmailz" — pick one of: Gmail, Yahoo Mail, AOL Mail, iCloud Mail/);
  const notEmail = await route({ action: 'addHelper', email: 'nobody', password: PASSWORD });
  assert.equal(notEmail.status, 400);
  assert.match(notEmail.body.error, /does not look like an email address/);
  const outlook = await route({ action: 'addHelper', email: 'x@outlook.com', password: PASSWORD });
  assert.equal(outlook.status, 400);
  assert.match(outlook.body.error, /OAuth2/);
  const missing = await route({ action: 'addHelper', email: 'x@gmail.com' });
  assert.equal(missing.status, 400);
  assert.deepEqual(logins, [], 'nothing was tried');
});

test('addHelper: a server that never answers → a plain "try again" within the budget; iCloud falls back to the full address as IMAP user', async () => {
  io.smtpVerify = () => new Promise(() => {}); // hangs
  const t0 = Date.now();
  const slow = await addHelper({ email: 'kim.helper@aol.com', password: PASSWORD }, { deadline: Date.now() + 1500 });
  assert.ok(Date.now() - t0 < 3000, 'answers within the budget');
  assert.equal(slow.ok, false);
  assert.equal(slow.kind, 'unreachable');
  assert.match(slow.error, /^AOL Mail did not answer within 20 seconds — try again in a minute$/);
  assert.equal(await kv.hgetall(K.warmupHelper('kim.helper@aol.com')), null);

  // iCloud: the part before the @ is refused, the full address works → kept as the IMAP user.
  stubLogins({ imap: (a) => (a.imapUser === 'kim.helper' ? { ok: false, error: 'AUTHENTICATIONFAILED', auth: true } : IMAP_OK) });
  const r = await addHelper({ email: 'kim.helper@icloud.com', password: PASSWORD });
  assert.equal(r.ok, true);
  assert.deepEqual(logins.filter((l) => l.kind === 'imap').map((l) => l.user), ['kim.helper', 'kim.helper@icloud.com']);
  assert.equal((await kv.hgetall(K.warmupHelper('kim.helper@icloud.com'))).imapUser, 'kim.helper@icloud.com');
});

test('helperFailure: plain reasons per kind (pure)', () => {
  assert.equal(helperFailure('google', { smtp: SMTP_OK, imap: IMAP_OK }), null);
  assert.equal(helperFailure('yahoo', { smtp: { success: false, code: 'ETIMEDOUT', error: 'Connection timeout' } }).kind, 'unreachable');
  assert.equal(helperFailure('yahoo', { smtp: { success: false, error: 'Invalid login: 535 5.7.0 (#AUTH005) Too many bad auth attempts' } }).kind, 'wrong_password');
  assert.equal(helperFailure('icloud', { smtp: SMTP_OK, imap: { ok: false, auth: true, error: 'Authentication failed' } }).kind, 'imap_user');
  assert.equal(helperFailure('gmx', { smtp: SMTP_OK, imap: { timedOut: true } }).kind, 'unreachable');
  assert.match(helperFailure('google', { smtp: SMTP_OK, imap: { ok: false, auth: true, error: 'Invalid credentials' } }).reason, /took the password for sending but refused the mailbox login/);
});

// ── 2. testHelper ────────────────────────────────────────────────────────────

test('testHelper: re-tests a saved helper; health, problem and lastOkAt follow; a refused login leaves the circle until it passes', async () => {
  await route({ action: 'addHelper', email: 'jo.helper@gmail.com', password: PASSWORD });
  const inCircle = async () => (await getPool({ now: NOW, clients: [] })).some((m) => m.email === 'jo.helper@gmail.com');
  assert.equal(await inCircle(), true);

  // The app password was revoked.
  stubLogins({ smtp: { success: false, error: 'Invalid login', code: 'EAUTH', responseCode: 535 } });
  const bad = await route({ action: 'testHelper', email: 'jo.helper@gmail.com' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /^Gmail said the password is wrong/);
  assert.equal(bad.body.helper.health, 'failing');
  assert.equal(bad.body.helper.problem, bad.body.error);
  assert.equal(logins[0].pass, 'abcdefghijklmnop', 'the stored password is what is tested');
  assert.equal((await kv.hgetall(K.warmupHelper('jo.helper@gmail.com'))).health, 'auth_failed');
  assert.equal(await inCircle(), false);
  assert.ok(noSecrets(bad.body));

  // The server did not answer: noted, but it stays in the circle.
  stubLogins({ smtp: { success: false, code: 'ETIMEDOUT', error: 'Connection timeout' } });
  const flaky = await route({ action: 'testHelper', email: 'jo.helper@gmail.com' });
  assert.equal(flaky.body.helper.health, 'failing');
  assert.match(flaky.body.error, /Could not reach Gmail's mail server/);
  assert.equal(await inCircle(), true);

  // Fixed.
  stubLogins();
  const later = new Date(Date.now() + 60_000);
  const ok = (await testHelper('jo.helper@gmail.com', { now: later }));
  assert.equal(ok.ok, true);
  assert.equal(ok.helper.health, 'ok');
  assert.equal(ok.helper.problem, null);
  assert.equal(ok.helper.lastOkAt, later.toISOString());
  assert.equal(await inCircle(), true);

  const none = await route({ action: 'testHelper', email: 'nobody@gmail.com' });
  assert.equal(none.status, 404);
  assert.equal((await route({ action: 'testHelper' })).status, 400);
});

// ── 3. GET /api/mc/warmup ────────────────────────────────────────────────────

async function trial(id, { state = 'warming', inboxes = [], day1Date = '2026-10-26', name = null } = {}) {
  await createClient(id, { state, name: name || `${id[0].toUpperCase()}${id.slice(1)} Co` });
  if (day1Date) await kv.hset(K.trial(id), { day1Date });
  for (const ib of inboxes) {
    await saveInbox(id, { email: ib.email, password: PASSWORD, provider: 'google', displayName: 'Jordan Test' });
    const { email, ...fields } = ib;
    if (Object.keys(fields).length) await patchInbox(id, email, fields);
  }
}
async function helpers(n, from = 1) {
  const provs = ['gmail.com', 'yahoo.com', 'aol.com', 'icloud.com', 'gmx.com', 'web.de', 'yandex.com'];
  for (let i = from; i < from + n; i++) await saveHelper({ email: `helper${i}@${provs[i % provs.length]}`, password: PASSWORD, displayName: `Helper ${i}` });
}

test('GET /api/mc/warmup: the circle (helpers + client inboxes + aviance), plain helpers, providers — and the old fields', async () => {
  await trial('acme', { inboxes: [{ email: 'jordan@acme-mail.com', warmupStartedAt: daysAgo(4) }, { email: 'jordan.test@acme-mail.com', warmupStartedAt: daysAgo(4) }] });
  await createClient('aviance', { state: 'sending', name: 'Aviance' });
  await saveInbox('aviance', { email: 'me@getaviance.site', password: PASSWORD, provider: 'google' });
  await helpers(3);
  await saveHelper({ email: 'off.helper@gmail.com', password: PASSWORD });
  await kv.hset(K.warmupHelper('off.helper@gmail.com'), { enabled: '0' });
  await saveHelper({ email: 'broken.helper@yahoo.com', password: PASSWORD, provider: 'yahoo' });
  await kv.hset(K.warmupHelper('broken.helper@yahoo.com'), { health: 'auth_failed' });
  await statBump('helper1@yahoo.com', 'sent', 3);

  const { status, body } = await route();
  assert.equal(status, 200);
  assert.deepEqual(body.circle, {
    members: 6, helpers: 3, clientInboxes: 2, avianceInboxes: 1, min: 8, ready: false, missing: 2,
    label: '6 of 8 in the warm-up circle — add 2 more helpers',
    waiting: [{ clientId: 'acme', name: 'Acme Co' }],
  });
  const h = Object.fromEntries(body.helpers.map((x) => [x.email, x]));
  assert.equal(body.helpers.length, 5, 'switched-off and failing helpers are listed too');
  assert.deepEqual(Object.keys(h['helper1@yahoo.com']).slice(0, 8), ['email', 'provider', 'providerLabel', 'health', 'lastOkAt', 'problem', 'sentToday', 'displayName']);
  assert.equal(h['helper1@yahoo.com'].sentToday, 3);
  assert.equal(h['helper1@yahoo.com'].health, 'new');
  assert.equal(h['helper2@aol.com'].providerLabel, 'AOL Mail');
  assert.equal(h['off.helper@gmail.com'].health, 'disabled');
  assert.equal(h['off.helper@gmail.com'].providerLabel, 'Gmail');
  assert.equal(h['broken.helper@yahoo.com'].health, 'failing');
  assert.match(h['broken.helper@yahoo.com'].problem, /^Yahoo Mail refused the login — .*app password.*Add the helper again with it$/);
  assert.equal(h['broken.helper@yahoo.com'].state, 'auth_failed', 'the old page\'s Retry still finds it');
  assert.ok(body.helpers.every((x) => x.hasPassword === true && 'enabled' in x && 'providerOk' in x));
  assert.ok(noSecrets(body));

  assert.deepEqual(body.providers.map((p) => p.key), HELPER_PROVIDERS);
  const gmail = body.providers.find((p) => p.key === 'google');
  assert.deepEqual(gmail, { key: 'google', label: 'Gmail', steps: PROVIDERS.google.setup, note: PROVIDERS.google.helperNote, passwordLabel: '16-letter app password' });
  assert.ok(body.providers.every((p) => p.steps.length >= 2 && p.passwordLabel));

  // What the old Mission Control page reads is still there.
  for (const k of ['day', 'members', 'pairs', 'minPool', 'minFamilies', 'summary', 'presets', 'external', 'aviance', 'encKey']) assert.ok(k in body, `${k} kept`);
  assert.equal(body.members.length, 6);
  assert.equal(body.minPool, 8);

  // Enough members: ready, nobody waits.
  await helpers(2, 10);
  const full = (await route()).body.circle;
  assert.deepEqual([full.members, full.ready, full.missing, full.waiting], [8, true, 0, []]);
  assert.equal(full.label, '8 in the warm-up circle — enough (at least 8 needed)');
});

// ── 4. the trial's warm-up card ──────────────────────────────────────────────

test('trial detail `warmup`: day, rates, today\'s sends and quota per inbox, readyBy from the ramp; `simple` uses the label', async () => {
  // Day 5 (started 4 days ago), 7-day rates from the daily readiness run.
  await trial('acme', { inboxes: [
    { email: 'jordan@acme-mail.com', warmupStartedAt: daysAgo(4), inboxRate7d: '0.960', readyStreak: '1', readyCheckedDay: '2026-10-05', warmupReady: '0' },
    { email: 'jordan.test@acme-mail.com', warmupStartedAt: daysAgo(4), inboxRate7d: '0.980', readyStreak: '1', readyCheckedDay: '2026-10-05', warmupReady: '0' },
  ] });
  await helpers(6);
  await statBump('jordan@acme-mail.com', 'sent', 8, NOW);
  const d = await hubClient('acme', { now: NOW });
  assert.deepEqual(d.warmup, {
    status: 'warming',
    label: 'Warming up — day 5 of about 14 · 96% reach the inbox',
    day: 5, of: 14,
    readyBy: '2026-10-15', // the first warm-up day (2 Oct) + 13 = its day 14
    inboxRate: 0.96,
    inboxes: [
      { email: 'jordan@acme-mail.com', day: 5, sentToday: 8, quota: 8, inboxRate7d: 0.96, ready: false },
      { email: 'jordan.test@acme-mail.com', day: 5, sentToday: 0, quota: 8, inboxRate7d: 0.98, ready: false },
    ],
    problem: null,
    helpersNeeded: 0,
  });
  assert.equal(d.row.simple.step, 'warming_up');
  assert.equal(d.row.simple.label, d.warmup.label);
  assert.equal(d.row.simple.next, 'Nothing for you: first emails on Monday 26 October');
  assert.equal(d.row.simple.needsYou, false);
  assert.ok(!d.row.todo.some((t) => t.id.startsWith('warmup-helpers')));
  assert.ok(noSecrets(d.warmup));

  // Day 14: one inbox passed the rule, the other is under the line → later than day 14, and why.
  await patchInbox('acme', 'jordan@acme-mail.com', { warmupStartedAt: daysAgo(13), readyStreak: '2', warmupReady: '1' });
  await patchInbox('acme', 'jordan.test@acme-mail.com', { warmupStartedAt: daysAgo(13), inboxRate7d: '0.850', readyStreak: '0' });
  const lag = (await hubClient('acme', { now: NOW })).warmup;
  assert.equal(lag.status, 'warming');
  assert.equal(lag.day, 14);
  assert.equal(lag.inboxRate, 0.85);
  assert.equal(lag.label, 'Warming up — day 14 of about 14 · 85% reach the inbox');
  assert.equal(lag.readyBy, '2026-10-07', 'day 14 is today; two passing checks from tonight → tomorrow');
  assert.equal(lag.problem, 'jordan.test@acme-mail.com: 85% reach the inbox — it needs 90% on 2 days in a row');
  assert.deepEqual(lag.inboxes.map((i) => i.ready), [true, false]);

  // Still under the line a week past day 14 (the Day 1 slide window): no date is made up.
  await patchInbox('acme', 'jordan.test@acme-mail.com', { warmupStartedAt: daysAgo(21) });
  const stuck = (await hubClient('acme', { now: NOW })).warmup;
  assert.equal(stuck.readyBy, null);
  assert.equal(stuck.problem, 'jordan.test@acme-mail.com: 85% reach the inbox — it needs 90% on 2 days in a row, so Day 1 waits for it');

  // Every inbox ready → ready, no readyBy.
  await patchInbox('acme', 'jordan.test@acme-mail.com', { warmupReady: '1', inboxRate7d: '0.950' });
  const done = (await hubClient('acme', { now: NOW })).warmup;
  assert.deepEqual([done.status, done.label, done.readyBy], ['ready', 'Warm-up done · 95% reach the inbox', null]);
  assert.equal((await hubClient('acme', { now: NOW })).row.simple.label, 'Warm-up done · 95% reach the inbox');
});

test('readyBy: null when unknown (pure)', () => {
  const s = { today: DAY, readyRate: 0.9, need: 2, minDays: 14, maxSlideDays: 7 };
  // Never measured yet on day 3: the plain ramp — its day 14.
  assert.equal(estimateReadyBy([{ start: '2026-10-04', rate: null, streak: 0, checkedDay: null, ready: false }], s), '2026-10-17');
  // No start day → unknown.
  assert.equal(estimateReadyBy([{ start: null, rate: 0.95, ready: false }], s), null);
  // Under the line and already past the Day 1 slide window → unknown, never a made-up date.
  assert.equal(estimateReadyBy([{ start: '2026-09-16', rate: 0.7, streak: 0, checkedDay: '2026-10-05', ready: false }], s), null);
  assert.equal(estimateReadyBy([{ start: '2026-09-16', rate: null, streak: 0, checkedDay: null, ready: false }], s), null);
  // Passing at day 21 (past the window) is still a date: its streak finishes tomorrow.
  assert.equal(estimateReadyBy([{ start: '2026-09-16', rate: 0.93, streak: 1, checkedDay: '2026-10-06', ready: false }], s), '2026-10-07');
  // Lagging on day 14, inside the window → later than day 14.
  assert.equal(estimateReadyBy([{ start: '2026-09-23', rate: 0.8, streak: 0, checkedDay: '2026-10-05', ready: false }], s), '2026-10-07');
  // Ready inboxes do not count; all ready → nothing to wait for.
  assert.equal(estimateReadyBy([{ start: '2026-09-01', rate: 0.99, ready: true }], s), null);
});

test('warmupView: null before the inboxes are connected; paused until warm-up starts (pure)', async () => {
  const s = await warmupHubSettings();
  const inbox = { email: 'a@acme-mail.com', passwordEnc: 'x' };
  assert.equal(warmupView({ client: { id: 'acme', state: 'awaiting_purchase' }, inboxes: [inbox], now: NOW, s }), null);
  assert.equal(warmupView({ client: { id: 'acme', state: 'setup_check' }, inboxes: [{ email: 'a@acme-mail.com' }], now: NOW, s }), null, 'no login stored yet');
  const w = warmupView({ client: { id: 'acme', state: 'setup_check' }, inboxes: [inbox], now: NOW, s });
  assert.deepEqual([w.status, w.label, w.day, w.readyBy], ['paused', 'Warm-up starts when the setup checks pass', 0, null]);
  const off = warmupView({ client: { id: 'acme', state: 'warming' }, inboxes: [{ ...inbox, warmupStartedAt: daysAgo(2), warmupEnabled: '0' }], now: NOW, s });
  assert.deepEqual([off.status, off.label], ['paused', 'Warm-up is switched off for these inboxes']);
  const sending = warmupView({ client: { id: 'acme', state: 'sending' }, inboxes: [{ ...inbox, warmupStartedAt: daysAgo(20), inboxRate7d: '0.97' }], now: NOW, s });
  assert.deepEqual([sending.status, sending.label, sending.readyBy], ['ready', 'Warm-up done · 97% reach the inbox', null]);
  assert.equal(warmupView({ client: { id: 'acme', state: 'deciding' }, inboxes: [inbox], now: NOW, s }), null);
});

// ── 5. waiting for helpers ───────────────────────────────────────────────────

test('waiting_for_helpers: needsYou, the "Add N warm-up helpers" to-do (one on the board), the card', async () => {
  await trial('acme', { inboxes: [{ email: 'jordan@acme-mail.com', warmupStartedAt: daysAgo(2) }] });
  await trial('bolt', { inboxes: [{ email: 'sam@bolt-mail.com', warmupStartedAt: daysAgo(1) }], day1Date: null });
  await helpers(2);
  const d = await hubClient('acme', { now: NOW });
  assert.deepEqual(d.warmup.status, 'waiting_for_helpers');
  assert.equal(d.warmup.label, 'Waiting for warm-up helpers — 4 of 8 in the circle, add 4 more');
  assert.equal(d.warmup.problem, 'The warm-up circle has 4 of the 8 members it needs — add 4 warm-up helpers in Settings › Warm-up');
  assert.equal(d.warmup.helpersNeeded, 4);
  assert.equal(d.warmup.readyBy, null, 'not while the circle is short');
  assert.deepEqual([d.row.simple.step, d.row.simple.label, d.row.simple.next, d.row.simple.needsYou], ['warming_up', d.warmup.label, 'Add 4 warm-up helpers — Settings › Warm-up', true]);
  const todo = d.row.todo.find((t) => t.id === 'warmup-helpers:acme');
  assert.equal(todo.text, 'Add 4 warm-up helpers — Settings › Warm-up');
  assert.deepEqual(todo.action, { type: 'view', view: 'settings', section: 'warmup' });
  assert.equal(todo.urgent, true);
  assert.equal(d.row.systems.find((x) => x.key === 'warmup').status, 'waiting');

  // The board: one to-do for both waiting trials.
  const board = await hubBoard({ now: NOW });
  const hs = board.todos.filter((t) => t.id.startsWith('warmup-helpers'));
  assert.equal(hs.length, 1);
  assert.equal(hs[0].id, 'warmup-helpers');
  assert.equal(hs[0].text, 'Add 4 warm-up helpers — Settings › Warm-up');
  assert.match(hs[0].detail, /waiting: (Acme Co, Bolt Co|Bolt Co, Acme Co)$/);
  assert.deepEqual(hs[0].action, { type: 'view', view: 'settings', section: 'warmup' });
  const rows = board.stages.flatMap((s) => s.clients);
  assert.ok(rows.filter((r) => ['acme', 'bolt'].includes(r.id)).every((r) => r.simple.needsYou));

  // Enough helpers → back to warming, the to-do goes.
  await helpers(4, 20);
  const after = await hubClient('acme', { now: NOW });
  assert.equal(after.warmup.status, 'warming');
  assert.equal(after.row.simple.needsYou, false);
  assert.ok(!after.row.todo.some((t) => t.id.startsWith('warmup-helpers')));
});

test('simple / to-dos from a fixture ctx: waiting_for_helpers alone turns the dot on (pure)', () => {
  const ctx = { client: { id: 'acme', name: 'Acme Co', state: 'warming' }, trial: { day1Date: '2026-10-26' }, now: NOW,
    warmup: { status: 'waiting_for_helpers', label: 'Waiting for warm-up helpers — 7 of 8 in the circle, add 1 more', helpersNeeded: 1, problem: 'p' } };
  const todos = todosFor(ctx);
  assert.equal(todos.find((t) => t.id === 'warmup-helpers:acme').text, 'Add 1 warm-up helper — Settings › Warm-up');
  const s = simpleFor(ctx, todos);
  assert.deepEqual([s.label, s.next, s.needsYou], ['Waiting for warm-up helpers — 7 of 8 in the circle, add 1 more', 'Add 1 warm-up helper — Settings › Warm-up', true]);
  // Without the card (older fixtures) the old sentence stays.
  const old = simpleFor({ client: { id: 'acme', name: 'Acme Co', state: 'warming' }, trial: { day1Date: '2026-10-26' }, now: NOW });
  assert.equal(old.label, 'Warming up their inboxes — first emails on Monday 26 October');
});

test('warmup_needs_helpers: at most one alert a day while a trial waits (the warm-up runs and the daily run)', async () => {
  await trial('acme', { inboxes: [{ email: 'jordan@acme-mail.com', warmupStartedAt: daysAgo(2) }] });
  await helpers(2);
  const sent = [];
  const deps = { rng: () => 0.5, send: async (account, mail) => { sent.push({ from: account.email, to: mail.to }); return { success: true, messageId: `<${sent.length}@x>` }; } };
  await runWarmupSend({ now: NOW, deadline: Date.now() + 20_000, deps });
  await runWarmupSend({ now: new Date(NOW.getTime() + 10 * 60e3), deadline: Date.now() + 20_000, deps });
  assert.ok(sent.length >= 1, 'warm-up keeps going with the members it has');
  let a = await alertsOf('warmup_needs_helpers');
  assert.equal(a.length, 1);
  assert.equal(a[0].title, 'Add 5 warm-up helpers — the warm-up circle has 3 of 8');
  assert.equal(fill('t', ALERTS.warmup_needs_helpers.title, { helpers: '1 warm-up helper', members: 7, min: 8 }), 'Add 1 warm-up helper — the warm-up circle has 7 of 8');
  // The end-of-day run: no second alert, and not the older warmup_pool_small on top.
  await runWarmupDaily({ now: new Date('2026-10-07T03:45:00Z') });
  assert.equal((await alertsOf('warmup_needs_helpers')).length, 1);
  assert.equal((await alertsOf('warmup_pool_small')).length, 0);
  // Next day, still waiting → one more.
  const next = new Date('2026-10-07T15:00:00Z');
  await runWarmupSend({ now: next, deadline: Date.now() + 20_000, deps });
  await runWarmupSend({ now: new Date(next.getTime() + 10 * 60e3), deadline: Date.now() + 20_000, deps });
  assert.equal((await alertsOf('warmup_needs_helpers')).length, 2);
  // Nobody waits (enough helpers) → none; a small circle with no trial warming → the old pool alert only.
  await helpers(5, 30);
  await runWarmupSend({ now: new Date('2026-10-08T15:00:00Z'), deadline: Date.now() + 20_000, deps });
  assert.equal((await alertsOf('warmup_needs_helpers')).length, 2);
  __reset();
  await helpers(3);
  await runWarmupDaily({ now: new Date('2026-10-09T03:45:00Z') });
  assert.equal((await alertsOf('warmup_needs_helpers')).length, 0);
  assert.equal((await alertsOf('warmup_pool_small')).length, 1);
});

test('circleOf counts only working members; waiting lists trials in warming with an inbox not ready (pure)', async () => {
  const c = { id: 'acme', name: 'Acme Co', state: 'warming' };
  const pool = [
    { isHelper: true }, { isHelper: true },
    { isAviance: true, clientId: 'aviance' },
    { clientId: 'acme', client: c, record: { warmupReady: '1' } },
    { clientId: 'acme', client: c, record: { warmupReady: '0' } },
    { clientId: 'bolt', client: { id: 'bolt', state: 'sending' }, record: {} },
  ];
  const x = circleOf(pool, 8);
  assert.deepEqual([x.members, x.helpers, x.avianceInboxes, x.clientInboxes, x.missing, x.ready], [6, 2, 1, 3, 2, false]);
  assert.deepEqual(x.waiting, [{ clientId: 'acme', name: 'Acme Co' }]);
  assert.equal(circleOf(pool, 6).waiting.length, 0);
  assert.equal(circleOf(pool, 7).label, '6 of 7 in the warm-up circle — add 1 more helper');
});

// ── 6. auto-buy inboxes join the circle ──────────────────────────────────────

const KEY = 'ci_live_TestKey_0123456789abcdef';
const T0 = new Date('2026-10-05T14:00:00Z');
const at = (h) => new Date(T0.getTime() + h * 3600e3);
function fakeCheapInboxes() {
  const st = { hooks: new Map(), domains: new Map(), mailboxes: new Map(), creds: new Map() };
  const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json ?? null) });
  const page = (all, q) => { const limit = Number(q.limit) || 25; const offset = Number(q.offset) || 0; return { rows: all.slice(offset, offset + limit), pagination: { total: all.length, limit, offset } }; };
  st.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = String(opts.method || 'GET').toUpperCase();
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    const body = opts.body ? JSON.parse(opts.body) : null;
    assert.equal(u.origin, 'https://api.cheapinboxes.com');
    assert.ok(!/orders|billing\/(?!payment-methods)|checkout/.test(p), `never an order or a payment: ${method} ${p}`);
    let m;
    if (method === 'GET' && p === '/v1/org') return reply(200, { organization: { id: 'org_1', name: 'Aviance Outreach' }, role: 'owner' });
    if (method === 'GET' && p === '/v1/billing/payment-methods') return reply(200, { payment_methods: [{ id: 'pm_1', type: 'card', is_default: true }] });
    if (method === 'GET' && p === '/v1/webhooks') return reply(200, [...st.hooks.values()]);
    if (method === 'POST' && p === '/v1/webhooks') { const h = { id: `wh_${st.hooks.size + 1}`, url: body.url, events: body.events, secret: 'whsec_test' }; st.hooks.set(h.id, h); return reply(201, h); }
    if (method === 'POST' && p === '/v1/discovery/domains/search') return reply(200, { exact: (body.tlds || ['com']).map((t) => ({ domain: `${body.keyword}.${t}`, available: true, status: 'available', price: 9.99, currency: 'USD' })), suggestions: [] });
    if (method === 'GET' && p === '/v1/domains') { const r = page([...st.domains.values()], q); return reply(200, { domains: r.rows, pagination: r.pagination }); }
    if (method === 'GET' && (m = p.match(/^\/v1\/domains\/([^/]+)$/))) return reply(200, { domain: st.domains.get(m[1]) });
    if (method === 'PATCH' && (m = p.match(/^\/v1\/domains\/([^/]+)\/forwarding$/))) { Object.assign(st.domains.get(m[1]), { forwarding_url: body.forwarding_url, forwarding_status: 'active' }); return reply(200, { domain: st.domains.get(m[1]) }); }
    if (method === 'GET' && p === '/v1/mailboxes') { let all = [...st.mailboxes.values()]; if (q.domain_id) all = all.filter((x) => x.domain_id === q.domain_id); const r = page(all, q); return reply(200, { mailboxes: r.rows, pagination: r.pagination }); }
    if (method === 'GET' && (m = p.match(/^\/v1\/mailboxes\/([^/]+)\/credentials$/))) return reply(200, { credentials: st.creds.get(m[1]) });
    if (method === 'GET' && (m = p.match(/^\/v1\/mailboxes\/([^/]+)$/))) return reply(200, { mailbox: st.mailboxes.get(m[1]) });
    throw new Error(`fake CheapInboxes does not know ${method} ${p}`);
  };
  /** The owner buys in CheapInboxes (the machine never does); everything comes up active. */
  st.ownerBuys = (name, addresses) => {
    const id = `d_${name.replace(/\W/g, '')}`;
    st.domains.set(id, { id, domain: name, status: 'active', source_provider: 'cheapinboxes', infra_provider: 'google', auto_renew: true, forwarding_url: null, created_at: at(1).toISOString() });
    for (const a of addresses) {
      const mid = `mb_${a.replace(/\W/g, '')}`;
      st.mailboxes.set(mid, { id: mid, domain_id: id, full_email: a, first_name: 'Jordan', last_name: 'Test', status: 'active', source_provider: 'google', created_at: at(1).toISOString() });
      st.creds.set(mid, { email: a, password: 'Login-Pass#1', app_password: PASSWORD, imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587 });
    }
  };
  return st;
}

test('auto-buy: inboxes CheapInboxes connected join the warm-up circle by themselves when the trial reaches warming', async () => {
  const fake = fakeCheapInboxes();
  const emails = [];
  io.fetchJson = async (url, opts) => fake.fetch(url, opts);
  io.alertOwner = async () => ({ sent: true });
  io.notifyClient = async (clientId, key) => { emails.push({ clientId, key }); return { sent: true }; };
  io.dns = {
    resolveTxt: async (n) => {
      const d = n.replace(/^(google\._domainkey|_dmarc)\./, '');
      if (n.startsWith('google._domainkey.')) return [['v=DKIM1; k=rsa; p=MIIB']];
      if (n.startsWith('_dmarc.')) return [[`v=DMARC1; p=none; rua=mailto:dmarc@${d}`]];
      return [['v=spf1 include:_spf.google.com ~all']];
    },
    resolveMx: async () => [{ exchange: 'smtp.google.com', priority: 1 }],
    resolve4: async (n) => { if (/^\d+\.\d+\.\d+\.\d+\./.test(n)) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); return ['203.0.113.5']; },
  };
  io.fetchExt = async () => ({ status: 200, ok: true, url: 'https://acme.com/', text: async () => '' });
  io.sendEmail = async (acct, msg) => { emails.push({ key: 'loopback', from: acct.email, subject: msg.subject }); return { success: true }; };
  io.imapFindMessage = async (acct, token) => ({ found: true, folder: 'INBOX', headers: `Subject: Setup check ${token}\r\nAuthentication-Results: mx.google.com; dkim=pass; spf=pass` });
  io.now = () => T0;
  globalThis.__after = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith') });

  await ci.saveKey({ apiKey: KEY });
  await syncAutobuy({ force: true, now: at(0) });
  await createClient('acme', { state: 'awaiting_purchase', name: 'Acme Co', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', mainDomain: 'acme.com' });
  await kv.hset(K.profile('acme'), { senderName: 'Jordan Test', senderPrefix: 'jordan' });
  await syncAutobuy({ force: true, now: at(0.1) });
  const { buy } = await readRec('acme');
  assert.ok(buy?.domain, 'the shopping list is made');
  // Before the purchase: not in the circle, no card.
  assert.equal((await getPool({ now: at(0.2) })).filter((m) => m.clientId === 'acme').length, 0);
  assert.equal((await hubClient('acme', { now: at(0.2) })).warmup, null);

  fake.ownerBuys(buy.domain, buy.mailboxes.map((x) => x.email));
  for (let h = 1; h < 3 && (await getClient('acme')).state !== 'warming'; h += 0.2) await syncAutobuy({ force: true, now: at(h) });
  assert.equal((await getClient('acme')).state, 'warming');
  const recs = await getInboxRecords('acme');
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.source === 'cheapinboxes' && r.passwordEnc && r.warmupStartedAt && r.warmupEnabled !== '0'));

  // Nothing else to do: the next warm-up look finds them in the circle.
  const later = at(4);
  const pool = await getPool({ now: later });
  const theirs = pool.filter((m) => m.clientId === 'acme');
  assert.deepEqual(theirs.map((m) => m.email).sort(), buy.mailboxes.map((x) => x.email).sort());
  assert.ok(theirs.every((m) => m.days === 1 && m.quota === 3 && !m.isHelper && !m.isAviance));
  const members = await kv.smembers(K.warmupPool());
  for (const x of buy.mailboxes) assert.ok(members.includes(`acme|${x.email}`), `${x.email} in warmup:pool`);
  const { body } = await route();
  assert.equal(body.circle.clientInboxes, 2);
  assert.deepEqual(body.circle.waiting, [{ clientId: 'acme', name: 'Acme Co' }]);
  // The trial's card: waiting for helpers until the circle is full, then warming from day 1.
  let w = (await hubClient('acme', { now: later })).warmup;
  assert.equal(w.status, 'waiting_for_helpers');
  await helpers(6);
  w = (await hubClient('acme', { now: later })).warmup;
  assert.equal(w.status, 'warming');
  assert.equal(w.day, 1);
  assert.equal(w.label, 'Warming up — day 1 of about 14');
  assert.equal(w.readyBy, '2026-10-18');
  assert.deepEqual(w.inboxes.map((i) => i.quota), [3, 3]);
});
