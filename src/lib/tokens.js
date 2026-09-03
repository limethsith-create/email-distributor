/**
 * Signed tokens for the open-tracking pixel and the one-click unsubscribe
 * link. Kept dependency-free (no nodemailer, no KV) so the public pixel and
 * unsubscribe routes stay tiny and cold-start fast.
 */

import crypto from 'crypto';

/**
 * Absolute base URL the pixel and unsubscribe link point at. Must be publicly
 * reachable over HTTPS so mail clients can load it.
 */
export const TRACKING_BASE_URL = (
  process.env.TRACKING_BASE_URL ||
  process.env.NEXT_PUBLIC_BASE_URL ||
  'https://email-distributor.vercel.app'
).replace(/\/+$/, '');

/** Secret for signed tokens (falls back to CRON_SECRET, then a fixed string). */
const TOKEN_SECRET = process.env.TRACKING_SECRET || process.env.CRON_SECRET || 'aviance-tracking';

function hmac(payload) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url').slice(0, 22);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Signed open-tracking token, v2: `v2.<payload>.<sig>` where payload is
 * base64url(JSON{ e: email, t: touch, s: sentAtSeconds }). Carrying the touch
 * and send time lets the pixel route tell day-0 / day-3 / day-7 opens apart,
 * flag scanner hits that fire seconds after delivery, and makes every touch a
 * distinct URL so an image proxy can't serve a cached copy of the last one.
 * Legacy v1 tokens (plain base64url of the email) stay accepted by the route.
 */
export function buildTrackingToken(toEmail, touch = 'd0', sentAt = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    e: String(toEmail).trim().toLowerCase(),
    t: String(touch || 'd0'),
    s: Math.floor(sentAt / 1000),
  })).toString('base64url');
  return `v2.${payload}.${hmac(payload)}`;
}

/** Verify a v2 token; returns { email, touch, sentAt } or null. */
export function verifyTrackingToken(token) {
  try {
    const m = /^v2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
    if (!m || !safeEqual(hmac(m[1]), m[2])) return null;
    const data = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (!data || typeof data.e !== 'string' || !data.e.includes('@') || data.e.length > 200) return null;
    return { email: data.e.toLowerCase(), touch: String(data.t || 'd0'), sentAt: (Number(data.s) || 0) * 1000 };
  } catch {
    return null;
  }
}

/** Decode a legacy v1 token (plain base64url email); returns the email or null. */
export function decodeLegacyTrackingToken(token) {
  try {
    const email = Buffer.from(String(token || ''), 'base64url').toString('utf8').trim().toLowerCase();
    if (email && email.includes('@') && email.length < 200 && /^[^\s@]+@[^\s@]+$/.test(email)) return email;
  } catch {}
  return null;
}

/** Signed one-click unsubscribe token for a recipient. */
export function buildUnsubscribeToken(toEmail) {
  const payload = Buffer.from(String(toEmail).trim().toLowerCase()).toString('base64url');
  return `${payload}.${hmac(`unsub:${payload}`)}`;
}

/** Verify an unsubscribe token; returns the email or null. */
export function verifyUnsubscribeToken(token) {
  try {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
    if (!m || !safeEqual(hmac(`unsub:${m[1]}`), m[2])) return null;
    const email = Buffer.from(m[1], 'base64url').toString('utf8').trim().toLowerCase();
    return email.includes('@') && email.length < 200 ? email : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(toEmail) {
  return `${TRACKING_BASE_URL}/api/unsubscribe?t=${buildUnsubscribeToken(toEmail)}`;
}

export function trackingPixelUrl(toEmail, touch = 'd0', sentAt = Date.now()) {
  return `${TRACKING_BASE_URL}/api/track/open?t=${buildTrackingToken(toEmail, touch, sentAt)}`;
}
