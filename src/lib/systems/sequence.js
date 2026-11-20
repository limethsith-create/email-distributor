/**
 * Sequence rendering (SPEC §7.5 Copy Engine, the no-AI part). A sequence is
 * four touches — d0, d3, d7, d10 — the client's approved copy in
 * client:{id}:sequence (written by systems/copy.js). Every `{Slot}` must be
 * filled from the lead, the client profile or config; a missing value throws
 * TemplateError and the caller skips that touch — nothing is ever guessed.
 */

import { fill, TemplateError } from '@/lib/templates/render';

export { TemplateError };

export const TOUCH_DAYS = { d0: 0, d3: 3, d7: 7, d10: 10 };

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
