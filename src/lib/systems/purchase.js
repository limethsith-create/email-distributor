/**
 * Purchase page logic (SPEC §6.5) — the owner pastes what was bought.
 *
 * Input: the domain name (registrar login is never asked for), confirmation
 * that auto-renew is OFF (required to proceed), and per inbox: email, app
 * password, display name. Passwords are encrypted with ENC_KEY
 * (AES-256-GCM) by saveInbox and never logged or returned. Then:
 * client:{id}:domain is written, shopping.boughtAt set, state → setup_check,
 * and the Setup Checker runs immediately (the `setup-check` job continues
 * anything that does not fit in this request).
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getDomain, setState } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { saveInbox, getInboxRecords, removeInbox } from '@/lib/db/inboxes';
import { hasEncKey } from '@/lib/crypto';
import { io, truthy } from '@/lib/systems/intake-io';
import { startSetupCheck, runSetupCheck } from '@/lib/systems/setupcheck';
import { tldOf } from '@/lib/systems/pricescout';

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** Validate the paste. Returns { errors, domain, inboxes }. */
export async function validatePurchase(body, clientId) {
  const errors = {};
  const domain = String(body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(domain)) errors.domain = 'Enter the bare domain, e.g. acme-team.com';
  const banned = (await cfg(clientId, 'BANNED_TLDS')).map((t) => String(t).replace(/^\./, ''));
  if (!errors.domain && banned.includes(tldOf(domain))) errors.domain = `.${tldOf(domain)} is a banned TLD.`;
  if (!truthy(body.autoRenewOff)) errors.autoRenewOff = 'Auto-renew must be OFF before setup can continue. Turn it off at the registrar and tick the box.';
  const inboxes = (Array.isArray(body.inboxes) ? body.inboxes : []).map((i) => ({
    email: String(i?.email || '').trim().toLowerCase(),
    password: String(i?.password || i?.appPassword || '').replace(/\s+/g, ''),
    displayName: String(i?.displayName || '').trim().slice(0, 80),
  })).filter((i) => i.email || i.password);
  if (!inboxes.length) errors.inboxes = 'Add at least one inbox (two are expected).';
  inboxes.forEach((i, n) => {
    if (!EMAIL_RE.test(i.email)) errors[`inbox${n}`] = `Inbox ${n + 1}: enter the full email address.`;
    else if (!errors.domain && !i.email.endsWith(`@${domain}`)) errors[`inbox${n}`] = `Inbox ${n + 1}: ${i.email} is not on ${domain}.`;
    else if (!i.password) errors[`inbox${n}`] = `Inbox ${n + 1}: paste the app password.`;
    else if (!/^[a-z]{16}$/i.test(i.password)) errors[`inbox${n}`] = `Inbox ${n + 1}: a Google app password is 16 letters.`;
    if (!i.displayName) errors[`inbox${n}`] = errors[`inbox${n}`] || `Inbox ${n + 1}: add the display name.`;
  });
  if (new Set(inboxes.map((i) => i.email)).size !== inboxes.length) errors.inboxes = 'The same inbox is listed twice.';
  return { errors, domain, inboxes };
}

/**
 * Save the purchase and run the Setup Checker. Allowed from awaiting_purchase
 * and (to fix a wrong password or domain) from setup_check.
 */
export async function submitPurchase(clientId, body, { now = io.now(), deadline = Date.now() + 15000 } = {}) {
  const client = await getClient(clientId);
  if (!client) return { ok: false, status: 404, errors: { _form: 'Client not found.' } };
  if (!['awaiting_purchase', 'setup_check'].includes(client.state)) return { ok: false, status: 409, errors: { _form: `The client is in ${client.state}; the purchase page is only for awaiting_purchase / setup_check.` } };
  if (!hasEncKey()) return { ok: false, status: 503, errors: { _form: 'ENC_KEY is not set on the server, so passwords cannot be stored safely yet.' } };
  const { errors, domain, inboxes } = await validatePurchase(body, clientId);
  if (Object.keys(errors).length) return { ok: false, status: 400, errors };

  const existing = await getDomain(clientId);
  const price = Number(body.price);
  await kv.hset(K.domain(clientId), {
    name: domain,
    registrar: String(body.registrar || existing.registrar || '').slice(0, 40),
    purchasedAt: existing.name === domain && existing.purchasedAt ? existing.purchasedAt : now.toISOString(),
    ...(Number.isFinite(price) && price > 0 ? { price } : {}),
    autoRenew: 'false',
    autoRenewConfirmedAt: now.toISOString(),
    forwardsTo: client.mainDomain || '',
  });
  // Replace the inbox set with what was pasted (a re-paste fixes a typo).
  const keep = new Set(inboxes.map((i) => i.email));
  for (const r of await getInboxRecords(clientId)) if (!keep.has(r.email)) await removeInbox(clientId, r.email);
  for (const i of inboxes) await saveInbox(clientId, { email: i.email, password: i.password, displayName: i.displayName, provider: 'google', enabled: false });
  await kv.hset(K.shopping(clientId), { boughtAt: now.toISOString() });
  await logEvent(clientId, 'purchase', 'logins_pasted', { domain, inboxes: inboxes.map((i) => i.email) });

  if (client.state === 'awaiting_purchase') await setState(clientId, 'setup_check', 'owner pasted logins');
  await startSetupCheck(clientId, { all: true, now });
  const result = await runSetupCheck(clientId, { deadline, now });
  return { ok: true, setup: result };
}
