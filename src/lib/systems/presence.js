/**
 * Who uses the hub, and what they look at (docs/HUB-API.md "Employees").
 *
 * The hub posts presence events for every signed-in user (owner and
 * employees): signin, signout, a heartbeat (`active`, about every 60 s while
 * the page is visible) and `view` when a screen opens. Identity always comes
 * from the verified token, never from the body.
 *
 *   - hub:activity   capped list of {at, uid, email, name, role, event, view}
 *                    (heartbeats are not listed; a `view` identical to the
 *                    user's previous listed event within 10 minutes is not
 *                    listed again)
 *   - hub:person:X   one hash per user (see K.hubPerson)
 *   - hub:person:X:days   active seconds per day
 *
 * Active time: an `active` / `view` arriving within 3 minutes of lastSeen adds
 * the gap to the running totals.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';

export const EVENTS = ['signin', 'signout', 'active', 'view'];
export const LIST_CAP = 5000;
export const RATE_MAX = 120; // posts per user per 10 minutes; more are dropped silently
const RATE_WINDOW_S = 600;
const ACTIVE_GAP_MS = 3 * 60 * 1000;
const DEDUPE_MS = 10 * 60 * 1000;
const ONLINE_MS = 2 * 60 * 1000;

/** The day an active second counts on, in the owner's time zone (HUB_TZ, default Asia/Colombo). */
export function dayKey(date = new Date()) {
  const tz = process.env.HUB_TZ || 'Asia/Colombo';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

/**
 * Record one presence post.
 * @param {{uid: string, email: string, role: 'admin'|'employee', name?: string}} who  from the verified token
 * @param {{event: string, view?: string, name?: string}} body
 * @returns {Promise<{ok: true, listed?: boolean, limited?: boolean} | {ok: false, error: string}>}
 */
export async function recordPresence(who, body = {}, now = new Date()) {
  const event = String(body?.event || '');
  if (!EVENTS.includes(event)) return { ok: false, error: `event must be one of ${EVENTS.join(', ')}` };
  const uid = String(who?.uid || '');
  if (!uid) return { ok: false, error: 'no user' };
  const view = clean(body?.view, 60);

  // Per-user limit (silent: the hub does not need to know).
  const bucket = Math.floor(now.getTime() / (RATE_WINDOW_S * 1000));
  const rateKey = K.hubPresenceRate(uid, bucket);
  const n = await kv.incr(rateKey);
  if (n === 1) await kv.expire(rateKey, RATE_WINDOW_S + 60);
  if (n > RATE_MAX) return { ok: true, limited: true };

  const pKey = K.hubPerson(uid);
  const person = (await kv.hgetall(pKey)) || {};
  const at = now.toISOString();
  const name = clean(who.name, 80) || clean(person.name, 80) || clean(body?.name, 80) || clean(who.email, 120);

  const fields = { uid, email: clean(who.email, 120), name, role: who.role === 'admin' ? 'admin' : 'employee', lastSeen: at };
  if (!person.firstSeen) fields.firstSeen = at;
  if (event === 'signin') fields.lastSignIn = at;
  if (event === 'signout') fields.lastSignOut = at;
  if (view && (event === 'view' || event === 'active' || event === 'signin')) fields.lastView = view;

  // Active time: the gap since the last sign of life, when it is short.
  let addSeconds = 0;
  if (event === 'active' || event === 'view') {
    const gap = now.getTime() - ms(person.lastSeen);
    const signedOut = ms(person.lastSignOut) && ms(person.lastSignOut) >= ms(person.lastSeen);
    if (ms(person.lastSeen) && !signedOut && gap > 0 && gap <= ACTIVE_GAP_MS) addSeconds = Math.round(gap / 1000);
  }

  // The list: no heartbeats; a repeated view within 10 minutes is left out.
  let listed = event !== 'active';
  if (listed && event === 'view' && person.lastLoggedEvent === 'view' && String(person.lastLoggedView ?? '') === view
      && now.getTime() - ms(person.lastLoggedAt) < DEDUPE_MS) listed = false;
  if (listed) Object.assign(fields, { lastLoggedEvent: event, lastLoggedView: view, lastLoggedAt: at });

  const p = kv.pipeline();
  p.hset(pKey, fields);
  if (event === 'signin') p.hincrby(pKey, 'sessions', 1);
  if (addSeconds) {
    p.hincrby(pKey, 'activeSeconds', addSeconds);
    p.hincrby(K.hubPersonDays(uid), dayKey(now), addSeconds);
  }
  p.sadd(K.hubPeople(), uid);
  if (listed) {
    p.lpush(K.hubActivity(), { at, uid, email: fields.email, name, role: fields.role, event, view: view || null });
    p.ltrim(K.hubActivity(), 0, LIST_CAP - 1);
  }
  await p.exec();
  return { ok: true, listed };
}

/** The owner's "who is using the hub" view. */
export async function peopleView(now = new Date(), { events: eventLimit = 300 } = {}) {
  const ids = (await kv.smembers(K.hubPeople())) || [];
  const today = dayKey(now);
  const people = [];
  for (const uid of ids) {
    let h;
    try { h = await kv.hgetall(K.hubPerson(uid)); } catch { continue; }
    if (!h || !Object.keys(h).length) continue;
    const todaySecs = Number(await kv.hget(K.hubPersonDays(uid), today)) || 0;
    const lastSeen = h.lastSeen || null;
    const signedOut = ms(h.lastSignOut) && ms(h.lastSignOut) >= ms(lastSeen);
    people.push({
      uid: String(h.uid || uid),
      email: h.email || '',
      name: h.name || h.email || '',
      role: h.role === 'admin' ? 'admin' : 'employee',
      online: !!lastSeen && !signedOut && now.getTime() - ms(lastSeen) <= ONLINE_MS,
      firstSeen: h.firstSeen || null,
      lastSignIn: h.lastSignIn || null,
      lastSignOut: h.lastSignOut || null,
      lastSeen,
      lastView: h.lastView || null,
      sessions: Number(h.sessions) || 0,
      activeSecondsToday: todaySecs,
      activeSecondsTotal: Number(h.activeSeconds) || 0,
    });
  }
  people.sort((a, b) => (Number(b.online) - Number(a.online)) || (ms(b.lastSeen) - ms(a.lastSeen)));
  const raw = (await kv.lrange(K.hubActivity(), 0, eventLimit - 1)) || [];
  const events = raw.map((e) => (typeof e === 'string' ? (() => { try { return JSON.parse(e); } catch { return null; } })() : e)).filter(Boolean);
  return { people, events };
}
