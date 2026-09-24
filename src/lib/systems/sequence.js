/**
 * Sequence rendering (SPEC §7.5 Copy Engine, the no-AI part). A sequence is
 * four touches — d0, d3, d7, d10 — from templates/sequence/*.json or the
 * client's approved copy in client:{id}:sequence. Every `{Slot}` must be
 * filled from the lead, the client profile or config; a missing value throws
 * TemplateError and the caller skips that touch — nothing is ever guessed.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { fill, TemplateError } from '@/lib/templates/render';
import defaultSequence from '@/lib/templates/sequence/default.json';

export { TemplateError };

export const TOUCH_DAYS = { d0: 0, d3: 3, d7: 7, d10: 10 };

/** The sequence a client sends (approved variant A if stored, else default). */
export async function getSequence(clientId) {
  try {
    const raw = await kv.hget(K.sequence(clientId), 'variantA');
    const seq = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (seq && Array.isArray(seq.touches) && seq.touches.length) return seq;
  } catch {}
  return defaultSequence;
}

export function touchOf(seq, touch) {
  return (seq.touches || []).find((t) => t.touch === touch) || null;
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');

/**
 * Slot values for one lead. Lead fields win over client-level defaults set
 * in Mission Control (profile.defaultNiche / defaultIcp).
 */
export function varsFor(lead, { profile = {}, account = null, ownerAddress = null } = {}) {
  const firstName = first(lead.first_name, String(lead.name || '').trim().split(/[\s,]+/)[0]);
  return {
    FirstName: firstName,
    Company: first(lead.company, lead.company_name),
    niche: first(lead.niche, profile.defaultNiche),
    ICP: first(lead.icp, profile.defaultIcp),
    Count: first(lead.marketCount, lead.count),
    City: first(lead.city),
    size: first(lead.sizeBand, lead.size),
    dealValue: first(lead.dealValue),
    SenderName: first(profile.senderName, account && account.displayName),
    postalAddress: first(profile.postalAddress, ownerAddress),
  };
}

/** Render one touch → { subject|null, body, text, thread }. Throws TemplateError. */
export function renderTouch(seq, touch, vars) {
  const t = touchOf(seq, touch);
  if (!t) throw new TemplateError(`sequence:${touch}`, ['touch not in sequence']);
  const name = `sequence:${touch}`;
  const subject = t.subject ? fill(name, t.subject, vars) : null;
  const body = fill(name, t.body, vars);
  const footer = seq.footer ? fill(`${name}:footer`, seq.footer, vars) : '';
  return { subject, body, footer, text: footer ? `${body}\n\n${footer}` : body, thread: t.thread || 'new' };
}

/**
 * Client-level readiness: can the footer render at all? (Sender name and
 * postal address are legally required on every cold email.)
 */
export async function sequenceReady(clientId, { profile = {}, account = null } = {}) {
  const seq = await getSequence(clientId);
  const ownerAddress = await cfg(clientId, 'OWNER.address');
  const vars = varsFor({}, { profile, account, ownerAddress });
  try {
    if (seq.footer) fill('sequence:footer', seq.footer, vars);
    return { ok: true, seq, ownerAddress };
  } catch (err) {
    return { ok: false, missing: err.missing || [err.message], seq, ownerAddress };
  }
}
