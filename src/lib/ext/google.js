/**
 * Google Meet (docs/REPLYBOT-MEET.md §3, the owner's steps in
 * docs/GOOGLE-SETUP.md) — the owner connects his Google account once; from
 * then on every confirmed meeting gets an event on his primary Google
 * Calendar with a real Meet link.
 *
 *  - OAuth 2.0 web-server flow with plain fetch (no googleapis package):
 *    connectUrl → Google's consent screen → /api/google/callback →
 *    handleCallback swaps the code for tokens. Scope calendar.events, plus
 *    `openid email` to show which account is connected; offline access,
 *    prompt=consent (so a refresh token comes back every time).
 *  - The OAuth client: env GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET win, else
 *    the owner's pasted values. Those and the refresh token are encrypted in
 *    KV with ENC_KEY (lib/crypto.js) and never returned by any API.
 *  - accessToken(): cached in KV (encrypted) until about a minute before it
 *    expires, else refreshed. A refused refresh (access removed, the 7-day
 *    limit of an app left in "Testing", the client deleted) → status `broken`
 *    and ONE `google_disconnected` owner alert.
 *  - Calendar calls (insert with conferenceData, patch, delete) go through
 *    io.fetchJson with timeouts and one overall time budget, so tests stub
 *    them and a slow Google never holds a button press for long.
 *  - meetFor / moveMeet / dropMeet: what the Calendar (systems/calendar.js)
 *    calls. They never throw: Google failing must never block a meeting.
 *
 * No AI anywhere.
 */

import crypto from 'node:crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { encrypt, decrypt, hasEncKey, sha256 } from '@/lib/crypto';
import { logEvent } from '@/lib/db/events';
import { baseUrl } from '@/lib/notify';
import { io, asObject } from '@/lib/systems/intake-io';

const SYSTEM = 'google';
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const SCOPES = [CAL_SCOPE, 'openid', 'email'];
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
/** A consent-screen `state` is good for this long (seconds), once. */
export const STATE_TTL = 600;
/** Per call, for one whole button press, and the wait between looks at a Meet still being made (tests shorten them). */
export const GOOGLE_TIMING = { callMs: 8000, budgetMs: 15000, pollMs: 1000, polls: 2 };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Where the machine and the hub live. */
export const redirectUri = () => `${baseUrl()}/api/google/callback`;
export const hubUrl = () => String(process.env.HUB_URL || 'https://aviance.store').replace(/\/+$/, '');

// ─── errors in plain words ───────────────────────────────────────────────────

const WORDS = {
  not_set_up: "Google isn't set up yet — paste the Client ID and Client secret in Settings › Google Meet.",
  not_connected: "Google isn't connected — press Connect Google in Settings › Google Meet.",
  broken: 'Google is disconnected — press Connect Google again in Settings › Google Meet.',
  no_enc_key: 'ENC_KEY is not set on the server, so the Google keys cannot be stored safely yet.',
  env_client: 'The Client ID is set on the server (GOOGLE_CLIENT_ID) — change it there.',
  bad_client_id: "That doesn't look like a Google Client ID — it ends with .apps.googleusercontent.com.",
  bad_client_secret: 'Paste the Client secret too (it usually starts with GOCSPX-).',
  timeout: "Google didn't answer in time.",
  network: "Google couldn't be reached.",
};
const HTTP = { not_set_up: 409, not_connected: 409, broken: 409, no_enc_key: 503, env_client: 409, bad_client_id: 400, bad_client_secret: 400 };

/** A Google problem: `code` for the machine, the message for the owner. */
export class GoogleError extends Error {
  constructor(code, message = null) { super(message || WORDS[code] || code); this.code = code; this.status = HTTP[code] || 502; }
}
const asGoogleError = (err) => (err instanceof GoogleError ? err : new GoogleError('api', String(err?.message || err).slice(0, 200)));

/** The hub's "No Meet link — …" reason. */
function shortWhy(e) {
  if (e.code === 'not_set_up' || e.code === 'not_connected') return "Google isn't connected";
  if (e.code === 'broken') return 'Google is disconnected — reconnect it in Settings › Google Meet';
  return e.message.replace(/\.$/, '');
}

/** Google's error answer → plain words (the two setup mistakes are named). */
function apiProblem(r) {
  const e = asObject(r?.json?.error) || {};
  const reason = String(e.errors?.[0]?.reason || '');
  const msg = String(e.message || (typeof r?.json?.error === 'string' ? r.json.error : '') || '');
  if (reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(msg)) return 'The Google Calendar API is not turned on in your Google Cloud project (step 2 of the guide).';
  if (reason === 'insufficientPermissions' || /insufficient (authentication )?scopes?|insufficient permission/i.test(msg)) return "Google didn't give the calendar permission — press Connect Google again and tick the calendar box.";
  return `Google said ${r?.status || 'no'}${msg ? `: ${msg.slice(0, 140)}` : ''}`;
}

// ─── the stored connection ───────────────────────────────────────────────────

const open = (v) => { try { return v ? decrypt(v) : null; } catch { return null; } };
const readConn = async () => (await kv.hgetall(K.google())) || {};

/** The OAuth client: env wins, else the owner's saved one. Null when neither is complete. */
async function oauthClient(conn = null) {
  const envId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const envSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (envId && envSecret) return { id: envId, secret: envSecret, from: 'env' };
  const c = conn || await readConn();
  const id = open(c.clientIdEnc);
  const secret = open(c.clientSecretEnc);
  return id && secret ? { id, secret, from: 'saved' } : null;
}

/**
 * GET /api/mc/google → { status: not_set_up|ready_to_connect|connected|broken,
 * account, redirectUri, hasClient, clientFrom, connectedAt, brokenAt, problem,
 * encKey }. Never a key, a secret or a token.
 */
export async function googleStatus() {
  const conn = await readConn();
  const client = await oauthClient(conn);
  const status = !client ? 'not_set_up' : conn.refreshTokenEnc ? 'connected' : conn.brokenAt ? 'broken' : 'ready_to_connect';
  return {
    status,
    account: (status === 'connected' || status === 'broken') && conn.account ? String(conn.account) : null,
    redirectUri: redirectUri(),
    hasClient: Boolean(client),
    clientFrom: client?.from || null,
    connectedAt: status === 'connected' ? conn.connectedAt || null : null,
    brokenAt: status === 'broken' ? conn.brokenAt || null : null,
    problem: status === 'broken' ? conn.brokenReason || WORDS.broken : null,
    encKey: hasEncKey(),
  };
}

/** Save the pasted Client ID + secret (encrypted). A different client forgets the old connection (its tokens only work with their own client). */
export async function saveClient({ clientId, clientSecret } = {}, { now = io.now() } = {}) {
  if (String(process.env.GOOGLE_CLIENT_ID || '').trim() && String(process.env.GOOGLE_CLIENT_SECRET || '').trim()) throw new GoogleError('env_client');
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[a-z0-9-]{5,120}\.apps\.googleusercontent\.com$/i.test(id)) throw new GoogleError('bad_client_id');
  if (secret.length < 8 || secret.length > 200 || /\s/.test(secret)) throw new GoogleError('bad_client_secret');
  if (!hasEncKey()) throw new GoogleError('no_enc_key');
  const conn = await readConn();
  const oldId = open(conn.clientIdEnc);
  if (oldId && oldId !== id && (conn.refreshTokenEnc || conn.brokenAt)) await forget(conn, { revoke: true });
  await kv.hset(K.google(), { clientIdEnc: encrypt(id), clientSecretEnc: encrypt(secret), updatedAt: now.toISOString() });
  await kv.del(K.googleAccess());
  await logEvent(null, SYSTEM, 'client_saved', { changed: Boolean(oldId && oldId !== id) });
  return googleStatus();
}

// ─── connecting (OAuth consent) ──────────────────────────────────────────────

/** POST { action: 'connect' } → the consent-screen address, with a one-use `state` kept 10 minutes. */
export async function connectUrl({ now = io.now() } = {}) {
  const client = await oauthClient();
  if (!client) throw new GoogleError('not_set_up');
  if (!hasEncKey()) throw new GoogleError('no_enc_key');
  const state = crypto.randomBytes(24).toString('base64url');
  await kv.set(K.googleState(sha256(state)), JSON.stringify({ at: now.toISOString() }), { ex: STATE_TTL });
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** One use only: the state must be one we made, under 10 minutes old; it is gone afterwards either way. */
async function takeState(state, now) {
  const s = String(state || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(s)) return false;
  const key = K.googleState(sha256(s));
  const v = await kv.get(key);
  const gone = await kv.del(key); // Redis DEL is atomic: of two callbacks with one state, only one gets 1
  if (!v || gone !== 1) return false;
  const at = Date.parse(asObject(v)?.at || '');
  return Number.isFinite(at) && now.getTime() - at <= STATE_TTL * 1000 && at - now.getTime() <= 60e3;
}

/** The account's address from the id_token (it came straight from Google's token endpoint over TLS, so no signature check is needed). */
function emailOf(idToken) {
  try {
    const p = JSON.parse(Buffer.from(String(idToken || '').split('.')[1] || '', 'base64url').toString('utf8'));
    return p?.email && p.email_verified !== false ? String(p.email).toLowerCase() : null;
  } catch { return null; }
}

async function userinfoEmail(accessToken) {
  try {
    const r = await send(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    return r.ok && r.json?.email ? String(r.json.email).toLowerCase() : null;
  } catch { return null; }
}

async function cacheAccess(token, expiresIn) {
  const ttl = Math.floor(Number(expiresIn) || 3600) - 60;
  if (!token || ttl < 30) return;
  try { await kv.set(K.googleAccess(), encrypt(token), { ex: ttl }); } catch {}
}

/**
 * GET /api/google/callback?code&state → { ok, account } or { ok: false, error:
 * short code }. The state is checked first: a callback the machine did not
 * start changes nothing and says nothing more than `state`.
 */
export async function handleCallback({ code = null, state = null, error = null } = {}, { now = io.now() } = {}) {
  if (!(await takeState(state, now))) return { ok: false, error: 'state' };
  if (error) return { ok: false, error: error === 'access_denied' ? 'denied' : 'google' };
  if (!code) return { ok: false, error: 'no_code' };
  if (!hasEncKey()) return { ok: false, error: 'server' };
  const conn = await readConn();
  const client = await oauthClient(conn);
  if (!client) return { ok: false, error: 'not_set_up' };
  let r;
  try {
    r = await send(TOKEN_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ code: String(code), client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }).toString() });
  } catch {
    return { ok: false, error: 'google_down' };
  }
  if (!r.ok || !r.json?.access_token) {
    await logEvent(null, SYSTEM, 'connect_failed', { status: r.status, error: String(r.json?.error || '').slice(0, 60) });
    return { ok: false, error: 'exchange' };
  }
  const granted = String(r.json.scope || '').split(/\s+/).filter(Boolean);
  if (!granted.includes(CAL_SCOPE)) return { ok: false, error: 'calendar_permission' };
  if (!r.json.refresh_token) return { ok: false, error: 'no_refresh_token' };
  const account = emailOf(r.json.id_token) || await userinfoEmail(r.json.access_token);
  await kv.hdel(K.google(), 'brokenAt', 'brokenReason');
  await kv.hset(K.google(), { refreshTokenEnc: encrypt(r.json.refresh_token), account: account || '', scope: granted.join(' '), connectedAt: now.toISOString(), updatedAt: now.toISOString() });
  await cacheAccess(r.json.access_token, r.json.expires_in);
  await logEvent(null, SYSTEM, 'connected', { account });
  return { ok: true, account };
}

/** Forget the connection (the pasted client stays): the tokens, the account, the broken mark. */
async function forget(conn, { revoke = true } = {}) {
  const refresh = open(conn.refreshTokenEnc);
  let revoked = false;
  if (revoke && refresh) {
    try {
      const r = await send(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ token: refresh }).toString() });
      revoked = r.ok;
    } catch {}
  }
  await kv.hdel(K.google(), 'refreshTokenEnc', 'account', 'scope', 'connectedAt', 'brokenAt', 'brokenReason');
  await kv.del(K.googleAccess());
  return revoked;
}

/** POST { action: 'disconnect' }: revoke at Google (best effort) and forget. */
export async function disconnect() {
  const revoked = await forget(await readConn(), { revoke: true });
  await logEvent(null, SYSTEM, 'disconnected', { revoked });
  return { ...(await googleStatus()), revoked };
}

// ─── access tokens ───────────────────────────────────────────────────────────

/** Google refused the refresh token: status `broken`, and the owner is told once. */
async function markBroken(conn, reason, now) {
  const at = now.toISOString();
  const first = await kv.hsetnx(K.google(), 'brokenAt', at);
  await kv.hset(K.google(), { brokenReason: reason, updatedAt: at });
  await kv.hdel(K.google(), 'refreshTokenEnc');
  await kv.del(K.googleAccess());
  if (!first) return;
  await logEvent(null, SYSTEM, 'broken', { reason });
  try {
    await io.alertOwner('google_disconnected', {
      scope: `google:${conn.connectedAt || 'x'}`,
      vars: { account: conn.account || 'your Google account' },
      body: `Google stopped letting the machine use the calendar of ${conn.account || 'your Google account'} (${reason}). Calls you confirm now get no Google Meet link until you reconnect: hub → Settings › Google Meet → Connect Google.`,
      did: "Kept confirming calls as usual; their emails say I'll send the link before the call.",
      url: '/#settings/google',
    });
  } catch (err) { console.error('[google] alert failed', err?.message); }
}

const REFUSED = {
  invalid_grant: 'the connection was removed or has expired',
  invalid_client: 'the Client ID or Client secret is no longer valid',
  unauthorized_client: 'the Client ID is no longer allowed',
};

/** A working access token (from the cache, else refreshed). Throws GoogleError. */
export async function accessToken({ fresh = false, deadline = null, now = io.now() } = {}) {
  const conn = await readConn();
  const client = await oauthClient(conn);
  if (!client) throw new GoogleError('not_set_up');
  if (!conn.refreshTokenEnc) throw new GoogleError(conn.brokenAt ? 'broken' : 'not_connected');
  if (!fresh) {
    const cached = open(await kv.get(K.googleAccess()));
    if (cached) return cached;
  }
  const refresh = open(conn.refreshTokenEnc);
  if (!refresh) {
    await markBroken(conn, 'the saved connection could not be read (was ENC_KEY changed?)', now);
    throw new GoogleError('broken');
  }
  const r = await send(TOKEN_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: 'refresh_token' }).toString(), deadline });
  if (r.ok && r.json?.access_token) {
    await cacheAccess(r.json.access_token, r.json.expires_in);
    return r.json.access_token;
  }
  const code = String(r.json?.error || '');
  if ((r.status === 400 || r.status === 401) && REFUSED[code]) {
    await markBroken(conn, REFUSED[code], now);
    throw new GoogleError('broken');
  }
  throw new GoogleError('api', `Google did not give a new access key (${r.status}${code ? ` ${code}` : ''}).`);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** One call through io.fetchJson (stubbed in tests), inside the time left. No automatic retry: an insert must never run twice. */
async function send(url, { method = 'GET', headers = {}, body = undefined, deadline = null } = {}) {
  const left = (deadline ?? Date.now() + GOOGLE_TIMING.callMs) - Date.now();
  if (left < 300) throw new GoogleError('timeout');
  try {
    return await io.fetchJson(url, { method, headers, body, timeoutMs: Math.min(GOOGLE_TIMING.callMs, left), retry: false, service: 'google' });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(String(err?.message || ''));
    throw new GoogleError(timedOut ? 'timeout' : 'network');
  }
}

/** A Calendar API call with the owner's token; a 401 (token revoked mid-life) refreshes once and tries again. */
async function gcal(method, url, { body = null, deadline = null } = {}, retried = false) {
  const token = await accessToken({ fresh: retried, deadline });
  const r = await send(url, { method, deadline, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && !retried) return gcal(method, url, { body, deadline }, true);
  return r;
}

// ─── Calendar events ─────────────────────────────────────────────────────────

const rfc3339 = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const meetLinkOf = (ev) => ev?.hangoutLink || ev?.conferenceData?.entryPoints?.find((e) => e?.entryPointType === 'video')?.uri || null;
const conferenceStatus = (ev) => ev?.conferenceData?.createRequest?.status?.statusCode || null;
const eventUrl = (id, qs = '') => `${EVENTS_URL}/${encodeURIComponent(id)}${qs}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The meeting's start and end, UTC (RFC 3339). */
function timesOf(m) {
  const t = Date.parse(m.start);
  return { start: { dateTime: rfc3339(t) }, end: { dateTime: rfc3339(t + (Number(m.minutes) || 30) * 60e3) } };
}

/**
 * The event for a meeting: summary = its title, its time in UTC, the client as
 * the attendee (so they join without knocking), a Meet made by Google
 * (requestId = the meeting id), and a short line + the hub link.
 */
export function eventBody(m, { requestId = m.id, description = null } = {}) {
  const who = [m.person, m.company ? `(${m.company})` : ''].filter(Boolean).join(' ');
  const hub = m.clientId ? `${hubUrl()}/#trial/${m.clientId}` : `${hubUrl()}/#calendar`;
  return {
    summary: String(m.title || 'Call'),
    description: description || `${m.kind === 'onboarding' ? 'Onboarding call' : 'Call'}${who ? ` with ${who}` : ''}, booked through Aviance.\nIn the hub: ${hub}`,
    ...timesOf(m),
    ...(m.email ? { attendees: [{ email: String(m.email), ...(m.person ? { displayName: String(m.person) } : {}) }] } : {}),
    conferenceData: { createRequest: { requestId: String(requestId), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    extendedProperties: { private: { avianceMeetingId: String(m.id) } },
  };
}

/** Insert on the primary calendar (no emails from Google) and read back the Meet link; a Meet still `pending` is looked at once or twice more. */
async function createEvent(m, { deadline, requestId = m.id, description = null } = {}) {
  const r = await gcal('POST', `${EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`, { body: eventBody(m, { requestId, description }), deadline });
  if (!r.ok || !r.json?.id) throw new GoogleError('api', apiProblem(r));
  let ev = r.json;
  for (let i = 0; i < GOOGLE_TIMING.polls && !meetLinkOf(ev) && conferenceStatus(ev) === 'pending'; i++) {
    if (deadline - Date.now() < GOOGLE_TIMING.pollMs + 1500) break;
    await sleep(GOOGLE_TIMING.pollMs);
    try {
      const g = await gcal('GET', eventUrl(ev.id), { deadline });
      if (g.ok && g.json?.id) ev = g.json;
    } catch { break; }
  }
  const link = meetLinkOf(ev);
  return { eventId: String(ev.id), meetLink: link, pending: !link && conferenceStatus(ev) === 'pending' };
}

/** New times (and title) on an existing event; `gone` when it was deleted in Google Calendar. */
async function patchEvent(m, { deadline }) {
  const r = await gcal('PATCH', eventUrl(m.googleEventId, '?conferenceDataVersion=1&sendUpdates=none'), { body: { summary: String(m.title || 'Call'), ...timesOf(m) }, deadline });
  if (r.ok) return { ok: true, meetLink: meetLinkOf(r.json) };
  if (r.status === 404 || r.status === 410) return { ok: false, gone: true };
  throw new GoogleError('api', apiProblem(r));
}

/** Delete an event (already gone counts as done). */
async function deleteEvent(eventId, { deadline }) {
  const r = await gcal('DELETE', eventUrl(eventId, '?sendUpdates=none'), { deadline });
  if (r.ok || r.status === 404 || r.status === 410) return { ok: true };
  throw new GoogleError('api', apiProblem(r));
}

// ─── what the Calendar calls (never throws) ──────────────────────────────────

/**
 * A meeting being confirmed (confirm, their yes to a suggestion, the owner's
 * `add` with a client): its event on the owner's Google Calendar with a Meet —
 * created, or moved to the meeting's time when it already has one (a call
 * that had been confirmed before). → the fields to store on the meeting:
 * { googleEventId, meetLink, meetError }. Never throws: on any failure the
 * meeting keeps what it had and `meetError` says why in plain words (none when
 * Google was never set up and CALENDAR.meetingLink is: his own link is used).
 */
export async function meetFor(m, { fixedLink = null } = {}) {
  const deadline = Date.now() + GOOGLE_TIMING.budgetMs;
  try {
    let requestId = m.id;
    if (m.googleEventId) {
      const p = await patchEvent(m, { deadline });
      if (p.ok) {
        const link = p.meetLink || m.meetLink || null;
        return { googleEventId: m.googleEventId, meetLink: link, meetError: link ? null : 'Google made no Meet link for this call' };
      }
      // Deleted in Google Calendar by hand: a new event (a new request id, or Google would ignore the Meet request).
      requestId = `${m.id}-${Date.now().toString(36)}`;
    }
    const ev = await createEvent(m, { deadline, requestId });
    await logEvent(m.clientId || null, SYSTEM, 'event_created', { meetingId: m.id, eventId: ev.eventId, meet: Boolean(ev.meetLink) });
    return { googleEventId: ev.eventId, meetLink: ev.meetLink, meetError: ev.meetLink ? null : ev.pending ? 'Google was still making the Meet link' : 'Google made the event but no Meet link' };
  } catch (err) {
    const e = asGoogleError(err);
    if (e.code === 'not_set_up' && fixedLink) return { meetError: null };
    // Never set up / not connected is the owner's choice, not an event worth logging on every call.
    if (e.code !== 'not_set_up' && e.code !== 'not_connected') await logEvent(m.clientId || null, SYSTEM, 'meet_failed', { meetingId: m.id, code: e.code, error: e.message.slice(0, 200) });
    return { meetError: m.meetLink ? null : shortWhy(e) };
  }
}

/** A confirmed call moved: its event follows (same Meet link). Never throws; a failure is logged (the link still works). */
export async function moveMeet(m) {
  if (!m?.googleEventId) return {};
  try {
    const p = await patchEvent(m, { deadline: Date.now() + GOOGLE_TIMING.budgetMs });
    if (!p.ok) await logEvent(m.clientId || null, SYSTEM, 'move_failed', { meetingId: m.id, error: 'the event was deleted in Google Calendar' });
    return p.ok && p.meetLink && !m.meetLink ? { meetLink: p.meetLink, meetError: null } : {};
  } catch (err) {
    await logEvent(m.clientId || null, SYSTEM, 'move_failed', { meetingId: m.id, error: asGoogleError(err).message.slice(0, 200) });
    return {};
  }
}

/** A cancelled / declined call: its event goes from his Google Calendar. Never throws; a failure is logged. */
export async function dropMeet(m) {
  if (!m?.googleEventId) return {};
  try {
    await deleteEvent(m.googleEventId, { deadline: Date.now() + GOOGLE_TIMING.budgetMs });
    await logEvent(m.clientId || null, SYSTEM, 'event_deleted', { meetingId: m.id, eventId: m.googleEventId });
    return { googleEventId: null, meetLink: null, meetError: null };
  } catch (err) {
    await logEvent(m.clientId || null, SYSTEM, 'delete_failed', { meetingId: m.id, eventId: m.googleEventId, error: asGoogleError(err).message.slice(0, 200) });
    return {};
  }
}

/** POST { action: 'test' }: a 15-minute event with a Meet tomorrow, deleted straight away → { ok, meetLink }. Throws GoogleError. */
export async function testMeet({ now = io.now() } = {}) {
  const deadline = Date.now() + GOOGLE_TIMING.budgetMs;
  const start = Math.ceil((now.getTime() + 864e5) / 3600e3) * 3600e3;
  const m = { id: `test-${crypto.randomBytes(6).toString('hex')}`, title: 'Aviance test — safe to delete', start: new Date(start).toISOString(), minutes: 15, kind: 'other' };
  const ev = await createEvent(m, { deadline, description: 'A test from Aviance (Settings › Google Meet › Test it). It deletes itself straight away.' });
  let removed = false;
  try { removed = (await deleteEvent(ev.eventId, { deadline: Date.now() + GOOGLE_TIMING.callMs })).ok; } catch {}
  await logEvent(null, SYSTEM, 'tested', { meet: Boolean(ev.meetLink), removed });
  if (!ev.meetLink) {
    throw new GoogleError('api', ev.pending
      ? 'Google made the test event but was still making the Meet link — try again in a minute.'
      : 'Google made the test event but no Meet link — check that Google Meet is turned on for this account.');
  }
  return { ok: true, meetLink: ev.meetLink, removed, ...(removed ? {} : { note: 'The test event could not be removed — delete "Aviance test" from your Google Calendar.' }) };
}

/** The status word only (the Calendar's settings carry it). Never throws. */
export async function googleState() {
  try { return (await googleStatus()).status; } catch { return 'not_set_up'; }
}
