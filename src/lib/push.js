/**
 * Phone alerts by Web Push (the owner's choice: a normal notification on his
 * iPhone from the Aviance Hub home-screen app — no Telegram, no SMS).
 *
 * The hub subscribes a phone with the machine's VAPID public key and posts the
 * subscription here; every owner alert is then pushed to every stored
 * subscription. Subscriptions the push service reports gone (404/410) are
 * removed. VAPID keys live in env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
 * VAPID_SUBJECT); without them push is simply "not configured".
 */

import webpush from 'web-push';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { sha256 } from '@/lib/crypto';

/** Test hook: replace the sender (defaults to web-push). */
export const pushIo = { send: (sub, payload, opts) => webpush.sendNotification(sub, payload, opts) };

export function vapid() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:limethsith@gmail.com').trim();
  return publicKey && privateKey ? { publicKey, privateKey, subject } : null;
}

const idOf = (endpoint) => sha256(String(endpoint || '')).slice(0, 32);

/** The browsers' own push services — the machine never posts alerts anywhere else. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

export function pushHostAllowed(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function validSubscription(sub) {
  return sub && typeof sub.endpoint === 'string' && pushHostAllowed(sub.endpoint)
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}

export async function savePushSub(subscription, device = '') {
  if (!validSubscription(subscription)) throw new Error('not a push subscription');
  const id = idOf(subscription.endpoint);
  const prev = await kv.hget(K.pushSubs(), id);
  const rec = { subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }, device: String(device || '').slice(0, 80), addedAt: prev?.addedAt || new Date().toISOString(), seenAt: new Date().toISOString() };
  await kv.hset(K.pushSubs(), { [id]: rec });
  return { count: await kv.hlen(K.pushSubs()) };
}

export async function removePushSub(endpoint) {
  await kv.hdel(K.pushSubs(), idOf(endpoint));
}

export async function pushStatus(endpoint) {
  const count = await kv.hlen(K.pushSubs());
  const subscribed = endpoint ? Boolean(await kv.hget(K.pushSubs(), idOf(endpoint))) : false;
  return { subscribed, count };
}

/**
 * Push one message to every stored subscription (or only `endpoint`).
 * payload: { title, body, url, tag, urgent }. Never throws.
 * @returns {{ok:boolean, sent:number, failed:number, removed:number, error?:string}}
 */
export async function pushToOwner(payload, { endpoint = null } = {}) {
  const keys = vapid();
  if (!keys) return { ok: false, sent: 0, failed: 0, removed: 0, error: 'push not configured' };
  let subs;
  try { subs = (await kv.hgetall(K.pushSubs())) || {}; } catch { subs = {}; }
  const entries = Object.entries(subs).filter(([, r]) => r && r.subscription && (!endpoint || r.subscription.endpoint === endpoint));
  if (!entries.length) return { ok: false, sent: 0, failed: 0, removed: 0, error: 'no phone subscribed' };
  const body = JSON.stringify({ at: new Date().toISOString(), ...payload });
  const opts = { vapidDetails: keys, TTL: payload.urgent ? 24 * 3600 : 6 * 3600, urgency: payload.urgent ? 'high' : 'normal', topic: String(payload.tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined, timeout: 8000 };
  let sent = 0; let failed = 0; let removed = 0;
  await Promise.all(entries.map(async ([id, rec]) => {
    try {
      await pushIo.send(rec.subscription, body, opts);
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await kv.hdel(K.pushSubs(), id); removed++; } catch {}
      }
    }
  }));
  return { ok: sent > 0, sent, failed, removed, ...(sent ? {} : { error: `push failed for ${failed} device(s)` }) };
}
