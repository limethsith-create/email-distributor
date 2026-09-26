/**
 * CheapInboxes (docs/AUTO-BUY.md, the owner's steps in docs/CHEAPINBOXES-SETUP.md)
 * — the owner's account, read by the machine so that buying a domain and two
 * inboxes there is all he does; systems/autobuy.js does everything after.
 *
 *  - THE MACHINE NEVER PLACES AN ORDER AND NEVER SPENDS MONEY. Every call goes
 *    through `ciCall`, which refuses anything outside ALLOWED (read the org,
 *    the payment methods and what the account owns; search availability;
 *    our own webhook; a domain's forwarding) before a byte leaves — orders,
 *    quotes, checkout, billing actions and cancellations cannot be reached
 *    from any code path. tests/autobuy.test.mjs fails if one ever is.
 *  - Plain fetch through io.fetchJson (stubbed in tests), bearer key, a
 *    timeout per call and one time budget per button press. GETs retry once
 *    (fetchExt); a POST never does, so a webhook is never made twice.
 *  - The key: env CHEAPINBOXES_API_KEY wins, else the owner's pasted key,
 *    encrypted in KV with ENC_KEY (lib/crypto.js). The key and the webhook's
 *    secret are never in any answer and never in a backup.
 *  - Saving the key checks it (GET /org), reads whether a card is on file
 *    (GET /billing/payment-methods — read only) and registers ONE webhook
 *    (a re-save replaces it). A key CheapInboxes refuses later → status
 *    `broken` and ONE owner alert.
 *  - Webhooks: HMAC-SHA256 over the raw body with the stored secret, in the
 *    common header forms (their docs do not name the header). A delivery is
 *    only ever a wake-up for a re-sync; its body is never read.
 *  - The domain index (cheapinboxes:domains): what the account owns and which
 *    trial each domain belongs to — written by the sync, listed as
 *    `unmatched` for the owner.
 *
 * No AI anywhere.
 */

import crypto from 'node:crypto';
import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { encrypt, decrypt, hasEncKey } from '@/lib/crypto';
import { logEvent } from '@/lib/db/events';
import { baseUrl } from '@/lib/notify';
import { io, asObject } from '@/lib/systems/intake-io';

const SYSTEM = 'cheapinboxes';
export const API_ORIGIN = 'https://api.cheapinboxes.com';
export const API_BASE = `${API_ORIGIN}/v1`;
/** The events the machine listens for (docs/AUTO-BUY.md §1). Each is only a wake-up. */
export const WEBHOOK_EVENTS = ['domain.provisioned', 'domain.dns_configured', 'mailbox.active', 'mailbox.credentials_ready', 'order.completed', 'order.failed', 'billing.invoice_failed'];
/** Per call and for one whole button press (tests shorten them). */
export const CI_TIMING = { callMs: 8000, budgetMs: 15000 };
/** Pages of 100 read at most per listing (1 000 domains or mailboxes). */
const MAX_PAGES = 10;
const PAGE = 100;

/** Where CheapInboxes sends its events (public route, middleware lets /api/webhooks/* through). */
export const webhookUrl = () => `${baseUrl()}/api/webhooks/cheapinboxes`;

// ─── the only calls the machine may make ─────────────────────────────────────

const ID = '[A-Za-z0-9_-]{1,100}';
/**
 * [method, path under /v1]. Everything else — /orders (quote, checkout),
 * /billing actions (pay-now, cancel, payment-method changes), mailbox or
 * domain cancellation, creating mailboxes — is refused before any request.
 */
export const ALLOWED = [
  ['GET', new RegExp('^/org$')],
  ['GET', new RegExp('^/billing/payment-methods$')],
  ['POST', new RegExp('^/webhooks$')],
  ['GET', new RegExp('^/webhooks$')],
  ['DELETE', new RegExp(`^/webhooks/${ID}$`)],
  ['POST', new RegExp('^/discovery/domains/search$')],
  ['GET', new RegExp('^/domains$')],
  ['GET', new RegExp(`^/domains/${ID}$`)],
  ['PATCH', new RegExp(`^/domains/${ID}/forwarding$`)],
  ['GET', new RegExp('^/mailboxes$')],
  ['GET', new RegExp(`^/mailboxes/${ID}$`)],
  ['GET', new RegExp(`^/mailboxes/${ID}/credentials$`)],
];

/** True only for a call in ALLOWED (`path` is under /v1, a query string is ignored). */
export function isAllowedCall(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0];
  return ALLOWED.some(([am, re]) => am === m && re.test(p));
}

// ─── errors in plain words ───────────────────────────────────────────────────

const WORDS = {
  not_set_up: "CheapInboxes isn't connected — paste your API key in Settings › Inboxes & domains.",
  no_enc_key: 'ENC_KEY is not set on the server, so the key cannot be stored safely yet.',
  env_key: 'The API key is set on the server (CHEAPINBOXES_API_KEY) — change it there.',
  bad_key: "That doesn't look like a CheapInboxes API key — it starts with ci_live_.",
  refused: 'CheapInboxes refused the API key — create a new one (Integrations → API) and paste it again.',
  rate_limited: 'CheapInboxes asked us to slow down — try again in a minute.',
  timeout: "CheapInboxes didn't answer in time.",
  network: "CheapInboxes couldn't be reached.",
  forbidden: 'The machine never places orders or spends money — that CheapInboxes call is not allowed.',
};
const HTTP = { not_set_up: 409, no_enc_key: 503, env_key: 409, bad_key: 400, refused: 400, forbidden: 500 };

/** A CheapInboxes problem: `code` for the machine, the message for the owner. */
export class CheapInboxesError extends Error {
  constructor(code, message = null) { super(message || WORDS[code] || code); this.code = code; this.status = HTTP[code] || 502; }
}

/** Their error envelope `{ error: { code, message } }` → plain words. */
export function apiProblem(r) {
  const e = asObject(r?.json?.error) || {};
  const msg = String(e.message || (typeof r?.json?.error === 'string' ? r.json.error : '') || r?.json?.message || '');
  return `CheapInboxes said ${r?.status || 'nothing'}${msg ? `: ${msg.slice(0, 160)}` : ''}`;
}

// ─── the stored connection ───────────────────────────────────────────────────

const open = (v) => { try { return v ? decrypt(v) : null; } catch { return null; } };
const envKey = () => String(process.env.CHEAPINBOXES_API_KEY || '').trim() || null;

/** The account hash (never returned as such: it holds the encrypted key). */
export async function readAccount() {
  try { return (await kv.hgetall(K.cheapinboxes())) || {}; } catch { return {}; }
}

/** The key to use: env wins, else the saved one. Null when neither. */
export async function apiKey(acct = null) {
  const env = envKey();
  if (env) return { key: env, from: 'env' };
  const a = acct || await readAccount();
  const k = open(a.apiKeyEnc);
  return k ? { key: k, from: 'saved' } : null;
}

/** Is a key there at all (one Redis read at most; the board asks once per load)? */
export async function isConnected() {
  if (envKey()) return true;
  try { return Boolean(await kv.hget(K.cheapinboxes(), 'apiKeyEnc')); } catch { return false; }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/**
 * One call. Refused before any request unless ALLOWED — checked on the path
 * given and again on the URL actually built (so `..` can never walk out).
 * → { status, ok, json }. Throws CheapInboxesError for a refused key (401),
 * a rate limit (429), a timeout or the network; other answers go back to the
 * caller (404 means "not there (yet)" to most of them).
 */
export async function ciCall(method, path, { key, body = undefined, query = null, deadline = null, retry = null } = {}) {
  const m = String(method || '').toUpperCase();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const built = url.pathname.startsWith('/v1/') ? url.pathname.slice(3) : null;
  if (!isAllowedCall(m, path) || url.origin !== API_ORIGIN || !built || !isAllowedCall(m, built)) {
    await logEvent(null, SYSTEM, 'call_refused', { method: m, path: String(path).slice(0, 120) }).catch(() => {});
    throw new CheapInboxesError('forbidden');
  }
  if (!key) throw new CheapInboxesError('not_set_up');
  const left = (deadline ?? Date.now() + CI_TIMING.callMs) - Date.now();
  if (left < 300) throw new CheapInboxesError('timeout');
  let r;
  try {
    r = await io.fetchJson(url.toString(), {
      method: m,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: Math.min(CI_TIMING.callMs, left),
      retry: retry ?? m === 'GET',
      service: 'cheapinboxes',
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(String(err?.message || ''));
    throw new CheapInboxesError(timedOut ? 'timeout' : 'network');
  }
  if (r.status === 401) throw new CheapInboxesError('refused');
  if (r.status === 429) throw new CheapInboxesError('rate_limited');
  return r;
}

/** A GET that must succeed → its JSON (else CheapInboxesError('api') in plain words). */
async function getOk(path, opts) {
  const r = await ciCall('GET', path, opts);
  if (!r.ok) throw Object.assign(new CheapInboxesError('api', apiProblem(r)), { httpStatus: r.status });
  return r.json || {};
}

/** A list answer in any of the shapes their docs show: an array, or `{ [name]: [...] }`. */
const listOf = (json, name) => (Array.isArray(json) ? json : Array.isArray(json?.[name]) ? json[name] : Array.isArray(json?.data) ? json.data : []);

/**
 * Every page of a listing (limit/offset, their `pagination.total`). Their docs
 * do not name the query parameters: if the first page is refused as a bad
 * request, the plain listing (no parameters) is read instead — callers filter
 * what they need themselves.
 */
async function listAll(path, name, { key, deadline, query = {} }) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let json;
    try {
      json = await getOk(path, { key, deadline, query: { ...query, limit: PAGE, offset: page * PAGE } });
    } catch (err) {
      if (page === 0 && err.httpStatus === 400) return listOf(await getOk(path, { key, deadline }), name);
      throw err;
    }
    const rows = listOf(json, name);
    out.push(...rows);
    const total = Number(json?.pagination?.total);
    if (!rows.length || rows.length < PAGE || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

// ─── the reads and the few writes the machine makes ─────────────────────────

/** GET /org → { id, name }. */
export async function readOrg(key, { deadline } = {}) {
  const json = await getOk('/org', { key, deadline });
  const org = asObject(json.organization) || json;
  return { id: org.id ? String(org.id) : null, name: String(org.name || org.billing_name || org.billing_company || 'CheapInboxes account').slice(0, 120) };
}

/** GET /billing/payment-methods (read only) → true when a default card is on file, false when none, null when unknown. */
export async function readHasPaymentMethod(key, { deadline } = {}) {
  const r = await ciCall('GET', '/billing/payment-methods', { key, deadline });
  if (!r.ok) return null;
  const list = listOf(r.json, 'payment_methods');
  if (!list.length) return false;
  const flagged = list.some((p) => p && Object.prototype.hasOwnProperty.call(p, 'is_default'));
  return flagged ? list.some((p) => p?.is_default === true) : true;
}

/** POST /discovery/domains/search (read only) → [{ domain, available, price, currency }], exact matches first. */
export async function searchDomains(key, keyword, tlds, { deadline } = {}) {
  const r = await ciCall('POST', '/discovery/domains/search', { key, deadline, body: { keyword: String(keyword), ...(tlds?.length ? { tlds } : {}) }, retry: true });
  if (!r.ok) throw new CheapInboxesError('api', apiProblem(r));
  const rows = [...listOf(r.json, 'exact'), ...listOf(r.json, 'suggestions')];
  return rows.filter((x) => x && x.domain).map((x) => ({
    domain: String(x.domain).toLowerCase(),
    available: x.available === true || String(x.status || '').toLowerCase() === 'available',
    price: Number.isFinite(Number(x.price)) ? Number(x.price) : null,
    currency: x.currency ? String(x.currency).toUpperCase() : 'USD',
  }));
}

/** GET /domains, every page. */
export const listDomains = (key, { deadline } = {}) => listAll('/domains', 'domains', { key, deadline });

/** GET /domains/{id} → the domain, or null when it is not in the account (404). */
export async function getDomain(key, id, { deadline } = {}) {
  const r = await ciCall('GET', `/domains/${encodeURIComponent(id)}`, { key, deadline });
  if (r.status === 404) return null;
  if (!r.ok) throw new CheapInboxesError('api', apiProblem(r));
  return asObject(r.json?.domain) || r.json || null;
}

/**
 * GET /mailboxes filtered by domain — the filter is asked for AND applied
 * here (by domain id or the address), so it holds whatever the API does with
 * the query.
 */
export async function listMailboxes(key, { domainId, domain, deadline } = {}) {
  const rows = await listAll('/mailboxes', 'mailboxes', { key, deadline, query: { domain_id: domainId } });
  const at = `@${String(domain || '').toLowerCase()}`;
  return rows.filter((m) => m && ((domainId && String(m.domain_id) === String(domainId)) || (domain && String(m.full_email || m.email || '').toLowerCase().endsWith(at))));
}

/** GET /mailboxes/{id}/credentials → { email, password, app_password, imap_host, imap_port, smtp_host, smtp_port } or null (not ready yet). */
export async function getCredentials(key, id, { deadline } = {}) {
  const r = await ciCall('GET', `/mailboxes/${encodeURIComponent(id)}/credentials`, { key, deadline });
  if (!r.ok) return null;
  return asObject(r.json?.credentials) || asObject(r.json) || null;
}

/** PATCH /domains/{id}/forwarding (permanent 301) → { ok, error? }. */
export async function setForwarding(key, id, url, { deadline } = {}) {
  const r = await ciCall('PATCH', `/domains/${encodeURIComponent(id)}/forwarding`, { key, deadline, body: { forwarding_url: url, permanent: true } });
  return r.ok ? { ok: true } : { ok: false, error: apiProblem(r) };
}

// ─── our webhook ─────────────────────────────────────────────────────────────

/**
 * ONE webhook for this machine: the old one (by id, with the key that made it)
 * and any other pointing at our address go first, then a new one is made.
 * → { id, secret }.
 */
async function registerWebhook(key, { oldId = null, oldKey = null, deadline } = {}) {
  if (oldId) {
    for (const k of [...new Set([oldKey, key].filter(Boolean))]) {
      try { const r = await ciCall('DELETE', `/webhooks/${encodeURIComponent(oldId)}`, { key: k, deadline }); if (r.ok) break; } catch (err) { if (err.code === 'forbidden') throw err; }
    }
  }
  const url = webhookUrl();
  try {
    const list = listOf((await ciCall('GET', '/webhooks', { key, deadline })).json, 'webhooks');
    for (const h of list) {
      if (h?.id && String(h.url || '') === url && String(h.id) !== String(oldId)) await ciCall('DELETE', `/webhooks/${encodeURIComponent(h.id)}`, { key, deadline }).catch(() => null);
    }
  } catch (err) { if (err.code === 'refused' || err.code === 'forbidden') throw err; }
  const r = await ciCall('POST', '/webhooks', { key, deadline, body: { url, events: WEBHOOK_EVENTS } });
  const hook = asObject(r.json?.webhook) || r.json || {};
  if (!r.ok || !hook.id) throw new CheapInboxesError('api', `The webhook could not be registered (${apiProblem(r)}).`);
  return { id: String(hook.id), secret: hook.secret ? String(hook.secret) : null };
}

/** Is our webhook still listed in the account? (null = could not tell) */
async function webhookListed(key, id, { deadline } = {}) {
  if (!id) return false;
  try {
    const r = await ciCall('GET', '/webhooks', { key, deadline });
    if (!r.ok) return null;
    return listOf(r.json, 'webhooks').some((h) => String(h?.id) === String(id));
  } catch (err) {
    if (err.code === 'refused') throw err;
    return null;
  }
}

const hookFields = (hook, now) => (hook?.id
  ? { webhookId: hook.id, webhookUrl: webhookUrl(), webhookAt: now.toISOString(), webhookError: '', ...(hook.secret ? { webhookSecretEnc: encrypt(hook.secret) } : {}) }
  : {});

// ─── the owner's buttons (Settings › Inboxes & domains) ─────────────────────

/**
 * GET /api/mc/cheapinboxes → { status: not_set_up|connected|broken, account,
 * hasPaymentMethod, webhook: registered|missing, unmatched, keyFrom,
 * checkedAt, lastSyncAt, problem, encKey }. Never the key or the secret.
 */
export async function cheapInboxesStatus() {
  const a = await readAccount();
  const k = await apiKey(a);
  const status = !k ? 'not_set_up' : a.brokenAt ? 'broken' : 'connected';
  // Upstash hands '1' / '0' back as numbers: compare as text.
  const hp = String(a.hasPaymentMethod ?? '');
  const hasPaymentMethod = !k ? null : hp === '1' ? true : hp === '0' ? false : null;
  const webhook = k && a.webhookId ? 'registered' : 'missing';
  return {
    status,
    account: k && a.account ? String(a.account) : null,
    hasPaymentMethod,
    webhook,
    unmatched: k ? unmatchedOf(await readDomainIndex()) : [],
    keyFrom: k?.from || null,
    checkedAt: k ? a.checkedAt || null : null,
    lastSyncAt: k ? a.lastSyncAt || null : null,
    problem: statusProblem({ status, hasPaymentMethod, webhook, brokenReason: a.brokenReason }),
    encKey: hasEncKey(),
  };
}

/** The one thing to fix on the Settings card, in plain words — null when all is well (or nothing is set up yet). Pure. */
export function statusProblem({ status, hasPaymentMethod, webhook, brokenReason = null }) {
  if (status === 'not_set_up') return null;
  if (status === 'broken') return `The key was refused by CheapInboxes${brokenReason && brokenReason !== WORDS.refused ? ` (${brokenReason})` : ''} — create a new one (Integrations → API), paste it here and press Test.`;
  if (hasPaymentMethod === false) return 'No card on your CheapInboxes account — add one under Billing before you buy.';
  if (webhook !== 'registered') return 'The webhook is not registered, so purchases are found a little later — press Test to register it again.';
  return null;
}

/**
 * POST { action: 'saveKey', apiKey }: check the key (GET /org), read whether a
 * card is on file, register the webhook (replacing ours), store it encrypted.
 * A key CheapInboxes refuses is not saved. A webhook that could not be made
 * does not stop the save (status shows `webhook: 'missing'`; Test retries it).
 */
export async function saveKey({ apiKey: raw } = {}, { now = io.now() } = {}) {
  if (envKey()) throw new CheapInboxesError('env_key');
  const key = String(raw || '').trim();
  if (!/^ci_[A-Za-z0-9_-]{8,200}$/.test(key)) throw new CheapInboxesError('bad_key');
  if (!hasEncKey()) throw new CheapInboxesError('no_enc_key');
  const deadline = Date.now() + CI_TIMING.budgetMs;
  const org = await readOrg(key, { deadline });
  const acct = await readAccount();
  const pay = await readHasPaymentMethod(key, { deadline }).catch((err) => { if (err.code === 'forbidden') throw err; return null; });
  let hook = null;
  let hookError = null;
  try { hook = await registerWebhook(key, { oldId: acct.webhookId || null, oldKey: open(acct.apiKeyEnc), deadline }); } catch (err) { if (err.code === 'forbidden') throw err; hookError = err.message; }
  const orgChanged = Boolean(acct.orgId && org.id && acct.orgId !== org.id);
  const drop = ['brokenAt', 'brokenReason', ...(hook ? [] : ['webhookId', 'webhookUrl', 'webhookAt']), ...(hook?.secret ? [] : ['webhookSecretEnc']), ...(orgChanged ? ['baselineAt'] : [])];
  await kv.hdel(K.cheapinboxes(), ...drop);
  await kv.hset(K.cheapinboxes(), {
    apiKeyEnc: encrypt(key),
    account: org.name,
    orgId: org.id || '',
    hasPaymentMethod: pay === true ? '1' : pay === false ? '0' : '',
    savedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    ...hookFields(hook, now),
    ...(hookError ? { webhookError: String(hookError).slice(0, 200) } : {}),
  });
  if (orgChanged) await forgetUnlinked();
  await logEvent(null, SYSTEM, 'key_saved', { account: org.name, webhook: Boolean(hook), hasPaymentMethod: pay });
  return { ...(await cheapInboxesStatus()), ...(hookError ? { webhookError: hookError } : {}) };
}

/**
 * POST { action: 'test' }: the key still works (GET /org), the card, and our
 * webhook still listed — a missing one is registered again.
 */
export async function testKey({ now = io.now() } = {}) {
  const acct = await readAccount();
  const k = await apiKey(acct);
  if (!k) throw new CheapInboxesError('not_set_up');
  const deadline = Date.now() + CI_TIMING.budgetMs;
  let org;
  try { org = await readOrg(k.key, { deadline }); } catch (err) {
    if (err.code === 'refused') await markBroken(WORDS.refused, { now });
    throw err;
  }
  const pay = await readHasPaymentMethod(k.key, { deadline }).catch(() => null);
  let renewed = false;
  let hookError = null;
  const listed = await webhookListed(k.key, acct.webhookId, { deadline });
  let hook = null;
  if (listed === false || !acct.webhookSecretEnc) {
    try { hook = await registerWebhook(k.key, { oldId: acct.webhookId || null, deadline }); renewed = true; } catch (err) { if (err.code === 'forbidden') throw err; hookError = err.message; }
  }
  await kv.hdel(K.cheapinboxes(), 'brokenAt', 'brokenReason', ...(hook && !hook.secret ? ['webhookSecretEnc'] : []));
  await kv.hset(K.cheapinboxes(), {
    account: org.name,
    orgId: org.id || '',
    hasPaymentMethod: pay === true ? '1' : pay === false ? '0' : '',
    checkedAt: now.toISOString(),
    ...hookFields(hook, now),
  });
  await logEvent(null, SYSTEM, 'tested', { renewed, webhook: listed });
  return { ok: true, ...(await cheapInboxesStatus()), webhookRenewed: renewed, ...(hookError ? { webhookError: hookError } : {}) };
}

/** POST { action: 'forget' }: our webhook goes (best effort) and the saved key with it. Trials already linked keep their domains. */
export async function forgetKey() {
  if (envKey()) throw new CheapInboxesError('env_key');
  const acct = await readAccount();
  const key = open(acct.apiKeyEnc);
  let removed = false;
  if (key && acct.webhookId) {
    try { removed = (await ciCall('DELETE', `/webhooks/${encodeURIComponent(acct.webhookId)}`, { key })).ok; } catch {}
  }
  await kv.del(K.cheapinboxes());
  await forgetUnlinked();
  await logEvent(null, SYSTEM, 'key_forgotten', { webhookRemoved: removed });
  return { ...(await cheapInboxesStatus()), webhookRemoved: removed };
}

/** CheapInboxes refused the key: status `broken`, and the owner is told once. */
export async function markBroken(reason, { now = io.now() } = {}) {
  const first = await kv.hsetnx(K.cheapinboxes(), 'brokenAt', now.toISOString());
  await kv.hset(K.cheapinboxes(), { brokenReason: String(reason).slice(0, 200) });
  if (!(first === 1 || first === true)) return;
  await logEvent(null, SYSTEM, 'broken', { reason });
  try {
    await io.alertOwner('autobuy_problem', {
      scope: `cheapinboxes:key:${now.toISOString().slice(0, 10)}`,
      vars: { what: 'CheapInboxes refused the API key' },
      body: `CheapInboxes stopped accepting the machine's API key (${reason}). New purchases are not found and set up until it works again.\n\nWhat to do: in CheapInboxes create a new API key (Integrations → API), paste it in the hub under Settings › Inboxes & domains and press Test.`,
      did: 'Nothing was bought or changed. Trials already set up keep running.',
      url: '/#settings/inboxes',
    });
  } catch (err) { console.error('[cheapinboxes] alert failed', err?.message); }
}

// ─── the domain index ────────────────────────────────────────────────────────

/** domain → entry (see K.cheapinboxesDomains). */
export async function readDomainIndex() {
  let raw = {};
  try { raw = (await kv.hgetall(K.cheapinboxesDomains())) || {}; } catch {}
  const out = {};
  for (const [k, v] of Object.entries(raw)) { const o = asObject(v); if (o) out[k] = o; }
  return out;
}

/** Write the entries that changed (`before` = the index as read). */
export async function writeDomainIndex(index, before = {}) {
  const changed = {};
  for (const [k, v] of Object.entries(index)) {
    const s = JSON.stringify(v);
    if (JSON.stringify(before[k] ?? null) !== s) changed[k] = s;
  }
  if (Object.keys(changed).length) await kv.hset(K.cheapinboxesDomains(), changed);
  return Object.keys(changed).length;
}

/** Domains nobody has claimed and the owner has not seen before the key was saved: [{ domain, mailboxes, boughtAt }], newest first. */
export function unmatchedOf(index) {
  return Object.entries(index || {})
    .filter(([, e]) => e && !e.clientId && !e.preexisting && !e.gone)
    .map(([domain, e]) => ({ domain, mailboxes: Number.isFinite(Number(e.mailboxes)) ? Number(e.mailboxes) : null, boughtAt: e.boughtAt || e.firstSeenAt || null }))
    .sort((a, b) => String(b.boughtAt || '').localeCompare(String(a.boughtAt || '')));
}

/** Drop entries that belong to no trial (another account's domains, or none at all). Linked ones stay. */
async function forgetUnlinked() {
  const index = await readDomainIndex();
  const drop = Object.entries(index).filter(([, e]) => !e.clientId).map(([k]) => k);
  if (drop.length) await kv.hdel(K.cheapinboxesDomains(), ...drop);
}

// ─── webhook signatures ──────────────────────────────────────────────────────

/** Header names a signature may come in (their docs say "HMAC-SHA256" but not where). */
export const SIGNATURE_HEADERS = ['x-cheapinboxes-signature', 'cheapinboxes-signature', 'x-webhook-signature', 'webhook-signature', 'x-signature', 'x-signature-256', 'x-hub-signature-256'];
const TIMESTAMP_HEADERS = ['x-cheapinboxes-timestamp', 'x-webhook-timestamp', 'webhook-timestamp', 'x-timestamp'];

const headerOf = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return hit ? headers[hit] : null;
};

/** '…' → the 32 bytes it names (hex or base64/base64url), else null. */
function sigBytes(s) {
  const v = String(s || '').trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

/**
 * Every (signature, signed text) pair a delivery could carry: a bare hex or
 * base64 digest, `sha256=…`, `t=…,v1=…` (signed `t.body`), `v1,…` pairs
 * (signed `id.t.body`), or a separate timestamp header (signed `t.body`).
 */
export function signatureCandidates(raw, headers) {
  const body = String(raw ?? '');
  const out = [];
  const idHeader = headerOf(headers, 'webhook-id');
  const tsHeader = TIMESTAMP_HEADERS.map((h) => headerOf(headers, h)).find(Boolean) || null;
  for (const name of SIGNATURE_HEADERS) {
    const value = headerOf(headers, name);
    if (!value) continue;
    const sigs = [];
    let t = null;
    if (/(^|\s)v1,/.test(value)) {
      for (const part of value.trim().split(/\s+/)) { const [ver, s] = part.split(','); if (ver === 'v1' && s) sigs.push(s); }
    } else {
      for (const part of value.split(/[,;\s]+/).filter(Boolean)) {
        const eq = part.indexOf('=');
        const k = eq > 0 ? part.slice(0, eq).toLowerCase() : null;
        const v = eq > 0 ? part.slice(eq + 1) : part;
        if (k === 't' || k === 'ts' || k === 'timestamp') t = v;
        else if (!k || ['v1', 'v0', 's', 'sig', 'signature', 'sha256'].includes(k)) sigs.push(v);
        else if (sigBytes(part)) sigs.push(part); // base64 ending in '='
      }
    }
    for (const s of sigs) {
      const bytes = sigBytes(s);
      if (!bytes) continue;
      const texts = [body];
      if (t) texts.push(`${t}.${body}`);
      if (tsHeader) texts.push(`${tsHeader}.${body}`);
      if (idHeader && tsHeader) texts.push(`${idHeader}.${tsHeader}.${body}`);
      for (const text of texts) out.push({ bytes, text });
    }
  }
  return out;
}

/** HMAC-SHA256 check with `secret` (as given, and — for a `whsec_` secret — its base64 body too). Pure. */
export function verifySignature(raw, headers, secret) {
  if (!secret) return false;
  const keys = [Buffer.from(String(secret), 'utf8')];
  const m = String(secret).match(/^whsec_([A-Za-z0-9+/=_-]+)$/);
  if (m) { try { const b = Buffer.from(m[1], 'base64'); if (b.length >= 16) keys.push(b); } catch {} }
  for (const { bytes, text } of signatureCandidates(raw, headers)) {
    for (const k of keys) {
      const mac = crypto.createHmac('sha256', k).update(text, 'utf8').digest();
      if (mac.length === bytes.length && crypto.timingSafeEqual(mac, bytes)) return true;
    }
  }
  return false;
}

/** A delivery signed with our stored secret? Never throws. */
export async function verifyWebhook(raw, headers) {
  try {
    const secret = open(await kv.hget(K.cheapinboxes(), 'webhookSecretEnc'));
    return verifySignature(raw, headers, secret);
  } catch { return false; }
}
