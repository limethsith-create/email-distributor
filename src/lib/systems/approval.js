/**
 * Approval page logic (SPEC §7.6). The page replaces the live Build Session:
 * the client sees the profile summary, marketEstimate, the 20 sanity rows and
 * both variants of the four emails rendered for a sample lead with the Copy
 * Checker ticks, and approves each section or asks for a change.
 *
 *   Day −7   approval_link (token page /c/{token}/approve)
 *   Day −5, −3 approval_reminder while anything is unapproved
 *   48 h after the second reminder with no click → approvalMode = silence,
 *            approved_by_silence (client) + owner FYI
 *   change request → owner alert change_requested + a Promise; the owner edits
 *            the copy in Mission Control and re-sends (approval_updated).
 *            Max APPROVAL rounds (2); after that the owner's version stands.
 *
 * State: client:{id}:approval (hash). Approval lands in client:{id}:sequence
 * (approvedAt, approvedBy, approvalMode) — what Stage C and the readiness gate read.
 */

import { kv } from '@vercel/kv';
import { K } from '@/lib/db/keys';
import { cfg } from '@/lib/config';
import { getClient, getProfile, getTrial } from '@/lib/db/client';
import { logEvent } from '@/lib/db/events';
import { addPromise } from '@/lib/db/promises';
import { alertOwner, notifyClient } from '@/lib/notify';
import { mintToken, readToken, pageUrl, TTL } from '@/lib/pagetokens';
import { encrypt, decrypt } from '@/lib/crypto';
import { ET, dayKeyIn, trialDay, addDays } from '@/lib/time';
import { buildSequence, getStoredSequence, checkVariant, sampleLead } from '@/lib/systems/copy';
import { getSanityRows } from '@/lib/systems/sanity';

export const SECTIONS = ['profile', 'list', 'copy'];
const PURPOSE = 'approval';

const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

export async function getApproval(clientId) {
  const raw = (await kv.hgetall(K.approval(clientId))) || {};
  return {
    ...raw,
    sections: parse(raw.sections, {}),
    reminders: parse(raw.reminders, {}),
    changes: parse(raw.changes, []),
    round: Number(raw.round) || 0,
  };
}

async function saveApproval(clientId, fields) {
  const out = { ...fields };
  for (const k of ['sections', 'reminders', 'changes']) if (out[k] && typeof out[k] !== 'string') out[k] = JSON.stringify(out[k]);
  if (out.round !== undefined) out.round = String(out.round);
  await kv.hset(K.approval(clientId), out);
}

/** "Monday, October 12" for a dayKey. */
export function fmtDay(dayKey) {
  if (!dayKey) return '';
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** The day by which silence counts as approval (second reminder day + silenceHours). */
export async function silenceDay(clientId, trial) {
  const days = await cfg(clientId, 'APPROVAL.reminderDays');
  const hours = await cfg(clientId, 'APPROVAL.silenceHours');
  if (!trial.day1Date) return null;
  return addDays(trial.day1Date, Math.max(...days) - 1 + Math.ceil(hours / 24));
}

/** The approval URL (reuses the stored token; mints a fresh one when missing or expired). */
export async function approvalUrl(clientId, { fresh = false } = {}) {
  const a = await getApproval(clientId);
  if (!fresh && a.tokenEnc) {
    try {
      const raw = decrypt(a.tokenEnc);
      if (await readToken(raw, { purpose: PURPOSE })) return pageUrl(raw, 'approve');
    } catch {}
  }
  const token = await mintToken(clientId, PURPOSE, { ttl: TTL.long * 2 });
  let tokenEnc = '';
  try { tokenEnc = encrypt(token); } catch {}
  await saveApproval(clientId, { tokenEnc, tokenMintedAt: new Date().toISOString() });
  return pageUrl(token, 'approve');
}

async function mailVars(clientId) {
  const [client, trial] = await Promise.all([getClient(clientId), getTrial(clientId)]);
  const profile = await getProfile(clientId);
  return {
    contactName: client?.contactName || 'there',
    senderName: profile.senderName || client?.name,
    day1Date: fmtDay(trial.day1Date),
    silenceDate: fmtDay(await silenceDay(clientId, trial)),
    ownerName: (await cfg(clientId, 'OWNER.signerName')) || 'The Aviance team',
    approvalUrl: await approvalUrl(clientId),
  };
}

/** Day −7: build the copy if needed and email the link (once). */
export async function sendApprovalLink(clientId, { now = new Date(), deps = {} } = {}) {
  const seq = await getStoredSequence(clientId);
  if (!seq.variantA) {
    const built = await buildSequence(clientId);
    if (!built.ok) return { sent: false, reason: `copy not buildable: ${built.missing?.join(', ')}` };
  }
  const vars = await mailVars(clientId);
  const res = await (deps.notify || notifyClient)(clientId, 'approval_link', vars, { dedupe: 'approval_link' });
  if (res.sent || res.deduped) await saveApproval(clientId, { sentAt: now.toISOString(), status: 'sent' });
  await logEvent(clientId, 'approval', 'link_sent', { deduped: Boolean(res.deduped) });
  return { sent: Boolean(res.sent), deduped: Boolean(res.deduped) };
}

async function markApproved(clientId, mode, by, now = new Date()) {
  const seq = await getStoredSequence(clientId);
  if (seq.approvedAt) return false;
  await kv.hset(K.sequence(clientId), { approvedAt: now.toISOString(), approvedBy: by, approvalMode: mode });
  await saveApproval(clientId, { approvedAt: now.toISOString(), mode, status: 'approved' });
  await logEvent(clientId, 'approval', 'approved', { mode, by });
  return true;
}

/** Everything the page renders. null when the token is invalid. */
export async function loadApprovalPage(rawToken) {
  const tok = await readToken(rawToken, { purpose: PURPOSE });
  if (!tok) return null;
  const id = tok.clientId;
  const [client, profile, trial, a, seq, rows] = await Promise.all([getClient(id), getProfile(id), getTrial(id), getApproval(id), getStoredSequence(id), getSanityRows(id)]);
  const lead = rows.find((r) => r.first_name && r.company) || (await sampleLead(id));
  const maxWords = await cfg(id, 'COPY.maxWords');
  const variants = {};
  for (const [label, v] of [['A', seq.variantA], ['B', seq.variantB]]) {
    if (!v) continue;
    variants[label] = lead ? checkVariant(v, profile, lead, { maxWords }).map((r) => ({ touch: r.touch, ok: r.ok, ticks: r.ticks, subject: r.rendered?.subject || null, text: r.rendered?.text || null, failures: r.failures })) : null;
  }
  const maxRounds = await cfg(id, 'BUILD.approvalMaxRounds');
  return {
    company: client?.name || id,
    contactName: client?.contactName || '',
    day1Date: trial.day1Date || null,
    profile: {
      sellsTo: profile.sellsTo || '', oneLiner: profile.oneLiner || '', industry: profile.industry || '', cities: profile.cities || '', states: profile.states || '',
      sizeMin: profile.sizeMin || '', sizeMax: profile.sizeMax || '', titles: profile.titles || '', excludedTitles: profile.excludedTitles || '',
      senderName: profile.senderName || '', senderTitle: profile.senderTitle || '', postalAddress: profile.postalAddress || '', calendarUrl: profile.calendarUrl || '',
    },
    marketEstimate: client?.marketEstimate ?? profile.marketEstimate ?? null,
    rows,
    sampleLead: lead ? { first_name: lead.first_name, company: lead.company, city: lead.city } : null,
    variants,
    sections: a.sections,
    round: a.round,
    maxRounds,
    changesLeft: Math.max(0, maxRounds - a.round),
    approvedAt: seq.approvedAt || null,
    approvalMode: seq.approvalMode || null,
  };
}

/** Approve one section; when all three are approved the sequence is approved (mode click). */
export async function approveSection(rawToken, section, { now = new Date() } = {}) {
  const tok = await readToken(rawToken, { purpose: PURPOSE });
  if (!tok) return { error: 'This link has expired.', status: 401 };
  if (!SECTIONS.includes(section)) return { error: 'unknown section', status: 400 };
  const id = tok.clientId;
  const a = await getApproval(id);
  const sections = { ...a.sections, [section]: { status: 'approved', at: now.toISOString() } };
  await saveApproval(id, { sections, lastClickAt: now.toISOString() });
  await logEvent(id, 'approval', 'section_approved', { section });
  let approved = false;
  if (SECTIONS.every((s) => sections[s]?.status === 'approved')) {
    const client = await getClient(id);
    approved = await markApproved(id, 'click', client?.contactEmail || client?.contactName || 'client', now);
  }
  return { ok: true, approved };
}

/** Ask for a change on one section (max rounds). */
export async function requestChange(rawToken, section, text, { now = new Date() } = {}) {
  const tok = await readToken(rawToken, { purpose: PURPOSE });
  if (!tok) return { error: 'This link has expired.', status: 401 };
  if (!SECTIONS.includes(section)) return { error: 'unknown section', status: 400 };
  const note = String(text || '').trim().slice(0, 2000);
  if (note.length < 3) return { error: 'Please say what to change.', status: 400 };
  const id = tok.clientId;
  const a = await getApproval(id);
  const maxRounds = await cfg(id, 'BUILD.approvalMaxRounds');
  if (a.round >= maxRounds) return { error: `We have already made ${maxRounds} rounds of changes, so this version is the one that goes out. Reply to our email if something is wrong.`, status: 409 };
  const round = a.round + 1;
  const changes = [...a.changes, { section, text: note, at: now.toISOString(), round }];
  const sections = { ...a.sections, [section]: { status: 'change', at: now.toISOString() } };
  await saveApproval(id, { sections, changes, round, lastClickAt: now.toISOString() });
  const due = new Date(now.getTime() + 24 * 3600e3).toISOString();
  await addPromise(id, `Answer the ${section} change request (round ${round}): "${note.slice(0, 120)}"`, due);
  await alertOwner('change_requested', { clientId: id, scope: `${id}:r${round}`, vars: { clientId: id }, body: `Section: ${section} (round ${round} of ${maxRounds})\n\n"${note}"`, did: `A promise to answer within a day was logged. Edit the copy at /mc/clients/${id}/sequence, then press "Re-send to client".` });
  await logEvent(id, 'approval', 'change_requested', { section, round, text: note });
  return { ok: true, round, changesLeft: Math.max(0, maxRounds - round) };
}

/** Owner edited the copy after a change request: reset the changed sections and re-send. */
export async function resendAfterChange(clientId, { deps = {} } = {}) {
  const a = await getApproval(clientId);
  const sections = { ...a.sections };
  for (const s of SECTIONS) if (sections[s]?.status === 'change') sections[s] = { status: 'pending', at: new Date().toISOString() };
  await saveApproval(clientId, { sections });
  const res = await (deps.notify || notifyClient)(clientId, 'approval_updated', await mailVars(clientId), { dedupe: `approval_updated:r${a.round}` });
  await logEvent(clientId, 'approval', 'resent', { round: a.round, deduped: Boolean(res.deduped) });
  return res;
}

/**
 * The hourly `approval` job for a client in `warming`: link at Day −7,
 * reminders at Day −5 / −3, silence rule 48 h after the second reminder.
 */
export async function runApprovalJob({ client, now = new Date(), deps = {} }) {
  const notify = deps.notify || notifyClient;
  const id = client.id;
  const trial = await getTrial(id);
  const td = trialDay(trial, now);
  if (td == null) return { skipped: 'no trial dates' };
  const seq = await getStoredSequence(id);
  if (seq.approvedAt) return { approved: true };
  const a = await getApproval(id);
  const linkDay = await cfg(id, 'BUILD.approvalLinkDay');
  if (!a.sentAt) {
    if (td < linkDay) return { waiting: `link on Day ${linkDay}` };
    return { link: await sendApprovalLink(id, { now, deps }) };
  }
  const reminderDays = [...(await cfg(id, 'APPROVAL.reminderDays'))].sort((x, y) => x - y);
  const today = dayKeyIn(ET, now);
  const reminders = { ...a.reminders };
  for (const d of reminderDays) {
    if (td >= d && !reminders[d] && dayKeyIn(ET, new Date(a.sentAt)) < today) {
      const res = await notify(id, 'approval_reminder', await mailVars(id), { dedupe: `approval_reminder:${d}` });
      reminders[d] = now.toISOString();
      const fields = { reminders };
      if (d === reminderDays[reminderDays.length - 1]) fields.secondReminderAt = now.toISOString();
      await saveApproval(id, fields);
      await logEvent(id, 'approval', 'reminder_sent', { day: d, deduped: Boolean(res.deduped) });
      return { reminder: d };
    }
  }
  const second = a.secondReminderAt;
  const hours = await cfg(id, 'APPROVAL.silenceHours');
  if (second && now.getTime() - Date.parse(second) >= hours * 3600e3 && (!a.lastClickAt || a.lastClickAt < second)) {
    if (await markApproved(id, 'silence', 'silence', now)) {
      await notify(id, 'approved_by_silence', await mailVars(id), { dedupe: 'approved_by_silence' });
      await alertOwner('approved_by_silence', { clientId: id, vars: { clientId: id }, body: `No answer ${hours} h after the second reminder, so the copy counts as approved (spec §7.6 silence rule).`, did: 'The client was told; Day 1 now only waits on warm-up, list and canary.' });
    }
    return { approved: 'silence' };
  }
  return { waiting: 'client' };
}
