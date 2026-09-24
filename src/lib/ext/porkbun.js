/**
 * Porkbun API (SPEC §6.4, §13) and the RDAP availability fallback.
 *
 *  - getPricing(): public, unauthenticated TLD price list.
 *  - checkDomain(): availability + price; needs PORKBUN_API_KEY + PORKBUN_SECRET.
 *  - balance(), createDomain(), setAutoRenewOff(): Auto-Buyer only.
 *  - rdapAvailable(): https://rdap.org/domain/{name} — 404 means unregistered.
 *
 * Keys travel in the JSON body only and are never logged.
 */

import { fetchJson } from '@/lib/ext/http';

const BASE = 'https://api.porkbun.com/api/json/v3';

export function porkbunKeys() {
  const apikey = process.env.PORKBUN_API_KEY;
  const secretapikey = process.env.PORKBUN_SECRET || process.env.PORKBUN_SECRET_API_KEY;
  return apikey && secretapikey ? { apikey, secretapikey } : null;
}

async function call(path, body = {}, { auth = true, timeoutMs = 10000 } = {}) {
  const keys = auth ? porkbunKeys() : null;
  if (auth && !keys) throw new Error('porkbun keys not set');
  const res = await fetchJson(`${BASE}${path}`, {
    service: 'porkbun',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(keys || {}), ...body }),
    timeoutMs,
  });
  if (!res.ok || !res.json || String(res.json.status).toUpperCase() !== 'SUCCESS') {
    throw new Error(`porkbun ${path.split('/').slice(0, 3).join('/')} ${res.status}: ${String(res.json?.message || '').slice(0, 160)}`);
  }
  return res.json;
}

/** { com: { registration: 10.37, renewal: 10.37 }, ... } as numbers. */
export async function getPricing() {
  const j = await call('/pricing/get', {}, { auth: false });
  const out = {};
  for (const [tld, p] of Object.entries(j.pricing || {})) {
    const reg = Number(p?.registration);
    if (Number.isFinite(reg)) out[tld] = { registration: reg, renewal: Number(p?.renewal) || null };
  }
  return out;
}

/** { available, price, regularPrice } for one name. */
export async function checkDomain(name) {
  const j = await call(`/domain/checkDomain/${encodeURIComponent(name)}`);
  const r = j.response || {};
  return {
    available: String(r.avail).toLowerCase() === 'yes',
    price: Number(r.price) || null,
    regularPrice: Number(r.regularPrice) || null,
    premium: String(r.premium || '').toLowerCase() === 'yes',
    renewal: Number(r.additional?.renewal?.price) || null,
  };
}

/** Account credit in USD. Throws when the response carries no number. */
export async function balance() {
  const j = await call('/user/balance');
  const n = Number(j.balance ?? j.response?.balance ?? j.credit);
  if (!Number.isFinite(n)) throw new Error('porkbun balance: no number in response');
  return n;
}

/** Register a domain. `cost` in USD (sent in pennies, as the API expects). */
export async function createDomain(name, { cost, dryRun = false } = {}) {
  return call(`/domain/create/${encodeURIComponent(name)}`, { cost: Math.round(Number(cost) * 100), agreeToTerms: 'yes', ...(dryRun ? { dryRun: true } : {}) }, { timeoutMs: 20000 });
}

export async function setAutoRenewOff(name) {
  return call(`/domain/updateAutoRenew/${encodeURIComponent(name)}`, { status: 'off' });
}

/** true = unregistered (RDAP 404), false = registered (200), null = unknown. */
export async function rdapAvailable(name) {
  try {
    const res = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(name)}`, { service: 'rdap', timeoutMs: 6000, retry: false, headers: { accept: 'application/rdap+json' } });
    if (res.status === 404) return true;
    if (res.status === 200) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * One RDAP lookup with the detail the domain tools need:
 * { status: 'free' | 'taken' | 'limited' | 'unknown', registeredAt: ISO|null }.
 * 404 = free, 200 = taken (registeredAt from the `registration` event),
 * 429 = rate-limited (the caller backs off; nothing is retried here).
 */
export async function rdapLookup(name, { base = 'https://rdap.org/domain/', timeoutMs = 6000 } = {}) {
  try {
    const res = await fetchJson(`${base}${encodeURIComponent(name)}`, { service: 'rdap', timeoutMs, retry: false, headers: { accept: 'application/rdap+json' } });
    if (res.status === 404) return { status: 'free', registeredAt: null };
    if (res.status === 429) return { status: 'limited', registeredAt: null };
    if (res.status === 200) {
      const ev = (res.json?.events || []).find((e) => String(e?.eventAction || '').toLowerCase() === 'registration');
      const at = ev && Number.isFinite(Date.parse(ev.eventDate)) ? new Date(ev.eventDate).toISOString() : null;
      return { status: 'taken', registeredAt: at };
    }
    return { status: 'unknown', registeredAt: null };
  } catch {
    return { status: 'unknown', registeredAt: null };
  }
}
