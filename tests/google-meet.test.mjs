// Google Meet (docs/REPLYBOT-MEET.md §3): the owner's Google connection (OAuth
// consent, one-use state, code exchange, encrypted storage, refresh + cache,
// a refused refresh → broken + one alert, disconnect), the Calendar's hooks
// (confirm → an event with a Meet before the email; move → patch; cancel /
// decline → delete; Google down → confirmed anyway with the fallback words),
// the `test` action, and the middleware letting only the callback through.
// Google is a fake behind io.fetchJson; SMTP is the nodemailer stub. Nothing
// leaves the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { __reset, kv } from '@vercel/kv';
import { io } from '@/lib/systems/intake-io';
import { K } from '@/lib/db/keys';
import { createClient } from '@/lib/db/client';
import { approveApplication } from '@/lib/systems/gatekeeper';
import { ALERTS } from '@/lib/templates/owner';
import { fill } from '@/lib/templates/render';
import { decrypt, sha256 } from '@/lib/crypto';
import { exportAll } from '@/lib/systems/backup';
import { calendarView, getMeeting } from '@/lib/systems/calendar';
import {
  GOOGLE_TIMING, AUTH_URL, TOKEN_URL, REVOKE_URL, EVENTS_URL, accessToken, GoogleError,
} from '@/lib/ext/google';

// ── stubs ──
process.env.ENC_KEY = crypto.randomBytes(32).toString('base64');
process.env.OWNER_INBOX = 'owner@aviance.test:app-pw:Limeth Sith';
process.env.SMTP_ACCOUNT_1 = 'onboard@aviance.test:app-pw2:Limeth Sith';
process.env.PUBLIC_BASE_URL = 'https://app.test';
delete process.env.OPEN_TRACKING;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.HUB_URL;
GOOGLE_TIMING.pollMs = 5;

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-verysecretvalue123';
const REFRESH = 'rt-secret-1';
const CAL = 'https://www.googleapis.com/auth/calendar.events';
const SECRETS = [CLIENT_ID, CLIENT_SECRET, REFRESH, 'at-1', 'at-r1', 'at-r2'];
const REDIRECT = 'https://app.test/api/google/callback';
const HUB = 'https://aviance.store/#settings/google';

let sent = [];
let order = [];
nodemailer.createTransport = (opts = {}) => ({
  async sendMail(m) { sent.push({ ...m, user: opts.auth?.user }); order.push(`mail:${m.subject}`); return { messageId: m.messageId, response: '250 OK' }; },
  async verify() { return true; },
  close() {},
});
let alerts = [];
const realNow = io.now;

// ── a fake Google (OAuth + Calendar) behind io.fetchJson ──
let g;
const reply = (status, json = null) => ({ status, ok: status >= 200 && status < 300, json, text: json ? JSON.stringify(json) : '' });
const idToken = (email) => ['x', Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url'), 'sig'].join('.');
function fakeGoogle(url, opts = {}) {
  const method = opts.method || 'GET';
  const headers = opts.headers || {};
  g.calls.push({ url, method, headers, body: opts.body, timeoutMs: opts.timeoutMs, retry: opts.retry });
  if (g.down) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  if (url === TOKEN_URL) {
    const f = new URLSearchParams(opts.body);
    if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return reply(401, { error: 'invalid_client' });
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== 'good-code' || f.get('redirect_uri') !== REDIRECT) return reply(400, { error: 'invalid_grant' });
      g.valid.add('at-1');
      return reply(200, { access_token: 'at-1', expires_in: 3599, refresh_token: REFRESH, scope: g.scope ?? `${CAL} openid https://www.googleapis.com/auth/userinfo.email`, token_type: 'Bearer', id_token: idToken('owner@gmail.com') });
    }
    if (f.get('grant_type') === 'refresh_token') {
      if (f.get('refresh_token') !== REFRESH) return reply(400, { error: 'invalid_grant' });
      if (g.refreshError) return reply(400, { error: g.refreshError, error_description: 'Token has been expired or revoked.' });
      g.refreshes++;
      g.valid.add(`at-r${g.refreshes}`);
      return reply(200, { access_token: `at-r${g.refreshes}`, expires_in: 3599, scope: CAL, token_type: 'Bearer' });
    }
    return reply(400, { error: 'unsupported_grant_type' });
  }
  if (url === REVOKE_URL) { g.revoked.push(new URLSearchParams(opts.body).get('token')); return reply(200, {}); }
  if (url.startsWith(EVENTS_URL)) {
    const token = String(headers.authorization || '').replace(/^Bearer /, '');
    if (!g.valid.has(token)) return reply(401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (g.apiError) return reply(g.apiError.status, g.apiError.json);
    const u = new URL(url);
    const id = decodeURIComponent(u.pathname.split('/events/')[1] || '');
    if (method === 'POST' && !id) {
      const body = JSON.parse(opts.body);
      const n = ++g.n;
      const ev = { id: `ev${n}`, status: 'confirmed', ...body, conferenceData: { createRequest: { ...body.conferenceData.createRequest, status: { statusCode: 'pending' } } } };
      ev.pendingLeft = g.pendingPolls;
      ev.link = `https://meet.google.com/abc-defg-${String(n).padStart(3, '0')}`;
      if (!ev.pendingLeft) ready(ev);
      g.events.set(ev.id, ev);
      order.push('google:POST');
      return reply(200, view(ev));
    }
    const ev = g.events.get(id);
    order.push(`google:${method}`);
    if (!ev) return reply(404, { error: { code: 404, message: 'Not Found' } });
    if (method === 'GET') { if (ev.pendingLeft && --ev.pendingLeft === 0) ready(ev); return reply(200, view(ev)); }
    if (method === 'PATCH') { Object.assign(ev, JSON.parse(opts.body)); return reply(200, view(ev)); }
    if (method === 'DELETE') { g.events.delete(id); return reply(204); }
  }
  throw new Error(`fake Google does not know ${method} ${url}`);
}
function ready(ev) {
  ev.hangoutLink = ev.link;
  ev.conferenceData = { ...ev.conferenceData, createRequest: { ...ev.conferenceData.createRequest, status: { statusCode: 'success' } }, entryPoints: [{ entryPointType: 'video', uri: ev.link }] };
}
const view = (ev) => { const { pendingLeft, link, ...out } = ev; return JSON.parse(JSON.stringify(out)); };
const calls = (method, pred = () => true) => g.calls.filter((c) => c.method === method && c.url.startsWith(EVENTS_URL) && pred(c));
const tokenCalls = (grant) => g.calls.filter((c) => c.url === TOKEN_URL && new URLSearchParams(c.body).get('grant_type') === grant);

beforeEach(async () => {
  __reset();
  sent = []; alerts = []; order = [];
  g = { calls: [], events: new Map(), valid: new Set(), n: 0, refreshes: 0, revoked: [], down: false, refreshError: null, apiError: null, pendingPolls: 0, scope: undefined };
  io.fetchJson = async (url, opts) => fakeGoogle(url, opts);
  io.fetchExt = async (url) => { throw new Error(`unexpected fetchExt ${url}`); };
  io.alertOwner = async (key, o = {}) => { alerts.push({ key, ...o }); return { sent: true }; };
  io.scanMailbox = async () => ({ ok: true, messages: [], uidState: {} });
  io.now = realNow;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
});

// ── the hub's routes ──
const answers = [];
async function mc(body) {
  const { POST } = await import('@/app/api/mc/google/route');
  const res = await POST(new Request('https://app.test/api/mc/google', { method: 'POST', body: JSON.stringify(body) }));
  const out = { status: res.status, body: await res.json() };
  // The consent address carries the Client ID by design (the browser takes it to Google); nothing else may.
  answers.push(body.action === 'connect' && out.body.url ? { ...out.body, url: new URL(out.body.url).origin } : out.body);
  return out;
}
async function status() {
  const { GET } = await import('@/app/api/mc/google/route');
  const body = await (await GET()).json();
  answers.push(body);
  return body;
}
async function callback(qs) {
  const { GET } = await import('@/app/api/google/callback/route');
  const res = await GET(new Request(`https://app.test/api/google/callback?${qs}`));
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}
const stateOf = (url) => new URL(url).searchParams.get('state');
/** Paste the client, press Connect, Allow on Google's screen. */
async function connectGoogle() {
  assert.equal((await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).status, 200);
  const { body } = await mc({ action: 'connect' });
  const back = await callback(`state=${encodeURIComponent(stateOf(body.url))}&code=good-code&scope=${encodeURIComponent(CAL)}`);
  assert.deepEqual([back.status, back.location], [303, `${HUB}?connected=1`]);
}
const leaks = (value) => SECRETS.filter((s) => JSON.stringify(value).includes(s));

// ── the calendar (as in tests/calendar.test.mjs) ──
const ID = 'ecreek';
const SAM = 'sam@ecreek.com';
const MON = new Date('2026-10-05T14:00:00Z'); // Mon 10:00 ET
const TUE_2PM = '2026-10-06T18:00:00.000Z';
const WED_10AM = '2026-10-07T14:00:00.000Z';
const at = (base, hours) => new Date(base.getTime() + hours * 3600e3);
const toSam = () => sent.filter((m) => m.to === SAM);
const unfold = (ics) => ics.replace(/\r\n /g, '');
const icsLine = (mail, name) => (unfold(mail.icalEvent.content).match(new RegExp(`\\r\\n${name}:([^\\r]*)`)) || [])[1] || null;

async function approved() {
  await createClient(ID, { name: 'eCreek IT', contactName: 'Sam Test', contactEmail: SAM, mainDomain: 'ecreek.com', website: 'https://ecreek.com', state: 'applied', source: 'website' });
  await kv.hset(K.application(ID), { review: 'pending', mainDomain: 'ecreek.com', receivedAt: '2026-10-05T12:00:00Z', source: 'website' });
  assert.equal((await approveApplication(ID, { now: MON })).outcome, 'onboarding');
  const m = toSam()[0].text.match(/Book a time that suits you: https:\/\/app\.test\/c\/([^/\s]+)\/book/);
  assert.ok(m, 'the acceptance email links the booking page');
  return m[1];
}
async function ask(token, start) {
  const { POST } = await import('@/app/api/c/book/route');
  const res = await POST(new Request('https://app.test/api/c/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, start }) }));
  return { status: res.status, body: await res.json() };
}
async function hub(body) {
  const { POST } = await import('@/app/api/mc/calendar/route');
  const res = await POST(new Request('https://app.test/api/mc/calendar', { method: 'POST', body: JSON.stringify(body) }));
  const out = { status: res.status, body: await res.json() };
  answers.push(out.body);
  return out;
}
/** An applicant who asked for Tuesday 2 pm ET; returns { token, meeting }. */
async function asked() {
  const token = await approved();
  io.now = () => at(MON, 1);
  const r = await ask(token, TUE_2PM);
  assert.equal(r.status, 200);
  io.now = () => at(MON, 2);
  return { token, meeting: r.body.meeting };
}

// ── connecting ───────────────────────────────────────────────────────────────

test('consent URL: Google\'s address with the contract\'s parameters; the state is kept 10 minutes (hashed); not_set_up → ready_to_connect; env wins', async () => {
  let s = await status();
  assert.deepEqual([s.status, s.hasClient, s.account, s.redirectUri, s.encKey], ['not_set_up', false, null, REDIRECT, true]);
  assert.equal((await mc({ action: 'connect' })).status, 409, 'nothing to connect with yet');
  assert.match((await mc({ action: 'connect' })).body.error, /paste the Client ID and Client secret/);
  // Pasting: a wrong Client ID or an empty secret is refused in plain words.
  assert.equal((await mc({ action: 'saveClient', clientId: 'not-a-client-id', clientSecret: CLIENT_SECRET })).status, 400);
  assert.equal((await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: '' })).status, 400);
  const saved = await mc({ action: 'saveClient', clientId: ` ${CLIENT_ID} `, clientSecret: CLIENT_SECRET });
  assert.deepEqual([saved.status, saved.body.ok, saved.body.status, saved.body.hasClient, saved.body.clientFrom], [200, true, 'ready_to_connect', true, 'saved']);
  const conn = await kv.hgetall(K.google());
  assert.match(conn.clientIdEnc, /^v1\./);
  assert.match(conn.clientSecretEnc, /^v1\./);
  assert.equal(decrypt(conn.clientSecretEnc), CLIENT_SECRET);
  assert.deepEqual(leaks(conn), [], 'nothing stored in plain text');

  const { status: code, body } = await mc({ action: 'connect' });
  assert.equal(code, 200);
  const u = new URL(body.url);
  assert.equal(`${u.origin}${u.pathname}`, AUTH_URL);
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual({ ...q, state: undefined }, {
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events openid email',
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: undefined,
  });
  assert.ok(q.state.length >= 30);
  const key = K.googleState(sha256(q.state));
  assert.ok(await kv.get(key), 'the state waits for its callback');
  const ttl = await kv.ttl(key);
  assert.ok(ttl > 590 && ttl <= 600, `10 minutes (${ttl})`);
  assert.equal(await kv.get(K.googleState(q.state)), null, 'only its hash is a key');
  assert.notEqual(stateOf((await mc({ action: 'connect' })).body.url), q.state, 'a new state each time');

  // Env wins: the Client ID from the server settings, and pasting is refused (it would not be used).
  process.env.GOOGLE_CLIENT_ID = 'env-111.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-fromenv';
  s = await status();
  assert.deepEqual([s.status, s.clientFrom], ['ready_to_connect', 'env']);
  assert.equal(new URL((await mc({ action: 'connect' })).body.url).searchParams.get('client_id'), 'env-111.apps.googleusercontent.com');
  const refused = await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /GOOGLE_CLIENT_ID/);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  // No ENC_KEY: nothing can be stored safely.
  const encKey = process.env.ENC_KEY;
  process.env.ENC_KEY = '';
  assert.equal((await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).status, 503);
  process.env.ENC_KEY = encKey;
  assert.deepEqual(leaks(answers), [], 'no key, secret or token in any answer');
});

test('callback: a bad, expired or reused state is refused, changes nothing and reveals nothing; "Cancel" on Google\'s screen is `denied`', async () => {
  await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const forged = await callback(`state=${crypto.randomBytes(24).toString('base64url')}&code=good-code`);
  assert.deepEqual([forged.status, forged.location, forged.body], [303, `${HUB}?error=state`, '']);
  assert.equal((await callback('code=good-code')).location, `${HUB}?error=state`, 'no state at all');
  assert.equal((await callback('state=%3Cscript%3E&code=good-code')).location, `${HUB}?error=state`);
  assert.equal(g.calls.length, 0, 'Google is never asked without a good state');
  assert.equal((await status()).status, 'ready_to_connect');

  const state = stateOf((await mc({ action: 'connect' })).body.url);
  const ok = await callback(`state=${state}&code=good-code`);
  assert.equal(ok.location, `${HUB}?connected=1`);
  assert.equal((await status()).status, 'connected');
  // The same state again (a replay): refused; the connection is unchanged.
  const tokenBefore = (await kv.hgetall(K.google())).refreshTokenEnc;
  const replay = await callback(`state=${state}&code=other-code`);
  assert.equal(replay.location, `${HUB}?error=state`);
  assert.equal(tokenCalls('authorization_code').length, 1);
  assert.equal((await kv.hgetall(K.google())).refreshTokenEnc, tokenBefore);

  // Older than 10 minutes: refused (and used up).
  const late = stateOf((await mc({ action: 'connect' })).body.url);
  io.now = () => new Date(Date.now() + 11 * 60e3);
  assert.equal((await callback(`state=${late}&code=good-code`)).location, `${HUB}?error=state`);
  io.now = realNow;
  assert.equal((await callback(`state=${late}&code=good-code`)).location, `${HUB}?error=state`, 'used up');
  // He pressed Cancel on Google's screen.
  const cancelled = stateOf((await mc({ action: 'connect' })).body.url);
  assert.equal((await callback(`error=access_denied&state=${cancelled}`)).location, `${HUB}?error=denied`);
  // A code Google does not accept.
  const bad = stateOf((await mc({ action: 'connect' })).body.url);
  assert.equal((await callback(`state=${bad}&code=wrong-code`)).location, `${HUB}?error=exchange`);
  assert.equal((await status()).status, 'connected', 'the good connection stays');
});

test('code exchange: the tokens are stored encrypted, the account is shown, no secret is in any answer or backup; the calendar box left unticked → calendar_permission', async () => {
  await connectGoogle();
  const ex = tokenCalls('authorization_code')[0];
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ex.body)), { code: 'good-code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' });
  assert.equal(ex.retry, false, 'a code is used once: never retried');
  const s = await status();
  assert.deepEqual([s.status, s.account, s.hasClient], ['connected', 'owner@gmail.com', true]);
  assert.ok(s.connectedAt);
  const conn = await kv.hgetall(K.google());
  assert.equal(decrypt(conn.refreshTokenEnc), REFRESH);
  assert.equal(conn.scope.split(' ')[0], CAL);
  assert.deepEqual(leaks(conn), []);
  const access = await kv.get(K.googleAccess());
  assert.equal(decrypt(access), 'at-1');
  const ttl = await kv.ttl(K.googleAccess());
  assert.ok(ttl > 3500 && ttl <= 3539, `cached until about a minute before it expires (${ttl})`);
  // Nothing secret in the hub's answers, the calendar, or the backup.
  const view = await calendarView({ now: MON });
  assert.equal(view.settings.googleMeet, 'connected');
  assert.deepEqual(leaks([answers, view]), []);
  const backup = await exportAll();
  assert.deepEqual(leaks(backup), []);
  const row = backup.keys.find((k) => k.key === K.google());
  assert.equal(row.value.account, 'owner@gmail.com');
  assert.ok(!('refreshTokenEnc' in row.value) && !('clientSecretEnc' in row.value) && !('clientIdEnc' in row.value));
  assert.ok(!backup.keys.some((k) => k.key === K.googleAccess() || k.key.startsWith('google:state:')));

  // The calendar permission unticked on Google's screen: not connected, and he is told why.
  __reset();
  g.scope = 'openid https://www.googleapis.com/auth/userinfo.email';
  await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const state = stateOf((await mc({ action: 'connect' })).body.url);
  assert.equal((await callback(`state=${state}&code=good-code`)).location, `${HUB}?error=calendar_permission`);
  assert.equal((await status()).status, 'ready_to_connect');
});

test('access token: cached until about a minute before it expires, then refreshed and cached again; a 401 mid-life refreshes once', async () => {
  await connectGoogle();
  assert.equal(await accessToken(), 'at-1');
  assert.equal(tokenCalls('refresh_token').length, 0, 'from the cache');
  await kv.del(K.googleAccess()); // what its EX does about a minute before Google's expiry
  assert.equal(await accessToken(), 'at-r1');
  const r = tokenCalls('refresh_token')[0];
  assert.deepEqual(Object.fromEntries(new URLSearchParams(r.body)), { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH, grant_type: 'refresh_token' });
  assert.ok(r.timeoutMs > 0 && r.timeoutMs <= GOOGLE_TIMING.callMs);
  assert.equal(await accessToken(), 'at-r1');
  assert.equal(tokenCalls('refresh_token').length, 1, 'cached again');
  // Google stops taking the cached token (revoked mid-life): one refresh, one retry.
  g.valid.delete('at-r1');
  const t = await mc({ action: 'test' });
  assert.equal(t.status, 200);
  assert.equal(tokenCalls('refresh_token').length, 2);
  assert.deepEqual(calls('POST').map((c) => c.headers.authorization), ['Bearer at-r1', 'Bearer at-r2']);
});

test('a refused refresh (invalid_grant): status broken, ONE google_disconnected alert, no more calls to Google; calls are still confirmed with the fallback', async () => {
  await connectGoogle();
  await kv.del(K.googleAccess());
  g.refreshError = 'invalid_grant';
  await assert.rejects(accessToken(), (e) => e instanceof GoogleError && e.code === 'broken');
  const s = await status();
  assert.deepEqual([s.status, s.account, s.problem], ['broken', 'owner@gmail.com', 'the connection was removed or has expired']);
  assert.ok(s.brokenAt);
  assert.ok(!(await kv.hgetall(K.google())).refreshTokenEnc, 'the dead token is gone');
  assert.deepEqual(alerts.map((a) => a.key), ['google_disconnected']);
  assert.equal(fill('alert:google_disconnected', ALERTS.google_disconnected.title, alerts[0].vars), 'Google Meet disconnected (owner@gmail.com) — reconnect it in Settings');
  assert.match(alerts[0].body, /Settings › Google Meet → Connect Google/);
  assert.equal(alerts[0].url, '/#settings/google');
  const refreshes = tokenCalls('refresh_token').length;
  await assert.rejects(accessToken(), (e) => e.code === 'broken');
  assert.equal(tokenCalls('refresh_token').length, refreshes, 'Google is not asked again');

  // A call confirmed now: confirmed, the fallback words, and the hub says why.
  const { meeting } = await asked();
  const r = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.meeting.status, r.body.meeting.meetLink, r.body.meeting.googleEventId], ['confirmed', null, null]);
  assert.equal(r.body.meeting.meetError, 'Google is disconnected — reconnect it in Settings › Google Meet');
  assert.match(toSam().at(-1).text, /\n\nI'll send the link before the call\.\n\n/);
  assert.deepEqual(alerts.filter((a) => a.key === 'google_disconnected').length, 1, 'still one alert');

  // Connecting again clears it.
  g.refreshError = null;
  io.now = realNow;
  const state = stateOf((await mc({ action: 'connect' })).body.url);
  assert.equal((await callback(`state=${state}&code=good-code`)).location, `${HUB}?connected=1`);
  const again = await status();
  assert.deepEqual([again.status, again.brokenAt, again.problem], ['connected', null, null]);
});

// ── the Calendar's hooks ─────────────────────────────────────────────────────

test('confirm: the Google event is made first (UTC times, the client as attendee, a Meet, no Google emails); the confirmation and its .ics carry the Meet link; the hub shows it', async () => {
  await connectGoogle();
  const { token, meeting } = await asked();
  order = [];
  const r = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(r.status, 200);
  const [create] = calls('POST');
  const u = new URL(create.url);
  assert.equal(`${u.origin}${u.pathname}`, EVENTS_URL);
  assert.deepEqual(Object.fromEntries(u.searchParams), { conferenceDataVersion: '1', sendUpdates: 'none' });
  assert.equal(create.retry, false, 'an insert never runs twice');
  assert.ok(create.timeoutMs > 0 && create.timeoutMs <= GOOGLE_TIMING.callMs);
  assert.equal(create.headers.authorization, 'Bearer at-1');
  const body = JSON.parse(create.body);
  assert.deepEqual(body.start, { dateTime: '2026-10-06T18:00:00Z' });
  assert.deepEqual(body.end, { dateTime: '2026-10-06T18:30:00Z' });
  assert.equal(body.summary, 'Onboarding call — eCreek IT');
  assert.deepEqual(body.attendees, [{ email: SAM, displayName: 'Sam Test' }]);
  assert.deepEqual(body.conferenceData, { createRequest: { requestId: meeting.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } });
  assert.equal(body.description, 'Onboarding call with Sam Test (eCreek IT), booked through Aviance.\nIn the hub: https://aviance.store/#trial/ecreek');
  // Google first, then the email with its link.
  assert.deepEqual(order, ['google:POST', 'mail:Confirmed: our call on Tue 6 Oct at 2:00 pm ET']);
  const LINK = 'https://meet.google.com/abc-defg-001';
  const mail = toSam().at(-1);
  assert.match(mail.text, /\n\nJoin here: https:\/\/meet\.google\.com\/abc-defg-001\n\n/);
  assert.equal(icsLine(mail, 'LOCATION'), LINK);
  assert.match(icsLine(mail, 'DESCRIPTION'), /Join here: https:\/\/meet\.google\.com\/abc-defg-001/);
  // Stored on the meeting and shown by the hub.
  const m = await getMeeting(meeting.id);
  assert.deepEqual([m.status, m.googleEventId, m.meetLink, m.meetError ?? null], ['confirmed', 'ev1', LINK, null]);
  assert.deepEqual([r.body.meeting.meetLink, r.body.meeting.googleEventId, r.body.meeting.meetError], [LINK, 'ev1', null]);
  const view = await calendarView({ from: '2026-10-05T00:00:00Z', to: '2026-10-12T00:00:00Z', now: at(MON, 2) });
  assert.deepEqual([view.meetings[0].meetLink, view.meetings[0].googleEventId, view.meetings[0].meetError], [LINK, 'ev1', null]);
  // Their booking page shows the link of their confirmed call.
  const { GET } = await import('@/app/c/[token]/book/route');
  const html = await (await GET(new Request(`https://app.test/c/${token}/book`), { params: Promise.resolve({ token }) })).text();
  assert.match(html, /Join here: <a href="https:\/\/meet\.google\.com\/abc-defg-001">/);
});

test('a Meet still being made is looked at again; move → the event is patched after the email (same link in it and its .ics); cancel → deleted after the email', async () => {
  await connectGoogle();
  const { meeting } = await asked();
  g.pendingPolls = 1;
  await hub({ action: 'confirm', id: meeting.id });
  assert.equal(calls('GET').length, 1, 'looked at once more');
  const LINK = 'https://meet.google.com/abc-defg-001';
  assert.equal((await getMeeting(meeting.id)).meetLink, LINK);
  assert.match(toSam().at(-1).text, /Join here: https:\/\/meet\.google\.com\/abc-defg-001/);

  order = [];
  const mv = await hub({ action: 'move', id: meeting.id, start: WED_10AM });
  assert.equal(mv.status, 200);
  const [patch] = calls('PATCH');
  const pu = new URL(patch.url);
  assert.equal(pu.pathname.split('/').pop(), 'ev1');
  assert.deepEqual(Object.fromEntries(pu.searchParams), { conferenceDataVersion: '1', sendUpdates: 'none' });
  const pb = JSON.parse(patch.body);
  assert.deepEqual([pb.start, pb.end], [{ dateTime: '2026-10-07T14:00:00Z' }, { dateTime: '2026-10-07T14:30:00Z' }]);
  assert.deepEqual(order, ['mail:New time for our call: Wed 7 Oct at 10:00 am ET', 'google:PATCH'], 'the email first: a failed send changes nothing');
  const moved = toSam().at(-1);
  assert.match(moved.text, /Join here: https:\/\/meet\.google\.com\/abc-defg-001/);
  assert.equal(icsLine(moved, 'LOCATION'), LINK);
  assert.equal(g.events.get('ev1').start.dateTime, '2026-10-07T14:00:00Z');
  assert.deepEqual([mv.body.meeting.meetLink, mv.body.meeting.googleEventId], [LINK, 'ev1']);

  order = [];
  const cx = await hub({ action: 'cancel', id: meeting.id, reason: 'Something came up' });
  assert.equal(cx.status, 200);
  const [del] = calls('DELETE');
  assert.equal(new URL(del.url).pathname.split('/').pop(), 'ev1');
  assert.equal(new URL(del.url).searchParams.get('sendUpdates'), 'none');
  assert.deepEqual(order, ['mail:Cancelled: our call on Wed 7 Oct at 10:00 am ET', 'google:DELETE']);
  assert.equal(g.events.size, 0, 'gone from his Google Calendar');
  const m = await getMeeting(meeting.id);
  assert.deepEqual([m.status, m.googleEventId, m.meetLink], ['cancelled', null, null]);
  assert.equal(calls('POST').length, 1);
  // Held / no-show touch nothing at Google (checked on a fresh call below).
});

test('they ask to move a confirmed call: Yes patches the same event (no second Meet); Decline deletes it; held / no-show leave Google alone', async () => {
  await connectGoogle();
  const { token, meeting } = await asked();
  await hub({ action: 'confirm', id: meeting.id });
  // They pick another time on the booking page: a request again, the event stays until the owner answers.
  io.now = () => at(MON, 3);
  assert.equal((await ask(token, WED_10AM)).status, 200);
  assert.equal(calls('PATCH').length + calls('DELETE').length, 0, 'their ask alone changes nothing at Google');
  io.now = () => at(MON, 4);
  const yes = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(yes.status, 200);
  assert.equal(calls('POST').length, 1, 'no second event');
  assert.equal(JSON.parse(calls('PATCH')[0].body).start.dateTime, '2026-10-07T14:00:00Z');
  assert.match(toSam().at(-1).text, /Join here: https:\/\/meet\.google\.com\/abc-defg-001/);
  // Again, and this time the owner declines: the call leaves his Google Calendar.
  io.now = () => at(MON, 5);
  assert.equal((await ask(token, TUE_2PM)).status, 200);
  io.now = () => at(MON, 6);
  const no = await hub({ action: 'decline', id: meeting.id, reason: 'I am away that day' });
  assert.equal(no.status, 200);
  assert.equal(calls('DELETE').length, 1);
  assert.equal(g.events.size, 0);
  assert.equal((await getMeeting(meeting.id)).googleEventId, null);

  // A call that happens: held / no-show make no Google call.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  io.now = realNow;
  await connectGoogle();
  const again = await asked();
  await hub({ action: 'confirm', id: again.meeting.id });
  const before = g.calls.length;
  io.now = () => at(MON, 30);
  assert.equal((await hub({ action: 'held', id: again.meeting.id })).status, 200);
  assert.equal((await hub({ action: 'noShow', id: again.meeting.id })).status, 200);
  assert.equal(g.calls.length, before);
});

test('Google down or not connected: the call is still confirmed, the email has the fallback words, the meeting carries meetError (none with the owner\'s own link)', async () => {
  // Never set up.
  let { meeting } = await asked();
  let r = await hub({ action: 'confirm', id: meeting.id });
  assert.deepEqual([r.status, r.body.meeting.status, r.body.meeting.meetLink, r.body.meeting.meetError], [200, 'confirmed', null, "Google isn't connected"]);
  assert.match(toSam().at(-1).text, /\n\nI'll send the link before the call\.\n\n/);
  assert.equal(icsLine(toSam().at(-1), 'LOCATION'), null);
  assert.equal(g.calls.length, 0, 'Google is not called at all');
  assert.equal((await calendarView({ now: at(MON, 2) })).settings.googleMeet, 'not_set_up');

  // Never set up, but his own meeting link is set: that link, and no "No Meet link" note.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test'), 'CALENDAR.meetingLink': JSON.stringify('https://zoom.us/j/123456') });
  io.now = realNow;
  ({ meeting } = await asked());
  r = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(r.body.meeting.meetError, null);
  assert.match(toSam().at(-1).text, /Join here: https:\/\/zoom\.us\/j\/123456/);

  // Connected, but Google does not answer: confirmed anyway, in time, with the fallback.
  __reset(); sent = [];
  await kv.hset('system:config', { 'OWNER.signerName': JSON.stringify('Limeth Sith'), 'ONBOARDCALL.inbox': JSON.stringify('onboard@aviance.test') });
  io.now = realNow;
  await connectGoogle();
  ({ meeting } = await asked());
  g.down = true;
  r = await hub({ action: 'confirm', id: meeting.id });
  assert.deepEqual([r.status, r.body.meeting.status, r.body.meeting.meetError], [200, 'confirmed', "Google didn't answer in time"]);
  assert.match(toSam().at(-1).text, /I'll send the link before the call\./);
  assert.equal((await status()).status, 'connected', 'a slow Google is not a broken connection');
  assert.deepEqual(alerts.filter((a) => a.key === 'google_disconnected'), []);
  // Moving it with Google still down: moved and emailed as usual.
  assert.equal((await hub({ action: 'move', id: meeting.id, start: WED_10AM })).status, 200);

  // Connected, but the Calendar API is not turned on in his Google Cloud project: named in plain words.
  g.down = false;
  g.apiError = { status: 403, json: { error: { code: 403, message: 'Google Calendar API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } } };
  const other = await hub({ action: 'add', clientId: ID, title: 'Follow-up', start: '2026-10-08T15:00:00Z', minutes: 30 });
  assert.equal(other.status, 200);
  assert.equal(other.body.meeting.meetError, 'The Google Calendar API is not turned on in your Google Cloud project (step 2 of the guide)');
});

test('email to them fails after the event was made: nothing confirmed (502), the event is kept on the request, and the next Yes reuses it', async () => {
  await connectGoogle();
  const { meeting } = await asked();
  const real = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ async sendMail() { throw new Error('SMTP down'); }, async verify() { return true; }, close() {} });
  const r = await hub({ action: 'confirm', id: meeting.id });
  nodemailer.createTransport = real;
  assert.equal(r.status, 502);
  const m = await getMeeting(meeting.id);
  assert.deepEqual([m.status, m.googleEventId, m.meetLink], ['requested', 'ev1', 'https://meet.google.com/abc-defg-001']);
  const again = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(again.status, 200);
  assert.equal(calls('POST').length, 1, 'one event, one Meet');
  assert.equal(calls('PATCH').length, 1);
  assert.match(toSam().at(-1).text, /Join here: https:\/\/meet\.google\.com\/abc-defg-001/);
});

test('the owner\'s own meeting with a client gets a Meet (nobody is emailed); without a client none; their "Yes, that works" gets one too', async () => {
  await connectGoogle();
  const { meeting } = await asked();
  const mails = sent.length;
  const withClient = await hub({ action: 'add', clientId: ID, title: 'Follow-up with Sam', start: '2026-10-08T15:00:00Z', minutes: 20 });
  assert.equal(withClient.status, 200);
  const body = JSON.parse(calls('POST')[0].body);
  assert.deepEqual([body.summary, body.start.dateTime, body.end.dateTime, body.attendees[0].email], ['Follow-up with Sam', '2026-10-08T15:00:00Z', '2026-10-08T15:20:00Z', SAM]);
  assert.equal(body.conferenceData.createRequest.requestId, withClient.body.meeting.id);
  assert.equal(withClient.body.meeting.meetLink, 'https://meet.google.com/abc-defg-001');
  assert.equal(sent.length, mails, 'nobody emailed');
  const alone = await hub({ action: 'add', clientId: null, title: 'Dentist', start: '2026-10-09T15:00:00Z', minutes: 60 });
  assert.equal(alone.status, 200);
  assert.equal(calls('POST').length, 1, 'no Google event without a client');
  assert.equal(alone.body.meeting.meetLink, null);

  // The owner suggests another time; their one click confirms it — with a Meet in that confirmation.
  await hub({ action: 'suggest', id: meeting.id, start: WED_10AM });
  const link = toSam().at(-1).text.match(/Yes, that works: https:\/\/app\.test\/c\/([^/\s]+)\/book\/accept\?m=(m[a-z0-9]+)/);
  const acceptRoute = await import('@/app/c/[token]/book/accept/route');
  io.now = () => at(MON, 3);
  const done = await acceptRoute.POST(new Request(`https://app.test/c/${link[1]}/book/accept?m=${link[2]}`, { method: 'POST' }), { params: Promise.resolve({ token: link[1] }) });
  assert.equal(done.status, 200);
  assert.equal(calls('POST').length, 2);
  assert.equal(JSON.parse(calls('POST')[1].body).start.dateTime, '2026-10-07T14:00:00Z');
  assert.match(toSam().at(-1).text, /Join here: https:\/\/meet\.google\.com\/abc-defg-002/);
  assert.equal((await getMeeting(meeting.id)).meetLink, 'https://meet.google.com/abc-defg-002');
});

// ── test + disconnect ────────────────────────────────────────────────────────

test('`test`: a 15-minute event with a Meet, deleted straight away → { ok, meetLink }; not connected → 409; Google\'s refusal in plain words', async () => {
  let r = await mc({ action: 'test' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /isn't set up yet/);
  await connectGoogle();
  io.now = () => new Date('2026-10-05T14:10:00Z');
  r = await mc({ action: 'test' });
  assert.deepEqual([r.status, r.body.ok, r.body.meetLink, r.body.removed], [200, true, 'https://meet.google.com/abc-defg-001', true]);
  const body = JSON.parse(calls('POST')[0].body);
  assert.deepEqual([body.start.dateTime, body.end.dateTime], ['2026-10-06T15:00:00Z', '2026-10-06T15:15:00Z'], 'tomorrow, 15 minutes');
  assert.equal(body.attendees, undefined, 'nobody invited');
  assert.equal(body.summary, 'Aviance test — safe to delete');
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.equal(new URL(calls('DELETE')[0].url).pathname.split('/').pop(), 'ev1');
  assert.equal(g.events.size, 0);
  g.apiError = { status: 403, json: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } };
  r = await mc({ action: 'test' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "Google didn't give the calendar permission — press Connect Google again and tick the calendar box.");
});

test('disconnect: revoked at Google and forgotten (the pasted client stays); a new Client ID forgets the old connection', async () => {
  await connectGoogle();
  const r = await mc({ action: 'disconnect' });
  assert.deepEqual([r.status, r.body.ok, r.body.revoked, r.body.status, r.body.account, r.body.hasClient], [200, true, true, 'ready_to_connect', null, true]);
  assert.deepEqual(g.revoked, [REFRESH]);
  const conn = await kv.hgetall(K.google());
  assert.ok(!conn.refreshTokenEnc && !conn.account && !conn.connectedAt);
  assert.ok(conn.clientIdEnc && conn.clientSecretEnc);
  assert.equal(await kv.get(K.googleAccess()), null);
  const { meeting } = await asked();
  const c = await hub({ action: 'confirm', id: meeting.id });
  assert.equal(c.body.meeting.meetError, "Google isn't connected");
  assert.equal(calls('POST').length, 0);

  // Connected again, then a different Client ID is pasted: the old tokens only work with the old client.
  io.now = realNow;
  const state = stateOf((await mc({ action: 'connect' })).body.url);
  await callback(`state=${state}&code=good-code`);
  assert.equal((await status()).status, 'connected');
  const other = await mc({ action: 'saveClient', clientId: '999-other.apps.googleusercontent.com', clientSecret: 'GOCSPX-other' });
  assert.equal(other.body.status, 'ready_to_connect');
  assert.deepEqual(g.revoked, [REFRESH, REFRESH]);
  // The same Client ID with a new secret keeps the connection.
  await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const s2 = stateOf((await mc({ action: 'connect' })).body.url);
  await callback(`state=${s2}&code=good-code`);
  assert.equal((await mc({ action: 'saveClient', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).body.status, 'connected');
  assert.deepEqual(leaks(answers), []);
});

// ── the middleware ───────────────────────────────────────────────────────────

test('middleware: only the Google callback is public; the hub\'s Google settings need a sign-in', async () => {
  process.env.ADMIN_SECRET = 'admin-secret-for-tests';
  const { middleware } = await import('@/middleware');
  const req = (path) => { const url = `https://email-distributor.vercel.app${path}`; return { url, method: 'GET', nextUrl: new URL(url), headers: new Headers(), cookies: { get: () => undefined } }; };
  const through = (res) => res.headers.get('x-middleware-next') === '1';
  assert.ok(through(await middleware(req('/api/google/callback?code=x&state=y'))));
  for (const path of ['/api/mc/google', '/api/google/callback/extra', '/api/google/other', '/api/google']) {
    const res = await middleware(req(path));
    assert.ok(!through(res), path);
    assert.equal(res.status, 401, path);
  }
});

test('one event, not two: the .ics invite reuses Google\'s iCalUID; the day-before reminder carries the Meet link', async () => {
  const { renderTemplate } = await import('@/lib/templates/client');
  const m = renderTemplate('onboard_call_tomorrow', { firstName: 'Sam', ownerName: 'Limeth', callMinutes: 30, when: 'Tuesday at 2:00 pm MT', callDay: 'tomorrow', joinLine: 'Join here: https://meet.google.com/abc-defg-hij' });
  assert.match(m.text, /Join here: https:\/\/meet\.google\.com\/abc-defg-hij/);
});
