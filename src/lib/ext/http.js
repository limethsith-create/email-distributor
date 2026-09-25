/**
 * Every external call goes through here (SPEC §13): timeout, one retry after
 * 2 s on network errors / 5xx / 429, and a Usage Meter counter.
 */

import { countUsage } from '@/lib/systems/usage';
import { safeFetch } from '@/lib/safefetch';

/**
 * `publicOnly: true` for any address that came from outside (an applicant's
 * website, a client's calendar link): goes through lib/safefetch.js, which
 * refuses private / internal addresses on every hop (SSRF).
 */
export async function fetchExt(url, { service = null, usageField = 'calls', timeoutMs = 10_000, retry = true, publicOnly = false, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = publicOnly
        ? await safeFetch(url, { method: init.method, headers: init.headers, body: init.body, redirect: init.redirect === 'manual' ? 'manual' : 'follow', timeoutMs })
        : await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (service) await countUsage(service, usageField, 1);
      if ((res.status >= 500 || res.status === 429) && attempt === 0 && retry) { lastErr = new Error(`${service || url} ${res.status}`); continue; }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchExt(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}
