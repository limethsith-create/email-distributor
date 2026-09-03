/**
 * Per-inbox connection health — one durable record per sending address in the
 * `inbox_health` KV hash, written on every SMTP send attempt and every IMAP
 * scan. This is what makes a dead inbox (wrong app password, IMAP disabled,
 * provider throttling) visible within one run instead of showing up as
 * "the Replies tab stays at 0" days later, and what lets the sender skip an
 * inbox that keeps failing instead of burning a whole heartbeat on it.
 *
 * Record shape (all optional):
 *   lastSendAt, lastSuccessAt, lastSendMs, lastResponse, lastMessageId
 *   lastError, lastErrorKind, lastErrorCode, lastErrorAt, consecutiveFailures
 *   disabledReason, disabledAt, nextSendAt
 *   imapLastOkAt, imapLastError, imapLastErrorAt, imapConsecutiveFailures,
 *   imapFolders, imapLastScanMs, imapLastNewMessages
 *   firstSendAt, bouncesToday, bouncesTodayKey
 */

import { kv } from '@vercel/kv';

export const INBOX_HEALTH_KEY = 'inbox_health';

/** Consecutive SMTP failures before the sender skips the inbox for a while. */
export const SKIP_AFTER_FAILURES = 3;
/** How long a failing inbox is skipped before it gets another try. */
export const SKIP_COOLDOWN_MS = 30 * 60 * 1000;

const norm = (email) => String(email || '').trim().toLowerCase();

export async function getInboxHealth() {
  try {
    const map = await kv.hgetall(INBOX_HEALTH_KEY);
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

export async function getInboxHealthFor(email) {
  try {
    const rec = await kv.hget(INBOX_HEALTH_KEY, norm(email));
    return rec && typeof rec === 'object' ? rec : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the inbox's record (or apply a function(existing)). */
export async function updateInboxHealth(email, patch) {
  const key = norm(email);
  if (!key) return null;
  try {
    const existing = await getInboxHealthFor(key);
    const p = typeof patch === 'function' ? patch(existing) : patch;
    if (!p) return existing;
    const updated = { ...existing, ...p, email: key, updatedAt: new Date().toISOString() };
    await kv.hset(INBOX_HEALTH_KEY, { [key]: updated });
    return updated;
  } catch {
    return null;
  }
}

/** Record a successful SMTP send. */
export function recordSendSuccess(email, meta = {}) {
  const now = new Date().toISOString();
  return updateInboxHealth(email, (h) => ({
    lastSendAt: now,
    lastSuccessAt: now,
    lastSendMs: meta.ms ?? null,
    lastResponse: meta.response ?? null,
    lastMessageId: meta.messageId ?? null,
    consecutiveFailures: 0,
    lastError: null,
    lastErrorKind: null,
    lastErrorCode: null,
    firstSendAt: h.firstSendAt || now,
    sendsTotal: (Number(h.sendsTotal) || 0) + 1,
  }));
}

/** Record a failed SMTP send (classified by mailer.classifySmtpError). */
export function recordSendFailure(email, failure = {}) {
  const now = new Date().toISOString();
  return updateInboxHealth(email, (h) => ({
    lastSendAt: now,
    lastErrorAt: now,
    lastError: String(failure.error || failure.message || 'unknown').slice(0, 300),
    lastErrorKind: failure.kind || 'other',
    lastErrorCode: failure.code || failure.responseCode || null,
    lastErrorCommand: failure.command || null,
    consecutiveFailures: (Number(h.consecutiveFailures) || 0) + 1,
    failuresTotal: (Number(h.failuresTotal) || 0) + 1,
  }));
}

/** Record the outcome of an IMAP scan. */
export function recordImapResult(email, result = {}) {
  const now = new Date().toISOString();
  return updateInboxHealth(email, (h) => (result.ok
    ? {
        imapLastOkAt: now,
        imapLastError: null,
        imapConsecutiveFailures: 0,
        imapFolders: result.folders || h.imapFolders || null,
        imapLastScanMs: result.ms ?? null,
        imapLastNewMessages: result.newMessages ?? 0,
        imapLastCandidates: result.candidates ?? 0,
      }
    : {
        imapLastErrorAt: now,
        imapLastError: String(result.error || 'unknown').slice(0, 300),
        imapConsecutiveFailures: (Number(h.imapConsecutiveFailures) || 0) + 1,
        imapLastScanMs: result.ms ?? null,
      }));
}

/**
 * Should the sender skip this inbox right now? True while it is inside the
 * cooldown after SKIP_AFTER_FAILURES consecutive failures, or when it was
 * auto-disabled (bad credentials).
 */
export function shouldSkipInbox(health, now = Date.now()) {
  if (!health) return { skip: false };
  if (health.disabledReason) return { skip: true, reason: health.disabledReason };
  const failures = Number(health.consecutiveFailures) || 0;
  if (failures >= SKIP_AFTER_FAILURES && health.lastErrorAt) {
    const since = now - new Date(health.lastErrorAt).getTime();
    if (since < SKIP_COOLDOWN_MS) {
      return { skip: true, reason: `${failures} consecutive failures — retry in ${Math.ceil((SKIP_COOLDOWN_MS - since) / 60000)} min` };
    }
  }
  return { skip: false };
}

/** Human-readable status for the Inboxes API. */
export function describeHealth(health) {
  if (!health || !Object.keys(health).length) return { state: 'unknown', label: 'No sends yet' };
  if (health.disabledReason) return { state: 'disabled', label: health.disabledReason };
  const skip = shouldSkipInbox(health);
  if (skip.skip) return { state: 'failing', label: skip.reason };
  if (health.imapLastError && !health.imapLastOkAt) return { state: 'imap_error', label: `IMAP: ${health.imapLastError}` };
  if (health.imapLastError && health.imapLastErrorAt > (health.imapLastOkAt || '')) return { state: 'imap_error', label: `IMAP: ${health.imapLastError}` };
  if (health.lastError && health.lastErrorAt > (health.lastSuccessAt || '')) return { state: 'warning', label: `Last send failed: ${health.lastError}` };
  return { state: 'ok', label: 'Healthy' };
}
